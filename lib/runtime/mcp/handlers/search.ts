/**
 * MCP Handlers — 搜索类
 *
 * v2: 将 search / contextSearch / keywordSearch / semanticSearch
 * 收束到 search() 入口，通过 mode 参数路由。
 * tool-router.ts 的 mode 路由直接指向本函数。
 *
 * 设计原则：
 * 1. 通过 container.get('searchEngine') 获取 singleton 实例（含 vectorStore + aiProvider）
 * 2. 统一 responseTime、byKind 分组、kind 过滤
 * 3. 投影使用 SearchTypes.slimSearchResult()（消除 3 处重复投影）
 */

import { groupByKind, slimSearchResult } from '@alembic/core/search';
import { resolveProjectRoot } from '@alembic/core/workspace';
import {
  DefaultContextExpansionProvider,
  DefaultKnowledgeDetailProvider,
  DefaultRecipeCandidateProvider,
  DefaultRecipeRelationChainProvider,
  DefaultVectorRerankProvider,
  defaultProjectKnowledgeContextLayer,
  defaultRefRegistry,
  type KnowledgeContextDetailRef,
  type KnowledgeContextNextAction,
  type KnowledgeContextProjectionPayload,
  type KnowledgeContextSource,
  type KnowledgeRetrievalItem,
  stableRefSegment,
  type VectorRerankEvidence,
} from '#service/project-knowledge-context/index.js';
import type { ResidentSearchClient } from '#service/resident/AlembicResidentCapabilityClients.js';
import type {
  ResidentSearchAttemptMeta,
  ResidentSearchRequest,
} from '#service/resident/AlembicResidentServiceClient.js';
import {
  buildHostIntentFrame,
  buildResidentIntentHandoff,
  prepareHostIntentInput,
} from '#service/task/HostIntentFrame.js';
import { extract as extractIntent } from '#service/task/IntentExtractor.js';
import type {
  KnowledgeEntryJSON,
  McpContext,
  SearchArgs,
  SearchResultItem,
} from '../../../runtime/mcp/handlers/types.js';

// ─── 工具函数 ────────────────────────────────────────────────

/**
 * 获取 SearchEngine singleton（带 vectorStore + aiProvider）
 * 避免每次调用 new SearchEngine(db) —— 那样没有向量能力、每次重建索引
 */
function getSearchEngine(ctx: McpContext) {
  try {
    return ctx.container.get('searchEngine');
  } catch {
    // 降级：直接创建基础实例（无向量能力）
    return null;
  }
}

function getResidentSearchClient(ctx: McpContext): ResidentSearchClient | null {
  try {
    return ctx.container.get('residentSearchClient') as ResidentSearchClient;
  } catch {
    // Test and HTTP compatibility contexts may still expose the older internal key.
  }
  try {
    return ctx.container.get('residentServiceClient') as ResidentSearchClient;
  } catch {
    return null;
  }
}

/** 降级创建 SearchEngine（仅在 container 无法提供时） */
async function getFallbackEngine(ctx: McpContext) {
  const { SearchEngine } = await import('@alembic/core/search');
  const db = ctx.container.get('database');
  const knowledgeRepo = ctx.container.get('knowledgeRepository');
  const sourceRefRepo = ctx.container.get('recipeSourceRefRepository');
  return new SearchEngine(db, { knowledgeRepo, sourceRefRepo } as Record<string, unknown>);
}

/** 根据 kind 参数过滤 items */
function filterByKind(items: SearchResultItem[], kind: string) {
  if (!kind || kind === 'all') {
    return items;
  }
  return items.filter(
    (it: SearchResultItem) => (it.kind || it.metadata?.kind || 'pattern') === kind
  );
}

// ─── 统一搜索入口 ────────────────────────────────────────────

/**
 * 统一搜索入口 — 支持 auto / keyword / weighted / semantic / context 五种模式
 *
 * search / contextSearch / keywordSearch / semanticSearch 共享本入口。
 * mode 路由:
 *   - auto (默认): FieldWeighted + semantic 融合 + Ranking Pipeline
 *   - keyword: SQL LIKE 精确匹配，适合已知函数名/类名
 *   - weighted: 加权字段评分搜索（原 bm25 模式，已替换为 FieldWeightedScorer）
 *   - bm25: weighted 的向后兼容别名
 *   - semantic: 向量语义搜索（不可用时降级 weighted）
 *   - context: weighted + Ranking Pipeline + 会话上下文加成
 *
 * 所有模式共享: kind 过滤 → slimSearchResult 投影 → byKind 分组
 */
export async function search(ctx: McpContext, args: SearchArgs) {
  const operation = normalizeSearchOperation(args.operation);
  if (operation === 'get' || operation === 'expand') {
    return projectDetailOperation(ctx, args, operation);
  }
  const projectRoot = resolveSearchProjectRoot(ctx, args);
  const pipeline = await runSearchPipeline(ctx, args);
  const candidateItems = await buildKnowledgeCandidates(ctx, args, pipeline);
  const relevance = assessSearchRelevance(candidateItems, args, pipeline);
  const knowledgeItems = relevance.items;
  const relationProvider = new DefaultRecipeRelationChainProvider();
  const relationChains = knowledgeItems.flatMap((item) =>
    relationProvider.expandRecipeRelationChains(item.id, relationHopLimit(args), {
      fanout: relationFanout(args),
      items: knowledgeItems.map(knowledgeItemToRecord),
    })
  );
  const detailRefs = knowledgeItems.map((item) =>
    createKnowledgeDetailRef(item, 'search', false, args)
  );
  const sources = knowledgeItems.map((item, index) =>
    createKnowledgeSource(item, detailRefs[index]?.id)
  );
  const payload: KnowledgeContextProjectionPayload = {
    detailRefs,
    inventory: {
      candidateCount: candidateItems.length,
      candidateSources: pipeline.residentAttempt?.meta.available
        ? ['resident-search', 'embedded-search']
        : ['embedded-search'],
      kindCounts: pipeline.kindCounts,
      noTrustedMatch: relevance.noTrustedMatch,
      operation: 'search',
      recipeRelationCount: relationChains.length,
      trustedCandidateCount: knowledgeItems.length,
      weakCandidateCount: relevance.weakCandidateCount,
    },
    items: knowledgeItems.map(projectKnowledgeItem),
    nextActions: nextActionsForSearch(knowledgeItems, detailRefs, pipeline.query, relevance),
    relations: relationChains.map((chain) => ({ ...chain })),
    result: {
      actualMode: pipeline.actualMode,
      degraded: pipeline.degraded,
      kind: pipeline.kind === 'all' ? undefined : pipeline.kind,
      mode: pipeline.requestedMode,
      query: pipeline.query,
      residentSearch: sanitizeResidentSearchMeta(pipeline.residentAttempt?.meta),
      residentVector: sanitizeResidentVector(pipeline.searchMeta.residentVector),
      searchMeta: sanitizeSearchMeta(pipeline.searchMeta),
      searchQuality: {
        degradedReason: relevance.degradedReason,
        noTrustedMatch: relevance.noTrustedMatch,
        trustedCandidateCount: knowledgeItems.length,
        weakCandidateCount: relevance.weakCandidateCount,
      },
      totalResults: knowledgeItems.length,
      vector: {
        available: vectorAvailable(pipeline.searchMeta),
        used: vectorUsed(pipeline.searchMeta),
      },
    },
    sources,
    summary: relevance.noTrustedMatch
      ? `Knowledge search found no trusted candidate for "${pipeline.query}"; weak fallback matches were withheld.`
      : `Knowledge search found ${knowledgeItems.length} trusted candidate(s) for "${pipeline.query}".`,
  };

  return defaultProjectKnowledgeContextLayer.resolveMcpResult(
    'alembic_search',
    toKnowledgeContextSearchInput(args, {
      operation: 'search',
      query: pipeline.query,
      mode: pipeline.requestedMode,
      projectRoot,
    }),
    {
      payload,
      snapshot: {
        domainFreshness: {
          knowledge: relevance.noTrustedMatch
            ? {
                state: 'stale',
                degradedReason:
                  relevance.degradedReason ??
                  'No candidate had enough lexical, keyword, sourceRef, or semantic evidence to trust.',
              }
            : { state: 'ready' },
          recipeRelation: {
            state: relationChains.length > 0 ? 'ready' : 'stale',
            degradedReason:
              relationChains.length > 0
                ? undefined
                : 'No recipe relation chain evidence was found in the bounded candidate pool.',
          },
          vector: {
            state: vectorAvailable(pipeline.searchMeta) ? 'ready' : 'stale',
            degradedReason: vectorAvailable(pipeline.searchMeta)
              ? undefined
              : 'Vector evidence was unavailable; results used resident or embedded lexical ranking.',
          },
        },
        knowledgeItemCount: knowledgeItems.length,
        recipeRelationCount: relationChains.length,
        vectorCandidateCount: vectorUsed(pipeline.searchMeta) ? knowledgeItems.length : 0,
      },
    }
  );
}

