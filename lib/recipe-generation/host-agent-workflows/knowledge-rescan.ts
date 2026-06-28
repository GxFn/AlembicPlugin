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
  adviseCoverageLedger,
  auditRecipesForRescan,
  buildCoverageLedgerModuleAxisFromSummaries,
  buildHostAgentAnalysisPacketFromProjectContext,
  buildKnowledgeRescanPlan,
  buildKnowledgeRescanWorkflowPlan,
  buildProjectContextMissionBriefing,
  buildRescanPrescreen,
  type CoverageLedgerCandidate,
  type CoverageLedgerModuleAxis,
  type CoverageLedgerModuleSummary,
  createHostAgentKnowledgeRescanIntent,
  type DimensionDef,
  type ModuleCellBinding,
  type ModuleDimensionTarget,
  presentHostAgentKnowledgeRescanEmptyProject,
  presentHostAgentKnowledgeRescanResponse,
  projectHostAgentRescanEvidencePlan,
  resolveModuleTier,
  resolvePerCellTargetDefault,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
} from '@alembic/core/host-agent-workflows';
import type { EvolutionCoverageLedgerRepository } from '@alembic/core/repositories';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { buildLocalSelectionMismatch } from '#codex/HostProjectAlignment.js';
import { buildHostAgentAnalysisSurface } from '#codex/host-agent/HostAgentAnalysisSurface.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { runCommitDrivenMaintenance } from '#recipe-generation/evolution/git-diff-checkpoint/CommitDrivenMaintenance.js';
import type { GitDiffScanResult } from '#recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import {
  HostAgentFileChangeHandler,
  type UnifiedEvolutionReport,
} from '#recipe-generation/evolution/HostAgentFileChangeHandler.js';
import { buildPluginOpportunisticEvolutionSurface } from '#recipe-generation/evolution/PluginOpportunisticEvolution.js';
import {
  buildHostAgentProjectContextAnalysis,
  createProjectContextHostAgentSession,
  type HostAgentProjectContextAnalysis,
  releaseEmptyHostAgentSessionLeaseById,
  releaseEmptyHostAgentSessionLeaseForProject,
  selectProjectContextDimensions,
} from '#recipe-generation/host-agent-workflows/project-context-analysis.js';
import {
  acquirePlanGenerationLease,
  applyPlanGateToProjectAnalysisIntent,
  attachPlanGenerationGateData,
  type PlanGenerationGateReady,
  type PlanSelectionModuleBinding,
  resolvePlanGenerationGate,
} from '#recipe-generation/plan-generation-gate.js';
import { attachProjectContextCreationGuide } from '#recipe-generation/project-context-anchoring.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import {
  attachBriefingTransportMeta,
  attachFullBriefingRef,
  BRIEFING_INLINE_BUDGET_BYTES,
  budgetBriefingResponseData,
} from './briefing-budget.js';
import { attachPlanScopeTargetCounts } from './cold-start.js';
import {
  countTargetScopedCoverageItems,
  isTargetScopedCoverageModuleId,
  preferTargetScopedCoverageItems,
  uniqueTargetScopedCoverageModuleCount,
} from './coverage-ledger-target-axis.js';
import { writeCoverageLedgerForCompletion } from './coverage-ledger-write.js';
import {
  type KnowledgeIndexRebuildReport,
  rebuildLocalKnowledgeIndexes,
} from './knowledge-index-rebuild.js';

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

interface RescanUnifiedEvolutionResult {
  report: UnifiedEvolutionReport | null;
  routeError: string | null;
  scan: GitDiffScanResult;
  surface: Awaited<ReturnType<typeof buildPluginOpportunisticEvolutionSurface>>;
}

interface RescanCoverageLedgerSeedReport {
  aggregateOrRootModuleIds: string[];
  status: 'inconsistent' | 'skipped' | 'written';
  reason?: string;
  candidateCount: number;
  coveredPathCount: number;
  deferredCells: number;
  dimensionIds: string[];
  measuredCells: number;
  moduleCount: number;
  targetScopedCells: number;
  usableCells: number;
  writtenCells: number;
}

interface RescanBriefingBuildResult {
  briefing: Record<string, unknown>;
  sessionId: string;
}

interface OpenHostAgentRescanRoundResult {
  openRound: boolean;
  rescanId: string | null;
  roundIndex: number | null;
}

// ── 主入口 ─────────────────────────────────────────────────

export async function runHostAgentKnowledgeRescanWorkflow(ctx: McpContext, args: RescanInput) {
  const { runProjectIndexWorkflow } = await import('./project-index.js');
  return runProjectIndexWorkflow(ctx, args, { mode: 'incremental' });
}

export async function runHostAgentProjectIndexIncrementalWorkflow(
  ctx: McpContext,
  args: RescanInput
) {
  const t0 = Date.now();
  const planGate = await resolvePlanGenerationGate(ctx, args, {
    defaultStage: resolveDefaultRescanGenerationStage(args),
    toolName: 'alembic_rescan',
  });
  if (!planGate.ok) {
    return planGate.response;
  }
  releaseEmptyHostAgentSessionLeaseForProject({
    allowFreshEmpty: true,
    container: ctx.container,
    logger: ctx.logger,
    projectRoot: planGate.value.projectRoot,
    reason: 'rescan-route-replaces-empty-bootstrap-session',
    source: 'alembic_rescan',
  });
  const lease = acquirePlanGenerationLease({
    gate: planGate.value,
    idempotencyKey: args.rescanId,
    toolName: 'alembic_rescan',
  });
  if (!lease.ok) {
    return lease.response;
  }

  try {
    const state = await prepareRescanState(ctx, args, planGate.value);

    // 空项目 fast-path
    if (state.projectContextAnalysis.isEmpty) {
      const response = attachPlanGenerationGateData(
        presentHostAgentKnowledgeRescanEmptyProject({
          responseTimeMs: Date.now() - t0,
        }) as Record<string, unknown> & { meta?: Record<string, unknown> },
        state.planGate
      );
      attachHostProjectSelectionMismatch(response, state.projectRoot);
      return response;
    }

    return buildRescanResponse(ctx, state, Date.now() - t0);
  } finally {
    lease.lease.release();
  }
}

