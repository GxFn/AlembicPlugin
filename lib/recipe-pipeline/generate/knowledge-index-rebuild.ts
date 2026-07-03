import type { ServiceContainer } from '#inject/ServiceContainer.js';
import {
  buildRecipeSemanticRegionVectors,
  type RecipeRegionVectorBuildReport,
} from './recipe-region-vector.js';

// U6 D2：fingerprint/rescan scan 的批量上限 tier 表（S/M/L → 50/150/400）。
// 与 Core perCellTarget 的 D2_PER_CELL_TARGET_DEFAULT(={S:5,M:3,L:2}) 不同——那是 per-cell
// 「生成多少条 recipe」目标，本表是「单批扫描/对账多少条」上限，两者语义独立、勿混用。
// 设计为 orchestration 层 caller-supplied cap（同 DecayDetector.scanAll(cap) /
// StagingManager.checkAndPromote(cap) 口径）：U6-Core reconcile 保持 caller-limited，
// 由本层供 cap。⚠ 现状 Core SourceRefReconciler.reconcile(opts?:{force?}) 尚未暴露 cap 形参，
// 故本表尚无可注入的 U6 reconcile 出口（blocked-on-Core，待 Core 加 cap 形参后接线）；
// 此处先固化权威 tier 表 + 解析器，避免散落魔数、为接线就绪。
type ScanBatchTier = 'L' | 'M' | 'S';
const D2_SCAN_BATCH_CAP_BY_TIER: Record<ScanBatchTier, number> = { S: 50, M: 150, L: 400 } as const;

interface KnowledgeIndexRebuildContext {
  container: ServiceContainer;
  db: unknown;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  logPrefix: string;
}

interface KnowledgeSyncServiceLike {
  sync(
    db: unknown,
    opts?: { force?: boolean }
  ): {
    created: number;
    skipped: number;
    synced: number;
    updated: number;
    violations?: string[];
  };
}

interface SourceRefReconcilerLike {
  reconcile(opts?: { force?: boolean }): Promise<{
    active: number;
    cleaned?: number;
    drifted?: number;
    inserted: number;
    recipesProcessed: number;
    skipped: number;
    stale: number;
  }>;
  // U6 P4：rename 修复另一半。真实容器实例（Core SourceRefReconciler）始终带这两个方法；
  // 此处声明为可选，使「实例上缺方法」（旧 Core / 残桩）走 best-effort 跳过分支而非类型错误。
  // 两者都是幂等的：repairRenames 在 findStale() 为空时早返回 {renamed:0,stillStale:0}，
  // applyRepairs 在 findRenamed() 为空时早返回 {applied:0,failed:0}——已修复的树上重跑不会重复写。
  applyRepairs?: () => Promise<{ applied: number; failed: number }>;
  repairRenames?: () => Promise<{ renamed: number; stillStale: number }>;
}

// U6 P4：reconcile 报告之上附加 rename 修复计数（renamed=git 检测到 rename 的条目，
// applied=写回 .md+DB 并转 active 的条目），供 P5 surface。仅当本轮触发了修复时出现。
type ReconcileReportWithRepair = Awaited<ReturnType<SourceRefReconcilerLike['reconcile']>> & {
  applied?: number;
  renamed?: number;
};

export interface KnowledgeIndexRebuildReport {
  knowledgeSync: ReturnType<KnowledgeSyncServiceLike['sync']> | null;
  recipeRegionVectors: RecipeRegionVectorBuildReport;
  sourceRefs: ReconcileReportWithRepair | null;
}

/**
 * Rebuild local derived Recipe indexes from the canonical knowledge rows.
 *
 * This is intentionally shared by rescan and local verification scripts:
 * - KnowledgeSyncService restores Recipe files -> knowledge_entries.
 * - SourceRefReconciler restores knowledge_entries.reasoning.sources -> recipe_source_refs.
 * - Recipe semantic-region vectors then use recipe_source_refs as their bridge metadata.
 */
