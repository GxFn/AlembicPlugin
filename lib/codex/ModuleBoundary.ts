import type { CodexEnhancementRouteChoice } from './EnhancementRoute.js';
import type { CodexHostProjectAlignment } from './HostProjectAlignment.js';
import {
  CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES,
  CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES,
  CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY,
} from './runtime/EmbeddedRuntimeContract.js';
import {
  CODEX_EMBEDDED_RUNTIME_SPECIFIER,
  CODEX_PLUGIN_NAME,
  CODEX_RUNTIME_BIN,
  CODEX_RUNTIME_PACKAGE,
} from './runtime/RuntimeContext.js';

export type CodexModuleBoundaryOwner =
  | 'Alembic'
  | 'AlembicAgent'
  | 'AlembicCore'
  | 'AlembicDashboard'
  | 'AlembicPlugin'
  | 'Codex host';

export interface CodexModuleBoundaryEntry {
  id: string;
  owner: CodexModuleBoundaryOwner;
  pluginRole: string;
  retainedInPlugin: boolean;
  sourceOfTruth: string;
}

export interface CodexDashboardArtifactBoundary {
  artifactPath: null;
  buildCommand: null;
  deletionCompletedThisWave: true;
  localDaemonRequirement: string;
  pluginDoesNotBuildOrServe: string[];
  pluginRole: 'dashboard-url-handoff-only';
  sourceOwner: 'Alembic/AlembicDashboard';
}

export interface CodexModuleBoundaryStatus {
  adapters: {
    embeddedRuntime: {
      artifact: string;
      packageName: string;
      requiredFiles: string[];
      role: string;
      startCommand: string;
    };
    enhancementRoute: {
      consumesLocalAlembicCapabilities: boolean;
      hostAgentSource: string | null;
      residentDaemonJobProviderIsProviderStateOnly: boolean;
      missingCapabilities: string[];
      selected: string | null;
    };
    projectRootResolver: {
      role: string;
      sourceOfTruth: 'Codex host and @alembic/core/workspace';
    };
    hostProjectAlignment: {
      connectionState: string | null;
      handoffAllowed: boolean | null;
      role: string;
      sourceOfTruth: '@alembic/core/workspace and @alembic/core/daemon ProjectRuntimeControlState';
      switchOwnership: 'Alembic/Dashboard';
    };
    runtimeContract: {
      capabilitySummarySource: string;
      compatibilityRuntimeBoundaryConsumer: string | null;
      compatibilityRuntimeBoundaryDeletionCondition: string | null;
      compatibilityRuntimeBoundarySource: string | null;
      fileMonitorMode: string | null;
      healthPath: '/api/v1/daemon/health';
      requiredRoutes: string[];
      residentServiceOwner: string | null;
      residentServiceRoute: string | null;
      residentServiceScopeKind: string | null;
      retainedDaemonEntryPoint: typeof CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY;
      runtimeBoundarySource: string | null;
      runtimeBoundaryAvailable: boolean;
    };
  };
  dashboard: CodexDashboardArtifactBoundary;
  phase:
    | 'runtime-contract-consumption-wave-2'
    | 'capability-code-interface-cleanup-ccic-7-plugin-dashboard-handoff'
    | 'unified-resident-service-phase-4-behavior-cleanup';
  pluginDoesNotOwn: CodexModuleBoundaryEntry[];
  pluginOwns: CodexModuleBoundaryEntry[];
  nextWaveGaps: string[];
}

export const CODEX_DASHBOARD_ARTIFACT_BOUNDARY: CodexDashboardArtifactBoundary = {
  artifactPath: null,
  buildCommand: null,
  deletionCompletedThisWave: true,
  localDaemonRequirement:
    'alembic_codex_dashboard returns a URL only from a local Alembic daemon that advertises Dashboard capability.',
  pluginDoesNotBuildOrServe: [
    'Plugin-owned Dashboard frontend distribution directory',
    'AlembicDashboard source checkout',
    'embedded runtime Dashboard frontend directory',
  ],
  pluginRole: 'dashboard-url-handoff-only',
  sourceOwner: 'Alembic/AlembicDashboard',
};

