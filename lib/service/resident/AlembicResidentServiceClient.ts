import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALEMBIC_RESIDENT_FEATURES,
  type AlembicResidentDashboardHandoff,
  type AlembicResidentFeature,
  type AlembicResidentJobFeature,
  type AlembicResidentServiceProbe,
  type AlembicResidentServiceResult,
  type AlembicResidentServiceStatus,
  type AlembicResidentServiceUnavailableReason,
  createAlembicResidentServiceProbe,
  createAlembicResidentServiceStatus,
  createAlembicResidentServiceSuccess,
  createAlembicResidentServiceUnavailable,
  createProjectRuntimeControlState,
  type DaemonState,
  normalizeAlembicResidentServiceStatus,
  PROJECT_RUNTIME_CONTROL_STATE_SCHEMA_VERSION,
  readDaemonState,
  resolveDaemonPaths,
  summarizeAlembicResidentServiceStatus,
} from '@alembic/core/daemon';
import type { SearchResponseMeta, SearchResultItem } from '@alembic/core/search';
import { normalizeProjectScopeSummary, type ProjectScopeSummary } from '@alembic/core/shared';
import { getProjectRegistryDir, WorkspaceResolver } from '@alembic/core/workspace';
import type { DaemonStatus } from '../../daemon/DaemonSupervisor.js';

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
  residentRequestMode?: string;
  requestedMode: string;
  residentService?: Record<string, unknown>;
  projectScopeIdentity?: AlembicResidentProjectScopeIdentity;
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

export interface AlembicResidentServiceClientOptions {
  fetchImpl?: FetchLike;
  projectRoot: string;
  readState?: (projectRoot: string) => DaemonState | null;
  timeoutMs?: number;
}

export interface AlembicResidentProbeOptions {
  daemonStatus?: DaemonStatus | null;
}

export interface AlembicResidentProjectScopeOptions extends AlembicResidentProbeOptions {
  folderPath?: string | null;
}

export interface AlembicResidentProjectScopeIdentity {
  available: boolean;
  controlRoot: string | null;
  currentFolderId: string | null;
  currentFolderPath: string | null;
  dataRoot: string | null;
  dataRootSource: string | null;
  diagnosticProjectRoot: string;
  folderCount: number;
  folders: ProjectScopeSummary['folders'];
  mode: 'project-scope' | 'single-folder-baseline';
  projectId: string | null;
  projectRoot: string;
  projectScope: ProjectScopeSummary | null;
  projectScopeCapability: Record<string, unknown> | null;
  projectScopeId: string | null;
  reason: string | null;
  resident: {
    owner: string;
    route: string;
    serviceScopeId: string | null;
  };
  serviceScopeId: string | null;
  source:
    | 'resident-project-scope-endpoint'
    | 'resident-service-scope'
    | 'plugin-single-folder-baseline';
  storageKind: string | null;
  workspaceMode: string | null;
}

export interface AlembicResidentJobRequestOptions extends AlembicResidentProbeOptions {
  body?: Record<string, unknown>;
}

interface ResidentHttpPayload {
  data?: Record<string, unknown>;
  error?: { message?: unknown };
  message?: unknown;
  success?: boolean;
}

interface ResolvedResidentProbe {
  projectScopeResolution?: {
    capability: Record<string, unknown> | null;
    summary: ProjectScopeSummary;
  };
  state: DaemonState | null;
  status: AlembicResidentServiceStatus;
}

const RESIDENT_HEALTH_PATH = '/api/v1/daemon/health';
const RESIDENT_PROJECT_SCOPE_RESOLVE_PATH = '/api/v1/project-scope/resolve-folder';
const RESIDENT_SEARCH_PATH = '/api/v1/search';
const RESIDENT_JOBS_PATH = '/api/v1/jobs';
const PROJECT_SCOPE_UNAVAILABLE_REASON = 'resident project scope unavailable';

export class AlembicResidentServiceClient {
  #fetch: FetchLike;
  #projectRoot: string;
  #readState: (projectRoot: string) => DaemonState | null;
  #timeoutMs: number;

