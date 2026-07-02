import { resolveModuleTier, resolvePerCellTargetDefault } from '@alembic/core/host-agent-workflows';
import type { PlanStageId } from '@alembic/core/plans';
import type {
  CoverageLedgerRecord,
  EvolutionCoverageLedgerRepository,
} from '@alembic/core/repositories';
import {
  attachFullProjectInfoTreeRefIfNeeded,
  buildCandidateDimensions,
  buildProjectInfoTree,
  buildProjectProfileFromAnalysis,
  type CandidateDimension,
  collectPlanProjectContext,
  PLAN_FACTS_PROJECTION_BUDGET_BYTES,
  type PlanProjectContextAnalysis,
  type ProjectInfoTreeRoot,
} from '@alembic/core/service/planFacts';
import { resolveProjectRoot } from '@alembic/core/workspace';
import type { PlanInput } from '#shared/schemas/mcp-tools.js';
import { confirmPlan } from './plan-confirm.js';

interface PlanToolContext {
  actor?: { role?: string; user?: string };
  container: {
    get(name: string): unknown;
    singletons?: Record<string, unknown>;
  };
}

interface PlanToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

type PlanArgs = PlanInput;

/** U2b：deepMining 草稿向 Agent 暴露的覆盖账本「信号」（gap 候选 + 现存计数 + 评级 + 单轮上限）。 */
interface CoverageSeedGapCandidate {
  moduleId: string;
  moduleName?: string;
  dimensionId: string;
  grade: CoverageLedgerRecord['grade'];
  coveredCount: number;
  totalCandidateCount: number;
  valueScore: number;
  /** 距 perCellTarget 的缺口（advisory，供 Agent 参考；非强制目标）。 */
  suggestedDeficit: number;
}

interface CoverageSeedRatingByDimension {
  empty: number;
  thin: number;
  partial: number;
  covered: number;
}

interface CoverageSeed {
  /** 价值降序的空白/单薄 cell（已排除 exhausted-with-reason 格），已按 D2 单轮上限截断。 */
  gapCandidates: CoverageSeedGapCandidate[];
  /** 每维已覆盖 recipe 计数（账本 coveredCount 求和）。 */
  existingCountByDimension: Record<string, number>;
  /** 每维 cell 评级分布（empty/thin/partial/covered 计数）。 */
  ratingByDimension: Record<string, CoverageSeedRatingByDimension>;
  /** D2 单轮 cell 上限（按 tier）。 */
  perRoundCellBudget: number;
  tier: 'S' | 'M' | 'L';
}

interface PlanDraftContext {
  analysis: PlanProjectContextAnalysis;
  projectRoot: string;
  projectInfoTree: ProjectInfoTreeRoot;
  candidateDimensions: CandidateDimension[];
  // U2b：deepMining 草稿才有的覆盖账本信号；coldStart/moduleMining 留 undefined（coldStart 仍从零）。
  coverageSeed?: CoverageSeed;
  // U2b：把请求的 generationStage 透传进来，让 confirm next-action 不再硬编码 coldStart。
  requestedStage?: PlanStageId;
}

const PLAN_TOOL_NAME = 'alembic_plan';
// C-1(2026-07-02 统一重构)：投影预算改由 Core 单源常量提供，与主体 PlanSelectionGate 同一定义。
const DEFAULT_PROJECT_INFO_TREE_BUDGET_BYTES = PLAN_FACTS_PROJECTION_BUDGET_BYTES;

// D2 perRoundCellBudget —— 单轮 cell 上限，防止 deepMining 单轮预算爆炸；
// 这是 plan 编排侧的 cell 数上限，与 Core 的 K/maxRounds 停止条件正交（一个限「本轮喂多少格」，
// 一个限「该不该再扫一轮」）。按 canonical 模块规模 tier 取值。
const D2_PER_ROUND_CELL_BUDGET = { S: 50, M: 60, L: 80 } as const;

/**
 * U2b（纯函数，可独立单测）：从账本 cells 构建 deepMining 草稿的覆盖信号。
 *
 * gapCandidates = grade∈{empty,thin} 且非（exhausted && 有 reason）的 cell，按 valueScore 降序，
 * 再按 D2[tier] 单轮上限截断。每项带 suggestedDeficit=max(0, perCellTarget−coveredCount)。
 * 另产出 existingCountByDimension（每维 coveredCount 求和）与 ratingByDimension（每维评级分布）。
 *
 * no-guess：这些只是 SIGNAL，最终扫哪些 cell / 预算多少由 Agent confirm 决定。
 */
