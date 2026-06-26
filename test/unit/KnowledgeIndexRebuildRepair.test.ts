import { describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  rebuildLocalKnowledgeIndexes,
  resolveRescanScanBatchCap,
} from '../../lib/recipe-generation/host-agent-workflows/knowledge-index-rebuild.js';

// U6 P4/P5/D2 consumer wiring tests:
//  - P4: stale>0 → repairRenames+applyRepairs 激活、renamed/applied surface、幂等重跑不重复写。
//  - P4 degrade: 实例缺方法 → best-effort 跳过、不抛、按 reconcile 报告返回。
//  - P5: rebuild wrapper 返回报告；region-vector skipped → 高可见 warn；synced → 无 warn。
//  - D2: tier S/M/L → 50/150/400 + env 覆盖 + 守卫回退。

/** 最小 ServiceContainer.get 桩（同 RecipeRegionVectorAvailability.test.ts 口径）。 */
function createContainer(services: Record<string, unknown>): ServiceContainer {
  return {
    get: (name: string) => {
      if (!(name in services)) {
        throw new Error(`missing service ${name}`);
      }
      return services[name];
    },
  } as unknown as ServiceContainer;
}

/** reconcile 报告工厂——只填 P4 触发判定关心的字段，其余给确定默认。 */
function reconcileReport(overrides: { stale: number } & Record<string, number>) {
  return {
    active: 0,
    cleaned: 0,
    inserted: 0,
    recipesProcessed: 0,
    skipped: 0,
    ...overrides,
  };
}

/**
 * region-vector provider 桩：把 buildRecipeSemanticRegionVectors 推向 'skipped' 或 'synced'。
 * - unavailable=true → getAvailability 返回 available:false，建器走 vector-unavailable 跳过分支（status='skipped'）。
 * - unavailable=false → 单条 recipe + 可用 provider，建器走 synced 分支（semantic_memories 非 0）。
 */