async function runSearchPipeline(ctx: McpContext, args: SearchArgs): Promise<SearchPipelineResult> {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const residentSearchClient = getResidentSearchClient(ctx);
  const query = resolveSearchQuery(args);
  const mode = args.mode || 'auto';
  const kind = args.kind || args.type || 'all';
  const residentIntentHandoff = prepareResidentSearchHandoff(args, query);
  const execution = createSearchExecutionOptions(args, mode, kind);

  const residentAttempt = await tryResidentSearch(residentSearchClient, {
    kind,
    limit: execution.engineLimit,
    mode,
    query,
    rank: execution.rank,
    ...residentIntentHandoff,
  });

  const result = await resolveSearchResult(engine, residentAttempt, query, mode, execution);

  let items = result.items;
  const actualMode = result.mode || mode;

  // ── Kind 过滤 + 截断 ──
  items = filterByKind(items, kind);
  items = items.slice(0, execution.limit);

  // ── 统一投影: slimSearchResult() ──
  const slimItems = items.map(slimSearchResult);
  const byKindGroups = groupByKind(slimItems);
  const elapsed = Date.now() - t0;

  // ── semantic 降级提示 ──
  const degraded = mode === 'semantic' && actualMode !== 'semantic';

  const source = result.ranked ? 'search-engine+ranking' : 'search-engine';
  const searchMeta = {
    ...(result.searchMeta || {}),
    ...(residentAttempt?.meta.intentEvidence
      ? { intentEvidence: residentAttempt.meta.intentEvidence }
      : {}),
    ...(residentAttempt?.meta.primeInjectionPackage
      ? { primeInjectionPackage: residentAttempt.meta.primeInjectionPackage }
      : {}),
    ...(residentAttempt ? { residentSearch: residentAttempt.meta } : {}),
    ...(residentAttempt ? { residentVector: residentAttempt.meta.residentVector } : {}),
  };

  return {
    actualMode,
    degraded,
    elapsed,
    kind,
    kindCounts: {
      fact: byKindGroups.fact.length,
      pattern: byKindGroups.pattern.length,
      rule: byKindGroups.rule.length,
    },
    query,
    rawItems: items,
    requestedMode: mode,
    residentAttempt,
    searchMeta,
    slimItems,
    source,
  };
}

function prepareResidentSearchHandoff(
  args: SearchArgs,
  query: string
): Partial<ResidentSearchRequest> {
  const hostIntentInput = prepareHostIntentInput({
    userQuery: query,
    language: args.language,
    hostDeclaredIntent: args.hostDeclaredIntent,
    hostTurnMeta: args.hostTurnMeta,
  });
  const extractedHostIntent = extractIntent(
    hostIntentInput.userQuery,
    undefined,
    hostIntentInput.language
  );
  const handoff = buildResidentIntentHandoff({
    hostIntentFrame: buildHostIntentFrame(hostIntentInput, extractedHostIntent),
    language: args.language,
    sessionHistory: args.sessionHistory,
    sourceRefs: args.sourceRefs,
    userQuery: query,
  });
  if (!handoff) {
    return {};
  }
  return {
    confidence: handoff.confidence,
    degraded: handoff.degraded,
    degradedReason: handoff.degradedReason,
    hostDeclaredIntent: handoff.hostDeclaredIntent,
    hostTurnMeta: handoff.hostTurnMeta,
    intentContext: handoff.intentContext,
    language: handoff.language,
    scenario: handoff.scenario,
    searchIntent: handoff.searchIntent,
    sessionHistory: handoff.sessionHistory,
    sourceRefs: handoff.sourceRefs,
  };
}

interface SearchExecutionOptions {
  context?: {
    intent: 'search';
    language?: string;
    sessionHistory: unknown[];
  };
  engineLimit: number;
  isContext: boolean;
  limit: number;
  rank: boolean;
}

function createSearchExecutionOptions(
  args: SearchArgs,
  mode: string,
  kind: string
): SearchExecutionOptions {
  const isContext = mode === 'context';
  const limit = args.limit ?? (isContext ? 5 : 10);
  const recallLimit = kind !== 'all' ? limit * 2 : limit;
  return {
    context: isContext
      ? {
          intent: 'search',
          language: args.language,
          sessionHistory: args.sessionHistory || [],
        }
      : undefined,
    engineLimit: mode === 'semantic' ? recallLimit * 2 : recallLimit,
    isContext,
    limit,
    rank: mode !== 'keyword',
  };
}

