import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createProjectRuntimeFailureEnvelope,
  createProjectRuntimeIdentityContract,
  createProjectRuntimeServiceReadiness,
  type ProjectRuntimeFailureEnvelope,
  type ProjectRuntimeFailureReason,
  type ProjectRuntimeIdentityContract,
  type ProjectRuntimeReadinessState,
  type ProjectRuntimeRequiredService,
  type ProjectRuntimeServiceReadiness,
} from '@alembic/core/daemon';
import { WorkspaceResolver } from '@alembic/core/workspace';
import type { DaemonStatus } from '../../daemon/DaemonSupervisor.js';
import type {
  AlembicResidentProjectScopeIdentity,
  ResidentSearchAttemptMeta,
} from '../../service/resident/AlembicResidentServiceClient.js';
import type { CodexEnhancementRouteChoice } from '../EnhancementRoute.js';
import type { CodexHostProjectAlignment } from '../HostProjectAlignment.js';
import type { CodexProjectRootResolution } from '../ProjectRootResolver.js';
import type { CodexRuntimeContext } from './RuntimeContext.js';
import { resolveCodexRuntimeContext } from './RuntimeContext.js';

const PROJECT_RUNTIME_CONTEXT_VERSION = 1;

export type CodexMcpEntryMode = 'local-dev-direct-dist' | 'packaged-wrapper' | 'unknown';

export interface CodexProjectRuntimeContext {
  contractVersion: typeof PROJECT_RUNTIME_CONTEXT_VERSION;
  blockedFallbacks: string[];
  entryMode: CodexProjectRuntimeEntryMode;
  failureEnvelopes: ProjectRuntimeFailureEnvelope[];
  identity: ProjectRuntimeIdentityContract;
  readinessState: ProjectRuntimeReadinessState;
  requiredServices: ProjectRuntimeServiceReadiness[];
  sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null;
  sourcePolicy: {
    effectiveIdentitySource: 'codex-current-project';
    projectScopeSource: 'resident-read-only' | 'single-folder-baseline';
    runtimeControlSource: 'read-only-diagnostics';
    selectedOrActiveCanOverrideEffectiveIdentity: false;
  };
}

export interface CodexProjectRuntimeEntryMode {
  mode: CodexMcpEntryMode;
  command: string | null;
  mcpConfigPath: string | null;
  runtimeSpecifier: string | null;
  source: 'plugin-mcp-config' | 'runtime-context';
}

export interface CodexAlembicRuntimeSourceOfTruth {
  contractVersion: number | null;
  failure: Record<string, unknown> | null;
  operation: Record<string, unknown> | null;
  owner: string | null;
  readiness: {
    ready: boolean | null;
    reasonCode: string | null;
    stale: boolean | null;
    status: string | null;
  } | null;
  requiredService: {
    kind: string | null;
    owner: string | null;
    route: string | null;
  } | null;
  route: string | null;
  runtimeControl: {
    activeMatchesCurrentProject: boolean | null;
    activeStateTrusted: boolean | null;
    readOnly: boolean | null;
    selectedMatchesCurrentProject: boolean | null;
    statePath: string | null;
  } | null;
  targetProject: Record<string, unknown> | null;
  writePolicy: Record<string, unknown> | null;
}

export interface BuildCodexProjectRuntimeContextOptions {
  daemonStatus?: DaemonStatus | null;
  enhancementRoute?: CodexEnhancementRouteChoice | null;
  hostProjectAlignment?: CodexHostProjectAlignment | null;
  includeOptionalServices?: boolean;
  projectRoot: string;
  projectRootResolution?: CodexProjectRootResolution | null;
  projectScopeIdentity?: AlembicResidentProjectScopeIdentity | null;
  requiredServices?: readonly ProjectRuntimeRequiredService[];
  runtime?: CodexRuntimeContext;
}