async function prepareRescanState(
  ctx: McpContext,
  args: RescanInput,
  planGate: PlanGenerationGateReady
) {
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const db = ctx.container.get('database');
  const intent = createHostAgentKnowledgeRescanIntent({
    ...args,
    contentMaxLines: planGate.scale.contentMaxLines,
    dimensions: planGate.planSelection.dimensions,
    force: planGate.cleanupPolicy === 'force-rescan',
    maxFiles: planGate.scale.maxFiles,
  });
  applyPlanGateToProjectAnalysisIntent(intent, planGate);
  // U2b chain：把 Agent 的 per-cell 目标（gate.moduleBindings）派生成意图侧 perDimensionTargets /
  // moduleDimensionTargets。两字段是 KnowledgeRescanWorkflowIntent 的加性字段；非空才设，零回归。
  // 这让「Agent confirm 的 per-(模块×维度) 目标 → intent → Core gap」链条显式且可在 buildRescanPlanning 直接读 state.intent。
  const { perDimensionTargets, moduleDimensionTargets } = derivePerCellTargetsFromGate(
    planGate.moduleBindings
  );
  if (Object.keys(perDimensionTargets).length > 0) {
    intent.perDimensionTargets = perDimensionTargets;
  }
  if (moduleDimensionTargets.length > 0) {
    intent.moduleDimensionTargets = moduleDimensionTargets;
  }
  // U2d：开新一轮 deep_mining_round 不在此处（prepareRescanState 早于 attachCoverageAdvisory）。
  // 收敛建议必须读「上一已完成轮」，故开轮挪到 attachCoverageAdvisory 之后（见 buildRescanResponse）。
  intent.cleanupPolicy =
    planGate.cleanupPolicy === 'full-reset' ? 'rescan-clean' : planGate.cleanupPolicy;
  intent.analysisMode = planGate.cleanupPolicy === 'force-rescan' ? 'full' : 'incremental';
  const plan = buildKnowledgeRescanWorkflowPlan({ intent, projectRoot, dataRoot });
  const { cleanResult, recipeSnapshot } = await runRescanCleanup({
    dataRoot,
    db,
    intent,
    logger: ctx.logger,
    plan,
  });

  ctx.logger.info(`[Rescan] Preserved ${recipeSnapshot.count} recipes`, {
    cleanupPolicy: intent.cleanupPolicy,
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // U6 P5：捕获 rebuild 报告（cleanupPolicy='none' 时不重建 → 无报告，置 null）。
  let indexRebuild: KnowledgeIndexRebuildReport | null = null;
  if (intent.cleanupPolicy !== 'none') {
    indexRebuild = await rebuildRescanIndexes(ctx, db);
  }

  const projectContextAnalysis = await buildHostAgentProjectContextAnalysis({
    maxFiles: plan.projectAnalysis.scan.maxFiles,
    moduleScope: planGate.moduleScope,
    projectRoot: plan.projectAnalysis.projectRoot,
    source: 'codex-host-rescan',
  });
  const coverageLedgerSeed = seedRescanCoverageLedgerFromSnapshot(ctx, {
    planGate,
    projectContextAnalysis,
    projectRoot,
    recipeEntries: recipeSnapshot.entries,
  });
  const unifiedEvolution = await runRescanUnifiedEvolution(ctx, {
    projectRoot,
  });
  const rescanId =
    typeof args.rescanId === 'string' && args.rescanId.length > 0 ? args.rescanId : null;

  return {
    cleanResult,
    coverageLedgerSeed,
    dataRoot,
    db,
    indexRebuild,
    intent,
    plan,
    planGate,
    projectContextAnalysis,
    projectRoot,
    rescanId,
    recipeSnapshot,
    unifiedEvolution,
  };
}

async function runRescanCleanup(input: {
  dataRoot: string;
  db: unknown;
  intent: ReturnType<typeof createHostAgentKnowledgeRescanIntent>;
  logger: McpContext['logger'];
  plan: ReturnType<typeof buildKnowledgeRescanWorkflowPlan>;
}) {
  if (input.intent.cleanupPolicy === 'force-rescan') {
    return runForceRescanCleanPolicy({
      projectRoot: input.plan.cleanup.projectRoot,
      dataRoot: input.dataRoot,
      db: input.db,
      logger: input.logger,
      createCleanupService: createWorkflowCleanupService,
    });
  }
  if (input.intent.cleanupPolicy === 'rescan-clean') {
    return runRescanCleanPolicy({
      projectRoot: input.plan.cleanup.projectRoot,
      dataRoot: input.dataRoot,
      db: input.db,
      logger: input.logger,
      createCleanupService: createWorkflowCleanupService,
    });
  }

  const cleanupService = createWorkflowCleanupService({
    projectRoot: input.plan.cleanup.projectRoot,
    dataRoot: input.dataRoot,
    db: input.db,
    logger: input.logger,
  });
  const recipeSnapshot = await cleanupService.snapshotRecipes();
  return {
    cleanResult: {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: recipeSnapshot.count,
      errors: [],
    },
    recipeSnapshot,
  };
}

async function rebuildRescanIndexes(
  ctx: McpContext,
  db: unknown
): Promise<KnowledgeIndexRebuildReport> {
  // 恢复 Recipe 文件 ↔ DB ↔ source-ref 桥接 ↔ semantic-region vectors。
  // rescanClean 保留 recipes/ 和 active/published/staging/evolving DB 记录，
  // 但可能清除派生桥接表；这里显式 reconcile source refs，再重建 region vectors。
  // U6 P5：返回 rebuild 报告（含 P4 renamed/applied + region-vector status）让 prepareRescanState
  // 把它带进 state，供 rescan 运维/响应感知 source-ref 修复与 region 信任证据缺口（之前被丢弃）。
  return rebuildLocalKnowledgeIndexes({
    container: ctx.container,
    db,
    logger: ctx.logger,
    logPrefix: 'Rescan',
  });
}

function seedRescanCoverageLedgerFromSnapshot(
  ctx: McpContext,
  input: {
    planGate: PlanGenerationGateReady;
    projectContextAnalysis: HostAgentProjectContextAnalysis;
    projectRoot: string;
    recipeEntries: ReadonlyArray<{
      dimensionId?: string;
      sourceFile?: string;
      sourceRefs?: readonly string[];
    }>;
  }
): RescanCoverageLedgerSeedReport {
  const empty = (reason: string): RescanCoverageLedgerSeedReport => ({
    aggregateOrRootModuleIds: [],
    status: 'skipped',
    reason,
    candidateCount: 0,
    coveredPathCount: 0,
    deferredCells: 0,
    dimensionIds: [],
    measuredCells: 0,
    moduleCount: 0,
    targetScopedCells: 0,
    usableCells: 0,
    writtenCells: 0,
  });

  if (
    input.planGate.generationStage !== 'deepMining' &&
    input.planGate.generationStage !== 'moduleMining'
  ) {
    return empty('unsupported-generation-stage');
  }

  try {
    const repository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repository) {
      return empty('coverage-ledger-repository-unavailable');
    }

    const dimensionIds = uniqueStrings(input.planGate.dimensionIds);
    if (dimensionIds.length === 0) {
      return empty('no-selected-dimensions');
    }

    const moduleAxis = buildRescanCoverageModuleAxis(input.projectContextAnalysis, input.planGate);
    const targetAxis = preferTargetScopedCoverageItems(moduleAxis.modules);
    const existingTargetCellCount =
      targetAxis.targetScopedCount === 0
        ? countTargetScopedCoverageItems(repository.listByProjectRoot(input.projectRoot))
        : 0;
    if (targetAxis.filteredCount > 0) {
      ctx.logger.info('[Rescan] Coverage ledger module axis filtered to target scope', {
        filteredModuleCount: targetAxis.filteredCount,
        moduleAxisSource: moduleAxis.source,
        projectRoot: input.projectRoot,
        targetScopedModuleCount: targetAxis.targetScopedCount,
      });
    }
    if (
      moduleAxis.source === 'rescan-snapshot' &&
      targetAxis.targetScopedCount === 0 &&
      existingTargetCellCount > 0
    ) {
      ctx.logger.info(
        '[Rescan] coverage ledger seed skipped: existing target axis would be polluted by aggregate modules',
        {
          existingTargetCellCount,
          moduleAxisSource: moduleAxis.source,
          projectRoot: input.projectRoot,
          rawModuleCount: moduleAxis.modules.length,
        }
      );
      return empty('target-axis-present-no-target-modules');
    }
    const modules = targetAxis.items;
    if (modules.length === 0) {
      return empty('no-project-context-modules');
    }
    ctx.logger.info('[Rescan] Coverage ledger module axis resolved', {
      moduleAxisSource: moduleAxis.source,
      moduleCount: modules.length,
      projectRoot: input.projectRoot,
    });

    const selectedDimensions = new Set(dimensionIds);
    const coveredPaths = uniqueStrings(
      input.recipeEntries.flatMap((entry) => {
        if (!entry.dimensionId || !selectedDimensions.has(entry.dimensionId)) {
          return [];
        }
        return collectRecipeSourcePaths(entry);
      })
    );

    const candidates: CoverageLedgerCandidate[] = [
      ...input.recipeEntries.flatMap((entry) => {
        if (!entry.dimensionId || !selectedDimensions.has(entry.dimensionId)) {
          return [];
        }
        const refs = collectRecipeSourcePaths(entry);
        return refs.length > 0
          ? [{ dimensionIds: [entry.dimensionId], sourceRefPaths: refs, importance: 70 }]
          : [];
      }),
      ...modules.flatMap((module) =>
        dimensionIds.map((dimensionId) => ({
          dimensionIds: [dimensionId],
          sourceRefPaths: [...module.ownedPaths],
          importance: 50,
        }))
      ),
    ];

    if (candidates.length === 0) {
      return empty('no-source-ref-or-module-candidates');
    }

    const latestRound = repository.listRoundsByProjectRoot(input.projectRoot).at(-1) ?? null;
    const tier = resolveModuleTier(modules.length);
    const perCellTarget = resolvePerCellTargetDefault(tier);
    const result = writeCoverageLedgerForCompletion({
      repository,
      projectRoot: input.projectRoot,
      modules,
      dimensionIds,
      candidates,
      coveredPaths,
      perCellTarget,
      lastRound: latestRound?.roundIndex ?? 0,
      logger: ctx.logger,
    });
    const seedSummary = summarizeCoverageLedgerSeed(result.cells);

    const report: RescanCoverageLedgerSeedReport = {
      aggregateOrRootModuleIds: seedSummary.aggregateOrRootModuleIds,
      status: 'written',
      candidateCount: candidates.length,
      coveredPathCount: seedSummary.coveredPathCount,
      deferredCells: result.deferredCells,
      dimensionIds,
      measuredCells: seedSummary.measuredCells,
      moduleCount: seedSummary.moduleCount,
      targetScopedCells: seedSummary.targetScopedCells,
      usableCells: seedSummary.usableCells,
      writtenCells: result.writtenCells,
    };
    ctx.logger.info('[Rescan] Coverage ledger seeded from existing recipe evidence', {
      ...report,
      projectRoot: input.projectRoot,
    });
    return report;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn('[Rescan] coverage ledger seed skipped (advisory, non-blocking)', {
      projectRoot: input.projectRoot,
      reason,
    });
    return empty(reason);
  }
}

function reconcileCoverageLedgerSeedWithPersistedState(
  ctx: McpContext,
  projectRoot: string,
  seed: RescanCoverageLedgerSeedReport
): RescanCoverageLedgerSeedReport {
  try {
    const repository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repository) {
      return seed;
    }
    const persistedCells = repository.listByProjectRoot(projectRoot);
    if (persistedCells.length === 0) {
      return seed;
    }
    const persistedSummary = summarizeCoverageLedgerSeed(persistedCells);
    const dimensionIds = uniqueStrings(persistedCells.map((cell) => cell.dimensionId));
    const persistedSeed: RescanCoverageLedgerSeedReport = {
      ...seed,
      aggregateOrRootModuleIds: persistedSummary.aggregateOrRootModuleIds,
      coveredPathCount: persistedSummary.coveredPathCount,
      dimensionIds: dimensionIds.length > 0 ? dimensionIds : seed.dimensionIds,
      measuredCells: persistedSummary.measuredCells,
      moduleCount: persistedSummary.moduleCount,
      targetScopedCells: persistedSummary.targetScopedCells,
      usableCells: persistedSummary.usableCells,
      writtenCells: persistedCells.length,
    };
    const inconsistentReasons = coverageLedgerSeedInconsistencyReasons(seed, persistedSeed);
    if (inconsistentReasons.length === 0) {
      return persistedSeed;
    }
    const reason = inconsistentReasons.join(',');
    ctx.logger.warn('[Rescan] coverage ledger seed reconciled with persisted state', {
      aggregateOrRootModuleIds: persistedSeed.aggregateOrRootModuleIds,
      projectRoot,
      reason,
      routeMeasuredCells: seed.measuredCells,
      routeWrittenCells: seed.writtenCells,
      persistedMeasuredCells: persistedSeed.measuredCells,
      persistedWrittenCells: persistedSeed.writtenCells,
    });
    return {
      ...persistedSeed,
      status: 'inconsistent',
      reason,
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn('[Rescan] coverage ledger seed persisted-state reconciliation skipped', {
      projectRoot,
      reason,
    });
    return seed;
  }
}

function coverageLedgerSeedInconsistencyReasons(
  routeSeed: RescanCoverageLedgerSeedReport,
  persistedSeed: RescanCoverageLedgerSeedReport
): string[] {
  const reasons: string[] = [];
  if (persistedSeed.aggregateOrRootModuleIds.length > 0) {
    reasons.push('persisted-aggregate-or-root-coverage-cells');
  }
  if (routeSeed.writtenCells !== persistedSeed.writtenCells) {
    reasons.push('persisted-written-cell-count-mismatch');
  }
  if (routeSeed.measuredCells !== persistedSeed.measuredCells) {
    reasons.push('persisted-measured-cell-count-mismatch');
  }
  if (routeSeed.targetScopedCells !== persistedSeed.targetScopedCells) {
    reasons.push('persisted-target-scoped-cell-count-mismatch');
  }
  return uniqueStrings(reasons);
}

type RescanCoverageModuleAxisSource = 'project-map' | 'rescan-snapshot';
type RescanCoverageResolvedModuleAxisSource =
  | RescanCoverageModuleAxisSource
  | 'project-context-targets';

export function buildRescanCoverageModuleAxis(
  analysis: HostAgentProjectContextAnalysis,
  planGate: PlanGenerationGateReady
): { modules: CoverageLedgerModuleAxis[]; source: RescanCoverageResolvedModuleAxisSource } {
  const projectMapModules = buildCoverageLedgerModuleAxisFromSummaries({
    modules: buildProjectMapCoverageModuleSummaries(analysis, planGate),
  });
  if (projectMapModules.length > 0) {
    return { modules: projectMapModules, source: 'project-map' };
  }
  const projectContextTargetModules = buildCoverageLedgerModuleAxisFromSummaries({
    modules: buildProjectContextTargetCoverageModuleSummaries(analysis, planGate),
  });
  if (projectContextTargetModules.length > 0) {
    return { modules: projectContextTargetModules, source: 'project-context-targets' };
  }
  return {
    modules: buildRescanSnapshotCoverageModules(analysis, planGate),
    source: 'rescan-snapshot',
  };
}

function buildProjectMapCoverageModuleSummaries(
  analysis: HostAgentProjectContextAnalysis,
  planGate: PlanGenerationGateReady
): CoverageLedgerModuleSummary[] {
  const modules = new Map<string, CoverageLedgerModuleSummary>();
  for (const module of analysis.presenterInput.map?.modules ?? []) {
    const moduleId = normalizeTargetScopedCoverageModuleId({
      moduleId: module.id,
      moduleName: module.name,
      modulePath: module.ref?.scope.filePath,
      projectRoot: planGate.projectRoot,
    });
    const moduleName = module.name.trim() || moduleId;
    const modulePath = module.ref?.scope.filePath
      ? normalizeCoverageSourcePath(module.ref.scope.filePath)
      : undefined;
    if (!moduleId || !moduleName || !modulePath) {
      continue;
    }
    const existing = modules.get(moduleId);
    modules.set(moduleId, {
      moduleId,
      moduleName,
      modulePath,
      ownedPaths: uniqueStrings([...(existing?.ownedPaths ?? []), modulePath]),
    });
  }
  return [...modules.values()];
}

function buildProjectContextTargetCoverageModuleSummaries(
  analysis: HostAgentProjectContextAnalysis,
  planGate: PlanGenerationGateReady
): CoverageLedgerModuleSummary[] {
  const targetNames = uniqueStrings(
    (analysis.presenterInput.repo?.targets ?? []).map((target) => target.name)
  );
  if (targetNames.length === 0 || analysis.sourceFileFacts.length === 0) {
    return [];
  }

  const requestedScopes = uniqueStrings(
    [
      ...(planGate.moduleScope ?? []),
      ...(planGate.moduleBindings ?? []).flatMap((binding) => [
        binding.modulePath,
        binding.moduleId,
        canonicalModuleNameFromBinding(binding),
      ]),
    ].filter((value): value is string => typeof value === 'string')
  );
  const projectRootName = basenameFromPath(planGate.projectRoot);
  const modules = new Map<string, CoverageLedgerModuleSummary>();
  for (const targetName of targetNames) {
    const modulePath = inferTargetModulePathFromSourceFacts(targetName, analysis.sourceFileFacts);
    if (!modulePath) {
      continue;
    }
    const moduleId = normalizeTargetScopedCoverageModuleId({
      moduleName: targetName,
      modulePath,
      projectRoot: planGate.projectRoot,
    });
    if (!moduleId || isAggregateProjectTarget(targetName, modulePath, projectRootName)) {
      continue;
    }
    if (
      requestedScopes.length > 0 &&
      !requestedScopes.some((scope) => coverageScopeMatchesModule(scope, targetName, modulePath))
    ) {
      continue;
    }
    const ownedPaths = uniqueStrings(
      analysis.sourceFileFacts
        .map((file) => normalizeCoverageSourcePath(file.filePath))
        .filter((filePath) => coveragePathWithin(filePath, modulePath))
    );
    if (ownedPaths.length === 0) {
      continue;
    }
    modules.set(moduleId, {
      moduleId,
      moduleName: targetName,
      modulePath,
      ownedPaths,
    });
  }

  if (modules.size > 0) {
    return [...modules.values()];
  }

  return buildUnscopedProjectContextTargetCoverageModuleSummaries(
    analysis,
    planGate,
    targetNames,
    projectRootName
  );
}

function buildUnscopedProjectContextTargetCoverageModuleSummaries(
  analysis: HostAgentProjectContextAnalysis,
  planGate: PlanGenerationGateReady,
  targetNames: readonly string[],
  projectRootName: string | undefined
): CoverageLedgerModuleSummary[] {
  const modules = new Map<string, CoverageLedgerModuleSummary>();
  for (const targetName of targetNames) {
    const modulePath = inferTargetModulePathFromSourceFacts(targetName, analysis.sourceFileFacts);
    if (!modulePath || isAggregateProjectTarget(targetName, modulePath, projectRootName)) {
      continue;
    }
    const moduleId = normalizeTargetScopedCoverageModuleId({
      moduleName: targetName,
      modulePath,
      projectRoot: planGate.projectRoot,
    });
    if (!moduleId) {
      continue;
    }
    const ownedPaths = uniqueStrings(
      analysis.sourceFileFacts
        .map((file) => normalizeCoverageSourcePath(file.filePath))
        .filter((filePath) => coveragePathWithin(filePath, modulePath))
    );
    if (ownedPaths.length === 0) {
      continue;
    }
    modules.set(moduleId, {
      moduleId,
      moduleName: targetName,
      modulePath,
      ownedPaths,
    });
  }
  return [...modules.values()];
}

function inferTargetModulePathFromSourceFacts(
  targetName: string,
  sourceFileFacts: readonly HostAgentProjectContextAnalysis['sourceFileFacts'][number][]
): string | undefined {
  const normalizedTargetName = targetName.trim();
  if (!normalizedTargetName) {
    return undefined;
  }
  const modulePaths = sourceFileFacts
    .flatMap((file) => inferTargetModulePathsFromSourcePath(normalizedTargetName, file.filePath))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return modulePaths[0];
}

function inferTargetModulePathsFromSourcePath(targetName: string, filePath: string): string[] {
  const normalizedPath = normalizeCoverageSourcePath(filePath);
  const parts = normalizedPath.split('/').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === targetName) {
      paths.push(parts.slice(0, index + 1).join('/'));
    }
  }
  return uniqueStrings(paths);
}

