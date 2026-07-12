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
    const limit = boundedLimit(args.limit);
    const listed = await service.list(
      {
        ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
        ...(typeof args.category === 'string' ? { category: args.category } : {}),
        ...(typeof args.language === 'string' ? { language: args.language } : {}),
      },
      { page: 1, pageSize: Math.max(limit, 100) }
    );
    const query = queryText(args);
    const candidates = Array.isArray(listed.data) ? listed.data : [];
    items = candidates.filter((item) => matchesQuery(item, query)).slice(0, limit);
    summary = items.length
      ? `Alembic knowledge search returned ${items.length} direct match(es).`
      : 'Alembic knowledge search returned zero direct matches.';
    status = items.length ? 'ready' : 'degraded';
    result = {
      mode: typeof args.mode === 'string' ? args.mode : 'auto',
      query: query || null,
      totalResults: items.length,
      requestProjectIdentity: identity,
    };
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
    .toLowerCase();
}

function matchesQuery(item: Record<string, unknown>, query: string): boolean {
  if (!query) {
    return true;
  }
  const text = [item.id, item.title, item.trigger, item.description, item.doClause, item.whenClause]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return query.split(/\s+/).every((token) => text.includes(token));
}

function boundedLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, 100)
    : 10;
}
