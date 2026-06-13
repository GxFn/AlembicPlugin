export interface KnowledgeDetail {
  contentPreview?: string;
  detailRefId: string;
  id: string;
  summary: string;
}

export interface KnowledgeDetailProvider {
  getKnowledgeDetail(refId: string): KnowledgeDetail | null;
}