function normalizeTargetScopedCoverageModuleId(input: {
  moduleId?: string;
  moduleName?: string;
  modulePath?: string;
  projectRoot?: string;
}): string | undefined {
  const existingId = input.moduleId?.trim();
  if (isTargetScopedCoverageModuleId(existingId)) {
    return existingId;
  }
  const modulePath = input.modulePath ? normalizeCoverageSourcePath(input.modulePath) : undefined;
  const moduleName = input.moduleName?.trim() || basenameFromPath(modulePath);
  if (
    !moduleName ||
    !modulePath ||
    isAggregateProjectTarget(moduleName, modulePath, basenameFromPath(input.projectRoot))
  ) {
    return undefined;
  }
  return `target:${moduleName}:${modulePath}`;
}

function isAggregateProjectTarget(
  moduleName: string,
  modulePath: string,
  projectRootName: string | undefined
): boolean {
  const normalizedName = moduleName.trim();
  const normalizedPath = normalizeCoverageSourcePath(modulePath);
  if (!normalizedName || normalizedName === 'root' || normalizedPath === 'root') {
    return true;
  }
  return Boolean(
    projectRootName &&
      normalizedName === projectRootName &&
      (normalizedPath === projectRootName || normalizedPath === '.')
  );
}

function coverageScopeMatchesModule(
  scope: string,
  moduleName: string,
  modulePath: string
): boolean {
  const normalizedScope = normalizeCoverageSourcePath(scope);
  if (!normalizedScope) {
    return false;
  }
  const moduleAliases = uniqueStrings([
    moduleName,
    modulePath,
    basenameFromPath(modulePath) ?? '',
    `target:${moduleName}:${modulePath}`,
  ]);
  return moduleAliases.some(
    (alias) =>
      normalizedScope === alias ||
      alias === normalizedScope ||
      alias.startsWith(`${normalizedScope}/`) ||
      normalizedScope.startsWith(`${alias}/`)
  );
}

