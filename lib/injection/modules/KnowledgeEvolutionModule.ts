/** 知识演化装配：引用维护、生命周期、提案与生产入口；仓储由 Infra 提供。 */
// readFileAtCommit 走 ROOT 门面(@alembic/core):Core 侧 ./shared 门面冻结在
// shrink-only 预算 192,G-C P3 新增符号按 SD-5 B2=re-point 先例经根门面导出。
import { readFileAtCommit } from '@alembic/core';
import {
  ConsolidationAdvisor,
  ContentPatcher,
  DecayDetector,
  EnhancementSuggester,
  LifecycleStateMachine,
  ProposalExecutor,
  ProposalGateway,
  RedundancyAnalyzer,
  StagingManager,
} from '@alembic/core/evolution';
import {
  RecipeFreshnessService,
  RecipeProductionGateway,
  SourceRefReconciler,
} from '@alembic/core/knowledge';
import { findSimilarRecipes } from '@alembic/core/service/candidate';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import {
  createRecipeEmbeddingSimProvider,
  type EmbeddingSimProvider,
  type SimProviderLogger,
} from '../../recipe-pipeline/vector/recipe-embedding-sim-provider.js';
import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * 解析共享的 embedding 相似度 provider 函数，喂给三处演化服务 ctor。
 * 句柄为 null（无 vectorStore）→ 返回 undefined → Core ctor 保持缺省（纯 Jaccard）。
 */
function resolveEmbeddingSimProvider(ct: ServiceContainer): EmbeddingSimProvider | undefined {
  const handle = ct.get('embeddingSimProvider');
  return handle?.provider;
}

export function registerKnowledgeEvolution(c: ServiceContainer) {
  registerEvolutionAnalysisServices(c);
  registerEvolutionWorkflowServices(c);
  registerRecipeProductionServices(c);
}

function registerEvolutionAnalysisServices(c: ServiceContainer) {
  c.singleton('sourceRefReconciler', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    const sourceRefRepo = ct.get('recipeSourceRefRepository');
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new SourceRefReconciler(projectRoot, sourceRefRepo, knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      // P3 observe-only 漂移精判:git 历史读取器,绑定本容器 projectRoot 的 git 仓。
      // 多 folder ProjectScope 下 sourcePath 属其他 folder 仓时 git show 取不到 → null →
      // 精判保守跳过(不误判);基线 commit 由 rescan 侧从 checkpoint 传入,缺则不精判。
      gitReader: (commit, relPath) => readFileAtCommit(projectRoot, commit, relPath),
    });
  });

  c.singleton('recipeFreshnessService', (ct: ServiceContainer) => {
    return new RecipeFreshnessService({
      sourceRefReconciler: ct.get('sourceRefReconciler'),
      sourceRefRepository: ct.get('recipeSourceRefRepository'),
      vectorService: ct.services.vectorService ? ct.get('vectorService') : null,
    });
  });

  c.singleton('stagingManager', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const lifecycle = ct.get('lifecycleStateMachine');
    return new StagingManager(knowledgeRepo, {
      fileStore: ct.get('knowledgeFileWriter'),
      lifecycle,
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
    });
  });

  c.singleton('decayDetector', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new DecayDetector(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      knowledgeEdgeRepo: ct.services.knowledgeEdgeRepository
        ? ct.get('knowledgeEdgeRepository')
        : undefined,
      sourceRefRepo: ct.services.recipeSourceRefRepository
        ? ct.get('recipeSourceRefRepository')
        : undefined,
      // U4 消费侧 d2：注入 lifecycleStateMachine，使 staging sweep 第4 driver 调 scanAll(cap) 时，
      // 命中的 active recipe 经 Core DecayDetector 内部直走 transition(trigger='decay-detection')→decaying
      // 并记 lifecycle_transition_events（B1：不依赖信号订阅）。lifecycleStateMachine 单例 factory 不反向
      // 依赖 decayDetector，无循环依赖；缺省（不注入）时 Core 仅打分不迁移（向后兼容）。
      lifecycleStateMachine: ct.get('lifecycleStateMachine'),
    });
  });

  // U5 #1 closeout：构建一次 VectorService-backed embedding 相似度 provider 句柄，
  // 三处演化服务（RedundancyAnalyzer / ProposalExecutor / ConsolidationAdvisor）共用同一实例。
  // 无 vectorStore → 句柄为 null → 三处保持缺省（Core 纯 Jaccard，向后兼容）。
  // 预热（一次性加载预计算 region 向量）由 VectorModule.initializeVectorService 完成，
  // provider 函数本身保持同步。
  c.singleton('embeddingSimProvider', (ct: ServiceContainer) => {
    const vectorStore = ct.services.vectorStore ? ct.get('vectorStore') : null;
    return createRecipeEmbeddingSimProvider({
      vectorStore,
      logger: (ct.singletons.logger as SimProviderLogger | undefined) ?? null,
    });
  });

  c.singleton('redundancyAnalyzer', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new RedundancyAnalyzer(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      embeddingSimProvider: resolveEmbeddingSimProvider(ct),
    });
  });

  c.singleton('enhancementSuggester', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new EnhancementSuggester(knowledgeRepo, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
    });
  });

  c.singleton('contentPatcher', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const sourceRefRepo = ct.get('recipeSourceRefRepository');
    // P-B(2026-07-11 落锚 parity):注入 projectRoot,update 提案执行后 refs
    // 立即带 region 指纹落锚(此前重建 refs 全 NULL fp,漂移检测对刚更新的
    // 知识失明直到下次 reconcile)。
    return new ContentPatcher(knowledgeRepo, sourceRefRepo, {
      projectRoot: resolveProjectRoot(ct),
      fileStore: ct.get('knowledgeFileWriter'),
    });
  });
}

