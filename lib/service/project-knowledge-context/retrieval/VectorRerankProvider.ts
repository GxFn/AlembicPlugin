import type { KnowledgeRetrievalItem } from './KnowledgeRetrievalProvider.js';

export interface VectorRerankProvider {
  rerank(
    query: string,
    items: readonly KnowledgeRetrievalItem[],
    limit: number,
    evidence?: VectorRerankEvidence
  ): KnowledgeRetrievalItem[];
}

export interface VectorRerankEvidence {
  residentVector?: Record<string, unknown> | null;
  scoreBreakdown?: readonly Record<string, unknown>[];
  semanticUsed?: boolean;
  vectorAvailable?: boolean;
  vectorUsed?: boolean;
}

export class DefaultVectorRerankProvider implements VectorRerankProvider {
  rerank(
    _query: string,
    items: readonly KnowledgeRetrievalItem[],
    limit: number,
    evidence: VectorRerankEvidence = {}
  ): KnowledgeRetrievalItem[] {
    const scoreById = new Map(
      (evidence.scoreBreakdown ?? [])
        .map((entry) => {
          const id = typeof entry.itemId === 'string' ? entry.itemId : undefined;
          const finalScore = typeof entry.finalScore === 'number' ? entry.finalScore : undefined;
          return id && finalScore !== undefined ? ([id, finalScore] as const) : null;
        })
        .filter((entry): entry is readonly [string, number] => entry !== null)
    );
    return items
      .map((item) => {
        const vectorScore = scoreById.get(item.id);
        const baseScore = typeof item.score === 'number' ? item.score : 0;
        const score = vectorScore ?? baseScore;
        return {
          ...item,
          score,
          scoreBreakdown: {
            ...(item.scoreBreakdown ?? {}),
            vectorEvidence: vectorScore ?? null,
            vectorUsed: evidence.vectorUsed ?? evidence.semanticUsed ?? false,
          },
          vector: {
            ...(item.vector ?? {}),
            available: evidence.vectorAvailable ?? readBoolean(evidence.residentVector?.available),
            residentVector: evidence.residentVector ?? undefined,
            semanticUsed: evidence.semanticUsed ?? false,
            used: evidence.vectorUsed ?? false,
          },
          whyMatched: [
            ...(item.whyMatched ?? []),
            ...(vectorScore === undefined ? [] : ['vector-rerank']),
          ],
        };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
