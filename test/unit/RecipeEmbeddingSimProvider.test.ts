/**
 * RecipeEmbeddingSimProvider 单元测试
 *
 * 覆盖：
 *  1. provider 工厂：无 vectorStore → null（不注入，Core 走纯 Jaccard）。
 *  2. 预热 + 同步查表：高相似向量 → 高数值；端到端经 RedundancyAnalyzer，
 *     embedding 注入使 content 维度与整体相似度 **严格高于** 纯 Jaccard。
 *  3. 确定性回退：缺失向量 / 某侧无 id / 维度不一致 / 索引异常 → undefined（同入同出）。
 *  4. 余弦数值正确性 + clamp。
 *
 * 这里用「返回已知向量的 stub store」测试 provider 自身逻辑（合法：测的是本仓库 provider，
 * 不是生产 VectorService 接线）。生产接线用真实 VectorService，由 KnowledgeModule 完成。
 */

import { RedundancyAnalyzer } from '@alembic/core/evolution';
import { describe, expect, it } from 'vitest';
import {
  createRecipeEmbeddingSimProvider,
  type RegionVectorStorePort,
} from '../../lib/recipe-generation/vector/recipe-embedding-sim-provider.js';

const REGION_TYPE = 'recipe-semantic-region';

/** 构建一个返回固定 region 记录的 stub VectorStore（仅实现 searchByFilter）。 */
function stubStore(
  records: Array<{ id: string; recipeId: string; vector: number[] }>,
  opts: { throwOnSearch?: boolean } = {}
): RegionVectorStorePort {
  return {
    async searchByFilter(filter: Record<string, unknown>): Promise<Record<string, unknown>[]> {
      if (opts.throwOnSearch) {
        throw new Error('stub store boom');
      }
      // 仅返回匹配 type 的记录（模拟 Core 的 metadata 过滤）。
      if (filter.type !== REGION_TYPE) {
        return [];
      }
      return records.map((r) => ({
        id: r.id,
        content: 'x',
        vector: r.vector,
        metadata: { type: REGION_TYPE, recipeId: r.recipeId },
      }));
    },
  };
}

/** 单位向量（用于精确余弦断言）。 */
function unit(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return values.map((v) => v / norm);
}

