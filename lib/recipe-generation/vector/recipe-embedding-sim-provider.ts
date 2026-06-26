/**
 * RecipeEmbeddingSimProvider — VectorService 预计算 region 向量 → 同步 embedding 相似度注入器
 *
 * U5 #1 closeout（插件侧）：把 VectorService / RecipeRegionVectorIndex 已经算好的
 * recipe semantic region 向量，封装成 Core 三处演化服务（RedundancyAnalyzer /
 * ProposalExecutor / ConsolidationAdvisor）ctor 接收的 `EmbeddingSimProvider`
 * （签名 `(a, b) => number | undefined`，**同步**）。
 *
 * 关键边界（与 Core domain/evolution/RecipeSimilarity 的契约一致）：
 *   - domain/service 不发起 embed；本 provider **只读取已预计算的向量**，绝不在
 *     调用路径上触发 embed()。向量来源是 rescan/rebuild 阶段写入 VectorStore 的
 *     `recipe-semantic-region` 记录（id 前缀 `recipe_region_`，metadata.recipeId）。
 *   - provider 函数必须同步：因此在 DI 初始化阶段（容器 initialize 的 awaited 钩子）
 *     一次性 `preheat()` 把所有 region 向量加载进内存 Map，运行时只做同步查表 + 余弦。
 *   - 每条 recipe 可能有多个 regionClass 向量；这里对同一 recipeId 的各 region 向量做
 *     L2 归一化后 **均值池化（mean-pool）**，得到一条代表向量，再对两条代表向量算余弦。
 *     这是确定性的、纯读已算向量的聚合，不引入任何在线 embed。
 *   - 任一侧向量缺失 / 维度不一致 / 非有限数 / 索引不可用 → 返回 `undefined`，让 Core
 *     回退到确定性 Jaccard（永不抛错，永不返回常量）。
 *
 * Core 调用约定（a96c4ee 实测）：三处站点把「带 .id 的 recipe 对象」作为 RecipeLike 传入
 * （RecipeLike 静态类型不含 id，但运行时对象携带 id，例如 RedundancyAnalyzer 用 a.id/b.id）。
 * 因此本 provider 通过结构化读取 `(x as { id?: unknown }).id` 取 recipeId；某侧无 id
 * （如 ConsolidationAdvisor 的 candidateLike、ProposalExecutor 的 #toRecipeLike 投影）→
 * 找不到向量 → 返回 undefined → Jaccard 回退。这是预期内的优雅降级。
 *
 * @module recipe-generation/vector/recipe-embedding-sim-provider
 */

/**
 * Core `EmbeddingSimProvider` 的入参类型 `RecipeLike` 未从 `@alembic/core/evolution`
 * 导出（其定义在 `domain/evolution/RecipeSimilarity`，非导出子路径），所以这里从
 * `RedundancyAnalyzer.ctor` 的 options 结构里结构化派生 provider 函数类型，保证与 Core
 * a96c4ee 的三处消费站点签名逐字一致（结构化兼容，不依赖具名导出）。
 */
import type { RedundancyAnalyzer } from '@alembic/core/evolution';
import { cosineDistance } from '@alembic/core/vector';

/** 从 Core ctor options 派生出的 embedding 相似度注入器类型（同步函数）。 */
export type EmbeddingSimProvider = NonNullable<
  NonNullable<ConstructorParameters<typeof RedundancyAnalyzer>[1]>['embeddingSimProvider']
>;

/** EmbeddingSimProvider 的入参（RecipeLike）——只取我们真正用到的字段（运行时还带 id）。 */
type ProviderRecipeArg = Parameters<EmbeddingSimProvider>[0];

/**
 * provider 读取 region 向量所需的最小 VectorStore 端口：
 * 只用到按 metadata 过滤批量读取（一次性预热）。保持结构化，避免强耦合具体适配器类型。
 */
