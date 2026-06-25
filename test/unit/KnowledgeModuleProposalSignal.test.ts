import { describe, expect, it, vi } from 'vitest';
import { initializeKnowledgeServices } from '../../lib/injection/modules/KnowledgeModule.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

// P3 轨①：init 在 eventBus 早 return 之前 best-effort 幂等接通 proposal 信号驱动
// （proposalExecutor.subscribeToSignals(signalBus)）。这些用例不提供 eventBus/searchEngine
// （c.services 为空），故 init 仅执行 proposal 订阅段、随后早 return。
describe('KnowledgeModule proposal signal wiring', () => {
  it('subscribes the proposal executor to the signal bus once at init', () => {
    const subscribeToSignals = vi.fn();
    const signalBus = { id: 'signal-bus' };
    const proposalExecutor = { subscribeToSignals };
    const container = {
      services: {},
      get(name: string) {
        if (name === 'proposalExecutor') {
          return proposalExecutor;
        }
        if (name === 'signalBus') {
          return signalBus;
        }
        return null;
      },
    } as unknown as ServiceContainer;

    initializeKnowledgeServices(container);

    // 恰一次、且以同一 signalBus 调用，接通信号即时驱动 observing proposal 执行。
    expect(subscribeToSignals).toHaveBeenCalledTimes(1);
    expect(subscribeToSignals).toHaveBeenCalledWith(signalBus);
  });

  it('skips proposal signal subscription best-effort when executor or bus is unavailable', () => {
    // proposalExecutor / signalBus 不可取（get→null）时不应抛错（同既有 best-effort wiring 风格）。
    const container = {
      services: {},
      get() {
        return null;
      },
    } as unknown as ServiceContainer;

    expect(() => initializeKnowledgeServices(container)).not.toThrow();
  });
});
