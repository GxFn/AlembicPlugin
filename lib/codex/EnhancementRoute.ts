import { spawnSync } from 'node:child_process';
import {
  type AlembicRuntimeCapabilitySummary,
  type AlembicRuntimeRouteKind,
  summarizeAlembicRuntimeCapabilities,
} from '@alembic/core/daemon';
import { HOST_AGENT_SOURCE } from '@alembic/core/shared';
import type { DaemonStatus } from '../daemon/DaemonSupervisor.js';
import type { CodexAiConfigState } from './AiConfigState.js';
import {
  CODEX_RUNTIME_PACKAGE,
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from './RuntimeContext.js';

export type CodexEnhancementRequirement = 'dashboard' | 'jobs' | 'mcp' | 'status';

export type CodexEnhancementRouteKind = AlembicRuntimeRouteKind;

export const CODEX_HOST_AGENT_ROUTE_TOOLS = [
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
] as const;

export type CodexDaemonCapabilitySummary = AlembicRuntimeCapabilitySummary;

export interface CodexEnhancementDaemonProbe {
  available: boolean;
  capabilities: CodexDaemonCapabilitySummary;
  dashboardUrl: string | null;
  healthVersion: string | null;
  packageName: string | null;
  ready: boolean;
  route: string | null;
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
  aiConfig?: CodexAiConfigState | null;
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
  const internalAiProvider = summarizeInternalAiProvider(input.daemonStatus.health, input.aiConfig);
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
  const capabilitySummary = summarizeAlembicRuntimeCapabilities(capabilities);
  const dashboardUrl = firstString(
    capabilitySummary.dashboardUrl,
    data?.dashboardUrl,
    status.state?.dashboardUrl
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
    route: firstString(enhancement?.route) || inferRouteFromReadyDaemon(status),
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
  if (input.daemon.ready && input.daemon.route === 'local-alembic') {
    return 'local-alembic-daemon';
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
  selected: CodexEnhancementRouteKind;
}): string {
  if (input.selected === 'local-alembic-daemon') {
    const suffix =
      input.missingCapabilities.length > 0
        ? ` Missing capabilities: ${input.missingCapabilities.join(', ')}.`
        : '';
    return `Local Alembic daemon is ready and owns enhancement route.${suffix}`;
  }
  if (input.selected === 'embedded-plugin-runtime') {
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
  health: Record<string, unknown> | null,
  aiConfig?: CodexAiConfigState | null
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
    available: aiConfig?.ready === true,
    configSource: aiConfig?.source ?? null,
    model: aiConfig?.model ?? null,
    provider: aiConfig?.provider ?? null,
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
