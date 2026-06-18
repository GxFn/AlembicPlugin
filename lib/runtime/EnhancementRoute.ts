import { spawnSync } from 'node:child_process';
import {
  type AlembicFileMonitorMode,
  type AlembicResidentServiceStatus,
  type AlembicResidentServiceStatusSummary,
  type AlembicRuntimeCapabilitySummary,
  normalizeAlembicFileMonitorMode,
  normalizeAlembicResidentServiceStatus,
  summarizeAlembicResidentServiceStatus,
  summarizeAlembicRuntimeCapabilities,
} from '@alembic/core/daemon';
import { HOST_AGENT_SOURCE } from '@alembic/core/shared';
import type { DaemonStatus } from './daemon-status.js';

export type CodexEnhancementRequirement = 'dashboard' | 'jobs' | 'mcp' | 'status';

// PDR-5: the Plugin's enhancement-route choice is a plugin-local concept with two
// first-class routes. It is intentionally NOT Core's AlembicRuntimeRouteKind (the
// daemon's self-reported route), which is a separate concept.
//   - 'resident': 有主体 — a resident Alembic service is reachable, consumed via Core contracts.
//   - 'pure-local': 无主体 — in-process MCP Services + local stage cache + local vector.
//     Fully functional; a first-class route, NOT a degrade fallback.
export type CodexEnhancementRouteKind = 'resident' | 'pure-local';

export const CODEX_HOST_AGENT_ROUTE_TOOLS = [
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
] as const;

