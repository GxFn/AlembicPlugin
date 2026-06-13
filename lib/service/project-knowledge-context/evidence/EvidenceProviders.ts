import type { KnowledgeContextDetailRef, KnowledgeContextSource } from '../contracts/index.js';

export interface SourceEvidenceProvider {
  listSourceEvidenceRefs(sourceRefs: readonly string[]): KnowledgeContextSource[];
}

export interface DocumentContextProvider {
  resolveDocumentRefs(sourceRefs: readonly string[]): KnowledgeContextDetailRef[];
}

export interface EvidenceLinkProvider {
  createEvidenceLink(ref: string): KnowledgeContextDetailRef | null;
}
