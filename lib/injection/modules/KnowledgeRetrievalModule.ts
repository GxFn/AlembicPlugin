/** 检索资源装配：搜索、向量存储/代际、索引管线；只注册惰性工厂。 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import { HybridRetriever, SearchEngine } from '@alembic/core/search';
import { isExcludedProject } from '@alembic/core/shared';
import { HnswVectorAdapter, IndexingPipeline, JsonVectorAdapter } from '@alembic/core/vector';
import {
  resolveDataRoot,
  resolveKnowledgeScanDirs,
  resolveProjectRoot,
} from '@alembic/core/workspace';
import {
  createRecipeVectorGenerationRuntime,
  RECIPE_VECTOR_GENERATION_MANAGER_KEY,
  RECIPE_VECTOR_TRUTH_REMOVER_KEY,
} from '../../recipe-pipeline/vector/recipe-vector-generation-runtime.js';
import type { ServiceContainer } from '../ServiceContainer.js';

interface VectorRuntimeRoot {
  dataRoot: string;
  writeZone: WriteZone | undefined;
}

function resolveVectorRuntimeRoot(ct: ServiceContainer): VectorRuntimeRoot {
  const dataRoot = resolveDataRoot(ct);
  const projectRoot = resolveProjectRoot(ct);
  const wz = ct.singletons.writeZone as WriteZone | undefined;
  const sourceRepoExclusion = isExcludedProject(projectRoot);

  if (sourceRepoExclusion.excluded && path.resolve(dataRoot) === path.resolve(projectRoot)) {
    const digest = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
    const redirectedRoot = path.join(tmpdir(), 'alembic-dev', 'vector', digest);
    const logger = ct.singletons.logger || console;
    (logger as { warn?: (...args: unknown[]) => void }).warn?.(
      '[vectorStore] Excluded project detected; redirecting vector runtime away from source repository',
      {
        reason: sourceRepoExclusion.reason,
        redirectedRoot,
      }
    );
    return { dataRoot: redirectedRoot, writeZone: undefined };
  }

  return { dataRoot, writeZone: wz };
}

export function registerKnowledgeRetrieval(c: ServiceContainer) {
  c.singleton('searchEngine', (ct: ServiceContainer) => {
    const vectorService = ct.services.vectorService ? ct.get('vectorService') : null;
    return new SearchEngine(ct.get('database'), {
      // Plugin 不再注入第三方 AI/embedding provider；语义增强走 Alembic resident service，
      // 本地 embedded runtime 保持 baseline/hybrid search 行为。
      aiProvider: null,
      vectorStore: ct.get('vectorStore'),
      vectorService,
      hybridRetriever: ct.get('hybridRetriever'),
      crossEncoderReranker: null,
      signalBus: ct.singletons.signalBus || null,
      knowledgeRepo: ct.get('knowledgeRepository'),
      sourceRefRepo: ct.get('recipeSourceRefRepository'),
    } as unknown as ConstructorParameters<typeof SearchEngine>[1]);
  });

  c.singleton('vectorStore', (ct: ServiceContainer) => {
    const { dataRoot, writeZone } = resolveVectorRuntimeRoot(ct);
    const config =
      ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    const adapter = (config.adapter as string) || 'auto';

    // 根据配置选择适配器
    if (adapter === 'json') {
      const store = new JsonVectorAdapter(dataRoot, { writeZone });
      store.initSync();
      return wrapRecipeVectorGenerationRuntime(ct, dataRoot, writeZone, store);
    }

    if (adapter === 'hnsw' || adapter === 'auto') {
      try {
        const hnsw = (config.hnsw as Record<string, unknown> | undefined) || {};
        const persistence = (config.persistence as Record<string, unknown> | undefined) || {};
        const store = new HnswVectorAdapter(dataRoot, {
          M: hnsw.M as number | undefined,
          efConstruct: hnsw.efConstruct as number | undefined,
          efSearch: hnsw.efSearch as number | undefined,
          quantize: config.quantize as string | undefined,
          quantizeThreshold: config.quantizeThreshold as number | undefined,
          flushIntervalMs: persistence.flushIntervalMs as number | undefined,
          flushBatchSize: persistence.flushBatchSize as number | undefined,
          writeZone,
        });
        store.initSync();
        return wrapRecipeVectorGenerationRuntime(ct, dataRoot, writeZone, store);
      } catch (err: unknown) {
        // HNSW 初始化失败, 降级到 JSON — 记录警告便于排查
        const logger = ct.singletons.logger || console;
        (logger as { warn?: (...args: unknown[]) => void }).warn?.(
          '[vectorStore] HNSW init failed, falling back to JsonVectorAdapter',
          {
            error: (err as Error).message,
            adapter,
          }
        );
        const store = new JsonVectorAdapter(dataRoot, { writeZone });
        store.initSync();
        return wrapRecipeVectorGenerationRuntime(ct, dataRoot, writeZone, store);
      }
    }

    // 未知适配器, 默认 JSON
    const store = new JsonVectorAdapter(dataRoot, { writeZone });
    store.initSync();
    return wrapRecipeVectorGenerationRuntime(ct, dataRoot, writeZone, store);
  });

  c.singleton('indexingPipeline', (ct: ServiceContainer) => {
    const { dataRoot } = resolveVectorRuntimeRoot(ct);
    return new IndexingPipeline({
      projectRoot: dataRoot,
      scanDirs: resolveKnowledgeScanDirs(ct),
      vectorStore: ct.get('vectorStore'),
    } as ConstructorParameters<typeof IndexingPipeline>[0]);
  });

  c.singleton('hybridRetriever', (ct: ServiceContainer) => {
    const config = (ct.singletons._config as Record<string, unknown> | undefined)?.vector as
      | Record<string, unknown>
      | undefined;
    const hybrid = (config?.hybrid as Record<string, unknown> | undefined) || {};
    return new HybridRetriever({
      vectorStore: ct.get('vectorStore'),
      rrfK: (hybrid.rrfK as number) || 60,
      alpha: (hybrid.alpha as number) || 0.5,
    } as ConstructorParameters<typeof HybridRetriever>[0]);
  });
}

function wrapRecipeVectorGenerationRuntime(
  container: ServiceContainer,
  dataRoot: string,
  writeZone: WriteZone | undefined,
  baseStore: InstanceType<typeof JsonVectorAdapter> | InstanceType<typeof HnswVectorAdapter>
) {
  const runtime = createRecipeVectorGenerationRuntime({
    baseStore,
    dataRoot,
    ...(writeZone ? { writeZone } : {}),
  });
  (container.singletons as Record<string, unknown>)[RECIPE_VECTOR_GENERATION_MANAGER_KEY] =
    runtime.generationManager;
  (container.singletons as Record<string, unknown>)[RECIPE_VECTOR_TRUTH_REMOVER_KEY] =
    runtime.recipeVectorTruthRemover;
  return runtime.vectorStore;
}
