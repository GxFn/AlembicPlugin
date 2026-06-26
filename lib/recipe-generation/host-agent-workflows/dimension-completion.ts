import { dimensionTags } from '@alembic/core/dimensions';
import {
  type CoverageLedgerCandidate,
  type CoverageLedgerExhaustedDeclaration,
  type CoverageLedgerModuleAxis,
  type DimensionDef,
  type ProjectSkillDeliveryReceipt,
  resolveModuleTier,
  resolvePerCellTargetDefault,
  saveDimensionCheckpoint,
} from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { EvolutionCoverageLedgerRepository } from '@alembic/core/repositories';
import { getDeveloperIdentity, HOST_AGENT_SOURCE } from '@alembic/core/shared';
import { buildIDEAgentAnalysisProgressBackfill } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import { BootstrapEventEmitter } from '#recipe-generation/bootstrap/BootstrapEventEmitter.js';
import {
  buildDimensionCompletionCompletenessCritic,
  buildSubmittedRecipesForCompletenessCritic,
  projectCompletenessCriticForAgent,
} from '#recipe-generation/host-agent-workflows/completeness-critic.js';
import {
  reflowDeepMiningRoundOnCompletion,
  writeCoverageLedgerForCompletion,
} from '#recipe-generation/host-agent-workflows/coverage-ledger-write.js';
import { resolveHostAgentDataRoot } from '#recipe-generation/host-agent-workflows/project-data-root.js';
import {
  buildEvidenceGateFailureData,
  previewDimensionQualityReport,
  primaryEvidenceGateCode,
  validateDimensionCompletionEvidenceGate,
} from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';
import {
  runWorkflowCompletionFinalizer,
  type WorkflowCompletionFinalizerDependencies,
} from '#workflows/capabilities/completion/WorkflowCompletionFinalizer.js';
import { generateSkill as generateWorkflowSkill } from '#workflows/capabilities/execution/WorkflowSkillCompletionCapability.js';

const logger = Logger.getInstance();

const BOOTSTRAP_COMPLETE_ACTIONS: Array<{ action: string; prompt: string; tool: string }> = [];

export interface HostAgentDimensionCompleteArgs {
  sessionId?: unknown;
  dimensionId?: unknown;
  unitId?: unknown;
  analysisUnitIds?: unknown;
  skippedAnalysisUnitIds?: unknown;
  rejectedAnalysisUnitIds?: unknown;
  remainingAnalysisUnitIds?: unknown;
  deviationReason?: unknown;
  submittedRecipeIds?: unknown;
  analysisText?: unknown;
  referencedFiles?: unknown;
  keyFindings?: unknown;
  candidateCount?: unknown;
  crossDimensionHints?: unknown;
  exhaustedReason?: unknown;
  noPadding?: unknown;
  [key: string]: unknown;
}

interface HostAgentCompletionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface HostAgentSessionContainer {
  get(name: string): unknown;
  services?: Record<string, unknown>;
  singletons?: Record<string, unknown>;
}

interface HostAgentCompletionContainer extends HostAgentSessionContainer {
  get(name: string): unknown;
}

export interface HostAgentDimensionCompletionContext {
  container: HostAgentCompletionContainer;
  logger?: HostAgentCompletionLogger;
  [key: string]: unknown;
}

export interface HostAgentDimensionCompletionResponse<T = unknown> {
  success: boolean;
  data?: T | null;
  message?: string;
  meta?: Record<string, unknown>;
  errorCode?: string | null;
}

export interface HostAgentDimensionCompletionDependencies {
  getActiveSession?: (
    container: HostAgentSessionContainer,
    sessionId?: string
  ) => Promise<HostAgentWorkflowSession | null> | HostAgentWorkflowSession | null;
  generateSkill?: GenerateHostAgentDimensionSkill;
  saveCheckpoint?: typeof saveDimensionCheckpoint;
  createEmitter?: (container: HostAgentCompletionContainer) => HostAgentDimensionCompletionEmitter;
  now?: () => number;
  runCompletionFinalizer?: typeof runWorkflowCompletionFinalizer;
  finalizerDependencies?: WorkflowCompletionFinalizerDependencies;
}

type GenerateHostAgentDimensionSkill = (
  ctx: HostAgentDimensionCompletionContext,
  dimension: DimensionDef,
  analysisText: string,
  referencedFiles: string[],
  keyFindings: string[],
  source: string
) => Promise<HostAgentDimensionSkillResult>;

interface HostAgentDimensionSkillResult {
  deliveryReceipt?: ProjectSkillDeliveryReceipt;
  error?: string;
  exportResult?: Record<string, unknown>;
  success: boolean;
}

export interface HostAgentWorkflowSession {
  id: string;
  projectRoot: string;
  expiresAt?: number;
  dimensions: DimensionDef[];
  submissionTracker: {
    buildQualityReport?(
      dimId: string,
      analysisText?: string,
      referencedFiles?: string[]
    ): {
      totalScore?: number;
      pass: boolean;
      scores?: Record<string, number>;
      suggestions?: string[];
    };
    getSubmissions(dimId: string): Array<{ recipeId?: string; sources: string[] }>;
    getAccumulatedEvidence(dimId: string): unknown;
  };
  sessionStore: {
    getDimensionReport(dimId: string): unknown;
  };
  getSnapshotCache?(): {
    allFiles?: Array<{
      filePath?: string;
      language?: string;
      path?: string;
      relativePath?: string;
    }>;
    localPackageModules?: Array<{ packageName?: string; name?: string; path?: string }>;
    targetsSummary?: Array<{ name?: string; path?: string; type?: string }>;
  } | null;
  getProgress(): {
    completed: number;
    total: number;
    completedDimIds: string[];
    remainingDimIds: string[];
  };
  readonly isComplete: boolean;
  markDimensionComplete(
    dimensionId: string,
    report: {
      analysisText: string;
      keyFindings: string[];
      referencedFiles: string[];
      recipeIds: string[];
      candidateCount: number;
    }
  ): {
    updated: boolean;
    qualityReport?: {
      totalScore: number;
      pass: boolean;
      scores: Record<string, number>;
      suggestions: string[];
    };
  };
  storeHints(dimId: string, hints: Record<string, unknown>): void;
  getAccumulatedHints(): Record<string, unknown>;
}

