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

import Logger from '@alembic/core/logging';
import type { EmbedLaneSelection, FetchLike } from '@alembic/core/vector';
import { VectorService } from '@alembic/core/vector';
import type { ContextualEnricher } from '#recipe-pipeline/vector/ContextualEnricher.js';
import {
  resolveLocalEmbeddingConfig,
  selectLocalEmbedLane,
} from '#recipe-pipeline/vector/LocalEmbedding.js';
import {
  RECIPE_VECTOR_GENERATION_MANAGER_KEY,
  RECIPE_VECTOR_TRUTH_REMOVER_KEY,
} from '#recipe-pipeline/vector/recipe-vector-generation-runtime.js';
import type { ServiceContainer } from '../ServiceContainer.js';

// GMAP-L3: the singleton key holding the local-first embed-lane selection. It is
// populated by prepareLocalEmbedProvider() (async probe) before the vectorService
// factory first runs, so the sync factory can read the selected provider.
const LOCAL_EMBED_SELECTION_KEY = '_localEmbedSelection';

interface VectorModuleLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/**
 * 解析本模块日志端口。
 *
 * MCP stdio 模式下 stdout 是 JSON-RPC 协议通道：绝不能回退到 `console`（console.info/log
 * 写 stdout，会把非 JSON 行混进协议流）。singletons.logger 仅作为显式注入的测试/宿主接缝；
 * 未注入时（生产路径，lib 内从不赋值）统一走 Core Logger —— MCP 模式下它不挂 Console
 * transport，非 MCP 模式下 Console transport 的所有级别都走 stderr。
 *
 * MCP 模式下宿主只能通过 server stderr 看到诊断，因此 warn/error 在 Core Logger 之外再
 * 镜像一行到 process.stderr（info 只留在 Core Logger，避免噪音）；Core Logger 已挂 Console
 * transport 时不镜像，避免同一条警告在 stderr 出现两次。
 */
function resolveVectorModuleLogger(c: ServiceContainer): VectorModuleLogger {
  const injected = c.singletons.logger as VectorModuleLogger | undefined;
  if (injected) {
    return injected;
  }
  const core = Logger.getInstance();
  return {
    info: (...args: unknown[]) => {
      (core.info as (...a: unknown[]) => unknown)(...args);
    },
    warn: (...args: unknown[]) => {
      (core.warn as (...a: unknown[]) => unknown)(...args);
      mirrorToStderr(core, 'warn', args);
    },
    error: (...args: unknown[]) => {
      (core.error as (...a: unknown[]) => unknown)(...args);
      mirrorToStderr(core, 'error', args);
    },
  };
}

