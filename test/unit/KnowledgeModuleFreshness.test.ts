import { describe, expect, it, vi } from 'vitest';
import { initializeKnowledgeServices } from '../../lib/injection/modules/KnowledgeModule.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

describe('KnowledgeModule create freshness wiring', () => {
  it('delegates create-event source refs and vector freshness to Core service', async () => {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    const eventBus = {
      on: vi.fn((eventName: string, handler: (data: unknown) => void) => {
        handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
      }),
    };
    const searchEngine = { refreshIndex: vi.fn() };
    const sourceRefRepo = { upsert: vi.fn() };
    const refreshRecipes = vi.fn(async () => ({
      errors: [],
      processed: 1,
      recipes: [
        {
          errors: [],
          recipeId: 'recipe-1',
          retrievalMayBeStale: false,
          sourceRefs: {
            activeRefs: ['src/current.ts:1'],
            active: 1,
            allRefs: ['src/current.ts:1'],
            cleaned: 0,
            errors: [],
            inserted: 1,
            recipesProcessed: 1,
            skipped: 0,
            staleRefs: [],
            stale: 0,
            status: 'completed',
          },
          sourceRefsBridge: { refs: ['src/current.ts:1'], status: 'active' },
          vector: {
            availability: { status: 'available', reason: 'embed-provider-ready' },
            entrySyncStatus: 'completed',
            errors: [],
            regionSyncStatus: 'completed',
            status: 'completed',
          },
        },
      ],
      requested: 1,
      retrievalMayBeStale: false,
      status: 'completed',
    }));
    const container = {
      services: {
        eventBus: () => eventBus,
        searchEngine: () => searchEngine,
      },
      get(name: string) {
        if (name === 'eventBus') {
          return eventBus;
        }
        if (name === 'searchEngine') {
          return searchEngine;
        }
        if (name === 'knowledgeRepository') {
          return {
            findById: vi.fn(async () => ({
              id: 'recipe-1',
              title: 'Recipe One',
              content: { markdown: 'Recipe body.' },
              reasoning: { sources: ['src/current.ts:1'] },
            })),
          };
        }
        if (name === 'recipeFreshnessService') {
          return { refreshRecipes };
        }
        if (name === 'recipeSourceRefRepository') {
          return sourceRefRepo;
        }
        return null;
      },
    } as unknown as ServiceContainer;

    initializeKnowledgeServices(container);
    const changedHandlers = handlers.get('knowledge:changed') ?? [];
    expect(changedHandlers).toHaveLength(2);

    for (const handler of changedHandlers) {
      handler({ action: 'create', entryId: 'recipe-1' });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(searchEngine.refreshIndex).toHaveBeenCalledTimes(1);
    expect(refreshRecipes).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'recipe-1', title: 'Recipe One' })],
      { maxRecipes: 1 }
    );
    expect(sourceRefRepo.upsert).not.toHaveBeenCalled();
  });
});