  constructor(options: AlembicResidentServiceClientOptions) {
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

  async probe(options: AlembicResidentProbeOptions = {}): Promise<AlembicResidentServiceProbe> {
    const resolved = await this.#resolveProbe(options);
    return createAlembicResidentServiceProbe(resolved.status, new Date().toISOString());
  }

  async resolveProjectScopeIdentity(
    options: AlembicResidentProjectScopeOptions = {}
  ): Promise<AlembicResidentProjectScopeIdentity> {
    const resolved = await this.#resolveProbe(options);
    return this.#resolveProjectScopeIdentity(resolved, options.folderPath ?? this.#projectRoot);
  }

  async search(request: ResidentSearchRequest): Promise<ResidentSearchResult> {
    const result = await this.searchWithResult(request);
    if (result.ok) {
      return result.value;
    }
    return buildUnavailableSearchResult(result, request);
  }

  async searchWithResult(
    request: ResidentSearchRequest
  ): Promise<AlembicResidentServiceResult<ResidentSearchResult>> {
    const startedAt = Date.now();
    const requestedMode = normalizeRequestedMode(request.mode);
    const residentRequestMode = normalizeResidentRequestMode(requestedMode);
    const resolved = await this.#resolveProbe();
    const status = resolved.status;
    const projectScopeIdentity = await this.#resolveProjectScopeIdentity(
      resolved,
      this.#projectRoot
    );
    const feature = residentRequestMode === 'semantic' ? 'search.semantic' : 'search.keyword';
    const unavailable = this.#ensureFeatureAvailable<ResidentSearchResult>(status, feature, {
      requireLocalAlembic: true,
    });
    if (unavailable) {
      return withProjectScopeTelemetry(unavailable, projectScopeIdentity);
    }

    if (!resolved.state?.token) {
      return createAlembicResidentServiceUnavailable<ResidentSearchResult>(
        status,
        'token-missing',
        'Alembic resident service token is missing.',
        { retryable: true, telemetry: { feature, projectScopeIdentity } }
      );
    }

    const endpoint = new URL(RESIDENT_SEARCH_PATH, status.apiBaseUrl || resolved.state.url);
    endpoint.searchParams.set('q', request.query);
    endpoint.searchParams.set('mode', residentRequestMode);
    endpoint.searchParams.set('limit', String(request.limit ?? 8));
    const type = normalizeResidentType(request.type ?? request.kind);
    if (type) {
      endpoint.searchParams.set('type', type);
    }

    try {
      const response = await this.#fetchJson(endpoint, {
        method: 'GET',
        token: resolved.state.token,
      });
      if (
        !response.ok ||
        response.payload?.success === false ||
        !isRecord(response.payload?.data)
      ) {
        return createAlembicResidentServiceUnavailable<ResidentSearchResult>(
          status,
          response.ok ? 'request-failed' : reasonForHttpStatus(response.status),
          extractResponseError(response.payload) || `resident_search_http_${response.status}`,
          {
            retryable: true,
            telemetry: {
              endpoint: endpoint.toString(),
              feature,
              projectScopeIdentity,
              status: response.status,
            },
          }
        );
      }

      const data = response.payload.data;
      const items = Array.isArray(data.items) ? (data.items as SearchResultItem[]) : [];
      const searchMeta = isRecord(data.searchMeta) ? data.searchMeta : {};
      return createAlembicResidentServiceSuccess(
        {
          items,
          meta: buildResidentMeta({
            data,
            durationMs: Date.now() - startedAt,
            endpoint: endpoint.toString(),
            items,
            projectScopeIdentity,
            residentRequestMode,
            requestedMode,
            searchMeta,
            status,
          }),
        },
        status,
        { endpoint: endpoint.toString(), feature }
      );
    } catch (err: unknown) {
      const reason = isTimeoutError(err) ? 'request-timeout' : 'request-failed';
      return createAlembicResidentServiceUnavailable<ResidentSearchResult>(
        status,
        reason,
        err instanceof Error ? err.message : String(err),
        {
          retryable: true,
          telemetry: { endpoint: endpoint.toString(), feature, projectScopeIdentity },
        }
      );
    }
  }

  async enqueueJob(
    kind: 'bootstrap' | 'rescan',
    options: AlembicResidentJobRequestOptions = {}
  ): Promise<AlembicResidentServiceResult<unknown>> {
    const resolved = await this.#resolveProbe(options);
    const feature = resolveJobFeature(resolved.status, kind);
    const unavailable = this.#ensureFeatureAvailable<unknown>(resolved.status, feature, {
      allowEmbeddedPlugin: true,
    });
    if (unavailable) {
      return unavailable;
    }
    return this.#requestJson(resolved, `${RESIDENT_JOBS_PATH}/${kind}`, {
      body: options.body,
      feature,
      method: 'POST',
    });
  }

  async readJob(
    args: Record<string, unknown>,
    options: AlembicResidentProbeOptions = {}
  ): Promise<AlembicResidentServiceResult<unknown>> {
    const resolved = await this.#resolveProbe(options);
    const feature = resolveJobFeature(
      resolved.status,
      args.kind === 'rescan' ? 'rescan' : 'bootstrap'
    );
    const unavailable = this.#ensureAnyJobFeatureAvailable<unknown>(resolved.status);
    if (unavailable) {
      return unavailable;
    }
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    const path = jobId
      ? `${RESIDENT_JOBS_PATH}/${encodeURIComponent(jobId)}`
      : `${RESIDENT_JOBS_PATH}${buildJobQuery(args)}`;
    return this.#requestJson(resolved, path, { feature, method: 'GET' });
  }

  async dashboard(
    options: AlembicResidentProbeOptions = {}
  ): Promise<AlembicResidentServiceResult<AlembicResidentDashboardHandoff>> {
    const resolved = await this.#resolveProbe(options);
    const unavailable = this.#ensureFeatureAvailable<AlembicResidentDashboardHandoff>(
      resolved.status,
      'dashboard.handoff',
      { requireLocalAlembic: true }
    );
    if (unavailable) {
      return unavailable;
    }
    const url = resolved.state?.dashboardUrl ?? null;
    if (!url) {
      return createAlembicResidentServiceUnavailable<AlembicResidentDashboardHandoff>(
        resolved.status,
        'capability-unavailable',
        'Alembic resident service did not provide a Dashboard handoff URL.',
        { telemetry: { feature: 'dashboard.handoff' } }
      );
    }
    return createAlembicResidentServiceSuccess(
      {
        available: true,
        message: null,
        owner: resolved.status.owner,
        route: resolved.status.route,
        unavailableReason: null,
        url,
      },
      resolved.status,
      { feature: 'dashboard.handoff' }
    );
  }

  async #requestJson(
    resolved: ResolvedResidentProbe,
    path: string,
    input: {
      body?: Record<string, unknown>;
      feature: AlembicResidentJobFeature;
      method: 'GET' | 'POST';
    }
  ): Promise<AlembicResidentServiceResult<unknown>> {
    if (!resolved.state?.token) {
      return createAlembicResidentServiceUnavailable<unknown>(
        resolved.status,
        'token-missing',
        'Alembic resident service token is missing.',
        { retryable: true, telemetry: { feature: input.feature, path } }
      );
    }
    const endpoint = new URL(path, resolved.status.apiBaseUrl || resolved.state.url);
    try {
      const response = await this.#fetchJson(endpoint, {
        body: input.body,
        method: input.method,
        token: resolved.state.token,
      });
      if (!response.ok || response.payload?.success === false) {
        return createAlembicResidentServiceUnavailable<unknown>(
          resolved.status,
          response.ok ? 'request-failed' : reasonForHttpStatus(response.status),
          extractResponseError(response.payload) || `resident_service_http_${response.status}`,
          {
            retryable: true,
            telemetry: {
              endpoint: endpoint.toString(),
              feature: input.feature,
              status: response.status,
            },
          }
        );
      }
      return createAlembicResidentServiceSuccess(response.payload, resolved.status, {
        endpoint: endpoint.toString(),
        feature: input.feature,
      });
    } catch (err: unknown) {
      return createAlembicResidentServiceUnavailable<unknown>(
        resolved.status,
        isTimeoutError(err) ? 'request-timeout' : 'request-failed',
        err instanceof Error ? err.message : String(err),
        {
          retryable: true,
          telemetry: { endpoint: endpoint.toString(), feature: input.feature },
        }
      );
    }
  }

  async #resolveProjectScopeIdentity(
    resolved: ResolvedResidentProbe,
    folderPathInput: string | null
  ): Promise<AlembicResidentProjectScopeIdentity> {
    const folderPath = normalizeFolderPath(folderPathInput) ?? this.#projectRoot;
    if (resolved.projectScopeResolution) {
      return buildProjectScopeIdentityFromSummary({
        capability: resolved.projectScopeResolution.capability,
        folderPath,
        source: 'resident-project-scope-endpoint',
        status: resolved.status,
        summary: resolved.projectScopeResolution.summary,
      });
    }

    const statusScope = buildProjectScopeIdentityFromSummary({
      capability: null,
      folderPath,
      source: 'resident-service-scope',
      status: resolved.status,
      summary: normalizeProjectScopeSummary(
        resolved.status.serviceScope.projectIdentity.projectScope
      ),
    });
    if (statusScope.available) {
      return statusScope;
    }

    // ProjectScope 是 Alembic resident 的增强输入；Plugin 只读 resolve 结果。
    // 没有 local Alembic resident、token 或 resolve endpoint 时，降级为单 folder baseline，
    // 并把原因写成 developer-visible 诊断字段，而不是阻断 Codex-facing baseline 搜索。
    if (!isLocalAlembicResident(resolved.status) || !resolved.state?.token) {
      return buildSingleFolderBaselineIdentity({
        detail: resolved.status.message,
        folderPath,
        reason: PROJECT_SCOPE_UNAVAILABLE_REASON,
        status: resolved.status,
      });
    }

    const endpoint = new URL(
      RESIDENT_PROJECT_SCOPE_RESOLVE_PATH,
      resolved.status.apiBaseUrl || resolved.state.url
    );
    endpoint.searchParams.set('folderPath', folderPath);

    try {
      const response = await this.#fetchJson(endpoint, {
        method: 'GET',
        token: resolved.state.token,
      });
      if (
        !response.ok ||
        response.payload?.success === false ||
        !isRecord(response.payload?.data)
      ) {
        return buildSingleFolderBaselineIdentity({
          detail: extractResponseError(response.payload) || `project_scope_http_${response.status}`,
          folderPath,
          reason: PROJECT_SCOPE_UNAVAILABLE_REASON,
          status: resolved.status,
        });
      }

      const data = response.payload.data;
      const summary =
        normalizeProjectScopeSummary(data.summary) ||
        normalizeProjectScopeSummary(resolved.status.serviceScope.projectIdentity.projectScope);
      const capability = isRecord(data.capability) ? data.capability : null;
      const endpointIdentity = buildProjectScopeIdentityFromSummary({
        capability,
        folderPath,
        source: 'resident-project-scope-endpoint',
        status: resolved.status,
        summary,
      });
      if (endpointIdentity.available) {
        return endpointIdentity;
      }
      return buildSingleFolderBaselineIdentity({
        detail: 'ProjectScope resolve endpoint returned no matching summary.',
        folderPath,
        reason: PROJECT_SCOPE_UNAVAILABLE_REASON,
        status: resolved.status,
      });
    } catch (err: unknown) {
      return buildSingleFolderBaselineIdentity({
        detail: err instanceof Error ? err.message : String(err),
        folderPath,
        reason: PROJECT_SCOPE_UNAVAILABLE_REASON,
        status: resolved.status,
      });
    }
  }

  async #resolveProbe(options: AlembicResidentProbeOptions = {}): Promise<ResolvedResidentProbe> {
    if (options.daemonStatus) {
      const direct = {
        state: options.daemonStatus.state,
        status: statusFromDaemonStatus(options.daemonStatus),
      };
      if (isLocalAlembicResident(direct.status)) {
        return direct;
      }
      return (await this.#resolveActiveProjectScopeProbe(direct)) ?? direct;
    }

    const state = this.#readState(this.#projectRoot);
    if (!state?.url) {
      const direct = {
        state,
        status: unavailableStatus('not-running', 'No Alembic daemon state is available.', state),
      };
      return (await this.#resolveActiveProjectScopeProbe(direct)) ?? direct;
    }
    if (!state.token) {
      const direct = {
        state,
        status: unavailableStatus(
          'token-missing',
          'Alembic daemon state is missing its token.',
          state
        ),
      };
      return (await this.#resolveActiveProjectScopeProbe(direct)) ?? direct;
    }

    try {
      const endpoint = new URL(RESIDENT_HEALTH_PATH, state.url);
      const response = await this.#fetchJson(endpoint, { method: 'GET', token: state.token });
      if (!response.ok || response.payload?.success === false) {
        const direct = {
          state,
          status: unavailableStatus(
            response.ok ? 'request-failed' : reasonForHttpStatus(response.status),
            extractResponseError(response.payload) || `resident_health_http_${response.status}`,
            state
          ),
        };
        return (await this.#resolveActiveProjectScopeProbe(direct)) ?? direct;
      }
      return {
        state,
        status: statusFromHealth(response.payload, state),
      };
    } catch (err: unknown) {
      const direct = {
        state,
        status: unavailableStatus(
          isTimeoutError(err) ? 'request-timeout' : 'request-failed',
          err instanceof Error ? err.message : String(err),
          state
        ),
      };
      return (await this.#resolveActiveProjectScopeProbe(direct)) ?? direct;
    }
  }

  async #resolveActiveProjectScopeProbe(
    direct: ResolvedResidentProbe
  ): Promise<ResolvedResidentProbe | null> {
    const candidates = readRuntimeControlProjectRoots();
    for (const candidateRoot of candidates) {
      if (samePath(candidateRoot, this.#projectRoot)) {
        continue;
      }
      const state = this.#readState(candidateRoot);
      if (!state?.url || !state.token) {
        continue;
      }
      const status = await this.#fetchResidentStatus(state);
      if (!status || !isLocalAlembicResident(status)) {
        continue;
      }
      const resolution = await this.#resolveProjectScopeFromEndpoint(
        status,
        state,
        this.#projectRoot
      );
      if (!resolution) {
        continue;
      }
      return {
        projectScopeResolution: resolution,
        state,
        status,
      };
    }
    return null;
  }

  async #fetchResidentStatus(state: DaemonState): Promise<AlembicResidentServiceStatus | null> {
    try {
      const endpoint = new URL(RESIDENT_HEALTH_PATH, state.url);
      const response = await this.#fetchJson(endpoint, { method: 'GET', token: state.token });
      if (!response.ok || response.payload?.success === false) {
        return null;
      }
      return statusFromHealth(response.payload, state);
    } catch {
      return null;
    }
  }

  async #resolveProjectScopeFromEndpoint(
    status: AlembicResidentServiceStatus,
    state: DaemonState,
    folderPath: string
  ): Promise<ResolvedResidentProbe['projectScopeResolution'] | null> {
    if (!isLocalAlembicResident(status) || !state.token) {
      return null;
    }
    const endpoint = new URL(RESIDENT_PROJECT_SCOPE_RESOLVE_PATH, status.apiBaseUrl || state.url);
    endpoint.searchParams.set('folderPath', folderPath);
    try {
      const response = await this.#fetchJson(endpoint, { method: 'GET', token: state.token });
      if (
        !response.ok ||
        response.payload?.success === false ||
        !isRecord(response.payload?.data)
      ) {
        return null;
      }
      const data = response.payload.data;
      const summary = normalizeProjectScopeSummary(data.summary);
      if (!summary) {
        return null;
      }
      return {
        capability: isRecord(data.capability) ? data.capability : null,
        summary,
      };
    } catch {
      return null;
    }
  }

  #ensureFeatureAvailable<TValue>(
    status: AlembicResidentServiceStatus,
    feature: AlembicResidentFeature,
    options: { allowEmbeddedPlugin?: boolean; requireLocalAlembic?: boolean } = {}
  ): AlembicResidentServiceResult<TValue> | null {
    if (options.requireLocalAlembic && !isLocalAlembicResident(status)) {
      return createAlembicResidentServiceUnavailable<TValue>(
        status,
        status.route === 'unavailable' ? 'route-unavailable' : 'unsupported-route',
        'Alembic resident enhancement requires route=local-alembic-daemon and owner=alembic.',
        { telemetry: { feature } }
      );
    }
    if (!options.allowEmbeddedPlugin && status.route === 'embedded-plugin-runtime') {
      return createAlembicResidentServiceUnavailable<TValue>(
        status,
        'unsupported-route',
        'Embedded Plugin runtime is a recoverable Codex host-agent route, not Alembic resident enhancement.',
        { telemetry: { feature } }
      );
    }
    const capability = status.capabilities[feature];
    if (!capability?.available) {
      return createAlembicResidentServiceUnavailable<TValue>(
        status,
        capability?.unavailableReason ?? 'capability-unavailable',
        capability?.message || `Resident service capability ${feature} is unavailable.`,
        { telemetry: { feature } }
      );
    }
    return null;
  }

  #ensureAnyJobFeatureAvailable<TValue>(
    status: AlembicResidentServiceStatus
  ): AlembicResidentServiceResult<TValue> | null {
    const features: AlembicResidentJobFeature[] =
      status.route === 'embedded-plugin-runtime'
        ? ['jobs.host-agent-recoverable.bootstrap', 'jobs.host-agent-recoverable.rescan']
        : ['jobs.internal-ai.bootstrap', 'jobs.internal-ai.rescan'];
    if (features.some((feature) => status.capabilities[feature]?.available)) {
      return null;
    }
    return createAlembicResidentServiceUnavailable<TValue>(
      status,
      status.route === 'unavailable' ? 'route-unavailable' : 'capability-unavailable',
      'No resident job status capability is available for this route.',
      { telemetry: { features } }
    );
  }

  async #fetchJson(
    endpoint: URL,
    input: { body?: Record<string, unknown>; method: 'GET' | 'POST'; token: string }
  ): Promise<{ ok: boolean; payload: ResidentHttpPayload | null; status: number }> {
    const response = await this.#fetch(endpoint, {
      method: input.method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-alembic-daemon-token': input.token,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: this.#timeoutMs > 0 ? AbortSignal.timeout(this.#timeoutMs) : undefined,
    });
    return {
      ok: response.ok,
      payload: (await readJsonResponse(response)) as ResidentHttpPayload | null,
      status: response.status,
    };
  }
}

