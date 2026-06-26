/**
 * coverage-ledger-write — U2 覆盖账本写入的共享适配层（纯输入版）。
 *
 * 复用方：U2a（dimension-completion 维度完成写已扫 cell）+ U2c（coldStart confirm 写 deferred 空行）。
 * 这里只做「已解析输入 → buildCoverageLedger → repository.upsertCell」的薄适配，不读 fs、不硬编码宿主路径、
 * 不扫项目：modules/dimensionIds/candidates/coveredPaths/perCellTarget 全由调用方从 canonical ProjectMap +
 * 已提交 recipe 证据提供，project_root 由调用方在 upsert 时传入（Core 不另造来源）。
 *
 * 边界声明（红线）：
 * - 覆盖账本只是 **advisory 覆盖状态**，不是生产/阻断门；写失败必须吞掉、返回零计数，绝不阻断维度完成或 confirm。
 * - D3：本模块只写 coverage_ledger，**绝不读写 git_diff_checkpoints**（账本链与 git-diff checkpoint 完全正交）。
 * - no-guess：deferred 行只写「调用方明确判定本轮不扫」的 cell，不替宿主/Agent 推断该扫哪些。
 */

import {
  buildCoverageLedger,
  type CoverageLedgerCandidate,
  type CoverageLedgerCell,
  type CoverageLedgerExhaustedDeclaration,
  type CoverageLedgerModuleAxis,
} from '@alembic/core/host-agent-workflows';
import type { EvolutionCoverageLedgerRepository } from '@alembic/core/repositories';

/** 最小日志接口：与 dimension-completion / plan-tool 现有 logger 结构兼容（debug 可选）。 */
interface CoverageLedgerWriteLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface CoverageLedgerWriteInput {
  repository: EvolutionCoverageLedgerRepository;
  /** Plugin 提供的 project_root（Core 不硬编码宿主路径，统一在 upsert 时落库）。 */
  projectRoot: string;
  /** canonical ModuleSummary ownedPaths 投影出的 module 轴。 */
  modules: readonly CoverageLedgerModuleAxis[];
  dimensionIds: readonly string[];
  candidates: readonly CoverageLedgerCandidate[];
  coveredPaths: readonly string[];
  perCellTarget: number;
  exhaustedDeclarations?: readonly CoverageLedgerExhaustedDeclaration[];
  /** 这批 cell 归属的轮次戳（deepMining 轮号；coldStart 由调用方传 0/1）。 */
  lastRound?: number | null;
  /** U2c：本轮判定为「不扫」的 cell，落 grade=empty,deferred=1 空行（让 deepMining「空白格」语义无歧义）。 */
  deferredCells?: ReadonlyArray<{ moduleId: string; dimensionId: string }>;
  logger?: CoverageLedgerWriteLogger;
}

export interface CoverageLedgerWriteResult {
  writtenCells: number;
  deferredCells: number;
  cells: CoverageLedgerCell[];
}

/**
 * 为一次完成构建 per-(module×dimension) 覆盖账本并 upsert。
 *
 * 流程：buildCoverageLedger 聚合 candidates+coveredPaths → cells；逐 cell upsert（lastRound 戳轮号、deferred:false）；
 * 再为 deferredCells 中「不在已建 cell 里」的格子写空 deferred 行。整段 try/catch 包裹：任何异常都吞掉并返回零计数，
 * 保证 advisory 写入永不阻断上游（维度完成 / confirm）。
 */