async function resolveSearchResult(
  engine: {
    search: (query: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  },
  residentAttempt: { items: SearchResultItem[]; meta: ResidentSearchAttemptMeta } | null,
  query: string,
  mode: string,
  execution: SearchExecutionOptions
): Promise<SearchEnginePipelineResult> {
  if (residentAttempt?.meta.available && residentAttempt.items.length > 0) {
    return {
      items: residentAttempt.items,
      mode: residentAttempt.meta.actualMode || mode,
      ranked: false,
      searchMeta: readRecord(residentAttempt.meta.searchMeta),
    };
  }
  const result = await engine.search(query, {
    mode: execution.isContext ? 'bm25' : mode,
    limit: execution.engineLimit,
    rank: execution.rank,
    groupByKind: true,
    context: execution.context,
  });
  return normalizeSearchEnginePipelineResult(result);
}

interface SearchEnginePipelineResult {
  items: SearchResultItem[];
  mode?: string;
  ranked?: boolean;
  searchMeta?: Record<string, unknown>;
}

function normalizeSearchEnginePipelineResult(
  result: Record<string, unknown>
): SearchEnginePipelineResult {
  return {
    items: Array.isArray(result.items) ? (result.items as SearchResultItem[]) : [],
    mode: readString(result.mode),
    ranked: readBoolean(result.ranked),
    searchMeta: readRecord(result.searchMeta),
  };
}

interface SearchPipelineResult {
  actualMode: string;
  degraded: boolean;
  elapsed: number;
  kind: string;
  kindCounts: Record<string, number>;
  query: string;
  rawItems: SearchResultItem[];
  requestedMode: string;
  residentAttempt: { items: SearchResultItem[]; meta: ResidentSearchAttemptMeta } | null;
  searchMeta: Record<string, unknown>;
  slimItems: Array<ReturnType<typeof slimSearchResult>>;
  source: string;
}

async function projectDetailOperation(
  ctx: McpContext,
  args: SearchArgs,
  operation: 'get' | 'expand'
) {
  const projectRoot = resolveSearchProjectRoot(ctx, args);
  const refId = resolveDetailRef(args);
  const entries = await listKnowledgeEntries(ctx, args, Math.max(args.limit ?? 10, 20));
  const directEntry = refId ? await getKnowledgeEntry(ctx, refId) : null;
  const candidates = mergeKnowledgeCandidates([
    ...(directEntry ? [knowledgeEntryToCandidate(directEntry)] : []),
    ...entries.map(knowledgeEntryToCandidate),
  ]);
  const detailProvider = new DefaultKnowledgeDetailProvider(candidates);
  const expansionProvider = new DefaultContextExpansionProvider(detailProvider);
  const relationProvider = new DefaultRecipeRelationChainProvider();
  const detail = refId ? detailProvider.getKnowledgeDetail(refId) : null;
  const expanded =
    operation === 'expand' && refId
      ? expansionProvider.expandContext(refId, contentCharLimit(args))
      : null;
  const selectedItem = detail ? candidates.find((candidate) => candidate.id === detail.id) : null;
  const detailRefs = selectedItem
    ? [createKnowledgeDetailRef(selectedItem, operation, true, args)]
    : [];
  const relationChains = selectedItem
    ? relationProvider.expandRecipeRelationChains(selectedItem.id, relationHopLimit(args), {
        fanout: relationFanout(args),
        items: candidates.map(knowledgeItemToRecord),
      })
    : [];
  const sources =
    selectedItem && detailRefs[0] ? [createKnowledgeSource(selectedItem, detailRefs[0].id)] : [];
  const payload: KnowledgeContextProjectionPayload = {
    detailRefs,
    inventory: {
      candidateCount: candidates.length,
      found: detail !== null,
      operation,
      recipeRelationCount: relationChains.length,
    },
    items: selectedItem ? [projectKnowledgeItem(selectedItem)] : [],
    nextActions: nextActionsForDetail(operation, refId, detailRefs[0]),
    relations: relationChains.map((chain) => ({ ...chain })),
    result: {
      expanded,
      found: detail !== null,
      refId,
      requestedOperation: operation,
      residentSearch: {
        attempted: false,
        available: false,
        reason: 'detail-operation-uses-knowledge-service',
        used: false,
      },
      residentVector: {
        available: false,
        reason: 'detail-operation-uses-knowledge-service',
      },
      vector: {
        available: false,
        degradedReason:
          'Detail operations resolve a stable knowledge ref from the knowledge service; vector/rerank evidence is reported by search operations.',
        used: false,
      },
    },
    sources,
    summary:
      detail === null
        ? `Knowledge ${operation} could not resolve ${refId ?? 'the requested ref'}.`
        : `Knowledge ${operation} resolved ${detail.title ?? detail.id}.`,
  };

  return defaultProjectKnowledgeContextLayer.resolveMcpResult(
    'alembic_search',
    toKnowledgeContextSearchInput(args, { operation, projectRoot, refId }),
    {
      payload,
      snapshot: {
        domainFreshness: {
          knowledge: {
            state: detail === null ? 'stale' : 'ready',
            degradedReason: detail === null ? 'Requested knowledge ref was not found.' : undefined,
          },
          recipeRelation: {
            state: relationChains.length > 0 ? 'ready' : 'stale',
            degradedReason:
              relationChains.length > 0
                ? undefined
                : 'No recipe relation chain evidence was found for the requested ref.',
          },
          vector: {
            state: 'stale',
            degradedReason:
              'Detail operations resolve a stable knowledge ref from the knowledge service and do not invoke vector/rerank.',
          },
        },
        knowledgeItemCount: candidates.length,
        recipeRelationCount: relationChains.length,
      },
    }
  );
}

async function buildKnowledgeCandidates(
  ctx: McpContext,
  args: SearchArgs,
  pipeline: SearchPipelineResult
): Promise<KnowledgeRetrievalItem[]> {
  const entryCandidates = (
    await listKnowledgeEntries(ctx, args, Math.max((args.limit ?? 10) * 2, 20))
  ).map(knowledgeEntryToCandidate);
  const searchCandidates = pipeline.rawItems.map((item, index) =>
    searchItemToCandidate(item, pipeline.slimItems[index], pipeline.searchMeta)
  );
  const provider = new DefaultRecipeCandidateProvider(
    mergeKnowledgeCandidates([...searchCandidates, ...entryCandidates])
  );
  const ranked = provider.listRecipeCandidates(
    {
      activeFile: args.activeFile,
      category: args.category,
      kind: args.kind ?? args.type ?? 'all',
      keywords: args.keywords,
      language: args.language,
      limit: args.limit ?? 10,
      module: args.module,
      query: pipeline.query,
      sourceRefs: readStringArray(args.sourceRefs),
    },
    args.limit ?? 10
  );
  return new DefaultVectorRerankProvider().rerank(
    pipeline.query,
    ranked,
    args.limit ?? 10,
    vectorRerankEvidence(pipeline.searchMeta)
  );
}

interface SearchRelevanceAssessment {
  boundedDetailIntent: boolean;
  degradedReason?: string;
  items: KnowledgeRetrievalItem[];
  lowInformationIntent: boolean;
  mcpToolQualityIntent: boolean;
  noTrustedMatch: boolean;
  weakCandidateCount: number;
}

function assessSearchRelevance(
  items: readonly KnowledgeRetrievalItem[],
  args: SearchArgs,
  pipeline: SearchPipelineResult
): SearchRelevanceAssessment {
  if (items.length === 0) {
    return {
      boundedDetailIntent: false,
      degradedReason: 'Search returned no candidate items.',
      items: [],
      lowInformationIntent: false,
      mcpToolQualityIntent: false,
      noTrustedMatch: true,
      weakCandidateCount: 0,
    };
  }

  const queryTerms = relevanceTerms([pipeline.query, ...(args.keywords ?? [])]);
  const mcpToolQualityIntent = hasMcpToolQualityIntent(pipeline.query, args);
  const profile: SearchRelevanceProfile = {
    boundedDetailIntent: hasBoundedDetailIntent(queryTerms),
    hasCallerContext: hasCallerRelevanceContext(args),
    lowInformationIntent: hasLowInformationIntent(pipeline.query, args, queryTerms),
    mcpToolQualityIntent,
    semanticEvidenceAvailable: hasSemanticSearchEvidence(pipeline),
    specificQuery: queryTerms.length >= 2 || (args.keywords?.length ?? 0) > 0,
  };
  const trusted = items.filter((item) => candidateHasTrustedRelevance(item, profile));
  const weakCandidateCount = items.length - trusted.length;
  if (trusted.length > 0) {
    return {
      boundedDetailIntent: profile.boundedDetailIntent,
      degradedReason:
        weakCandidateCount > 0
          ? 'Weak fallback candidates without query, keyword, sourceRef, or semantic evidence were withheld.'
          : undefined,
      items: trusted,
      lowInformationIntent: profile.lowInformationIntent,
      mcpToolQualityIntent: profile.mcpToolQualityIntent,
      noTrustedMatch: false,
      weakCandidateCount,
    };
  }

  return {
    boundedDetailIntent: profile.boundedDetailIntent,
    degradedReason: noTrustedSearchReason(profile),
    items: [],
    lowInformationIntent: profile.lowInformationIntent,
    mcpToolQualityIntent: profile.mcpToolQualityIntent,
    noTrustedMatch: true,
    weakCandidateCount: items.length,
  };
}

interface SearchRelevanceProfile {
  boundedDetailIntent: boolean;
  hasCallerContext: boolean;
  lowInformationIntent: boolean;
  mcpToolQualityIntent: boolean;
  semanticEvidenceAvailable: boolean;
  specificQuery: boolean;
}

function hasSemanticSearchEvidence(pipeline: SearchPipelineResult): boolean {
  return (
    vectorUsed(pipeline.searchMeta) ||
    (pipeline.residentAttempt?.meta.available === true &&
      pipeline.residentAttempt.meta.used !== false &&
      pipeline.residentAttempt.items.length > 0)
  );
}

function candidateHasTrustedRelevance(
  item: KnowledgeRetrievalItem,
  profile: SearchRelevanceProfile
): boolean {
  const scoreBreakdown = item.scoreBreakdown ?? {};
  const queryHits = readNumber(scoreBreakdown.queryHits) ?? 0;
  const keywordHits = readNumber(scoreBreakdown.keywordHits) ?? 0;
  const sourceRefHits = readNumber(scoreBreakdown.sourceRefHits) ?? 0;
  const evidenceSignals = new Set(item.whyMatched ?? []);
  const semanticSupport = candidateHasSemanticSupport(item, profile);
  if (sourceRefHits > 0) {
    return true;
  }
  if (profile.lowInformationIntent && !profile.hasCallerContext) {
    return false;
  }
  if (profile.boundedDetailIntent) {
    return candidateHasBoundedDetailSupport(item, {
      evidenceSignals,
      keywordHits,
      queryHits,
      semanticSupport,
    });
  }
  if (profile.mcpToolQualityIntent) {
    return candidateHasMcpToolQualitySupport(item, {
      evidenceSignals,
      keywordHits,
      queryHits,
      semanticSupport,
    });
  }
  if (evidenceSignals.has('intent-anchor')) {
    return true;
  }
  if (keywordHits >= (profile.specificQuery ? 2 : 1)) {
    return true;
  }
  if (profile.specificQuery) {
    return queryHits >= 2 || (queryHits > 0 && semanticSupport);
  }
  return queryHits > 0 || semanticSupport;
}

function relevanceTerms(values: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    for (const match of value.toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? []) {
      const term = match.trim();
      if (term.length >= 2 && !GENERIC_RELEVANCE_TERMS.has(term)) {
        terms.add(term);
      }
    }
  }
  return [...terms].slice(0, 80);
}

