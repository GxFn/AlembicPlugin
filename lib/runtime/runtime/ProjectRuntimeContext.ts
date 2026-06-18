import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createProjectRuntimeFailureEnvelope,
  createProjectRuntimeIdentityContract,
  createProjectRuntimeServiceReadiness,
  normalizeAlembicRuntimeDataRootSource,
  type ProjectRuntimeFailureEnvelope,
  type ProjectRuntimeFailureReason,
  type ProjectRuntimeIdentityContract,
  type ProjectRuntimeReadinessState,
  type ProjectRuntimeRequiredService,
  type ProjectRuntimeServiceReadiness,
} from '@alembic/core/daemon';
import { WorkspaceResolver } from '@alembic/core/workspace';
import type { HostEnhancementRouteChoice } from '../../runtime/EnhancementRoute.js';
import type { CodexHostProjectAlignment } from '../../runtime/HostProjectAlignment.js';
import { readCodexPluginMcpDeclaration } from '../../runtime/PluginRegistry.js';
import type { CodexProjectRootResolution } from '../../runtime/ProjectRootResolver.js';
import type { HostRuntimeContext } from '../../runtime/runtime/RuntimeContext.js';
import { resolveHostRuntimeContext } from '../../runtime/runtime/RuntimeContext.js';
import type {
  AlembicResidentProjectScopeIdentity,
  ResidentSearchAttemptMeta,
} from '../../service/resident/AlembicResidentServiceClient.js';
import type { DaemonStatus } from '../daemon-status.js';

const PROJECT_RUNTIME_CONTEXT_VERSION = 1;

export type CodexMcpEntryMode = 'local-dev-direct-dist' | 'marketplace-shell' | 'unknown';

export interface CodexProjectRuntimeContext {
  contractVersion: typeof PROJECT_RUNTIME_CONTEXT_VERSION;
  blockedFallbacks: string[];
  entryMode: CodexProjectRuntimeEntryMode;
  fallbackIsolation: CodexRuntimeFallbackIsolation[];
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

export type CodexRuntimeFallbackIsolationId =
  | 'embedded-plugin-owned-runtime'
  | 'local-jobstore'
  | 'runtime-control-selected-active'
  | 'saved-project-root';

export interface CodexRuntimeFallbackIsolation {
  id: CodexRuntimeFallbackIsolationId;
  allowedUse:
    | 'blocked-effective-identity'
    | 'codex-host-agent-execution-route'
    | 'embedded-host-agent-recovery'
    | 'read-only-diagnostics';
  effectiveIdentityAllowed: false;
  legacyEffectiveIdentityFallback: string | null;
  persistenceRootAllowed: false;
  reason: string;
}

export const CODEX_RUNTIME_FALLBACK_ISOLATION: readonly CodexRuntimeFallbackIsolation[] = [
  {
    allowedUse: 'blocked-effective-identity',
    effectiveIdentityAllowed: false,
    id: 'saved-project-root',
    legacyEffectiveIdentityFallback: 'saved-project-root-effective-identity',
    persistenceRootAllowed: false,
    reason:
      'Saved Codex project-root state is diagnostic or recovery context only; the current trusted Codex project remains the effective identity.',
  },
  {
    allowedUse: 'read-only-diagnostics',
    effectiveIdentityAllowed: false,
    id: 'runtime-control-selected-active',
    legacyEffectiveIdentityFallback: 'runtime-control-selected-active-effective-identity',
    persistenceRootAllowed: false,
    reason:
      'Alembic selected or active runtime control state is read-only diagnostic evidence and cannot replace the Codex current project identity.',
  },
  {
    allowedUse: 'embedded-host-agent-recovery',
    effectiveIdentityAllowed: false,
    id: 'local-jobstore',
    legacyEffectiveIdentityFallback: 'local-jobstore-default-effective-identity',
    persistenceRootAllowed: false,
    reason:
      'Local JobStore access is limited to recoverable embedded Codex host-agent jobs for the current project identity.',
  },
  {
    allowedUse: 'codex-host-agent-execution-route',
    effectiveIdentityAllowed: false,
    id: 'embedded-plugin-owned-runtime',
    legacyEffectiveIdentityFallback: null,
    persistenceRootAllowed: false,
    reason:
      'The embedded Plugin-owned MCP runtime is an execution route for Codex-facing tools; project identity and persistence still come from the unified ProjectRuntimeContext.',
  },
];

export function getCodexRuntimeFallbackIsolation(
  id: CodexRuntimeFallbackIsolationId
): CodexRuntimeFallbackIsolation {
  const isolation = CODEX_RUNTIME_FALLBACK_ISOLATION.find((item) => item.id === id);
  if (!isolation) {
    throw new Error(`Unknown Codex runtime fallback isolation id: ${id}`);
  }
  return { ...isolation };
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
  diagnostics: Record<string, unknown>[];
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
    activeProject: Record<string, unknown> | null;
    activeReadyProject: Record<string, unknown> | null;
    activeStateTrusted: boolean | null;
    diagnostics: Record<string, unknown>[];
    projects: Record<string, unknown> | null;
    readOnly: boolean | null;
    selectedMatchesCurrentProject: boolean | null;
    selectedProject: Record<string, unknown> | null;
    state: Record<string, unknown> | null;
    stateCleanup: Record<string, unknown> | null;
    statePath: string | null;
  } | null;
  targetProject: Record<string, unknown> | null;
  writePolicy: Record<string, unknown> | null;
}

