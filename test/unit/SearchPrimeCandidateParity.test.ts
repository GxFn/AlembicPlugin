import { describe, expect, test, vi } from 'vitest';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

describe('Search and Prime canonical candidate parity', () => {
  test('keeps the frozen eight-query Core ranking fixture in Plugin Prime Top 3', async () => {
    const targetRecipeId = 'eed49092-3cc8-4a2a-9a5d-29ead96e267b';
    const queries = [
      'How do we enforce clean architecture boundaries across Swift packages?',
      'What architecture rules should guide modular boundaries in a Swift app?',
      'How should layered dependencies flow across app, feature, service, and core modules?',
      'What are the modularization constraints for independently removable features?',
      'Where are dependencies allowed between UI features and shared core modules?',
      'How should an iOS application structure feature modules to avoid coupling?',
      'How do I keep SwiftPM feature packages independent from each other?',
      'What prevents one feature module from importing another feature directly?',
    ];
    const engine = {
      search: vi.fn().mockImplementation(async () => ({
        items: [
          canonicalItem('fixture-neighbor-a', 'pattern', 0.013, 1),
          canonicalItem(targetRecipeId, 'pattern', 0.012, 2),
          canonicalItem('fixture-neighbor-b', 'rule', 0.011, 3),
        ],
        searchMeta: {
          requestedMode: 'auto',
          actualMode: 'auto(canonical-hybrid)',
          route: 'core-search-engine',
          semanticUsed: true,
          vectorUsed: true,
        },
      })),
    };
    const pipeline = new PrimeSearchPipeline(engine);

    for (const query of queries) {
      const result = await pipeline.search({ query, limit: 3 });
      expect(result?.searchMeta.candidateRecipeIds.slice(0, 3), query).toContain(targetRecipeId);
    }
    expect(engine.search).toHaveBeenCalledTimes(queries.length);
  });

  test('keeps the authoritative Search order without a second Prime admission threshold', async () => {
    const items = [
      canonicalItem('recipe-low', 'pattern', 0.0081, 1),
      canonicalItem('recipe-rule', 'rule', 0.0079, 2),
      canonicalItem('recipe-tail', 'pattern', 0.0002, 3),
    ];
    const engine = {
      search: vi.fn().mockResolvedValue({
        items,
        searchMeta: {
          requestedMode: 'auto',
          actualMode: 'auto(canonical-hybrid)',
          route: 'core-search-engine',
          semanticUsed: true,
          vectorUsed: true,
        },
      }),
    };

    const result = await new PrimeSearchPipeline(engine).search({
      query: 'layered Swift package boundaries',
      limit: 3,
    });

    expect(engine.search).toHaveBeenCalledWith(
      'layered Swift package boundaries',
      expect.objectContaining({ limit: 3, mode: 'auto' })
    );
    expect(result?.searchMeta.candidateRecipeIds).toEqual([
      'recipe-low',
      'recipe-rule',
      'recipe-tail',
    ]);
    expect(
      [...(result?.relatedKnowledge ?? []), ...(result?.guardRules ?? [])].map((item) => item.id)
    ).toEqual(['recipe-low', 'recipe-tail', 'recipe-rule']);
    expect(result?.searchMeta.filteredCount).toBe(3);
  });

  test('preserves dense, sparse, and raw RRF evidence in the Prime projection', async () => {
    const engine = {
      search: vi.fn().mockResolvedValue({
        items: [canonicalItem('recipe-evidence', 'pattern', 0.0123, 4)],
        searchMeta: {
          requestedMode: 'auto',
          actualMode: 'auto(canonical-hybrid)',
          route: 'core-search-engine',
          semanticUsed: true,
          vectorUsed: true,
        },
      }),
    };

    const result = await new PrimeSearchPipeline(engine).search({ query: 'evidence' });
    expect(result?.relatedKnowledge[0]).toMatchObject({
      denseRank: 4,
      denseSimilarity: 0.88,
      sparseRank: 2,
      sparseScore: 17,
      rrfContribution: {
        dense: 0.004,
        sparse: 0.0083,
        total: 0.0123,
      },
    });
  });
});

function canonicalItem(id: string, kind: string, score: number, denseRank: number) {
  return {
    id,
    title: id,
    trigger: '',
    kind,
    language: 'swift',
    score,
    description: `${id} description`,
    denseSimilarity: 0.88,
    denseRank,
    sparseScore: 17,
    sparseRank: 2,
    rrfContribution: {
      dense: 0.004,
      sparse: 0.0083,
      total: 0.0123,
    },
    regionEvidence: [{ id: `recipe-region:${id}:summary`, regionClass: 'summary' }],
    retrievalDiagnostics: {
      filteredOrphanCount: 0,
      filteredDeprecatedCount: 0,
      aggregatedRegionCount: 1,
      refillRounds: 0,
      candidateWindow: 32,
      exhausted: true,
      candidateBudgetReached: false,
    },
  };
}