interface HostAgentDimensionCompletionEmitter {
  emitDimensionComplete(
    dimId: string,
    data: Parameters<BootstrapEventEmitter['emitDimensionComplete']>[1]
  ): void;
  emitAllComplete(sessionId: string, total: number, source: string): void;
}

interface KnowledgeEntryLike {
  tags?: string[] | string;
  title?: string;
  description?: string;
  whenClause?: string;
  doClause?: string;
  dontClause?: string;
  coreCode?: string;
}

interface KnowledgeServiceLike {
  get(recipeId: string): Promise<KnowledgeEntryLike | null> | KnowledgeEntryLike | null;
  update(
    recipeId: string,
    patch: { category?: string; dimensionId?: string; tags?: string[] },
    options: { userId: string }
  ): Promise<unknown> | unknown;
}

interface KnowledgeGraphServiceLike {
  addEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string,
    meta?: Record<string, unknown>
  ): Promise<unknown> | unknown;
}

interface AccumulatedEvidenceLike {
  completedDimSummaries: Array<{
    dimId: string;
    submissionCount: number;
    titles: string[];
    referencedFiles: string[];
  }>;
  sharedFiles: unknown[];
  negativeSignals: Array<{ pattern?: string }>;
  usedTriggers: string[];
}

interface DimensionReportLike {
  analysisText?: string;
  findings?: Array<{ finding?: string; content?: string }>;
}

type DimensionQualityReport = ReturnType<
  HostAgentWorkflowSession['markDimensionComplete']
>['qualityReport'];

interface CompletionInput {
  sessionId?: string;
  dimensionId: string;
  analysisUnitIds: string[];
  deviationReason?: string;
  rejectedAnalysisUnitIds: string[];
  remainingAnalysisUnitIds: string[];
  skippedAnalysisUnitIds: string[];
  submittedRecipeIds: string[];
  analysisText: string;
  referencedFiles: string[];
  keyFindings: string[];
  candidateCount?: number;
  crossDimensionHints?: Record<string, unknown>;
  exhaustedReason?: string;
  noPadding?: boolean;
}

interface DimensionCompletionSideEffectResult {
  accumulatedHints: Record<string, unknown> | undefined;
  completenessCritic: Record<string, unknown> | undefined;
  evidenceHints: Record<string, unknown> | undefined;
  ideAgentAnalysisProgress: ReturnType<typeof buildIDEAgentAnalysisProgressBackfill>;
  isComplete: boolean;
  progress: ReturnType<HostAgentWorkflowSession['getProgress']>;
  qualityFeedback: Record<string, unknown> | undefined;
  recipesBound: number;
  skillResult: HostAgentDimensionSkillResult;
  subpackageCoverageWarning: string | undefined;
  updated: boolean;
}

export async function runHostAgentDimensionCompletionWorkflow(
  ctx: HostAgentDimensionCompletionContext,
  args: HostAgentDimensionCompleteArgs,
  dependencies: HostAgentDimensionCompletionDependencies = {}
): Promise<HostAgentDimensionCompletionResponse> {
  const startedAtMs = dependencies.now?.() ?? Date.now();
  const input = normalizeCompletionInput(args);
  if (!input.success) {
    return input.response;
  }

  const session = await resolveHostAgentCompletionSession({
    ctx,
    input: input.value,
    dependencies,
  });
  if (!session.success) {
    return session.response;
  }

  extendSessionTtl(session.value);

  const dimension = session.value.dimensions.find(
    (dim: { id: string }) => dim.id === input.value.dimensionId
  );
  if (!dimension) {
    return validationFailure(
      `Unknown dimensionId: "${input.value.dimensionId}". Valid dimensions: ${session.value.dimensions.map((dim: { id: string }) => dim.id).join(', ')}`,
      'VALIDATION_ERROR'
    );
  }

  const projectRoot = session.value.projectRoot;
  const dataRoot = resolveHostAgentDataRoot(ctx.container, projectRoot);
  const referencedFiles =
    input.value.referencedFiles.length > 0
      ? input.value.referencedFiles
      : recoverReferencedFiles(session.value, input.value.dimensionId);
  const submittedRecipeIds =
    input.value.submittedRecipeIds.length > 0
      ? input.value.submittedRecipeIds
      : recoverSubmittedRecipeIds(session.value, input.value.dimensionId);

  const evidenceGateResponse = validateDimensionCompletionBeforeSideEffects({
    input: input.value,
    referencedFiles,
    session: session.value,
    submittedRecipeIds,
  });
  if (evidenceGateResponse) {
    return evidenceGateResponse;
  }

  const sideEffects = await applyDimensionCompletionSideEffects({
    ctx,
    dataRoot,
    dependencies,
    dimension,
    input: input.value,
    referencedFiles,
    session: session.value,
    submittedRecipeIds,
  });
  if (!sideEffects.success) {
    return sideEffects.response;
  }

  return buildDimensionCompletionSuccessResponse({
    dimensionId: input.value.dimensionId,
    result: sideEffects.value,
    responseTimeMs: (dependencies.now?.() ?? Date.now()) - startedAtMs,
  });
}

async function applyDimensionCompletionSideEffects({
  ctx,
  dataRoot,
  dependencies,
  dimension,
  input,
  referencedFiles,
  session,
  submittedRecipeIds,
}: {
  ctx: HostAgentDimensionCompletionContext;
  dataRoot: string;
  dependencies: HostAgentDimensionCompletionDependencies;
  dimension: DimensionDef;
  input: CompletionInput;
  referencedFiles: string[];
  session: HostAgentWorkflowSession;
  submittedRecipeIds: string[];
}): Promise<
  | { success: true; value: DimensionCompletionSideEffectResult }
  | { success: false; response: HostAgentDimensionCompletionResponse }