export async function rebuildLocalKnowledgeIndexes(
  ctx: KnowledgeIndexRebuildContext
): Promise<KnowledgeIndexRebuildReport> {
  const knowledgeSync = syncKnowledgeEntries(ctx);
  const sourceRefs = await reconcileSourceRefs(ctx);
  const recipeRegionVectors = await buildRecipeSemanticRegionVectors({
    container: ctx.container,
    logger: ctx.logger,
    logPrefix: ctx.logPrefix,
  });

  // U6 P5：region-vector provider 不可用 → 报告 status 已是 'skipped'（建器内部各跳过分支统一置位）；
  // 这里在装配层补一条高可见 warn，让「semantic_memories 维持 0、subject-less prime 无法挣到
  // recipe-semantic-region 信任证据」对 rescan 运维可见（建器内只有 info 级 logger）。
  // status='synced' 时 semantic_memories 从 0→非 0，无需告警；'failed' 是带原因的非阻断失败，亦记 warn。
  warnIfRegionVectorsNotBuilt(ctx, recipeRegionVectors);

  return { knowledgeSync, recipeRegionVectors, sourceRefs };
}

/**
 * U6 P5：当 region-vector 未真正构建（skipped/failed）时发高可见告警。
 * 仅 surface，不改变构建判定——provider 在则 status='synced'、semantic_memories 非 0；
 * provider 缺则建器已置 status='skipped'，此处把它升级成 warn 让运维注意到 region 信任证据缺口。
 */
function warnIfRegionVectorsNotBuilt(
  ctx: KnowledgeIndexRebuildContext,
  report: RecipeRegionVectorBuildReport
): void {
  if (report.status === 'synced') {
    return;
  }
  ctx.logger.warn(
    `[${ctx.logPrefix}] Recipe semantic-region vectors NOT built (status=${report.status}); semantic_memories stay 0 and subject-less prime cannot earn recipe-semantic-region trust until a vector provider is available`,
    {
      status: report.status,
      reason: report.reason,
      semanticMemoryStatus: report.semanticMemories?.status ?? null,
      semanticMemoryTotal: report.semanticMemories?.total ?? 0,
      vectorAvailable: report.vectorAvailability?.available ?? null,
    }
  );
}

