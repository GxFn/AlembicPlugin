import {
  createHostAiProviderManager,
  createHostManagedProvider,
  type HostAiProvider,
  type HostAiProviderManager,
} from '../../codex/HostAiAdapter.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export async function initialize(c: ServiceContainer) {
  const initialProvider =
    (c.singletons.aiProvider as HostAiProvider | null) ||
    createHostManagedProvider({
      provider: process.env.ALEMBIC_AI_PROVIDER || null,
      model: process.env.ALEMBIC_AI_MODEL || null,
    });
  const manager = createHostAiProviderManager(initialProvider);
  c.singletons._aiProviderManager = manager;

  manager._bindDiSync((provider, embed) => {
    c.singletons.aiProvider = provider;
    c.singletons._embedProvider = embed;
  });

  manager._bindDependentClearer(() => {
    const cleared: string[] = [];
    for (const key of c._aiDependentSingletons || []) {
      if (c.singletons[key]) {
        c.singletons[key] = null;
        cleared.push(key);
      }
    }
    return cleared;
  });

  manager._bindEmbedFallbackInit(() => null);
  if (c.singletons._embedProvider) {
    manager.setEmbedProvider(c.singletons._embedProvider as HostAiProvider);
  }
  c.singletons.aiProvider = manager.runtimeProvider;
  c.singletons._embedProvider = manager.embedProvider;
}

/**
 * 注册 AI 相关的服务到容器
 *
 * - 标记 AI 模块就绪
 * - 注册 aiProviderManager 服务
 * - 延迟注入 TokenRecorder（tokenUsageStore 此时已可用）
 */
export function register(c: ServiceContainer) {
  c.singletons._aiModuleReady = true;

  // 注册 aiProviderManager（消费者通过 container.get('aiProviderManager') 获取）
  c.register('aiProviderManager', () => c.singletons._aiProviderManager);

  // 延迟注入 TokenRecorder 到 manager（tokenUsageStore 在 AppModule 中注册）
  const manager = c.singletons._aiProviderManager as HostAiProviderManager;
  const containerRef = c;
  manager.setTokenRecorder({
    record(r: {
      source: string;
      provider?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
    }) {
      try {
        const store = containerRef.get('tokenUsageStore') as {
          record: (rec: typeof r) => void;
        };
        store.record(r);
      } catch {
        /* tokenUsageStore not available yet */
      }
    },
  });
}
