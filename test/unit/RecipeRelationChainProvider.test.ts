import { describe, expect, it } from 'vitest';
import { DefaultRecipeRelationChainProvider } from '../../lib/service/project-knowledge-context/retrieval/RecipeRelationChainProvider.js';

describe('DefaultRecipeRelationChainProvider', () => {
  it('extracts relation targets from persisted target-shaped relation entries', () => {
    const provider = new DefaultRecipeRelationChainProvider();

    const chains = provider.expandRecipeRelationChains('search-handler', 1, {
      items: [
        {
          id: 'search-handler',
          relations: {
            implements: [
              {
                description: 'source-backed governance entry',
                target: 'knowledge:asq-quality-fact',
              },
            ],
          },
        },
      ],
    });

    expect(chains).toEqual([
      expect.objectContaining({
        hops: ['search-handler', 'knowledge:asq-quality-fact'],
        relationType: 'implements',
      }),
    ]);
  });

  it('continues relation chains across knowledge prefix variants', () => {
    const provider = new DefaultRecipeRelationChainProvider();

    const chains = provider.expandRecipeRelationChains('knowledge:search-handler', 2, {
      items: [
        {
          id: 'search-handler',
          relations: {
            implements: [{ target: 'knowledge:ranking-provider' }],
          },
        },
        {
          id: 'ranking-provider',
          relations: {
            supports: [{ target: 'detail-ref-canonicalizer' }],
          },
        },
      ],
    });

    expect(chains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hops: ['knowledge:search-handler', 'knowledge:ranking-provider'],
          relationType: 'implements',
        }),
        expect.objectContaining({
          hops: [
            'knowledge:search-handler',
            'knowledge:ranking-provider',
            'detail-ref-canonicalizer',
          ],
          relationType: 'implements',
        }),
      ])
    );
  });
});
