import { describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  buildRecipeSemanticRegionVectors,
  syncRecipeSemanticMemoriesForEntries,
} from '../../lib/recipe-pipeline/generate/recipe-region-vector.js';

describe('buildRecipeSemanticRegionVectors authoritative maintenance', () => {
  it('passes one complete non-deprecated authority set to every batch, including an empty corpus', async () => {
    const syncRecipeSemanticRegions = vi.fn(async () => ({
      degradedReason: null,
      errors: [],
      generated: 0,
      generatedMetadata: [],
      removed: 0,
      scanned: 0,
      skipped: 0,
      status: 'completed',
      upserted: 0,
    }));
    const vectorService = {
      getAvailability: vi.fn(async () => vectorAvailability({ available: true })),
      getStats: vi.fn(async () => ({ count: 0, dimension: 3, hasIndex: true, indexSize: 0 })),
      syncRecipeSemanticRegions,
    };
    const entries = Array.from({ length: 8 }, (_, index) => ({
      toJSON: () => ({
        content: `Recipe ${index}`,
        id: `recipe-${index}`,
        lifecycle: index === 7 ? 'deprecated' : 'active',
        title: `Recipe ${index}`,
      }),
    }));
    const knowledgeService = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: entries })
        .mockResolvedValueOnce({ data: [] }),
    };
    const container = createContainer({
      knowledgeService,
      memoryRepository: createMemoryRepository(),
      vectorService,
      vectorStore: { flush: vi.fn(async () => undefined) },
    });

    await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(syncRecipeSemanticRegions).toHaveBeenCalledTimes(2);
    const expectedAuthority = Array.from({ length: 7 }, (_, index) => `recipe-${index}`);
    for (const call of syncRecipeSemanticRegions.mock.calls) {
      expect(call[1]).toMatchObject({
        maintenanceScope: {
          kind: 'authoritative-corpus',
          nonDeprecatedRecipeIds: expectedAuthority,
        },
      });
    }

    syncRecipeSemanticRegions.mockClear();
    await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'test-empty',
    });

    expect(syncRecipeSemanticRegions).toHaveBeenCalledOnce();
    expect(syncRecipeSemanticRegions).toHaveBeenCalledWith([], {
      maintenanceScope: {
        kind: 'authoritative-corpus',
        nonDeprecatedRecipeIds: [],
      },
      sourceRefsBridgeByRecipeId: {},
    });
  });

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

  it.each([
    {
      expectedReason: 'embed-provider-unavailable',
      expectedStatus: 'degraded',
      syncResult: {
        degradedReason: 'embed-provider-unavailable',
        errors: [],
        generated: 1,
        generatedMetadata: [],
        removed: 0,
        scanned: 1,
        skipped: 1,
        status: 'degraded',
        upserted: 0,
      },
    },
    {
      expectedReason: 'embed-upsert-failed:replacement generation failed',
      expectedStatus: 'failed',
      syncResult: {
        errors: ['embed-upsert-failed:replacement generation failed'],
        generated: 1,
        generatedMetadata: [],
        removed: 0,
        scanned: 1,
        skipped: 0,
        status: 'failed',
        upserted: 0,
      },
    },
  ])(
    'surfaces $expectedStatus maintenance without claiming synced',
    async ({ expectedReason, expectedStatus, syncResult }) => {
      const container = createContainer({
        knowledgeService: {
          list: vi.fn(async () => ({
            data: [
              {
                toJSON: () => ({
                  content: 'Replacement body',
                  id: 'recipe-replacement',
                  lifecycle: 'active',
                  title: 'Replacement Recipe',
                }),
              },
            ],
          })),
        },
        memoryRepository: createMemoryRepository(),
        vectorService: {
          getAvailability: vi.fn(async () => vectorAvailability({ available: true })),
          getStats: vi.fn(async () => ({ count: 2, dimension: 3, hasIndex: true, indexSize: 2 })),
          syncRecipeSemanticRegions: vi.fn(async () => syncResult),
        },
        vectorStore: { flush: vi.fn(async () => undefined) },
      });

      const report = await buildRecipeSemanticRegionVectors({
        container,
        logger: { info: vi.fn() },
        logPrefix: 'replacement-safety',
      });

      expect(report).toMatchObject({
        reason: expectedReason,
        status: expectedStatus,
        syncResult: { removed: 0, upserted: 0 },
      });
    }
  );

  it('forwards complete Recipe authority when provider availability is degraded', async () => {
    const syncRecipeSemanticRegions = vi.fn(async () => ({
      degradedReason: 'embed-provider-unavailable',
      errors: [],
      generated: 1,
      generatedMetadata: [],
      removed: 2,
      scanned: 1,
      skipped: 1,
      status: 'degraded',
      upserted: 0,
    }));
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
    const list = vi.fn(async () => ({
      data: [
        {
          toJSON: () => ({
            content: 'Live body retained without replacement embedding.',
            id: 'recipe-live',
            lifecycle: 'active',
            title: 'Live Recipe',
          }),
        },
        {
          toJSON: () => ({
            content: 'Deprecated body excluded from authority.',
            id: 'recipe-deprecated',
            lifecycle: 'deprecated',
            title: 'Deprecated Recipe',
          }),
        },
      ],
    }));
    const container = createContainer({
      vectorService,
      knowledgeService: {
        list,
      },
      memoryRepository: createMemoryRepository(),
      vectorStore: { flush: vi.fn(async () => undefined) },
    });

    const report = await buildRecipeSemanticRegionVectors({
      container,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(list).toHaveBeenCalledOnce();
    expect(syncRecipeSemanticRegions).toHaveBeenCalledOnce();
    expect(syncRecipeSemanticRegions).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'recipe-live' })],
      {
        maintenanceScope: {
          kind: 'authoritative-corpus',
          nonDeprecatedRecipeIds: ['recipe-live'],
        },
        sourceRefsBridgeByRecipeId: {},
      }
    );
    expect(report).toMatchObject({
      reason: 'embed-provider-unavailable',
      status: 'degraded',
      syncResult: {
        removed: 2,
        upserted: 0,
      },
      vectorAvailability: {
        available: false,
        probeStatus: 'unavailable',
        reason: 'embed-provider-unavailable',
        status: 'degraded',
      },
    });
  });

  it('continues authoritative cleanup when the availability probe throws', async () => {
    const probeError = new Error('availability probe timed out');
    const syncRecipeSemanticRegions = vi.fn(async () => ({
      degradedReason: 'embed-provider-unavailable',
      errors: [],
      generated: 1,
      generatedMetadata: [],
      removed: 1,
      scanned: 1,
      skipped: 1,
      status: 'degraded',
      upserted: 0,
    }));
    const list = vi.fn(async () => ({
      data: [
        {
          toJSON: () => ({
            content: 'Live body',
            id: 'recipe-live',
            lifecycle: 'active',
            title: 'Live Recipe',
          }),
        },
      ],
    }));
    const logger = { info: vi.fn() };
    const container = createContainer({
      knowledgeService: { list },
      memoryRepository: createMemoryRepository(),
      vectorService: {
        getAvailability: vi.fn(async () => {
          throw probeError;
        }),
        getStats: vi.fn(async () => ({ count: 2, dimension: 3, hasIndex: true, indexSize: 2 })),
        syncRecipeSemanticRegions,
      },
      vectorStore: { flush: vi.fn(async () => undefined) },
    });

    const report = await buildRecipeSemanticRegionVectors({
      container,
      logger,
      logPrefix: 'probe-error',
    });

    expect(list).toHaveBeenCalledOnce();
    expect(syncRecipeSemanticRegions).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'recipe-live' })],
      expect.objectContaining({
        maintenanceScope: {
          kind: 'authoritative-corpus',
          nonDeprecatedRecipeIds: ['recipe-live'],
        },
      })
    );
    expect(report).toMatchObject({
      reason: 'embed-provider-unavailable',
      status: 'degraded',
      syncResult: { removed: 1, upserted: 0 },
      vectorAvailability: null,
    });
    expect(logger.info).toHaveBeenCalledWith(
      '[probe-error] Recipe region-vector availability probe failed; continuing cleanup',
      { reason: probeError.message }
    );
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