> {
  const ideAgentAnalysisProgress = buildIDEAgentAnalysisProgressBackfill({
    analysisUnitIds: input.analysisUnitIds,
    deviationReason: input.deviationReason,
    dimensionId: input.dimensionId,
    rejectedAnalysisUnitIds: input.rejectedAnalysisUnitIds,
    remainingAnalysisUnitIds: input.remainingAnalysisUnitIds,
    sessionId: session.id,
    skippedAnalysisUnitIds: input.skippedAnalysisUnitIds,
  });
  const recipesBound = await bindSubmittedRecipes({
    ctx,
    session,
    dimensionId: input.dimensionId,
    submittedRecipeIds,
  });
  const skillResult = await createHostAgentDimensionSkill({
    ctx,
    dimension,
    dimensionId: input.dimensionId,
    analysisText: input.analysisText,
    referencedFiles,
    keyFindings: input.keyFindings,
    submittedRecipeIds,
    dependencies,
  });

  const completion = markDimensionCompleteOrFailure({
    input,
    referencedFiles,
    session,
    submittedRecipeIds,
  });
  if (!completion.success) {
    return completion;
  }

  return {
    success: true,
    value: await persistAndBroadcastDimensionCompletion({
      ctx,
      dataRoot,
      dependencies,
      dimension,
      ideAgentAnalysisProgress,
      input,
      qualityReport: completion.qualityReport,
      recipesBound,
      referencedFiles,
      session,
      skillResult,
      submittedRecipeIds,
      updated: completion.updated,
    }),
  };
}

function markDimensionCompleteOrFailure({
  input,
  referencedFiles,
  session,
  submittedRecipeIds,
}: {
  input: CompletionInput;
  referencedFiles: string[];
  session: HostAgentWorkflowSession;
  submittedRecipeIds: string[];
}):
  | { success: true; qualityReport: DimensionQualityReport; updated: boolean }
  | { success: false; response: HostAgentDimensionCompletionResponse } {
  const { updated, qualityReport } = session.markDimensionComplete(input.dimensionId, {
    analysisText: input.analysisText,
    keyFindings: input.keyFindings,
    referencedFiles,
    recipeIds: submittedRecipeIds,
    candidateCount: input.candidateCount || submittedRecipeIds.length,
  });
  if (qualityReport?.pass === false) {
    return {
      success: false,
      response: validateDimensionCompletionFailedQuality({
        input,
        qualityReport,
        referencedFiles,
        session,
        submittedRecipeIds,
      }),
    };
  }
  return { success: true, qualityReport, updated };
}

async function persistAndBroadcastDimensionCompletion({
  ctx,
  dataRoot,
  dependencies,
  dimension,
  ideAgentAnalysisProgress,
  input,
  qualityReport,
  recipesBound,
  referencedFiles,
  session,
  skillResult,
  submittedRecipeIds,
  updated,
}: {
  ctx: HostAgentDimensionCompletionContext;
  dataRoot: string;
  dependencies: HostAgentDimensionCompletionDependencies;
  dimension: DimensionDef;
  ideAgentAnalysisProgress: ReturnType<typeof buildIDEAgentAnalysisProgressBackfill>;
  input: CompletionInput;
  qualityReport: DimensionQualityReport;
  recipesBound: number;
  referencedFiles: string[];
  session: HostAgentWorkflowSession;
  skillResult: HostAgentDimensionSkillResult;
  submittedRecipeIds: string[];
  updated: boolean;
}): Promise<DimensionCompletionSideEffectResult> {
  await persistDimensionCheckpoint({
    session,
    dataRoot,
    dimensionId: input.dimensionId,
    candidateCount: input.candidateCount || submittedRecipeIds.length,
    analysisText: input.analysisText,
    referencedFiles,
    submittedRecipeIds,
    skillCreated: skillResult.success,
    ideAgentAnalysisProgress,
    dependencies,
  });
  await persistKeyFindings({
    ctx,
    session,
    dimensionId: input.dimensionId,
    keyFindings: input.keyFindings,
  });

  const progress = session.getProgress();
  const isComplete = session.isComplete;
  emitHostAgentCompletionProgress({
    ctx,
    session,
    dimension,
    dimensionId: input.dimensionId,
    candidateCount: input.candidateCount || submittedRecipeIds.length,
    skillCreated: skillResult.success,
    recipesBound,
    progress,
    isComplete,
    dependencies,
  });

  if (isComplete) {
    await (dependencies.runCompletionFinalizer ?? runWorkflowCompletionFinalizer)({
      ctx,
      session,
      dataRoot,
      log: logger,
      dependencies: dependencies.finalizerDependencies,
    });
  }

  if (input.crossDimensionHints) {
    session.storeHints(input.dimensionId, input.crossDimensionHints);
  }

  const accumulatedHints = session.getAccumulatedHints();
  const accumulatedEvidence = session.submissionTracker.getAccumulatedEvidence(
    input.dimensionId
  ) as AccumulatedEvidenceLike;

  const qualityFeedback = buildQualityFeedback({
    dimensionId: input.dimensionId,
    qualityReport,
  });
  const evidenceHints = buildEvidenceHints({
    session,
    isComplete,
    accumulatedEvidence,
  });
  const subpackageCoverageWarning = buildSubpackageCoverageWarning({
    session,
    dimensionId: input.dimensionId,
    referencedFiles,
  });
  const completenessCritic = buildCompletionCompletenessCritic({
    dimension,
    input,
    referencedFiles,
    session,
    submittedRecipeIds,
  });

  // U2a：维度完成后写 per-(module×dimension) 覆盖账本（advisory 覆盖状态，非门禁）。
  // 放在 critic 之后、return 之前，且整段 best-effort：账本写失败不改响应、不阻断完成。
  // submittedRecipeIds 透传给 U2d 轮次回流：本次维度完成新增的 recipe 数累计进当前轮 new_recipes_this_round。
  await writeDimensionCompletionCoverageLedger({
    ctx,
    dimension,
    input,
    referencedFiles,
    submittedRecipeIds,
    projectRoot: session.projectRoot,
  });

  return {
    accumulatedHints,
    completenessCritic,
    evidenceHints,
    ideAgentAnalysisProgress,
    isComplete,
    progress,
    qualityFeedback,
    recipesBound,
    skillResult,
    subpackageCoverageWarning,
    updated,
  };
}

/** ModuleService 的最小投影：canonical 模块与 ProjectContext 真实 ownedFiles。 */
interface CanonicalModuleServiceLike {
  listCanonicalModules(): Promise<
    Array<{ id?: string; name: string; path?: string; ownedFiles?: string[] }>
  >;
}

