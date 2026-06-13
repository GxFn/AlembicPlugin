import type {
  KnowledgeRetrievalItem,
  KnowledgeRetrievalProviderSearchInput,
} from './KnowledgeRetrievalProvider.js';

export interface RecipeCandidateProvider {
  listRecipeCandidates(
    input: KnowledgeRetrievalProviderSearchInput | string,
    limit?: number
  ): KnowledgeRetrievalItem[];
}

export class DefaultRecipeCandidateProvider implements RecipeCandidateProvider {
  constructor(private readonly items: readonly KnowledgeRetrievalItem[] = []) {}

  listRecipeCandidates(
    input: KnowledgeRetrievalProviderSearchInput | string,
    limit = 20
  ): KnowledgeRetrievalItem[] {
    const normalized = normalizeCandidateInput(input, limit);
    return this.items
      .map((item) => scoreCandidate(item, normalized))
      .filter((item) => item.scoreBreakdown?.filterMatch !== false)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
      .slice(0, normalized.limit);
  }
}

export function normalizeCandidateInput(
  input: KnowledgeRetrievalProviderSearchInput | string,
  limit = 20
): Required<Pick<KnowledgeRetrievalProviderSearchInput, 'limit' | 'query'>> &
  Omit<KnowledgeRetrievalProviderSearchInput, 'limit' | 'query'> {
  if (typeof input === 'string') {
    return { query: input, limit };
  }
  return {
    ...input,
    query: input.query,
    limit: input.limit ?? limit,
  };
}

export function scoreCandidate(
  item: KnowledgeRetrievalItem,
  input: KnowledgeRetrievalProviderSearchInput
): KnowledgeRetrievalItem {
  const text = [item.id, item.title, item.summary, item.trigger, item.kind, item.language]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
  const queryTerms = tokenize(input.query);
  const keywordTerms = (input.keywords ?? []).flatMap(tokenize);
  const sourceRefs = input.sourceRefs ?? [];
  const itemRefs = [item.id, item.detailRefId, ...(item.relationRefs ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  const queryHits = queryTerms.filter((term) => text.includes(term)).length;
  const keywordHits = keywordTerms.filter((term) => text.includes(term)).length;
  const sourceRefHits = sourceRefs.filter((ref) => itemRefs.includes(ref)).length;
  const languageMatch =
    input.language === undefined || item.language === undefined || item.language === input.language;
  const kindMatch = !input.kind || input.kind === 'all' || item.kind === input.kind;
  const categoryMatch =
    input.category === undefined || item.category === undefined || item.category === input.category;
  const filterMatch = languageMatch && kindMatch && categoryMatch;
  const baseScore = typeof item.score === 'number' ? item.score : 0;
  const derivedScore = baseScore + queryHits * 0.08 + keywordHits * 0.05 + sourceRefHits * 0.1;
  const whyMatched = [
    ...(item.whyMatched ?? []),
    ...(queryHits > 0 ? [`query:${queryHits}`] : []),
    ...(keywordHits > 0 ? [`keywords:${keywordHits}`] : []),
    ...(sourceRefHits > 0 ? [`sourceRefs:${sourceRefHits}`] : []),
    ...(input.activeFile ? ['activeFile-hint'] : []),
    ...(input.module ? ['module-hint'] : []),
  ];
  return {
    ...item,
    score: Number(derivedScore.toFixed(6)),
    scoreBreakdown: {
      ...(item.scoreBreakdown ?? {}),
      baseScore,
      categoryMatch,
      filterMatch,
      keywordHits,
      kindMatch,
      languageMatch,
      queryHits,
      sourceRefHits,
    },
    whyMatched: whyMatched.length > 0 ? Array.from(new Set(whyMatched)) : ['candidate-pool'],
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 40);
}