function coveragePathWithin(filePath: string, modulePath: string): boolean {
  return filePath === modulePath || filePath.startsWith(`${modulePath}/`);
}

function buildRescanSnapshotCoverageModules(
  analysis: HostAgentProjectContextAnalysis,
  planGate: PlanGenerationGateReady
): CoverageLedgerModuleAxis[] {
  const modules = new Map<string, CoverageLedgerModuleSummary>();
  const add = (input: {
    moduleId?: string;
    moduleName?: string;
    modulePath?: string;
    ownedPaths?: readonly string[];
  }) => {
    const moduleName = input.moduleName?.trim() || input.moduleId?.trim() || input.modulePath;
    const moduleId = input.moduleId?.trim() || input.modulePath?.trim() || moduleName;
    if (!moduleId) {
      return;
    }
    const ownedPaths = uniqueStrings(
      [...(input.ownedPaths ?? []), input.modulePath].flatMap((value) =>
        value ? [normalizeCoverageSourcePath(value)] : []
      )
    );
    if (ownedPaths.length === 0) {
      return;
    }
    const existing = modules.get(moduleId);
    modules.set(moduleId, {
      moduleId,
      ...(moduleName ? { moduleName } : {}),
      ownedPaths: uniqueStrings([...(existing?.ownedPaths ?? []), ...ownedPaths]),
    });
  };

  for (const seed of analysis.moduleSeeds) {
    add({
      moduleId: seed.moduleId,
      moduleName: seed.moduleName,
      modulePath: seed.modulePath,
      ownedPaths: seed.ownedFiles,
    });
  }
  for (const binding of planGate.moduleBindings) {
    add({
      moduleId: binding.moduleId,
      moduleName: canonicalModuleNameFromBinding(binding),
      modulePath: binding.modulePath,
    });
  }

  return buildCoverageLedgerModuleAxisFromSummaries({ modules: [...modules.values()] });
}

function collectRecipeSourcePaths(entry: {
  sourceFile?: string;
  sourceRefs?: readonly string[];
}): string[] {
  return uniqueStrings(
    [...(entry.sourceRefs ?? []), entry.sourceFile].flatMap((value) =>
      value ? [normalizeCoverageSourcePath(value)] : []
    )
  );
}

function normalizeCoverageSourcePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/^\.\//, '');
}

function basenameFromPath(value: string | undefined): string | undefined {
  const normalized = value ? normalizeCoverageSourcePath(value) : '';
  return normalized.split('/').filter(Boolean).at(-1);
}

function summarizeCoverageLedgerSeed(
  cells: readonly CoverageLedgerCandidateCellLike[]
): Pick<
  RescanCoverageLedgerSeedReport,
  | 'aggregateOrRootModuleIds'
  | 'coveredPathCount'
  | 'measuredCells'
  | 'moduleCount'
  | 'targetScopedCells'
  | 'usableCells'
> {
  const targetScopedCells = cells.filter((cell) => isTargetScopedCoverageModuleId(cell.moduleId));
  const measuredCells = targetScopedCells.filter(
    (cell) => (cell.coveredCount ?? 0) > 0 || (cell.coveredSourceRefs?.length ?? 0) > 0
  );
  return {
    aggregateOrRootModuleIds: uniqueStrings(
      cells.map((cell) => cell.moduleId).filter(isAggregateOrRootCoverageModuleId)
    ),
    coveredPathCount: uniqueStrings(
      targetScopedCells.flatMap((cell) => cell.coveredSourceRefs ?? [])
    ).length,
    measuredCells: measuredCells.length,
    moduleCount: uniqueStrings(targetScopedCells.map((cell) => cell.moduleId)).length,
    targetScopedCells: targetScopedCells.length,
    usableCells: targetScopedCells.length,
  };
}

interface CoverageLedgerCandidateCellLike {
  coveredCount?: number;
  coveredSourceRefs?: readonly string[];
  moduleId: string;
  totalCandidateCount?: number;
  uncoveredHints?: readonly string[];
}

function isAggregateOrRootCoverageModuleId(moduleId: string | undefined): moduleId is string {
  if (!moduleId) {
    return false;
  }
  const normalized = moduleId.trim();
  return (
    normalized === 'root' ||
    normalized === 'module:root' ||
    normalized.startsWith('module:root:') ||
    !isTargetScopedCoverageModuleId(normalized)
  );
}

function attachCoverageLedgerSeedMeta(
  response: Record<string, unknown> & { meta?: Record<string, unknown> },
  seed: RescanCoverageLedgerSeedReport
): void {
  const coverageLedgerSeed = {
    status: seed.status,
    ...(seed.reason ? { reason: seed.reason } : {}),
    aggregateOrRootModuleIds: seed.aggregateOrRootModuleIds,
    writtenCells: seed.writtenCells,
    coveredPathCount: seed.coveredPathCount,
    measuredCells: seed.measuredCells,
    moduleCount: seed.moduleCount,
    targetScopedCells: seed.targetScopedCells,
    usableCells: seed.usableCells,
    dimensionIds: seed.dimensionIds,
  };
  const meta =
    response.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
      ? (response.meta as Record<string, unknown>)
      : {};
  response.meta = meta;
  meta.coverageLedgerSeed = coverageLedgerSeed;

  const data = readRecord(response.data);
  if (data) {
    data.coverageLedgerSeed = coverageLedgerSeed;
    const dataMeta = readRecord(data.meta) ?? {};
    data.meta = {
      ...dataMeta,
      coverageLedgerSeed,
    };
  }
}

function releaseNoWorkRescanSession(
  ctx: McpContext,
  response: Record<string, unknown> & { message?: string; meta?: Record<string, unknown> },
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  sessionId: string,
  coverageAdvisory: {
    highValueBlankCount: number;
    shouldStop: boolean;
    stopReason: string;
    suggestion: string | null;
  }
): void {
  const release = releaseEmptyHostAgentSessionLeaseById({
    container: ctx.container,
    logger: ctx.logger,
    projectRoot: state.projectRoot,
    reason: `${state.planGate.generationStage}-${coverageAdvisory.stopReason}`,
    sessionId,
    source: 'alembic_rescan',
  });
  const closedRounds = closeOpenHostAgentRescanRounds(ctx, state.projectRoot, Date.now());

  const data = readRecord(response.data);
  if (data) {
    data.session = null;
    data.noActionableHostAgentWork = {
      generationStage: state.planGate.generationStage,
      closedOpenRound: closedRounds.count > 0,
      closedOpenRounds: closedRounds.count,
      releasedEmptySession: release.released,
      sessionId: release.released ? sessionId : null,
      stopReason: coverageAdvisory.stopReason,
    };
  }
  const meta =
    response.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
      ? (response.meta as Record<string, unknown>)
      : {};
  response.meta = meta;
  meta.noActionableHostAgentWork = {
    generationStage: state.planGate.generationStage,
    closedOpenRound: closedRounds.count > 0,
    closedOpenRounds: closedRounds.count,
    releasedEmptySession: release.released,
    stopReason: coverageAdvisory.stopReason,
  };
  response.message = `${response.message ?? ''} coverageAdvisory=${coverageAdvisory.stopReason}，本次 ${state.planGate.generationStage} 不保留空 host-agent session。`;
}