export function buildCodexProjectRuntimeContext(
  options: BuildCodexProjectRuntimeContextOptions
): CodexProjectRuntimeContext {
  const projectRoot = resolve(options.projectRoot);
  const runtime = options.runtime ?? resolveCodexRuntimeContext();
  const resolver = WorkspaceResolver.fromProject(projectRoot, {
    currentFolderId: options.projectScopeIdentity?.currentFolderId ?? undefined,
  });
  const facts = resolver.toFacts();
  const identity = createProjectRuntimeIdentityContract({
    currentFolderId: facts.currentFolderId ?? options.projectScopeIdentity?.currentFolderId ?? null,
    dataRoot: facts.dataRoot,
    dataRootSource: facts.dataRootSource,
    databasePath: facts.databasePath,
    ghost: facts.ghost,
    mode: facts.mode,
    projectExists: existsSync(projectRoot),
    projectId: facts.projectId ?? options.projectScopeIdentity?.projectId ?? null,
    projectRealpath: facts.projectRealpath,
    projectRoot,
    projectScope: options.projectScopeIdentity?.projectScope ?? facts.projectScope ?? null,
    projectScopeId: facts.projectScopeId ?? options.projectScopeIdentity?.projectScopeId ?? null,
    registered: facts.registered,
    runtimeDir: facts.runtimeDir,
    workspaceExists: facts.workspaceExists,
  });
  const sourceOfTruth = extractAlembicRuntimeSourceOfTruth(options.daemonStatus);
  const requiredServices = buildRequiredServiceReadiness({
    daemonStatus: options.daemonStatus ?? null,
    enhancementRoute: options.enhancementRoute ?? null,
    hostProjectAlignment: options.hostProjectAlignment ?? null,
    identity,
    includeOptionalServices: options.includeOptionalServices ?? true,
    projectRootResolution: options.projectRootResolution ?? null,
    projectScopeIdentity: options.projectScopeIdentity ?? null,
    requiredServices: options.requiredServices ?? ['project-identity'],
    sourceOfTruth,
  });
  const readinessState = summarizeReadiness(requiredServices);
  const failureEnvelopes = requiredServices
    .filter((service) => service.state !== 'ready' && service.reason)
    .map((service) =>
      createProjectRuntimeFailureEnvelope({
        identity,
        message: service.message,
        readinessState: service.state,
        reason: service.reason ?? 'runtime-unavailable',
        service: service.service,
        source: service.source,
      })
    );

  return {
    contractVersion: PROJECT_RUNTIME_CONTEXT_VERSION,
    blockedFallbacks: [
      'saved-project-root-effective-identity',
      'runtime-control-selected-active-effective-identity',
      'local-jobstore-default-effective-identity',
    ],
    entryMode: detectCodexMcpEntryMode(runtime),
    failureEnvelopes,
    identity,
    readinessState,
    requiredServices,
    sourceOfTruth,
    sourcePolicy: {
      effectiveIdentitySource: 'codex-current-project',
      projectScopeSource: options.projectScopeIdentity?.available
        ? 'resident-read-only'
        : 'single-folder-baseline',
      runtimeControlSource: 'read-only-diagnostics',
      selectedOrActiveCanOverrideEffectiveIdentity: false,
    },
  };
}

export function buildCodexPrimeRuntimeContext(input: {
  projectRoot: string;
  residentSearch?: ResidentSearchAttemptMeta | null;
}): Pick<
  CodexProjectRuntimeContext,
  | 'blockedFallbacks'
  | 'contractVersion'
  | 'failureEnvelopes'
  | 'identity'
  | 'readinessState'
  | 'requiredServices'
  | 'sourcePolicy'
> {
  return buildCodexProjectRuntimeContext({
    projectRoot: input.projectRoot,
    projectScopeIdentity: input.residentSearch?.projectScopeIdentity ?? null,
    requiredServices: ['project-identity'],
  });
}

function buildRequiredServiceReadiness(input: {
  daemonStatus: DaemonStatus | null;
  enhancementRoute: CodexEnhancementRouteChoice | null;
  hostProjectAlignment: CodexHostProjectAlignment | null;
  identity: ProjectRuntimeIdentityContract;
  includeOptionalServices: boolean;
  projectRootResolution: CodexProjectRootResolution | null;
  projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
  requiredServices: readonly ProjectRuntimeRequiredService[];
  sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null;
}): ProjectRuntimeServiceReadiness[] {
  const required = new Set<ProjectRuntimeRequiredService>(input.requiredServices);
  const services: ProjectRuntimeRequiredService[] = input.includeOptionalServices
    ? ['project-identity', 'project-scope', 'daemon', 'jobs', 'api-ai', 'dashboard', 'file-monitor']
    : [...required];
  return services.map((service) =>
    createProjectRuntimeServiceReadiness({
      available: isServiceAvailable(service, input),
      message: serviceMessage(service, input),
      reason: serviceFailureReason(service, input),
      required: required.has(service),
      service,
      source: serviceSource(service, input),
    })
  );
}

