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
  type ModuleCellBinding,
  presentHostAgentKnowledgeRescanEmptyProject,
  presentHostAgentKnowledgeRescanResponse,
  projectHostAgentRescanEvidencePlan,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
} from '@alembic/core/host-agent-workflows';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { buildLocalSelectionMismatch } from '#codex/HostProjectAlignment.js';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import {
  FileChangeHandler,
  type UnifiedEvolutionReport,
} from '#recipe-generation/evolution/FileChangeHandler.js';
import { runCommitDrivenMaintenance } from '#recipe-generation/evolution/git-diff-checkpoint/CommitDrivenMaintenance.js';
import type { GitDiffScanResult } from '#recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import { buildPluginOpportunisticEvolutionSurface } from '#recipe-generation/evolution/PluginOpportunisticEvolution.js';
import {
  buildHostAgentProjectContextAnalysis,
  createProjectContextHostAgentSession,
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
  BRIEFING_INLINE_BUDGET_BYTES,
  attachFullBriefingRef,
  budgetBriefingResponseData,
} from './briefing-budget.js';
import { attachPlanScopeTargetCounts } from './cold-start.js';
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

// ── 主入口 ─────────────────────────────────────────────────

export async function runHostAgentKnowledgeRescanWorkflow(ctx: McpContext, args: RescanInput) {
  const t0 = Date.now();
  const planGate = await resolvePlanGenerationGate(ctx, args, {
    defaultStage: resolveDefaultRescanGenerationStage(args),
    toolName: 'alembic_rescan',
  });
  if (!planGate.ok) {
    return planGate.response;
  }
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
  const unifiedEvolution = await runRescanUnifiedEvolution(ctx, {
    projectRoot,
  });

  return {
    cleanResult,
    dataRoot,
    db,
    indexRebuild,
    intent,
    plan,
    planGate,
    projectContextAnalysis,
    projectRoot,
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

async function buildRescanResponse(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  responseTimeMs: number
) {
  const planning = await buildRescanPlanning(ctx, state);
  const briefing = buildRescanBriefing(ctx, state, planning);
  const response = presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot: state.recipeSnapshot,
    cleanResult: state.cleanResult,
    auditSummary: planning.auditSummary,
    briefing,
    evidencePlan: planning.evidencePlan,
    dimensions: planning.requestedDimensions,
    reason: state.intent.reason,
    responseTimeMs,
  }) as Record<string, unknown> & { message?: string; meta?: Record<string, unknown> };

  attachPlanGenerationGateData(response, state.planGate);
  attachRescanUnifiedEvolution(response, state.unifiedEvolution);
  attachTrashArchiveMessage(response, state.cleanResult);
  attachHostProjectSelectionMismatch(response, state.projectRoot);
  // U3 item3：在所有 attach*（unifiedEvolution/trashArchive/projectSelectionMismatch）之后，对完整
  // response.data 做内联预算化（与 cold-start 共享同一步骤/口径）。≤18KB 内联并清理遗留 transient；
  // >预算把完整 data 写入 'rescan-briefing' transient transport，再经 attachFullBriefingRef 把引用写进
  // meta.fullBriefingRef（复用 output allowlist 既有键→零改 allowlist）。rescan 不提供 compact 回调，
  // 故超预算只附 transient 引用、不瘦身内联（与 cold-start 的逐级压缩有意不对称——本卡范围）。
  await budgetBriefingResponseData(response, {
    dataRoot: state.dataRoot,
    projectRoot: state.projectRoot,
    transportName: 'rescan-briefing',
    inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
    attachRef: (data, ref) => attachFullBriefingRef(data, ref),
  });
  return response;
}

function resolveDefaultRescanGenerationStage(args: RescanInput): 'deepMining' | 'moduleMining' {
  if (args.generationStage === 'moduleMining' || (args.moduleScope?.length ?? 0) > 0) {
    return 'moduleMining';
  }
  return 'deepMining';
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
  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: state.recipeSnapshot.entries,
    auditSummary,
    dimensions: state.projectContextAnalysis.dimensions as DimensionDef[],
    requestedDimensionIds: state.intent.dimensionIds,
    ...(moduleCellBindings.length > 0 ? { moduleBindings: moduleCellBindings } : {}),
    ...(canonicalModuleCount !== undefined ? { moduleCount: canonicalModuleCount } : {}),
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
    prescreen,
    requestedDimensions,
  };
}

function buildRescanBriefing(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  planning: Awaited<ReturnType<typeof buildRescanPlanning>>
) {
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
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromProjectContext({
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    options: {
      profile: 'rescan',
      projectRoot: state.projectRoot,
    },
    projectContext: projectContextAnalysis.presenterInput,
  });
  const ideAgentAnalysis = buildIDEAgentAnalysisSurface(ideAgentPacket);
  const briefingWithIdeAgentSurface = attachIDEAgentAnalysisSurface(
    briefingWithModuleCounts as Record<string, unknown>,
    ideAgentAnalysis
  );
  briefingWithIdeAgentSurface.meta.projectContextDirectSwitch = {
    moduleSeedCount: projectContextAnalysis.moduleSeeds.length,
    requestKinds: projectContextAnalysis.requestKinds,
  };
  const briefingWithProjectContextGuide = attachProjectContextCreationGuide(
    briefingWithIdeAgentSurface,
    {
      dimensionIds: (Array.isArray(dimensions) ? dimensions : []).map((dimension) => dimension.id),
      generationStage: state.planGate.generationStage,
      moduleScope: state.planGate.moduleScope,
      projectRoot: state.projectRoot,
      stage: 'rescan',
      testMode: state.planGate.testMode,
    }
  );
  logRescanBriefingReady(ctx, state, planning, session.id, ideAgentAnalysis.progress.totalUnits);
  return briefingWithProjectContextGuide;
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
    if (unifiedEvolution.surface.gitDiffEvidence) {
      target.gitDiffEvidence = unifiedEvolution.surface.gitDiffEvidence;
    }
    if (!unifiedEvolution.surface.unifiedEvolution) {
      return;
    }
    const evolution = unifiedEvolution.surface.unifiedEvolution;
    target.evolution = evolution;
    target.pendingProposals = evolution.pendingProposals;
    target.proposals = evolution.pendingProposals;
    target.generationChangeLog = evolution.generationChangeLog;
    target.moduleMiningRoutes = evolution.moduleMiningRoutes;
  };
  attach(response);
  attach(data);
}

function createRescanUnifiedEvolutionHandler(
  ctx: McpContext,
  projectRoot: string
): FileChangeHandler | null {
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
  return new FileChangeHandler(
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
