import { describe, expect, test, vi } from 'vitest';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

describe('PrimeSearchPipeline route evidence', () => {
  test('preserves the actual vector route even when the quality filter yields no items', async () => {
    const engine = {
      search: vi.fn().mockResolvedValue({
        items: [],
        searchMeta: {
          requestedMode: 'auto',
          actualMode: 'semantic',
          route: 'semantic',
          semanticUsed: true,
          vectorUsed: true,
          resultCount: 0,
        },
      }),
    };
    const result = await new PrimeSearchPipeline(engine).search({ query: 'module isolation' });
    expect(result?.searchMeta).toMatchObject({
      actualMode: 'semantic',
      route: 'semantic',
      semanticUsed: true,
      vectorUsed: true,
    });
    expect(result?.relatedKnowledge).toEqual([]);
  });

  test('preserves keyword fallback evidence independently of region evidence', async () => {
    const engine = {
      search: vi.fn().mockResolvedValue({
        items: [],
        searchMeta: {
          requestedMode: 'auto',
          actualMode: 'keyword',
          route: 'keyword-fallback',
          semanticUsed: false,
          vectorUsed: false,
          fallbackReason: 'vector_store_query_failed:private provider failure',
          resultCount: 0,
        },
      }),
    };
    const result = await new PrimeSearchPipeline(engine).search({ query: 'module isolation' });
    expect(result?.searchMeta).toMatchObject({
      actualMode: 'keyword',
      route: 'keyword-fallback',
      vectorUsed: false,
      fallbackReason: 'vector-store-query-failed',
    });
    expect(JSON.stringify(result)).not.toContain('private provider failure');
  });
});