function attachActionRequiredRescanLifecycle(
  response: Record<string, unknown> & { message?: string; meta?: Record<string, unknown> },
  input: {
    coverageAdvisory: {
      highValueBlankCount: number;
      shouldStop: boolean;
      stopReason: string;
      suggestion: string | null;
    } | null;
    executionDimensionCount: number;
    generationStage: string;
    openRound: OpenHostAgentRescanRoundResult;
    produceDimensionCount: number;
    seed: RescanCoverageLedgerSeedReport;
  }
): void {
  const actionReason =
    input.coverageAdvisory?.shouldStop === false
      ? 'coverage-advisory-continue'
      : `coverage-advisory-${input.coverageAdvisory?.stopReason ?? 'missing'}-with-produce-dimensions`;
  const hostAgentLifecycle = {
    actionRequired: true,
    actionReason,
    coverage: {
      highValueBlankCount: input.coverageAdvisory?.highValueBlankCount ?? null,
      measuredCells: input.seed.measuredCells,
      shouldStop: input.coverageAdvisory?.shouldStop ?? null,
      stopReason: input.coverageAdvisory?.stopReason ?? null,
      targetScopedCells: input.seed.targetScopedCells,
    },
    generationStage: input.generationStage,
    nextExpectedTools: [
      'alembic_recipe_map',
      'alembic_graph',
      'alembic_submit_knowledge',
      'alembic_dimension_complete',
    ],
    planning: {
      executionDimensionCount: input.executionDimensionCount,
      produceDimensionCount: input.produceDimensionCount,
    },
    round: {
      open: input.openRound.openRound,
      rescanId: input.openRound.rescanId,
      roundIndex: input.openRound.roundIndex,
      triggerActor: 'host-agent-rescan',
    },
    session: {
      active: true,
      releasePolicy:
        'keep until session-bound submit_knowledge + dimension_complete closes the dimension, or a terminal no-output advisory releases an empty session',
    },
    state: 'action-required',
    terminal: false,
    terminalGate: {
      pass: false,
      reason: 'host-agent-action-required',
    },
  };

  const data = readRecord(response.data);
  if (data) {
    data.hostAgentLifecycle = hostAgentLifecycle;
  }
  response.message = `${response.message ?? ''} hostAgentLifecycle=action-required，${input.generationStage} 仍需 session-bound Recipe evidence；terminalGate=false。`;
}

async function buildRescanResponse(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  responseTimeMs: number
) {
  const planning = await buildRescanPlanning(ctx, state);
  const briefingResult = buildRescanBriefing(ctx, state, planning);
  const response = presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot: state.recipeSnapshot,
    cleanResult: state.cleanResult,
    auditSummary: planning.auditSummary,
    briefing: briefingResult.briefing,
    evidencePlan: planning.evidencePlan,
    dimensions: planning.requestedDimensions,
    reason: state.intent.reason,
    responseTimeMs,
  }) as Record<string, unknown> & { message?: string; meta?: Record<string, unknown> };

  attachPlanGenerationGateData(response, state.planGate);
  attachRescanUnifiedEvolution(response, state.unifiedEvolution);
  attachTrashArchiveMessage(response, state.cleanResult);
  attachHostProjectSelectionMismatch(response, state.projectRoot);
  attachCoverageLedgerSeedMeta(response, state.coverageLedgerSeed);
  // U2d：附覆盖账本收敛建议（ADVISORY）。放在预算化之前 → 建议进 response.data 并一起被预算。
  // 严格非阻断：绝不设任何 blocking/gate 标志、绝不自动触发再扫一轮——是否再扫由用户/宿主决定。
  const coverageAdvisory = attachCoverageAdvisory(ctx, response, state);
  const hasActionableProduceWork =
    state.planGate.generationStage === 'deepMining' && planning.produceDimensionCount > 0;
  const terminalCoverageAdvisory =
    coverageAdvisory?.shouldStop === true && isTerminalCoverageAdvisory(coverageAdvisory);
  const noActionableRescanWork =
    coverageAdvisory?.shouldStop === true &&
    (!hasActionableProduceWork || terminalCoverageAdvisory);
  if (
    coverageAdvisory?.shouldStop === true &&
    hasActionableProduceWork &&
    !terminalCoverageAdvisory
  ) {
    ctx.logger.info(
      '[Rescan] Keeping deepMining round/session open despite coverage advisory stop because produce dimensions exist',
      {
        executionDimensions: planning.executionDimensionCount,
        produceDimensions: planning.produceDimensionCount,
        rescanId: state.rescanId,
        stopReason: coverageAdvisory.stopReason,
      }
    );
  }
  if (noActionableRescanWork) {
    releaseNoWorkRescanSession(ctx, response, state, briefingResult.sessionId, coverageAdvisory);
  }
  // U2d：收敛建议读完「上一已完成轮」之后，再为本次 deepMining rescan 开新一轮（startedAt+triggerActor）。
  // 顺序关键：必须在 attachCoverageAdvisory 之后开轮，否则 advisory 会把刚开的、产出尚为 0 的本轮当成「上一轮」，
  // 触发 new_recipes_this_round(0)<K 的收益递减误判，使多轮循环每轮立即停止。新轮在 rescan 返回前开好，
  // 供随后的 dimension_complete 回流累计 new_recipes_this_round / completedAt（轮次边界=plan-confirm 到该轮全部回流）。
  // coldStart/moduleMining rescan 不是 deepMining 轮次，用 stage 守卫排除。best-effort、不阻断。
  let openRound: OpenHostAgentRescanRoundResult = {
    openRound: false,
    rescanId: state.rescanId ?? null,
    roundIndex: null,
  };
  if (state.planGate.generationStage === 'deepMining' && !noActionableRescanWork) {
    openRound = openDeepMiningRound(ctx, state.projectRoot, state.rescanId);
  }
  if (
    state.planGate.generationStage === 'deepMining' &&
    hasActionableProduceWork &&
    !noActionableRescanWork
  ) {
    attachActionRequiredRescanLifecycle(response, {
      coverageAdvisory,
      executionDimensionCount: planning.executionDimensionCount,
      generationStage: state.planGate.generationStage,
      openRound,
      produceDimensionCount: planning.produceDimensionCount,
      seed: state.coverageLedgerSeed,
    });
  }
  // Keep the seed in the final full-briefing body after advisory/session/round mutations.
  attachCoverageLedgerSeedMeta(
    response,
    reconcileCoverageLedgerSeedWithPersistedState(ctx, state.projectRoot, state.coverageLedgerSeed)
  );
  // U3 item3：在所有 attach*（unifiedEvolution/trashArchive/projectSelectionMismatch）之后，对完整
  // response.data 做内联预算化（与 cold-start 共享同一步骤/口径）。≤18KB 内联并清理遗留 transient；
  // >预算把完整 data 写入 'rescan-briefing' transient transport，再经 attachFullBriefingRef 把引用写进
  // data.meta.fullBriefingRef；随后把该 ref 投影到 clean output 会保留的顶层 response.meta.fullBriefingRef。
  // rescan 不提供 compact 回调，故超预算只附 transient 引用、不瘦身内联（与 cold-start 的逐级压缩有意不对称）。
  await budgetBriefingResponseData(response, {
    dataRoot: state.dataRoot,
    projectRoot: state.projectRoot,
    transportName: 'rescan-briefing',
    inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
    attachRef: (data, ref) => attachFullBriefingRef(data, ref),
  });
  attachBriefingTransportMeta(response, readRecord(response.data) ?? {});
  return response;
}

function isTerminalCoverageAdvisory(input: { stopReason: string }): boolean {
  return input.stopReason === 'diminishing-returns' || input.stopReason === 'round-cap';
}

function closeOpenHostAgentRescanRounds(
  ctx: McpContext,
  projectRoot: string,
  now: number
): { count: number; roundIndexes: number[] } {
  try {
    const repository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repository) {
      return { count: 0, roundIndexes: [] };
    }
    const openRounds = repository
      .listRoundsByProjectRoot(projectRoot)
      .filter((round) => round.triggerActor === 'host-agent-rescan' && round.completedAt === null);
    if (openRounds.length === 0) {
      return { count: 0, roundIndexes: [] };
    }
    for (const openRound of openRounds) {
      repository.upsertRound({
        projectRoot,
        roundIndex: openRound.roundIndex,
        ...(openRound.rescanId ? { rescanId: openRound.rescanId } : {}),
        completedAt: now,
        newRecipesThisRound: openRound.newRecipesThisRound,
      });
    }
    return { count: openRounds.length, roundIndexes: openRounds.map((round) => round.roundIndex) };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn('[Rescan] host-agent rescan round close skipped', { projectRoot, reason });
    return { count: 0, roundIndexes: [] };
  }
}

