/**
 * KnowledgeModule — 知识 + 搜索 + 向量服务注册
 *
 * 负责注册:
 *   - knowledgeService, knowledgeGraphService, confidenceRouter
 *   - searchEngine, vectorStore, indexingPipeline
 *   - discovererRegistry, enhancementRegistry, languageService, dimensionCopy
 *   - projectGraph
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DimensionCopy } from '@alembic/core/dimensions';
import { getFrameworkEnhancements as getEnhancementRegistry } from '@alembic/core/enhancement';
import {
  ConsolidationAdvisor,
  ContentPatcher,
  DecayDetector,
  EnhancementSuggester,
  EvolutionGateway,
  LifecycleStateMachine,
  ProposalExecutor,
  RedundancyAnalyzer,
  StagingManager,
} from '@alembic/core/evolution';
import type { WriteZone } from '@alembic/core/io';
import {
  ConfidenceRouter,
  KnowledgeGraphService,
  KnowledgeService,
  RecipeFreshnessService,
  RecipeProductionGateway,
  SourceRefReconciler,
} from '@alembic/core/knowledge';
import type {
  EvolutionLifecycleEventRepository,
  EvolutionProposalRepository,
  KnowledgeEdgeRepository,
  KnowledgeRepository,
  SourceRefRepository,
} from '@alembic/core/repositories';
import { HybridRetriever, SearchEngine } from '@alembic/core/search';
import { findSimilarRecipes } from '@alembic/core/service/candidate';
import { isExcludedProject, LanguageService } from '@alembic/core/shared';
import { HnswVectorAdapter, IndexingPipeline, JsonVectorAdapter } from '@alembic/core/vector';
import {
  resolveDataRoot,
  resolveKnowledgeScanDirs,
  resolveProjectRoot,
} from '@alembic/core/workspace';
import {
  createRecipeEmbeddingSimProvider,
  type EmbeddingSimProvider,
  type RecipeEmbeddingSimProviderHandle,
  type RegionVectorStorePort,
  type SimProviderLogger,
} from '../../recipe-generation/vector/recipe-embedding-sim-provider.js';
import { refreshRecipeFreshnessByIds } from '../../service/knowledge/RecipeFreshnessRuntime.js';
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

export function register(c: ServiceContainer) {
  registerKnowledgeServices(c);
  registerSearchServices(c);
  registerSharedServices(c);
  registerEvolutionServices(c);
}

/**
 * 解析共享的 embedding 相似度 provider 函数，喂给三处演化服务 ctor。
 * 句柄为 null（无 vectorStore）→ 返回 undefined → Core ctor 保持缺省（纯 Jaccard）。
 */
function resolveEmbeddingSimProvider(ct: ServiceContainer): EmbeddingSimProvider | undefined {
  const handle = ct.get('embeddingSimProvider') as RecipeEmbeddingSimProviderHandle | null;
  return handle?.provider;
}

function registerKnowledgeServices(c: ServiceContainer) {
  c.singleton(
    'confidenceRouter',
    (ct: ServiceContainer) =>
      new ConfidenceRouter(
        {},
        ct.get('qualityScorer') as ConstructorParameters<typeof ConfidenceRouter>[1]
      )
  );

  c.singleton(
    'knowledgeService',
    (ct: ServiceContainer) =>
      new KnowledgeService(
        ct.get('knowledgeRepository') as ConstructorParameters<typeof KnowledgeService>[0],
        ct.get('auditLogger') as ConstructorParameters<typeof KnowledgeService>[1],
        // PDR-3: governance Gateway deleted (dead daemon path). KnowledgeService stores but
        // never reads this ctor arg, so pass null instead of a removed 'gateway' singleton.
        null,
        ct.get('knowledgeGraphService') as ConstructorParameters<typeof KnowledgeService>[3],
        {
          fileWriter: ct.get('knowledgeFileWriter'),
          skillHooks: ct.get('skillHooks'),
          confidenceRouter: ct.get('confidenceRouter'),
          qualityScorer: ct.get('qualityScorer'),
          eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
          edgeRepo: ct.get('knowledgeEdgeRepository'),
          proposalRepo: ct.get('proposalRepository'),
        } as ConstructorParameters<typeof KnowledgeService>[4]
      )
  );

  c.singleton(
    'knowledgeGraphService',
    (ct: ServiceContainer) =>
      new KnowledgeGraphService(
        ct.get('knowledgeEdgeRepository') as ConstructorParameters<typeof KnowledgeGraphService>[0]
      )
  );
}