function statusFromDaemonStatus(status: DaemonStatus): AlembicResidentServiceStatus {
  if (status.health) {
    return statusFromHealth(status.health, status.state);
  }
  if (status.ready && status.state) {
    return embeddedPluginStatus(status.state);
  }
  return unavailableStatus(
    status.status === 'stopped' ? 'not-running' : 'request-failed',
    status.message || 'Alembic daemon is not ready.',
    status.state
  );
}

function statusFromHealth(
  payload: unknown,
  state: DaemonState | null
): AlembicResidentServiceStatus {
  const payloadRecord = isRecord(payload) ? payload : null;
  const data = isRecord(payloadRecord?.data) ? payloadRecord.data : null;
  if (data?.residentService) {
    return withStateFallbacks(normalizeAlembicResidentServiceStatus(data.residentService), state);
  }
  if (state) {
    return embeddedPluginStatus(state);
  }
  return unavailableStatus(
    'route-unavailable',
    'Daemon health did not expose residentService.',
    state
  );
}

function embeddedPluginStatus(state: DaemonState): AlembicResidentServiceStatus {
  return createAlembicResidentServiceStatus({
    apiBaseUrl: state.url,
    capabilityOverrides: {
      'dashboard.handoff': unavailableCapability('dashboard.handoff', 'unsupported-route'),
      'file-monitor.git-worktree': unavailableCapability(
        'file-monitor.git-worktree',
        'unsupported-route'
      ),
      'jobs.host-agent-recoverable.bootstrap': {
        available: true,
        message: 'Embedded Plugin runtime can recover Codex host-agent bootstrap jobs.',
        owner: 'alembic-plugin',
        route: 'embedded-plugin-runtime',
      },
      'jobs.host-agent-recoverable.rescan': {
        available: true,
        message: 'Embedded Plugin runtime can recover Codex host-agent rescan jobs.',
        owner: 'alembic-plugin',
        route: 'embedded-plugin-runtime',
      },
      'jobs.internal-ai.bootstrap': unavailableCapability(
        'jobs.internal-ai.bootstrap',
        'unsupported-route',
        'Alembic internal AI jobs require a local Alembic resident daemon.'
      ),
      'jobs.internal-ai.rescan': unavailableCapability(
        'jobs.internal-ai.rescan',
        'unsupported-route',
        'Alembic internal AI jobs require a local Alembic resident daemon.'
      ),
      'search.keyword': unavailableCapability('search.keyword', 'unsupported-route'),
      'search.semantic': unavailableCapability('search.semantic', 'unsupported-route'),
      'status.health': {
        available: true,
        message: 'Embedded Plugin runtime health is available.',
        owner: 'alembic-plugin',
        route: 'embedded-plugin-runtime',
      },
    },
    message:
      'Embedded Plugin runtime is available for Codex host-agent recovery; it is not Alembic resident enhancement.',
    owner: 'alembic-plugin',
    route: 'embedded-plugin-runtime',
    serviceScope: {
      diagnosticPaths: {
        databasePath: state.databasePath,
        dataRoot: state.dataRoot,
        projectRoot: state.projectRoot,
        runtimeDir: resolveDaemonPaths(state.projectRoot).runtimeDir,
        statePath: resolveDaemonPaths(state.projectRoot).statePath,
      },
      kind: 'current-project',
      projectIdentity: {
        dataRootSource: null,
        projectId: state.projectId,
        projectScope: null,
        projectScopeId: null,
        schemaMigrationVersion: state.schemaMigrationVersion,
        workspaceMode: null,
      },
      scopeId: state.projectId ? `plugin:${state.projectId}` : null,
    },
  });
}

