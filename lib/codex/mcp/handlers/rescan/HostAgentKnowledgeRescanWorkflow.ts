/**
 * HostAgentKnowledgeRescanWorkflow — 宿主 Agent 增量知识重扫
 *
 * 保留已审核 Recipe，清理衍生缓存，全量/指定维度重新扫描。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   3. Phase 1-4 全量分析 (ProjectIntelligenceCapability)
 *   4. 构建 Mission Briefing（含 allRecipes + evolutionGuide）
 *   5. 返回给宿主 Agent 按维度执行: evolve → gap-fill → dimension_complete
 */

import {
  auditRecipesForRescan,
  buildExternalMissionBriefing as buildHostAgentMissionBriefing,
  buildIDEAgentAnalysisPacketFromSnapshot,
  buildKnowledgeRescanPlan,
  buildKnowledgeRescanWorkflowPlan,
  buildRescanPrescreen,
  createExternalKnowledgeRescanIntent as createHostAgentKnowledgeRescanIntent,
  createExternalWorkflowSession as createHostAgentWorkflowSession,
  presentExternalKnowledgeRescanEmptyProject as presentHostAgentKnowledgeRescanEmptyProject,
  presentExternalKnowledgeRescanResponse as presentHostAgentKnowledgeRescanResponse,
  projectExternalRescanEvidencePlan as projectHostAgentRescanEvidencePlan,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
  syncKnowledgeStoreForRescan,
} from '@alembic/core/host-agent-workflows';
import type { DimensionDef, ProjectSnapshot } from '@alembic/core/project-intelligence';
import {
  buildProjectSnapshot,
  ProjectIntelligenceCapability,
} from '@alembic/core/project-intelligence';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
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

  // ═══════════════════════════════════════════════════════════
  // Step 3: Phase 1-4 全量分析
  // ═══════════════════════════════════════════════════════════

  const phaseResults = await ProjectIntelligenceCapability.run({
    projectRoot: plan.projectAnalysis.projectRoot,
    ctx,
    prepare: plan.projectAnalysis.prepare,
    scan: plan.projectAnalysis.scan,
    materialize: plan.projectAnalysis.materialize,
  });

  // 空项目 fast-path
  if (phaseResults.isEmpty) {
    return presentHostAgentKnowledgeRescanEmptyProject({ responseTimeMs: Date.now() - t0 });
  }

  const {
    allFiles,
    primaryLang,
    depGraphData,
    langStats,
    astProjectSummary,
    codeEntityResult,
    callGraphResult,
    guardAudit,
    activeDimensions: allDimensions,
    targetsSummary,
    localPackageModules,
    langProfile,
  } = phaseResults;
  const activeDimensions = Array.isArray(allDimensions) ? allDimensions : [];

  // ── Build immutable ProjectSnapshot ──
  const snapshot: ProjectSnapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: 'rescan-host-agent',
    ...phaseResults,
    report: phaseResults.report,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 4: Recipe 证据验证 + 快速衰退
  // ═══════════════════════════════════════════════════════════

  const auditSummary = await auditRecipesForRescan({
    container: ctx.container,
    logger: ctx.logger,
    recipeEntries: recipeSnapshot.entries,
    allFiles,
    projectRoot,
  });

  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: recipeSnapshot.entries,
    auditSummary,
    dimensions: activeDimensions as DimensionDef[],
    requestedDimensionIds: intent.dimensionIds,
  });
  const dimensions = knowledgeRescanPlan.executionDimensions;
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

  const session = createHostAgentWorkflowSession({
    container: ctx.container,
    projectRoot,
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    snapshot,
    primaryLang,
    fileCount: allFiles.length,
    moduleCount: depGraphData?.nodes?.length || 0,
  });

  const briefing = buildHostAgentMissionBriefing({
    projectRoot,
    primaryLang,
    secondaryLanguages: (langProfile as { secondary?: string[] }).secondary || [],
    isMultiLang: (langProfile as { isMultiLang?: boolean }).isMultiLang || false,
    fileCount: allFiles.length,
    projectType: snapshot.discoverer.id,
    profile: 'rescan-external',
    rescan: { evidencePlan, prescreen },
    briefing: {
      astData: astProjectSummary,
      codeEntityResult,
      callGraphResult,
      depGraphData,
      guardAudit: normalizeGuardAuditForBriefing(guardAudit),
      // Core MissionBriefingBuilder consumes a target array; generic project scans can
      // provide a summary object, so keep the compatibility normalization in Plugin.
      targets: Array.isArray(targetsSummary) ? targetsSummary : [],
      activeDimensions: Array.isArray(dimensions) ? dimensions : [],
      session,
      languageStats: langStats,
      panoramaResult: snapshot.panorama,
      localPackageModules: Array.isArray(localPackageModules) ? localPackageModules : [],
    },
  });
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromSnapshot(
    normalizeProjectSnapshotForIDEAgent(snapshot),
    {
      profile: 'rescan',
    }
  );
  const ideAgentAnalysis = buildIDEAgentAnalysisSurface(ideAgentPacket);
  const briefingWithIdeAgentSurface = attachIDEAgentAnalysisSurface(
    briefing as Record<string, unknown>,
    ideAgentAnalysis
  );

  // 附加 warnings
  if (phaseResults.warnings.length > 0) {
    briefingWithIdeAgentSurface.meta = briefingWithIdeAgentSurface.meta || {};
    const existingWarnings = Array.isArray(briefingWithIdeAgentSurface.meta.warnings)
      ? briefingWithIdeAgentSurface.meta.warnings
      : [];
    briefingWithIdeAgentSurface.meta.warnings = [...existingWarnings, ...phaseResults.warnings];
  }

  const dimGapLog = evidencePlan.dimensionGaps
    .map(
      (dimensionGap) =>
        `${dimensionGap.dimensionId}(${dimensionGap.existingCount}→gap ${dimensionGap.gap}, mode ${dimensionGap.executionMode}, budget ${dimensionGap.createBudget})`
    )
    .join(', ');
  ctx.logger.info(
    `[Rescan] Mission Briefing ready: ${allFiles.length} files, ${
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

  return presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot,
    cleanResult,
    auditSummary,
    briefing: briefingWithIdeAgentSurface,
    evidencePlan,
    dimensions: requestedDimensions,
    reason: intent.reason,
    responseTimeMs: Date.now() - t0,
  });
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

function normalizeGuardAuditForBriefing<T>(guardAudit: T): T {
  if (!guardAudit || typeof guardAudit !== 'object' || Array.isArray(guardAudit)) {
    return guardAudit;
  }
  const record = guardAudit as Record<string, unknown>;
  // Core briefing expects array fields; Plugin accepts older/newer Guard audit DTOs here.
  return {
    ...record,
    files: Array.isArray(record.files) ? record.files.map(normalizeGuardAuditFile) : [],
    crossFileViolations: Array.isArray(record.crossFileViolations)
      ? record.crossFileViolations
      : [],
  } as T;
}

function normalizeGuardAuditFile(file: unknown): unknown {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return file;
  }
  const record = file as Record<string, unknown>;
  return {
    ...record,
    violations: Array.isArray(record.violations) ? record.violations : [],
  };
}

function normalizeProjectSnapshotForIDEAgent(snapshot: ProjectSnapshot): ProjectSnapshot {
  return {
    ...snapshot,
    guardAudit: normalizeGuardAuditForBriefing(snapshot.guardAudit),
    panorama: normalizePanoramaForIDEAgent(snapshot.panorama),
  };
}

function normalizePanoramaForIDEAgent<T>(panorama: T): T {
  if (!panorama || typeof panorama !== 'object' || Array.isArray(panorama)) {
    return panorama;
  }
  const record = panorama as Record<string, unknown>;
  return {
    ...record,
    layers: Array.isArray(record.layers) ? record.layers : [],
    couplingHotspots: Array.isArray(record.couplingHotspots) ? record.couplingHotspots : [],
    cyclicDependencies: Array.isArray(record.cyclicDependencies) ? record.cyclicDependencies : [],
  } as T;
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
