import type { KnowledgeRetrievalItem } from './KnowledgeRetrievalProvider.js';

export interface SearchProvider {
  search(query: string, limit: number): KnowledgeRetrievalItem[];
}
