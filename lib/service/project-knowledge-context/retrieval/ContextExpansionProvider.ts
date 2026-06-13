import type { KnowledgeDetailProvider } from './KnowledgeDetailProvider.js';

export interface ExpandedKnowledgeContext {
  contentPreview: string;
  detailRefs: string[];
  refId: string;
  summary?: string;
}

export interface ContextExpansionProvider {
  expandContext(refId: string, contentCharLimit: number): ExpandedKnowledgeContext | null;
}

export class DefaultContextExpansionProvider implements ContextExpansionProvider {
  constructor(private readonly detailProvider: KnowledgeDetailProvider) {}

  expandContext(refId: string, contentCharLimit: number): ExpandedKnowledgeContext | null {
    const detail = this.detailProvider.getKnowledgeDetail(refId);
    if (!detail) {
      return null;
    }
    return {
      contentPreview: trimText(detail.contentPreview ?? detail.summary, contentCharLimit),
      detailRefs: [detail.detailRefId],
      refId: detail.id,
      summary: detail.summary,
    };
  }
}

function trimText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