/**
 * U2a：维度完成时写覆盖账本（best-effort，绝不阻断完成）。
 *
 * module 轴来自 canonical ProjectMap（ModuleService.listCanonicalModules），优先 ownedFiles，缺失时才用模块根路径；
 * 候选 = referencedFiles（importance 60，已落点→覆盖）∪ 各模块 ownedPath（importance 50，未被引用→暴露 thin/blank 缺口）；
 * coveredPaths = referencedFiles 去行号；perCellTarget 由 canonical 模块数定 tier 后取 D2 默认值。
 * 维度只写本次完成的这一维（dimensionIds=[dimension.id]）；exhausted 仅在 Agent 显式 noPadding+reason 时按维落 agent-declared。
 *
 * no-guess：moduleService 不可用或无 canonical 模块 → 直接跳过（不臆造模块轴）。
 * D3：本路径只写 coverage_ledger，绝不触达 git_diff_checkpoints。
 */
async function writeDimensionCompletionCoverageLedger(args: {
  ctx: HostAgentDimensionCompletionContext;
  dimension: DimensionDef;
  input: CompletionInput;
  referencedFiles: string[];
  submittedRecipeIds: string[];
  projectRoot: string;
}): Promise<void> {
  const { ctx, dimension, input, referencedFiles, submittedRecipeIds, projectRoot } = args;
  const logger = ctx.logger;
  try {
    const coverageLedgerRepository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!coverageLedgerRepository) {
      // DI 未注册账本仓（旧容器/部分启动）→ 跳过，advisory 写入缺席不影响完成。
      logger?.debug?.('[DimensionComplete] coverage ledger write skipped: repository unavailable');
      return;
    }

    const moduleService = ctx.container.get('moduleService') as
      | CanonicalModuleServiceLike
      | undefined;
    if (!moduleService || typeof moduleService.listCanonicalModules !== 'function') {
      logger?.debug?.(
        '[DimensionComplete] coverage ledger write skipped: moduleService unavailable'
      );
      return;
    }
    const canonicalModules = await moduleService.listCanonicalModules();
    if (canonicalModules.length === 0) {
      // no-guess：没有 canonical 模块就没有可信 module 轴，不臆造模块。
      logger?.debug?.('[DimensionComplete] coverage ledger write skipped: no canonical modules');
      return;
    }

    // canonical 模块 → CoverageLedgerModuleAxis：真实 ownedFiles 优先；无 ownedFiles 时才用模块根路径兜底。
    // Core pathsOverlap 已是 segment-safe 目录匹配，不会把 `src/auth` 误归到 `src/authentication`。
    const modules: CoverageLedgerModuleAxis[] = canonicalModules.map((module) => {
      const ownedFiles = uniqueStrings(module.ownedFiles ?? []);
      return {
        moduleId: module.id ?? module.name,
        moduleName: module.name,
        ownedPaths: ownedFiles.length > 0 ? ownedFiles : module.path ? [module.path] : [],
      };
    });

    // coveredPaths = 已引用文件去行号锚点（referencedFiles 形如 `path:10-20`，剥离末尾 `:行号`）。
    const coveredPaths = referencedFiles.map((ref) => ref.replace(/:\d+(?:-\d+)?$/, ''));
    // 候选：referencedFiles 作高价值已覆盖候选（importance 60）；模块 ownedPath 作低价值候选（importance 50），
    // 未被引用的模块 ownedPath → 候选未覆盖 → 该 (模块×维度) 落 thin/empty，正是 deepMining 想要的空白/单薄信号。
    const candidates: CoverageLedgerCandidate[] = [
      ...coveredPaths.map((path) => ({
        dimensionIds: [dimension.id],
        sourceRefPaths: [path],
        importance: 60,
      })),
      ...modules
        .filter((module) => module.ownedPaths.length > 0)
        .map((module) => ({
          dimensionIds: [dimension.id],
          sourceRefPaths: [...module.ownedPaths],
          importance: 50,
        })),
    ];

    const tier = resolveModuleTier(modules.length);
    const perCellTarget = resolvePerCellTargetDefault(tier);

    // exhausted：仅当 Agent 显式 noPadding=true 且给了非空 reason，才按维度对每个模块落 agent-declared 尽力声明。
    let exhaustedDeclarations: CoverageLedgerExhaustedDeclaration[] | undefined;
    const exhaustedReason =
      typeof input.exhaustedReason === 'string' ? input.exhaustedReason.trim() : '';
    if (input.noPadding === true && exhaustedReason.length > 0) {
      exhaustedDeclarations = modules.map((module) => ({
        moduleId: module.moduleId,
        dimensionId: dimension.id,
        reason: exhaustedReason,
      }));
    }

    // 轮号戳：取账本里最新一轮（升序末元素）的轮号，无轮次则 0；这批 cell 归属该轮（deepMining 多轮收敛用）。
    // 轮次的 new_recipes_this_round 累加在下方 reflow 里完成（helper 内自取最新轮）。
    const rounds = coverageLedgerRepository.listRoundsByProjectRoot(projectRoot);
    const lastRound = rounds.length > 0 ? rounds[rounds.length - 1].roundIndex : 0;

    writeCoverageLedgerForCompletion({
      repository: coverageLedgerRepository,
      projectRoot,
      modules,
      dimensionIds: [dimension.id],
      candidates,
      coveredPaths,
      perCellTarget,
      ...(exhaustedDeclarations ? { exhaustedDeclarations } : {}),
      lastRound,
      ...(logger ? { logger } : {}),
    });

    // U2d 轮次回流：本次维度完成把「新增 recipe 数」累计进当前已开轮（reflowDeepMiningRoundOnCompletion 内取最新轮、
    // 累加 new_recipes_this_round、推进 completedAt；coldStart 无已开轮则自然跳过）。new_recipes 是收益递减判定的真实输入，
    // 必须由回流写入，否则收敛建议会把刚开的、产出仍为 0 的本轮当「上一轮」误判递减、令多轮循环每轮立即停止。
    const newRecipeCount =
      typeof input.candidateCount === 'number' && input.candidateCount > 0
        ? input.candidateCount
        : submittedRecipeIds.length;
    reflowDeepMiningRoundOnCompletion({
      repository: coverageLedgerRepository,
      projectRoot,
      newRecipeCount,
      ...(logger ? { logger } : {}),
    });
  } catch (err: unknown) {
    // 任何异常都吞掉：账本写入是 advisory 旁路，绝不改变维度完成响应或阻断完成。
    const reason = err instanceof Error ? err.message : String(err);
    logger?.debug?.(`[DimensionComplete] coverage ledger write skipped: ${reason}`);
  }
}

