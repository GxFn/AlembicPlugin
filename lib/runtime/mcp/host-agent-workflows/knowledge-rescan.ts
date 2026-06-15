/**
 * HostAgentKnowledgeRescanWorkflow — 宿主 Agent 增量知识重扫
 *
 * 保留已审核 Recipe，清理衍生缓存，全量/指定维度重新扫描。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   3. ProjectContext 直接读取项目结构/源码/符号事实
 *   4. 构建 Mission Briefing（含 allRecipes + evolutionGuide）
 *   5. 返回给宿主 Agent 按维度执行: evolve → gap-fill → dimension_complete
 */

import {
  auditRecipesForRescan,
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildKnowledgeRescanPlan,
  buildKnowledgeRescanWorkflowPlan,
  buildProjectContextMissionBriefing,
  buildRescanPrescreen,
  createHostAgentKnowledgeRescanIntent,
  type DimensionDef,
  presentHostAgentKnowledgeRescanEmptyProject,
  presentHostAgentKnowledgeRescanResponse,
  projectHostAgentRescanEvidencePlan,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
  syncKnowledgeStoreForRescan,
} from '@alembic/core/host-agent-workflows';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexLocalSelectionMismatch } from '#codex/HostProjectAlignment.js';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import {
  buildHostAgentProjectContextAnalysis,
  createProjectContextHostAgentSession,
  selectProjectContextDimensions,
} from '#codex/mcp/host-agent-workflows/project-context-analysis.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';

/** MCP handler context */
interface McpContext {
  container: ServiceContainer;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  startedAt?: number;
  [key: string]: unknown;
}

interface ProjectContextAuditFile {
  filePath: string;
}

// ── 主入口 ─────────────────────────────────────────────────

