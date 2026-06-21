/**
 * MCP Handlers — 搜索类
 *
 * v2: 将 search / keywordSearch / semanticSearch
 * 收束到 search() 入口，通过 mode 参数路由。
 * tool-router.ts 的 mode 路由直接指向本函数。
 *
 * 设计原则：
 * 1. 通过 container.get('searchEngine') 获取 singleton 实例（含 vectorStore + aiProvider）
 * 2. 统一 responseTime、byKind 分组、kind 过滤
 * 3. 投影使用 SearchTypes.slimSearchResult()（消除 3 处重复投影）
 */

import { groupByKind, slimSearchResult } from '@alembic/core/search';
import {
  ALEMBIC_SEARCH_OUTPUT_CONTRACT_VERSION,
  type AlembicSearchOperation,
  type AlembicSearchStatus,
  createAlembicSearchMcpResult,
  DefaultContextExpansionProvider,
  DefaultKnowledgeDetailProvider,
  DefaultRecipeCandidateProvider,
  defaultRefRegistry,
  type KnowledgeContextDetailRef,
  type KnowledgeContextSource,
  type KnowledgeRetrievalItem,
  type SearchDiagnostic,
  type SearchNextAction,
  stableRefSegment,
  type ToolNextAction,
  type VectorRerankEvidence,
} from '#service/project-knowledge-context/index.js';
import type { ResidentSearchClient } from '#service/resident/AlembicResidentCapabilityClients.js';
import type {
  ResidentSearchAttemptMeta,
  ResidentSearchRequest,
} from '#service/resident/AlembicResidentServiceClient.js';
import type {
  KnowledgeEntryJSON,
  McpContext,
  SearchArgs,
  SearchResultItem,
} from '../../../runtime/mcp/handlers/types.js';

const KEYWORD_MATCH_THRESHOLD = 0.5;
const SEMANTIC_MATCH_THRESHOLD = 0.55;
const INTERNAL_SEARCH_ROUTES_KEY = '__alembicSearchRoutes';

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

// ─── AlembicSearchOutput projection (GMAP-8b: no middle layer) ───────────────

// GMAP-8c: the handler-local intermediate payload (was KnowledgeContextProjectionPayload
// from the retired middle layer). projectAlembicSearchOutput maps it into the
// search-owned AlembicSearchOutput envelope.
interface SearchProjectionPayload {
  detailRefs: KnowledgeContextDetailRef[];
  inventory: Record<string, unknown>;
  items: Record<string, unknown>[];
  nextActions: ToolNextAction[];
  relations: unknown[];
  result: Record<string, unknown>;
  sources: KnowledgeContextSource[];
  summary: string;
}

// Project the handler's bounded search/detail payload into alembic_search's own
// AlembicSearchOutput envelope — replacing the retired KnowledgeContext middle-layer
// projection. result/inventory/items are loose passthroughs so resident-search
// evidence and search-quality survive intact.
function projectAlembicSearchOutput(
  payload: SearchProjectionPayload,
  opts: {
    operation: AlembicSearchOperation;
    status: AlembicSearchStatus;
    diagnostics: SearchDiagnostic[];
  }
) {
  const ok = opts.status !== 'failed' && opts.status !== 'blocked';
  return createAlembicSearchMcpResult({
    ok,
    status: opts.status,
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation: opts.operation,
    summary: payload.summary ?? 'alembic_search returned no summary.',
    ...(payload.result ? { result: payload.result as Record<string, unknown> } : {}),
    ...(payload.inventory ? { inventory: payload.inventory as Record<string, unknown> } : {}),
    items: (payload.items ?? []) as Record<string, unknown>[],
    detailRefs: (payload.detailRefs ?? []) as unknown as Record<string, unknown>[],
    sources: (payload.sources ?? []) as unknown as Record<string, unknown>[],
    diagnostics: opts.diagnostics,
    nextActions: (payload.nextActions ?? []).map(mapSearchNextAction),
    meta: {
      contractVersion: ALEMBIC_SEARCH_OUTPUT_CONTRACT_VERSION,
      outputSchema: 'AlembicSearchOutput',
      producer: 'alembic-search-handler',
    },
  });
}

function mapSearchNextAction(action: ToolNextAction): SearchNextAction {
  // MTC-1: dropped the dead alembic_project_matrix→recipe_map redirect (project_matrix is
  // fully retired and never emitted as a next-action hint).
  const tool = action.tool;
  return {
    tool,
    ...(action.operation ? { operation: action.operation } : {}),
    reason: action.reason,
    ...(action.refId ? { refId: action.refId } : {}),
    ...(action.detailRefId ? { detailRefId: action.detailRefId } : {}),
    required: action.required,
  };
}

// ─── 统一搜索入口 ────────────────────────────────────────────

/**
 * 统一搜索入口 — 支持 auto / keyword / semantic 三种公开模式
 *
 * search / keywordSearch / semanticSearch 共享本入口。
 * mode 路由:
 *   - auto (默认): FieldWeighted + semantic 融合 + Ranking Pipeline
 *   - keyword: SQL LIKE 精确匹配，适合已知函数名/类名
 *   - semantic: 向量语义搜索（不可用时降级 weighted）
 *
 * 所有模式共享: kind 过滤 → slimSearchResult 投影 → byKind 分组
 */