export interface RegionVectorStorePort {
  searchByFilter(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/** 已构建好的 provider 句柄：`provider` 喂给 Core 三处 ctor；`preheat` 在 DI 初始化时 await 一次。 */
export interface RecipeEmbeddingSimProviderHandle {
  /** 同步 embedding 相似度函数，注入 Core 三处演化服务 ctor。 */
  readonly provider: EmbeddingSimProvider;
  /**
   * 一次性异步预热：把所有 `recipe-semantic-region` 向量加载进内存并按 recipeId 均值池化。
   * 幂等：重复调用只会重新加载并替换内存快照。失败时静默降级（内存为空 → provider 全返回 undefined）。
   * @returns 预热后内存中代表向量的 recipe 条数（便于诊断/测试）。
   */
  preheat(): Promise<number>;
  /** 当前内存中代表向量条数（诊断用）。 */
  readonly size: number;
}

/** VectorStore 中 recipe semantic region 记录的 metadata.type 值（Core 固定）。 */
const RECIPE_SEMANTIC_REGION_METADATA_TYPE = 'recipe-semantic-region';

/**
 * 把任意已加载记录里的 vector 字段安全转成 number[]：要求非空、全有限数；否则返回 null。
 * 不接受空向量（length===0）以免污染池化。
 */
function toFiniteVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const out: number[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return null;
    }
    out[i] = v;
  }
  return out;
}

/** L2 范数。 */
function l2Norm(vec: number[]): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/**
 * 对同一 recipe 的多条 region 向量做「L2 归一化后均值池化」，得到一条代表向量。
 * 维度以首条向量为准；维度不一致的后续向量被跳过（已打 diag），保证池化稳定。
 * 全部被跳过 / 范数为 0 → 返回 null（该 recipe 不进入查表表）。
 */
function meanPoolNormalized(
  vectors: number[][],
  onSkip: (reason: string) => void
): number[] | null {
  if (vectors.length === 0) {
    return null;
  }
  const dim = vectors[0].length;
  const acc = new Array<number>(dim).fill(0);
  let used = 0;
  for (const vec of vectors) {
    if (vec.length !== dim) {
      // region 向量维度应一致（同一 embed 模型）；不一致是异常数据，跳过而非污染池化。
      onSkip(`region-vector dim mismatch: expected ${dim}, got ${vec.length}`);
      continue;
    }
    const norm = l2Norm(vec);
    if (norm === 0 || !Number.isFinite(norm)) {
      onSkip('region-vector zero/non-finite norm');
      continue;
    }
    for (let i = 0; i < dim; i++) {
      acc[i] += vec[i] / norm;
    }
    used++;
  }
  if (used === 0) {
    return null;
  }
  for (let i = 0; i < dim; i++) {
    acc[i] /= used;
  }
  return acc;
}