export async function runHostAgentKnowledgeRescanWorkflow(ctx: McpContext, args: RescanInput) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const db = ctx.container.get('database');
  const intent = createHostAgentKnowledgeRescanIntent(args);
  const plan = buildKnowledgeRescanWorkflowPlan({ intent, projectRoot, dataRoot });

  // ═══════════════════════════════════════════════════════════
  // Step 0: 清理策略（根据 intent 决定）
  // ═══════════════════════════════════════════════════════════

  let recipeSnapshot: Awaited<ReturnType<CleanupService['snapshotRecipes']>>;
  let cleanResult: Awaited<ReturnType<CleanupService['rescanClean']>>;

  if (intent.cleanupPolicy === 'force-rescan') {
    const result = await runForceRescanCleanPolicy({
      projectRoot: plan.cleanup.projectRoot,
      dataRoot,
      db,
      logger: ctx.logger,
      createCleanupService: createWorkflowCleanupService,
    });
    recipeSnapshot = result.recipeSnapshot;
    cleanResult = result.cleanResult;
  } else if (intent.cleanupPolicy === 'rescan-clean') {
    const result = await runRescanCleanPolicy({
      projectRoot: plan.cleanup.projectRoot,
      dataRoot,
      db,
      logger: ctx.logger,
      createCleanupService: createWorkflowCleanupService,
    });
    recipeSnapshot = result.recipeSnapshot;
    cleanResult = result.cleanResult;
  } else {
    const cleanupService = createWorkflowCleanupService({
      projectRoot: plan.cleanup.projectRoot,
      dataRoot,
      db,
      logger: ctx.logger,
    });
    recipeSnapshot = await cleanupService.snapshotRecipes();
    cleanResult = {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: recipeSnapshot.count,
      errors: [],
    };
  }

  ctx.logger.info(`[Rescan] Preserved ${recipeSnapshot.count} recipes`, {
    cleanupPolicy: intent.cleanupPolicy,
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2.5: Recipe 文件 ↔ DB 一致性恢复 + 向量索引重建
  // ═══════════════════════════════════════════════════════════

  // 2.5a: KnowledgeSyncService — 恢复 Recipe 文件 ↔ DB 一致性
  //   rescanClean 保留了 recipes/ 文件和 active/published/staging/evolving DB 记录，
  //   但清除了 recipe_source_refs 等桥接表，需重新同步。
  syncKnowledgeStoreForRescan({
    container: ctx.container,
    db,
    logger: ctx.logger,
    logPrefix: 'Rescan',
  });

  // NOTE: 不在 rescan 中调用 VectorService.fullBuild()
  // 理由：fullBuild 依赖外部 embedding API（LLM），在 MCP handler 同步路径中
  // 引入 LLM 调用不合理（无超时、可能阻塞、需要 API key）。
  // 向量索引会在后续 Agent 提交新知识时由 SyncCoordinator 增量更新。

  const projectContextAnalysis = await buildHostAgentProjectContextAnalysis({
    maxFiles: plan.projectAnalysis.scan.maxFiles,
    projectRoot: plan.projectAnalysis.projectRoot,
    source: 'codex-host-rescan',
  });

  // 空项目 fast-path
  if (projectContextAnalysis.isEmpty) {
    return presentHostAgentKnowledgeRescanEmptyProject({ responseTimeMs: Date.now() - t0 });
  }

  const activeDimensions = projectContextAnalysis.dimensions;

  // ═══════════════════════════════════════════════════════════
  // Step 4: Recipe 证据验证 + 快速衰退
  // ═══════════════════════════════════════════════════════════

  const auditSummary = await auditRecipesForRescan({
    container: ctx.container,
    logger: ctx.logger,
    recipeEntries: recipeSnapshot.entries,
    allFiles: projectContextFilesForRescanAudit(projectContextAnalysis.presenterInput.files),
    projectRoot,
  });

  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: recipeSnapshot.entries,
    auditSummary,
    dimensions: activeDimensions as DimensionDef[],
    requestedDimensionIds: intent.dimensionIds,
  });
  const dimensions = selectProjectContextDimensions(
    knowledgeRescanPlan.executionDimensions,
    intent.dimensionIds
  );
  const requestedDimensions = knowledgeRescanPlan.requestedDimensions;

  // ═══════════════════════════════════════════════════════════
  // Step 4.5: 构建进化前置过滤（Phase A）
  // ═══════════════════════════════════════════════════════════

  const prescreen = buildRescanPrescreen(auditSummary, recipeSnapshot.entries, dimensions);
  const evidencePlan = projectHostAgentRescanEvidencePlan(knowledgeRescanPlan);

  ctx.logger.info('[Rescan] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5: 构建 Mission Briefing + 过滤维度
  // ═══════════════════════════════════════════════════════════

  const session = createProjectContextHostAgentSession({
    container: ctx.container,
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    fileCount: projectContextAnalysis.fileCount,
    moduleCount: projectContextAnalysis.moduleCount,
    primaryLang: projectContextAnalysis.primaryLang,
    projectRoot,
  });

  const briefing = buildProjectContextMissionBriefing({
    activeDimensions: Array.isArray(dimensions) ? dimensions : [],
    projectContext: projectContextAnalysis.presenterInput,
    profile: 'rescan-host-agent',
    rescan: { evidencePlan, prescreen },
    session,
  });
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromProjectContext({
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    options: {
      profile: 'rescan',
      projectRoot,
    },
    projectContext: projectContextAnalysis.presenterInput,
  });
  const ideAgentAnalysis = buildIDEAgentAnalysisSurface(ideAgentPacket);
  const briefingWithIdeAgentSurface = attachIDEAgentAnalysisSurface(
    briefing as Record<string, unknown>,
    ideAgentAnalysis
  );
  briefingWithIdeAgentSurface.meta.projectContextDirectSwitch = {
    moduleSeedCount: projectContextAnalysis.moduleSeeds.length,
    requestKinds: projectContextAnalysis.requestKinds,
  };

  const dimGapLog = evidencePlan.dimensionGaps
    .map(
      (dimensionGap) =>
        `${dimensionGap.dimensionId}(${dimensionGap.existingCount}→gap ${dimensionGap.gap}, mode ${dimensionGap.executionMode}, budget ${dimensionGap.createBudget})`
    )
    .join(', ');
  ctx.logger.info(
    `[Rescan] ProjectContext Mission Briefing ready: ${projectContextAnalysis.fileCount} files, ${
      Array.isArray(dimensions) ? dimensions.length : 0
    } dims, ` +
      `preserved: ${recipeSnapshot.count}, decayed: ${evidencePlan.decayCount}, totalGap: ${evidencePlan.totalGap}, ` +
      `ideUnits: ${ideAgentAnalysis.progress.totalUnits} — session ${session.id}`
  );
  ctx.logger.info(`[Rescan] Dimension gaps: ${dimGapLog}`);
  ctx.logger.info('[Rescan] Execution reasons', {
    executionDimensions: knowledgeRescanPlan.executionDimensions.length,
    produceDimensions: knowledgeRescanPlan.produceDimensions.length,
    reasons: knowledgeRescanPlan.executionReasons,
  });

  const response = presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot,
    cleanResult,
    auditSummary,
    briefing: briefingWithIdeAgentSurface,
    evidencePlan,
    dimensions: requestedDimensions,
    reason: intent.reason,
    responseTimeMs: Date.now() - t0,
  }) as Record<string, unknown> & { message?: string; meta?: Record<string, unknown> };

  // MT1 P1 归档诚实性：候选/wiki 投影被移动时，摘要必须说明归档去向
  // （结构化的 rescan.archive 字段由 Core presenter 携带）。
  if (cleanResult.trash && cleanResult.trash.movedItems > 0) {
    response.message =
      `📦 已清理的 candidates/wiki 投影归档到 .asd/.trash/${cleanResult.trash.folder.split(/[\\/]/).filter(Boolean).pop()}/` +
      `（${cleanResult.trash.movedItems} 项，可恢复）。${response.message ?? ''}`;
  }

  // MT1 P3-3 一致性：与 alembic_bootstrap 相同的选择不一致事实回带。
  const mismatch = buildCodexLocalSelectionMismatch(projectRoot);
  if (mismatch) {
    response.meta = { ...(response.meta ?? {}), hostProjectSelectionMismatch: mismatch };
  }
  return response;
}