export async function search(ctx: McpContext, args: SearchArgs) {
  const operation = normalizeSearchOperation(args.operation);
  if (operation === 'get' || operation === 'expand') {
    return projectDetailOperation(ctx, args, operation);
  }
  const pipeline = await runSearchPipeline(ctx, args);
  const candidateItems = await buildKnowledgeCandidates(ctx, args, pipeline);
  const relevance = assessSearchRelevance(candidateItems, args, pipeline);
  const knowledgeItems = relevance.items;
  const detailRefs = knowledgeItems.map((item) =>
    createKnowledgeDetailRef(item, 'search', false, args)
  );
  const sources = knowledgeItems.map((item, index) =>
    createKnowledgeSource(item, detailRefs[index]?.id)
  );
  const queryLabel = searchQueryLabel(pipeline.query, relevance.normalizedFilters);
  const payload: SearchProjectionPayload = {
    detailRefs,
    inventory: {
      candidateCount: candidateItems.length,
      candidateSources: candidateSourcesForPipeline(pipeline),
      belowThresholdCount: relevance.belowThresholdCount,
      ignoredInputs: ignoredSearchInputs(args),
      kindCounts: pipeline.kindCounts,
      laneEvidence: relevance.laneEvidence,
      matchedCount: relevance.matchedCount,
      normalizedFilters: relevance.normalizedFilters,
      omittedCount: relevance.omittedCount,
      operation: 'search',
      returnedCount: relevance.returnedCount,
      thresholds: relevance.thresholds,
      zeroMatch: relevance.zeroMatch,
    },
    items: knowledgeItems.map((item) =>
      projectKnowledgeItem(item, { includeContentPreview: false })
    ),
    nextActions: nextActionsForSearch(knowledgeItems, detailRefs, queryLabel, relevance, args),
    relations: [],
    result: {
      actualMode: pipeline.actualMode,
      degraded: pipeline.degraded,
      kind: pipeline.kind === 'all' ? undefined : pipeline.kind,
      mode: pipeline.requestedMode,
      query: pipeline.query.length === 0 ? undefined : pipeline.query,
      queryLabel,
      residentSearch: sanitizeResidentSearchMeta(pipeline.residentAttempt?.meta),
      residentVector: sanitizeResidentVector(pipeline.searchMeta.residentVector),
      searchMeta: sanitizeSearchMeta(pipeline.searchMeta),
      searchQuality: {
        belowThresholdCount: relevance.belowThresholdCount,
        degradedReason: relevance.degradedReason,
        laneEvidence: relevance.laneEvidence,
        matchedCount: relevance.matchedCount,
        normalizedFilters: relevance.normalizedFilters,
        omittedCount: relevance.omittedCount,
        returnedCount: relevance.returnedCount,
        thresholds: relevance.thresholds,
        zeroMatch: relevance.zeroMatch,
      },
      totalResults: knowledgeItems.length,
      vector: {
        available: vectorAvailable(pipeline.searchMeta),
        used: vectorUsed(pipeline.searchMeta),
      },
    },
    sources,
    summary: relevance.zeroMatch
      ? `Knowledge search returned zero direct matches for ${queryLabel}.`
      : `Knowledge search returned ${relevance.returnedCount} of ${relevance.matchedCount} direct match(es) for ${queryLabel}.`,
  };

  const status: AlembicSearchStatus =
    pipeline.degraded || relevance.zeroMatch ? 'degraded' : 'ready';
  const diagnostics: SearchDiagnostic[] = relevance.zeroMatch
    ? [
        {
          code: 'search-zero-match',
          severity: 'info',
          message:
            relevance.degradedReason ??
            'No candidate met exact id/ref/title/trigger, explicit filter, keyword, or semantic match thresholds.',
          domain: 'knowledge',
          retryable: false,
        },
      ]
    : [];
  return projectAlembicSearchOutput(payload, { operation: 'search', status, diagnostics });
}

