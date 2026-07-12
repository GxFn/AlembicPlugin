import {
  ALEMBIC_SEARCH_OUTPUT_CONTRACT_VERSION,
  type AlembicSearchOperation,
  type AlembicSearchStatus,
  createAlembicSearchMcpResult,
  type SearchDiagnostic,
} from '#service/project-knowledge-context/index.js';
import { type McpContext, requireRequestProjectRuntime, type SearchArgs } from './types.js';

interface KnowledgeServiceLike {
  get(id: string): Promise<Record<string, unknown> | null>;
  list(
    filters?: Record<string, unknown>,
    pagination?: { page?: number; pageSize?: number }
  ): Promise<{ data?: Array<Record<string, unknown>>; total?: number }>;
}

interface SearchEngineResponseLike {
  items?: Array<Record<string, unknown>>;
  total?: number;
  mode?: string;
  searchMeta?: Record<string, unknown>;
}

interface SearchEngineLike {
  search(query: string, options?: Record<string, unknown>): Promise<SearchEngineResponseLike>;
}

export async function search(ctx: McpContext, args: SearchArgs = {}) {
  const operation = normalizeOperation(args.operation);
  const identity = requestIdentity(ctx);
  const service = ctx.container.get('knowledgeService') as KnowledgeServiceLike;
  const diagnostics: SearchDiagnostic[] = [];
  let items: Array<Record<string, unknown>> = [];
  let summary: string;
  let status: AlembicSearchStatus = 'ready';
  let result: Record<string, unknown>;

  if (operation === 'get' || operation === 'expand') {
    const refId = normalizeRefId(args.refId ?? args.detailRefId ?? args.id);
    const entry = refId ? await service.get(refId) : null;
    items = entry ? [entry] : [];
    status = entry ? 'ready' : 'degraded';
    summary = entry
      ? `Alembic knowledge ${operation} resolved ${String(entry.title ?? entry.id ?? refId)}.`
      : `Alembic knowledge ${operation} found no entry for ${refId ?? 'the requested ref'}.`;
    result = {
      found: Boolean(entry),
      refId: refId ?? null,
      requestProjectIdentity: identity,
      ...(operation === 'expand' && entry ? { expanded: entry } : {}),
    };
    if (!entry) {
      diagnostics.push({
        code: 'search-detail-not-found',
        severity: 'info',
        message: summary,
        domain: 'knowledge',
        retryable: false,
      });
    }
  } else {
    const query = queryText(args);
    const limit = boundedSearchLimit(args);
    const requestedMode = normalizeSearchMode(args.mode);
    const engine = ctx.container.get('searchEngine') as SearchEngineLike;
    const response = await engine.search(query, searchOptions(args, requestedMode, limit));
    items = Array.isArray(response.items) ? response.items.slice(0, limit) : [];
    const route = publicSearchRoute(
      response.searchMeta,
      requestedMode,
      response.mode,
      items.length
    );
    summary = items.length
      ? `Alembic knowledge search returned ${items.length} result(s) via ${route.actualMode}.`
      : `Alembic knowledge search returned zero matches via ${route.actualMode}.`;
    status = route.degraded ? 'degraded' : 'ready';
    result = {
      requestedMode,
      actualMode: route.actualMode,
      route: route.route,
      semanticUsed: route.semanticUsed,
      vectorUsed: route.vectorUsed,
      ...(route.fallbackReason ? { fallbackReason: route.fallbackReason } : {}),
      ...(route.filteredOrphanVectorCount === undefined
        ? {}
        : { filteredOrphanVectorCount: route.filteredOrphanVectorCount }),
      query: query || null,
      totalResults: typeof response.total === 'number' ? response.total : items.length,
      requestProjectIdentity: identity,
    };
    if (route.vectorUsed) {
      diagnostics.push({
        code: 'search-vector-used',
        severity: 'info',
        message: 'The request used the local semantic/vector search route.',
        domain: 'knowledge',
        retryable: false,
      });
    } else if (route.fallbackReason) {
      diagnostics.push({
        code: 'search-keyword-fallback',
        severity: 'info',
        message: 'Semantic/vector search was unavailable; the request used the keyword fallback.',
        domain: 'knowledge',
        retryable: false,
      });
    }
    if (route.filteredOrphanVectorCount !== undefined) {
      diagnostics.push({
        code: 'search-orphan-vector-filtered',
        severity: 'info',
        message: `${route.filteredOrphanVectorCount} stale vector candidate(s) were excluded by the request-scoped knowledge database.`,
        domain: 'knowledge',
        retryable: false,
      });
    }
    if (items.length === 0) {
      diagnostics.push({
        code: 'search-zero-match',
        severity: 'info',
        message: summary,
        domain: 'knowledge',
        retryable: false,
      });
    }
  }

  return createAlembicSearchMcpResult({
    ok: true,
    status,
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation,
    summary,
    result,
    inventory: {
      candidateCount: items.length,
      operation,
      requestProjectIdentity: identity,
    },
    items,
    detailRefs: items.map((item) => ({
      id: `knowledge:${String(item.id ?? 'unknown')}`,
      kind: 'knowledge-detail',
    })),
    sources: [],
    diagnostics,
    nextActions: [],
    meta: {
      contractVersion: ALEMBIC_SEARCH_OUTPUT_CONTRACT_VERSION,
      outputSchema: 'AlembicSearchOutput',
      generatedAt: new Date().toISOString(),
      producer: 'alembic-plugin-local-search',
    },
  });
}