function unavailableStatus(
  reason: AlembicResidentServiceUnavailableReason,
  message: string,
  state?: DaemonState | null
): AlembicResidentServiceStatus {
  return createAlembicResidentServiceStatus({
    apiBaseUrl: state?.url ?? null,
    capabilityOverrides: Object.fromEntries(
      ALEMBIC_RESIDENT_FEATURES.map((feature) => [
        feature,
        unavailableCapability(feature, reason, message),
      ])
    ),
    message,
    owner: 'alembic-plugin',
    route: 'unavailable',
    serviceScope: {
      diagnosticPaths: {
        databasePath: state?.databasePath ?? null,
        dataRoot: state?.dataRoot ?? null,
        projectRoot: state?.projectRoot ?? null,
        runtimeDir: state?.projectRoot ? resolveDaemonPaths(state.projectRoot).runtimeDir : null,
        statePath: state?.projectRoot ? resolveDaemonPaths(state.projectRoot).statePath : null,
      },
      kind: state ? 'runtime-only' : 'unknown',
      projectIdentity: {
        dataRootSource: null,
        projectId: state?.projectId ?? null,
        projectScope: null,
        projectScopeId: null,
        schemaMigrationVersion: state?.schemaMigrationVersion ?? null,
        workspaceMode: null,
      },
      scopeId: null,
    },
  });
}

