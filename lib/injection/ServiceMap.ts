/**
 * ServiceMap — DI 容器类型安全映射
 *
 * 将服务名（字符串 key）映射到具体类型，实现编译期类型检查。
 * 使用方式：`container.get('searchEngine')` → 自动推导为 `SearchEngine`
 *
 * @module ServiceMap
 */

import type { JobStore } from '@alembic/core/daemon';
import type { DatabaseConnection } from '@alembic/core/database';
import type { DimensionCopy } from '@alembic/core/dimensions';
import type { EventBus, SignalBus } from '@alembic/core/events';
import type {
  ExclusionManager,
  GuardCheckEngine,
  GuardFeedbackLoop,
  GuardService,
  RuleLearner,
  ViolationsStore,
} from '@alembic/core/guard';
import type { WriteZone } from '@alembic/core/io';
import type {
  ConfidenceRouter,
  KnowledgeFileWriter,
  KnowledgeGraphService,
  KnowledgeService,
  KnowledgeSyncService,
  RecipeExtractor,
  RecipeFreshnessService,
  RecipeProductionGateway,
} from '@alembic/core/knowledge';
import type Logger from '@alembic/core/logging';
import type { MemoryRepositoryImpl } from '@alembic/core/memory';
// ── Repository Types ──
import type {
  BootstrapRepository,
  CodeEntityRepository,
  EvolutionGitDiffCheckpointRepository,
  EvolutionLifecycleEventRepository,
  EvolutionProposalRepository,
  EvolutionWarningRepository,
  GuardViolationRepository,
  KnowledgeEdgeRepository,
  KnowledgeRepository,
  SessionRepository,
  SourceRefRepository,
  TokenUsageStore,
} from '@alembic/core/repositories';
import type { HybridRetriever, SearchEngine } from '@alembic/core/search';
// ── Context Types ──
import type { FeedbackCollector, QualityScorer } from '@alembic/core/service/quality';
import type { RecipeCandidateValidator, RecipeParser } from '@alembic/core/service/recipe';
// ── Shared Types ──
import type { LanguageService } from '@alembic/core/shared';
import type { IndexingPipeline, VectorService, VectorStore } from '@alembic/core/vector';
import type { BootstrapTaskManager } from '#recipe-generation/bootstrap/BootstrapTaskManager.js';
import type { ContextualEnricher } from '#recipe-generation/vector/ContextualEnricher.js';
// ── Domain Types ──
// ── Core Types ──
// ── InfraModule Types ──
import type AuditLogger from '../infrastructure/audit/AuditLogger.js';
import type AuditStore from '../infrastructure/audit/AuditStore.js';
import type { ModuleService } from '../service/module/ModuleService.js';
import type {
  AlembicResidentCapabilityClients,
  ResidentSearchClient,
} from '../service/resident/AlembicResidentCapabilityClients.js';
import type { AlembicResidentServiceClient } from '../service/resident/AlembicResidentServiceClient.js';
import type { SkillHooks } from '../service/skills/SkillHooks.js';
import type { PrimeSearchPipeline } from '../service/task/PrimeSearchPipeline.js';

/**
 * 类型安全的服务映射表
 *
 * 将 DI 容器的字符串 key 映射到具体的服务类型。
 * `container.get<K extends keyof ServiceMap>(name: K): ServiceMap[K]`
 */
export interface ServiceMap {
  // ═══ InfraModule ═══
  database: DatabaseConnection;
  logger: ReturnType<typeof Logger.getInstance>;
  writeZone: WriteZone | null;
  auditStore: AuditStore;
  auditLogger: AuditLogger;
  eventBus: EventBus;
  bootstrapTaskManager: BootstrapTaskManager;
  jobStore: JobStore;
  knowledgeRepository: KnowledgeRepository;
  knowledgeEdgeRepository: KnowledgeEdgeRepository;
  codeEntityRepository: CodeEntityRepository;
  bootstrapRepository: BootstrapRepository;
  guardViolationRepository: GuardViolationRepository;
  memoryRepository: MemoryRepositoryImpl;
  sessionRepository: SessionRepository;
  proposalRepository: EvolutionProposalRepository;
  warningRepository: EvolutionWarningRepository;
  lifecycleEventRepository: EvolutionLifecycleEventRepository;
  gitDiffCheckpointRepository: EvolutionGitDiffCheckpointRepository;
  recipeSourceRefRepository: SourceRefRepository;
  knowledgeFileWriter: KnowledgeFileWriter;
  knowledgeSyncService: KnowledgeSyncService;

  // ═══ AppModule ═══
  qualityScorer: QualityScorer;
  recipeParser: RecipeParser;
  recipeCandidateValidator: RecipeCandidateValidator;
  recipeExtractor: RecipeExtractor | null;
  feedbackCollector: FeedbackCollector;
  tokenUsageStore: TokenUsageStore;
  moduleService: ModuleService;
  residentCapabilityClients: AlembicResidentCapabilityClients;
  residentSearchClient: ResidentSearchClient;
  residentServiceClient: AlembicResidentServiceClient;
  primeSearchPipeline: PrimeSearchPipeline;

  // ═══ KnowledgeModule ═══
  confidenceRouter: ConfidenceRouter;
  knowledgeService: KnowledgeService;
  recipeFreshnessService: RecipeFreshnessService;
  recipeProductionGateway: RecipeProductionGateway;
  knowledgeGraphService: KnowledgeGraphService;
  searchEngine: SearchEngine;
  vectorStore: VectorStore;
  indexingPipeline: IndexingPipeline;
  hybridRetriever: HybridRetriever;
  enhancementRegistry: unknown; // dynamic registry, type varies
  languageService: typeof LanguageService;
  dimensionCopy: typeof DimensionCopy;
  projectGraph: unknown | null;

  // ═══ VectorModule ═══
  vectorService: VectorService;
  contextualEnricher: ContextualEnricher | null;

  // ═══ GuardModule ═══
  guardService: GuardService;
  guardCheckEngine: GuardCheckEngine;
  exclusionManager: ExclusionManager;
  ruleLearner: RuleLearner;
  violationsStore: ViolationsStore;
  guardFeedbackLoop: GuardFeedbackLoop;

  // ═══ Plugin Skill Hooks ═══
  skillHooks: SkillHooks;

  // ═══ SignalModule ═══
  signalBus: SignalBus;

  // ═══ Singleton-injected values (bypassing get() factories) ═══
  _projectRoot: string;
  _config: Record<string, unknown>;
  _lang: string | null;
  _fileCache: unknown[] | null;
}