export interface BuildCodexProjectRuntimeContextOptions {
  daemonStatus?: DaemonStatus | null;
  enhancementRoute?: HostEnhancementRouteChoice | null;
  hostProjectAlignment?: CodexHostProjectAlignment | null;
  includeOptionalServices?: boolean;
  projectRoot: string;
  projectRootResolution?: CodexProjectRootResolution | null;
  projectScopeIdentity?: AlembicResidentProjectScopeIdentity | null;
  requiredServices?: readonly ProjectRuntimeRequiredService[];
  runtime?: HostRuntimeContext;
}

export function buildCodexProjectRuntimeContext(
  options: BuildCodexProjectRuntimeContextOptions
): CodexProjectRuntimeContext {
  const projectRoot = resolve(options.projectRoot);
  const runtime = options.runtime ?? resolveHostRuntimeContext();
  const resolver = WorkspaceResolver.fromProject(projectRoot, {
    currentFolderId: options.projectScopeIdentity?.currentFolderId ?? undefined,
  });
  const facts = resolver.toFacts();
  const identity = buildProjectRuntimeIdentity({
    facts,
    projectRoot,
    projectScopeIdentity: options.projectScopeIdentity ?? null,
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
    fallbackIsolation: CODEX_RUNTIME_FALLBACK_ISOLATION.map((item) => ({ ...item })),
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
  | 'fallbackIsolation'
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

function buildProjectRuntimeIdentity(input: {
  facts: ReturnType<WorkspaceResolver['toFacts']>;
  projectRoot: string;
  projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
}): ProjectRuntimeIdentityContract {
  const residentIdentity = input.projectScopeIdentity;
  const residentScope = residentIdentity?.available === true ? residentIdentity.projectScope : null;
  const residentDataRoot =
    residentIdentity?.available === true
      ? (stringFrom(residentIdentity.dataRoot) ?? stringFrom(residentScope?.dataRoot))
      : null;

  if (residentDataRoot) {
    const runtimeDir = join(residentDataRoot, '.asd');
    const dataRootSource =
      normalizeAlembicRuntimeDataRootSource(residentIdentity?.dataRootSource) ??
      normalizeAlembicRuntimeDataRootSource(residentScope?.dataRootSource) ??
      input.facts.dataRootSource;
    return createProjectRuntimeIdentityContract({
      currentFolderId:
        residentIdentity?.currentFolderId ??
        residentScope?.currentFolderId ??
        input.facts.currentFolderId,
      dataRoot: residentDataRoot,
      dataRootSource,
      databasePath: join(runtimeDir, 'alembic.db'),
      ghost: true,
      mode: 'ghost',
      projectExists: existsSync(input.projectRoot),
      projectId: residentIdentity?.projectId ?? residentScope?.projectId ?? input.facts.projectId,
      projectRealpath: input.facts.projectRealpath,
      projectRoot: input.projectRoot,
      projectScope: residentScope ?? input.facts.projectScope ?? null,
      projectScopeId:
        residentIdentity?.projectScopeId ??
        residentScope?.projectScopeId ??
        input.facts.projectScopeId,
      registered: true,
      runtimeDir,
      workspaceExists: existsSync(residentDataRoot),
    });
  }

  return createProjectRuntimeIdentityContract({
    currentFolderId: input.facts.currentFolderId ?? residentIdentity?.currentFolderId ?? null,
    dataRoot: input.facts.dataRoot,
    dataRootSource: input.facts.dataRootSource,
    databasePath: input.facts.databasePath,
    ghost: input.facts.ghost,
    mode: input.facts.mode,
    projectExists: existsSync(input.projectRoot),
    projectId: input.facts.projectId ?? residentIdentity?.projectId ?? null,
    projectRealpath: input.facts.projectRealpath,
    projectRoot: input.projectRoot,
    projectScope: residentIdentity?.projectScope ?? input.facts.projectScope ?? null,
    projectScopeId: input.facts.projectScopeId ?? residentIdentity?.projectScopeId ?? null,
    registered: input.facts.registered,
    runtimeDir: input.facts.runtimeDir,
    workspaceExists: input.facts.workspaceExists,
  });
}

function buildRequiredServiceReadiness(input: {
  daemonStatus: DaemonStatus | null;
  enhancementRoute: HostEnhancementRouteChoice | null;
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
    enhancementRoute: HostEnhancementRouteChoice | null;
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
  if (sourceReason === 'daemon-missing') {
    return 'daemon-missing';
  }
  if (sourceReason === 'daemon-not-running') {
    return 'daemon-missing';
  }
  if (
    sourceReason === 'runtime-control-active-stale' ||
    sourceReason === 'runtime-control-selected-mismatch'
  ) {
    return 'daemon-stale';
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

function detectCodexMcpEntryMode(runtime: HostRuntimeContext): CodexProjectRuntimeEntryMode {
  // Shared per-host declaration reader: .mcp.json (Codex shell, historical
  // byte-identical behavior) or the inline .claude-plugin manifest mcpServers
  // (Claude Code shell). Fixes the mode=unknown meta riding F-V2-2.
  const declaration = readCodexPluginMcpDeclaration(runtime.pluginRoot);
  const command = stringFrom(declaration.server?.command);
  const args = declaration.args;
  const runtimeSpecifier = args.includes('--package')
    ? (args[args.indexOf('--package') + 1] ?? null)
    : null;
  const mode = args.some((arg) => arg.endsWith('alembic-start.mjs'))
    ? 'marketplace-shell'
    : args.some(
          (arg) => arg.endsWith('/dist/bin/host-mcp.js') || arg.endsWith('dist/bin/host-mcp.js')
        )
      ? 'local-dev-direct-dist'
      : 'unknown';

  // Existence (not parse success) keeps the historical Codex-side semantics
  // for present-but-unparsable declarations byte-identical.
  const declarationExists = existsSync(declaration.json.path);
  return {
    command,
    mcpConfigPath: declarationExists ? declaration.json.path : null,
    mode,
    runtimeSpecifier: runtimeSpecifier ?? runtime.pinnedRuntimeSpecifier,
    source: declarationExists ? 'plugin-mcp-config' : 'runtime-context',
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
    diagnostics: recordArrayFrom(raw.diagnostics),
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
          activeProject: asRecord(runtimeControl.activeProject),
          activeReadyProject: asRecord(runtimeControl.activeReadyProject),
          activeStateTrusted: booleanFrom(runtimeControl.activeStateTrusted),
          diagnostics: recordArrayFrom(runtimeControl.diagnostics),
          projects: asRecord(runtimeControl.projects),
          readOnly: booleanFrom(runtimeControl.readOnly),
          selectedMatchesCurrentProject: booleanFrom(runtimeControl.selectedMatchesCurrentProject),
          selectedProject: asRecord(runtimeControl.selectedProject),
          state: asRecord(runtimeControl.state),
          stateCleanup: asRecord(runtimeControl.stateCleanup),
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

function _readJsonFile(path: string): Record<string, unknown> | null {
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

function recordArrayFrom(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
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