function unavailableCapability(
  feature: AlembicResidentFeature,
  reason: AlembicResidentServiceUnavailableReason,
  message?: string
) {
  return {
    available: false,
    message:
      message ||
      (feature.startsWith('search.')
        ? 'Search enhancement requires a local Alembic resident daemon.'
        : 'Resident service capability is unavailable for this route.'),
    unavailableReason: reason,
  };
}

function withStateFallbacks(
  status: AlembicResidentServiceStatus,
  state: DaemonState | null
): AlembicResidentServiceStatus {
  if (!state || status.apiBaseUrl) {
    return status;
  }
  return { ...status, apiBaseUrl: state.url };
}

function isLocalAlembicResident(status: AlembicResidentServiceStatus): boolean {
  return status.route === 'local-alembic-daemon' && status.owner === 'alembic';
}

function resolveJobFeature(
  status: AlembicResidentServiceStatus,
  kind: 'bootstrap' | 'rescan'
): AlembicResidentJobFeature {
  if (status.route === 'embedded-plugin-runtime') {
    return `jobs.host-agent-recoverable.${kind}` as AlembicResidentJobFeature;
  }
  return `jobs.internal-ai.${kind}` as AlembicResidentJobFeature;
}

function buildResidentMeta(input: {
  data: Record<string, unknown>;
  durationMs: number;
  endpoint: string;
  items: SearchResultItem[];
  projectScopeIdentity: AlembicResidentProjectScopeIdentity;
  residentRequestMode: string;
  requestedMode: string;
  searchMeta: Record<string, unknown>;
  status: AlembicResidentServiceStatus;
}): ResidentSearchAttemptMeta {
  const meta = input.searchMeta;
  const residentVector = isRecord(meta.residentVector)
    ? (meta.residentVector as ResidentSearchAttemptMeta['residentVector'])
    : {
        available:
          meta.vectorUsed === true ||
          meta.semanticUsed === true ||
          (input.residentRequestMode !== 'semantic' && input.items.length > 0),
        reason:
          typeof meta.fallbackReason === 'string'
            ? meta.fallbackReason
            : input.residentRequestMode === 'semantic' &&
                meta.vectorUsed !== true &&
                meta.semanticUsed !== true
              ? 'resident_search_telemetry_missing'
              : null,
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
    residentRequestMode: input.residentRequestMode,
    requestedMode: input.requestedMode,
    projectScopeIdentity: input.projectScopeIdentity,
    residentService: residentServiceSummary(input.status),
    residentVector,
    resultCount,
    route: 'alembic-resident-service',
    searchMeta: {
      ...meta,
      codexRequestedMode: input.requestedMode,
      projectScopeIdentity: input.projectScopeIdentity,
      residentRequestMode: input.residentRequestMode,
    },
    semanticUsed: booleanFrom(meta.semanticUsed),
    service: stringFrom(meta.service),
    used: input.items.length > 0,
    vectorUsed: booleanFrom(meta.vectorUsed),
    workspace: isRecord(meta.workspace) ? (meta.workspace as Record<string, unknown>) : null,
  };
}

