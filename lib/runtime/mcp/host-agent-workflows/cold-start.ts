/**
 * HostAgentColdStartWorkflow — 宿主 Agent 驱动的冷启动
 *
 * Phase 1-4 同步执行（文件收集 / AST / 依赖图 / Guard），
 * 构建 Mission Briefing 一次性返回，不启动异步 AI pipeline。
 * 等待 IDE 插件宿主中的宿主 Agent 主动提交知识 + 完成维度。
 *
 * 本文件只返回宿主 Agent Mission Briefing；插件侧不启动本地 AI pipeline。
 * Phase 1-4 分析逻辑由 ProjectIntelligenceRunner 执行。
 */

import type { WorkflowLogger } from '@alembic/core/host-agent-workflows';
import {
  buildColdStartWorkflowPlan,
  buildHostAgentMissionBriefing,
  buildIDEAgentAnalysisPacketFromSnapshot,
  createHostAgentColdStartIntent,
  createHostAgentWorkflowSession,
  getActiveHostAgentWorkflowSession,
  presentHostAgentColdStartEmptyProject,
  presentHostAgentColdStartResponse,
  runFullResetPolicy,
} from '@alembic/core/host-agent-workflows';
import type { ProjectSnapshot } from '@alembic/core/project-intelligence';
import {
  buildProjectSnapshot,
  ProjectIntelligenceCapability,
} from '@alembic/core/project-intelligence';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexLocalSelectionMismatch } from '#codex/HostProjectAlignment.js';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import { type CodexKnowledgeState, inspectCodexKnowledge } from '#codex/KnowledgeState.js';
import { resolveHostAgentDataRoot } from '#codex/mcp/host-agent-workflows/project-data-root.js';
import { buildCodexColdStartOnboardingContract } from '#codex/status/OnboardingContract.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import type { BootstrapInput } from '#shared/schemas/mcp-tools.js';

interface McpContext {
  container: ServiceContainer;
  logger: WorkflowLogger;
  startedAt?: number;
  [key: string]: unknown;
}

interface AttachColdStartOnboardingInput<T extends { meta?: Record<string, unknown> }> {
  allFiles: readonly unknown[];
  briefing: T;
  dataRoot: string;
  depGraphData?: { nodes?: unknown[] } | null;
  dimensions: readonly unknown[];
  langProfile: unknown;
  primaryLang: string | null;
  projectRoot: string;
  projectType: string | null;
  session: unknown;
}

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * bootstrapForHostAgent — 宿主 Agent 驱动的一键冷启动
 *
 * 无参数调用，返回 Mission Briefing。
 * Phase 1-4 复用现有 bootstrap.js 逻辑，Phase 5 不启动。
 *
 * @param ctx { container, logger, startedAt }
 * @returns envelope({ success, data: MissionBriefing })
 */
