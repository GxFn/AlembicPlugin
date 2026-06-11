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
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import { buildCodexColdStartOnboardingContract } from '#codex/status/OnboardingContract.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';

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
export async function runHostAgentColdStartWorkflow(ctx: McpContext) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
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

  return presentHostAgentColdStartResponse({
    cleanupResult,
    briefing: briefingWithOnboardingContract,
    dimensionCount: briefingDimensions.length,
    responseTimeMs: Date.now() - t0,
  });
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