function buildUnavailableSearchResult(
  result: Extract<AlembicResidentServiceResult<ResidentSearchResult>, { ok: false }>,
  request: ResidentSearchRequest
): ResidentSearchResult {
  const requestedMode = normalizeRequestedMode(request.mode);
  const residentRequestMode = normalizeResidentRequestMode(requestedMode);
  return {
    items: [],
    meta: {
      attempted: true,
      available: false,
      durationMs: 0,
      reason: result.reason,
      residentRequestMode,
      requestedMode,
      residentService: result.status ? residentServiceSummary(result.status) : undefined,
      projectScopeIdentity: result.telemetry?.projectScopeIdentity as
        | AlembicResidentProjectScopeIdentity
        | undefined,
      residentVector: {
        available: false,
        reason: result.reason,
      },
      resultCount: 0,
      route: 'alembic-resident-service',
      used: false,
    },
  };
}

function withProjectScopeTelemetry<TValue>(
  result: AlembicResidentServiceResult<TValue>,
  projectScopeIdentity: AlembicResidentProjectScopeIdentity
): AlembicResidentServiceResult<TValue> {
  if (result.ok) {
    return result;
  }
  return {
    ...result,
    telemetry: {
      ...(result.telemetry || {}),
      projectScopeIdentity,
    },
  };
}