export async function runHostAgentColdStartWorkflow(ctx: McpContext, args?: BootstrapInput) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveHostAgentDataRoot(ctx.container, projectRoot);

  // ═══════════════════════════════════════════════════════════
  // Step 0: 重建确认门禁（MT1 P1 数据丢失门禁的 bootstrap 半边）
  // fullReset 会把全部现有知识移入垃圾桶并清空 DB；可用知识库存在时
  // 必须显式 rebuild:true 确认，否则拒绝并推荐保留式 alembic_rescan。
  // 使用与 tools/list 知识门同一谓词（inspectCodexKnowledge.usable），
  // 保证确认门禁与工具面收合发生在同一事实上。
  // ═══════════════════════════════════════════════════════════

  const knowledgeBefore = inspectCodexKnowledge(projectRoot);
  const confirmationBlock = buildBootstrapRebuildConfirmationBlock(knowledgeBefore, args);
  if (confirmationBlock) {
    return attachLocalSelectionMismatch(confirmationBlock, projectRoot);
  }

  const intent = createHostAgentColdStartIntent();
  const plan = buildColdStartWorkflowPlan({ intent, projectRoot, dataRoot });

  // ═══════════════════════════════════════════════════════════
  // Step 1: 全量清理 (CleanupService.fullReset)
  // ═══════════════════════════════════════════════════════════

  const db = ctx.container.get('database');
  const cleanupResult = await runFullResetPolicy({
    projectRoot: plan.cleanup.projectRoot,
    dataRoot,
    db,
    logger: ctx.logger,
    createCleanupService: (policyCtx) =>
      new CleanupService({
        projectRoot: policyCtx.projectRoot,
        dataRoot: policyCtx.dataRoot,
        db: policyCtx.db,
        logger: policyCtx.logger,
      }),
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享数据收集管线（永远全量，无增量检测）
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
    return presentHostAgentColdStartEmptyProject({ responseTimeMs: Date.now() - t0 });
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
    activeDimensions: dimensions,
    targetsSummary,
    localPackageModules,
    langProfile,
  } = phaseResults;
  const briefingDimensions = Array.isArray(dimensions) ? dimensions : [];

  // ── Build immutable ProjectSnapshot ──
  const snapshot: ProjectSnapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: 'codex-host-bootstrap',
    ...phaseResults,
    report: phaseResults.report,
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 4: 构建 Mission Briefing
  // ═══════════════════════════════════════════════════════════

  const session = createHostAgentWorkflowSession({
    container: ctx.container,
    projectRoot,
    dimensions: briefingDimensions,
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
    profile: 'cold-start-host-agent',
    briefing: {
      astData: astProjectSummary,
      codeEntityResult,
      callGraphResult,
      depGraphData,
      guardAudit: normalizeGuardAuditForBriefing(guardAudit),
      // Core MissionBriefingBuilder expects an array target list. ProjectIntelligence
      // may expose a summary object for generic projects, so Plugin normalizes at the
      // adapter boundary instead of teaching Codex a private schema.
      targets: Array.isArray(targetsSummary) ? targetsSummary : [],
      activeDimensions: briefingDimensions,
      session,
      languageStats: langStats,
      panoramaResult: snapshot.panorama,
      localPackageModules: Array.isArray(localPackageModules) ? localPackageModules : [],
    },
  });
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromSnapshot(
    normalizeProjectSnapshotForIDEAgent(snapshot),
    {
      profile: 'cold-start',
    }
  );
  const ideAgentAnalysis = buildIDEAgentAnalysisSurface(ideAgentPacket);
  const briefingWithIdeAgentSurface = attachIDEAgentAnalysisSurface(briefing, ideAgentAnalysis);
  const briefingWithOnboardingContract = attachColdStartOnboardingSurface({
    allFiles,
    briefing: briefingWithIdeAgentSurface,
    dataRoot,
    depGraphData,
    dimensions: briefingDimensions,
    langProfile,
    primaryLang,
    projectRoot,
    projectType: snapshot.discoverer.id,
    session,
  });

  // 附加 warnings
  if (phaseResults.warnings.length > 0) {
    briefingWithOnboardingContract.meta = briefingWithOnboardingContract.meta || {};
    const existingWarnings = Array.isArray(briefingWithOnboardingContract.meta.warnings)
      ? briefingWithOnboardingContract.meta.warnings
      : [];
    briefingWithOnboardingContract.meta.warnings = [...existingWarnings, ...phaseResults.warnings];
  }

  ctx.logger.info(
    `[BootstrapHostAgent] Mission Briefing ready: ${allFiles.length} files, ${briefingDimensions.length} dims, ` +
      `${briefingWithOnboardingContract.meta?.responseSizeKB || '?'}KB — session ${session.id}`
  );

  const response = presentHostAgentColdStartResponse({
    cleanupResult,
    briefing: briefingWithOnboardingContract,
    dimensionCount: briefingDimensions.length,
    responseTimeMs: Date.now() - t0,
  }) as Record<string, unknown> & { message?: string };

  // MT1 P1 归档诚实性：销毁式重建必须在摘要里说明归档去向与工具面变化，
  // 不允许只在结构化字段里携带。
  if (cleanupResult.trash && cleanupResult.trash.movedItems > 0) {
    response.message =
      `⚠️ 原有知识已归档到 .asd/.trash/${baseName(cleanupResult.trash.folder)}/` +
      `（${cleanupResult.trash.movedItems} 项，含 DB 快照 ${cleanupResult.trash.dbSnapshotRows} 行，可恢复）。` +
      `知识库清空后，知识相关工具会从 tools/list 暂时隐藏，直到重建出可用知识。` +
      `${response.message ?? ''}`;
  }
  return attachLocalSelectionMismatch(response, projectRoot);
}

/**
 * 可用知识库 + 未确认 rebuild → 拒绝销毁（导出供单测直接验证门禁矩阵）。
 */