function resolveDefaultRescanGenerationStage(args: RescanInput): 'deepMining' | 'moduleMining' {
  if (args.generationStage === 'moduleMining' || (args.moduleScope?.length ?? 0) > 0) {
    return 'moduleMining';
  }
  return 'deepMining';
}

/**
 * U2b chain：从覆盖账本读「每维已覆盖计数」（coveredCount 求和）。best-effort：
 * 账本不可用 / 读失败 / 为空 → 返回空对象，Core 退回现算（零回归）。
 * D3：只读 coverage_ledger，绝不触达 git_diff_checkpoints。
 */
function loadLedgerCoverageByDimension(
  ctx: McpContext,
  projectRoot: string
): Record<string, number> {
  try {
    const repo = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repo) {
      return {};
    }
    const cells = repo.listByProjectRoot(projectRoot);
    if (cells.length === 0) {
      return {};
    }
    const coverageByDimension: Record<string, number> = {};
    for (const cell of cells) {
      coverageByDimension[cell.dimensionId] =
        (coverageByDimension[cell.dimensionId] ?? 0) + cell.coveredCount;
    }
    return coverageByDimension;
  } catch (_err: unknown) {
    // 读账本失败绝不影响 rescan 规划：吞掉异常、返回空对象让 Core 现算覆盖。
    return {};
  }
}

/**
 * U2d：在 deepMining rescan 起点开一轮 deep_mining_round。
 *
 * 轮次边界 = plan-confirm 到该轮所有 dimension_complete 回流。这里只「开轮」（startedAt + triggerActor），
 * new_recipes_this_round / completedAt 由后续 dimension_complete 回流更新（本卡不强求，缺省 0）。
 * 有 rescanId 时沿用 Core 的 rescan-aware 幂等语义：同一 rescanId 重复进入 deepMining 只复用原轮号。
 * 无 rescanId 时维持旧行为：轮号 = (现有最大轮号 + 1)。
 * best-effort：repo 不可用 / 写失败都吞掉，绝不阻断 rescan。D3：只写 coverage 账本侧的 round 表，不碰 git-diff checkpoint。
 */
function openDeepMiningRound(
  ctx: McpContext,
  projectRoot: string,
  rescanId?: string | null
): OpenHostAgentRescanRoundResult {
  try {
    const repo = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repo) {
      return { openRound: false, rescanId: rescanId ?? null, roundIndex: null };
    }
    const existing = repo.listRoundsByProjectRoot(projectRoot);
    const existingForRescanId =
      rescanId === null || rescanId === undefined
        ? null
        : (existing.find((round) => round.rescanId === rescanId) ?? null);
    // listRoundsByProjectRoot 升序，末元素为当前最大轮号；有 rescanId 命中则复用原轮号，否则无轮次首轮 = 1。
    const nextIndex =
      existingForRescanId?.roundIndex ??
      (existing.length > 0 ? existing[existing.length - 1].roundIndex + 1 : 1);
    const round = repo.upsertRound({
      projectRoot,
      roundIndex: nextIndex,
      ...(rescanId ? { rescanId } : {}),
      startedAt: Date.now(),
      triggerActor: 'host-agent-rescan',
    });
    ctx.logger.info('[Rescan] Opened deepMining round (advisory round boundary)', {
      projectRoot,
      roundIndex: nextIndex,
      rescanId,
    });
    return {
      openRound: true,
      rescanId: round.rescanId ?? rescanId ?? null,
      roundIndex: round.roundIndex,
    };
  } catch (_err: unknown) {
    // 开轮失败绝不阻断 rescan：吞掉异常（advisory 轮次记录缺失只影响后续收敛建议精度）。
    return { openRound: false, rescanId: rescanId ?? null, roundIndex: null };
  }
}

async function buildRescanPlanning(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>
) {
  const auditSummary = await auditRecipesForRescan({
    container: ctx.container,
    logger: ctx.logger,
    recipeEntries: state.recipeSnapshot.entries,
    allFiles: projectContextFilesForRescanAudit(state.projectContextAnalysis.sourceFileFacts),
    projectRoot: state.projectRoot,
  });

  // U1 #2：把 gate.moduleBindings（per-模块意图，含 dimensions/targetRecipes）拍扁成 Core 的 per-cell
  // ModuleCellBinding[]，透传给 buildKnowledgeRescanPlan 驱动 per-(模块×维度) gap。canonical moduleCount
  // 取自 presenterInput.map.modules.length（ProjectMap 权威模块列表），用于 Core perCellTarget tier 回退；
  // map 不可用时传 undefined，Core 退回「本批去重模块数」（零回归）。flat moduleScope 出口不受影响。
  const moduleCellBindings = flattenModuleBindingsToCells(state.planGate.moduleBindings);
  const canonicalModuleCount = state.projectContextAnalysis.presenterInput.map?.modules.length;
  // U2b chain：perDimensionTargets 直接读意图（prepareRescanState 已从 gate.moduleBindings 派生并设上）；
  // 它驱动 Core 每维 gap 用 Agent 目标替代硬编码 5/维。非空才透传（零回归）。
  const intentPerDimensionTargets = state.intent.perDimensionTargets ?? {};
  // U2b chain：ledgerCoverageByDimension 从覆盖账本读「每维已覆盖计数」，让 Core existingCount 优先用账本
  // （比现算更准）。账本不可用/读失败/为空 → 留空对象，Core 退回现算 buildCoverageByDimension（零回归）。
  const ledgerCoverageByDimension = loadLedgerCoverageByDimension(ctx, state.projectRoot);
  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: state.recipeSnapshot.entries,
    auditSummary,
    dimensions: state.projectContextAnalysis.dimensions as DimensionDef[],
    requestedDimensionIds: state.intent.dimensionIds,
    ...(moduleCellBindings.length > 0 ? { moduleBindings: moduleCellBindings } : {}),
    ...(canonicalModuleCount !== undefined ? { moduleCount: canonicalModuleCount } : {}),
    ...(Object.keys(intentPerDimensionTargets).length > 0
      ? { perDimensionTargets: intentPerDimensionTargets }
      : {}),
    ...(Object.keys(ledgerCoverageByDimension).length > 0 ? { ledgerCoverageByDimension } : {}),
  });
  const dimensions = selectProjectContextDimensions(
    knowledgeRescanPlan.executionDimensions,
    state.intent.dimensionIds
  );
  const requestedDimensions = knowledgeRescanPlan.requestedDimensions;
  const prescreen = buildRescanPrescreen(auditSummary, state.recipeSnapshot.entries, dimensions);
  const evidencePlan = projectHostAgentRescanEvidencePlan(knowledgeRescanPlan);

  ctx.logger.info('[Rescan] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });
  ctx.logger.info('[Rescan] Execution reasons', {
    executionDimensions: knowledgeRescanPlan.executionDimensions.length,
    produceDimensions: knowledgeRescanPlan.produceDimensions.length,
    reasons: knowledgeRescanPlan.executionReasons,
  });

  return {
    auditSummary,
    dimensions,
    evidencePlan,
    executionDimensionCount: knowledgeRescanPlan.executionDimensions.length,
    prescreen,
    produceDimensionCount: knowledgeRescanPlan.produceDimensions.length,
    requestedDimensions,
  };
}

function buildRescanBriefing(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  planning: Awaited<ReturnType<typeof buildRescanPlanning>>
): RescanBriefingBuildResult {
  const dimensions = planning.dimensions;
  const projectContextAnalysis = state.projectContextAnalysis;
  const session = createProjectContextHostAgentSession({
    container: ctx.container,
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    fileCount: projectContextAnalysis.fileCount,
    moduleCount: projectContextAnalysis.moduleCount,
    primaryLang: projectContextAnalysis.primaryLang,
    projectRoot: state.projectRoot,
  });

  const briefing = buildProjectContextMissionBriefing({
    activeDimensions: Array.isArray(dimensions) ? dimensions : [],
    projectContext: projectContextAnalysis.presenterInput,
    projectMeta: {
      fileCount: projectContextAnalysis.fileCount,
      moduleCount: projectContextAnalysis.moduleCount,
    },
    profile: 'rescan-host-agent',
    rescan: { evidencePlan: planning.evidencePlan, prescreen: planning.prescreen },
    session,
  });
  // U3 item4：moduleMining（planGate.moduleScope 非空 / generationStage==='moduleMining'）对称
  // cold-start.ts:290——用 projectContext.sourceFileFacts（D1：模块轴唯一来源，不另造）给 plan moduleScope
  // 补每模块目标文件计数。deepMining 不调用（moduleScope 空时 attachPlanScopeTargetCounts 本就是 no-op，
  // 这里显式 stage 守卫使「moduleMining 调 / deepMining 不调」意图可测）。
  const isModuleMiningStage =
    state.planGate.generationStage === 'moduleMining' ||
    (state.planGate.moduleScope?.length ?? 0) > 0;
  const briefingWithModuleCounts = isModuleMiningStage
    ? attachPlanScopeTargetCounts(briefing, {
        moduleScope: state.planGate.moduleScope,
        sourceFileFacts: projectContextAnalysis.sourceFileFacts,
      })
    : briefing;
  const hostAgentPacket = buildHostAgentAnalysisPacketFromProjectContext({
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    options: {
      profile: 'rescan',
      projectRoot: state.projectRoot,
    },
    projectContext: projectContextAnalysis.presenterInput,
  });
  const hostAgentAnalysis = buildHostAgentAnalysisSurface(hostAgentPacket);
  const briefingWithHostAgentSurface = attachHostAgentAnalysisSurface(
    briefingWithModuleCounts as Record<string, unknown>,
    hostAgentAnalysis
  );
  briefingWithHostAgentSurface.meta.projectContextDirectSwitch = {
    moduleSeedCount: projectContextAnalysis.moduleSeeds.length,
    requestKinds: projectContextAnalysis.requestKinds,
  };
  const briefingWithProjectContextGuide = attachProjectContextCreationGuide(
    briefingWithHostAgentSurface,
    {
      dimensionIds: (Array.isArray(dimensions) ? dimensions : []).map((dimension) => dimension.id),
      generationStage: state.planGate.generationStage,
      moduleScope: state.planGate.moduleScope,
      projectRoot: state.projectRoot,
      stage: 'rescan',
      testMode: state.planGate.testMode,
    }
  );
  logRescanBriefingReady(ctx, state, planning, session.id, hostAgentAnalysis.progress.totalUnits);
  return { briefing: briefingWithProjectContextGuide, sessionId: session.id };
}