export function keywordSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'keyword' });
}

export function semanticSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'semantic' });
}

function requestIdentity(ctx: McpContext): Record<string, unknown> {
  const runtimeIdentity = requireRequestProjectRuntime(ctx).identity;
  return {
    projectRoot: runtimeIdentity.projectRoot,
    projectId: runtimeIdentity.projectId,
    projectScopeId: runtimeIdentity.projectScopeId,
    dataRoot: runtimeIdentity.dataRoot,
  };
}

function normalizeOperation(value: unknown): AlembicSearchOperation {
  return value === 'get' || value === 'expand' ? value : 'search';
}

function normalizeRefId(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value.trim().replace(/^knowledge(?:-detail)?:/, '');
}

function queryText(args: SearchArgs): string {
  return [
    typeof args.query === 'string' ? args.query : '',
    ...(Array.isArray(args.keywords) ? args.keywords : []),
  ]
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function boundedLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, 100)
    : 10;
}

function boundedSearchLimit(args: SearchArgs): number {
  const requested = boundedLimit(args.limit);
  const budget = args.budget as { itemLimit?: unknown } | undefined;
  return Math.min(requested, boundedLimit(budget?.itemLimit ?? requested));
}

function normalizeSearchMode(value: unknown): 'auto' | 'keyword' | 'semantic' {
  return value === 'keyword' || value === 'semantic' ? value : 'auto';
}

function searchOptions(
  args: SearchArgs,
  mode: 'auto' | 'keyword' | 'semantic',
  limit: number
): Record<string, unknown> {
  const value = args as Record<string, unknown>;
  const kind = typeof args.kind === 'string' && args.kind !== 'all' ? args.kind : undefined;
  return {
    mode,
    limit,
    rank: mode !== 'keyword',
    ...(kind ? { kind } : {}),
    ...copyStringFilter(value, 'category'),
    ...copyStringFilter(value, 'dimensionId'),
    ...copyStringFilter(value, 'knowledgeType'),
    ...copyStringFilter(value, 'scope'),
    ...copyStringFilter(value, 'language'),
    ...(Array.isArray(value.tags) ? { tags: value.tags } : {}),
  };
}

function copyStringFilter(value: Record<string, unknown>, key: string): Record<string, string> {
  return typeof value[key] === 'string' ? { [key]: value[key] } : {};
}

function publicSearchRoute(
  meta: Record<string, unknown> | undefined,
  requestedMode: string,
  responseMode: string | undefined,
  resultCount: number
) {
  const actualMode =
    typeof meta?.actualMode === 'string' ? meta.actualMode : (responseMode ?? 'keyword');
  const vectorUsed = meta?.vectorUsed === true;
  const semanticUsed = meta?.semanticUsed === true || vectorUsed;
  const fallbackReason = normalizePublicFallbackReason(meta?.fallbackReason);
  const filteredOrphanVectorCount = boundedPositiveCount(meta?.filteredOrphanVectorCount);
  return {
    requestedMode,
    actualMode,
    route: typeof meta?.route === 'string' ? meta.route : 'core-search-engine',
    vectorUsed,
    semanticUsed,
    fallbackReason,
    filteredOrphanVectorCount,
    degraded:
      meta?.degraded === true ||
      (requestedMode === 'semantic' && !vectorUsed && Boolean(fallbackReason)),
    resultCount,
  };
}

function boundedPositiveCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(10_000, Math.floor(value))
    : undefined;
}

function normalizePublicFallbackReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith('vector_store_query_failed')) {
    return 'vector-store-query-failed';
  }
  if (normalized.startsWith('semantic_search_failed')) {
    return 'semantic-search-failed';
  }
  if (normalized.includes('vector_store_unavailable')) {
    return 'vector-store-unavailable-or-empty';
  }
  if (normalized.includes('embed_provider_unavailable')) {
    return 'embed-provider-unavailable';
  }
  if (normalized.includes('empty_query_embedding')) {
    return 'empty-query-embedding';
  }
  if (normalized.startsWith('unsupported_mode')) {
    return 'unsupported-mode';
  }
  if (/^[a-z0-9_-]+$/.test(normalized)) {
    return normalized.replaceAll('_', '-');
  }
  return 'search-route-unavailable';
}