export function buildBootstrapRebuildConfirmationBlock(
  knowledge: CodexKnowledgeState,
  args?: BootstrapInput
): Record<string, unknown> | null {
  if (!knowledge.usable || args?.rebuild === true) {
    return null;
  }
  return {
    success: false,
    errorCode: 'CODEX_BOOTSTRAP_REBUILD_CONFIRMATION_REQUIRED',
    tool: 'alembic_bootstrap',
    message:
      `当前项目已有可用知识库（Recipe ${knowledge.recipeCount} 个、Skill ${knowledge.skillCount} 个、DB 条目 ${knowledge.databaseEntryCount} 条）。` +
      `bootstrap 会把全部现有知识移入 .asd/.trash/<时间戳>/ 并从零重建。` +
      `如需保留 Recipe 并刷新知识，请改用 alembic_rescan；` +
      `确认要重建请显式传入 { "rebuild": true } 重新调用。本次未做任何修改。`,
    data: {
      knowledge: {
        databaseEntryCount: knowledge.databaseEntryCount,
        recipeCount: knowledge.recipeCount,
        skillCount: knowledge.skillCount,
        usable: knowledge.usable,
      },
      needsUserInput: true,
      nextActions: [
        {
          label: 'Refresh while preserving Recipes',
          reason: 'alembic_rescan keeps reviewed Recipes and rebuilds derived knowledge.',
          tool: 'alembic_rescan',
        },
        {
          arguments: { rebuild: true },
          label: 'Rebuild from zero (destructive, archived to trash)',
          reason: 'Archives ALL existing knowledge to .asd/.trash/<timestamp>/ before rebuilding.',
          tool: 'alembic_bootstrap',
        },
      ],
    },
  };
}

/**
 * MT1 P3-3 一致性：本地工作流在全局选择不一致时照常工作（只动宿主项目
 * 自己的数据根），但必须把 codex_* 门禁所依据的同一事实带回响应，
 * 不允许静默绕过。
 */
function attachLocalSelectionMismatch(
  response: Record<string, unknown>,
  projectRoot: string
): Record<string, unknown> {
  const mismatch = buildCodexLocalSelectionMismatch(projectRoot);
  if (!mismatch) {
    return response;
  }
  const meta =
    response.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
      ? (response.meta as Record<string, unknown>)
      : {};
  response.meta = { ...meta, hostProjectSelectionMismatch: mismatch };
  return response;
}

function baseName(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? value;
}

/**
 * 获取当前 active session（供其他 handler 使用）
 *
 * 当指定了 sessionId 时，如果 active session 已过期但 id 匹配，
 * 仍然返回该 session（支持新 bootstrap 创建后旧 session 的 dimension_complete 继续工作）。
 */
export { getActiveHostAgentWorkflowSession as getActiveSession };

function attachIDEAgentAnalysisSurface<T extends { meta?: Record<string, unknown> }>(
  briefing: T,
  ideAgentAnalysis: ReturnType<typeof buildIDEAgentAnalysisSurface>
): T & { ideAgentAnalysis: typeof ideAgentAnalysis; meta: Record<string, unknown> } {
  return {
    ...briefing,
    ideAgentAnalysis,
    meta: {
      ...(briefing.meta || {}),
      ideAgentAnalysis: {
        packetId: ideAgentAnalysis.packetSummary.packetId,
        profile: ideAgentAnalysis.packetSummary.profile,
        totalUnits: ideAgentAnalysis.progress.totalUnits,
        remainingUnits: ideAgentAnalysis.progress.remainingUnitIds.length,
      },
    },
  };
}

function attachColdStartOnboardingSurface<T extends { meta?: Record<string, unknown> }>(
  input: AttachColdStartOnboardingInput<T>
): T &
  ReturnType<typeof buildCodexColdStartOnboardingContract> & { meta: Record<string, unknown> } {
  const onboardingContract = buildCodexColdStartOnboardingContract({
    dataRoot: input.dataRoot,
    dimensions: input.dimensions,
    fileCount: input.allFiles.length,
    moduleCount: input.depGraphData?.nodes?.length || 0,
    primaryLanguage: input.primaryLang,
    projectRoot: input.projectRoot,
    projectType: input.projectType,
    secondaryLanguages: readSecondaryLanguages(input.langProfile),
    session: input.session,
  });
  return attachCodexOnboardingContract(input.briefing, onboardingContract);
}

function attachCodexOnboardingContract<T extends { meta?: Record<string, unknown> }>(
  briefing: T,
  onboardingContract: ReturnType<typeof buildCodexColdStartOnboardingContract>
): T &
  ReturnType<typeof buildCodexColdStartOnboardingContract> & { meta: Record<string, unknown> } {
  return {
    ...briefing,
    ...onboardingContract,
    meta: {
      ...(briefing.meta || {}),
      onboardingContract: {
        contractVersion: 1,
        currentDomainId: onboardingContract.progress.currentDomainId,
        stagedDomainCount: onboardingContract.domainQueue.length,
      },
    },
  };
}

function readSecondaryLanguages(langProfile: unknown): string[] {
  const secondary = (langProfile as { secondary?: unknown }).secondary;
  return Array.isArray(secondary)
    ? secondary.filter((item): item is string => typeof item === 'string')
    : [];
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