/** 把 warn/error 以单行文本写到 stderr（绝不写 stdout）；已有 Console transport 时跳过。 */
function mirrorToStderr(
  core: ReturnType<typeof Logger.getInstance>,
  level: 'warn' | 'error',
  args: unknown[]
): void {
  // winston Console transport 运行时带 name='console'，但 TransportStream 类型未声明 name。
  const hasConsoleTransport = core.transports.some(
    (transport) => (transport as { name?: unknown }).name === 'console'
  );
  if (hasConsoleTransport) {
    return;
  }
  const text = args
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch (err: unknown) {
        // meta 无法序列化（循环引用等）时退回 String()，保证警告本身仍能输出。
        return `${String(arg)} (unserializable: ${err instanceof Error ? err.message : String(err)})`;
      }
    })
    .join(' ');
  try {
    process.stderr.write(`[alembic] ${level.toUpperCase()} ${text}\n`);
  } catch (err: unknown) {
    // stderr 已关闭（宿主断开）时无处可写；原始警告已进 Core Logger，这里只补一条 debug 诊断。
    core.debug(
      `[VectorModule] stderr mirror skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function selectedEmbedProvider(c: ServiceContainer): EmbedLaneSelection['provider'] {
  const selection = (c.singletons as Record<string, unknown>)[LOCAL_EMBED_SELECTION_KEY] as
    | EmbedLaneSelection
    | undefined;
  return selection?.provider ?? null;
}

export function register(c: ServiceContainer) {
  // ═══ ContextualEnricher（增强由 Codex host agent / Alembic resident service 托管）═══
  c.singleton('contextualEnricher', (_ct: ServiceContainer) => null);

  // ═══ VectorService ═══
  c.singleton('vectorService', (ct: ServiceContainer) => {
    const config =
      ((ct.singletons._config as Record<string, unknown> | undefined)?.vector as
        | Record<string, unknown>
        | undefined) || {};

    const vectorStore = ct.get('vectorStore');
    return new VectorService({
      vectorStore,
      indexingPipeline: ct.get('indexingPipeline'),
      hybridRetriever: ct.services.hybridRetriever
        ? (ct.get('hybridRetriever') as ConstructorParameters<
            typeof VectorService
          >[0]['hybridRetriever'])
        : null,
      eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
      // GMAP-L3: local-first embed provider selected by prepareLocalEmbedProvider()
      // (local Ollama → keyword baseline). null = keyword baseline (vectors disabled),
      // the clean degrade when Ollama is absent or localEmbedding is disabled.
      embedProvider: selectedEmbedProvider(ct),
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
      recipeGenerationManager: (ct.singletons as Record<string, unknown>)[
        RECIPE_VECTOR_GENERATION_MANAGER_KEY
      ] as ConstructorParameters<typeof VectorService>[0]['recipeGenerationManager'] | undefined,
      // 终态 identity 来自 Core lifecycle 事件；Plugin 只实现 base + 全 generation
      // 的物理删除，不能再从 active reader 或 entry_* 兼容删除推断终态意图。
      recipeVectorTruthRemover: (ct.singletons as Record<string, unknown>)[
        RECIPE_VECTOR_TRUTH_REMOVER_KEY
      ] as ConstructorParameters<typeof VectorService>[0]['recipeVectorTruthRemover'] | undefined,
    });
  });
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
    // GMAP-L3: select the local-first embed provider BEFORE the vectorService factory
    // first runs, so the (sync) factory injects the chosen provider.
    await prepareLocalEmbedProvider(c);
    try {
      const vectorService = c.get('vectorService') as InstanceType<typeof VectorService>;
      await vectorService.initialize();
    } catch (err: unknown) {
      resolveVectorModuleLogger(c).warn?.(
        '[VectorModule] VectorService initialization failed (non-blocking)',
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  // U5 #1 closeout：在向量索引初始化完成后，一次性预热 embedding 相似度 provider
  // （把已预计算的 recipe-semantic-region 向量加载进内存并按 recipeId 均值池化）。
  // provider 函数本身同步；预热在此 awaited 钩子里完成，保证三处演化服务运行时可同步查表。
  // 句柄为 null（无 vectorStore）→ 跳过；预热失败 → 内存为空 → Core 回退纯 Jaccard（非致命）。
  try {
    const embeddingSimProvider = c.services.embeddingSimProvider
      ? c.get('embeddingSimProvider')
      : null;
    if (embeddingSimProvider) {
      await embeddingSimProvider.preheat();
    }
  } catch (err: unknown) {
    resolveVectorModuleLogger(c).warn?.(
      '[VectorModule] embedding-sim provider preheat failed (non-blocking, Jaccard fallback)',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}

/**
 * GMAP-L3: resolve localEmbedding config (config.json + host env) and select the
 * local-first embed lane (local Ollama → keyword baseline) via the Core selector.
 * Stores the selection so the vectorService factory injects it. Never throws — an
 * absent/disabled Ollama cleanly degrades to the keyword baseline with honest logs.
 * The actual index rebuild with the selected provider is GMAP-L4/L5 (controller).
 */
export async function prepareLocalEmbedProvider(
  c: ServiceContainer,
  opts: { fetchImpl?: FetchLike } = {}
): Promise<void> {
  const vectorConfig = (c.singletons._config as Record<string, unknown> | undefined)?.vector;
  const localConfig = resolveLocalEmbeddingConfig(vectorConfig);
  // 不得回退 console：该函数在 MCP 容器初始化期间运行，console.info 会污染 stdout 协议通道。
  const logger = resolveVectorModuleLogger(c);
  const singletons = c.singletons as Record<string, unknown>;

  if (!localConfig.enabled) {
    singletons[LOCAL_EMBED_SELECTION_KEY] = undefined;
    logger.info?.('[VectorModule] local embedding disabled; using keyword baseline search.');
    return;
  }

  try {
    const selection = await selectLocalEmbedLane(localConfig, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    singletons[LOCAL_EMBED_SELECTION_KEY] = selection;
    if (selection.provider) {
      logger.info?.(
        `[VectorModule] local embedding lane=${selection.lane} (Ollama ${localConfig.model} @ ${localConfig.endpoint}).`
      );
    } else {
      const ollamaReason = selection.diagnostics.find((d) => d.name === 'ollama')?.reason;
      logger.warn?.(
        `[VectorModule] local embedding enabled but Ollama unavailable (${ollamaReason ?? 'unknown'}); falling back to keyword baseline.`
      );
    }
  } catch (err: unknown) {
    singletons[LOCAL_EMBED_SELECTION_KEY] = undefined;
    logger.warn?.(
      '[VectorModule] local embedding selection failed (non-blocking); using keyword baseline.',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}