function hasBoundedDetailIntent(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  const detailSignals = BOUNDED_DETAIL_INTENT_TERMS.filter((term) => terms.has(term)).length;
  return detailSignals >= 2;
}

function hasLowInformationIntent(
  query: string,
  args: SearchArgs,
  queryTerms: readonly string[]
): boolean {
  if (hasMcpToolQualityIntent(query, args)) {
    return false;
  }
  const queryText = query.toLowerCase().trim();
  if (LOW_INFORMATION_QUERY_PATTERNS.some((pattern) => pattern.test(queryText))) {
    return true;
  }
  const meaningfulTerms = queryTerms.filter((term) => !LOW_INFORMATION_TERMS.has(term));
  return meaningfulTerms.length === 0 && queryText.length <= 80;
}

function hasCallerRelevanceContext(args: SearchArgs): boolean {
  const hostDeclaredIntent = readRecord(args.hostDeclaredIntent);
  const hostKeywords = readStringArray(hostDeclaredIntent?.keywords);
  const hostSourceRefs = readStringArray(hostDeclaredIntent?.sourceRefs);
  return (
    readString(args.activeFile) !== undefined ||
    readString(args.module) !== undefined ||
    readStringArray(args.sourceRefs).length > 0 ||
    readStringArray(args.sourceEvidenceRefs).length > 0 ||
    (args.keywords?.length ?? 0) > 0 ||
    hostKeywords.length > 0 ||
    hostSourceRefs.length > 0
  );
}

function hasMcpToolQualityIntent(query: string, args: SearchArgs): boolean {
  const text = [
    query,
    ...(args.keywords ?? []),
    readString(args.module) ?? '',
    readString(args.activeFile) ?? '',
  ]
    .join(' ')
    .toLowerCase();
  const mentionsMcpTools =
    /\bmcp\b/u.test(text) &&
    (/四个/u.test(text) ||
      /\bfour\b/u.test(text) ||
      /\btools?\b/u.test(text) ||
      /工具/u.test(text));
  const mentionsQuality =
    /内容质量|返回内容|语义|相关性|排序|质量/u.test(text) ||
    /\b(quality|semantic|relevance|ranking|rank|content)\b/u.test(text);
  const mentionsPublicToolName =
    /\balembic_(search|prime|project_matrix|graph)\b/u.test(text) ||
    /public[-\s]?tools?|agent-public-tools|knowledge-context/u.test(text);
  return (mentionsMcpTools && mentionsQuality) || (mentionsPublicToolName && mentionsQuality);
}

function candidateHasSemanticSupport(
  item: KnowledgeRetrievalItem,
  profile: SearchRelevanceProfile
): boolean {
  if (!profile.semanticEvidenceAvailable) {
    return false;
  }
  const scoreBreakdown = item.scoreBreakdown ?? {};
  return (
    readNumber(scoreBreakdown.semanticScore) !== undefined ||
    readNumber(scoreBreakdown.vectorEvidence) !== undefined ||
    readNumber(scoreBreakdown.vectorScore) !== undefined ||
    item.whyMatched?.includes('vector-rerank') === true ||
    item.whyMatched?.includes('score-breakdown') === true
  );
}

function candidateHasBoundedDetailSupport(
  item: KnowledgeRetrievalItem,
  evidence: {
    evidenceSignals: Set<string>;
    keywordHits: number;
    queryHits: number;
    semanticSupport: boolean;
  }
): boolean {
  const support = boundedDetailSupportScore(item);
  if (support < 2) {
    return false;
  }
  if (evidence.evidenceSignals.has('intent-anchor') || evidence.semanticSupport) {
    return true;
  }
  return evidence.queryHits >= 2 || evidence.keywordHits >= 2;
}