function isServiceAvailable(
  service: ProjectRuntimeRequiredService,
  input: {
    daemonStatus: DaemonStatus | null;
    enhancementRoute: CodexEnhancementRouteChoice | null;
    hostProjectAlignment: CodexHostProjectAlignment | null;
    identity: ProjectRuntimeIdentityContract;
    projectRootResolution: CodexProjectRootResolution | null;
    projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
    sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null;
  }
): boolean {
  switch (service) {
    case 'project-identity':
      return Boolean(
        input.identity.projectRoot &&
          input.identity.dataRoot &&
          input.identity.runtimeDir &&
          (!input.projectRootResolution || input.projectRootResolution.trust === 'trusted')
      );
    case 'project-scope':
      return input.projectScopeIdentity?.available === true;
    case 'daemon':
      return input.daemonStatus?.ready === true && input.daemonStatus.status === 'ready';
    case 'jobs':
      return (
        input.sourceOfTruth?.readiness?.ready === true ||
        input.enhancementRoute?.localAlembic.daemon.capabilities.jobsAvailable === true ||
        input.enhancementRoute?.localAlembic.daemon.capabilities.residentDaemonJobsAvailable ===
          true
      );
    case 'api-ai':
      return (
        input.sourceOfTruth?.readiness?.ready === true &&
        input.sourceOfTruth.readiness.reasonCode === 'ready' &&
        input.enhancementRoute?.residentDaemonJobProvider.available === true
      );
    case 'dashboard':
      return (
        input.enhancementRoute?.selected === 'local-alembic-daemon' &&
        input.enhancementRoute.localAlembic.daemon.capabilities.dashboardAvailable === true &&
        Boolean(input.enhancementRoute.localAlembic.daemon.dashboardUrl)
      );
    case 'file-monitor':
      return input.sourceOfTruth?.readiness?.ready === true;
  }
}

function serviceFailureReason(
  service: ProjectRuntimeRequiredService,
  input: {
    daemonStatus: DaemonStatus | null;
    hostProjectAlignment: CodexHostProjectAlignment | null;
    projectRootResolution: CodexProjectRootResolution | null;
    projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
    sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null;
  }
): ProjectRuntimeFailureReason | null {
  if (isServiceAvailable(service, { ...input, enhancementRoute: null, identity: nullIdentity() })) {
    return null;
  }
  switch (service) {
    case 'project-identity':
      return input.projectRootResolution?.trust === 'rejected'
        ? 'project-identity-missing'
        : 'project-not-registered';
    case 'project-scope':
      return 'project-scope-unavailable';
    case 'daemon':
      return daemonFailureReason(input.daemonStatus, input.sourceOfTruth);
    case 'jobs':
      return 'jobs-unavailable';
    case 'api-ai':
      return 'api-ai-unavailable';
    case 'dashboard':
      return input.hostProjectAlignment?.connectionState === 'mismatch'
        ? 'daemon-unavailable'
        : 'dashboard-unavailable';
    case 'file-monitor':
      return 'file-monitor-unavailable';
  }
}

function serviceMessage(
  service: ProjectRuntimeRequiredService,
  input: {
    daemonStatus: DaemonStatus | null;
    hostProjectAlignment: CodexHostProjectAlignment | null;
    projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
    sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null;
  }
): string | null {
  if (service === 'project-scope' && input.projectScopeIdentity?.reason) {
    return input.projectScopeIdentity.reason;
  }
  if (service === 'dashboard' && input.hostProjectAlignment?.connectionState === 'mismatch') {
    return 'Codex host project does not match the Alembic selected or active runtime project.';
  }
  if (service === 'daemon') {
    return (
      input.sourceOfTruth?.failure?.blockingCondition?.toString() ??
      input.daemonStatus?.message ??
      null
    );
  }
  return null;
}

function serviceSource(
  service: ProjectRuntimeRequiredService,
  input: {
    projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
    sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null;
  }
): string {
  switch (service) {
    case 'project-identity':
      return 'codex-current-project';
    case 'project-scope':
      return input.projectScopeIdentity?.source ?? 'single-folder-baseline';
    case 'daemon':
    case 'jobs':
    case 'api-ai':
    case 'dashboard':
    case 'file-monitor':
      return input.sourceOfTruth?.route ?? 'alembic-resident-service';
  }
}

