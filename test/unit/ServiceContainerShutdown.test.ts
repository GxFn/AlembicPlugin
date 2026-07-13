import { describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { McpServer } from '../../lib/host-runtime/mcp/McpServer.js';

describe('Plugin vector shutdown ordering', () => {
  it('awaits VectorService drain, then flushes/destroys the store before database shutdown', async () => {
    const order: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const container = new ServiceContainer();
    const destroyVectorService = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseDrain = () => {
              order.push('vector-service-destroyed');
              resolve();
            };
          })
      );
    container.singletons.vectorService = { destroy: destroyVectorService };
    container.singletons.vectorStore = {
      destroy: vi.fn(() => order.push('vector-store-destroyed')),
      flush: vi.fn(async () => {
        order.push('vector-store-flushed');
      }),
    };
    const bootstrap = {
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {
        order.push('database-closed');
      }),
    };
    const server = new McpServer({ bootstrap, container, projectRoot: '/tmp/test-project' });

    const shutdown = server.shutdown();
    await vi.waitFor(() => expect(destroyVectorService).toHaveBeenCalledOnce());
    expect(bootstrap.shutdown).not.toHaveBeenCalled();
    releaseDrain?.();
    await shutdown;

    expect(order).toEqual([
      'vector-service-destroyed',
      'vector-store-flushed',
      'vector-store-destroyed',
      'database-closed',
    ]);
  });
});