function candidateHasMcpToolQualitySupport(
  item: KnowledgeRetrievalItem,
  evidence: {
    evidenceSignals: Set<string>;
    keywordHits: number;
    queryHits: number;
    semanticSupport: boolean;
  }
): boolean {
  const support = mcpToolQualitySupportScore(item);
  if (support < 2) {
    return false;
  }
  if (support >= 3) {
    return true;
  }
  if (evidence.evidenceSignals.has('intent-anchor') || evidence.semanticSupport) {
    return true;
  }
  return evidence.queryHits > 0 || evidence.keywordHits > 0;
}

function boundedDetailSupportScore(item: KnowledgeRetrievalItem): number {
  const text = searchableCandidateText(item);
  let score = 0;
  for (const pattern of BOUNDED_DETAIL_SUPPORT_PATTERNS) {
    if (pattern.test(text)) {
      score += 1;
    }
  }
  return score;
}

function mcpToolQualitySupportScore(item: KnowledgeRetrievalItem): number {
  const text = searchableCandidateText(item);
  let score = 0;
  for (const pattern of MCP_TOOL_QUALITY_SUPPORT_PATTERNS) {
    if (pattern.test(text)) {
      score += 1;
    }
  }
  return score;
}

function searchableCandidateText(item: KnowledgeRetrievalItem): string {
  return [
    item.id,
    item.title,
    item.summary,
    item.trigger,
    item.kind,
    item.language,
    item.category,
    item.contentPreview,
    ...(item.relationRefs ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
}

function noTrustedSearchReason(profile: SearchRelevanceProfile): string {
  if (profile.lowInformationIntent && !profile.hasCallerContext) {
    return 'Low-information search intent lacked activeFile, sourceRefs, keywords, or concrete intent anchors; semantic/vector similarity alone was withheld.';
  }
  if (profile.mcpToolQualityIntent) {
    return 'Search produced only weak candidates without MCP public-tool, handler, schema, ranking, or semantic-quality anchors.';
  }
  if (profile.boundedDetailIntent) {
    return 'Search produced only weak candidates without bounded Recipe detail/get/expand/detailRefs evidence.';
  }
  return 'Fallback search produced only weak candidates without enough query, keyword, sourceRef, or semantic evidence.';
}

const BOUNDED_DETAIL_INTENT_TERMS = [
  'bounded',
  'content',
  'detail',
  'detailrefs',
  'details',
  'expand',
  'fetch',
  'get',
  'ref',
  'refs',
  'summary',
];

// 这些锚点把“检索 Recipe 详情”与普通 contract/get 等弱词区分开，避免向宿主暴露无关可信结果。
const BOUNDED_DETAIL_SUPPORT_PATTERNS = [
  /\balembic_search\b/u,
  /\bdetail\s*refs?\b/u,
  /\bdetailrefs?\b/u,
  /\bexpand\b/u,
  /\bstructuredcontent\b/u,
  /\bknowledge-context\b/u,
  /\bknowledge\s+context\b/u,
  /\bsummary-only\b/u,
  /\bbounded\b/u,
];

const MCP_TOOL_QUALITY_SUPPORT_PATTERNS = [
  /\balembic_(search|prime|project_matrix|graph)\b/u,
  /\bagent-public-tools\b/u,
  /\bpublic[-\s]?tools?\b/u,
  /\bmcp\b/u,
  /\bhandler(s)?\b/u,
  /\bschema\b/u,
  /\bzodtomcpschema\b/u,
  /\bknowledge-context\b/u,
  /\bknowledge\s+context\b/u,
  /\brank(ing)?\b/u,
  /\brelevance\b/u,
  /\bsemantic[-\s]?quality\b/u,
  /\bprime(search|knowledge|material)?\b/u,
  /\bprojectgraphprovider\b/u,
  /\bsearch\.ts\b/u,
];

const GENERIC_RELEVANCE_TERMS = new Set([
  'alembic',
  'context',
  'knowledge',
  'mcp',
  'project',
  'recipe',
  'tool',
  'tools',
]);

const LOW_INFORMATION_TERMS = new Set([
  'begin',
  'do',
  'help',
  'here',
  'how',
  'i',
  'me',
  'next',
  'now',
  'please',
  'start',
  'started',
  'where',
  'what',
]);

const LOW_INFORMATION_QUERY_PATTERNS = [
  /^\s*where\s+do\s+i\s+start\s*[?.!]*\s*$/u,
  /^\s*(how|where)\s+(should\s+i\s+)?(start|begin|get\s+started)\s*[?.!]*\s*$/u,
  /^\s*(what\s+now|next\s+steps?|help)\s*[?.!]*\s*$/u,
];

async function listKnowledgeEntries(
  ctx: McpContext,
  args: SearchArgs,
  limit: number
): Promise<KnowledgeEntryJSON[]> {
  const service = safeContainerGet(ctx, 'knowledgeService') as {
    list?: (
      filters: Record<string, string>,
      page: { page: number; pageSize: number }
    ) => Promise<unknown>;
  } | null;
  if (!service || typeof service.list !== 'function') {
    return [];
  }
  const filters: Record<string, string> = {};
  const kind = args.kind ?? args.type;
  if (kind && kind !== 'all') {
    filters.kind = kind;
  }
  if (args.language) {
    filters.language = args.language;
  }
  if (args.category) {
    filters.category = args.category;
  }
  try {
    const result = await service.list(filters, { page: 1, pageSize: limit });
    const resultRecord = readRecord(result);
    return Array.isArray(resultRecord?.data) ? resultRecord.data.map(toKnowledgeEntryJson) : [];
  } catch {
    return [];
  }
}

async function getKnowledgeEntry(
  ctx: McpContext,
  refId: string
): Promise<KnowledgeEntryJSON | null> {
  const service = safeContainerGet(ctx, 'knowledgeService') as {
    get?: (refId: string) => Promise<unknown>;
  } | null;
  if (!service || typeof service.get !== 'function') {
    return null;
  }
  for (const candidateRef of candidateDetailRefIds(refId)) {
    try {
      const entry = await service.get(candidateRef);
      if (entry) {
        return toKnowledgeEntryJson(entry);
      }
    } catch {
      // Try the next compatible id form.
    }
  }
  return null;
}

function searchItemToCandidate(
  rawItem: SearchResultItem,
  slimItem: ReturnType<typeof slimSearchResult> | undefined,
  searchMeta: Record<string, unknown>
): KnowledgeRetrievalItem {
  const id = rawItem.id;
  const summary =
    readString(rawItem.description) ??
    readString(slimItem?.description) ??
    readString(rawItem.doClause) ??
    readString(rawItem.whenClause) ??
    rawItem.title;
  const kind = readString(rawItem.kind) ?? readString(rawItem.metadata?.kind);
  const itemScoreBreakdown = scoreBreakdownForItem(id, searchMeta);
  return {
    category: readString(rawItem.category) ?? readString(rawItem.metadata?.category),
    contentPreview: summary,
    detailRefId: `knowledge:${id}`,
    id,
    kind,
    language: readString(rawItem.language),
    metadata: rawItem.metadata,
    relationRefs: relationRefsForItem(rawItem),
    resident: sanitizeResidentSearchMeta(searchMeta.residentSearch),
    score: typeof rawItem.score === 'number' ? rawItem.score : undefined,
    scoreBreakdown: {
      ...(itemScoreBreakdown ?? {}),
      searchScore: typeof rawItem.score === 'number' ? rawItem.score : null,
    },
    summary,
    title: rawItem.title,
    trigger: readString(rawItem.trigger),
    vector: {
      available: vectorAvailable(searchMeta),
      used: vectorUsed(searchMeta),
    },
    whyMatched: whyMatchedForItem(id, rawItem, searchMeta),
  };
}

function knowledgeEntryToCandidate(entry: KnowledgeEntryJSON): KnowledgeRetrievalItem {
  const json = toKnowledgeEntryJson(entry);
  const content = readRecord(json.content);
  const summary =
    json.description ??
    json.doClause ??
    readString(content?.markdown) ??
    readString(content?.pattern) ??
    json.title;
  return {
    category: json.category,
    contentPreview: [
      json.whenClause,
      json.doClause,
      json.dontClause,
      readString(content?.markdown),
      readString(content?.pattern),
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n')
      .slice(0, 2400),
    detailRefId: `knowledge:${json.id}`,
    id: json.id,
    kind: json.kind,
    language: json.language,
    metadata: {
      knowledgeType: json.knowledgeType,
      relations: json.relations,
      tags: json.tags,
    },
    relationRefs: relationRefsFromRelations(json.relations),
    score: typeof json.quality?.overall === 'number' ? json.quality.overall : undefined,
    scoreBreakdown: {
      baseScore: typeof json.quality?.overall === 'number' ? json.quality.overall : 0,
      source: 'knowledge-service',
      vectorUsed: false,
    },
    summary,
    title: json.title,
    trigger: json.trigger,
    vector: {
      available: false,
      used: false,
    },
    whyMatched: ['knowledge-service'],
  };
}

function mergeKnowledgeCandidates(
  items: readonly KnowledgeRetrievalItem[]
): KnowledgeRetrievalItem[] {
  const byId = new Map<string, KnowledgeRetrievalItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || (item.score ?? 0) > (existing.score ?? 0)) {
      byId.set(item.id, {
        ...existing,
        ...item,
        relationRefs: Array.from(
          new Set([...(existing?.relationRefs ?? []), ...(item.relationRefs ?? [])])
        ),
        whyMatched: Array.from(
          new Set([...(existing?.whyMatched ?? []), ...(item.whyMatched ?? [])])
        ),
      });
    }
  }
  return [...byId.values()];
}

function projectKnowledgeItem(item: KnowledgeRetrievalItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    kind: item.kind,
    language: item.language,
    category: item.category,
    score: item.score,
    whyMatched: item.whyMatched,
    scoreBreakdown: item.scoreBreakdown,
    relationRefs: item.relationRefs,
    sourceRefs: [`knowledge:${item.id}`],
    detailRefId: item.detailRefId,
    vector: item.vector,
    resident: item.resident,
    contentPreview: item.contentPreview,
  };
}

