/**
 * VectorModule — 向量服务 DI 注册
 *
 * 注册:
 *   - vectorService: 统一向量服务层
 *   - contextualEnricher: 插件模式下禁用的上下文增强边界
 *
 * 依赖 KnowledgeModule 先注册: vectorStore, indexingPipeline, hybridRetriever
 * 依赖 InfraModule 先注册: eventBus, database
 */

import { VectorService } from '@alembic/core/vector';
import type { ContextualEnricher } from '../../service/vector/ContextualEnricher.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ ContextualEnricher (host-managed; local AI enrichment disabled) ═══
  c.singleton('contextualEnricher', (_ct: ServiceContainer) => null);

  // ═══ VectorService ═══
  c.singleton(
    'vectorService',
    (ct: ServiceContainer) => {
      const config =
        ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
          | Record<string, unknown>
          | undefined) || {};

      return new VectorService({
        vectorStore: ct.get('vectorStore'),
        indexingPipeline: ct.get('indexingPipeline'),
        hybridRetriever: ct.services.hybridRetriever
          ? (ct.get('hybridRetriever') as ConstructorParameters<
              typeof VectorService
            >[0]['hybridRetriever'])
          : null,
        eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
        // Plugin 不维护可执行 embedding provider。Resident vector search 由 Alembic daemon
        // HTTP API 增强；embedded runtime 只保留可降级的 baseline/vector store 管线。
        embedProvider: null,
        contextualEnricher: ct.services.contextualEnricher
          ? (ct.get('contextualEnricher') as InstanceType<typeof ContextualEnricher> | null)
          : null,
        autoSyncOnCrud: (config.autoSyncOnCrud as boolean) !== false,
        syncDebounceMs: (config.syncDebounceMs as number) || 2000,
        drizzle: ct.services.database
          ? ((ct.get('database') as unknown as { getDrizzle?(): unknown }).getDrizzle?.() as
              | import('@alembic/core/database').DrizzleDB
              | undefined)
          : undefined,
      });
    }
  );
}

/**
 * 初始化 VectorService（在容器初始化后调用）
 * 用于绑定 EventBus 监听等异步初始化操作，同时将 ContextualEnricher 注入 IndexingPipeline
 */
export async function initializeVectorService(c: ServiceContainer): Promise<void> {
  // 将 ContextualEnricher 注入 IndexingPipeline（如果可用）
  if (c.services.contextualEnricher && c.services.indexingPipeline) {
    const config =
      ((c.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};
    if (config.contextualEnrich) {
      const enricher = c.get('contextualEnricher') as InstanceType<
        typeof ContextualEnricher
      > | null;
      if (enricher) {
        const pipeline = c.get('indexingPipeline') as {
          setContextualEnricher?: (e: unknown) => void;
        };
        pipeline.setContextualEnricher?.(enricher);
      }
    }
  }

  if (c.services.vectorService) {
    try {
      const vectorService = c.get('vectorService') as InstanceType<typeof VectorService>;
      await vectorService.initialize();
    } catch (err: unknown) {
      const logger = c.singletons.logger || console;
      (logger as { warn?: (...args: unknown[]) => void }).warn?.(
        '[VectorModule] VectorService initialization failed (non-blocking)',
        { error: (err as Error).message }
      );
    }
  }
}
