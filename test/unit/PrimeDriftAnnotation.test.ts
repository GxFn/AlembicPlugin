/**
 * D5(2026-07-11,P-D 活体矩阵登记):prime 面 drift 标注对称回归。
 * search 面(P1)已带 sourceRefStatus+drifted 降权,prime 面此前漂移盲——
 * 同一 Recipe 的漂移锚点以无标记 trusted 证据交付。本测锁:
 * ①accepted item 携带 sourceRefStatus;②evidenceRefs 逐条 drifted 标记
 * (原串集合匹配);③trusted-to-use 回执 reason 提醒重核;④不改信任分层
 * (drifted item 仍在 acceptedKnowledge,不被降级/剔除)。
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

// 信任门需要 locator 证据(与 P-1 backfill 同形);drift 标注不参与信任判定。
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
  test('drifted Recipe:item 级状态+evidenceRefs 逐条标记+trusted-to-use 提醒', () => {
    const material = buildPrimeKnowledgeMaterial({
      requirement,
      searchDegraded: false,
      searchResult: buildDriftedSearchResult(),
      regionEvidence,
      taskAnchorDecision,
    });

    const accepted = material.acceptedKnowledge.find((item) => item.id === 'r-drift');
    expect(accepted).toBeDefined();
    // ④仍在 trusted 集合(漂移≠错误,不改信任分层)。
    expect(material.status).toBe('delivered');
    // ①item 级聚合态。
    expect(accepted?.sourceRefStatus).toBe('drifted');
    // ②逐条标记:a.ts 区间漂移,b.ts 未漂移不带字段。
    const refA = accepted?.evidenceRefs.find((ref) => ref.path === 'lib/feed/a.ts');
    const refB = accepted?.evidenceRefs.find((ref) => ref.path === 'lib/feed/b.ts');
    expect(refA).toMatchObject({ line: 10, endLine: 20, drifted: true });
    expect(refB?.drifted).toBeUndefined();
    // ③trusted-to-use 回执 reason 带重核提醒。
    const trustedLayer = material.trustPosture.receiptChecklist.find(
      (layer) => layer.layer === 'trusted-to-use'
    );
    const postureItem = trustedLayer?.items.find((item) => item.id === 'knowledge:r-drift');
    expect(postureItem?.reason).toContain('re-verify file:line');
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