function createKnowledgeDetailRef(
  item: KnowledgeRetrievalItem,
  operation: string,
  requiredForCompletion: boolean,
  args: SearchArgs
): KnowledgeContextDetailRef {
  return defaultRefRegistry.createDetailRef({
    budget: {
      contentCharLimit: contentCharLimit(args),
      relationHopLimit: relationHopLimit(args),
    },
    domain: 'knowledge',
    id: item.detailRefId ?? `knowledge:${item.id}`,
    operation,
    requiredForCompletion,
    summary: item.summary,
    title: item.title,
    tool: 'alembic_search',
  });
}

function createKnowledgeSource(
  item: KnowledgeRetrievalItem,
  detailRefId?: string
): KnowledgeContextSource {
  return {
    confidence: clampConfidence(item.score),
    detailRefId,
    domain: 'knowledge',
    id: `knowledge:${item.id}`,
    summary: item.summary,
    title: item.title,
  };
}

function nextActionsForSearch(
  items: readonly KnowledgeRetrievalItem[],
  detailRefs: readonly KnowledgeContextDetailRef[],
  query: string,
  relevance: SearchRelevanceAssessment
): KnowledgeContextNextAction[] {
  if (relevance.noTrustedMatch) {
    return [
      {
        operation: 'search',
        reason: `Refine "${query}" with concrete module names, symbols, source refs, or narrower keywords before trusting fallback knowledge.`,
        required: false,
        tool: 'alembic_search',
      },
      {
        operation: 'overview',
        reason:
          'Use the project matrix to choose a bounded project area before retrying knowledge search.',
        required: false,
        tool: 'alembic_project_matrix',
      },
    ];
  }
  return items.slice(0, 3).map((item, index) => ({
    detailRefId: detailRefs[index]?.id,
    operation: 'expand',
    reason: `Expand ${item.title} within the caller budget if this candidate is relevant.`,
    refId: `knowledge:${item.id}`,
    required: false,
    tool: 'alembic_search',
  }));
}

function nextActionsForDetail(
  operation: 'get' | 'expand',
  refId: string | undefined,
  detailRef?: KnowledgeContextDetailRef
): KnowledgeContextNextAction[] {
  if (!refId || operation === 'expand') {
    return [];
  }
  return [
    {
      detailRefId: detailRef?.id,
      operation: 'expand',
      reason: 'Expand relation chains and content preview for the resolved knowledge ref.',
      refId,
      required: false,
      tool: 'alembic_search',
    },
  ];
}

function toKnowledgeContextSearchInput(
  args: SearchArgs,
  override: {
    mode?: string;
    operation: 'search' | 'get' | 'expand';
    projectRoot?: string;
    query?: string;
    refId?: string;
  }
): Record<string, unknown> {
  const budget = readRecord(args.budget) ?? {};
  const projectRoot = override.projectRoot ?? readString(args.projectRoot);
  return {
    tool: 'alembic_search',
    operation: override.operation,
    mode: normalizeKnowledgeSearchMode(override.mode ?? args.mode),
    ...(override.query === undefined ? {} : { query: override.query }),
    ...(override.refId === undefined ? {} : { refId: override.refId }),
    ...(readString(args.id) === undefined ? {} : { id: readString(args.id) }),
    ...(readString(args.detailRefId) === undefined
      ? {}
      : { detailRefId: readString(args.detailRefId) }),
    kind: normalizeKnowledgeKind(args.kind ?? args.type),
    ...(readString(args.category) === undefined ? {} : { category: readString(args.category) }),
    ...(readString(args.language) === undefined ? {} : { language: readString(args.language) }),
    ...(readString(args.activeFile) === undefined
      ? {}
      : { activeFile: readString(args.activeFile) }),
    ...(readString(args.module) === undefined ? {} : { module: readString(args.module) }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(readString(args.sourceGraphRef) === undefined
      ? {}
      : { sourceGraphRef: readString(args.sourceGraphRef) }),
    ...(readStringArray(args.sourceRefs).length === 0
      ? {}
      : { sourceRefs: readStringArray(args.sourceRefs) }),
    ...(readStringArray(args.sourceEvidenceRefs).length === 0
      ? {}
      : { sourceEvidenceRefs: readStringArray(args.sourceEvidenceRefs) }),
    ...(Array.isArray(args.keywords) ? { keywords: args.keywords } : {}),
    budget: {
      ...budget,
      itemLimit: numberFromRecord(budget, 'itemLimit') ?? args.limit ?? 10,
      detailLimit: numberFromRecord(budget, 'detailLimit') ?? Math.max(args.limit ?? 10, 10),
      relationHopLimit: numberFromRecord(budget, 'relationHopLimit') ?? relationHopLimit(args),
      contentCharLimit: numberFromRecord(budget, 'contentCharLimit') ?? contentCharLimit(args),
    },
    detailLevel: readString(args.detailLevel) ?? 'summary',
    freshnessPolicy: readRecord(args.freshnessPolicy) ?? { policy: 'preferFresh' },
    hostDeclaredIntent: sanitizeHostDeclaredIntent(args.hostDeclaredIntent),
  };
}

function resolveSearchProjectRoot(ctx: McpContext, args: SearchArgs): string | undefined {
  const explicit = readString(args.projectRoot);
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    return resolveProjectRoot(ctx.container);
  } catch {
    return undefined;
  }
}