function buildDimensionCompletionSuccessResponse({
  dimensionId,
  result,
  responseTimeMs,
}: {
  dimensionId: string;
  result: DimensionCompletionSideEffectResult;
  responseTimeMs: number;
}): HostAgentDimensionCompletionResponse {
  const accumulatedHints =
    result.accumulatedHints && Object.keys(result.accumulatedHints).length > 0
      ? result.accumulatedHints
      : undefined;
  return {
    success: true,
    data: {
      dimensionId,
      updated: result.updated,
      skillCreated: result.skillResult.success,
      projectSkillDelivery: result.skillResult.deliveryReceipt
        ? {
            receipt: result.skillResult.deliveryReceipt,
            runtimeExport: result.skillResult.deliveryReceipt.runtimeExport,
            shoutSummary: result.skillResult.deliveryReceipt.shoutSummary,
          }
        : undefined,
      recipesBound: result.recipesBound,
      progress: `${result.progress.completed}/${result.progress.total}`,
      completedDimensions: result.progress.completedDimIds,
      remainingDimensions: result.progress.remainingDimIds,
      isBootstrapComplete: result.isComplete,
      accumulatedHints,
      qualityFeedback: result.qualityFeedback,
      completenessCritic: result.completenessCritic,
      evidenceHints: result.evidenceHints,
      ideAgentAnalysisProgress: result.ideAgentAnalysisProgress,
      subpackageCoverageWarning: result.subpackageCoverageWarning,
      nextActions: result.isComplete ? BOOTSTRAP_COMPLETE_ACTIONS : undefined,
    },
    meta: {
      tool: 'alembic_dimension_complete',
      responseTimeMs,
    },
  };
}

function validateDimensionCompletionBeforeSideEffects({
  input,
  referencedFiles,
  session,
  submittedRecipeIds,
}: {
  input: CompletionInput;
  referencedFiles: string[];
  session: HostAgentWorkflowSession;
  submittedRecipeIds: string[];
}): HostAgentDimensionCompletionResponse | null {
  const previewQualityReport = previewDimensionQualityReport({
    analysisText: input.analysisText,
    dimensionId: input.dimensionId,
    referencedFiles,
    session,
  });
  const evidenceGate = validateDimensionCompletionEvidenceGate({
    analysisText: input.analysisText,
    candidateCount: input.candidateCount,
    dimensionId: input.dimensionId,
    keyFindings: input.keyFindings,
    qualityReport: previewQualityReport,
    referencedFiles,
    session,
    submittedRecipeIds,
  });
  return evidenceGate.ok
    ? null
    : evidenceGateFailureResponse('alembic_dimension_complete', evidenceGate);
}

function validateDimensionCompletionFailedQuality({
  input,
  qualityReport,
  referencedFiles,
  session,
  submittedRecipeIds,
}: {
  input: CompletionInput;
  qualityReport: NonNullable<
    ReturnType<HostAgentWorkflowSession['markDimensionComplete']>['qualityReport']
  >;
  referencedFiles: string[];
  session: HostAgentWorkflowSession;
  submittedRecipeIds: string[];
}): HostAgentDimensionCompletionResponse {
  const failedQualityGate = validateDimensionCompletionEvidenceGate({
    analysisText: input.analysisText,
    candidateCount: input.candidateCount,
    dimensionId: input.dimensionId,
    keyFindings: input.keyFindings,
    qualityReport,
    referencedFiles,
    session,
    submittedRecipeIds,
  });
  return evidenceGateFailureResponse('alembic_dimension_complete', failedQualityGate);
}

function normalizeCompletionInput(
  args: HostAgentDimensionCompleteArgs
):
  | { success: true; value: CompletionInput }
  | { success: false; response: HostAgentDimensionCompletionResponse } {
  const dimensionId = typeof args.dimensionId === 'string' ? args.dimensionId : undefined;
  const analysisText = typeof args.analysisText === 'string' ? args.analysisText : undefined;
  const submittedRecipeIds = args.submittedRecipeIds ?? [];

  if (!dimensionId) {
    return {
      success: false,
      response: validationFailure('Missing required parameter: dimensionId'),
    };
  }
  if (!analysisText || analysisText.length < 10) {
    return {
      success: false,
      response: validationFailure('analysisText is required and must be at least 10 characters'),
    };
  }
  if (!Array.isArray(submittedRecipeIds)) {
    return {
      success: false,
      response: validationFailure('submittedRecipeIds must be an array of recipe ID strings'),
    };
  }

  return {
    success: true,
    value: {
      sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
      dimensionId,
      analysisUnitIds: uniqueStrings([
        ...(typeof args.unitId === 'string' ? [args.unitId] : []),
        ...stringArray(args.analysisUnitIds),
      ]),
      skippedAnalysisUnitIds: stringArray(args.skippedAnalysisUnitIds),
      rejectedAnalysisUnitIds: stringArray(args.rejectedAnalysisUnitIds),
      remainingAnalysisUnitIds: stringArray(args.remainingAnalysisUnitIds),
      deviationReason: typeof args.deviationReason === 'string' ? args.deviationReason : undefined,
      submittedRecipeIds: submittedRecipeIds.filter((id): id is string => typeof id === 'string'),
      analysisText,
      referencedFiles: stringArray(args.referencedFiles),
      keyFindings: stringArray(args.keyFindings),
      candidateCount: typeof args.candidateCount === 'number' ? args.candidateCount : undefined,
      exhaustedReason: typeof args.exhaustedReason === 'string' ? args.exhaustedReason : undefined,
      noPadding: args.noPadding === true,
      crossDimensionHints:
        args.crossDimensionHints && typeof args.crossDimensionHints === 'object'
          ? (args.crossDimensionHints as Record<string, unknown>)
          : undefined,
    },
  };
}

async function resolveHostAgentCompletionSession({
  ctx,
  input,
  dependencies,
}: {
  ctx: HostAgentDimensionCompletionContext;
  input: CompletionInput;
  dependencies: HostAgentDimensionCompletionDependencies;
}): Promise<
  | { success: true; value: HostAgentWorkflowSession }
  | { success: false; response: HostAgentDimensionCompletionResponse }
