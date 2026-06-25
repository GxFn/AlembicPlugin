import { describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  buildRecipeSemanticRegionVectors,
  syncRecipeSemanticMemoriesForEntries,
} from '../../lib/recipe-generation/host-agent-workflows/recipe-region-vector.js';

describe('buildRecipeSemanticRegionVectors availability gate', () => {
  it('uses VectorService availability instead of stats embedProviderAvailable', async () => {
    const syncRecipeSemanticRegions = vi.fn(async () => ({
      degradedReason: null,
      errors: [],
      generated: 1,
      generatedMetadata: [],
      removed: 0,
      scanned: 1,
      status: 'completed',
      upserted: 1,
    }));
    const vectorService = {
      getAvailability: vi.fn(async () => vectorAvailability({ available: true })),
      getStats: vi.fn(async () => ({
        count: 0,
        dimension: 1024,
        embedProviderAvailable: false,
        hasIndex: true,
        indexSize: 0,
      })),
      syncRecipeSemanticRegions,
    };
    const memoryRepository = createMemoryRepository();
    const container = createContainer({
      vectorService,
      knowledgeService: {
        list: vi.fn(async () => ({
          data: [
            {
              toJSON: () => ({
                category: 'runtime',
                content: 'Use structured vector availability.',
                description: 'DI availability should reach the real vector service.',
                dimensionId: 'architecture',
                id: 'recipe-1',
                lifecycle: 'active',
                reasoning: { sources: ['Sources/App.swift'], whyStandard: 'Runtime proof' },
                tags: ['vector'],
                title: 'Vector availability recipe',
                trigger: 'when vector availability looks stale',
              }),
            },
          ],
        })),
      },
      memoryRepository,
      recipeSourceRefRepository: {
        findActiveByRecipeIds: vi.fn(() => [
          { recipeId: 'recipe-1', sourcePath: 'Sources/App.swift', status: 'active' },
        ]),
      },
      vectorStore: {
        flush: vi.fn(async () => undefined),
      },
    });

    const report = await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(syncRecipeSemanticRegions).toHaveBeenCalledTimes(1);
    expect(memoryRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recipe-region-memory:recipe-1',
        relatedEntities: ['Sources/App.swift'],
        source: 'recipe-region-vector',
        sourceDimension: 'architecture',
        type: 'recipe',
      })
    );
    expect(report).toMatchObject({
      semanticMemories: {
        created: 1,
        status: 'synced',
        total: 1,
      },
      status: 'synced',
      vectorAvailability: {
        available: true,
        reason: 'embed-provider-ready',
        status: 'available',
      },
      vectorStatsBefore: {
        embedProviderAvailable: false,
      },
    });
  });

  it('skips without touching region vectors when provider availability is degraded', async () => {
    const syncRecipeSemanticRegions = vi.fn();
    const vectorService = {
      getAvailability: vi.fn(async () =>
        vectorAvailability({
          available: false,
          probeStatus: 'unavailable',
          reason: 'embed-provider-unavailable',
          status: 'degraded',
        })
      ),
      getStats: vi.fn(async () => ({
        count: 140,
        dimension: 1024,
        embedProviderAvailable: true,
        hasIndex: true,
        indexSize: 140,
      })),
      syncRecipeSemanticRegions,
    };
    const container = createContainer({
      vectorService,
      knowledgeService: {
        list: vi.fn(async () => {
          throw new Error('knowledge list should not run when availability is degraded');
        }),
      },
    });

    const report = await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(syncRecipeSemanticRegions).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      reason: 'embed-provider-unavailable',
      status: 'skipped',
      vectorAvailability: {
        available: false,
        probeStatus: 'unavailable',
        reason: 'embed-provider-unavailable',
        status: 'degraded',
      },
    });
  });

  it('keeps existing semantic memories when syncing a partial fresh-run Recipe batch', async () => {
    const memoryRepository = createMemoryRepository([
      {
        id: 'recipe-region-memory:recipe-existing',
        source: 'recipe-region-vector',
        type: 'recipe',
      },
    ]);
    const container = createContainer({
      memoryRepository,
      recipeSourceRefRepository: {
        findActiveByRecipeIds: vi.fn(() => [
          { recipeId: 'recipe-new', sourcePath: 'Sources/New.swift', status: 'active' },
        ]),
      },
    });

    const report = await syncRecipeSemanticMemoriesForEntries({
      container,
      deleteStale: false,
      entries: [
        {
          content: { markdown: 'Fresh run Recipe body.' },
          dimensionId: 'architecture',
          id: 'recipe-new',
          lifecycle: 'active',
          reasoning: { sources: ['Sources/New.swift'] },
          title: 'Fresh run recipe',
        },
      ],
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(report).toMatchObject({
      created: 1,
      deleted: 0,
      status: 'synced',
      total: 1,
    });
    expect(memoryRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recipe-region-memory:recipe-new',
        relatedEntities: ['Sources/New.swift'],
        source: 'recipe-region-vector',
        sourceDimension: 'architecture',
        type: 'recipe',
      })
    );
    expect(memoryRepository.delete).not.toHaveBeenCalled();
    expect(await memoryRepository.findById('recipe-region-memory:recipe-existing')).toBeTruthy();
  });
});

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

function createMemoryRepository(seed: Array<{ id: string; [key: string]: unknown }> = []) {
  const rows = new Map<string, unknown>(seed.map((row) => [row.id, row]));
  return {
    create: vi.fn(async (data: { id: string }) => {
      rows.set(data.id, data);
      return data;
    }),
    delete: vi.fn(async (id: string) => rows.delete(id)),
    findById: vi.fn(async (id: string) => rows.get(id) ?? null),
    getAllActive: vi.fn(async () => [...rows.values()] as Array<{ id: string }>),
    update: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      rows.set(id, { ...(rows.get(id) as Record<string, unknown>), ...updates });
      return true;
    }),
  };
}

function vectorAvailability(
  overrides: Partial<{
    available: boolean;
    embedProviderConfigured: boolean;
    probeStatus: string;
    reason: string;
    status: string;
  }> = {}
) {
  return {
    available: overrides.available ?? true,
    embedProviderConfigured: overrides.embedProviderConfigured ?? true,
    probeStatus: overrides.probeStatus ?? 'available',
    reason: overrides.reason ?? 'embed-provider-ready',
    status: overrides.status ?? 'available',
  };
}
