export interface ExpandedKnowledgeContext {
  contentPreview: string;
  detailRefs: string[];
  refId: string;
}

export interface ContextExpansionProvider {
  expandContext(refId: string, contentCharLimit: number): ExpandedKnowledgeContext | null;
}
