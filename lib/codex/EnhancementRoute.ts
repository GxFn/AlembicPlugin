import { spawnSync } from 'node:child_process';
import {
  type AlembicFileMonitorMode,
  type AlembicResidentServiceStatus,
  type AlembicResidentServiceStatusSummary,
  type AlembicRuntimeCapabilitySummary,
  type AlembicRuntimeRouteKind,
  normalizeAlembicFileMonitorMode,
  normalizeAlembicResidentServiceStatus,
  summarizeAlembicResidentServiceStatus,
  summarizeAlembicRuntimeCapabilities,
} from '@alembic/core/daemon';
import { HOST_AGENT_SOURCE } from '@alembic/core/shared';
import type { DaemonStatus } from '../daemon/DaemonSupervisor.js';
import {
  CODEX_RUNTIME_PACKAGE,
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from './runtime/RuntimeContext.js';

export type CodexEnhancementRequirement = 'dashboard' | 'jobs' | 'mcp' | 'status';

export type CodexEnhancementRouteKind = AlembicRuntimeRouteKind;

export const CODEX_HOST_AGENT_ROUTE_TOOLS = [
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
] as const;

export type CodexDaemonCapabilitySummary = AlembicRuntimeCapabilitySummary;

export interface CodexDaemonRuntimeBoundarySummary {
  available: boolean;
  dashboard: {
    frontendOwner: string | null;
    handoff: string | null;
    serverOwner: string | null;
    url: string | null;
  };
  daemon: {
    apiBaseUrl: string | null;
    mode: string | null;
    owner: string | null;
    stateContract: string | null;
  };
  fileMonitor: {
    available: boolean | null;
    longLivedOwner: string | null;
    mode: AlembicFileMonitorMode | null;
  };
  internalAi: {
    available: boolean | null;
    owner: string | null;
    runtimeOwner: string | null;
  };
  jobs: {
    kinds: string[];
    owner: string | null;
    store: string | null;
  };
  owner: string | null;
  route: string | null;
  source: 'capabilities.runtimeBoundary' | 'data.runtimeBoundary' | null;
  workspace: {
    contract: string | null;
    databasePath: string | null;
    dataRoot: string | null;
    dataRootSource: string | null;
    mode: string | null;
    projectId: string | null;
    projectRoot: string | null;
    runtimeDir: string | null;
  };
}

export interface CodexEnhancementDaemonProbe {
  available: boolean;
  capabilities: CodexDaemonCapabilitySummary;
  dashboardUrl: string | null;
  healthVersion: string | null;
  packageName: string | null;
  ready: boolean;
  residentService: {
    status: AlembicResidentServiceStatus;
    summary: AlembicResidentServiceStatusSummary;
  } | null;
  route: string | null;
  runtimeBoundary: CodexDaemonRuntimeBoundarySummary;
  status: string;
  version: string | null;
}

export interface CodexLocalAlembicInstallProbe {
  available: boolean;
  command: string;
  error: string | null;
  version: string | null;
}

export interface CodexEnhancementRouteChoice {
  embeddedRuntime: {
    artifact: string;
    available: boolean;
    packageName: string;
    route: 'embedded-plugin-runtime';
    version: string;
  };
  hostAgentRoute: {
    requiresAiProvider: false;
    source: typeof HOST_AGENT_SOURCE;
    tools: typeof CODEX_HOST_AGENT_ROUTE_TOOLS;
  };
  internalAiProvider: {
    available: boolean;
    configSource: 'empty' | 'process-env' | 'runtime-overrides' | 'workspace-settings' | null;
    model: string | null;
    provider: string | null;
  };
  localAlembic: {
    daemon: CodexEnhancementDaemonProbe;
    install: CodexLocalAlembicInstallProbe;
  };
  missingCapabilities: string[];
  reason: string;
  requirement: CodexEnhancementRequirement;
  selected: CodexEnhancementRouteKind;
}

export function buildCodexEnhancementRouteChoice(input: {
  daemonStatus: DaemonStatus;
  localInstall?: CodexLocalAlembicInstallProbe;
  requirement?: CodexEnhancementRequirement;
  runtime?: CodexRuntimeContext;
}): CodexEnhancementRouteChoice {
  const runtime = input.runtime || resolveCodexRuntimeContext();
  const requirement = input.requirement || 'status';
  const daemon = summarizeEnhancementDaemon(input.daemonStatus);
  const localInstall = input.localInstall || probeLocalAlembicInstall();
  const missingCapabilities = findMissingCapabilities(requirement, daemon);
  const internalAiProvider = summarizeInternalAiProvider(input.daemonStatus.health);
  const embeddedRuntime = {
    artifact: runtime.embeddedRuntimeSpecifier,
    available: true,
    packageName: runtime.runtimePackage || CODEX_RUNTIME_PACKAGE,
    route: 'embedded-plugin-runtime' as const,
    version: runtime.packageVersion,
  };

  const selected = selectEnhancementRoute({
    daemon,
    localInstall,
    missingCapabilities,
    requirement,
  });

  return {
    embeddedRuntime,
    hostAgentRoute: {
      requiresAiProvider: false,
      source: HOST_AGENT_SOURCE,
      tools: CODEX_HOST_AGENT_ROUTE_TOOLS,
    },
    internalAiProvider,
    localAlembic: {
      daemon,
      install: localInstall,
    },
    missingCapabilities,
    reason: buildEnhancementRouteReason({
      daemon,
      localInstall,
      missingCapabilities,
      requirement,
      selected,
    }),
    requirement,
    selected,
  };
}

export function probeLocalAlembicInstall(command = 'alembic'): CodexLocalAlembicInstallProbe {
  const versionResult = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  const output = `${versionResult.stdout || versionResult.stderr || ''}`.trim();
  if (versionResult.status !== 0) {
    return {
      available: false,
      command,
      error: versionResult.error?.message || output || `Unable to run ${command} --version`,
      version: null,
    };
  }
  const daemonHelpResult = spawnSync(command, ['daemon', '--help'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  const daemonHelp = `${daemonHelpResult.stdout || daemonHelpResult.stderr || ''}`.trim();
  const hasAlembicDaemonCommand = daemonHelpResult.status === 0;
  return {
    available: hasAlembicDaemonCommand,
    command,
    error: hasAlembicDaemonCommand
      ? null
      : daemonHelpResult.error?.message ||
        daemonHelp ||
        `${command} is present but does not expose Alembic daemon commands`,
    version: output,
  };
}

export function summarizeEnhancementDaemon(status: DaemonStatus): CodexEnhancementDaemonProbe {
  const data = asRecord(status.health?.data);
  const enhancement = asRecord(data?.enhancement);
  const capabilities = asRecord(data?.capabilities);
  const residentServiceStatus = data?.residentService
    ? normalizeAlembicResidentServiceStatus(data.residentService)
    : null;
  const runtimeBoundary = summarizeDaemonRuntimeBoundary(capabilities, data);
  const capabilitySummary = mergeCapabilitySummaryWithResidentService(
    mergeCapabilitySummaryWithRuntimeBoundary(
      summarizeAlembicRuntimeCapabilities(capabilities),
      runtimeBoundary
    ),
    residentServiceStatus
  );
  const route =
    firstString(residentServiceStatus?.route, enhancement?.route, runtimeBoundary.route) ||
    inferRouteFromReadyDaemon(status);
  const dashboardUrl = firstString(
    capabilitySummary.dashboardUrl,
    runtimeBoundary.dashboard.url,
    data?.dashboardUrl,
    isLocalAlembicDaemonRoute(route) && capabilitySummary.dashboardAvailable === true
      ? status.state?.dashboardUrl
      : null
  );

  return {
    available: status.ready === true && Boolean(status.state),
    capabilities: {
      ...capabilitySummary,
      dashboardUrl,
    },
    dashboardUrl,
    healthVersion: firstString(data?.version),
    packageName: firstString(enhancement?.packageName),
    ready: status.ready,
    residentService: residentServiceStatus
      ? {
          status: residentServiceStatus,
          summary: summarizeAlembicResidentServiceStatus(residentServiceStatus),
        }
      : null,
    route: route || inferRouteFromReadyDaemon(status),
    runtimeBoundary,
    status: status.status,
    version: firstString(enhancement?.version, data?.version, status.state?.version),
  };
}

function selectEnhancementRoute(input: {
  daemon: CodexEnhancementDaemonProbe;
  localInstall: CodexLocalAlembicInstallProbe;
  missingCapabilities: string[];
  requirement: CodexEnhancementRequirement;
}): CodexEnhancementRouteKind {
  if (input.daemon.ready && isLocalAlembicDaemonRoute(input.daemon.route)) {
    return 'local-alembic-daemon';
  }
  if (input.requirement === 'dashboard' && input.localInstall.available) {
    return 'local-alembic-install';
  }
  if (input.daemon.ready && input.daemon.route === 'embedded-plugin-runtime') {
    return 'embedded-plugin-runtime';
  }
  if (input.daemon.ready) {
    return 'embedded-plugin-runtime';
  }
  if (input.localInstall.available && input.requirement === 'status') {
    return 'local-alembic-install';
  }
  return 'embedded-plugin-runtime';
}

function buildEnhancementRouteReason(input: {
  daemon: CodexEnhancementDaemonProbe;
  localInstall: CodexLocalAlembicInstallProbe;
  missingCapabilities: string[];
  requirement: CodexEnhancementRequirement;
  selected: CodexEnhancementRouteKind;
}): string {
  if (input.selected === 'local-alembic-daemon') {
    const suffix =
      input.missingCapabilities.length > 0
        ? ` Missing capabilities: ${input.missingCapabilities.join(', ')}.`
        : '';
    const boundary = input.daemon.runtimeBoundary.available
      ? ` Runtime boundary source: ${input.daemon.runtimeBoundary.source}.`
      : '';
    return `Local Alembic daemon is ready and owns enhancement route.${boundary}${suffix}`;
  }
  if (input.selected === 'embedded-plugin-runtime') {
    if (input.requirement === 'dashboard') {
      return 'Dashboard handoff requires a local Alembic daemon that serves the Dashboard; the embedded Codex plugin runtime only exposes MCP/API compatibility.';
    }
    if (input.daemon.ready) {
      return 'Embedded Codex plugin runtime daemon is ready for this project.';
    }
    if (input.localInstall.available) {
      return 'Local Alembic install was detected, but no local daemon API is ready; plugin actions will start the embedded runtime on demand.';
    }
    return 'No local Alembic daemon API is ready; plugin actions will use the embedded portable runtime on demand.';
  }
  if (input.selected === 'local-alembic-install') {
    return 'Local Alembic CLI install was detected, but no daemon API is ready yet.';
  }
  return 'No usable Alembic enhancement route is available.';
}

function summarizeDaemonRuntimeBoundary(
  capabilities: Record<string, unknown> | null,
  data: Record<string, unknown> | null
): CodexDaemonRuntimeBoundarySummary {
  const source = asRecord(capabilities?.runtimeBoundary) || asRecord(data?.runtimeBoundary);
  const sourceName = asRecord(capabilities?.runtimeBoundary)
    ? 'capabilities.runtimeBoundary'
    : asRecord(data?.runtimeBoundary)
      ? 'data.runtimeBoundary'
      : null;
  const workspace = asRecord(source?.workspace);
  const daemon = asRecord(source?.daemon);
  const dashboard = asRecord(source?.dashboard);
  const fileMonitor = asRecord(source?.fileMonitor);
  const internalAi = asRecord(source?.internalAi);
  const jobs = asRecord(source?.jobs);

  return {
    available: Boolean(source),
    owner: firstString(source?.owner),
    route: firstString(source?.route),
    source: sourceName,
    workspace: {
      contract: firstString(workspace?.contract),
      databasePath: firstString(workspace?.databasePath),
      dataRoot: firstString(workspace?.dataRoot),
      dataRootSource: firstString(workspace?.dataRootSource),
      mode: firstString(workspace?.mode),
      projectId: firstString(workspace?.projectId),
      projectRoot: firstString(workspace?.projectRoot),
      runtimeDir: firstString(workspace?.runtimeDir),
    },
    daemon: {
      apiBaseUrl: firstString(daemon?.apiBaseUrl),
      mode: firstString(daemon?.mode),
      owner: firstString(daemon?.owner),
      stateContract: firstString(daemon?.stateContract),
    },
    dashboard: {
      frontendOwner: firstString(dashboard?.frontendOwner),
      handoff: firstString(dashboard?.handoff),
      serverOwner: firstString(dashboard?.serverOwner),
      url: firstString(dashboard?.url),
    },
    fileMonitor: {
      available: booleanOrNull(fileMonitor?.available),
      longLivedOwner: firstString(fileMonitor?.longLivedOwner),
      mode:
        normalizeAlembicFileMonitorMode(fileMonitor?.mode) ||
        normalizeAlembicFileMonitorMode(fileMonitor?.source),
    },
    internalAi: {
      available: booleanOrNull(internalAi?.available),
      owner: firstString(internalAi?.owner),
      runtimeOwner: firstString(internalAi?.runtimeOwner),
    },
    jobs: {
      kinds: stringArray(jobs?.kinds),
      owner: firstString(jobs?.owner),
      store: firstString(jobs?.store),
    },
  };
}

function mergeCapabilitySummaryWithRuntimeBoundary(
  summary: AlembicRuntimeCapabilitySummary,
  runtimeBoundary: CodexDaemonRuntimeBoundarySummary
): AlembicRuntimeCapabilitySummary {
  return {
    apiAvailable: summary.apiAvailable,
    dashboardAvailable: summary.dashboardAvailable ?? (runtimeBoundary.dashboard.url ? true : null),
    dashboardUrl: summary.dashboardUrl ?? runtimeBoundary.dashboard.url,
    fileMonitorAvailable: summary.fileMonitorAvailable ?? runtimeBoundary.fileMonitor.available,
    fileMonitorMode: summary.fileMonitorMode ?? runtimeBoundary.fileMonitor.mode,
    internalAiAvailable: summary.internalAiAvailable ?? runtimeBoundary.internalAi.available,
    jobsAvailable: summary.jobsAvailable ?? (runtimeBoundary.jobs.kinds.length > 0 ? true : null),
    jobKinds: summary.jobKinds.length > 0 ? summary.jobKinds : runtimeBoundary.jobs.kinds,
  };
}

function mergeCapabilitySummaryWithResidentService(
  summary: AlembicRuntimeCapabilitySummary,
  residentService: AlembicResidentServiceStatus | null
): AlembicRuntimeCapabilitySummary {
  if (!residentService) {
    return summary;
  }
  const available = (feature: keyof AlembicResidentServiceStatus['capabilities']) =>
    residentService.capabilities[feature]?.available === true;
  const unavailable = (feature: keyof AlembicResidentServiceStatus['capabilities']) =>
    residentService.capabilities[feature]?.available === false;
  const jobKinds = [
    ...(available('jobs.internal-ai.bootstrap') ||
    available('jobs.host-agent-recoverable.bootstrap')
      ? ['bootstrap']
      : []),
    ...(available('jobs.internal-ai.rescan') || available('jobs.host-agent-recoverable.rescan')
      ? ['rescan']
      : []),
  ];
  const dashboardAvailable = available('dashboard.handoff')
    ? true
    : unavailable('dashboard.handoff')
      ? false
      : null;
  const fileMonitorAvailable = available('file-monitor.git-worktree')
    ? true
    : unavailable('file-monitor.git-worktree')
      ? false
      : null;
  const internalAiAvailable =
    available('jobs.internal-ai.bootstrap') || available('jobs.internal-ai.rescan')
      ? true
      : unavailable('jobs.internal-ai.bootstrap') && unavailable('jobs.internal-ai.rescan')
        ? false
        : null;

  return {
    apiAvailable: summary.apiAvailable ?? (available('status.health') ? true : null),
    dashboardAvailable: summary.dashboardAvailable ?? dashboardAvailable,
    dashboardUrl: summary.dashboardUrl,
    fileMonitorAvailable: summary.fileMonitorAvailable ?? fileMonitorAvailable,
    fileMonitorMode: summary.fileMonitorMode,
    internalAiAvailable: summary.internalAiAvailable ?? internalAiAvailable,
    jobsAvailable: summary.jobsAvailable ?? (jobKinds.length > 0 ? true : null),
    jobKinds: summary.jobKinds.length > 0 ? summary.jobKinds : jobKinds,
  };
}

function isLocalAlembicDaemonRoute(route: string | null): boolean {
  return route === 'local-alembic' || route === 'local-alembic-daemon';
}

function findMissingCapabilities(
  requirement: CodexEnhancementRequirement,
  daemon: CodexEnhancementDaemonProbe
): string[] {
  if (!daemon.ready) {
    return requirement === 'status' ? [] : ['daemon-api'];
  }

  const missing: string[] = [];
  if (requirement === 'dashboard') {
    if (daemon.capabilities.dashboardAvailable === false || !daemon.dashboardUrl) {
      missing.push('dashboard');
    }
  }
  if (requirement === 'jobs') {
    const hasJobs =
      daemon.capabilities.jobsAvailable !== false &&
      (daemon.capabilities.jobKinds.length === 0 ||
        (daemon.capabilities.jobKinds.includes('bootstrap') &&
          daemon.capabilities.jobKinds.includes('rescan')));
    if (!hasJobs) {
      missing.push('jobs.bootstrap-rescan');
    }
  }
  if (requirement === 'mcp' && daemon.capabilities.apiAvailable === false) {
    missing.push('mcp-api');
  }
  return missing;
}

function summarizeInternalAiProvider(
  health: Record<string, unknown> | null
): CodexEnhancementRouteChoice['internalAiProvider'] {
  const data = asRecord(health?.data);
  const capabilities = asRecord(data?.capabilities);
  const internalAi = asRecord(capabilities?.internalAi);
  if (internalAi) {
    return {
      available: internalAi.available === true,
      configSource: readConfigSource(internalAi.configSource),
      model: firstString(internalAi.model),
      provider: firstString(internalAi.provider),
    };
  }
  return {
    available: false,
    configSource: null,
    model: null,
    provider: null,
  };
}

function readConfigSource(
  value: unknown
): CodexEnhancementRouteChoice['internalAiProvider']['configSource'] {
  return value === 'empty' ||
    value === 'process-env' ||
    value === 'runtime-overrides' ||
    value === 'workspace-settings'
    ? value
    : null;
}

function inferRouteFromReadyDaemon(status: DaemonStatus): string | null {
  if (!status.ready) {
    return null;
  }
  return 'embedded-plugin-runtime';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
