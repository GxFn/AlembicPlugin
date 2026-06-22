import { describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { buildRecipeSemanticRegionVectors } from '../../lib/recipe-generation/host-agent-workflows/recipe-region-vector.js';

describe('buildRecipeSemanticRegionVectors availability gate', () => {
  it('uses VectorService availability instead of stats embedProviderAvailable', async () => {
    const syncRecipeSemanticRegions = vi.fn(async () => ({
      degradedReason: null,
      errors: 0,
      generated: 1,
      removed: 0,
      scanned: 1,
      status: 'synced',
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
    const container = createContainer({
      vectorService,
      knowledgeService: {
        list: vi.fn(async () => ({
          data: [
            {
              toJSON: () => ({
                content: 'Use structured vector availability.',
                id: 'recipe-1',
                title: 'Vector availability recipe',
              }),
            },
          ],
        })),
      },
      recipeSourceRefRepository: {
        findActiveByRecipeIds: vi.fn(() => []),
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
    expect(report).toMatchObject({
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
