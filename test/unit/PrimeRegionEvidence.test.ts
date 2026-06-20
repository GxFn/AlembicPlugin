import type { RecipeRecord } from '@alembic/core/recipe-context';
import { describe, expect, test } from 'vitest';
import {
  buildPrimeRegionQuery,
  mapRegionHitsToPrimeEvidence,
  projectRecipeSourceRefLocatorEvidence,
} from '../../lib/runtime/mcp/handlers/agent-public-tools.js';
import { buildPrimeKnowledgeMaterial } from '../../lib/service/task/PrimeKnowledgeMaterial.js';

// PDR-2b: prove the local Recipe semantic-region lane is wired end to end —
// searchRegions hits → regionEvidence records → prime trust gate credits them as
// recipe-semantic-region evidence (full quality), un-deferring the PDR-1d interim
// where subject-less prime fell back to lexical-only.

describe('mapRegionHitsToPrimeEvidence', () => {
  test('groups region hits by recipe into trust-gate-shaped records', () => {
    const evidence = mapRegionHitsToPrimeEvidence([
      { id: 'r1#core', recipeId: 'r1', regionClass: 'core-code', score: 0.9, content: 'core body' },
      { id: 'r1#when', recipeId: 'r1', regionClass: 'when-clause', score: 0.7, content: 'when X' },
      { id: 'r2#do', recipeId: 'r2', regionClass: 'do-clause', score: 0.5, content: 'do Y' },
    ]);

    expect(evidence).toHaveLength(2);
    const r1 = evidence.find((e) => e.recipeId === 'r1');
    expect(r1).toMatchObject({
      itemId: 'r1',
      recipeId: 'r1',
      injectionStatus: 'selected',
      matchedRegionClasses: ['core-code', 'when-clause'],
      score: 0.9, // max across the recipe's region hits
      description: 'core body',
    });
    expect(r1?.evidenceRefs).toEqual(['residentRegionRetrieval:r1']);
    expect(Array.isArray(r1?.matchedRegions)).toBe(true);
    expect((r1?.matchedRegions as unknown[]).length).toBe(2);
  });

  test('drops hits with empty recipeId or regionClass (defective Core would emit these)', () => {
    const evidence = mapRegionHitsToPrimeEvidence([
      { id: 'x', recipeId: '', regionClass: 'core-code', score: 0.9 },
      { id: 'y', recipeId: 'r3', regionClass: '', score: 0.8 },
      { id: 'z', recipeId: 'r4', regionClass: 'core-code', score: 0.6 },
    ]);
    expect(evidence.map((e) => e.recipeId)).toEqual(['r4']);
  });
});

describe('buildPrimeRegionQuery', () => {
  test('uses the explicit searchQuery when present', () => {
    expect(
      buildPrimeRegionQuery({
        domainObjects: [],
        keywords: [],
        labels: [],
        locatorFacets: [],
        qualityConcerns: [],
        searchQuery: 'implement region retrieval',
      })
    ).toBe('implement region retrieval');
  });

  test('falls back to goal/scenario/keywords/labels for a subject-less prime', () => {
    const query = buildPrimeRegionQuery({
      domainObjects: [],
      keywords: ['vector', 'region'],
      labels: ['retrieval'],
      locatorFacets: [],
      qualityConcerns: [],
      requirementGoal: 'restore prime quality',
      scenario: 'prime',
    });
    expect(query).toBe('restore prime quality prime vector region retrieval');
  });
});

describe('regionEvidence → prime trust gate (PDR-1d interim un-defer)', () => {
  const requirement = {
    userQuery: 'implement recipe region retrieval',
    queries: ['implement recipe region retrieval'],
    keywords: ['region'],
    labels: ['retrieval'],
    language: null,
  };
  // Models the real subject-less prime: the unified search ran (not degraded) but
  // surfaced no lexical hits (searchResult null here); the region lane is what
  // supplies evidence. searchDegraded:false so region evidence is not blanket-dropped.
  const baseInput = {
    requirement,
    searchDegraded: false,
    searchResult: null,
    taskAnchorDecision: {
      action: 'skip' as const,
      confidence: 'low' as const,
      reasonCode: 'readonly-no-anchor' as const,
    },
  };

  test('region evidence surfaces accepted knowledge with recipe-semantic-region trust', () => {
    const regionEvidence = mapRegionHitsToPrimeEvidence([
      {
        id: 'rA#core',
        recipeId: 'rA',
        regionClass: 'core-code',
        score: 0.88,
        content: 'snippet A',
      },
    ]);
    const material = buildPrimeKnowledgeMaterial({ ...baseInput, regionEvidence });

    const accepted = material.acceptedKnowledge.find((k) => k.id === 'rA');
    expect(accepted).toBeDefined();
    expect(accepted?.trustEvidence.kind).toBe('recipe-semantic-region');
    expect(accepted?.matchedRegionClasses).toContain('core-code');
  });

  test('without region evidence the same subject-less prime accepts no recipe (interim shape)', () => {
    const material = buildPrimeKnowledgeMaterial({ ...baseInput, regionEvidence: [] });
    expect(material.acceptedKnowledge).toHaveLength(0);
  });

  test('source-ref locator evidence promotes exact Recipe source matches without vector evidence', () => {
    const recipe = makeRecipeRecord({
      id: 'r-source',
      sources: ['Alembic/lib/http/HttpServer.ts'],
      title: 'HTTP server request policy',
    });
    const regionEvidence = projectRecipeSourceRefLocatorEvidence(
      recipe,
      new Set(['Alembic/lib/http/HttpServer.ts']),
      '/Users/example/AlembicWorkspace'
    );
    const material = buildPrimeKnowledgeMaterial({ ...baseInput, regionEvidence });

    const accepted = material.acceptedKnowledge.find((item) => item.id === 'r-source');
    expect(accepted).toBeDefined();
    expect(accepted?.trustEvidence.kind).toBe('recipe-locator');
    expect(accepted?.trustEvidence.source).toBe('source-ref-locator-fallback');
    expect(accepted?.evidenceRefs.map((ref) => ref.path)).toContain(
      'Alembic/lib/http/HttpServer.ts'
    );
  });
});

function makeRecipeRecord(overrides: Partial<RecipeRecord>): RecipeRecord {
  return {
    id: 'recipe-id',
    lifecycle: 'active',
    ref: { id: 'recipe-id', kind: 'recipe', label: 'Recipe' },
    relations: [],
    sources: [],
    tags: [],
    title: 'Recipe',
    ...overrides,
  };
}
