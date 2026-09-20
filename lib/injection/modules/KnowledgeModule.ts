/** 知识用例装配入口：基础服务 → 检索 → 共享服务 → 演化；初始化订阅保持独立。 */
import { DimensionCopy } from '@alembic/core/dimensions';
import { getFrameworkEnhancements as getEnhancementRegistry } from '@alembic/core/enhancement';
import {
  ConfidenceRouter,
  createFsSourceRefResolver,
  KnowledgeGraphService,
  KnowledgeService,
  type KnowledgeServiceOptions,
  resolveGroundedSourcePaths,
} from '@alembic/core/knowledge';
import { LanguageService } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { refreshRecipeFreshnessByIds } from '#recipe-pipeline/sustain/RecipeFreshnessRuntime.js';
import type { ServiceContainer } from '../ServiceContainer.js';
import { registerKnowledgeEvolution } from './KnowledgeEvolutionModule.js';
import { registerKnowledgeRetrieval } from './KnowledgeRetrievalModule.js';

export function register(c: ServiceContainer) {
  registerKnowledgeServices(c);
  registerKnowledgeRetrieval(c);
  registerSharedServices(c);
  registerKnowledgeEvolution(c);
}

function registerKnowledgeServices(c: ServiceContainer) {
  c.singleton(
    'confidenceRouter',
    (ct: ServiceContainer) => new ConfidenceRouter({}, ct.get('qualityScorer'))
  );

  c.singleton(
    'knowledgeService',
    (ct: ServiceContainer) =>
      new KnowledgeService(
        ct.get('knowledgeRepository'),
        ct.get('auditLogger'),
        // PDR-3: governance Gateway deleted (dead daemon path). KnowledgeService stores but
        // never reads this ctor arg, so pass null instead of a removed 'gateway' singleton.
        null,
        ct.get('knowledgeGraphService'),
        {
          fileWriter: ct.get('knowledgeFileWriter'),
          skillHooks: ct.get('skillHooks'),
          confidenceRouter: ct.get('confidenceRouter'),
          qualityScorer: ct.get('qualityScorer'),
          eventBus: ct.services.eventBus ? ct.get('eventBus') : null,
          edgeRepo: ct.get('knowledgeEdgeRepository'),
          proposalRepo: ct.get('proposalRepository'),
          // P5/C8: 注入深度接地 port，激活 QualityScorer 的深度加权评分(未注入时评分退化为 legacy)。
          // 两宿主共用 Core createFsSourceRefResolver 保证接地判定 parity。
          groundedSourcePaths: (item: Record<string, unknown>) =>
            resolveGroundedSourcePaths(item, {
              sourceRefResolver: createFsSourceRefResolver(),
              projectRoot: resolveProjectRoot(ct),
            }),
        } satisfies KnowledgeServiceOptions
      )
  );

  c.singleton(
    'knowledgeGraphService',
    (ct: ServiceContainer) => new KnowledgeGraphService(ct.get('knowledgeEdgeRepository'))
  );
}

function registerSharedServices(c: ServiceContainer) {
  c.register('enhancementRegistry', () => getEnhancementRegistry());
  c.register('languageService', () => LanguageService);
  c.register('dimensionCopy', () => DimensionCopy);
  c.register('projectGraph', () => c.singletons.projectGraph || null);
}

/**
 * 初始化知识服务（在容器初始化后调用）
 * 绑定 EventBus → SearchEngine.refreshIndex() + recipe_source_refs 填充
 */
export function initializeKnowledgeServices(c: ServiceContainer): void {
  // 轨①（P3 daemon-less 自动化）：init 一次性接通 proposal 执行的信号驱动。best-effort：
  // proposalExecutor/signalBus 不可取时跳过（非致命）；subscribeToSignals 在 Core 侧已幂等
  // （if(#unsubscribe)return），重复 init 不放大订阅。接通后真实信号（HostAgentFileChangeHandler 的
  // quality/source_modified 等）即时驱动 observing proposal 执行；sweep 有界兜底见 staging-access-sweep。
  // 放在 eventBus 早 return 之前：proposal 信号订阅不应依赖 eventBus/searchEngine 是否就绪。
  try {
    const proposalExecutor = c.get('proposalExecutor');
    const signalBus = c.get('signalBus');
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
    const eventBus = c.get('eventBus');
    const searchEngine = c.get('searchEngine');

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

async function _refreshFreshnessForEntry(c: ServiceContainer, entryId: string): Promise<void> {
  try {
    await refreshRecipeFreshnessByIds(c, [entryId]);
  } catch {
    /* repos/services may not be registered yet */
  }
}
