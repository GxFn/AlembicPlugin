import { describe, expect, it, vi } from 'vitest';

import {
  buildRecipeSemanticRegionChunks,
  syncRecipeSemanticRegionVectors,
} from '@alembic/core/vector';

import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { buildRecipeSemanticRegionVectors } from '../../lib/recipe-pipeline/generate/recipe-region-vector.js';

describe('Plugin authoritative Recipe vector maintenance integration', () => {
  it('removes exactly 595 absent-recipe regions while preserving 75 entries, live regions, idempotence, and subset safety', async () => {
    const liveRecipes = [recipe('live-a'), recipe('live-b')];
    const liveChunks = liveRecipes.flatMap((entry) => buildRecipeSemanticRegionChunks(entry));
    const store = memoryVectorStore([
      ...Array.from({ length: 75 }, (_, index) => vectorItem(`entry_live-${index}`)),
      ...liveChunks.map((chunk) => ({ ...chunk, vector: [1, 0, 0] })),
      ...Array.from({ length: 595 }, (_, index) =>
        vectorItem(
          `recipe_region_absent-${index % 72}_identity_stale-${String(index).padStart(4, '0')}`
        )
      ),
    ]);
    const embedProvider = {
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
    };
    const syncRecipeSemanticRegions = vi.fn((entries, options) =>
      syncRecipeSemanticRegionVectors(store as never, embedProvider as never, entries, options)
    );
    const container = createContainer({
      knowledgeService: {
        list: vi.fn(async () => ({ data: liveRecipes.map((entry) => ({ toJSON: () => entry })) })),
      },
      memoryRepository: memoryRepository(),
      recipeSourceRefRepository: { findActiveByRecipeIds: vi.fn(() => []) },
      vectorService: {
        getAvailability: vi.fn(async () => ({
          available: true,
          probeStatus: 'ready',
          reason: 'embed-provider-ready',
          status: 'available',
        })),
        getStats: vi.fn(async () => ({
          count: store.items.size,
          dimension: 3,
          hasIndex: true,
          indexSize: store.items.size,
        })),
        syncRecipeSemanticRegions,
      },
      vectorStore: store,
    });

    const first = await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'isolated-75-595',
    });

    expect(first.syncResult?.removed).toBe(595);
    expect([...store.items.keys()].filter((id) => id.startsWith('entry_'))).toHaveLength(75);
    expect([...store.items.keys()].filter((id) => id.includes('absent-'))).toHaveLength(0);
    for (const chunk of liveChunks) {
      expect(store.items.has(chunk.id)).toBe(true);
    }

    const second = await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'isolated-75-595-repeat',
    });
    expect(second.syncResult?.removed).toBe(0);

    const unrelatedId = 'recipe_region_unrelated_identity_subset-proof';
    store.items.set(unrelatedId, vectorItem(unrelatedId));
    const subset = await syncRecipeSemanticRegionVectors(
      store as never,
      embedProvider as never,
      [liveRecipes[0]],
      { sourceRefsBridgeByRecipeId: {} }
    );
    expect(subset.removed).toBe(0);
    expect(store.items.has(unrelatedId)).toBe(true);
  });
});

function recipe(id: string) {
  return {
    content: { markdown: `${id} implementation body`, rationale: `${id} rationale` },
    description: `${id} description`,
    dimensionId: 'architecture',
    doClause: `Keep ${id} correct`,
    id,
    lifecycle: 'active',
    reasoning: { sources: [`Sources/${id}.swift`], whyStandard: `${id} evidence` },
    title: `${id} title`,
    trigger: `when ${id} applies`,
  };
}

function vectorItem(id: string) {
  return { content: id, id, metadata: {}, vector: [1, 0, 0] };
}

function memoryVectorStore(seed: Array<ReturnType<typeof vectorItem>>) {
  const items = new Map(seed.map((item) => [item.id, item]));
  return {
    items,
    batchUpsert: vi.fn(async (next: Array<ReturnType<typeof vectorItem>>) => {
      for (const item of next) {
        items.set(item.id, item);
      }
    }),
    flush: vi.fn(async () => undefined),
    listIds: vi.fn(async () => [...items.keys()]),
    remove: vi.fn(async (id: string) => {
      items.delete(id);
    }),
  };
}

function memoryRepository() {
  const items = new Map<string, unknown>();
  return {
    create: vi.fn((entry: { id: string }) => items.set(entry.id, entry)),
    delete: vi.fn((id: string) => items.delete(id)),
    findById: vi.fn((id: string) => items.get(id) ?? null),
    getAllActive: vi.fn(() => []),
    update: vi.fn(),
  };
}

function createContainer(services: Record<string, unknown>): ServiceContainer {
  return {
    get: (name: string) => {
      if (!(name in services)) {
        throw new Error(`missing service ${name}`);
      }
      return services[name];
    },
  } as unknown as ServiceContainer;
}