function daemonFailureReason(
  status: DaemonStatus | null,
  sourceOfTruth: CodexAlembicRuntimeSourceOfTruth | null
): ProjectRuntimeFailureReason {
  const sourceReason = sourceOfTruth?.readiness?.reasonCode;
  if (sourceReason === 'daemon-stale') {
    return 'daemon-stale';
  }
  if (sourceReason === 'daemon-starting') {
    return 'daemon-starting';
  }
  if (sourceReason === 'daemon-failed') {
    return 'daemon-failed';
  }
  if (sourceReason === 'daemon-not-running') {
    return 'daemon-missing';
  }
  switch (status?.status) {
    case 'failed':
      return 'daemon-failed';
    case 'ready':
      return status.ready ? 'daemon-unavailable' : 'daemon-not-checked';
    case 'stale':
      return 'daemon-stale';
    case 'starting':
      return 'daemon-starting';
    case 'stopped':
      return 'daemon-missing';
    default:
      return 'daemon-not-checked';
  }
}

function summarizeReadiness(
  services: readonly ProjectRuntimeServiceReadiness[]
): ProjectRuntimeReadinessState {
  if (services.some((service) => service.state === 'blocked')) {
    return 'blocked';
  }
  if (services.some((service) => service.state === 'degraded')) {
    return 'degraded';
  }
  return 'ready';
}

function detectCodexMcpEntryMode(runtime: CodexRuntimeContext): CodexProjectRuntimeEntryMode {
  const mcpConfigPath = join(runtime.pluginRoot, '.mcp.json');
  const parsed = readJsonFile(mcpConfigPath);
  const mcpServers = asRecord(parsed?.mcpServers);
  const server = asRecord(mcpServers?.alembic);
  const command = stringFrom(server?.command);
  const args = Array.isArray(server?.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const runtimeSpecifier = args.includes('--package')
    ? (args[args.indexOf('--package') + 1] ?? null)
    : null;
  const mode = args.some((arg) => arg.endsWith('alembic-codex-mcp-wrapper.mjs'))
    ? 'packaged-wrapper'
    : args.some(
          (arg) => arg.endsWith('/dist/bin/codex-mcp.js') || arg.endsWith('dist/bin/codex-mcp.js')
        )
      ? 'local-dev-direct-dist'
      : 'unknown';

  return {
    command,
    mcpConfigPath: existsSync(mcpConfigPath) ? mcpConfigPath : null,
    mode,
    runtimeSpecifier: runtimeSpecifier ?? runtime.embeddedRuntimeSpecifier,
    source: existsSync(mcpConfigPath) ? 'plugin-mcp-config' : 'runtime-context',
  };
}

function extractAlembicRuntimeSourceOfTruth(
  daemonStatus?: DaemonStatus | null
): CodexAlembicRuntimeSourceOfTruth | null {
  const data = asRecord(daemonStatus?.health?.data);
  const raw = asRecord(data?.projectRuntimeSourceOfTruth);
  if (!raw) {
    return null;
  }
  const readiness = asRecord(raw.readiness);
  const requiredService = asRecord(raw.requiredService);
  const runtimeControl = asRecord(raw.runtimeControl);
  return {
    contractVersion: numberFrom(raw.contractVersion),
    failure: asRecord(raw.failure),
    operation: asRecord(raw.operation),
    owner: stringFrom(raw.owner),
    readiness: readiness
      ? {
          ready: booleanFrom(readiness.ready),
          reasonCode: stringFrom(readiness.reasonCode),
          stale: booleanFrom(readiness.stale),
          status: stringFrom(readiness.status),
        }
      : null,
    requiredService: requiredService
      ? {
          kind: stringFrom(requiredService.kind),
          owner: stringFrom(requiredService.owner),
          route: stringFrom(requiredService.route),
        }
      : null,
    route: stringFrom(raw.route),
    runtimeControl: runtimeControl
      ? {
          activeMatchesCurrentProject: booleanFrom(runtimeControl.activeMatchesCurrentProject),
          activeStateTrusted: booleanFrom(runtimeControl.activeStateTrusted),
          readOnly: booleanFrom(runtimeControl.readOnly),
          selectedMatchesCurrentProject: booleanFrom(runtimeControl.selectedMatchesCurrentProject),
          statePath: stringFrom(runtimeControl.statePath),
        }
      : null,
    targetProject: asRecord(raw.targetProject),
    writePolicy: asRecord(raw.writePolicy),
  };
}

function nullIdentity(): ProjectRuntimeIdentityContract {
  return createProjectRuntimeIdentityContract();
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanFrom(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