function registerSearchServices(c: ServiceContainer) {
  c.singleton('searchEngine', (ct: ServiceContainer) => {
    const vectorService = ct.services.vectorService ? ct.get('vectorService') : null;
    return new SearchEngine(
      ct.get('database') as unknown as ConstructorParameters<typeof SearchEngine>[0],
      {
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
      } as unknown as ConstructorParameters<typeof SearchEngine>[1]
    );
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
      return store;
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
        return store;
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
        return store;
      }
    }

    // 未知适配器, 默认 JSON
    const store = new JsonVectorAdapter(dataRoot, { writeZone });
    store.initSync();
    return store;
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

function registerSharedServices(c: ServiceContainer) {
  c.register('enhancementRegistry', () => getEnhancementRegistry());
  c.register('languageService', () => LanguageService);
  c.register('dimensionCopy', () => DimensionCopy);
  c.register('projectGraph', () => c.singletons.projectGraph || null);
}

function registerEvolutionServices(c: ServiceContainer) {
  registerEvolutionAnalysisServices(c);
  registerEvolutionWorkflowServices(c);
  registerRecipeProductionServices(c);
}

function registerEvolutionAnalysisServices(c: ServiceContainer) {
  c.singleton('sourceRefReconciler', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as SourceRefRepository;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new SourceRefReconciler(projectRoot, sourceRefRepo, knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
    });
  });

  c.singleton('recipeFreshnessService', (ct: ServiceContainer) => {
    return new RecipeFreshnessService({
      sourceRefReconciler: ct.get('sourceRefReconciler') as ConstructorParameters<
        typeof RecipeFreshnessService
      >[0]['sourceRefReconciler'],
      sourceRefRepository: ct.get('recipeSourceRefRepository') as ConstructorParameters<
        typeof RecipeFreshnessService
      >[0]['sourceRefRepository'],
      vectorService: ct.services.vectorService
        ? (ct.get('vectorService') as ConstructorParameters<
            typeof RecipeFreshnessService
          >[0]['vectorService'])
        : null,
    });
  });

  c.singleton('stagingManager', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    return new StagingManager(knowledgeRepo, {
      lifecycle,
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
    });
  });

  c.singleton('decayDetector', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new DecayDetector(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      knowledgeEdgeRepo: ct.services.knowledgeEdgeRepository
        ? (ct.get('knowledgeEdgeRepository') as KnowledgeEdgeRepository)
        : undefined,
      sourceRefRepo: ct.services.recipeSourceRefRepository
        ? (ct.get('recipeSourceRefRepository') as SourceRefRepository)
        : undefined,
    });
  });

  // U5 #1 closeout：构建一次 VectorService-backed embedding 相似度 provider 句柄，
  // 三处演化服务（RedundancyAnalyzer / ProposalExecutor / ConsolidationAdvisor）共用同一实例。
  // 无 vectorStore → 句柄为 null → 三处保持缺省（Core 纯 Jaccard，向后兼容）。
  // 预热（一次性加载预计算 region 向量）在 initializeKnowledgeServices 的 await 钩子里完成，
  // provider 函数本身保持同步。
  c.singleton('embeddingSimProvider', (ct: ServiceContainer) => {
    const vectorStore = ct.services.vectorStore
      ? (ct.get('vectorStore') as unknown as RegionVectorStorePort)
      : null;
    return createRecipeEmbeddingSimProvider({
      vectorStore,
      logger: (ct.singletons.logger as SimProviderLogger | undefined) ?? null,
    });
  });

  c.singleton('redundancyAnalyzer', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new RedundancyAnalyzer(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      embeddingSimProvider: resolveEmbeddingSimProvider(ct),
    });
  });

  c.singleton('enhancementSuggester', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new EnhancementSuggester(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
    });
  });

  c.singleton('contentPatcher', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const sourceRefRepo = ct.get('recipeSourceRefRepository') as SourceRefRepository;
    return new ContentPatcher(knowledgeRepo, sourceRefRepo);
  });
}

function registerEvolutionWorkflowServices(c: ServiceContainer) {
  c.singleton('lifecycleStateMachine', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const lifecycleEventRepo = ct.get(
      'lifecycleEventRepository'
    ) as EvolutionLifecycleEventRepository;
    const signalBus = ct.get('signalBus') as import('@alembic/core/events').SignalBus;
    const proposalRepo = ct.get('proposalRepository') as EvolutionProposalRepository;
    return new LifecycleStateMachine(knowledgeRepo, lifecycleEventRepo, signalBus, proposalRepo);
  });

  c.singleton('proposalExecutor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    const proposalRepo = ct.get('proposalRepository') as EvolutionProposalRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    const contentPatcher = ct.get('contentPatcher') as ContentPatcher;
    const edgeRepo = ct.get('knowledgeEdgeRepository') as KnowledgeEdgeRepository;
    return new ProposalExecutor(
      knowledgeRepo,
      proposalRepo,
      lifecycle,
      contentPatcher,
      edgeRepo,
      resolveEmbeddingSimProvider(ct)
    );
  });

  c.singleton('consolidationAdvisor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new ConsolidationAdvisor(knowledgeRepo, resolveEmbeddingSimProvider(ct));
  });

  c.singleton('evolutionGateway', (ct: ServiceContainer) => {
    const proposalRepo = ct.get('proposalRepository') as EvolutionProposalRepository;
    const lifecycle = ct.get('lifecycleStateMachine') as LifecycleStateMachine;
    const knowledgeRepo = ct.get('knowledgeRepository') as KnowledgeRepository;
    return new EvolutionGateway(proposalRepo, lifecycle, knowledgeRepo);
  });
}

