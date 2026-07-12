/**
 * D5(2026-07-11,P-D 活体矩阵登记):prime 面 drift 标注对称回归。
 * search 面(P1)已带 sourceRefStatus+drifted 降权,prime 面此前漂移盲——
 * 同一 Recipe 的漂移锚点以无标记 trusted 证据交付。本测锁:
 * 漂移 Recipe 即使仍有 locator，也只能保留为 requires-verification 候选，
 * 不能进入 acceptedKnowledge / trusted-to-use。
 */
import { describe, expect, test } from 'vitest';
import { buildPrimeKnowledgeMaterial } from '../../lib/service/task/PrimeKnowledgeMaterial.js';

const requirement = {
  userQuery: 'refactor feed module',
  queries: ['refactor feed module'],
  keywords: ['feed'],
  labels: [],
  language: null,
};

const taskAnchorDecision = {
  action: 'skip' as const,
  confidence: 'low' as const,
  reasonCode: 'readonly-no-anchor' as const,
};

function buildDriftedSearchResult() {
  return {
    relatedKnowledge: [
      {
        id: 'r-drift',
        title: 'Feed 模块分层约定',
        trigger: 'feed-layering',
        kind: 'pattern',
        language: 'typescript',
        score: 0.8,
        description: 'Feed 模块的分层约定',
        sourceRefs: ['lib/feed/a.ts:10-20', 'lib/feed/b.ts:5'],
        driftedSourceRefs: ['lib/feed/a.ts:10-20'],
        sourceRefStatus: 'drifted' as const,
      },
    ],
    guardRules: [],
    searchMeta: {
      queries: ['refactor feed module'],
      scenario: 'implement',
      language: null,
      module: null,
      resultCount: 1,
      filteredCount: 0,
    },
  };
}

// 信任门需要 locator 证据(与 P-1 backfill 同形)，但 locator 不能覆盖漂移状态。
const regionEvidence = [
  {
    evidenceRefs: ['recipe-locator:r-drift'],
    injectionStatus: 'selected',
    itemId: 'r-drift',
    recipeId: 'r-drift',
    score: 1,
    whySelected: ['recipe-locator:search-hit-source-ref-backfill'],
  },
];

describe('prime drift 标注对称(D5)', () => {
  test('drifted Recipe stays visible for verification but never becomes trusted-to-use', () => {
    const material = buildPrimeKnowledgeMaterial({
      requirement,
      searchDegraded: false,
      searchResult: buildDriftedSearchResult(),
      regionEvidence,
      taskAnchorDecision,
    });

    expect(material.acceptedKnowledge).toHaveLength(0);
    const trustedLayer = material.trustPosture.receiptChecklist.find(
      (layer) => layer.layer === 'trusted-to-use'
    );
    expect(trustedLayer?.items).toHaveLength(0);
    const verificationLayer = material.trustPosture.receiptChecklist.find(
      (layer) => layer.layer === 'requires-verification'
    );
    const candidate = verificationLayer?.items.find(
      (item) => item.id === 'source-status-candidate:r-drift'
    );
    expect(candidate).toMatchObject({ status: 'drifted' });
    expect(candidate?.evidenceRefs?.find((ref) => ref.path === 'lib/feed/a.ts')).toMatchObject({
      line: 10,
      endLine: 20,
      drifted: true,
    });
  });

  test('active Recipe:透传 active 状态,evidenceRefs 无 drifted 字段', () => {
    const searchResult = buildDriftedSearchResult();
    const [item] = searchResult.relatedKnowledge;
    if (item) {
      item.sourceRefStatus = 'active' as never;
      (item as { driftedSourceRefs?: string[] }).driftedSourceRefs = undefined;
    }
    const material = buildPrimeKnowledgeMaterial({
      requirement,
      searchDegraded: false,
      searchResult,
      regionEvidence,
      taskAnchorDecision,
    });
    const accepted = material.acceptedKnowledge.find((entry) => entry.id === 'r-drift');
    expect(accepted?.sourceRefStatus).toBe('active');
    expect(accepted?.evidenceRefs.every((ref) => ref.drifted === undefined)).toBe(true);
  });
});