const PLUGIN_OWNED_BOUNDARIES: CodexModuleBoundaryEntry[] = [
  {
    id: 'codex-entry',
    owner: 'AlembicPlugin',
    pluginRole: 'MCP stdio/http entry, Codex tool schema, tier policy, and skill handoff.',
    retainedInPlugin: true,
    sourceOfTruth: 'lib/codex/mcp/** and lib/codex/**',
  },
  {
    id: 'host-agent-tool-route',
    owner: 'AlembicPlugin',
    pluginRole:
      'Routes Codex host-agent bootstrap, rescan, candidate submission, and dimension completion through Core workflow contracts.',
    retainedInPlugin: true,
    sourceOfTruth:
      'lib/codex/mcp/handlers/host-agent/** + lib/codex/mcp/host-agent-workflows/** with @alembic/core/host-agent-workflows',
  },
  {
    id: 'marketplace-artifact',
    owner: 'AlembicPlugin',
    pluginRole:
      'Codex plugin shell, channel metadata, skills, cache sync, and marketplace artifact.',
    retainedInPlugin: true,
    sourceOfTruth: `plugins/${CODEX_PLUGIN_NAME}, channels/**, .agents/**`,
  },
  {
    id: 'portable-runtime-packaging',
    owner: 'AlembicPlugin',
    pluginRole:
      'Maintains the lightweight Codex marketplace shell that starts the pinned runtime package without public embedded artifacts.',
    retainedInPlugin: true,
    sourceOfTruth:
      'plugins/alembic-codex/bin/alembic-codex-start.mjs and packages/alembic-codex-runtime',
  },
  {
    id: 'dashboard-url-handoff',
    owner: 'AlembicPlugin',
    pluginRole:
      'Presents Codex host project alignment and returns a Dashboard URL only when Alembic selected/active runtime already matches the host project.',
    retainedInPlugin: true,
    sourceOfTruth: 'alembic_codex_dashboard and status/onboarding adapters',
  },
  {
    id: 'host-project-mismatch-presentation',
    owner: 'AlembicPlugin',
    pluginRole:
      'Reads Core project/runtime state for Codex-visible mismatch guidance; never switches Alembic projects.',
    retainedInPlugin: true,
    sourceOfTruth: 'lib/codex/HostProjectAlignment.ts',
  },
];

const EXTERNAL_OWNED_BOUNDARIES: CodexModuleBoundaryEntry[] = [
  {
    id: 'alembic-daemon-main',
    owner: 'Alembic',
    pluginRole:
      'Consumes daemon health/state/capability shape or starts embedded compatibility runtime.',
    retainedInPlugin: false,
    sourceOfTruth: 'Alembic daemon and HTTP/API runtime',
  },
  {
    id: 'project-registry-main',
    owner: 'AlembicCore',
    pluginRole:
      'Uses public WorkspaceResolver/ProjectRegistry contract; does not define registry rules.',
    retainedInPlugin: false,
    sourceOfTruth: '@alembic/core/workspace',
  },
  {
    id: 'job-store-main',
    owner: 'AlembicCore',
    pluginRole:
      'Reads/writes job records through public JobStore as daemon/job compatibility storage.',
    retainedInPlugin: false,
    sourceOfTruth: '@alembic/core/daemon',
  },
  {
    id: 'file-monitor-main',
    owner: 'Alembic',
    pluginRole:
      'Keeps only embedded runtime checkpoint compatibility; long-lived daemon file monitoring belongs outside Plugin.',
    retainedInPlugin: false,
    sourceOfTruth: 'Alembic daemon file monitor contract',
  },
  {
    id: 'resident-daemon-job-runtime',
    owner: 'AlembicAgent',
    pluginRole:
      'Surfaces provider readiness for explicit resident daemon jobs; Codex host-agent route does not require it.',
    retainedInPlugin: false,
    sourceOfTruth: 'AlembicAgent runtime consumed by Alembic',
  },
  {
    id: 'dashboard-frontend-source',
    owner: 'AlembicDashboard',
    pluginRole:
      'Receives Dashboard URL handoff from Alembic; Plugin does not build, copy, package, or serve Dashboard frontend assets.',
    retainedInPlugin: false,
    sourceOfTruth: 'AlembicDashboard source and Alembic Dashboard server',
  },
];

