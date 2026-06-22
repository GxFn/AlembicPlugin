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
  const text = [
    item.id,
    item.title,
    item.summary,
    item.trigger,
    item.kind,
    item.language,
    item.category,
    item.contentPreview,
    ...candidateMetadataText(item.metadata),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
  const queryTerms = tokenize(input.query);
  const keywordTerms = (input.keywords ?? []).flatMap(tokenize);
  const queryHits = queryTerms.filter((term) => text.includes(term)).length;
  const keywordHits = keywordTerms.filter((term) => text.includes(term)).length;
  const itemMetadata = item.metadata ?? {};
  const languageMatch = stringFilterMatch(input.language, item.language);
  const kindMatch = !input.kind || input.kind === 'all' || stringFilterMatch(input.kind, item.kind);
  const categoryMatch = stringFilterMatch(input.category, item.category);
  const dimensionIdMatch = stringFilterMatch(
    input.dimensionId,
    metadataString(itemMetadata.dimensionId)
  );
  const knowledgeTypeMatch = stringFilterMatch(
    input.knowledgeType,
    metadataString(itemMetadata.knowledgeType)
  );
  const scopeMatch = stringFilterMatch(input.scope, metadataString(itemMetadata.scope));
  const tagsMatch = tagFilterMatch(input.tags, metadataStringArray(itemMetadata.tags));
  const filterMatch =
    languageMatch &&
    kindMatch &&
    categoryMatch &&
    dimensionIdMatch &&
    knowledgeTypeMatch &&
    scopeMatch &&
    tagsMatch;
  const baseScore = typeof item.score === 'number' ? item.score : 0;
  const derivedScore = baseScore + queryHits * 0.08 + keywordHits * 0.05;
  const whyMatched = [
    ...(item.whyMatched ?? []),
    ...(queryHits > 0 ? [`query:${queryHits}`] : []),
    ...(keywordHits > 0 ? [`keywords:${keywordHits}`] : []),
    ...(filterMatch ? filterMatchLabels(input) : []),
  ];
  return {
    ...item,
    score: Number(derivedScore.toFixed(6)),
    scoreBreakdown: {
      ...(item.scoreBreakdown ?? {}),
      baseScore,
      categoryMatch,
      dimensionIdMatch,
      filterMatch,
      keywordHits,
      knowledgeTypeMatch,
      kindMatch,
      languageMatch,
      queryHits,
      scopeMatch,
      tagsMatch,
    },
    whyMatched: whyMatched.length > 0 ? Array.from(new Set(whyMatched)) : ['candidate-pool'],
  };
}

function candidateMetadataText(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }
  return [
    metadata.category,
    metadata.dimensionId,
    metadata.knowledgeType,
    metadata.scope,
    metadata.sourceFile,
    ...stringArray(metadata.sourceRefs),
    ...stringArray(metadata.tags),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function stringFilterMatch(filter: string | undefined, value: string | undefined): boolean {
  return filter === undefined || value?.toLowerCase() === filter.toLowerCase();
}

function tagFilterMatch(filters: readonly string[] | undefined, tags: readonly string[]): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  const normalizedTags = new Set(tags.map((tag) => tag.toLowerCase()));
  return filters.some((filter) => normalizedTags.has(filter.toLowerCase()));
}

function filterMatchLabels(input: KnowledgeRetrievalProviderSearchInput): string[] {
  return [
    input.category === undefined ? undefined : 'filter:category',
    input.dimensionId === undefined ? undefined : 'filter:dimensionId',
    input.kind === undefined || input.kind === 'all' ? undefined : 'filter:kind',
    input.knowledgeType === undefined ? undefined : 'filter:knowledgeType',
    input.language === undefined ? undefined : 'filter:language',
    input.scope === undefined ? undefined : 'filter:scope',
    input.tags === undefined || input.tags.length === 0 ? undefined : 'filter:tags',
  ].filter((value): value is string => typeof value === 'string');
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function metadataStringArray(value: unknown): string[] {
  return stringArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [])
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 40);
}