function normalizeSearchOperation(value: unknown): 'search' | 'get' | 'expand' {
  return value === 'get' || value === 'expand' ? value : 'search';
}

function normalizeKnowledgeSearchMode(
  value: unknown
): 'auto' | 'keyword' | 'bm25' | 'semantic' | 'context' {
  return value === 'keyword' || value === 'bm25' || value === 'semantic' || value === 'context'
    ? value
    : 'auto';
}

function normalizeKnowledgeKind(value: unknown): string {
  return typeof value === 'string' &&
    ['all', 'rule', 'pattern', 'fact', 'guide', 'decision', 'standard'].includes(value)
    ? value
    : 'all';
}

function resolveSearchQuery(args: SearchArgs): string {
  return (
    readString(args.query) ??
    readString(readRecord(args.hostDeclaredIntent)?.query) ??
    (Array.isArray(args.keywords) && args.keywords.length > 0
      ? args.keywords.join(' ')
      : undefined) ??
    readString(args.refId) ??
    readString(args.id) ??
    'knowledge'
  );
}

function resolveDetailRef(args: SearchArgs): string | undefined {
  return readString(args.refId) ?? readString(args.id) ?? readString(args.detailRefId);
}

function candidateDetailRefIds(refId: string): string[] {
  const strippedKnowledge = refId.startsWith('knowledge:')
    ? refId.slice('knowledge:'.length)
    : refId;
  const strippedDetail = refId.startsWith('detail:') ? refId.slice('detail:'.length) : refId;
  return Array.from(new Set([refId, strippedKnowledge, strippedDetail, stableRefSegment(refId)]));
}

function relationHopLimit(args: SearchArgs): number {
  return clampNumber(numberFromRecord(readRecord(args.budget), 'relationHopLimit') ?? 2, 1, 10);
}

function relationFanout(args: SearchArgs): number {
  return clampNumber(args.limit ?? 5, 1, 20);
}

function contentCharLimit(args: SearchArgs): number {
  return clampNumber(
    numberFromRecord(readRecord(args.budget), 'contentCharLimit') ?? 1200,
    120,
    20000
  );
}

function vectorRerankEvidence(searchMeta: Record<string, unknown>): VectorRerankEvidence {
  const intentEvidence = readRecord(searchMeta.intentEvidence);
  const primeInjectionPackage = readRecord(searchMeta.primeInjectionPackage);
  const vector = readRecord(primeInjectionPackage?.vector);
  return {
    residentVector: readRecord(searchMeta.residentVector),
    scoreBreakdown:
      readRecordArray(intentEvidence?.scoreBreakdown) ?? readRecordArray(vector?.scoreBreakdown),
    semanticUsed: readBoolean(searchMeta.semanticUsed) ?? readBoolean(vector?.semanticUsed),
    vectorAvailable:
      readBoolean(readRecord(searchMeta.residentVector)?.available) ??
      readBoolean(vector?.vectorAvailable),
    vectorUsed: readBoolean(searchMeta.vectorUsed) ?? readBoolean(vector?.vectorUsed),
  };
}

function sanitizeSearchMeta(searchMeta: Record<string, unknown>): Record<string, unknown> {
  return {
    actualMode: readString(searchMeta.actualMode),
    coreRoute: readString(searchMeta.coreRoute),
    requestedMode: readString(searchMeta.requestedMode),
    residentRequestMode: readString(searchMeta.residentRequestMode),
    route: readString(searchMeta.route),
    semanticUsed: readBoolean(searchMeta.semanticUsed),
    vectorUsed: readBoolean(searchMeta.vectorUsed),
    intentEvidence: compactIntentEvidence(readRecord(searchMeta.intentEvidence)),
    primeInjectionPackage: compactPrimeInjectionPackage(
      readRecord(searchMeta.primeInjectionPackage)
    ),
  };
}

function sanitizeResidentSearchMeta(value: unknown): Record<string, unknown> | undefined {
  const meta = readRecord(value);
  if (!meta) {
    return undefined;
  }
  const projectScopeIdentity = readRecord(meta.projectScopeIdentity);
  return {
    actualMode: readString(meta.actualMode),
    attempted: readBoolean(meta.attempted),
    available: readBoolean(meta.available),
    durationMs: readNumber(meta.durationMs),
    hostIntentHandoff: readRecord(meta.hostIntentHandoff),
    projectScopeIdentity: projectScopeIdentity
      ? {
          mode: readString(projectScopeIdentity.mode),
          projectScopeId: readString(projectScopeIdentity.projectScopeId),
          serviceScopeId: readString(projectScopeIdentity.serviceScopeId),
        }
      : undefined,
    reason: readString(meta.reason),
    requestedMode: readString(meta.requestedMode),
    residentRequestMode: readString(meta.residentRequestMode),
    route: readString(meta.route),
    semanticUsed: readBoolean(meta.semanticUsed),
    used: readBoolean(meta.used),
    vectorUsed: readBoolean(meta.vectorUsed),
  };
}

function sanitizeResidentVector(value: unknown): Record<string, unknown> | undefined {
  const vector = readRecord(value);
  if (!vector) {
    return undefined;
  }
  return {
    available: readBoolean(vector.available),
    endpoint: readString(vector.endpoint),
    reason: readString(vector.reason),
  };
}

function compactIntentEvidence(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return {
    degraded: readBoolean(value.degraded),
    degradedReasons: readStringArray(value.degradedReasons),
    relationEvidence: readRecordArray(value.relationEvidence)?.slice(0, 10),
    scoreBreakdown: readRecordArray(value.scoreBreakdown)?.slice(0, 10),
    semanticAnchors: readRecordArray(value.semanticAnchors)?.slice(0, 10),
    topAnchorMatches: readRecordArray(value.topAnchorMatches)?.slice(0, 10),
    version: readNumber(value.version),
  };
}