function attachIDEAgentAnalysisSurface(
  briefing: Record<string, unknown>,
  ideAgentAnalysis: ReturnType<typeof buildIDEAgentAnalysisSurface>
): Record<string, unknown> & {
  ideAgentAnalysis: ReturnType<typeof buildIDEAgentAnalysisSurface>;
  meta: Record<string, unknown>;
} {
  const meta =
    briefing.meta && typeof briefing.meta === 'object' && !Array.isArray(briefing.meta)
      ? (briefing.meta as Record<string, unknown>)
      : {};
  return {
    ...briefing,
    ideAgentAnalysis,
    meta: {
      ...meta,
      ideAgentAnalysis: {
        packetId: ideAgentAnalysis.packetSummary.packetId,
        profile: ideAgentAnalysis.packetSummary.profile,
        totalUnits: ideAgentAnalysis.progress.totalUnits,
        remainingUnits: ideAgentAnalysis.progress.remainingUnitIds.length,
      },
    },
  };
}

function createWorkflowCleanupService(ctx: {
  projectRoot: string;
  dataRoot?: string;
  db?: unknown;
  logger?: ConstructorParameters<typeof CleanupService>[0]['logger'];
}) {
  return new CleanupService({
    projectRoot: ctx.projectRoot,
    dataRoot: ctx.dataRoot,
    db: ctx.db,
    logger: ctx.logger,
  });
}

function projectContextFilesForRescanAudit(files: readonly ProjectContextAuditFile[]): Array<{
  name: string;
  path?: string;
  relativePath?: string;
}> {
  return files.map((file) => ({
    name: file.filePath.split(/[\\/]/).filter(Boolean).pop() ?? file.filePath,
    path: file.filePath,
    relativePath: file.filePath,
  }));
}