export function buildCoverageSeedFromCells(
  cells: readonly CoverageLedgerRecord[],
  options: { moduleCount: number }
): CoverageSeed {
  const tier = resolveModuleTier(options.moduleCount);
  const perCellTarget = resolvePerCellTargetDefault(tier);
  const perRoundCellBudget = D2_PER_ROUND_CELL_BUDGET[tier];

  // 每维已覆盖计数 + 评级分布（遍历全量 cells，无论是否进 gapCandidates）。
  const existingCountByDimension: Record<string, number> = {};
  const ratingByDimension: Record<string, CoverageSeedRatingByDimension> = {};
  for (const cell of cells) {
    existingCountByDimension[cell.dimensionId] =
      (existingCountByDimension[cell.dimensionId] ?? 0) + cell.coveredCount;
    const rating =
      ratingByDimension[cell.dimensionId] ??
      (ratingByDimension[cell.dimensionId] = { empty: 0, thin: 0, partial: 0, covered: 0 });
    rating[cell.grade] += 1;
  }

  // gap 候选：只取空白/单薄；排除 Agent 已声明尽力（exhausted+reason）的格——那是「已尽」不是「缺口」。
  const gapCandidates: CoverageSeedGapCandidate[] = cells
    .filter((cell) => {
      const isGapGrade = cell.grade === 'empty' || cell.grade === 'thin';
      const exhaustedWithReason =
        cell.exhausted === true &&
        typeof cell.exhaustedReason === 'string' &&
        cell.exhaustedReason.trim().length > 0;
      return isGapGrade && !exhaustedWithReason;
    })
    .map((cell) => ({
      // CoverageLedgerRecord 不带 moduleName（只有 moduleId/dimensionId 轴），故 gap 候选只透传 moduleId。
      moduleId: cell.moduleId,
      dimensionId: cell.dimensionId,
      grade: cell.grade,
      coveredCount: cell.coveredCount,
      totalCandidateCount: cell.totalCandidateCount,
      valueScore: cell.valueScore ?? 0,
      suggestedDeficit: Math.max(0, perCellTarget - cell.coveredCount),
    }))
    // 价值降序：高价值空白排前，供 Agent 优先考虑。
    .sort((left, right) => right.valueScore - left.valueScore)
    // D2 单轮上限截断（防预算爆炸）。
    .slice(0, perRoundCellBudget);

  return {
    gapCandidates,
    existingCountByDimension,
    ratingByDimension,
    perRoundCellBudget,
    tier,
  };
}

export async function routePlanTool(
  ctx: PlanToolContext,
  args: PlanArgs
): Promise<PlanToolResponse> {
  switch (args.operation) {
    case 'draft':
      return draftPlan(ctx, args);
    case 'confirm':
      return confirmPlan(ctx, args);
    case 'get':
      return blocked(
        'PLAN_GET_REMOVED',
        'alembic_plan get was removed with the stateless planSelection contract; run draft and confirm for each generation stage.',
        {
          operation: 'get',
          projectRoot: resolvePlanProjectRoot(ctx, args),
          nextActions: buildStatelessPlanNextActions(resolvePlanProjectRoot(ctx, args)),
        }
      );
    default:
      return blocked(
        'PLAN_INVALID_OPERATION',
        'alembic_plan operation must be draft, confirm, or get.'
      );
  }
}

async function draftPlan(ctx: PlanToolContext, args: PlanArgs): Promise<PlanToolResponse> {
  const projectRoot = resolvePlanProjectRoot(ctx, args);
  const analysis = await collectPlanProjectContext(projectRoot, args.hints);
  if (analysis.fileCount === 0 && analysis.moduleCount === 0) {
    return emptyProjectContextResponse(projectRoot);
  }

  const draftContext = await buildPlanDraftContext(ctx, args, projectRoot, analysis);
  return planDraftResponse(draftContext);
}

function emptyProjectContextResponse(projectRoot: string): PlanToolResponse {
  return blocked(
    'PLAN_PROJECT_CONTEXT_EMPTY',
    'ProjectContext returned no files or modules for Plan draft.',
    {
      operation: 'draft',
      projectRoot,
      planDiagnostics: [
        {
          code: 'project-context-empty',
          severity: 'warning',
          message: 'No ProjectContext files/modules were available to ground a Plan draft.',
        },
      ],
    }
  );
}

async function buildPlanDraftContext(
  ctx: PlanToolContext,
  args: PlanArgs,
  projectRoot: string,
  analysis: PlanProjectContextAnalysis
): Promise<PlanDraftContext> {
  const budgetBytes = resolveProjectInfoTreeBudgetBytes(args);
  const projectInfoTree = buildProjectInfoTree(analysis, budgetBytes);
  await attachFullProjectInfoTreeRefIfNeeded(projectInfoTree, {
    analysis,
    projectRoot,
  });
  // U2b：deepMining 草稿每次都「重新读」账本生成覆盖信号；coldStart/moduleMining 不读（coldStart 仍从零）。
  // RED LINE 1：plan 仍是无状态 draft→confirm，账本只是被读取的覆盖状态，绝不把 plan 持久化。
  const coverageSeed =
    args.generationStage === 'deepMining'
      ? loadDeepMiningCoverageSeed(ctx, projectRoot, analysis.moduleCount)
      : undefined;
  return {
    analysis,
    projectRoot,
    projectInfoTree,
    candidateDimensions: buildCandidateDimensions(analysis),
    ...(coverageSeed ? { coverageSeed } : {}),
    // requestedStage 透传：confirm next-action 据此回填 generationStage（不再硬编码 coldStart）。
    ...(args.generationStage ? { requestedStage: args.generationStage } : {}),
  };
}