> {
  const getActiveSession = dependencies.getActiveSession ?? getActiveHostAgentWorkflowSession;
  const session = await getActiveSession(ctx.container, input.sessionId);
  if (session) {
    return { success: true, value: session };
  }

  return {
    success: false,
    response: {
      success: false,
      message: input.sessionId
        ? `No active bootstrap session found with id: ${input.sessionId}`
        : 'No active bootstrap session. Call alembic_bootstrap first.',
      errorCode: 'SESSION_NOT_FOUND',
      meta: { tool: 'alembic_dimension_complete' },
    },
  };
}

async function getActiveHostAgentWorkflowSession(
  container: HostAgentSessionContainer,
  sessionId?: string
): Promise<HostAgentWorkflowSession | null> {
  const { getActiveHostAgentWorkflowSession: getActiveCoreHostAgentWorkflowSession } = await import(
    '@alembic/core/host-agent-workflows'
  );
  return getActiveCoreHostAgentWorkflowSession(
    container as never,
    sessionId
  ) as HostAgentWorkflowSession | null;
}

function extendSessionTtl(session: HostAgentWorkflowSession): void {
  if (session.expiresAt) {
    session.expiresAt = Math.max(session.expiresAt, Date.now() + 60 * 60 * 1000);
  }
}

function recoverReferencedFiles(session: HostAgentWorkflowSession, dimensionId: string): string[] {
  try {
    const submissions = session.submissionTracker.getSubmissions(dimensionId);
    const filesFromSources = new Set<string>();
    for (const submission of submissions) {
      for (const source of submission.sources) {
        filesFromSources.add(source.split(':')[0]);
      }
    }
    if (filesFromSources.size > 0) {
      logger.debug(
        `[DimensionComplete] Auto-recovered ${filesFromSources.size} referencedFiles from submissions for "${dimensionId}"`
      );
    }
    return [...filesFromSources];
  } catch {
    return [];
  }
}

function recoverSubmittedRecipeIds(
  session: HostAgentWorkflowSession,
  dimensionId: string
): string[] {
  try {
    const recoveredIds = session.submissionTracker
      .getSubmissions(dimensionId)
      .map((submission) => submission.recipeId)
      .filter((id): id is string => Boolean(id));
    if (recoveredIds.length > 0) {
      logger.debug(
        `[DimensionComplete] Auto-recovered ${recoveredIds.length} submittedRecipeIds from tracker for "${dimensionId}"`
      );
    }
    return recoveredIds;
  } catch {
    return [];
  }
}

