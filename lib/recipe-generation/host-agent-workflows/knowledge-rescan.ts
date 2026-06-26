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
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildKnowledgeRescanPlan,
  buildKnowledgeRescanWorkflowPlan,
  buildProjectContextMissionBriefing,
  buildRescanPrescreen,
  createHostAgentKnowledgeRescanIntent,
  type DimensionDef,
  type ModuleCellBinding,
  type ModuleDimensionTarget,
  presentHostAgentKnowledgeRescanEmptyProject,
  presentHostAgentKnowledgeRescanResponse,
  projectHostAgentRescanEvidencePlan,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
} from '@alembic/core/host-agent-workflows';
import type { EvolutionCoverageLedgerRepository } from '@alembic/core/repositories';
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
  releaseEmptyHostAgentSessionLeaseForProject({
    container: ctx.container,
    logger: ctx.logger,
    projectRoot: planGate.value.projectRoot,
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
  // U2d：附覆盖账本收敛建议（ADVISORY）。放在预算化之前 → 建议进 response.data 并一起被预算。
  // 严格非阻断：绝不设任何 blocking/gate 标志、绝不自动触发再扫一轮——是否再扫由用户/宿主决定。
  attachCoverageAdvisory(ctx, response, state);
  // U2d：收敛建议读完「上一已完成轮」之后，再为本次 deepMining rescan 开新一轮（startedAt+triggerActor）。
  // 顺序关键：必须在 attachCoverageAdvisory 之后开轮，否则 advisory 会把刚开的、产出尚为 0 的本轮当成「上一轮」，
  // 触发 new_recipes_this_round(0)<K 的收益递减误判，使多轮循环每轮立即停止。新轮在 rescan 返回前开好，
  // 供随后的 dimension_complete 回流累计 new_recipes_this_round / completedAt（轮次边界=plan-confirm 到该轮全部回流）。
  // coldStart/moduleMining rescan 不是 deepMining 轮次，用 stage 守卫排除。best-effort、不阻断。
  if (state.planGate.generationStage === 'deepMining') {
    openDeepMiningRound(ctx, state.projectRoot);
  }
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
 * 轮号 = (现有最大轮号 + 1)，仅在 rescan 起点计算一次。round 表无 rescanId 列（有意设计），故对同一 rescanId
 * 重复调用会再开 index+1——本卡接受该折中（保持简单，避免引入跨调用幂等状态）。
 * best-effort：repo 不可用 / 写失败都吞掉，绝不阻断 rescan。D3：只写 coverage 账本侧的 round 表，不碰 git-diff checkpoint。
 */
function openDeepMiningRound(ctx: McpContext, projectRoot: string): void {
  try {
    const repo = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repo) {
      return;
    }
    const existing = repo.listRoundsByProjectRoot(projectRoot);
    // listRoundsByProjectRoot 升序，末元素为当前最大轮号；无轮次则首轮 = 1。
    const nextIndex = existing.length > 0 ? existing[existing.length - 1].roundIndex + 1 : 1;
    repo.upsertRound({
      projectRoot,
      roundIndex: nextIndex,
      startedAt: Date.now(),
      triggerActor: 'host-agent-rescan',
    });
    ctx.logger.info('[Rescan] Opened deepMining round (advisory round boundary)', {
      projectRoot,
      roundIndex: nextIndex,
    });
  } catch (_err: unknown) {
    // 开轮失败绝不阻断 rescan：吞掉异常（advisory 轮次记录缺失只影响后续收敛建议精度）。
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
): void {
  try {
    const repo = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!repo) {
      return;
    }
    const cells = repo.listByProjectRoot(state.projectRoot);
    const rounds = repo.listRoundsByProjectRoot(state.projectRoot);
    const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    const moduleCount =
      state.projectContextAnalysis.presenterInput.map?.modules.length ??
      state.projectContextAnalysis.moduleCount ??
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
  } catch (_err: unknown) {
    // advisory 计算/附加失败绝不破坏 rescan：吞掉异常继续（建议缺席只是少一条非阻断提示）。
    ctx.logger.warn('[Rescan] coverage advisory skipped (advisory, non-blocking)');
  }
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
