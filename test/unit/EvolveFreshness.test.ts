import { describe, expect, it, vi } from 'vitest';
import { evolveForHostAgent } from '../../lib/runtime/mcp/handlers/host-agent/evolve.js';

describe('evolveForHostAgent freshness wiring', () => {
  it('refreshes freshness after a still-valid verification updates the Recipe row', async () => {
    const submit = vi.fn(async () => ({
      action: 'valid',
      outcome: 'verified',
      recipeId: 'recipe-valid',
    }));
    const refreshRecipes = vi.fn(async () => freshnessResult('recipe-valid', false));
    const result = await evolveForHostAgent(makeContext({ refreshRecipes, submit }), {
      decisions: [
        {
          action: 'skip',
          recipeId: 'recipe-valid',
          skipReason: 'still_valid',
        },
      ],
    });

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: 'valid' }));
    expect(refreshRecipes).toHaveBeenCalledWith([expect.objectContaining({ id: 'recipe-valid' })], {
      maxRecipes: 1,
    });
    expect(result.data).toMatchObject({
      refreshed: 1,
      freshness: {
        status: 'completed',
        processed: 1,
        retrievalMayBeStale: false,
      },
      retrievalMayBeStale: false,
    });
  });

  it('refreshes freshness after immediate deprecation changes lifecycle state', async () => {
    const submit = vi.fn(async () => ({
      action: 'deprecate',
      outcome: 'immediately-executed',
      recipeId: 'recipe-deprecated',
    }));
    const refreshRecipes = vi.fn(async () => freshnessResult('recipe-deprecated', true));
    const result = await evolveForHostAgent(makeContext({ refreshRecipes, submit }), {
      decisions: [
        {
          action: 'confirm_deprecation',
          reason: 'Pattern disappeared.',
          recipeId: 'recipe-deprecated',
        },
      ],
    });

    expect(refreshRecipes).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'recipe-deprecated' })],
      { maxRecipes: 1 }
    );
    expect(result.data).toMatchObject({
      deprecated: 1,
      freshness: {
        status: 'degraded',
        recipes: [
          {
            recipeId: 'recipe-deprecated',
            vector: {
              status: 'degraded',
              availabilityReason: 'embed-provider-missing',
            },
          },
        ],
      },
      retrievalMayBeStale: true,
    });
  });

  it('reports proposal-only evolve outcomes as freshness skipped', async () => {
    const submit = vi.fn(async () => ({
      action: 'update',
      outcome: 'proposal-created',
      proposalId: 'proposal-1',
      recipeId: 'recipe-proposal',
    }));
    const refreshRecipes = vi.fn(async () => freshnessResult('recipe-proposal', false));
    const result = await evolveForHostAgent(makeContext({ refreshRecipes, submit }), {
      decisions: [
        {
          action: 'propose_evolution',
          evidence: {
            codeSnippet: 'export const value = 1;',
            filePath: 'src/current.ts',
            suggestedChanges: 'Update the Recipe after review.',
            type: 'enhance',
          },
          recipeId: 'recipe-proposal',
        },
      ],
    });

    expect(refreshRecipes).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      proposed: 1,
      freshness: {
        status: 'skipped',
        processed: 0,
        retrievalMayBeStale: true,
        recipes: [
          {
            recipeId: 'recipe-proposal',
            skippedReason: 'proposal-only:proposal-created',
            status: 'skipped',
          },
        ],
      },
    });
  });
});

function makeContext(input: {
  refreshRecipes: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
}) {
  return {
    container: {
      get(name: string) {
        if (name === 'evolutionGateway') {
          return { submit: input.submit };
        }
        if (name === 'knowledgeRepository') {
          return {
            findById: vi.fn(async (id: string) => ({
              id,
              title: `Recipe ${id}`,
              content: { markdown: 'Recipe body.' },
              lifecycle: id.includes('deprecated') ? 'deprecated' : 'active',
              reasoning: { sources: ['src/current.ts:1'] },
            })),
          };
        }
        if (name === 'recipeFreshnessService') {
          return { refreshRecipes: input.refreshRecipes };
        }
        return null;
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as Parameters<typeof evolveForHostAgent>[0];
}

function freshnessResult(recipeId: string, degraded: boolean) {
  return {
    errors: [],
    processed: 1,
    recipes: [
      {
        errors: [],
        recipeId,
        retrievalMayBeStale: degraded,
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
        vector: degraded
          ? {
              availability: {
                available: false,
                embedProviderConfigured: false,
                probeStatus: 'not-applicable',
                reason: 'embed-provider-missing',
                status: 'unavailable',
              },
              degradedReason: 'embed-provider-missing',
              entrySyncStatus: 'skipped',
              errors: [],
              regionSyncStatus: 'skipped',
              status: 'degraded',
            }
          : {
              availability: {
                available: true,
                embedProviderConfigured: true,
                probeStatus: 'available',
                reason: 'embed-provider-ready',
                status: 'available',
              },
              entrySyncStatus: 'completed',
              errors: [],
              regionSyncStatus: 'completed',
              status: 'completed',
            },
      },
    ],
    requested: 1,
    retrievalMayBeStale: degraded,
    status: degraded ? 'degraded' : 'completed',
  };
}