async function runRescanUnifiedEvolution(
  ctx: McpContext,
  input: {
    projectRoot: string;
  }
): Promise<RescanUnifiedEvolutionResult> {
  // UM#2：单一 commit-driven 维护编排（与 presenter 入口共享）。rescan 拥有自己的路由、从不去抖
  // （不传 residentSearchEnhancementReady）；prepareRescanState 的 cleanup + rebuildLocalKnowledgeIndexes
  // 已在本函数调用点之前执行，顺序不变（不在本编排内）。
  const { checkpoint, report, routeError, scan } = await runCommitDrivenMaintenance({
    buildHandler: (projectRoot) => createRescanUnifiedEvolutionHandler(ctx, projectRoot),
    container: ctx.container,
    handlerUnavailableReason:
      'Core unified evolution services are unavailable in the rescan MCP container',
    projectRoot: input.projectRoot,
  });

  const serviceGateReason =
    'alembic_rescan public workflow owns Plugin commit-driven unified evolution routing for this rescan response.';
  const surface = await buildPluginOpportunisticEvolutionSurface({
    projectRoot: input.projectRoot,
    scan,
    serviceGate: {
      reason: routeError
        ? `${serviceGateReason} Routing did not complete: ${routeError}.`
        : serviceGateReason,
      residentProjectScopeAvailable: false,
      // UM#3：rescan public workflow 自己拥有 commit-driven 维护路由，从不去抖给 resident。
      residentSearchEnhancementReady: false,
    },
    toolOutcome: {
      reason: 'alembic_rescan completed',
      success: true,
      tool: 'alembic_rescan',
    },
    checkpoint,
    unifiedEvolution: report,
  });

  return { report, routeError, scan, surface };
}

function attachRescanUnifiedEvolution(
  response: Record<string, unknown>,
  unifiedEvolution: RescanUnifiedEvolutionResult
): void {
  const data =
    response.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : {};
  response.data = data;
  const attach = (target: Record<string, unknown>) => {
    target.unifiedEvolution = unifiedEvolution.surface;
    // U2e：退役 git-diff 增量生成杂质——rescan 响应不再 surface gitDiffEvidence / moduleMiningRoutes
    //（created→moduleMining 生成已在 750ef70 退役，moduleMiningRoutes 恒空；gitDiffEvidence 是 git-diff
    // 增量扫描证据，属生成期杂质）。维护语义保留：evolution.pendingProposals / generationChangeLog 照常 attach。
    // D3：覆盖账本收敛判定完全用账本字段，rescan 响应不再透出 git-diff 游标证据。
    if (!unifiedEvolution.surface.unifiedEvolution) {
      return;
    }
    const evolution = unifiedEvolution.surface.unifiedEvolution;
    target.evolution = evolution;
    target.pendingProposals = evolution.pendingProposals;
    target.proposals = evolution.pendingProposals;
    target.generationChangeLog = evolution.generationChangeLog;
  };
  attach(response);
  attach(data);
}

/**
 * U2d：把覆盖账本收敛建议（adviseCoverageLedger）附到 response.data.coverageAdvisory（ADVISORY，非阻断）。
 *
 * 读账本 cells + deep_mining_rounds 最近一轮 → Core 纯函数算三类停止判定 + 价值排序缺口；moduleCount 取 canonical
 * ProjectMap.modules.length（无则退 analysis.moduleCount，再退 0）。planK/planMaxRounds 不传 → Core 用 D2[tier]。
 *
 * **建议非自动调度**：只产出 suggestion 文案与 shouldStop/stopReason，**绝不设任何 blocking/gate 标志、绝不自动再扫一轮**——
 * 是否再发一轮由用户/宿主决定。valueSortedGaps 截断 20 条防响应膨胀。
 * best-effort：repo 不可用 / 读失败都吞掉并继续（advisory 缺席绝不破坏 rescan）。
 * D3：只读 coverage_ledger + deep_mining_rounds，绝不触达 git_diff_checkpoints。
 */
function attachCoverageAdvisory(
  ctx: McpContext,
  response: Record<string, unknown> & { meta?: Record<string, unknown> },
  state: Awaited<ReturnType<typeof prepareRescanState>>
): {
  highValueBlankCount: number;
  shouldStop: boolean;
  stopReason: string;
  suggestion: string | null;
} | null {
  try {
    const repo = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repo) {
      return null;
    }
    const rawCells = repo.listByProjectRoot(state.projectRoot);
    const targetCells = preferTargetScopedCoverageItems(rawCells);
    if (targetCells.filteredCount > 0) {
      ctx.logger.info('[Rescan] coverage advisory filtered to target-scoped cells', {
        filteredCellCount: targetCells.filteredCount,
        projectRoot: state.projectRoot,
        targetScopedCellCount: targetCells.targetScopedCount,
      });
    }
    const cells = targetCells.items;
    const rounds = repo.listRoundsByProjectRoot(state.projectRoot);
    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    const projectMapTargetModuleCount = (
      state.projectContextAnalysis.presenterInput.map?.modules ?? []
    ).filter((module) => isTargetScopedCoverageModuleId(module.id)).length;
    const moduleCount =
      projectMapTargetModuleCount > 0
        ? projectMapTargetModuleCount
        : uniqueTargetScopedCoverageModuleCount(cells) ||
          state.projectContextAnalysis.moduleCount ||
          0;

    const advisory = adviseCoverageLedger({ cells, latestRound, moduleCount });

    // 仅保留 advisory 语义字段；不引入任何阻断/门禁键（no shouldBlock / gate / autoTrigger）。
    const coverageAdvisory = {
      shouldStop: advisory.shouldStop,
      stopReason: advisory.stopReason,
      highValueBlankCount: advisory.highValueBlankCount,
      valueSortedGaps: advisory.valueSortedGaps.slice(0, 20),
      suggestion: advisory.suggestion,
      tier: advisory.tier,
      k: advisory.k,
      maxRounds: advisory.maxRounds,
    };

    const data =
      response.data && typeof response.data === 'object' && !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : {};
    response.data = data;
    data.coverageAdvisory = coverageAdvisory;

    // meta 侧附一份紧凑摘要（仍是 advisory；output allowlist 已含 coverageAdvisory 键）。
    const meta =
      response.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
        ? (response.meta as Record<string, unknown>)
        : {};
    response.meta = meta;
    meta.coverageAdvisory = {
      shouldStop: advisory.shouldStop,
      stopReason: advisory.stopReason,
      highValueBlankCount: advisory.highValueBlankCount,
      suggestion: advisory.suggestion,
    };
    return meta.coverageAdvisory as {
      highValueBlankCount: number;
      shouldStop: boolean;
      stopReason: string;
      suggestion: string | null;
    };
  } catch (_err: unknown) {
    // advisory 计算/附加失败绝不破坏 rescan：吞掉异常继续（建议缺席只是少一条非阻断提示）。
    ctx.logger.warn('[Rescan] coverage advisory skipped (advisory, non-blocking)');
    return null;
  }
}