/**
 * U2b：读账本 → 覆盖信号（best-effort）。账本不可用或读失败 → 返回 undefined（草稿仍可工作，只是没信号）。
 * RED LINE 1：这是「每次草稿重新读」，无任何 plan/session 持久化。
 */
function loadDeepMiningCoverageSeed(
  ctx: PlanToolContext,
  projectRoot: string,
  moduleCount: number
): CoverageSeed | undefined {
  try {
    const coverageLedgerRepository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!coverageLedgerRepository) {
      return undefined;
    }
    const cells = coverageLedgerRepository.listByProjectRoot(projectRoot);
    if (cells.length === 0) {
      // 账本空（尚未跑过 coldStart/dimension_complete）→ 无信号；deepMining 草稿照常返回项目事实。
      return undefined;
    }
    return buildCoverageSeedFromCells(cells, { moduleCount });
  } catch (_err: unknown) {
    // 读账本失败绝不影响草稿：吞掉异常、返回 undefined（草稿仍输出 projectInfoTree/candidateDimensions）。
    return undefined;
  }
}

function planDraftResponse(draftContext: PlanDraftContext): PlanToolResponse {
  return {
    success: true,
    message: 'Stateless Plan draft is ready for Agent confirmation.',
    data: {
      operation: 'draft',
      projectRoot: draftContext.projectRoot,
      projectInfoTree: draftContext.projectInfoTree,
      candidateDimensions: draftContext.candidateDimensions,
      agentDecisionChecklist: buildAgentDecisionChecklist(),
      // U2b：deepMining 草稿带覆盖信号（gap 候选/现存计数/评级/单轮上限）。no-guess：是 SIGNAL，由 Agent 决定。
      ...(draftContext.coverageSeed ? { coverageSeed: draftContext.coverageSeed } : {}),
      nextActions: [buildDraftConfirmNextAction(draftContext)],
    },
  };
}

function buildDraftConfirmNextAction(draftContext: PlanDraftContext): Record<string, unknown> {
  return {
    tool: PLAN_TOOL_NAME,
    operation: 'confirm',
    required: true,
    reason:
      'Agent must author a complete Plan confirmation payload from the returned facts before generation.',
    requiredPayloadFields: [
      'selectedDimensions',
      'scale',
      'moduleBindings',
      'plannedNextActions',
      'evidenceRefs',
      'rationale',
    ],
    args: {
      operation: 'confirm',
      // U2b：generationStage 不再硬编码 coldStart。有覆盖信号 → deepMining；否则回退请求的 stage，再退 coldStart。
      // （coverageSeed 仅 deepMining 草稿才有，故它在场即等价于 deepMining。）
      generationStage: draftContext.coverageSeed
        ? 'deepMining'
        : (draftContext.requestedStage ?? 'coldStart'),
      projectProfile: buildProjectProfileFromAnalysis(draftContext.analysis),
    },
  };
}

function buildAgentDecisionChecklist(): string[] {
  return [
    'Pick dimensions from candidateDimensions; do not infer hidden recommended or skipped dimensions.',
    'Choose one generationStage for this run: coldStart, deepMining, or moduleMining.',
    'Set scale.totalRecipeBudget, depthLevels, maxFiles, and contentMaxLines from the projectInfoTree evidence.',
    'Bind selected dimensions to concrete module paths when moduleMining or scoped deepMining is needed.',
    'Call alembic_plan confirm with projectProfile from projectInfoTree L0 before bootstrap or rescan.',
  ];
}

function resolveProjectInfoTreeBudgetBytes(args: PlanArgs): number {
  const hintedKilobytes = args.hints?.maxBudget;
  if (typeof hintedKilobytes === 'number' && Number.isFinite(hintedKilobytes)) {
    return Math.max(1024, Math.floor(hintedKilobytes * 1024));
  }
  return DEFAULT_PROJECT_INFO_TREE_BUDGET_BYTES;
}

function buildStatelessPlanNextActions(projectRoot: string): Record<string, unknown>[] {
  return [
    {
      tool: PLAN_TOOL_NAME,
      operation: 'draft',
      required: true,
      reason: 'Collect a fresh bounded projectInfoTree and candidateDimensions before generation.',
      args: { operation: 'draft', projectRoot },
    },
    {
      tool: PLAN_TOOL_NAME,
      operation: 'confirm',
      required: true,
      reason: 'Return a stateless planSelection and pass it directly to the generation tool.',
    },
  ];
}

function resolvePlanProjectRoot(ctx: PlanToolContext, args: Partial<PlanArgs>): string {
  return args.projectRoot ?? resolveProjectRoot(ctx.container);
}

function blocked(
  errorCode: string,
  message: string,
  data: Record<string, unknown> = {}
): PlanToolResponse {
  return {
    success: false,
    errorCode,
    message,
    data,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function _readString(record: unknown, key: string): string | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
