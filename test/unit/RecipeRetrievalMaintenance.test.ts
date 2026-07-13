import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { maintainRecipeRetrievalDocuments } from '../../lib/recipe-pipeline/generate/recipe-region-vector.js';

function containerWith(vectorService: Record<string, unknown>) {
  const entry = {
    id: 'recipe-1',
    lifecycle: 'candidate',
    retrievalProfile: { schemaVersion: '1' },
  };
  return {
    get(name: string) {
      if (name === 'vectorService') {
        return vectorService;
      }
      if (name === 'knowledgeService') {
        return { list: vi.fn(async () => ({ data: [{ toJSON: () => entry }] })) };
      }
      if (name === 'recipeSourceRefRepository') {
        return null;
      }
      throw new Error(`unexpected-service:${name}`);
    },
  };
}

describe('Recipe retrieval maintenance', () => {
  it('uses the Core verified generation path without creating a generic Recipe memory', async () => {
    const buildRecipeRetrievalGeneration = vi.fn(async () => ({
      status: 'activated',
      generationId: 'generation-1',
      previous: null,
      active: { generationId: 'generation-1', manifestHash: 'manifest-1' },
      manifest: { manifestHash: 'manifest-1' },
      inspection: { healthy: true },
      errors: [],
    }));
    const syncRecipeSemanticRegions = vi.fn();

    const report = await maintainRecipeRetrievalDocuments({
      container: containerWith({
        buildRecipeRetrievalGeneration,
        getAvailability: vi.fn(async () => ({ available: true })),
        getStats: vi.fn(async () => ({ count: 4 })),
        syncRecipeSemanticRegions,
      }) as never,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(buildRecipeRetrievalGeneration).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'recipe-1' }),
    ]);
    expect(syncRecipeSemanticRegions).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: 'synced',
      generation: {
        status: 'activated',
        generationId: 'generation-1',
      },
    });
  });

  it('runs provider-independent authoritative cleanup when dense generation is offline', async () => {
    const syncRecipeSemanticRegions = vi.fn(async () => ({
      status: 'degraded',
      degradedReason: 'embed-provider-unavailable',
      scanned: 1,
      generated: 0,
      embedded: 0,
      upserted: 0,
      removed: 2,
      skipped: 1,
      verified: 0,
      errors: [],
      generatedMetadata: [],
    }));
    const report = await maintainRecipeRetrievalDocuments({
      container: containerWith({
        buildRecipeRetrievalGeneration: vi.fn(async () => ({
          status: 'failed',
          generationId: null,
          previous: { generationId: 'generation-old', manifestHash: 'manifest-old' },
          active: { generationId: 'generation-old', manifestHash: 'manifest-old' },
          manifest: null,
          inspection: null,
          errors: ['embed-provider-unavailable'],
        })),
        getAvailability: vi.fn(async () => ({ available: false })),
        getStats: vi.fn(async () => ({ count: 2 })),
        syncRecipeSemanticRegions,
      }) as never,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(syncRecipeSemanticRegions).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'recipe-1' })],
      expect.objectContaining({
        maintenanceScope: {
          kind: 'authoritative-corpus',
          nonDeprecatedRecipeIds: ['recipe-1'],
        },
        removeStale: true,
      })
    );
    expect(report).toMatchObject({ status: 'degraded', syncResult: { removed: 2 } });
  });

  it('reports storage failures without aborting the enclosing rescan', async () => {
    const report = await maintainRecipeRetrievalDocuments({
      container: containerWith({
        buildRecipeRetrievalGeneration: vi.fn(async () => {
          throw new Error('shadow-storage-unavailable');
        }),
        getAvailability: vi.fn(async () => ({ available: true })),
        getStats: vi.fn(async () => ({ count: 2 })),
        syncRecipeSemanticRegions: vi.fn(),
      }) as never,
      logger: { info: vi.fn() },
      logPrefix: 'test',
    });

    expect(report).toMatchObject({
      generation: null,
      reason: 'recipe-retrieval-maintenance-failed: shadow-storage-unavailable',
      status: 'failed',
    });
  });

  it('contains no live duplicate Recipe-memory producer', async () => {
    const maintenanceSource = await readFile(
      new URL('../../lib/recipe-pipeline/generate/recipe-region-vector.ts', import.meta.url),
      'utf8'
    );
    const freshnessSource = await readFile(
      new URL('../../lib/recipe-pipeline/sustain/RecipeFreshnessRuntime.ts', import.meta.url),
      'utf8'
    );

    expect(`${maintenanceSource}\n${freshnessSource}`).not.toMatch(
      /recipe-region-memory|syncRecipeSemanticMemoriesForEntries/
    );
    expect(maintenanceSource).not.toContain('buildRecipeSemanticRegionVectors');
  });
});