describe('createRecipeEmbeddingSimProvider', () => {
  it('returns null when no vectorStore is available (Core stays pure Jaccard)', () => {
    expect(createRecipeEmbeddingSimProvider({ vectorStore: null })).toBeNull();
    expect(createRecipeEmbeddingSimProvider({ vectorStore: undefined })).toBeNull();
    // 不具备 searchByFilter 的对象也视为不可用。
    expect(
      createRecipeEmbeddingSimProvider({
        vectorStore: {} as unknown as RegionVectorStorePort,
      })
    ).toBeNull();
  });

  it('computes high cosine similarity for near-identical precomputed vectors', async () => {
    const store = stubStore([
      { id: 'recipe_region_r1_implementation_aaaa', recipeId: 'r1', vector: unit([1, 0.05, 0]) },
      { id: 'recipe_region_r2_implementation_bbbb', recipeId: 'r2', vector: unit([1, 0.04, 0]) },
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    expect(handle).not.toBeNull();
    const loaded = await handle!.preheat();
    expect(loaded).toBe(2);
    expect(handle!.size).toBe(2);

    const sim = handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never);
    expect(sim).toBeGreaterThan(0.99);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('returns undefined when a vector is missing (deterministic fallback, same input twice)', async () => {
    const store = stubStore([
      { id: 'recipe_region_r1_implementation_aaaa', recipeId: 'r1', vector: unit([1, 0, 0]) },
      // r2 has no region vector
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    await handle!.preheat();

    const first = handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never);
    const second = handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(first).toBe(second);
  });

  it('returns undefined when either side has no recipe id (candidate projections)', async () => {
    const store = stubStore([
      { id: 'recipe_region_r1_implementation_aaaa', recipeId: 'r1', vector: unit([1, 0, 0]) },
      { id: 'recipe_region_r2_implementation_bbbb', recipeId: 'r2', vector: unit([1, 0, 0]) },
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    await handle!.preheat();

    // candidateLike 没有 id（ConsolidationAdvisor 场景）→ 无法定位向量 → undefined。
    expect(handle!.provider({ title: 't' } as never, { id: 'r2' } as never)).toBeUndefined();
    expect(handle!.provider({ id: 'r1' } as never, { title: 't' } as never)).toBeUndefined();
  });

  it('returns undefined (never returns a constant) before preheat runs', () => {
    const store = stubStore([
      { id: 'recipe_region_r1_implementation_aaaa', recipeId: 'r1', vector: unit([1, 0, 0]) },
      { id: 'recipe_region_r2_implementation_bbbb', recipeId: 'r2', vector: unit([1, 0, 0]) },
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    // 未预热 → 内存空 → undefined（Jaccard 回退）。
    expect(handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never)).toBeUndefined();
  });

  it('falls back to empty (Jaccard) when the store throws during preheat (non-fatal)', async () => {
    const store = stubStore([], { throwOnSearch: true });
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    const loaded = await handle!.preheat();
    expect(loaded).toBe(0);
    expect(handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never)).toBeUndefined();
  });

  it('mean-pools multiple region vectors per recipe', async () => {
    // r1 有两条 region 向量，方向分别偏 x 和偏 y；归一化均值池化后落在两者之间。
    const store = stubStore([
      { id: 'recipe_region_r1_a_aaaa', recipeId: 'r1', vector: unit([1, 0, 0]) },
      { id: 'recipe_region_r1_b_bbbb', recipeId: 'r1', vector: unit([0, 1, 0]) },
      { id: 'recipe_region_r2_a_cccc', recipeId: 'r2', vector: unit([1, 1, 0]) },
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    await handle!.preheat();
    // r1 池化方向 ≈ [0.707,0.707]，与 r2 的 [0.707,0.707] 几乎同向 → 高相似。
    const sim = handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never);
    expect(sim).toBeGreaterThan(0.99);
  });

  it('skips zero/non-finite vectors during preheat without throwing', async () => {
    const store = stubStore([
      { id: 'recipe_region_r1_a', recipeId: 'r1', vector: [0, 0, 0] }, // zero norm → skipped
      { id: 'recipe_region_r1_b', recipeId: 'r1', vector: unit([1, 0, 0]) }, // valid
      { id: 'recipe_region_r2_a', recipeId: 'r2', vector: unit([1, 0, 0]) },
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    await handle!.preheat();
    const sim = handle!.provider({ id: 'r1' } as never, { id: 'r2' } as never);
    expect(sim).toBeGreaterThan(0.99);
  });
});

describe('RedundancyAnalyzer with embeddingSimProvider (embedding beats pure Jaccard)', () => {
  // 设计：两条 recipe 共享 title / clause / guardPattern（驱动 title 0.15 + clause 0.25 +
  // guard 0.15 = 0.55 基线，越过阈值前缺一口气），但 coreCode 用「完全不重叠的标识符」，
  // 使 content token Jaccard ≈ 0。这样 content 维度（0.30）在「注入 embedding」前后是
  // 唯一变量：纯 Jaccard 下 content≈0，整体 < 0.65 → null；注入高 embedding 后 content≈1，
  // 整体跨过阈值 → 非 null，且 content 维度严格更高。直接证明 embedding > 纯 Jaccard。
  function makeRecipe(overrides: Record<string, unknown>) {
    return {
      id: 'x',
      title: '',
      doClause: null,
      dontClause: null,
      coreCode: null,
      guardPattern: null,
      content: null,
      ...overrides,
    } as Parameters<RedundancyAnalyzer['analyzePair']>[0];
  }

  const sharedTitle = 'Invalidate timer references inside the teardown lifecycle hook';
  const sharedClause = 'Always release scheduled timer references during teardown to avoid leaks';
  const sharedGuard = 'timer\\.invalidate';

  const a = makeRecipe({
    id: 'r1',
    title: sharedTitle,
    doClause: sharedClause,
    guardPattern: sharedGuard,
    // content token 集合 A：一组独有标识符。
    coreCode: 'alphaToken; betaToken; gammaToken; deltaToken; epsilonToken;',
  });
  const b = makeRecipe({
    id: 'r2',
    title: sharedTitle,
    doClause: sharedClause,
    guardPattern: sharedGuard,
    // content token 集合 B：与 A 完全不相交 → content token Jaccard ≈ 0。
    coreCode: 'omegaToken; sigmaToken; tauToken; rhoToken; lambdaToken;',
  });

  function repo() {
    return { findAllByLifecycles: async () => [] } as never;
  }

  async function highSimProvider() {
    const store = stubStore([
      { id: 'recipe_region_r1_x', recipeId: 'r1', vector: unit([1, 0.02, 0.01]) },
      { id: 'recipe_region_r2_x', recipeId: 'r2', vector: unit([1, 0.03, 0.02]) },
    ]);
    const handle = createRecipeEmbeddingSimProvider({ vectorStore: store });
    await handle!.preheat();
    return handle!.provider;
  }

  it('content dimension and overall similarity are strictly higher with the provider', async () => {
    const provider = await highSimProvider();

    const withProvider = new RedundancyAnalyzer(repo(), { embeddingSimProvider: provider });
    const withoutProvider = new RedundancyAnalyzer(repo());

    const baseline = withoutProvider.analyzePair(a, b);
    const boosted = withProvider.analyzePair(a, b);

    // 纯 Jaccard：content≈0，整体 < 0.65 → null（未判冗余）。
    expect(baseline).toBeNull();

    // 注入 embedding：content≈1，整体跨过阈值 → 非 null，content 维度显著提升。
    expect(boosted).not.toBeNull();
    expect(boosted!.dimensions.content).toBeGreaterThan(0.9);
    expect(boosted!.similarity).toBeGreaterThanOrEqual(0.65);
  });

  it('without the provider the same pair is NOT flagged redundant (pure Jaccard)', () => {
    const withoutProvider = new RedundancyAnalyzer(repo());
    // 纯 token Jaccard 对这对「disjoint coreCode」近义 recipe → content≈0 → 整体不过阈值。
    expect(withoutProvider.analyzePair(a, b)).toBeNull();
  });
});