function compactPrimeInjectionPackage(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const injection = readRecord(value.injection);
  const intent = readRecord(value.intent);
  const search = readRecord(value.search);
  const trace = readRecord(value.trace);
  const vector = readRecord(value.vector);
  return {
    injection: injection
      ? {
          selectedCount: readNumber(injection.selectedCount),
          status: readString(injection.status),
        }
      : undefined,
    intent: intent
      ? {
          confidence: readNumber(intent.confidence),
          executableQuery: readString(intent.executableQuery),
          requestedMode: readString(intent.requestedMode),
        }
      : undefined,
    search: search
      ? {
          actualMode: readString(search.actualMode),
          filteredCount: readNumber(search.filteredCount),
          requestedMode: readString(search.requestedMode),
          resultCount: readNumber(search.resultCount),
        }
      : undefined,
    trace: trace
      ? {
          evidenceRefs: readStringArray(trace.evidenceRefs),
          sourceRefs: readStringArray(trace.sourceRefs),
          sources: readStringArray(trace.sources),
        }
      : undefined,
    vector: vector
      ? {
          semanticUsed: readBoolean(vector.semanticUsed),
          vectorAvailable: readBoolean(vector.vectorAvailable),
          vectorUsed: readBoolean(vector.vectorUsed),
        }
      : undefined,
  };
}

function scoreBreakdownForItem(
  itemId: string,
  searchMeta: Record<string, unknown>
): Record<string, unknown> | undefined {
  const evidence = vectorRerankEvidence(searchMeta);
  return evidence.scoreBreakdown?.find((entry) => entry.itemId === itemId);
}

function whyMatchedForItem(
  itemId: string,
  item: SearchResultItem,
  searchMeta: Record<string, unknown>
): string[] {
  const intentEvidence = readRecord(searchMeta.intentEvidence);
  const topAnchorMatches = readRecordArray(intentEvidence?.topAnchorMatches) ?? [];
  const anchorMatch = topAnchorMatches.find((entry) => entry.itemId === itemId);
  return [
    'search-result',
    ...(readString(item.trigger) ? ['trigger'] : []),
    ...(anchorMatch ? ['intent-anchor'] : []),
    ...(scoreBreakdownForItem(itemId, searchMeta) ? ['score-breakdown'] : []),
  ];
}

function vectorAvailable(searchMeta: Record<string, unknown>): boolean {
  const evidence = vectorRerankEvidence(searchMeta);
  return evidence.vectorAvailable === true || evidence.vectorUsed === true;
}

function vectorUsed(searchMeta: Record<string, unknown>): boolean {
  const evidence = vectorRerankEvidence(searchMeta);
  return evidence.vectorUsed === true || evidence.semanticUsed === true;
}

function relationRefsForItem(item: SearchResultItem): string[] {
  return relationRefsFromRelations(item.relations).concat(
    relationRefsFromRelations(readRecord(item.metadata)?.relations)
  );
}

function relationRefsFromRelations(relations: unknown): string[] {
  if (!relations || typeof relations !== 'object') {
    return [];
  }
  const refs: string[] = [];
  if (Array.isArray(relations)) {
    for (const item of relations) {
      refs.push(...relationRefsFromRelationEntry(item));
    }
  } else {
    for (const value of Object.values(relations)) {
      if (Array.isArray(value)) {
        refs.push(...value.flatMap(relationRefsFromRelationEntry));
      } else {
        refs.push(...relationRefsFromRelationEntry(value));
      }
    }
  }
  return Array.from(new Set(refs));
}

function relationRefsFromRelationEntry(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  const record = readRecord(value);
  const ref = readString(record?.id) ?? readString(record?.refId) ?? readString(record?.targetId);
  return ref ? [ref] : [];
}

function knowledgeItemToRecord(item: KnowledgeRetrievalItem): Record<string, unknown> {
  return {
    ...item,
    relations: item.metadata?.relations,
  };
}

function toKnowledgeEntryJson(value: unknown): KnowledgeEntryJSON {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeEntryJSON).toJSON === 'function'
  ) {
    return (value as KnowledgeEntryJSON).toJSON?.() ?? (value as KnowledgeEntryJSON);
  }
  return value as KnowledgeEntryJSON;
}

function safeContainerGet(ctx: McpContext, name: string): unknown {
  try {
    return ctx.container.get(name);
  } catch {
    return null;
  }
}

function sanitizeHostDeclaredIntent(value: unknown): Record<string, unknown> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    ...(readString(record.action) === undefined ? {} : { action: readString(record.action) }),
    ...(readString(record.target) === undefined ? {} : { target: readString(record.target) }),
    ...(readNumber(record.confidence) === undefined
      ? {}
      : { confidence: readNumber(record.confidence) }),
    ...(readString(record.query) === undefined ? {} : { query: readString(record.query) }),
    ...(readStringArray(record.sourceRefs).length === 0
      ? {}
      : { sourceRefs: readStringArray(record.sourceRefs) }),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => readRecord(item) !== undefined)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberFromRecord(
  record: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  return readNumber(record?.[key]);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

async function tryResidentSearch(
  residentSearchClient: ResidentSearchClient | null,
  request: ResidentSearchRequest & {
    kind: string;
    limit: number;
    mode: string;
    query: string;
    rank: boolean;
  }
): Promise<{ items: SearchResultItem[]; meta: ResidentSearchAttemptMeta } | null> {
  if (!residentSearchClient || !shouldAskResidentSearch(request.mode)) {
    return null;
  }
  try {
    const result = await residentSearchClient.search({
      query: request.query,
      mode: request.mode,
      limit: request.limit,
      rank: request.rank,
      kind: request.kind,
      confidence: request.confidence,
      degraded: request.degraded,
      degradedReason: request.degradedReason,
      hostDeclaredIntent: request.hostDeclaredIntent,
      hostTurnMeta: request.hostTurnMeta,
      intentContext: request.intentContext,
      language: request.language,
      scenario: request.scenario,
      searchIntent: request.searchIntent,
      sessionHistory: request.sessionHistory,
      sourceRefs: request.sourceRefs,
    });
    if (!result.meta.available) {
      process.stderr.write(`[MCP/Search] resident search unavailable: ${result.meta.reason}\n`);
    }
    return {
      items: result.items as unknown as SearchResultItem[],
      meta: result.meta,
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[MCP/Search] resident search request failed: ${reason}\n`);
    return {
      items: [],
      meta: {
        attempted: true,
        available: false,
        durationMs: 0,
        reason,
        requestedMode: request.mode,
        residentVector: { available: false, reason },
        resultCount: 0,
        route: 'alembic-resident-service',
        used: false,
      },
    };
  }
}

function shouldAskResidentSearch(mode: string): boolean {
  return mode === 'auto' || mode === 'semantic';
}

// ─── Backward-compatible aliases ────────────────────────────
// tool-router.ts 按 mode 路由时直接调用这些别名

/** contextSearch — mode='context' 的别名 */
export function contextSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'context' });
}

/** keywordSearch — mode='keyword' 的别名 */
export function keywordSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'keyword' });
}

/** semanticSearch — mode='semantic' 的别名 */
export function semanticSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'semantic' });
}