function regionVectorServices(opts: { unavailable: boolean }): Record<string, unknown> {
  const availability = opts.unavailable
    ? {
        available: false,
        probeStatus: 'unavailable',
        reason: 'embed-provider-unavailable',
        status: 'degraded',
      }
    : {
        available: true,
        probeStatus: 'ready',
        reason: 'embed-provider-ready',
        status: 'available',
      };
  return {
    vectorService: {
      getAvailability: vi.fn(async () => availability),
      getStats: vi.fn(async () => ({
        count: 0,
        dimension: 1024,
        embedProviderAvailable: !opts.unavailable,
        hasIndex: true,
        indexSize: 0,
      })),
      syncRecipeSemanticRegions: vi.fn(async () => ({
        degradedReason: null,
        errors: [],
        generated: 1,
        generatedMetadata: [],
        removed: 0,
        scanned: 1,
        status: 'completed',
        upserted: 1,
      })),
    },
    knowledgeService: {
      list: vi.fn(async () => ({
        data: opts.unavailable
          ? []
          : [
              {
                toJSON: () => ({
                  category: 'runtime',
                  content: 'Region vector recipe.',
                  description: 'desc',
                  dimensionId: 'architecture',
                  id: 'recipe-rv',
                  lifecycle: 'active',
                  reasoning: { sources: ['Sources/App.swift'], whyStandard: 'proof' },
                  tags: ['vector'],
                  title: 'Region vector recipe',
                  trigger: 'when region vectors build',
                }),
              },
            ],
      })),
    },
    knowledgeSyncService: {
      sync: vi.fn(() => ({ created: 0, skipped: 0, synced: 0, updated: 0 })),
    },
    recipeSourceRefRepository: {
      findActiveByRecipeIds: vi.fn(() => [
        { recipeId: 'recipe-rv', sourcePath: 'Sources/App.swift', status: 'active' },
      ]),
    },
    vectorStore: { flush: vi.fn(async () => undefined) },
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('U6 P4 rename repair activation', () => {
  it('runs repairRenames then applyRepairs when stale>0 and surfaces renamed/applied counts', async () => {
    const repairRenames = vi.fn(async () => ({ renamed: 2, stillStale: 1 }));
    const applyRepairs = vi.fn(async () => ({ applied: 2, failed: 0 }));
    const reconcile = vi.fn(async () => reconcileReport({ stale: 3, inserted: 3 }));
    const reconciler = { reconcile, repairRenames, applyRepairs };

    const log = logger();
    const report = await rebuildLocalKnowledgeIndexes({
      container: createContainer({
        sourceRefReconciler: reconciler,
        ...regionVectorServices({ unavailable: true }),
      }),
      db: {},
      logger: log,
      logPrefix: 'Test',
    });

    expect(repairRenames).toHaveBeenCalledTimes(1);
    expect(applyRepairs).toHaveBeenCalledTimes(1);
    // 顺序固定：repairRenames（标记）必须先于 applyRepairs（写回）。
    expect(repairRenames.mock.invocationCallOrder[0]).toBeLessThan(
      applyRepairs.mock.invocationCallOrder[0]
    );
    expect(report.sourceRefs).toMatchObject({ stale: 3, renamed: 2, applied: 2 });
  });

  it('is idempotent: a second run on an already-repaired tree does not double-apply', async () => {
    // Core 幂等语义：repaired 后 stale=0 / 无 renamed 行 → 早返回 0 计数。这里以 stale=0 模拟
    // 「已修复树重跑」——P4 在 stale<=0 时根本不触发 repair，证明不会二次写回。
    const repairRenames = vi.fn(async () => ({ renamed: 0, stillStale: 0 }));
    const applyRepairs = vi.fn(async () => ({ applied: 0, failed: 0 }));
    const reconcile = vi.fn(async () => reconcileReport({ stale: 0, active: 5 }));
    const reconciler = { reconcile, repairRenames, applyRepairs };

    const report = await rebuildLocalKnowledgeIndexes({
      container: createContainer({
        sourceRefReconciler: reconciler,
        ...regionVectorServices({ unavailable: true }),
      }),
      db: {},
      logger: logger(),
      logPrefix: 'Test',
    });

    expect(repairRenames).not.toHaveBeenCalled();
    expect(applyRepairs).not.toHaveBeenCalled();
    // stale=0 时不附加 renamed/applied（无修复发生）。
    expect(report.sourceRefs).toMatchObject({ stale: 0 });
    expect(report.sourceRefs).not.toHaveProperty('renamed');
  });

  it('degrades gracefully when repairRenames/applyRepairs are absent on the instance', async () => {
    // 旧 Core / 残桩：实例上只有 reconcile。stale>0 但无修复方法 → 跳过、不抛、返回 reconcile 报告。
    const reconcile = vi.fn(async () => reconcileReport({ stale: 4, inserted: 4 }));
    const reconciler = { reconcile };

    const report = await rebuildLocalKnowledgeIndexes({
      container: createContainer({
        sourceRefReconciler: reconciler,
        ...regionVectorServices({ unavailable: true }),
      }),
      db: {},
      logger: logger(),
      logPrefix: 'Test',
    });

    expect(report.sourceRefs).toMatchObject({ stale: 4 });
    expect(report.sourceRefs).not.toHaveProperty('renamed');
  });
});

describe('U6 P5 region-vector skip warning + report surface', () => {
  it('returns the rebuild report and emits a high-visibility warning when region vectors are skipped', async () => {
    const reconciler = {
      reconcile: vi.fn(async () => reconcileReport({ stale: 0 })),
    };
    const log = logger();
    const report = await rebuildLocalKnowledgeIndexes({
      container: createContainer({
        sourceRefReconciler: reconciler,
        ...regionVectorServices({ unavailable: true }),
      }),
      db: {},
      logger: log,
      logPrefix: 'Rescan',
    });

    expect(report.recipeRegionVectors.status).toBe('skipped');
    const warned = log.warn.mock.calls.some((call) =>
      String(call[0]).includes('semantic-region vectors NOT built')
    );
    expect(warned).toBe(true);
  });

  it('does not warn when region vectors are synced (semantic_memories non-zero)', async () => {
    const reconciler = {
      reconcile: vi.fn(async () => reconcileReport({ stale: 0 })),
    };
    const log = logger();
    const report = await rebuildLocalKnowledgeIndexes({
      container: createContainer({
        sourceRefReconciler: reconciler,
        ...regionVectorServices({ unavailable: false }),
      }),
      db: {},
      logger: log,
      logPrefix: 'Rescan',
    });

    // synced 时 region-vector 真正构建（syncRecipeSemanticRegions 被调用），status 反映之；
    // 不发「NOT built」告警。（semantic_memories 子路径依赖独立 memoryRepository，此处不纳入断言。）
    expect(report.recipeRegionVectors.status).toBe('synced');
    expect(report.recipeRegionVectors.syncResult).not.toBeNull();
    const warned = log.warn.mock.calls.some((call) =>
      String(call[0]).includes('semantic-region vectors NOT built')
    );
    expect(warned).toBe(false);
  });
});

describe('U6 D2 rescan scan batch cap', () => {
  it('selects 50 / 150 / 400 for tiers S / M / L', () => {
    delete process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP;
    expect(resolveRescanScanBatchCap('S')).toBe(50);
    expect(resolveRescanScanBatchCap('M')).toBe(150);
    expect(resolveRescanScanBatchCap('L')).toBe(400);
  });

  it('honors ALEMBIC_RESCAN_SCAN_BATCH_CAP override across tiers', () => {
    process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP = '90';
    try {
      expect(resolveRescanScanBatchCap('S')).toBe(90);
      expect(resolveRescanScanBatchCap('L')).toBe(90);
    } finally {
      delete process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP;
    }
  });

  it('guards against 0 / negative / non-integer overrides by falling back to the tier default', () => {
    for (const bad of ['0', '-5', 'abc']) {
      process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP = bad;
      expect(resolveRescanScanBatchCap('M')).toBe(150);
    }
    process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP = '120.7';
    expect(resolveRescanScanBatchCap('L')).toBe(120); // 向下取整（LIMIT 需整数）
    delete process.env.ALEMBIC_RESCAN_SCAN_BATCH_CAP;
  });
});
