import type { KnowledgeRetrievalItem } from './KnowledgeRetrievalProvider.js';

export interface VectorRerankProvider {
  rerank(
    query: string,
    items: readonly KnowledgeRetrievalItem[],
    limit: number
  ): KnowledgeRetrievalItem[];
}