export function buildCodexModuleBoundaryStatus(
  input: {
    enhancementRoute?: CodexEnhancementRouteChoice | null;
    hostProjectAlignment?: CodexHostProjectAlignment | null;
  } = {}
): CodexModuleBoundaryStatus {
  const route = input.enhancementRoute || null;
  const hostProjectAlignment = input.hostProjectAlignment || null;
  const residentService = route?.localAlembic.daemon.residentService?.status ?? null;
  const runtimeBoundaryCompatibility =
    route?.localAlembic.daemon.compatibility.runtimeBoundary ?? null;
  return {
    phase: 'unified-resident-service-phase-4-behavior-cleanup',
    pluginOwns: PLUGIN_OWNED_BOUNDARIES.map(copyBoundary),
    pluginDoesNotOwn: EXTERNAL_OWNED_BOUNDARIES.map(copyBoundary),
    adapters: {
      projectRootResolver: {
        role: 'Resolve, trust, and persist the Codex target project root before delegating workspace identity to Core.',
        sourceOfTruth: 'Codex host and @alembic/core/workspace',
      },
      enhancementRoute: {
        selected: route?.selected ?? null,
        consumesLocalAlembicCapabilities: route
          ? route.selected === 'local-alembic-daemon' || route.selected === 'local-alembic-install'
          : false,
        hostAgentSource: route?.hostAgentRoute.source ?? null,
        residentDaemonJobProviderIsProviderStateOnly: true,
        missingCapabilities: route ? [...route.missingCapabilities] : [],
      },
      hostProjectAlignment: {
        connectionState: hostProjectAlignment?.connectionState ?? null,
        handoffAllowed: hostProjectAlignment?.handoffAllowed ?? null,
        role: 'Read-only Codex host project versus Alembic selected/active runtime mismatch presentation; does not own switch/start orchestration.',
        sourceOfTruth:
          '@alembic/core/workspace and @alembic/core/daemon ProjectRuntimeControlState',
        switchOwnership: 'Alembic/Dashboard',
      },
      embeddedRuntime: {
        artifact: CODEX_EMBEDDED_RUNTIME_SPECIFIER,
        packageName: CODEX_RUNTIME_PACKAGE,
        requiredFiles: [...CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES],
        role: 'Plugin-owned marketplace shell boundary that launches the pinned runtime package for Codex delivery, not the long-term Alembic daemon source of truth.',
        startCommand: CODEX_RUNTIME_BIN,
      },
      runtimeContract: {
        capabilitySummarySource:
          '@alembic/core/daemon#residentService and explicit capability sections',
        compatibilityRuntimeBoundaryConsumer: runtimeBoundaryCompatibility?.consumer ?? null,
        compatibilityRuntimeBoundaryDeletionCondition:
          runtimeBoundaryCompatibility?.deletionCondition ?? null,
        compatibilityRuntimeBoundarySource: runtimeBoundaryCompatibility?.source ?? null,
        fileMonitorMode: route?.localAlembic.daemon.capabilities.fileMonitorMode ?? null,
        healthPath: '/api/v1/daemon/health',
        requiredRoutes: [...CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES],
        residentServiceOwner: residentService?.owner ?? null,
        residentServiceRoute: residentService?.route ?? null,
        residentServiceScopeKind: residentService?.serviceScope.kind ?? null,
        retainedDaemonEntryPoint: CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY,
        runtimeBoundaryAvailable: route?.localAlembic.daemon.runtimeBoundary.available ?? false,
        runtimeBoundarySource: route?.localAlembic.daemon.runtimeBoundary.source ?? null,
      },
    },
    dashboard: { ...CODEX_DASHBOARD_ARTIFACT_BOUNDARY },
    nextWaveGaps: [
      'Ask Alembic/AlembicDashboard to guarantee a stable local Dashboard URL contract for Codex handoff; do not reintroduce Plugin-packaged frontend assets.',
      'Keep runtimeBoundary as diagnostics only; Plugin capability and project decisions must not fall back to it.',
      'Do not add Alembic projects API consumption to Plugin; handoff remains read-only and uses resident service scope plus runtime-control state.',
      'Keep git-diff checkpoint and JobStore usage marked as embedded runtime compatibility until Alembic daemon contracts can fully cover them.',
    ],
  };
}

function copyBoundary(entry: CodexModuleBoundaryEntry): CodexModuleBoundaryEntry {
  return { ...entry };
}
