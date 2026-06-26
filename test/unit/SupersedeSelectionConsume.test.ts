/**
 * Supersede 选择消费契约（U5 #7 consumer/verify）
 *
 * 背景：U5-Core ProposalExecutor.#selectMostSimilarReplacement 在 supersede 时从
 * relatedRecipeIds 中选「与被替代 Recipe 加权 5 维相似度最高」的新建项作为 deprecated_by
 * 目标（而非旧的 relatedRecipeIds[0]）。该选择是 Core 内部私有方法，由 Core 单测
 * （ProposalExecutorBounding.test.ts）直接覆盖；Plugin 只消费 executor 写出的 deprecated_by 边
 * （RecipeRelationChainProvider 按 relationType=deprecated_by 读取）。
 *
 * 本测试是 Plugin 侧「消费契约」验证：用 Core 公开的、同样基于 RecipeSimilarity 加权 5 维的
 * RedundancyAnalyzer.analyzePair（其 similarity 与 #selectMostSimilarReplacement 用的
 * RecipeSimilarity.compute 同源加权）证明「≥2 候选时相似度最高者胜出，且未必是数组第一个」。
 *
 * 注：RedundancyAnalyzer.analyzePair 仅在综合相似度 ≥0.65 时返回结果，否则 null。
 * 故近义候选构造为真正的近重复（清晰 ≥0.65），远候选低于阈值（null→视作 0），
 * argmax 干净地选中近义候选。真机端到端 supersede（proposal→executor→边）受 metrics/decayScore
 * 量纲限制（见 tr-u5-core 风险①），归后续 Test/U7；本处为消费侧契约证据。
 */

import { RedundancyAnalyzer } from '@alembic/core/evolution';
import { describe, expect, it } from 'vitest';

/**
 * 用 Core 公开 RecipeSimilarity 加权（经 RedundancyAnalyzer.analyzePair）给一对 Recipe 打分。
 * analyzePair 在 <0.65 时返回 null；这里把 null 归一为 0（低于冗余阈值＝可忽略的低相似），
 * 足以让「近义（≥0.65）vs 远（<0.65）」的 argmax 排序成立。
 */
function weightedSimilarity(a: unknown, b: unknown): number {
  const analyzer = new RedundancyAnalyzer({ findAllByLifecycles: async () => [] } as never);
  return analyzer.analyzePair(a as never, b as never)?.similarity ?? 0;
}

describe('supersede selection consume — most-similar wins, not createdIds[0]', () => {
  // 被替代的旧 Recipe。
  const superseded = {
    id: 'old',
    title: 'Invalidate NSTimer in dealloc method to avoid retain cycles',
    doClause: 'Always invalidate NSTimer in dealloc to prevent retain cycles',
    dontClause: 'Do not keep a strong timer reference past dealloc',
    coreCode: '[self.timer invalidate]; self.timer = nil;',
    guardPattern: 'timer invalidate',
    content: { markdown: 'Invalidate the repeating NSTimer in dealloc.' },
  };

  // 候选 1（createdIds[0]）：与旧 Recipe 关系较远（不同主题：网络缓存）→ <0.65。
  const candidateFirstButFar = {
    id: 'new-far',
    title: 'Configure URLCache for network responses',
    doClause: 'Set up a shared URLCache to cache HTTP responses',
    dontClause: 'Do not cache sensitive payloads',
    coreCode: 'URLCache.shared = URLCache()',
    guardPattern: null,
    content: { markdown: 'Cache network responses.' },
  };

  // 候选 2（createdIds[1]）：与旧 Recipe 近重复（NSTimer 失效）→ ≥0.65。
  const candidateSecondButNear = {
    id: 'new-near',
    title: 'Invalidate NSTimer in dealloc method required to avoid retain cycles',
    doClause: 'Always invalidate NSTimer in dealloc to prevent retain cycles',
    dontClause: 'Do not keep a strong timer reference past dealloc',
    coreCode: '[self.timer invalidate]; self.timer = nil;',
    guardPattern: 'timer invalidate',
    content: { markdown: 'Invalidate the repeating NSTimer in dealloc.' },
  };

  it('ranks the near candidate strictly above the far candidate', () => {
    const simFar = weightedSimilarity(superseded, candidateFirstButFar);
    const simNear = weightedSimilarity(superseded, candidateSecondButNear);
    expect(simNear).toBeGreaterThan(simFar);
    expect(simNear).toBeGreaterThanOrEqual(0.65);
  });

  it('argmax over relatedRecipeIds selects the second one, not createdIds[0]', () => {
    // 模拟 executor #selectMostSimilarReplacement 的 argmax：候选数组首个是远候选。
    const related = [candidateFirstButFar, candidateSecondButNear];
    let bestId = related[0].id;
    let best = -1;
    for (const cand of related) {
      const s = weightedSimilarity(superseded, cand);
      if (s > best) {
        best = s;
        bestId = cand.id;
      }
    }
    expect(bestId).toBe('new-near');
    expect(bestId).not.toBe(related[0].id); // 关键：不是 createdIds[0]
  });
});
