import { type DaemonState, readDaemonState, resolveDaemonPaths } from '@alembic/core/daemon';
import type { SearchResponseMeta, SearchResultItem } from '@alembic/core/search';

type FetchLike = typeof fetch;

export interface ResidentSearchRequest {
  query: string;
  mode?: string;
  limit?: number;
  rank?: boolean;
  kind?: string;
  type?: string;
}

export interface ResidentSearchAttemptMeta {
  actualMode?: string;
  attempted: true;
  available: boolean;
  coreRoute?: string | null;
  degraded?: boolean;
  degradedReason?: string | null;
  durationMs: number;
  endpoint?: string;
  error?: string;
  fallbackReason?: string | null;
  reason?: string;
  requestedMode: string;
  residentVector: {
    available: boolean;
    reason?: string | null;
    [key: string]: unknown;
  };
  resultCount: number;
  route: 'alembic-resident-service';
  searchMeta?: Record<string, unknown>;
  semanticUsed?: boolean;
  service?: string | null;
  status?: number;
  used: boolean;
  vectorUsed?: boolean;
  workspace?: SearchResponseMeta['workspace'] | Record<string, unknown> | null;
}

export interface ResidentSearchResult {
  items: SearchResultItem[];
  meta: ResidentSearchAttemptMeta;
}

interface ResidentSearchClientOptions {
  fetchImpl?: FetchLike;
  projectRoot: string;
  readState?: (projectRoot: string) => DaemonState | null;
  timeoutMs?: number;
}

interface ResidentSearchHttpPayload {
  data?: {
    items?: unknown[];
    searchMeta?: Record<string, unknown>;
    [key: string]: unknown;
  };
  error?: { message?: unknown };
  message?: unknown;
  success?: boolean;
}

const RESIDENT_SEARCH_PATH = '/api/v1/search';

export class ResidentSearchClient {
  #fetch: FetchLike;
  #projectRoot: string;
  #readState: (projectRoot: string) => DaemonState | null;
  #timeoutMs: number;

  constructor(options: ResidentSearchClientOptions) {
    this.#projectRoot = options.projectRoot;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#readState =
      options.readState ??
      ((projectRoot) => {
        const paths = resolveDaemonPaths(projectRoot);
        return readDaemonState(paths.statePath);
      });
    this.#timeoutMs = options.timeoutMs ?? 2500;
  }

  async search(request: ResidentSearchRequest): Promise<ResidentSearchResult> {
    const startedAt = Date.now();
    const requestedMode = request.mode || 'auto';
    const state = this.#readState(this.#projectRoot);
    if (!state?.url) {
      return this.#unavailable(startedAt, requestedMode, 'daemon_state_missing');
    }
    if (!state.token) {
      return this.#unavailable(startedAt, requestedMode, 'daemon_token_missing', state);
    }

    const url = new URL(RESIDENT_SEARCH_PATH, state.url);
    url.searchParams.set('q', request.query);
    url.searchParams.set('mode', requestedMode);
    url.searchParams.set('limit', String(request.limit ?? 8));
    const type = normalizeResidentType(request.type ?? request.kind);
    if (type) {
      url.searchParams.set('type', type);
    }

    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-alembic-daemon-token': state.token,
        },
        signal: this.#timeoutMs > 0 ? AbortSignal.timeout(this.#timeoutMs) : undefined,
      });
      const payload = (await readJsonResponse(response)) as ResidentSearchHttpPayload | null;
      if (!response.ok || payload?.success === false || !isRecord(payload?.data)) {
        return this.#unavailable(
          startedAt,
          requestedMode,
          extractResponseError(payload) || `resident_search_http_${response.status}`,
          state,
          response.status
        );
      }

      const data = payload.data;
      const items = Array.isArray(data.items) ? (data.items as SearchResultItem[]) : [];
      const searchMeta = isRecord(data.searchMeta) ? data.searchMeta : {};
      return {
        items,
        meta: buildResidentMeta({
          data,
          durationMs: Date.now() - startedAt,
          endpoint: `${state.url}${RESIDENT_SEARCH_PATH}`,
          items,
          requestedMode,
          searchMeta,
        }),
      };
    } catch (err: unknown) {
      return this.#unavailable(
        startedAt,
        requestedMode,
        err instanceof Error ? err.message : String(err),
        state
      );
    }
  }

  #unavailable(
    startedAt: number,
    requestedMode: string,
    reason: string,
    state?: DaemonState | null,
    status?: number
  ): ResidentSearchResult {
    return {
      items: [],
      meta: {
        attempted: true,
        available: false,
        durationMs: Date.now() - startedAt,
        ...(state?.url ? { endpoint: `${state.url}${RESIDENT_SEARCH_PATH}` } : {}),
        reason,
        requestedMode,
        residentVector: {
          available: false,
          reason,
        },
        resultCount: 0,
        route: 'alembic-resident-service',
        ...(typeof status === 'number' ? { status } : {}),
        used: false,
      },
    };
  }
}

function buildResidentMeta(input: {
  data: Record<string, unknown>;
  durationMs: number;
  endpoint: string;
  items: SearchResultItem[];
  requestedMode: string;
  searchMeta: Record<string, unknown>;
}): ResidentSearchAttemptMeta {
  const meta = input.searchMeta;
  const residentVector = isRecord(meta.residentVector)
    ? (meta.residentVector as ResidentSearchAttemptMeta['residentVector'])
    : {
        available:
          meta.vectorUsed === true ||
          meta.semanticUsed === true ||
          input.requestedMode !== 'semantic',
        reason: typeof meta.fallbackReason === 'string' ? meta.fallbackReason : null,
      };
  const resultCount =
    numberFrom(meta.resultCount) ?? numberFrom(input.data.total) ?? input.items.length;

  return {
    actualMode: stringFrom(meta.actualMode ?? input.data.mode),
    attempted: true,
    available: true,
    coreRoute: stringFrom(meta.coreRoute ?? meta.route) ?? null,
    degraded: booleanFrom(meta.degraded),
    degradedReason: stringFrom(meta.degradedReason),
    durationMs: numberFrom(meta.durationMs) ?? input.durationMs,
    endpoint: input.endpoint,
    fallbackReason: stringFrom(meta.fallbackReason),
    requestedMode: stringFrom(meta.requestedMode) ?? input.requestedMode,
    residentVector,
    resultCount,
    route: 'alembic-resident-service',
    searchMeta: meta,
    semanticUsed: booleanFrom(meta.semanticUsed),
    service: stringFrom(meta.service),
    used: input.items.length > 0,
    vectorUsed: booleanFrom(meta.vectorUsed),
    workspace: isRecord(meta.workspace) ? (meta.workspace as Record<string, unknown>) : null,
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { success: false, message: text };
  }
}

function extractResponseError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const obj = payload as ResidentSearchHttpPayload;
  return typeof obj.message === 'string'
    ? obj.message
    : typeof obj.error?.message === 'string'
      ? obj.error.message
      : null;
}

function normalizeResidentType(type: unknown): string | null {
  if (typeof type !== 'string') {
    return null;
  }
  const normalized = type.trim();
  return normalized && normalized !== 'all' ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanFrom(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
