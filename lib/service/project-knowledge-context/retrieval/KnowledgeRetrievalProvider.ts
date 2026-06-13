export interface KnowledgeRetrievalItem {
  category?: string;
  contentPreview?: string;
  detailRefId?: string;
  id: string;
  kind?: string;
  language?: string;
  metadata?: Record<string, unknown>;
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
  activeFile?: string;
  category?: string;
  kind?: string;
  keywords?: readonly string[];
  language?: string;
  limit?: number;
  module?: string;
  query: string;
  sourceRefs?: readonly string[];
}

export interface KnowledgeRetrievalProvider {
  searchKnowledge(
    input: KnowledgeRetrievalProviderSearchInput | string,
    limit?: number
  ): KnowledgeRetrievalItem[];
}