function createRescanUnifiedEvolutionHandler(
  ctx: McpContext,
  projectRoot: string
): HostAgentFileChangeHandler | null {
  const sourceRefRepository = safeContainerGet(ctx, 'recipeSourceRefRepository');
  const knowledgeRepository = safeContainerGet(ctx, 'knowledgeRepository');
  if (
    !hasFunctions(sourceRefRepository, ['findByRecipeId', 'findBySourcePath', 'replaceSourcePath'])
  ) {
    return null;
  }
  if (!hasFunctions(knowledgeRepository, ['findById'])) {
    return null;
  }
  const contentPatcher = safeContainerGet(ctx, 'contentPatcher');
  const evolutionGateway = safeContainerGet(ctx, 'evolutionGateway');
  const recipeFreshnessService = safeContainerGet(ctx, 'recipeFreshnessService');
  const signalBus = safeContainerGet(ctx, 'signalBus');
  return new HostAgentFileChangeHandler(
    sourceRefRepository as never,
    knowledgeRepository as never,
    contentPatcher,
    {
      evolutionGateway: hasFunctions(evolutionGateway, ['submit'])
        ? (evolutionGateway as never)
        : null,
      projectRoot,
      recipeFreshnessService: hasFunctions(recipeFreshnessService, ['refreshRecipes'])
        ? (recipeFreshnessService as never)
        : null,
      signalBus: hasFunctions(signalBus, ['send']) ? (signalBus as never) : null,
    }
  );
}

function safeContainerGet(ctx: McpContext, serviceName: string): unknown {
  try {
    return ctx.container.get(serviceName);
  } catch {
    return null;
  }
}

function hasFunctions(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

function logRescanBriefingReady(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  planning: Awaited<ReturnType<typeof buildRescanPlanning>>,
  sessionId: string,
  ideUnitCount: number
) {
  const dimGapLog = planning.evidencePlan.dimensionGaps
    .map(
      (dimensionGap) =>
        `${dimensionGap.dimensionId}(${dimensionGap.existingCount}→gap ${dimensionGap.gap}, mode ${dimensionGap.executionMode}, budget ${dimensionGap.createBudget})`
    )
    .join(', ');
  ctx.logger.info(
    `[Rescan] ProjectContext Mission Briefing ready: ${state.projectContextAnalysis.fileCount} files, ${
      Array.isArray(planning.dimensions) ? planning.dimensions.length : 0
    } dims, ` +
      `preserved: ${state.recipeSnapshot.count}, decayed: ${planning.evidencePlan.decayCount}, totalGap: ${planning.evidencePlan.totalGap}, ` +
      `ideUnits: ${ideUnitCount} — session ${sessionId}`
  );
  ctx.logger.info(`[Rescan] Dimension gaps: ${dimGapLog}`);
}

function attachTrashArchiveMessage(
  response: Record<string, unknown> & { message?: string },
  cleanResult: Awaited<ReturnType<CleanupService['rescanClean']>>
) {
  if (cleanResult.trash && cleanResult.trash.movedItems > 0) {
    response.message =
      `📦 已清理的 candidates/wiki 投影归档到 .asd/.trash/${cleanResult.trash.folder.split(/[\\/]/).filter(Boolean).pop()}/` +
      `（${cleanResult.trash.movedItems} 项，可恢复）。${response.message ?? ''}`;
  }
}

function attachHostProjectSelectionMismatch(
  response: Record<string, unknown> & { meta?: Record<string, unknown> },
  projectRoot: string
) {
  const mismatch = buildLocalSelectionMismatch(projectRoot);
  if (mismatch) {
    response.meta = { ...(response.meta ?? {}), hostProjectSelectionMismatch: mismatch };
  }
}

function attachHostAgentAnalysisSurface(
  briefing: Record<string, unknown>,
  hostAgentAnalysis: ReturnType<typeof buildHostAgentAnalysisSurface>
): Record<string, unknown> & {
  hostAgentAnalysis: ReturnType<typeof buildHostAgentAnalysisSurface>;
  ideAgentAnalysis: ReturnType<typeof buildHostAgentAnalysisSurface>;
  meta: Record<string, unknown>;
} {
  const meta =
    briefing.meta && typeof briefing.meta === 'object' && !Array.isArray(briefing.meta)
      ? (briefing.meta as Record<string, unknown>)
      : {};
  const analysisSummary = {
    packetId: hostAgentAnalysis.packetSummary.packetId,
    profile: hostAgentAnalysis.packetSummary.profile,
    totalUnits: hostAgentAnalysis.progress.totalUnits,
    remainingUnits: hostAgentAnalysis.progress.remainingUnitIds.length,
  };
  return {
    ...briefing,
    hostAgentAnalysis,
    ideAgentAnalysis: hostAgentAnalysis,
    meta: {
      ...meta,
      hostAgentAnalysis: analysisSummary,
      ideAgentAnalysis: analysisSummary,
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

// U1 #2：per-模块 → per-cell 拍扁。
// Plugin 的 PlanSelectionModuleBinding 是「一个模块 + 一组 dimensions」的意图；Core 的 ModuleCellBinding
// 是「单个 模块×维度 cell」。这里对每个 binding 的每个 dimension 各产出一条 cell（dimensionId=该维度），
// moduleId/moduleName 从模块派生，targetRecipes 作为 per-cell 目标透传（缺省由 Core 用 tier 默认补齐）。
// perCellCoverage 在 per-模块意图里没有，故不透传（Core 缺省按 0 处理；per-cell 覆盖账本=后续 U2a）。
// 维度去重，避免同一 (模块×维度) 被重复计入 gap。
export function flattenModuleBindingsToCells(
  moduleBindings: readonly PlanSelectionModuleBinding[]
): ModuleCellBinding[] {
  const cells: ModuleCellBinding[] = [];
  for (const binding of moduleBindings) {
    const moduleName = canonicalModuleNameFromBinding(binding);
    const seenDimensions = new Set<string>();
    for (const rawDimension of binding.dimensions ?? []) {
      const dimensionId = rawDimension.trim();
      if (dimensionId.length === 0 || seenDimensions.has(dimensionId)) {
        continue;
      }
      seenDimensions.add(dimensionId);
      cells.push({
        dimensionId,
        ...(binding.moduleId ? { moduleId: binding.moduleId } : {}),
        ...(moduleName ? { moduleName } : {}),
        // per-cell 目标：per-模块 binding 的 targetRecipes 落到该模块下每个 cell（plan 显式目标）。
        ...(typeof binding.targetRecipes === 'number'
          ? { targetRecipes: binding.targetRecipes }
          : {}),
      });
    }
  }
  return cells;
}

/**
 * U2b chain（纯函数，可独立单测）：从 gate.moduleBindings 派生意图侧的 per-cell 目标。
 *
 * 产出两份等价但用途不同的数据：
 *   1. perDimensionTargets: Record<dim, number> —— 每维取该维下所有 binding targetRecipes 的 MAX（per-维度 Agent 目标，
 *      驱动 Core gap 替代硬编码 5/维）；
 *   2. moduleDimensionTargets: ModuleDimensionTarget[] —— 复用 flattenModuleBindingsToCells（per-cell 拍扁），
 *      只保留带数值 targetRecipes 的 cell（让 Agent per-cell 目标 → intent → Core 的链条显式、可测）。
 *
 * 二者均为加性：为空时调用方不写入意图字段（零回归）。
 */
export function derivePerCellTargetsFromGate(
  moduleBindings: readonly PlanSelectionModuleBinding[]
): {
  perDimensionTargets: Record<string, number>;
  moduleDimensionTargets: ModuleDimensionTarget[];
} {
  // per-维度目标：同维多 binding 取 MAX（最激进的 Agent 目标胜出）。
  const perDimensionTargets: Record<string, number> = {};
  for (const binding of moduleBindings) {
    if (typeof binding.targetRecipes !== 'number') {
      continue;
    }
    for (const rawDimension of binding.dimensions ?? []) {
      const dimensionId = rawDimension.trim();
      if (dimensionId.length === 0) {
        continue;
      }
      const previous = perDimensionTargets[dimensionId];
      perDimensionTargets[dimensionId] =
        previous === undefined ? binding.targetRecipes : Math.max(previous, binding.targetRecipes);
    }
  }

  // per-cell 目标：复用拍扁结果，只取带数值 targetRecipes 的 cell 映射成 ModuleDimensionTarget。
  const moduleDimensionTargets: ModuleDimensionTarget[] = flattenModuleBindingsToCells(
    moduleBindings
  )
    .filter(
      (cell): cell is ModuleCellBinding & { targetRecipes: number } =>
        typeof cell.targetRecipes === 'number'
    )
    .map((cell) => ({
      ...(cell.moduleId ? { moduleId: cell.moduleId } : {}),
      ...(cell.moduleName ? { moduleName: cell.moduleName } : {}),
      dimensionId: cell.dimensionId,
      targetRecipes: cell.targetRecipes,
    }));

  return { perDimensionTargets, moduleDimensionTargets };
}

// 从 per-模块 binding 取一个稳定的 moduleName：优先 modulePath 末段，其次 moduleId。
// 仅用于 Core per-cell gap 的模块标识，不改变 flat moduleScope（仍是 modulePath 原值）。
function canonicalModuleNameFromBinding(binding: PlanSelectionModuleBinding): string | undefined {
  const fromPath = binding.modulePath
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.[^.]+$/, '');
  if (fromPath && fromPath.length > 0) {
    return fromPath;
  }
  return binding.moduleId && binding.moduleId.length > 0 ? binding.moduleId : undefined;
}