function registerRecipeProductionServices(c: ServiceContainer) {
  c.singleton('recipeProductionGateway', (ct: ServiceContainer) => {
    const knowledgeService = ct.get('knowledgeService');
    const dataRoot = resolveDataRoot(ct) as string;
    let consolidationAdvisor = null;
    let proposalRepository = null;
    let evolutionGateway = null;
    try {
      consolidationAdvisor = ct.get('consolidationAdvisor');
    } catch {
      /* optional */
    }
    try {
      proposalRepository = ct.get('proposalRepository');
    } catch {
      /* optional */
    }
    try {
      evolutionGateway = ct.get('evolutionGateway');
    } catch {
      /* optional */
    }
    // U1 #5：此处是同步 DI singleton 工厂，无法 await moduleService.load() 取 canonical 模块轴
    // （强行同步扫 ProjectContext 不符合 DI 工厂语义）。故本入口不注入 knownModuleNames /
    // resolveModuleFromSourceRefs，Core #deriveModuleName 退回原 passthrough（加性、向后兼容）。
    // 需要 canonical 模块轴的 submit 链路走 tool-router 的 async createSubmitKnowledgeGateway，
    // 在那里按 canonical ProjectMap.modules 注入这两个 dep。
    return new RecipeProductionGateway({
      knowledgeService: knowledgeService as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['knowledgeService'],
      projectRoot: dataRoot,
      consolidationAdvisor: consolidationAdvisor as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['consolidationAdvisor'],
      proposalRepository: proposalRepository as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalRepository'],
      evolutionGateway: evolutionGateway as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['evolutionGateway'],
      findSimilarRecipes,
    });
  });
}

/**
 * 初始化知识服务（在容器初始化后调用）
 * 绑定 EventBus → SearchEngine.refreshIndex() + recipe_source_refs 填充
 */
export function initializeKnowledgeServices(c: ServiceContainer): void {
  // 轨①（P3 daemon-less 自动化）：init 一次性接通 proposal 执行的信号驱动。best-effort：
  // proposalExecutor/signalBus 不可取时跳过（非致命）；subscribeToSignals 在 Core 侧已幂等
  // （if(#unsubscribe)return），重复 init 不放大订阅。接通后真实信号（FileChangeHandler 的
  // quality/source_modified 等）即时驱动 observing proposal 执行；sweep 有界兜底见 staging-access-sweep。
  // 放在 eventBus 早 return 之前：proposal 信号订阅不应依赖 eventBus/searchEngine 是否就绪。
  try {
    const proposalExecutor = c.get('proposalExecutor') as ProposalExecutor | null;
    const signalBus = c.get('signalBus') as import('@alembic/core/events').SignalBus | null;
    if (proposalExecutor && signalBus) {
      proposalExecutor.subscribeToSignals(signalBus);
    }
  } catch {
    /* proposalExecutor/signalBus not available — skip proposal signal subscription */
  }

  if (!c.services.eventBus || !c.services.searchEngine) {
    return;
  }

  try {
    const { EventBus } = await_import_EventBus();
    const eventBus = c.get('eventBus') as InstanceType<typeof EventBus>;
    const searchEngine = c.get('searchEngine') as {
      refreshIndex: (opts?: { force?: boolean }) => void;
    };

    // Bug 修复: keyword 索引与 Vector 索引一致性 — 将 knowledge:changed 事件绑定到 refreshIndex
    eventBus.on('knowledge:changed', () => {
      try {
        searchEngine.refreshIndex();
      } catch {
        /* refreshIndex failure is non-fatal */
      }
    });

    // Best-effort post-create freshness: Core owns source_ref reconciliation and vector sync.
    eventBus.on('knowledge:changed', (data: unknown) => {
      try {
        const d = data as { action?: string; entryId?: string };
        if (d.action === 'create' && d.entryId) {
          void _refreshFreshnessForEntry(c, d.entryId);
        }
      } catch {
        /* freshness refresh failure is non-fatal */
      }
    });
  } catch {
    /* EventBus/SearchEngine not available — skip binding */
  }
}

/** EventBus 延迟引用（避免循环依赖） */
function await_import_EventBus() {
  // EventBus 类型已经通过 container 解析，此处只用于 TS 类型
  return {
    EventBus: Object as unknown as typeof import('@alembic/core/events').EventBus,
  };
}

async function _refreshFreshnessForEntry(c: ServiceContainer, entryId: string): Promise<void> {
  try {
    await refreshRecipeFreshnessByIds(c, [entryId]);
  } catch {
    /* repos/services may not be registered yet */
  }
}