export function writeCoverageLedgerForCompletion(
  input: CoverageLedgerWriteInput
): CoverageLedgerWriteResult {
  const logger = input.logger;
  try {
    const cells = buildCoverageLedger({
      candidates: input.candidates,
      coveredPaths: input.coveredPaths,
      modules: input.modules,
      dimensionIds: input.dimensionIds,
      perCellTarget: input.perCellTarget,
      ...(input.exhaustedDeclarations
        ? { exhaustedDeclarations: input.exhaustedDeclarations }
        : {}),
    });

    const lastRound = input.lastRound ?? null;
    // 已建 cell 的 (module×dimension) 键集合，供 deferred 去重（已建为实测格，绝不被空 deferred 行覆盖）。
    const builtCellKeys = new Set<string>();
    let writtenCells = 0;
    for (const cell of cells) {
      builtCellKeys.add(`${cell.moduleId}::${cell.dimensionId}`);
      // 逐字段透传 Core 计算的 cell（grade/valueScore/exhausted 等都是 advisory 信号，不是阻断门）；deferred:false=实测格。
      input.repository.upsertCell({
        projectRoot: input.projectRoot,
        moduleId: cell.moduleId,
        dimensionId: cell.dimensionId,
        coveredCount: cell.coveredCount,
        totalCandidateCount: cell.totalCandidateCount,
        grade: cell.grade,
        coveredSourceRefs: cell.coveredSourceRefs,
        uncoveredHints: cell.uncoveredHints,
        valueScore: cell.valueScore,
        exhausted: cell.exhausted,
        exhaustedReason: cell.exhaustedReason,
        exhaustedSource: cell.exhaustedSource,
        lastRound,
        deferred: false,
      });
      writtenCells += 1;
    }

    // U2c deferred：本轮判定不扫的 cell 写空白行（grade=empty,deferred=1）。
    // 仅写「不在已建 cell 里」的格子——已建格是真实测量结果，不能被空 deferred 行盖掉（no-guess + 不回退实测）。
    let deferredWritten = 0;
    for (const deferred of input.deferredCells ?? []) {
      const key = `${deferred.moduleId}::${deferred.dimensionId}`;
      if (builtCellKeys.has(key)) {
        continue;
      }
      input.repository.upsertCell({
        projectRoot: input.projectRoot,
        moduleId: deferred.moduleId,
        dimensionId: deferred.dimensionId,
        grade: 'empty',
        deferred: true,
        coveredCount: 0,
        totalCandidateCount: 0,
        valueScore: 0,
        lastRound,
      });
      deferredWritten += 1;
    }

    // 记录写入计数；info 级以示这是 advisory 覆盖状态而非门禁结果（D3：只写 coverage_ledger）。
    logger?.info('[CoverageLedger] coverage state written (advisory, not a gate)', {
      projectRoot: input.projectRoot,
      writtenCells,
      deferredCells: deferredWritten,
      dimensionIds: [...input.dimensionIds],
      lastRound,
    });

    return { writtenCells, deferredCells: deferredWritten, cells };
  } catch (err: unknown) {
    // advisory 写入失败绝不上抛：吞掉异常、返回零计数，保证维度完成 / confirm 主链不受影响。
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn('[CoverageLedger] coverage ledger write skipped (advisory, non-blocking)', {
      projectRoot: input.projectRoot,
      reason,
    });
    return { writtenCells: 0, deferredCells: 0, cells: [] };
  }
}

export interface DeepMiningRoundReflowResult {
  /** 是否更新了某一轮（无已开轮 → false，如 coldStart 维度完成）。 */
  updated: boolean;
  /** 更新后该轮的累计 new_recipes_this_round（updated=false 时为 0）。 */
  newRecipesThisRound: number;
  /** 被更新的轮号（updated=false 时为 null）。 */
  roundIndex: number | null;
}

/**
 * U2d 轮次回流：维度完成时把「本次新增 recipe 数」累计进当前已开轮的 new_recipes_this_round，并推进 completedAt。
 *
 * 轮次边界 = plan-confirm 开轮 → 该轮全部 dimension_complete 回流；一轮跨多个维度完成，逐次累加（2 + 1 → 3），
 * 最后一次完成的 completedAt 即轮末。new_recipes 是收益递减判定（new_recipes < K）的真实输入，必须由此回流写入，
 * 否则收敛建议会把刚开的、产出仍为 0 的本轮当「上一轮」误判递减、令多轮循环每轮立即停止。
 *
 * 取「最新一轮」= listRoundsByProjectRoot 升序末元素；无任何轮（如 coldStart 尚未开 deepMining 轮）→ 不造轮、返回 updated:false。
 * best-effort：失败吞掉、返回 updated:false，绝不阻断维度完成。D3：只写 deep_mining_rounds，不碰 git_diff_checkpoints。
 */
export function reflowDeepMiningRoundOnCompletion(input: {
  repository: EvolutionCoverageLedgerRepository;
  projectRoot: string;
  newRecipeCount: number;
  now?: number;
  logger?: CoverageLedgerWriteLogger;
}): DeepMiningRoundReflowResult {
  try {
    const rounds = input.repository.listRoundsByProjectRoot(input.projectRoot);
    if (rounds.length === 0) {
      // 无已开轮（coldStart 维度完成 / 尚未触发 deepMining 轮）→ 不造轮，自然跳过。
      return { updated: false, newRecipesThisRound: 0, roundIndex: null };
    }
    const latest = rounds[rounds.length - 1];
    const increment = Number.isFinite(input.newRecipeCount) ? Math.max(0, input.newRecipeCount) : 0;
    const accumulated = latest.newRecipesThisRound + increment;
    // 仅传 newRecipesThisRound + completedAt + rescanId；startedAt/triggerActor 由 Core upsertRound 的 `?? existing` 保留。
    input.repository.upsertRound({
      projectRoot: input.projectRoot,
      roundIndex: latest.roundIndex,
      rescanId: latest.rescanId,
      newRecipesThisRound: accumulated,
      completedAt: input.now ?? Date.now(),
    });
    return { updated: true, newRecipesThisRound: accumulated, roundIndex: latest.roundIndex };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    input.logger?.warn(
      '[CoverageLedger] deepMining round reflow skipped (advisory, non-blocking)',
      {
        projectRoot: input.projectRoot,
        reason,
      }
    );
    return { updated: false, newRecipesThisRound: 0, roundIndex: null };
  }
}
