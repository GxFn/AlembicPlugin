import type { CodexEnhancementRouteChoice } from './EnhancementRoute.js';
import {
  CODEX_EMBEDDED_RUNTIME_SPECIFIER,
  CODEX_PLUGIN_NAME,
  CODEX_RUNTIME_BIN,
  CODEX_RUNTIME_PACKAGE,
} from './RuntimeContext.js';

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
  artifactPath: 'dashboard/dist';
  buildCommand: 'npm run build:dashboard';
  deletionAllowedThisWave: false;
  pluginRole: 'dashboard-url-handoff-and-portable-artifact-packaging';
  releaseAssetSwitchChecks: string[];
  releaseAssetSwitchCondition: string;
  sourceCandidates: readonly ['../AlembicDashboard', 'vendor/AlembicDashboard'];
  sourceOwner: 'AlembicDashboard';
  sourceResolver: 'scripts/local-source-paths.mjs#resolveDashboardSource';
}

export interface CodexModuleBoundaryStatus {
  adapters: {
    embeddedRuntime: {
      artifact: string;
      packageName: string;
      role: string;
      startCommand: string;
    };
    enhancementRoute: {
      consumesLocalAlembicCapabilities: boolean;
      hostAgentSource: string | null;
      internalAiProviderIsProviderStateOnly: boolean;
      missingCapabilities: string[];
      selected: string | null;
    };
    projectRootResolver: {
      role: string;
      sourceOfTruth: 'Codex host and @alembic/core/workspace';
    };
    runtimeContract: {
      capabilitySummarySource: '@alembic/core/daemon#summarizeAlembicRuntimeCapabilities';
      fileMonitorMode: string | null;
      healthPath: '/api/v1/daemon/health';
      runtimeBoundarySource: string | null;
      runtimeBoundaryAvailable: boolean;
    };
  };
  dashboard: CodexDashboardArtifactBoundary;
  phase: 'runtime-contract-consumption-wave-2';
  pluginDoesNotOwn: CodexModuleBoundaryEntry[];
  pluginOwns: CodexModuleBoundaryEntry[];
  nextWaveGaps: string[];
}

export const CODEX_DASHBOARD_ARTIFACT_BOUNDARY: CodexDashboardArtifactBoundary = {
  artifactPath: 'dashboard/dist',
  buildCommand: 'npm run build:dashboard',
  deletionAllowedThisWave: false,
  pluginRole: 'dashboard-url-handoff-and-portable-artifact-packaging',
  releaseAssetSwitchChecks: [
    'Dashboard artifact includes index.html and hashed assets without requiring Plugin-owned frontend source.',
    'Artifact metadata records AlembicDashboard source version or release tag.',
    'Codex plugin runtime can package the artifact without running AlembicDashboard build locally.',
  ],
  releaseAssetSwitchCondition:
    'Switch after Alembic/AlembicDashboard publish a stable Dashboard release artifact that the Codex plugin runtime can consume without rebuilding frontend source.',
  sourceCandidates: ['../AlembicDashboard', 'vendor/AlembicDashboard'],
  sourceOwner: 'AlembicDashboard',
  sourceResolver: 'scripts/local-source-paths.mjs#resolveDashboardSource',
};

const PLUGIN_OWNED_BOUNDARIES: CodexModuleBoundaryEntry[] = [
  {
    id: 'codex-entry',
    owner: 'AlembicPlugin',
    pluginRole: 'MCP stdio/http entry, Codex tool schema, tier policy, and skill handoff.',
    retainedInPlugin: true,
    sourceOfTruth: 'lib/external/mcp/** and lib/codex/**',
  },
  {
    id: 'host-agent-tool-route',
    owner: 'AlembicPlugin',
    pluginRole:
      'Routes Codex host-agent bootstrap, rescan, candidate submission, and dimension completion through Core workflow contracts.',
    retainedInPlugin: true,
    sourceOfTruth: 'lib/external/mcp/handlers/** with @alembic/core/host-agent-workflows',
  },
  {
    id: 'marketplace-artifact',
    owner: 'AlembicPlugin',
    pluginRole:
      'Codex plugin shell, channel metadata, skills, cache sync, and marketplace package.',
    retainedInPlugin: true,
    sourceOfTruth: `plugins/${CODEX_PLUGIN_NAME}, channels/**, .agents/**`,
  },
  {
    id: 'portable-runtime-packaging',
    owner: 'AlembicPlugin',
    pluginRole:
      'Packages compiled Plugin runtime, embedded Core snapshot, Dashboard artifact, and Codex wrapper.',
    retainedInPlugin: true,
    sourceOfTruth: 'scripts/prepare-codex-plugin-runtime.mjs',
  },
  {
    id: 'dashboard-url-handoff',
    owner: 'AlembicPlugin',
    pluginRole: 'Starts or connects to an enhancement daemon and returns a Dashboard URL to Codex.',
    retainedInPlugin: true,
    sourceOfTruth: 'alembic_codex_dashboard and status/onboarding adapters',
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
    id: 'internal-ai-runtime',
    owner: 'AlembicAgent',
    pluginRole:
      'Surfaces provider readiness for explicit internal AI daemon jobs; Codex host-agent route does not require it.',
    retainedInPlugin: false,
    sourceOfTruth: 'AlembicAgent runtime consumed by Alembic',
  },
  {
    id: 'dashboard-frontend-source',
    owner: 'AlembicDashboard',
    pluginRole:
      'Consumes built Dashboard artifact and returns Dashboard URL; does not own frontend source.',
    retainedInPlugin: false,
    sourceOfTruth: 'AlembicDashboard src and release artifact',
  },
];

export function buildCodexModuleBoundaryStatus(
  input: { enhancementRoute?: CodexEnhancementRouteChoice | null } = {}
): CodexModuleBoundaryStatus {
  const route = input.enhancementRoute || null;
  return {
    phase: 'runtime-contract-consumption-wave-2',
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
        internalAiProviderIsProviderStateOnly: true,
        missingCapabilities: route ? [...route.missingCapabilities] : [],
      },
      embeddedRuntime: {
        artifact: CODEX_EMBEDDED_RUNTIME_SPECIFIER,
        packageName: CODEX_RUNTIME_PACKAGE,
        role: 'Plugin-owned portable adapter that launches compiled daemon-server.js for Codex delivery, not the long-term Alembic daemon source of truth.',
        startCommand: CODEX_RUNTIME_BIN,
      },
      runtimeContract: {
        capabilitySummarySource: '@alembic/core/daemon#summarizeAlembicRuntimeCapabilities',
        fileMonitorMode: route?.localAlembic.daemon.capabilities.fileMonitorMode ?? null,
        healthPath: '/api/v1/daemon/health',
        runtimeBoundaryAvailable: route?.localAlembic.daemon.runtimeBoundary.available ?? false,
        runtimeBoundarySource: route?.localAlembic.daemon.runtimeBoundary.source ?? null,
      },
    },
    dashboard: { ...CODEX_DASHBOARD_ARTIFACT_BOUNDARY },
    nextWaveGaps: [
      'Replace Plugin-built dashboard/dist with a stable AlembicDashboard or Alembic release asset after that artifact contract exists.',
      'Continue consuming Alembic daemon health runtimeBoundary fields as they stabilize instead of adding Plugin-local permanent contracts.',
      'Keep git-diff checkpoint and JobStore usage marked as embedded runtime compatibility until Alembic daemon contracts can fully cover them.',
    ],
  };
}

function copyBoundary(entry: CodexModuleBoundaryEntry): CodexModuleBoundaryEntry {
  return { ...entry };
}