function registerEvolutionWorkflowServices(c: ServiceContainer) {
  c.singleton('lifecycleStateMachine', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const lifecycleEventRepo = ct.get('lifecycleEventRepository');
    const signalBus = ct.get('signalBus');
    const proposalRepo = ct.get('proposalRepository');
    // 进化与人工知识写入共用 Markdown 真相源，后续 sync 不得回滚状态。
    return new LifecycleStateMachine(
      knowledgeRepo,
      lifecycleEventRepo,
      signalBus,
      proposalRepo,
      undefined,
      {
        fileStore: ct.get('knowledgeFileWriter'),
      }
    );
  });

  c.singleton('proposalExecutor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const proposalRepo = ct.get('proposalRepository');
    const lifecycle = ct.get('lifecycleStateMachine');
    const contentPatcher = ct.get('contentPatcher');
    const edgeRepo = ct.get('knowledgeEdgeRepository');
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
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new ConsolidationAdvisor(knowledgeRepo, resolveEmbeddingSimProvider(ct));
  });

  c.singleton('proposalGateway', (ct: ServiceContainer) => {
    const proposalRepo = ct.get('proposalRepository');
    const lifecycle = ct.get('lifecycleStateMachine');
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new ProposalGateway(proposalRepo, lifecycle, knowledgeRepo);
  });
}

function registerRecipeProductionServices(c: ServiceContainer) {
  c.singleton('recipeProductionGateway', (ct: ServiceContainer) => {
    const knowledgeService = ct.get('knowledgeService');
    const dataRoot = resolveDataRoot(ct) as string;
    let consolidationAdvisor = null;
    let proposalRepository = null;
    let proposalGateway = null;
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
      proposalGateway = ct.get('proposalGateway');
    } catch {
      /* optional */
    }
    // U1 #5：此处是同步 DI singleton 工厂，无法 await moduleService.load() 取 canonical 模块轴
    // （强行同步扫 ProjectContext 不符合 DI 工厂语义）。故本入口不注入 knownModuleNames /
    // resolveModuleFromSourceRefs，Core #deriveModuleName 退回原 passthrough（加性、向后兼容）。
    // 需要 canonical 模块轴的 submit 链路走 tool-router 的 async createSubmitKnowledgeGateway，
    // 在那里按 canonical ProjectMap.modules 注入这两个 dep。
    return new RecipeProductionGateway({
      knowledgeService,
      projectRoot: dataRoot,
      consolidationAdvisor: consolidationAdvisor as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['consolidationAdvisor'],
      proposalRepository: proposalRepository as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalRepository'],
      proposalGateway: proposalGateway as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalGateway'],
      findSimilarRecipes,
    });
  });
}