function buildProjectScopeIdentityFromSummary(input: {
  capability: Record<string, unknown> | null;
  folderPath: string;
  source: AlembicResidentProjectScopeIdentity['source'];
  status: AlembicResidentServiceStatus;
  summary: ProjectScopeSummary | null;
}): AlembicResidentProjectScopeIdentity {
  if (!input.summary) {
    return buildSingleFolderBaselineIdentity({
      folderPath: input.folderPath,
      reason: PROJECT_SCOPE_UNAVAILABLE_REASON,
      status: input.status,
    });
  }
  return {
    available: true,
    controlRoot: input.summary.controlRoot,
    currentFolderId: input.summary.currentFolderId,
    currentFolderPath: input.summary.currentFolderPath,
    dataRoot: input.summary.dataRoot,
    dataRootSource: input.summary.dataRootSource,
    diagnosticProjectRoot: input.folderPath,
    folderCount: input.summary.folderCount,
    folders: input.summary.folders,
    mode: 'project-scope',
    projectId: input.summary.projectId,
    projectRoot: input.folderPath,
    projectScope: input.summary,
    projectScopeCapability: input.capability,
    projectScopeId: input.summary.projectScopeId,
    reason: null,
    resident: {
      owner: input.status.owner,
      route: input.status.route,
      serviceScopeId: input.status.serviceScope.scopeId,
    },
    serviceScopeId: input.status.serviceScope.scopeId,
    source: input.source,
    storageKind: input.summary.storageKind,
    workspaceMode: input.status.serviceScope.projectIdentity.workspaceMode,
  };
}