/** 结构化读取运行时 recipe 对象上的 id（RecipeLike 静态类型不含 id，但运行时携带）。 */
function readRecipeId(arg: ProviderRecipeArg): string | null {
  const id = (arg as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** 最小日志端口（可选）。仅在降级/异常路径打印，便于排查为何回退 Jaccard。 */
export interface SimProviderLogger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface CreateRecipeEmbeddingSimProviderDeps {
  /** region 向量来源（通常是容器里的 `vectorStore`）。为 null/undefined → 工厂返回 null（不注入）。 */
  vectorStore: RegionVectorStorePort | null | undefined;
  /** 可选日志端口。 */
  logger?: SimProviderLogger | null;
}

/**
 * 构建 recipe embedding 相似度 provider。
 *
 * 返回 null 表示「无向量源、不应注入」——调用方据此让 Core 三处 ctor 保持缺省（纯 Jaccard），
 * 行为向后兼容。返回 handle 时：先 `await handle.preheat()`（DI 初始化的 awaited 钩子里），
 * 之后把 `handle.provider` 喂给三处 ctor。
 *
 * provider 函数本身只做同步查表 + 余弦，绝不触发 embed；预热前/向量缺失 → 返回 undefined。
 */
export function createRecipeEmbeddingSimProvider(
  deps: CreateRecipeEmbeddingSimProviderDeps
): RecipeEmbeddingSimProviderHandle | null {
  const { vectorStore, logger } = deps;
  if (!vectorStore || typeof vectorStore.searchByFilter !== 'function') {
    // 无向量源：不注入 provider，Core 走纯 Jaccard（向后兼容）。
    logger?.debug?.('[RecipeEmbeddingSimProvider] no vectorStore — embedding provider not wired');
    return null;
  }

  // recipeId → 代表向量（L2 归一化后均值池化）。仅在 preheat 中整体替换。
  let pooledByRecipeId: Map<string, number[]> = new Map();

  const handle: RecipeEmbeddingSimProviderHandle = {
    provider(a: ProviderRecipeArg, b: ProviderRecipeArg): number | undefined {
      // 同步路径：只查内存表，不触发任何 IO/embed。
      const idA = readRecipeId(a);
      const idB = readRecipeId(b);
      if (idA === null || idB === null) {
        // 某侧不是带 id 的持久化 recipe（如 candidate 投影）→ 无法定位向量 → Jaccard 回退。
        return undefined;
      }
      const vecA = pooledByRecipeId.get(idA);
      const vecB = pooledByRecipeId.get(idB);
      if (vecA === undefined || vecB === undefined) {
        // 任一侧向量缺失（未预热 / 该 recipe 无 region 向量）→ Jaccard 回退。
        return undefined;
      }
      if (vecA.length !== vecB.length) {
        // 维度不一致（理论上不应发生，同模型同维）→ 安全回退，绝不抛错。
        return undefined;
      }
      // 余弦相似度 = 1 - 余弦距离，clamp 到 [0,1]；非有限数 → 回退。
      const distance = cosineDistance(vecA, vecB);
      if (!Number.isFinite(distance)) {
        return undefined;
      }
      const sim = 1 - distance;
      if (!Number.isFinite(sim)) {
        return undefined;
      }
      return Math.max(0, Math.min(1, sim));
    },

    async preheat(): Promise<number> {
      const next = new Map<string, number[]>();
      let records: Record<string, unknown>[];
      try {
        // 一次性按 metadata.type 过滤拉取所有 recipe-semantic-region 记录（含 vector + metadata.recipeId）。
        records = await vectorStore.searchByFilter({
          type: RECIPE_SEMANTIC_REGION_METADATA_TYPE,
        });
      } catch (err: unknown) {
        // 加载失败：保持内存为空 → provider 全返回 undefined → Core 纯 Jaccard。非致命。
        logger?.warn?.(
          '[RecipeEmbeddingSimProvider] preheat searchByFilter failed — falling back to Jaccard',
          { error: err instanceof Error ? err.message : String(err) }
        );
        pooledByRecipeId = next;
        return 0;
      }

      // 先按 recipeId 收集各 region 向量，再均值池化。
      const byRecipe = new Map<string, number[][]>();
      for (const rec of records) {
        const metadata = (rec?.metadata ?? null) as Record<string, unknown> | null;
        const recipeId =
          metadata && typeof metadata.recipeId === 'string' ? metadata.recipeId : null;
        if (recipeId === null || recipeId.length === 0) {
          continue;
        }
        const vec = toFiniteVector((rec as { vector?: unknown }).vector);
        if (vec === null) {
          continue;
        }
        const bucket = byRecipe.get(recipeId);
        if (bucket === undefined) {
          byRecipe.set(recipeId, [vec]);
        } else {
          bucket.push(vec);
        }
      }

      let skipped = 0;
      for (const [recipeId, vectors] of byRecipe) {
        const pooled = meanPoolNormalized(vectors, () => {
          skipped++;
        });
        if (pooled !== null) {
          next.set(recipeId, pooled);
        }
      }

      pooledByRecipeId = next;
      logger?.debug?.('[RecipeEmbeddingSimProvider] preheated region vectors', {
        recipeCount: next.size,
        rawRecords: records.length,
        skippedRegionVectors: skipped,
      });
      return next.size;
    },

    get size(): number {
      return pooledByRecipeId.size;
    },
  };

  return handle;
}