export interface CodexDaemonCapabilitySummary {
  apiAvailable: boolean | null;
  dashboardAvailable: boolean | null;
  dashboardUrl: string | null;
  fileMonitorAvailable: boolean | null;
  fileMonitorMode: AlembicFileMonitorMode | null;
  jobKinds: string[];
  jobsAvailable: boolean | null;
  residentDaemonJobsAvailable: boolean | null;
}

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
  residentDaemonJobProvider: {
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
  compatibility: {
    runtimeBoundary: CodexDaemonRuntimeBoundaryCompatibility;
  };
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

export interface CodexDaemonRuntimeBoundaryCompatibility {
  activeFallback: boolean;
  canonicalResidentServicePresent: boolean;
  consumer: string | null;
  deletionCondition: string | null;
  reason: string | null;
  retained: boolean;
  source: CodexDaemonRuntimeBoundarySummary['source'];
}

export interface CodexLocalAlembicInstallProbe {
  available: boolean;
  command: string;
  error: string | null;
  version: string | null;
}

export interface HostEnhancementRouteChoice {
  hostAgentRoute: {
    requiresAiProvider: false;
    source: typeof HOST_AGENT_SOURCE;
    tools: typeof CODEX_HOST_AGENT_ROUTE_TOOLS;
  };
  residentDaemonJobProvider: {
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

export function buildHostEnhancementRouteChoice(input: {
  daemonStatus: DaemonStatus;
  localInstall?: CodexLocalAlembicInstallProbe;
  requirement?: CodexEnhancementRequirement;
}): HostEnhancementRouteChoice {
  const requirement = input.requirement || 'status';
  const daemon = summarizeEnhancementDaemon(input.daemonStatus);
  const localInstall = input.localInstall || probeLocalAlembicInstall();
  const missingCapabilities = findMissingCapabilities(requirement, daemon);
  const residentDaemonJobProvider = summarizeResidentDaemonJobProvider(input.daemonStatus.health);

  const selected = selectEnhancementRoute({ daemon });

  return {
    hostAgentRoute: {
      requiresAiProvider: false,
      source: HOST_AGENT_SOURCE,
      tools: CODEX_HOST_AGENT_ROUTE_TOOLS,
    },
    residentDaemonJobProvider,
    localAlembic: {
      daemon,
      install: localInstall,
    },
    missingCapabilities,
    reason: buildEnhancementRouteReason({
      daemon,
      missingCapabilities,
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
    toCodexDaemonCapabilitySummary(summarizeAlembicRuntimeCapabilities(capabilities)),
    residentServiceStatus
  );
  const route =
    firstString(residentServiceStatus?.route, enhancement?.route) ||
    inferRouteFromReadyDaemon(status);
  const dashboardUrl = firstString(
    capabilitySummary.dashboardUrl,
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
    compatibility: {
      runtimeBoundary: summarizeRuntimeBoundaryCompatibility(
        runtimeBoundary,
        residentServiceStatus
      ),
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
}): CodexEnhancementRouteKind {
  // 有主体: a resident Alembic service is reachable (Core resident state present) → consume it.
  if (input.daemon.residentService !== null) {
    return 'resident';
  }
  // 无主体: pure-local first-class — in-process MCP Services + local stage cache + local vector.
  // Fully functional; a first-class route, not a degrade fallback.
  return 'pure-local';
}

function buildEnhancementRouteReason(input: {
  daemon: CodexEnhancementDaemonProbe;
  missingCapabilities: string[];
  selected: CodexEnhancementRouteKind;
}): string {
  if (input.selected === 'resident') {
    const suffix =
      input.missingCapabilities.length > 0
        ? ` Missing capabilities: ${input.missingCapabilities.join(', ')}.`
        : '';
    const residentService = input.daemon.residentService;
    if (residentService) {
      const scope = residentService.status.serviceScope.kind
        ? ` Service scope: ${residentService.status.serviceScope.kind}.`
        : '';
      return `Resident Alembic service is reachable and owns resident service route (${residentService.status.owner}/${residentService.status.route}); consuming it via Core contracts.${scope}${suffix}`;
    }
    return `Resident Alembic service is reachable; consuming it via Core contracts.${suffix}`;
  }
  // pure-local: first-class, fully functional — not a degrade fallback.
  return 'No resident Alembic service reachable; running pure-local — in-process MCP Services + local stage cache + local vector. First-class, fully functional (not a degrade).';
}

function summarizeRuntimeBoundaryCompatibility(
  runtimeBoundary: CodexDaemonRuntimeBoundarySummary,
  residentService: AlembicResidentServiceStatus | null
): CodexDaemonRuntimeBoundaryCompatibility {
  const reported = runtimeBoundary.available;
  const canonicalResidentServicePresent = residentService !== null;
  return {
    activeFallback: false,
    canonicalResidentServicePresent,
    consumer: null,
    deletionCondition: null,
    reason: reported
      ? canonicalResidentServicePresent
        ? 'runtimeBoundary is retained only as diagnostics; residentService is the canonical capability source.'
        : 'runtimeBoundary is reported only as diagnostics; Plugin capability decisions require residentService or explicit capability sections.'
      : null,
    retained: false,
    source: runtimeBoundary.source,
  };
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
  const contractApiAi = asRecord(source?.apiAi);
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
    residentDaemonJobProvider: {
      available: booleanOrNull(contractApiAi?.available),
      owner: firstString(contractApiAi?.owner),
      runtimeOwner: firstString(contractApiAi?.runtimeOwner),
    },
    jobs: {
      kinds: stringArray(jobs?.kinds),
      owner: firstString(jobs?.owner),
      store: firstString(jobs?.store),
    },
  };
}

function mergeCapabilitySummaryWithResidentService(
  summary: CodexDaemonCapabilitySummary,
  residentService: AlembicResidentServiceStatus | null
): CodexDaemonCapabilitySummary {
  if (!residentService) {
    return summary;
  }
  const available = (feature: keyof AlembicResidentServiceStatus['capabilities']) =>
    residentService.capabilities[feature]?.available === true;
  const unavailable = (feature: keyof AlembicResidentServiceStatus['capabilities']) =>
    residentService.capabilities[feature]?.available === false;
  const jobKinds = [
    ...(available('jobs.api-ai.bootstrap') || available('jobs.host-agent-recoverable.bootstrap')
      ? ['bootstrap']
      : []),
    ...(available('jobs.api-ai.rescan') || available('jobs.host-agent-recoverable.rescan')
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
  const residentDaemonJobsAvailable =
    available('jobs.api-ai.bootstrap') || available('jobs.api-ai.rescan')
      ? true
      : unavailable('jobs.api-ai.bootstrap') && unavailable('jobs.api-ai.rescan')
        ? false
        : null;
  const statusAvailable = available('status.health')
    ? true
    : unavailable('status.health')
      ? false
      : null;
  const jobsAvailable =
    jobKinds.length > 0
      ? true
      : unavailable('jobs.api-ai.bootstrap') &&
          unavailable('jobs.api-ai.rescan') &&
          unavailable('jobs.host-agent-recoverable.bootstrap') &&
          unavailable('jobs.host-agent-recoverable.rescan')
        ? false
        : null;

  return {
    ...summary,
    // residentService 是 canonical capability 输入；runtimeBoundary 保留为诊断字段，不补能力空缺。
    apiAvailable: statusAvailable ?? summary.apiAvailable,
    dashboardAvailable: dashboardAvailable ?? summary.dashboardAvailable,
    dashboardUrl: summary.dashboardUrl,
    fileMonitorAvailable: fileMonitorAvailable ?? summary.fileMonitorAvailable,
    fileMonitorMode: summary.fileMonitorMode,
    residentDaemonJobsAvailable: residentDaemonJobsAvailable ?? summary.residentDaemonJobsAvailable,
    jobsAvailable: jobsAvailable ?? summary.jobsAvailable,
    jobKinds: jobKinds.length > 0 ? jobKinds : summary.jobKinds,
  };
}

function toCodexDaemonCapabilitySummary(
  summary: AlembicRuntimeCapabilitySummary
): CodexDaemonCapabilitySummary {
  return {
    apiAvailable: summary.apiAvailable,
    dashboardAvailable: summary.dashboardAvailable,
    dashboardUrl: summary.dashboardUrl,
    fileMonitorAvailable: summary.fileMonitorAvailable,
    fileMonitorMode: summary.fileMonitorMode,
    jobKinds: summary.jobKinds,
    jobsAvailable: summary.jobsAvailable,
    // Core/Alembic exposes this as apiAiAvailable; Plugin presents it only as
    // resident daemon job readiness because the provider runtime is not owned here.
    residentDaemonJobsAvailable: summary.apiAiAvailable,
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

function summarizeResidentDaemonJobProvider(
  health: Record<string, unknown> | null
): HostEnhancementRouteChoice['residentDaemonJobProvider'] {
  const data = asRecord(health?.data);
  const capabilities = asRecord(data?.capabilities);
  const contractApiAi = asRecord(capabilities?.apiAi);
  if (contractApiAi) {
    return {
      available: contractApiAi.available === true,
      configSource: readConfigSource(contractApiAi.configSource),
      model: firstString(contractApiAi.model),
      provider: firstString(contractApiAi.provider),
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
): HostEnhancementRouteChoice['residentDaemonJobProvider']['configSource'] {
  return value === 'empty' ||
    value === 'process-env' ||
    value === 'runtime-overrides' ||
    value === 'workspace-settings'
    ? value
    : null;
}

function inferRouteFromReadyDaemon(_status: DaemonStatus): string | null {
  // PDR-3/PDR-5: the embedded plugin daemon was removed, so there is no daemon
  // self-reported route to infer here. The daemon's self-route (probe.route) is a
  // separate concept from the Plugin's enhancement-route choice and is now always
  // null when not advertised by a reachable resident service.
  return null;
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