function syncKnowledgeEntries(
  ctx: KnowledgeIndexRebuildContext
): ReturnType<KnowledgeSyncServiceLike['sync']> | null {
  try {
    const syncService = ctx.container.get('knowledgeSyncService') as KnowledgeSyncServiceLike;
    const report = syncService.sync(ctx.db, { force: true });
    ctx.logger.info(`[${ctx.logPrefix}] KnowledgeSyncService sync complete`, {
      created: report.created,
      skipped: report.skipped,
      synced: report.synced,
      updated: report.updated,
      violations: report.violations?.length ?? 0,
    });
    return report;
  } catch (err: unknown) {
    ctx.logger.warn(
      `[${ctx.logPrefix}] KnowledgeSyncService sync failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function reconcileSourceRefs(
  ctx: KnowledgeIndexRebuildContext
): Promise<ReconcileReportWithRepair | null> {
  try {
    const reconciler = ctx.container.get('sourceRefReconciler') as SourceRefReconcilerLike;
    const report: ReconcileReportWithRepair = await reconciler.reconcile({ force: true });
    ctx.logger.info(`[${ctx.logPrefix}] SourceRefReconciler reconcile complete`, {
      active: report.active,
      cleaned: report.cleaned ?? 0,
      drifted: report.drifted ?? 0,
      inserted: report.inserted,
      recipesProcessed: report.recipesProcessed,
      skipped: report.skipped,
      stale: report.stale,
    });

    // U6 P4：reconcile 标出 stale ref 后，激活 rename 修复另一半——
    // repairRenames（git rename 检测 → 标 renamed）→ applyRepairs（写回 .md+DB → 转 active）。
    // 仅在 stale>0 时触发；stale=0 时无可修复条目，跳过避免无谓 git 调用。
    // 幂等保证由 Core 早返回提供（见 SourceRefReconcilerLike 注释），重跑安全。
    await maybeRepairRenames(ctx, reconciler, report);

    return report;
  } catch (err: unknown) {
    ctx.logger.warn(
      `[${ctx.logPrefix}] SourceRefReconciler reconcile failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * U6 P4：对 stale ref 尝试 git rename 修复并把计数合并进 reconcile 报告（供 P5 surface）。
 *
 * - 触发条件：report.stale > 0（无 stale → 无可修复条目，直接返回）。
 * - best-effort 降级：实例上缺 repairRenames/applyRepairs（旧 Core / 残桩）时记 info 并按现状返回，
 *   不抛错、不阻断 rescan。
 * - 顺序固定：必须 repairRenames（标记）在前、applyRepairs（写回）在后——applyRepairs 只消费
 *   findRenamed() 的行，跳过前者则无行可写。
 * - 幂等：两个 Core 方法在各自来源集合为空时早返回 0 计数，已修复树上重跑得 renamed=0/applied=0，
 *   不重复写 .md/DB；本函数不引入任何破坏该幂等性的状态。
 */
async function maybeRepairRenames(
  ctx: KnowledgeIndexRebuildContext,
  reconciler: SourceRefReconcilerLike,
  report: ReconcileReportWithRepair
): Promise<void> {
  if (report.stale <= 0) {
    return;
  }
  if (
    typeof reconciler.repairRenames !== 'function' ||
    typeof reconciler.applyRepairs !== 'function'
  ) {
    ctx.logger.info(
      `[${ctx.logPrefix}] SourceRefReconciler rename repair unavailable on instance (skipped, non-blocking)`,
      { stale: report.stale }
    );
    return;
  }
  try {
    const repair = await reconciler.repairRenames();
    const apply = await reconciler.applyRepairs();
    // 合并修复计数进报告——renamed/applied 让 P5 / rescan response 能区分
    // 「stale 已被 rename 修复」与「stale 仍未解决」。
    report.renamed = repair.renamed;
    report.applied = apply.applied;
    ctx.logger.info(`[${ctx.logPrefix}] SourceRefReconciler rename repair complete`, {
      renamed: repair.renamed,
      stillStale: repair.stillStale,
      applied: apply.applied,
      failed: apply.failed,
    });
  } catch (err: unknown) {
    // 修复失败不阻断 rescan：保留已得 reconcile 报告，记 warn 供排查。
    ctx.logger.warn(
      `[${ctx.logPrefix}] SourceRefReconciler rename repair failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * U6 D2：解析 fingerprint/rescan scan 的单批上限（cap），按项目规模 tier 选 50/150/400。
 *
 * - tier 入参：S/M/L（由调用方按项目规模信号——如模块数/recipe 数——给出）。
 * - env 覆盖：ALEMBIC_RESCAN_SCAN_BATCH_CAP 显式设定时，统一覆盖所有 tier（运维逃生阀）。
 * - 守卫（同 resolveStagingAccessSweepCap 口径）：env 仅接受有限正整数(>=1)，否则回退 tier 默认——
 *   挡两个 foot-gun：cap=0（批为 0＝静默禁扫）、负值（传到 SQL LIMIT 后＝无界，反破坏有界语义）；
 *   非整数向下取整（LIMIT 需整数）。
 *
 * ⚠ 接线状态：本解析器是「就绪但暂未注入」——Core SourceRefReconciler.reconcile 当前
 * 不接受 cap 形参（见文件头 D2 表注释），故 U6 reconcile 路径上没有可供 cap 的出口。
 * 待 Core 暴露 reconcile(opts.cap) 或等价 caller-limited scan 后，由本层把本 cap 传入。
 * 导出以便就绪后接线与测试覆盖。
 */
export function resolveRescanScanBatchCap(tier: ScanBatchTier): number {
  const fallback = D2_SCAN_BATCH_CAP_BY_TIER[tier];
  const raw = process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP;
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}