function buildSingleFolderBaselineIdentity(input: {
  detail?: string | null;
  folderPath: string;
  reason: string;
  status: AlembicResidentServiceStatus;
}): AlembicResidentProjectScopeIdentity {
  const baseline = resolveSingleFolderBaseline(input.folderPath);
  return {
    available: false,
    controlRoot: null,
    currentFolderId: null,
    currentFolderPath: input.folderPath,
    dataRoot: baseline.dataRoot ?? input.status.serviceScope.diagnosticPaths.dataRoot,
    dataRootSource: baseline.dataRootSource,
    diagnosticProjectRoot: input.folderPath,
    folderCount: 1,
    folders: [],
    mode: 'single-folder-baseline',
    projectId: baseline.projectId ?? input.status.serviceScope.projectIdentity.projectId,
    projectRoot: input.folderPath,
    projectScope: null,
    projectScopeCapability: null,
    projectScopeId: null,
    reason: input.detail ? `${input.reason}: ${input.detail}` : input.reason,
    resident: {
      owner: input.status.owner,
      route: input.status.route,
      serviceScopeId: input.status.serviceScope.scopeId,
    },
    serviceScopeId: input.status.serviceScope.scopeId,
    source: 'plugin-single-folder-baseline',
    storageKind: null,
    workspaceMode:
      baseline.workspaceMode ?? input.status.serviceScope.projectIdentity.workspaceMode,
  };
}

function resolveSingleFolderBaseline(folderPath: string): {
  dataRoot: string | null;
  dataRootSource: string | null;
  projectId: string | null;
  workspaceMode: string | null;
} {
  try {
    const resolver = WorkspaceResolver.fromProject(folderPath);
    const facts = resolver.toFacts();
    return {
      dataRoot: resolver.dataRoot,
      dataRootSource: facts.dataRootSource,
      projectId: resolver.projectId,
      workspaceMode: facts.mode,
    };
  } catch {
    return {
      dataRoot: null,
      dataRootSource: null,
      projectId: null,
      workspaceMode: null,
    };
  }
}

function readRuntimeControlProjectRoots(): string[] {
  const controlPath = join(getProjectRegistryDir(), 'runtime-control.json');
  if (!existsSync(controlPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(controlPath, 'utf8')) as Record<string, unknown>;
    if (parsed.schemaVersion !== PROJECT_RUNTIME_CONTROL_STATE_SCHEMA_VERSION) {
      return [];
    }
    const state = createProjectRuntimeControlState({
      activeProjectId: nullableString(parsed.activeProjectId),
      activeProjectRoot: nullableString(parsed.activeProjectRoot),
      selectedAt: nullableString(parsed.selectedAt),
      selectedProjectId: nullableString(parsed.selectedProjectId),
      selectedProjectRoot: nullableString(parsed.selectedProjectRoot),
      updatedAt: nullableString(parsed.updatedAt) ?? new Date(0).toISOString(),
    });
    // runtime-control 是 Alembic/Dashboard 写入的只读控制面；Plugin 只用它找到
    // 已经启动的 controlRoot resident，再通过 /resolve-folder 验证当前 folder 是否属于
    // 同一 ProjectScope，避免把未绑定临时目录误接到全局 active daemon。
    return uniqueStrings([state.activeProjectRoot, state.selectedProjectRoot]);
  } catch {
    return [];
  }
}

function normalizeFolderPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? resolve(value.trim()) : null;
}

function residentServiceSummary(status: AlembicResidentServiceStatus): Record<string, unknown> {
  const summary = summarizeAlembicResidentServiceStatus(status);
  return {
    availableFeatures: summary.availableFeatures,
    contractVersion: summary.contractVersion,
    owner: summary.owner,
    route: summary.route,
    serviceScope: summary.serviceScope,
    unavailableReasons: summary.unavailableReasons,
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
  const obj = payload as ResidentHttpPayload;
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

function normalizeRequestedMode(mode: unknown): string {
  if (typeof mode !== 'string') {
    return 'auto';
  }
  const normalized = mode.trim().toLowerCase();
  return normalized || 'auto';
}

function normalizeResidentRequestMode(requestedMode: string): 'keyword' | 'bm25' | 'semantic' {
  // Codex-facing auto 仍表示“尽量增强”；Alembic resident API 只接受明确模式。
  switch (requestedMode) {
    case 'keyword':
      return 'keyword';
    case 'bm25':
    case 'context':
    case 'weighted':
      return 'bm25';
    case 'semantic':
    case 'auto':
      return 'semantic';
  }
  return 'semantic';
}

function buildJobQuery(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (args.kind === 'bootstrap' || args.kind === 'rescan') {
    params.set('kind', args.kind);
  }
  if (
    args.status === 'queued' ||
    args.status === 'running' ||
    args.status === 'completed' ||
    args.status === 'failed' ||
    args.status === 'cancelled'
  ) {
    params.set('status', args.status);
  }
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    params.set('limit', String(args.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function reasonForHttpStatus(status: number): AlembicResidentServiceUnavailableReason {
  return status === 401 || status === 403 ? 'token-missing' : 'request-failed';
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
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

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const normalized = resolve(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function samePath(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false;
  }
  return resolve(left) === resolve(right);
}
