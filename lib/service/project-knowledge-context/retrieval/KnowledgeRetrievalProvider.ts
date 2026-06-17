export interface KnowledgeRetrievalItem {
  category?: string;
  contentPreview?: string;
  detailRefId?: string;
  id: string;
  kind?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  relations?: unknown;
  relationRefs?: string[];
  resident?: Record<string, unknown>;
  score?: number;
  scoreBreakdown?: Record<string, unknown>;
  summary: string;
  title: string;
  trigger?: string;
  vector?: Record<string, unknown>;
  whyMatched?: string[];
}

export interface KnowledgeRetrievalProviderSearchInput {
  category?: string;
  dimensionId?: string;
  kind?: string;
  knowledgeType?: string;
  keywords?: readonly string[];
  language?: string;
  limit?: number;
  query: string;
  scope?: string;
  tags?: readonly string[];
}

export interface KnowledgeRetrievalProvider {
  searchKnowledge(
    input: KnowledgeRetrievalProviderSearchInput | string,
    limit?: number
  ): KnowledgeRetrievalItem[];
}
