/**
 * CrossEncoderReranker — deterministic search reranker.
 *
 * Local LLM scoring has been removed from AlembicPlugin. This adapter keeps
 * the SearchCrossEncoder contract and ranks with token overlap only.
 */

import type { SearchCrossEncoder, SearchResultItem } from '@alembic/core/search';
import { jaccardSimilarity, tokenize } from '@alembic/core/search';

interface RerankCandidate extends SearchResultItem {
  title?: string;
  trigger?: string;
  description?: string;
  summary?: string;
  code?: string;
  content?: string;
  semanticScore?: number;
  [key: string]: unknown;
}

export class CrossEncoderReranker implements SearchCrossEncoder {
  async rerank(query: string, candidates: SearchResultItem[]): Promise<SearchResultItem[]> {
    const rerankCandidates = candidates as RerankCandidate[];
    if (!candidates || candidates.length === 0) {
      return [];
    }
    if (!query) {
      return candidates;
    }
    return this.#jaccardFallback(query, rerankCandidates);
  }

  #extractDocText(candidate: RerankCandidate) {
    const parts = [
      candidate.title,
      candidate.trigger,
      candidate.description || candidate.summary,
      candidate.code,
      candidate.content,
    ].filter(Boolean);
    return parts.join(' | ');
  }

  #jaccardFallback(query: string, candidates: RerankCandidate[]) {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) {
      return candidates;
    }

    return candidates
      .map((candidate: RerankCandidate) => {
        const text = this.#extractDocText(candidate);
        const docTokens = new Set(tokenize(text));
        const score = jaccardSimilarity(queryTokens, docTokens);
        return { ...candidate, semanticScore: score };
      })
      .sort((a, b) => b.semanticScore - a.semanticScore);
  }
}
