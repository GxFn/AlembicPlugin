import type { KnowledgeRetrievalItem } from './KnowledgeRetrievalProvider.js';

export interface RecipeCandidateProvider {
  listRecipeCandidates(query: string, limit: number): KnowledgeRetrievalItem[];
}