async function bindSubmittedRecipes({
  ctx,
  session,
  dimensionId,
  submittedRecipeIds,
}: {
  ctx: HostAgentDimensionCompletionContext;
  session: HostAgentWorkflowSession;
  dimensionId: string;
  submittedRecipeIds: string[];
}): Promise<number> {
  if (submittedRecipeIds.length === 0) {
    return 0;
  }

  let recipesBound = 0;
  try {
    const knowledgeService = ctx.container.get('knowledgeService') as KnowledgeServiceLike | null;
    if (!knowledgeService) {
      return recipesBound;
    }

    for (const recipeId of submittedRecipeIds) {
      try {
        const entry = await knowledgeService.get(recipeId);
        if (!entry) {
          continue;
        }
        const newTags = [
          ...new Set([
            ...dimensionTags(dimensionId, parseExistingTags(entry.tags)),
            `bootstrap:${session.id}`,
          ]),
        ];
        await knowledgeService.update(
          recipeId,
          { dimensionId, tags: newTags },
          { userId: getDeveloperIdentity() }
        );
        recipesBound++;
      } catch (err: unknown) {
        logger.debug(
          `[DimensionComplete] Failed to tag recipe ${recipeId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err: unknown) {
    logger.warn(
      `[DimensionComplete] Recipe tagging failed (degraded): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return recipesBound;
}

function parseExistingTags(tags: string[] | string | undefined): string[] {
  if (Array.isArray(tags)) {
    return tags;
  }
  if (typeof tags !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
}

async function createHostAgentDimensionSkill({
  ctx,
  dimension,
  dimensionId,
  analysisText,
  referencedFiles,
  keyFindings,
  submittedRecipeIds,
  dependencies,
}: {
  ctx: HostAgentDimensionCompletionContext;
  dimension: DimensionDef;
  dimensionId: string;
  analysisText: string;
  referencedFiles: string[];
  keyFindings: string[];
  submittedRecipeIds: string[];
  dependencies: HostAgentDimensionCompletionDependencies;
}): Promise<HostAgentDimensionSkillResult> {
  if (!dimension.skillWorthy) {
    return { success: false };
  }

  const effectiveAnalysis = await synthesizeSkillAnalysisIfNeeded({
    ctx,
    dimension,
    dimensionId,
    analysisText,
    keyFindings,
    submittedRecipeIds,
  });
  const generateSkill = dependencies.generateSkill ?? generateWorkflowSkill;
  const skillResult = await generateSkill(
    ctx,
    dimension,
    effectiveAnalysis,
    referencedFiles,
    keyFindings,
    HOST_AGENT_SOURCE
  );
  if (!skillResult.success) {
    logger.warn(`[DimensionComplete] Skill skipped for "${dimensionId}": ${skillResult.error}`);
  }
  return {
    success: skillResult.success,
    deliveryReceipt: (skillResult as { deliveryReceipt?: ProjectSkillDeliveryReceipt })
      .deliveryReceipt,
    error: skillResult.error,
    exportResult: (skillResult as { exportResult?: Record<string, unknown> }).exportResult,
  };
}

async function synthesizeSkillAnalysisIfNeeded({
  ctx,
  dimension,
  dimensionId,
  analysisText,
  keyFindings,
  submittedRecipeIds,
}: {
  ctx: HostAgentDimensionCompletionContext;
  dimension: DimensionDef;
  dimensionId: string;
  analysisText: string;
  keyFindings: string[];
  submittedRecipeIds: string[];
}): Promise<string> {
  if (submittedRecipeIds.length === 0) {
    return analysisText;
  }

  try {
    const knowledgeService = ctx.container.get('knowledgeService') as KnowledgeServiceLike | null;
    if (!knowledgeService) {
      return analysisText;
    }
    const parts: string[] = [`## ${dimension.label || dimensionId} — 分析报告\n`];
    if (analysisText.trim().length > 0) {
      parts.push(analysisText.trim(), '');
    }
    for (const recipeId of submittedRecipeIds) {
      const entry = await knowledgeService.get(recipeId);
      if (!entry) {
        continue;
      }
      parts.push(...renderSubmittedRecipeGuidance(entry));
    }
    appendKeyFindings(parts, keyFindings);

    const synthesized = parts.join('\n');
    if (synthesized.length > analysisText.length) {
      logger.info(
        `[DimensionComplete] Synthesized analysisText for "${dimensionId}" from ${submittedRecipeIds.length} candidates (${analysisText.length} → ${synthesized.length} chars)`
      );
      return synthesized;
    }
  } catch (err: unknown) {
    logger.debug(
      `[DimensionComplete] Failed to synthesize analysisText: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return analysisText;
}

function renderSubmittedRecipeGuidance(entry: KnowledgeEntryLike): string[] {
  const parts = [`### ${entry.title || 'Untitled'}`];
  if (entry.description) {
    parts.push(entry.description);
  }
  appendRecipeClauses(parts, entry);
  if (entry.coreCode) {
    parts.push('', '```', entry.coreCode.substring(0, 500), '```');
  }
  parts.push('');
  return parts;
}

function appendRecipeClauses(parts: string[], entry: KnowledgeEntryLike): void {
  if (!entry.whenClause && !entry.doClause && !entry.dontClause) {
    return;
  }
  parts.push('');
  if (entry.whenClause) {
    parts.push(`- **When**: ${entry.whenClause}`);
  }
  if (entry.doClause) {
    parts.push(`- **Do**: ${entry.doClause}`);
  }
  if (entry.dontClause) {
    parts.push(`- **Don't**: ${entry.dontClause}`);
  }
}

function appendKeyFindings(parts: string[], keyFindings: readonly string[]): void {
  if (keyFindings.length === 0) {
    return;
  }
  parts.push('## Key Findings', '');
  for (const finding of keyFindings) {
    parts.push(`- ${finding}`);
  }
}

async function persistDimensionCheckpoint({
  session,
  dataRoot,
  dimensionId,
  candidateCount,
  analysisText,
  referencedFiles,
  submittedRecipeIds,
  skillCreated,
  ideAgentAnalysisProgress,
  dependencies,
}: {
  session: HostAgentWorkflowSession;
  dataRoot: string;
  dimensionId: string;
  candidateCount: number;
  analysisText: string;
  referencedFiles: string[];
  submittedRecipeIds: string[];
  skillCreated: boolean;
  ideAgentAnalysisProgress: ReturnType<typeof buildIDEAgentAnalysisProgressBackfill>;
  dependencies: HostAgentDimensionCompletionDependencies;
}): Promise<void> {
  try {
    const saveCheckpoint = dependencies.saveCheckpoint ?? saveDimensionCheckpoint;
    await saveCheckpoint(dataRoot, session.id, dimensionId, {
      candidateCount,
      analysisChars: analysisText.length,
      referencedFiles: referencedFiles.length,
      recipeIds: submittedRecipeIds,
      skillCreated,
      ideAgentAnalysisProgress,
    });
  } catch (err: unknown) {
    logger.warn(
      `[DimensionComplete] Checkpoint save failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function persistKeyFindings({
  ctx,
  session,
  dimensionId,
  keyFindings,
}: {
  ctx: HostAgentDimensionCompletionContext;
  session: HostAgentWorkflowSession;
  dimensionId: string;
  keyFindings: string[];
}): Promise<void> {
  try {
    const knowledgeGraphService = ctx.container.get(
      'knowledgeGraphService'
    ) as KnowledgeGraphServiceLike | null;
    if (!knowledgeGraphService || keyFindings.length === 0) {
      return;
    }
    for (const finding of keyFindings) {
      await knowledgeGraphService.addEdge(
        dimensionId,
        'dimension',
        finding.substring(0, 80),
        'finding',
        'discovered_in',
        { source: HOST_AGENT_SOURCE, sessionId: session.id }
      );
    }
  } catch (err: unknown) {
    logger.debug(
      `[DimensionComplete] SemanticMemory fixation skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function emitHostAgentCompletionProgress({
  ctx,
  session,
  dimension,
  dimensionId,
  candidateCount,
  skillCreated,
  recipesBound,
  progress,
  isComplete,
  dependencies,
}: {
  ctx: HostAgentDimensionCompletionContext;
  session: HostAgentWorkflowSession;
  dimension: DimensionDef;
  dimensionId: string;
  candidateCount: number;
  skillCreated: boolean;
  recipesBound: number;
  progress: ReturnType<HostAgentWorkflowSession['getProgress']>;
  isComplete: boolean;
  dependencies: HostAgentDimensionCompletionDependencies;
}): void {
  const emitter = dependencies.createEmitter
    ? dependencies.createEmitter(ctx.container)
    : new BootstrapEventEmitter(ctx.container);
  emitter.emitDimensionComplete(dimensionId, {
    type: dimension.skillWorthy ? 'skill' : 'candidate',
    extracted: candidateCount,
    skillCreated,
    recipesBound,
    progress: `${progress.completed}/${progress.total}`,
    isBootstrapComplete: isComplete,
    source: HOST_AGENT_SOURCE,
  });
  if (isComplete) {
    emitter.emitAllComplete(session.id, progress.total, HOST_AGENT_SOURCE);
  }
}

function buildQualityFeedback({
  dimensionId,
  qualityReport,
}: {
  dimensionId: string;
  qualityReport: ReturnType<HostAgentWorkflowSession['markDimensionComplete']>['qualityReport'];
}): Record<string, unknown> | undefined {
  if (!qualityReport) {
    return undefined;
  }
  const qualityFeedback = {
    totalScore: qualityReport.totalScore,
    pass: qualityReport.pass,
    scores: qualityReport.scores,
    suggestions: qualityReport.suggestions.length > 0 ? qualityReport.suggestions : undefined,
  };
  if (qualityReport.pass) {
    logger.info(
      `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 PASS`
    );
  } else {
    logger.warn(
      `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 BELOW_THRESHOLD`
    );
  }
  return qualityFeedback;
}

function buildCompletionCompletenessCritic({
  dimension,
  input,
  referencedFiles,
  session,
  submittedRecipeIds,
}: {
  dimension: DimensionDef;
  input: CompletionInput;
  referencedFiles: string[];
  session: HostAgentWorkflowSession;
  submittedRecipeIds: string[];
}): Record<string, unknown> | undefined {
  try {
    const trackerSubmissions = session.submissionTracker.getSubmissions(input.dimensionId);
    const result = buildDimensionCompletionCompletenessCritic({
      dimension: {
        id: dimension.id,
        label: dimension.label,
        guide: (dimension as { guide?: string }).guide,
        knowledgeTypes: (dimension as { knowledgeTypes?: readonly string[] }).knowledgeTypes,
      },
      exhaustedReason: input.exhaustedReason,
      noPadding: input.noPadding,
      referencedFiles,
      sessionSnapshot: session.getSnapshotCache?.(),
      submittedRecipeCount: input.candidateCount || submittedRecipeIds.length,
      submittedRecipes: buildSubmittedRecipesForCompletenessCritic({
        dimensionId: input.dimensionId,
        submittedRecipeIds,
        trackerSubmissions,
      }),
    });
    return projectCompletenessCriticForAgent(result);
  } catch (err: unknown) {
    logger.debug(
      `[DimensionComplete] Completeness critic skipped for "${input.dimensionId}": ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

function buildSubpackageCoverageWarning({
  session,
  dimensionId,
  referencedFiles,
}: {
  session: HostAgentWorkflowSession;
  dimensionId: string;
  referencedFiles: string[];
}): string | undefined {
  try {
    const localPackages = session.getSnapshotCache?.()?.localPackageModules;
    if (!localPackages || localPackages.length === 0 || referencedFiles.length === 0) {
      return undefined;
    }
    const uncoveredPackages: string[] = [];
    for (const localPackage of localPackages) {
      const packagePrefix = (localPackage.packageName ?? localPackage.path ?? '').replace(
        /\/$/,
        ''
      );
      const packageName = localPackage.name ?? packagePrefix;
      if (!packagePrefix && !packageName) {
        continue;
      }
      const covered = referencedFiles.some(
        (file) =>
          (packagePrefix.length > 0 && file.includes(packagePrefix)) ||
          (packageName.length > 0 && file.includes(packageName))
      );
      if (!covered) {
        uncoveredPackages.push(packageName);
      }
    }
    if (uncoveredPackages.length === 0) {
      return undefined;
    }
    logger.info(
      `[DimensionComplete] Subpackage coverage gap for "${dimensionId}": ${uncoveredPackages.join(', ')}`
    );
    return (
      `本维度未覆盖以下本地子包: ${uncoveredPackages.join(', ')}。` +
      `建议在分析中纳入这些模块的源码，以确保知识库完整性。`
    );
  } catch {
    return undefined;
  }
}

function buildEvidenceHints({
  session,
  isComplete,
  accumulatedEvidence,
}: {
  session: HostAgentWorkflowSession;
  isComplete: boolean;
  accumulatedEvidence: AccumulatedEvidenceLike;
}): Record<string, unknown> | undefined {
  if (
    isComplete ||
    (accumulatedEvidence.completedDimSummaries.length === 0 &&
      accumulatedEvidence.negativeSignals.length === 0)
  ) {
    return undefined;
  }

  return {
    previousSubmissions: accumulatedEvidence.completedDimSummaries.map((summary) => ({
      dimId: summary.dimId,
      submissionCount: summary.submissionCount,
      titles: summary.titles,
      referencedFiles: summary.referencedFiles,
    })),
    previousDimensionAnalysis: buildPreviousDimensionAnalysis(session, accumulatedEvidence),
    sharedFiles:
      accumulatedEvidence.sharedFiles.length > 0 ? accumulatedEvidence.sharedFiles : undefined,
    negativeSignals:
      accumulatedEvidence.negativeSignals.length > 0
        ? accumulatedEvidence.negativeSignals.map((signal) => signal.pattern)
        : undefined,
    usedTriggers:
      accumulatedEvidence.usedTriggers.length > 0 ? accumulatedEvidence.usedTriggers : undefined,
    _note:
      '以上为前序维度的分析证据，包含分析摘要和关键发现。请利用其中的文件引用和负空间信号，避免重复分析已覆盖的内容',
  };
}

function buildPreviousDimensionAnalysis(
  session: HostAgentWorkflowSession,
  accumulatedEvidence: AccumulatedEvidenceLike
) {
  try {
    const summaries: Array<{ dimId: string; analysisSummary: string; keyFindings: string[] }> = [];
    for (const dimensionSummary of accumulatedEvidence.completedDimSummaries) {
      const report = session.sessionStore.getDimensionReport(dimensionSummary.dimId) as
        | DimensionReportLike
        | undefined;
      if (!report) {
        continue;
      }
      summaries.push({
        dimId: dimensionSummary.dimId,
        analysisSummary: (report.analysisText || '').substring(0, 500),
        keyFindings: (report.findings || [])
          .slice(0, 5)
          .map((finding) => finding.finding || finding.content || ''),
      });
    }
    return summaries.length > 0 ? summaries : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.filter((item) => item.trim().length > 0))];
}

function validationFailure(
  message: string,
  errorCode = 'VALIDATION_ERROR'
): HostAgentDimensionCompletionResponse {
  return {
    success: false,
    message,
    errorCode,
    meta: { tool: 'alembic_dimension_complete' },
  };
}

function evidenceGateFailureResponse(
  tool: string,
  evidenceGate: ReturnType<typeof validateDimensionCompletionEvidenceGate>
): HostAgentDimensionCompletionResponse {
  return {
    success: false,
    errorCode: primaryEvidenceGateCode(evidenceGate),
    message:
      'Dimension evidence gate failed before checkpoint/progress finalization. Rebuild the bootstrap Recipe loop evidence.',
    data: {
      ...buildEvidenceGateFailureData(evidenceGate),
      problem: {
        type: 'alembic.dimension-evidence-gate.rebuild-required',
        status: 'rebuild-required',
        title: 'Dimension completion evidence did not meet the production floor',
        nextAction:
          evidenceGate.violations[0]?.nextAction ||
          'Repair submitted Recipe ids, referenced files, findings, and analysis before retrying.',
      },
    },
    meta: { tool },
  };
}
