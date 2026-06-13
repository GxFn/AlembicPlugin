import type { KnowledgeRetrievalItem } from './KnowledgeRetrievalProvider.js';

export interface KnowledgeDetail {
  contentPreview?: string;
  detailRefId: string;
  id: string;
  kind?: string;
  language?: string;
  summary: string;
  title?: string;
}

export interface KnowledgeDetailProvider {
  getKnowledgeDetail(refId: string): KnowledgeDetail | null;
}

export class DefaultKnowledgeDetailProvider implements KnowledgeDetailProvider {
  constructor(private readonly items: readonly KnowledgeRetrievalItem[] = []) {}

  getKnowledgeDetail(refId: string): KnowledgeDetail | null {
    const normalized = stripKnowledgePrefix(stripDetailPrefix(refId));
    const item = this.items.find(
      (candidate) =>
        candidate.id === refId ||
        candidate.id === normalized ||
        candidate.detailRefId === refId ||
        candidate.detailRefId === normalized
    );
    if (!item) {
      return null;
    }
    return {
      contentPreview: item.contentPreview ?? item.summary,
      detailRefId: item.detailRefId ?? `knowledge:${item.id}`,
      id: item.id,
      kind: item.kind,
      language: item.language,
      summary: item.summary,
      title: item.title,
    };
  }
}

function stripKnowledgePrefix(refId: string): string {
  return refId.startsWith('knowledge:') ? refId.slice('knowledge:'.length) : refId;
}

function stripDetailPrefix(refId: string): string {
  return refId.startsWith('detail:') ? refId.slice('detail:'.length) : refId;
}
