import { describe, expect, test } from 'vitest';
import {
  buildPrimeRegionQuery,
  mapRegionHitsToPrimeEvidence,
  projectRecipeSourceRefLocatorEvidence,
} from '../../lib/host-runtime/mcp/handlers/agent-public-tools.js';
import { buildPrimeKnowledgeMaterial } from '../../lib/service/task/PrimeKnowledgeMaterial.js';

type RecipeRecord = Parameters<typeof projectRecipeSourceRefLocatorEvidence>[0];

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

  test('search-hit source-ref backfill earns recipe-locator trust for subject-less pure-local prime (P-1)', () => {
    // P-1（2026-07-06）：无文件锚点、无向量证据时，本地检索命中的 Recipe 用
    // refs 表回填的证据形态必须过信任门——否则 pure-local prime 永远 knowledge-empty。
    const backfill = [
      {
        evidenceRefs: ['recipe-locator:r-hit'],
        injectionStatus: 'selected',
        itemId: 'r-hit',
        kind: 'pattern',
        recipeId: 'r-hit',
        score: 1,
        sourceRefs: ['Alembic/lib/http/middleware/errorHandler.ts:1-12'],
        title: 'errorHandler 集中式错误处理中间件',
        trustEvidenceSource: 'source-ref-locator-fallback',
        whySelected: ['recipe-locator:search-hit-source-ref-backfill'],
      },
    ];
    const material = buildPrimeKnowledgeMaterial({ ...baseInput, regionEvidence: backfill });

    const accepted = material.acceptedKnowledge.find((item) => item.id === 'r-hit');
    expect(accepted).toBeDefined();
    expect(accepted?.trustEvidence.kind).toBe('recipe-locator');
    expect(accepted?.trustEvidence.source).toBe('source-ref-locator-fallback');
  });

  test('weak matches below the trust floor drop to requires-verification, not trusted-to-use (Wave 3)', () => {
    const mk = (id: string, score: number) => ({
      evidenceRefs: [`recipe-locator:${id}`],
      injectionStatus: 'selected',
      itemId: id,
      kind: 'pattern',
      recipeId: id,
      score: 1,
      sourceRefs: [`Alembic/lib/x/${id}.ts:1-10`],
      title: `recipe ${id}`,
      trustEvidenceSource: 'source-ref-locator-fallback',
      whySelected: ['recipe-locator:search-hit-source-ref-backfill'],
    });
    // item 检索分决定信任层：0.9 相关 / 0.37 弱相关（真机 fix-daemon 形态）
    const searchResult = {
      relatedKnowledge: [
        {
          id: 'strong',
          title: 'strong',
          content: '',
          kind: 'pattern',
          language: 'typescript',
          score: 0.9,
          sourceRefs: [],
        },
        {
          id: 'weak',
          title: 'weak',
          content: '',
          kind: 'pattern',
          language: 'typescript',
          score: 0.37,
          sourceRefs: [],
        },
      ],
      guardRules: [],
      searchMeta: {
        queries: ['q'],
        scenario: 'prime',
        language: null,
        module: null,
        resultCount: 2,
        filteredCount: 2,
      },
    };
    const material = buildPrimeKnowledgeMaterial({
      ...baseInput,
      searchResult: searchResult as never,
      regionEvidence: [mk('strong', 0.9), mk('weak', 0.37)],
    });
    expect(material.acceptedKnowledge.map((k) => k.id)).toEqual(['strong']);
    expect(material.weakMatches.map((k) => k.id)).toEqual(['weak']);
    const verification = material.trustPosture.receiptChecklist.find(
      (layer) => layer.layer === 'requires-verification'
    );
    expect(verification?.items.some((item) => item.id === 'weak-match:weak')).toBe(true);
  });

  test('weak or unanchored Guard rules never become trusted-to-obey', () => {
    const rule = (id: string, score: number, sourceRefs: string[]) => ({
      id,
      title: id,
      trigger: `@${id}`,
      content: '',
      description: '',
      kind: 'rule',
      language: 'typescript',
      score,
      sourceRefs,
    });
    const material = buildPrimeKnowledgeMaterial({
      ...baseInput,
      searchResult: {
        relatedKnowledge: [],
        guardRules: [
          rule('strong-rule', 0.86, ['lib/strong.ts:1-10']),
          rule('weak-rule', 0.37, ['lib/weak.ts:1-10']),
          rule('unanchored-rule', 0.91, []),
        ],
        searchMeta: {
          queries: ['q'],
          scenario: 'prime',
          language: null,
          module: null,
          resultCount: 3,
          filteredCount: 3,
        },
      } as never,
      regionEvidence: [],
    });

    expect(material.acceptedGuards.map((guard) => guard.id)).toEqual(['strong-rule']);
    const obey = material.trustPosture.receiptChecklist.find(
      (layer) => layer.layer === 'trusted-to-obey'
    );
    expect(obey?.items.map((item) => item.id)).toEqual(['guard:strong-rule']);
    const verification = material.trustPosture.receiptChecklist.find(
      (layer) => layer.layer === 'requires-verification'
    );
    expect(verification?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['weak-guard:weak-rule', 'weak-guard:unanchored-rule'])
    );
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