async function runSearchPipeline(ctx: McpContext, args: SearchArgs): Promise<SearchPipelineResult> {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const residentSearchClient = getResidentSearchClient(ctx);
  const query = resolveSearchQuery(args);
  const mode = parsePublicSearchMode(args.mode);
  const kind = args.kind || args.type || 'all';
  const execution = createSearchExecutionOptions(args, mode, kind);
  const hasTextQuery = hasExplicitTextSearchQuery(args);

  const residentAttempt = hasTextQuery
    ? await tryResidentSearch(residentSearchClient, {
        category: readString(args.category),
        dimensionId: readString(args.dimensionId),
        kind,
        knowledgeType: readString(args.knowledgeType),
        language: args.language,
        limit: execution.engineLimit,
        mode,
        query,
        rank: execution.rank,
        scope: readString(args.scope),
        tags: readStringArray(args.tags),
      })
    : null;

  const result = hasTextQuery
    ? await resolveSearchResult(engine, residentAttempt, query, mode, execution)
    : {
        items: [],
        mode,
        ranked: false,
        searchMeta: {
          route: 'metadata-filter-only',
          semanticUsed: false,
          vectorUsed: false,
        },
      };

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

  const source =
    readString(result.searchMeta?.route) === 'metadata-filter-only'
      ? 'metadata-filter-only'
      : result.ranked
        ? 'search-engine+ranking'
        : 'search-engine';
  const searchMeta = {
    ...(result.searchMeta || {}),
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

interface SearchExecutionOptions {
  engineLimit: number;
  limit: number;
  rank: boolean;
}

function createSearchExecutionOptions(
  args: SearchArgs,
  mode: string,
  kind: string
): SearchExecutionOptions {
  const limit = args.limit ?? 10;
  const recallLimit = kind !== 'all' ? limit * 2 : limit;
  return {
    engineLimit: mode === 'semantic' ? recallLimit * 2 : recallLimit,
    limit,
    rank: false,
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
    const residentItems = residentAttempt.items.map((item) => markSearchRoute(item, 'semantic'));
    if (mode === 'auto') {
      const embedded = await tryEmbeddedSearch(engine, query, mode, execution);
      if (embedded.items.length > 0) {
        return {
          items: mergeSearchResultItems([
            ...embedded.items.map((item) => markSearchRoute(item, 'keyword')),
            ...residentItems,
          ]),
          mode: residentAttempt.meta.actualMode || embedded.mode || mode,
          ranked: embedded.ranked,
          searchMeta: {
            ...(embedded.searchMeta ?? {}),
            residentSearchMeta: readRecord(residentAttempt.meta.searchMeta),
          },
        };
      }
    }
    return {
      items: residentItems,
      mode: residentAttempt.meta.actualMode || mode,
      ranked: false,
      searchMeta: readRecord(residentAttempt.meta.searchMeta),
    };
  }
  if (mode === 'semantic') {
    return {
      items: [],
      mode,
      ranked: false,
      searchMeta: {
        residentSearchMeta: readRecord(residentAttempt?.meta),
        route: 'resident-semantic-unavailable',
        semanticUsed: false,
        vectorUsed: false,
      },
    };
  }
  return tryEmbeddedSearch(engine, query, mode, execution);
}

async function tryEmbeddedSearch(
  engine: {
    search: (query: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  },
  query: string,
  mode: string,
  execution: SearchExecutionOptions
): Promise<SearchEnginePipelineResult> {
  try {
    const result = await engine.search(query, {
      mode,
      limit: execution.engineLimit,
      rank: execution.rank,
      groupByKind: true,
    });
    const normalized = normalizeSearchEnginePipelineResult(result);
    return {
      ...normalized,
      items: normalized.items.map((item) => markSearchRoute(item, 'keyword')),
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[MCP/Search] embedded keyword search failed: ${reason}\n`);
    return {
      items: [],
      mode,
      ranked: false,
      searchMeta: {
        embeddedSearchError: reason,
        route: 'embedded-search-unavailable',
      },
    };
  }
}

function mergeSearchResultItems(items: readonly SearchResultItem[]): SearchResultItem[] {
  const byId = new Map<string, SearchResultItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || (item.score ?? 0) > (existing.score ?? 0)) {
      byId.set(item.id, mergeSearchResultItem(existing, item));
    } else {
      byId.set(item.id, mergeSearchResultItem(item, existing));
    }
  }
  return [...byId.values()];
}

function mergeSearchResultItem(
  lowerPriority: SearchResultItem | undefined,
  higherPriority: SearchResultItem
): SearchResultItem {
  const lowerMetadata = readRecord(lowerPriority?.metadata) ?? {};
  const higherMetadata = readRecord(higherPriority.metadata) ?? {};
  const routes = uniqueStrings([
    ...readStringArray(lowerMetadata[INTERNAL_SEARCH_ROUTES_KEY]),
    ...readStringArray(higherMetadata[INTERNAL_SEARCH_ROUTES_KEY]),
  ]);
  return {
    ...lowerPriority,
    ...higherPriority,
    metadata: {
      ...lowerMetadata,
      ...higherMetadata,
      ...(routes.length === 0 ? {} : { [INTERNAL_SEARCH_ROUTES_KEY]: routes }),
    },
  };
}

function markSearchRoute(item: SearchResultItem, route: 'keyword' | 'semantic'): SearchResultItem {
  const metadata = readRecord(item.metadata) ?? {};
  return {
    ...item,
    metadata: {
      ...metadata,
      [INTERNAL_SEARCH_ROUTES_KEY]: uniqueStrings([
        ...readStringArray(metadata[INTERNAL_SEARCH_ROUTES_KEY]),
        route,
      ]),
    },
  };
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
  const refId = resolveDetailRef(args);
  const entries = await listKnowledgeEntries(ctx, args, Math.max(args.limit ?? 10, 20));
  const directEntry = refId ? await getKnowledgeEntry(ctx, refId) : null;
  const candidates = mergeKnowledgeCandidates([
    ...(directEntry ? [knowledgeEntryToCandidate(directEntry)] : []),
    ...entries.map(knowledgeEntryToCandidate),
  ]);
  const detailProvider = new DefaultKnowledgeDetailProvider(candidates);
  const expansionProvider = new DefaultContextExpansionProvider(detailProvider);
  const detail = refId ? detailProvider.getKnowledgeDetail(refId) : null;
  const rawExpanded =
    operation === 'expand' && refId
      ? expansionProvider.expandContext(refId, contentCharLimit(args))
      : null;
  const expanded =
    rawExpanded && refId
      ? {
          ...rawExpanded,
          detailRefs: uniqueStrings(
            [refId, ...rawExpanded.detailRefs].map((value) => canonicalKnowledgeDetailRef(value))
          ),
          refId,
        }
      : rawExpanded;
  const selectedItem = detail ? candidates.find((candidate) => candidate.id === detail.id) : null;
  const detailRefs = selectedItem
    ? [createKnowledgeDetailRef(selectedItem, operation, true, args)]
    : [];
  const sources =
    selectedItem && detailRefs[0] ? [createKnowledgeSource(selectedItem, detailRefs[0].id)] : [];
  const payload: SearchProjectionPayload = {
    detailRefs,
    inventory: {
      candidateCount: candidates.length,
      found: detail !== null,
      operation,
    },
    items: selectedItem ? [projectKnowledgeItem(selectedItem)] : [],
    nextActions: selectedItem ? nextActionsForDetail(operation, refId, detailRefs[0]) : [],
    relations: [],
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

  const status: AlembicSearchStatus = detail === null ? 'degraded' : 'ready';
  const diagnostics: SearchDiagnostic[] =
    detail === null
      ? [
          {
            code: 'search-detail-not-found',
            severity: 'warning',
            message: `Requested knowledge ref ${refId ?? '(unspecified)'} was not found.`,
            domain: 'knowledge',
            retryable: false,
          },
        ]
      : [];
  return projectAlembicSearchOutput(payload, { operation, status, diagnostics });
}

async function buildKnowledgeCandidates(
  ctx: McpContext,
  args: SearchArgs,
  pipeline: SearchPipelineResult
): Promise<KnowledgeRetrievalItem[]> {
  const candidateLimit = Math.max((args.limit ?? 10) * 4, 20);
  const entryCandidates = (await listKnowledgeEntries(ctx, args, candidateLimit)).map(
    knowledgeEntryToCandidate
  );
  const searchCandidates = pipeline.rawItems.map((item, index) =>
    searchItemToCandidate(item, pipeline.slimItems[index], pipeline.searchMeta)
  );
  const provider = new DefaultRecipeCandidateProvider(
    mergeKnowledgeCandidates([...searchCandidates, ...entryCandidates])
  );
  const ranked = provider.listRecipeCandidates(
    {
      category: args.category,
      dimensionId: readString(args.dimensionId),
      kind: args.kind ?? args.type ?? 'all',
      knowledgeType: readString(args.knowledgeType),
      keywords: candidateKeywordsForSearch(args),
      language: args.language,
      limit: candidateLimit,
      query: candidateQueryForSearch(pipeline.query),
      scope: readString(args.scope),
      tags: readStringArray(args.tags),
    },
    candidateLimit
  );
  return ranked;
}

function candidateQueryForSearch(query: string): string {
  return query;
}

function candidateKeywordsForSearch(args: SearchArgs): string[] {
  return uniqueStrings([...(args.keywords ?? [])]);
}

interface SearchRelevanceAssessment {
  belowThresholdCount: number;
  degradedReason?: string;
  items: KnowledgeRetrievalItem[];
  laneEvidence: Record<string, unknown>;
  lowInformationIntent: boolean;
  matchedCount: number;
  normalizedFilters: Record<string, string | string[]>;
  omittedCount: number;
  returnedCount: number;
  thresholds: {
    keyword: number;
    semantic: number;
  };
  zeroMatch: boolean;
}

function assessSearchRelevance(
  items: readonly KnowledgeRetrievalItem[],
  args: SearchArgs,
  pipeline: SearchPipelineResult
): SearchRelevanceAssessment {
  const normalizedFilters = normalizeSearchFilters(args);
  const queryTerms = relevanceTerms([pipeline.query, ...(args.keywords ?? [])]);
  const lowInformationIntent =
    !hasExplicitSearchFilter(normalizedFilters) &&
    !hasExplicitKnowledgeRef(args) &&
    hasLowInformationIntent(pipeline.query, args, queryTerms);
  const annotated = items.map((item) =>
    annotateDirectSearchPrecision(item, args, pipeline, normalizedFilters, queryTerms)
  );
  const semanticEvidenceAvailable = hasSemanticSearchEvidence(pipeline);
  const matched = lowInformationIntent
    ? []
    : pipeline.requestedMode === 'semantic'
      ? annotated.filter((item) =>
          readStringArray(item.scoreBreakdown?.matchRoutes).includes('semantic')
        )
      : annotated.filter((item) => readStringArray(item.scoreBreakdown?.matchRoutes).length > 0);
  const limit = args.limit ?? 10;
  const returned = matched.slice(0, limit);
  const belowThresholdCount = annotated.length - matched.length;
  const omittedCount = Math.max(0, matched.length - returned.length);
  const zeroMatch = returned.length === 0;
  return {
    belowThresholdCount,
    degradedReason: directSearchDegradedReason({
      belowThresholdCount,
      candidateCount: annotated.length,
      lowInformationIntent,
      omittedCount,
      residentUnavailableReason: residentSemanticUnavailableReason(pipeline),
      semanticEvidenceAvailable,
      semanticMode: pipeline.requestedMode === 'semantic',
      zeroMatch,
    }),
    items: returned,
    laneEvidence: buildDirectSearchLaneEvidence(pipeline, annotated, returned, normalizedFilters),
    lowInformationIntent,
    matchedCount: matched.length,
    normalizedFilters,
    omittedCount,
    returnedCount: returned.length,
    thresholds: {
      keyword: KEYWORD_MATCH_THRESHOLD,
      semantic: SEMANTIC_MATCH_THRESHOLD,
    },
    zeroMatch,
  };
}

type SearchMatchRoute = 'exact' | 'filter' | 'keyword' | 'semantic';

interface DirectSearchRouteProjection {
  evidence: string[];
  matched: boolean;
  rate: number;
  route: SearchMatchRoute;
}

function annotateDirectSearchPrecision(
  item: KnowledgeRetrievalItem,
  args: SearchArgs,
  pipeline: SearchPipelineResult,
  normalizedFilters: Record<string, string | string[]>,
  queryTerms: readonly string[]
): KnowledgeRetrievalItem {
  const scoreBreakdown = item.scoreBreakdown ?? {};
  const exactMatch = candidateHasExactMatch(item, args, pipeline.query);
  const matchedFilters = matchedFilterLabels(scoreBreakdown, normalizedFilters);
  const filterMatch =
    hasExplicitSearchFilter(normalizedFilters) &&
    matchedFilters.length === Object.keys(normalizedFilters).length;
  const keywordMatchRate = exactMatch
    ? 1
    : directKeywordMatchRate(scoreBreakdown, queryTerms, args);
  const semanticMatchRate = directSemanticMatchRate(item, pipeline);
  const filterRouteAllowed = pipeline.requestedMode !== 'semantic';
  const keywordRouteAllowed =
    pipeline.requestedMode === 'auto' || pipeline.requestedMode === 'keyword';
  const filterRouteMatched = filterRouteAllowed && filterMatch && !hasExplicitTextSearchQuery(args);
  const keywordRouteMatched = keywordRouteAllowed && keywordMatchRate >= KEYWORD_MATCH_THRESHOLD;
  const semanticRouteMatched =
    semanticMatchRate !== undefined && semanticMatchRate >= SEMANTIC_MATCH_THRESHOLD;
  const routeProjection = projectDirectSearchRoutes([
    {
      evidence: ['exact:id-ref-title-trigger'],
      matched: exactMatch,
      rate: 1,
      route: 'exact',
    },
    {
      evidence: matchedFilters,
      matched: filterRouteMatched,
      rate: 1,
      route: 'filter',
    },
    {
      evidence: [`keyword:${keywordMatchRate.toFixed(2)}`],
      matched: keywordRouteMatched,
      rate: keywordMatchRate,
      route: 'keyword',
    },
    {
      evidence: [`semantic:${semanticMatchRate?.toFixed(2) ?? '0.00'}`],
      matched: semanticRouteMatched,
      rate: semanticMatchRate ?? 0,
      route: 'semantic',
    },
  ]);
  return {
    ...item,
    scoreBreakdown: {
      ...scoreBreakdown,
      belowThreshold: routeProjection.matchRoutes.length === 0,
      keywordMatchRate: Number(keywordMatchRate.toFixed(6)),
      keywordThreshold: KEYWORD_MATCH_THRESHOLD,
      matchRate: Number(routeProjection.matchRate.toFixed(6)),
      matchRoutes: routeProjection.matchRoutes,
      matchedFilters,
      routeEvidence: routeProjection.routeEvidence,
      semanticMatchRate:
        semanticMatchRate === undefined ? undefined : Number(semanticMatchRate.toFixed(6)),
      semanticThreshold: SEMANTIC_MATCH_THRESHOLD,
    },
    whyMatched: uniqueStrings([...(item.whyMatched ?? []), ...routeProjection.routeEvidence]),
  };
}

function projectDirectSearchRoutes(routes: readonly DirectSearchRouteProjection[]): {
  matchRate: number;
  matchRoutes: SearchMatchRoute[];
  routeEvidence: string[];
} {
  const matched = routes.filter((route) => route.matched);
  return {
    matchRate: Math.max(0, ...matched.map((route) => route.rate)),
    matchRoutes: matched.map((route) => route.route),
    routeEvidence: matched.flatMap((route) => route.evidence),
  };
}

function normalizeSearchFilters(args: SearchArgs): Record<string, string | string[]> {
  const filters: Record<string, string | string[]> = {};
  const kind = readString(args.kind ?? args.type);
  if (kind && kind !== 'all') {
    filters.kind = kind;
  }
  for (const [key, value] of Object.entries({
    category: readString(args.category),
    dimensionId: readString(args.dimensionId),
    knowledgeType: readString(args.knowledgeType),
    language: readString(args.language),
    scope: readString(args.scope),
  })) {
    if (value) {
      filters[key] = value;
    }
  }
  const tags = readStringArray(args.tags);
  if (tags.length > 0) {
    filters.tags = tags;
  }
  return filters;
}

function hasExplicitSearchFilter(filters: Record<string, string | string[]>): boolean {
  return Object.keys(filters).length > 0;
}

function hasExplicitKnowledgeRef(args: SearchArgs): boolean {
  return (
    readString(args.id) !== undefined ||
    readString(args.refId) !== undefined ||
    readString(args.detailRefId) !== undefined
  );
}

function candidateHasExactMatch(
  item: KnowledgeRetrievalItem,
  args: SearchArgs,
  query: string
): boolean {
  const needles = uniqueStrings([
    readString(args.id),
    readString(args.refId),
    readString(args.detailRefId),
    query,
  ]).flatMap((value) => normalizedExactNeedles(value));
  const candidateValues = uniqueStrings([
    item.id,
    `knowledge:${item.id}`,
    item.detailRefId,
    item.title,
    item.trigger,
    item.trigger?.replace(/^@/u, ''),
    stableRefSegment(item.detailRefId ?? item.id),
  ]).flatMap((value) => normalizedExactNeedles(value));
  const candidateSet = new Set(candidateValues);
  return needles.some((needle) => candidateSet.has(needle));
}

function normalizedExactNeedles(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const normalized = value.trim().toLowerCase();
  return uniqueStrings([
    normalized,
    canonicalKnowledgeDetailRef(normalized),
    normalized.startsWith('knowledge:') ? normalized.slice('knowledge:'.length) : undefined,
    normalized.startsWith('detail:') ? normalized.slice('detail:'.length) : undefined,
    normalized.startsWith('@') ? normalized.slice(1) : undefined,
  ]);
}

function matchedFilterLabels(
  scoreBreakdown: Record<string, unknown>,
  normalizedFilters: Record<string, string | string[]>
): string[] {
  return Object.keys(normalizedFilters)
    .filter((field) => readBoolean(scoreBreakdown[`${field}Match`]) === true)
    .map((field) => `filter:${field}`);
}

function directKeywordMatchRate(
  scoreBreakdown: Record<string, unknown>,
  queryTerms: readonly string[],
  args: SearchArgs
): number {
  const queryHits = readNumber(scoreBreakdown.queryHits) ?? 0;
  const keywordHits = readNumber(scoreBreakdown.keywordHits) ?? 0;
  const keywordTerms = relevanceTerms(args.keywords ?? []);
  const denominator = Math.max(1, Math.min(queryTerms.length + keywordTerms.length, 6));
  return clampConfidence((queryHits + keywordHits) / denominator) ?? 0;
}

function directSemanticMatchRate(
  item: KnowledgeRetrievalItem,
  pipeline: SearchPipelineResult
): number | undefined {
  if (!hasSemanticSearchEvidence(pipeline)) {
    return undefined;
  }
  const scoreBreakdown = item.scoreBreakdown ?? {};
  const explicit =
    readNumber(scoreBreakdown.semanticScore) ??
    readNumber(scoreBreakdown.vectorScore) ??
    readNumber(scoreBreakdown.finalScore);
  if (explicit !== undefined) {
    return clampConfidence(explicit);
  }
  const laneRoutes = readStringArray(scoreBreakdown.laneRoutes);
  if (laneRoutes.includes('semantic')) {
    return clampConfidence(item.score);
  }
  return undefined;
}

function directSearchDegradedReason(input: {
  belowThresholdCount: number;
  candidateCount: number;
  lowInformationIntent: boolean;
  omittedCount: number;
  residentUnavailableReason?: string;
  semanticEvidenceAvailable: boolean;
  semanticMode: boolean;
  zeroMatch: boolean;
}): string | undefined {
  if (input.lowInformationIntent) {
    return 'Low-information search lacked exact id/ref/title/trigger, explicit keywords, or metadata filters; no fallback candidates were returned.';
  }
  if (input.semanticMode && !input.semanticEvidenceAvailable) {
    return `Semantic search requires resident semantic/vector evidence; Plugin keyword/filter fallback was withheld${input.residentUnavailableReason ? ` (${input.residentUnavailableReason})` : ''}.`;
  }
  if (input.candidateCount === 0) {
    return 'Search returned no candidate items.';
  }
  if (input.semanticMode && input.zeroMatch) {
    return 'No resident semantic candidate met direct semantic admission threshold.';
  }
  if (input.zeroMatch) {
    return 'No candidate met exact, metadata-filter, keyword threshold, or semantic threshold admission rules.';
  }
  if (input.belowThresholdCount > 0) {
    return `${input.belowThresholdCount} candidate(s) were omitted below direct admission thresholds.`;
  }
  if (input.omittedCount > 0) {
    return `${input.omittedCount} matched candidate(s) were omitted by the caller limit.`;
  }
  return undefined;
}

function buildDirectSearchLaneEvidence(
  pipeline: SearchPipelineResult,
  candidates: readonly KnowledgeRetrievalItem[],
  returned: readonly KnowledgeRetrievalItem[],
  normalizedFilters: Record<string, string | string[]>
): Record<string, unknown> {
  return {
    filter: {
      applied: hasExplicitSearchFilter(normalizedFilters),
      candidateCount: countCandidatesWithRoute(candidates, 'filter'),
      returnedCount: countCandidatesWithRoute(returned, 'filter'),
    },
    keyword: {
      attempted: pipeline.requestedMode === 'auto' || pipeline.requestedMode === 'keyword',
      candidateCount: countCandidatesWithLane(candidates, 'keyword'),
      returnedCount: countCandidatesWithRoute(returned, 'keyword'),
      threshold: KEYWORD_MATCH_THRESHOLD,
    },
    semantic: {
      attempted: pipeline.residentAttempt?.meta.attempted === true,
      available: hasSemanticSearchEvidence(pipeline),
      candidateCount: countCandidatesWithLane(candidates, 'semantic'),
      residentAvailable: pipeline.residentAttempt?.meta.available === true,
      returnedCount: countCandidatesWithRoute(returned, 'semantic'),
      threshold: SEMANTIC_MATCH_THRESHOLD,
      unavailableReason: residentSemanticUnavailableReason(pipeline),
      used: hasSemanticSearchEvidence(pipeline),
    },
  };
}

function countCandidatesWithRoute(
  items: readonly KnowledgeRetrievalItem[],
  route: SearchMatchRoute
): number {
  return items.filter((item) => readStringArray(item.scoreBreakdown?.matchRoutes).includes(route))
    .length;
}

function countCandidatesWithLane(
  items: readonly KnowledgeRetrievalItem[],
  lane: 'keyword' | 'semantic'
): number {
  return items.filter((item) => readStringArray(item.scoreBreakdown?.laneRoutes).includes(lane))
    .length;
}

function hasSemanticSearchEvidence(pipeline: SearchPipelineResult): boolean {
  const residentVector = readRecord(pipeline.searchMeta.residentVector);
  if (!residentVector || residentVectorUnavailableForSemantic(residentVector)) {
    return false;
  }
  return (
    vectorUsed(pipeline.searchMeta) ||
    (pipeline.residentAttempt?.meta.available === true &&
      pipeline.residentAttempt.meta.used !== false &&
      readBoolean(residentVector.available) !== false &&
      pipeline.residentAttempt.items.length > 0)
  );
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

function hasMcpToolQualityIntent(query: string, args: SearchArgs): boolean {
  const text = [query, ...(args.keywords ?? [])].join(' ').toLowerCase();
  const mentionsMcpTools =
    /\bmcp\b/u.test(text) &&
    (/四个/u.test(text) ||
      /\bfour\b/u.test(text) ||
      /\btools?\b/u.test(text) ||
      /工具/u.test(text));
  const mentionsQuality =
    /内容质量|返回内容|输出质量|语义|相关性|排序|质量|有价值/u.test(text) ||
    /\b(output[-\s]?quality|quality|semantic|relevance|ranking|rank|content|diagnostics?)\b/u.test(
      text
    );
  const mentionsPublicToolName =
    /\balembic_(search|prime|recipe_map|graph)\b/u.test(text) ||
    /\b(graph\/search|projectcontext|projectgraphprovider)\b/u.test(text) ||
    /public[-\s]?tools?|agent-public-tools|knowledge-context/u.test(text);
  const mentionsSearchOrGraphQuality =
    /\b(search|graph|prime|matrix)\b/u.test(text) && mentionsQuality;
  return (
    (mentionsMcpTools && mentionsQuality) ||
    (mentionsPublicToolName && mentionsQuality) ||
    mentionsSearchOrGraphQuality
  );
}

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
  /^\s*(这个|这|那个|那)?\s*(怎么|如何|咋)\s*(处理|办|做|修|解决)\s*[？?。!！]*\s*$/u,
  /^\s*(怎么办|怎么处理|怎么弄|怎么做|如何处理|咋办)\s*[？?。!！]*\s*$/u,
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
  for (const [key, value] of Object.entries({
    dimensionId: readString(args.dimensionId),
    knowledgeType: readString(args.knowledgeType),
    scope: readString(args.scope),
  })) {
    if (value) {
      filters[key] = value;
    }
  }
  const tags = readStringArray(args.tags);
  if (tags.length === 1) {
    filters.tag = tags[0] ?? '';
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
  const rawMetadata = readRecord(rawItem.metadata);
  const laneRoutes = readStringArray(rawMetadata?.[INTERNAL_SEARCH_ROUTES_KEY]);
  return {
    category: readString(rawItem.category) ?? readString(rawItem.metadata?.category),
    contentPreview: summary,
    detailRefId: `knowledge:${id}`,
    id,
    kind,
    language: readString(rawItem.language),
    metadata: stripInternalSearchMetadata(rawItem.metadata),
    resident: sanitizeResidentSearchMeta(searchMeta.residentSearch),
    score: typeof rawItem.score === 'number' ? rawItem.score : undefined,
    scoreBreakdown: {
      ...(itemScoreBreakdown ?? {}),
      laneRoutes,
      searchScore: typeof rawItem.score === 'number' ? rawItem.score : null,
    },
    summary,
    title: rawItem.title,
    trigger: readString(rawItem.trigger),
    vector: {
      available: vectorAvailable(searchMeta),
      used: vectorUsed(searchMeta),
    },
    whyMatched: uniqueStrings([
      ...whyMatchedForItem(id, rawItem, searchMeta),
      ...laneRoutes.map((route) => `lane:${route}`),
    ]),
  };
}

function stripInternalSearchMetadata(value: unknown): Record<string, unknown> | undefined {
  const metadata = readRecord(value);
  if (!metadata) {
    return undefined;
  }
  const { [INTERNAL_SEARCH_ROUTES_KEY]: _internalSearchRoutes, ...publicMetadata } = metadata;
  return publicMetadata;
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
      dimensionId: readString(json.dimensionId),
      knowledgeType: json.knowledgeType,
      scope: json.scope,
      tags: json.tags,
    },
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
      const mergedScoreBreakdown = mergeScoreBreakdowns(
        existing?.scoreBreakdown,
        item.scoreBreakdown
      );
      byId.set(item.id, {
        ...existing,
        ...item,
        scoreBreakdown: mergedScoreBreakdown,
        whyMatched: Array.from(
          new Set([...(existing?.whyMatched ?? []), ...(item.whyMatched ?? [])])
        ),
      });
    } else {
      byId.set(item.id, {
        ...existing,
        scoreBreakdown: mergeScoreBreakdowns(item.scoreBreakdown, existing.scoreBreakdown),
        whyMatched: Array.from(
          new Set([...(existing.whyMatched ?? []), ...(item.whyMatched ?? [])])
        ),
      });
    }
  }
  return [...byId.values()];
}

function mergeScoreBreakdowns(
  lowerPriority: Record<string, unknown> | undefined,
  higherPriority: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!lowerPriority && !higherPriority) {
    return undefined;
  }
  const laneRoutes = uniqueStrings([
    ...readStringArray(lowerPriority?.laneRoutes),
    ...readStringArray(higherPriority?.laneRoutes),
  ]);
  return {
    ...(lowerPriority ?? {}),
    ...(higherPriority ?? {}),
    ...(laneRoutes.length === 0 ? {} : { laneRoutes }),
  };
}

function projectKnowledgeItem(
  item: KnowledgeRetrievalItem,
  options: { includeContentPreview?: boolean } = {}
): Record<string, unknown> {
  const scoreBreakdown = item.scoreBreakdown ?? {};
  return {
    id: item.id,
    refId: item.detailRefId ?? `knowledge:${item.id}`,
    title: item.title,
    summary: item.summary,
    kind: item.kind,
    language: item.language,
    category: item.category,
    score: item.score,
    whyMatched: item.whyMatched,
    scoreBreakdown: item.scoreBreakdown,
    matchRate: readNumber(scoreBreakdown.matchRate),
    keywordMatchRate: readNumber(scoreBreakdown.keywordMatchRate),
    semanticMatchRate: readNumber(scoreBreakdown.semanticMatchRate),
    matchRoutes: readStringArray(scoreBreakdown.matchRoutes),
    matchedFilters: readStringArray(scoreBreakdown.matchedFilters),
    routeEvidence: readStringArray(scoreBreakdown.routeEvidence),
    detailRefId: item.detailRefId,
    vector: item.vector,
    resident: item.resident,
    ...(options.includeContentPreview === false ? {} : { contentPreview: item.contentPreview }),
  };
}

function createKnowledgeDetailRef(
  item: KnowledgeRetrievalItem,
  operation: string,
  requiredForCompletion: boolean,
  args: SearchArgs
): KnowledgeContextDetailRef {
  return defaultRefRegistry.createDetailRef({
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
  queryLabel: string,
  relevance: SearchRelevanceAssessment,
  args: SearchArgs
): ToolNextAction[] {
  if (relevance.zeroMatch) {
    const activeFile = readString(args.activeFile);
    const projectContextActions: ToolNextAction[] = searchLooksLikeProjectContextQuery(args)
      ? [
          {
            operation: activeFile ? 'focus:file' : 'focus:space',
            reason: activeFile
              ? `Use alembic_recipe_map on ${activeFile} to inspect deterministic Recipe mounts and rollups for the focused code region.`
              : 'Use alembic_recipe_map with a focused file/module/space to inspect deterministic Recipe mounts when knowledge search has no direct Recipe match.',
            ...(activeFile ? { refId: activeFile } : {}),
            required: false,
            tool: 'alembic_recipe_map',
          },
          {
            operation: activeFile ? 'file-symbols' : 'map',
            reason: activeFile
              ? `Use alembic_graph file-symbols/source-slice around ${activeFile} for ProjectContext structure and source evidence.`
              : 'Use alembic_graph map/neighborhood queries for ProjectContext structure before turning code-location terms into Recipe search.',
            ...(activeFile ? { refId: activeFile } : {}),
            required: false,
            tool: 'alembic_graph',
          },
        ]
      : [];
    return [
      ...projectContextActions,
      {
        operation: 'search',
        reason: `Retry ${queryLabel} with an exact Recipe id/ref/title/trigger, explicit keywords, or metadata filters that satisfy direct admission thresholds.`,
        required: false,
        tool: 'alembic_search',
      },
    ].slice(0, 4);
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

function searchLooksLikeProjectContextQuery(args: SearchArgs): boolean {
  if (readString(args.activeFile) || readString(args.module)) {
    return true;
  }
  const haystack = uniqueStrings([
    readString(args.query),
    ...(args.keywords ?? []),
    readString(args.category),
    readString(args.kind ?? args.type),
  ])
    .join(' ')
    .toLowerCase();
  if (!haystack) {
    return false;
  }
  return (
    /\b(?:alembic_search|alembic_prime|alembic_graph|alembic_recipe_map|projectcontext|graph|recipe_map|handler|provider|file-symbols|source-slice|anchor-range|symbol|module|repo|repository|call-chain|source-ref|source-ref[s]?|\.ts|\.tsx|\.js|\.mjs|\.swift)\b/u.test(
      haystack
    ) || /[/\\][\w.-]+/u.test(haystack)
  );
}

function nextActionsForDetail(
  operation: 'get' | 'expand',
  refId: string | undefined,
  detailRef?: KnowledgeContextDetailRef
): ToolNextAction[] {
  if (!refId || operation === 'expand') {
    return [];
  }
  return [
    {
      detailRefId: detailRef?.id,
      operation: 'expand',
      reason: 'Expand bounded content preview for the resolved knowledge ref.',
      refId,
      required: false,
      tool: 'alembic_search',
    },
  ];
}

function ignoredSearchInputs(args: SearchArgs): string[] {
  const ignored = [
    readString(args.activeFile) === undefined ? undefined : 'activeFile',
    Array.isArray(args.sessionHistory) ? 'sessionHistory' : undefined,
    readRecord(args.hostDeclaredIntent) === undefined ? undefined : 'hostDeclaredIntent',
    readRecord(args.hostTurnMeta) === undefined ? undefined : 'hostTurnMeta',
    readString(args.module) === undefined ? undefined : 'module',
    readStringArray(args.sourceRefs).length === 0 ? undefined : 'sourceRefs',
    readStringArray(args.sourceEvidenceRefs).length === 0 ? undefined : 'sourceEvidenceRefs',
  ];
  return ignored.filter((value): value is string => typeof value === 'string');
}

function normalizeSearchOperation(value: unknown): 'search' | 'get' | 'expand' {
  return value === 'get' || value === 'expand' ? value : 'search';
}

function parsePublicSearchMode(value: unknown): 'auto' | 'keyword' | 'semantic' {
  if (value === undefined || value === null || value === '' || value === 'auto') {
    return 'auto';
  }
  if (value === 'keyword' || value === 'semantic') {
    return value;
  }
  throw new Error(
    `Unsupported alembic_search mode "${String(value)}". Supported modes: auto, keyword, semantic.`
  );
}

function resolveSearchQuery(args: SearchArgs): string {
  return (
    readString(args.query) ??
    (Array.isArray(args.keywords) && args.keywords.length > 0
      ? args.keywords.join(' ')
      : undefined) ??
    readString(args.refId) ??
    readString(args.id) ??
    ''
  );
}

function hasExplicitTextSearchQuery(args: SearchArgs): boolean {
  return (
    readString(args.query) !== undefined ||
    (Array.isArray(args.keywords) && args.keywords.length > 0) ||
    readString(args.refId) !== undefined ||
    readString(args.id) !== undefined
  );
}

function searchQueryLabel(
  query: string,
  normalizedFilters: Record<string, string | string[]>
): string {
  if (query.length > 0) {
    return `"${query}"`;
  }
  if (hasExplicitSearchFilter(normalizedFilters)) {
    return 'metadata filters';
  }
  return 'the requested criteria';
}

function candidateSourcesForPipeline(pipeline: SearchPipelineResult): string[] {
  return uniqueStrings([
    pipeline.residentAttempt?.meta.available === true ? 'resident-search' : undefined,
    pipeline.source === 'metadata-filter-only' ? undefined : 'embedded-search',
    'knowledge-service',
  ]);
}

function resolveDetailRef(args: SearchArgs): string | undefined {
  const refId = readString(args.refId) ?? readString(args.id) ?? readString(args.detailRefId);
  return refId === undefined ? undefined : canonicalKnowledgeDetailRef(refId);
}

function candidateDetailRefIds(refId: string): string[] {
  const canonical = canonicalKnowledgeDetailRef(refId);
  const strippedKnowledge = refId.startsWith('knowledge:')
    ? refId.slice('knowledge:'.length)
    : refId;
  const strippedDetail = refId.startsWith('detail:') ? refId.slice('detail:'.length) : refId;
  const strippedCanonicalKnowledge = canonical.startsWith('knowledge:')
    ? canonical.slice('knowledge:'.length)
    : canonical;
  const strippedCanonicalDetail = canonical.startsWith('detail:')
    ? canonical.slice('detail:'.length)
    : canonical;
  return Array.from(
    new Set([
      refId,
      canonical,
      strippedKnowledge,
      strippedDetail,
      strippedCanonicalKnowledge,
      strippedCanonicalDetail,
      stableRefSegment(refId),
      stableRefSegment(canonical),
    ])
  );
}

function canonicalKnowledgeDetailRef(refId: string): string {
  let current = refId.trim();
  for (let index = 0; index < 4; index += 1) {
    const next = stripKnowledgeOperationRef(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function stripKnowledgeOperationRef(refId: string): string {
  const match = /^(?:knowledge|detail):(search|get|expand):(.+)$/.exec(refId);
  return match?.[2] === undefined ? refId : match[2];
}

function contentCharLimit(args: SearchArgs): number {
  return clampNumber(
    numberFromRecord(readRecord(args.budget), 'contentCharLimit') ?? 1200,
    120,
    20000
  );
}

function vectorRerankEvidence(searchMeta: Record<string, unknown>): VectorRerankEvidence {
  const residentVector = normalizeResidentVectorTelemetry(readRecord(searchMeta.residentVector));
  const vectorSuppressed = residentVectorUnavailableForSemantic(residentVector);
  return {
    residentVector,
    scoreBreakdown:
      readRecordArray(searchMeta.scoreBreakdown) ??
      readRecordArray(readRecord(searchMeta.searchMeta)?.scoreBreakdown),
    semanticUsed: vectorSuppressed ? false : readBoolean(searchMeta.semanticUsed),
    vectorAvailable: vectorSuppressed ? false : readBoolean(residentVector?.available),
    vectorUsed: vectorSuppressed ? false : readBoolean(searchMeta.vectorUsed),
  };
}

function normalizeResidentVectorTelemetry(
  vector: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!vector) {
    return undefined;
  }
  const unavailableReason = residentVectorUnavailableReason(vector);
  if (!unavailableReason) {
    return vector;
  }
  return {
    ...vector,
    available: false,
    reason: unavailableReason,
    vectorAvailable: false,
    vectorUsed: false,
  };
}

function residentVectorEmptyIndex(vector: Record<string, unknown> | undefined): boolean {
  if (!vector) {
    return false;
  }
  if (readString(vector.reason) === 'empty-vector-index') {
    return true;
  }
  const stats = readRecord(vector?.stats);
  if (!stats) {
    return false;
  }
  const count = readNumber(stats?.count);
  const dimension = readNumber(stats?.dimension);
  const indexSize = readNumber(stats?.indexSize);
  if (indexSize === 0) {
    const available = residentVectorAvailabilityAvailable(vector);
    if ((count ?? 0) > 0 && (dimension ?? 0) > 0 && available !== false) {
      return false;
    }
    return true;
  }
  if (indexSize !== undefined) {
    return false;
  }
  if (readBoolean(stats?.hasIndex) === false) {
    return true;
  }
  if ((count ?? 0) > 0 && (dimension ?? 0) > 0) {
    return false;
  }
  return false;
}

function residentVectorSparseOnly(vector: Record<string, unknown> | undefined): boolean {
  if (!vector) {
    return false;
  }
  if (readBoolean(vector.sparseOnly) === true) {
    return true;
  }
  const stats = readRecord(vector.stats);
  if (readBoolean(stats?.sparseOnly) === true) {
    return true;
  }
  const signals = [
    readString(vector.reason),
    readString(vector.mode),
    readString(vector.route),
    readString(vector.strategy),
    readString(stats?.mode),
    readString(stats?.route),
    readString(stats?.strategy),
  ];
  return signals.some((signal) => signal === 'sparse-only');
}

function residentVectorUnavailableForSemantic(
  vector: Record<string, unknown> | undefined
): boolean {
  return residentVectorUnavailableReason(vector) !== undefined;
}

function residentVectorUnavailableReason(
  vector: Record<string, unknown> | undefined
): string | undefined {
  if (!vector) {
    return undefined;
  }
  const explicitReason = readString(vector.reason);
  if (explicitReason === 'empty-vector-index') {
    return explicitReason;
  }
  const availability = residentVectorAvailability(vector);
  const availabilityReason = readString(availability?.reason);
  const available = residentVectorAvailableSignal(vector, availability);
  if (available === false) {
    return explicitReason ?? availabilityReason ?? 'resident-vector-unavailable';
  }
  if (residentVectorSparseOnly(vector)) {
    return 'sparse-only';
  }
  if (residentVectorEmptyIndex(vector)) {
    return 'empty-vector-index';
  }
  return undefined;
}

function residentVectorAvailability(
  vector: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return readRecord(vector?.availability);
}

function residentVectorAvailabilityAvailable(vector: Record<string, unknown>): boolean | undefined {
  const availability = residentVectorAvailability(vector);
  return residentVectorAvailableSignal(vector, availability);
}

function residentVectorAvailableSignal(
  vector: Record<string, unknown>,
  availability: Record<string, unknown> | undefined = residentVectorAvailability(vector)
): boolean | undefined {
  const availabilityAvailable = readBoolean(availability?.available);
  const vectorAvailable = readBoolean(vector.available);
  if (availabilityAvailable === false || vectorAvailable === false) {
    return false;
  }
  return availabilityAvailable ?? vectorAvailable;
}

function residentSemanticUnavailableReason(pipeline: SearchPipelineResult): string | undefined {
  return (
    residentVectorUnavailableReason(readRecord(pipeline.searchMeta.residentVector)) ??
    (pipeline.residentAttempt?.meta.available === false
      ? pipeline.residentAttempt.meta.reason
      : undefined)
  );
}

function compactResidentVectorStats(
  stats: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!stats) {
    return undefined;
  }
  return {
    count: readNumber(stats.count),
    dimension: readNumber(stats.dimension),
    embedProviderAvailable: readBoolean(stats.embedProviderAvailable),
    hasIndex: readBoolean(stats.hasIndex),
    indexSize: readNumber(stats.indexSize),
  };
}

function compactResidentVectorAvailability(
  availability: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!availability) {
    return undefined;
  }
  return {
    available: readBoolean(availability.available),
    detail: readString(availability.detail),
    embedProviderConfigured: readBoolean(availability.embedProviderConfigured),
    probeStatus: readString(availability.probeStatus),
    reason: readString(availability.reason),
    status: readString(availability.status),
  };
}

function sanitizeSearchMeta(searchMeta: Record<string, unknown>): Record<string, unknown> {
  return {
    actualMode: readString(searchMeta.actualMode),
    coreRoute: readString(searchMeta.coreRoute),
    requestedMode: readString(searchMeta.requestedMode),
    residentRequestMode: readString(searchMeta.residentRequestMode),
    route: readString(searchMeta.route),
    semanticUsed: vectorUsed(searchMeta)
      ? readBoolean(searchMeta.semanticUsed)
      : (readBoolean(searchMeta.semanticUsed) ?? false) &&
        !residentVectorUnavailableForSemantic(readRecord(searchMeta.residentVector)),
    vectorUsed: vectorUsed(searchMeta),
  };
}

function sanitizeResidentSearchMeta(value: unknown): Record<string, unknown> | undefined {
  const meta = readRecord(value);
  if (!meta) {
    return undefined;
  }
  const projectScopeIdentity = readRecord(meta.projectScopeIdentity);
  const residentVectorUnavailable = residentVectorUnavailableForSemantic(
    readRecord(meta.residentVector)
  );
  return {
    actualMode: readString(meta.actualMode),
    attempted: readBoolean(meta.attempted),
    available: readBoolean(meta.available),
    durationMs: readNumber(meta.durationMs),
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
    semanticUsed: residentVectorUnavailable ? false : readBoolean(meta.semanticUsed),
    used: readBoolean(meta.used),
    vectorUsed: residentVectorUnavailable ? false : readBoolean(meta.vectorUsed),
  };
}

function sanitizeResidentVector(value: unknown): Record<string, unknown> | undefined {
  const vector = normalizeResidentVectorTelemetry(readRecord(value));
  if (!vector) {
    return undefined;
  }
  return {
    available: readBoolean(vector.available),
    availability: compactResidentVectorAvailability(readRecord(vector.availability)),
    endpoint: readString(vector.endpoint),
    reason: readString(vector.reason),
    stats: compactResidentVectorStats(readRecord(vector.stats)),
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
  return [
    'search-result',
    ...(readString(item.trigger) ? ['trigger'] : []),
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

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
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
    category?: string;
    dimensionId?: string;
    kind: string;
    knowledgeType?: string;
    limit: number;
    mode: string;
    query: string;
    rank: boolean;
    scope?: string;
    tags?: string[];
  }
): Promise<{ items: SearchResultItem[]; meta: ResidentSearchAttemptMeta } | null> {
  if (
    !residentSearchClient ||
    !shouldAskResidentSearch(request.mode) ||
    !readString(request.query)
  ) {
    return null;
  }
  try {
    const result = await residentSearchClient.search({
      query: request.query,
      mode: request.mode,
      limit: request.limit,
      rank: request.rank,
      kind: request.kind,
      language: request.language,
      ...(request.category ? { category: request.category } : {}),
      ...(request.dimensionId ? { dimensionId: request.dimensionId } : {}),
      ...(request.knowledgeType ? { knowledgeType: request.knowledgeType } : {}),
      ...(request.scope ? { scope: request.scope } : {}),
      ...(request.tags && request.tags.length > 0 ? { tags: request.tags } : {}),
    });
    if (!result.meta) {
      return {
        items: [],
        meta: {
          attempted: true,
          available: false,
          durationMs: 0,
          reason: 'invalid-resident-search-response',
          requestedMode: request.mode,
          residentVector: { available: false, reason: 'invalid-resident-search-response' },
          resultCount: 0,
          route: 'alembic-resident-service',
          used: false,
        },
      };
    }
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

/** keywordSearch — mode='keyword' 的别名 */
export function keywordSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'keyword' });
}

/** semanticSearch — mode='semantic' 的别名 */
export function semanticSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'semantic' });
}
