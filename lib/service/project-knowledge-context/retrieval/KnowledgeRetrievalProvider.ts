export interface KnowledgeRetrievalItem {
  id: string;
  kind?: string;
  score?: number;
  summary: string;
  title: string;
}

export interface KnowledgeRetrievalProvider {
  searchKnowledge(query: string, limit: number): KnowledgeRetrievalItem[];
}
