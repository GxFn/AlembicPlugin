import { CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES } from './codex-local-tools/output.js';
import { CORE_CLEAN_OUTPUT_TOOL_NAMES } from './core-tools/output.js';
import {
  listPluginToolSurfaceCatalog,
  type PluginToolResidentRoutePolicy,
} from './PluginToolSurfaceCatalog.js';
import { AGENT_PUBLIC_TOOL_NAMES } from './public-tools/contract.js';

export const PLUGIN_HOST_MCP_CONTRACT_VERSION = 1;

export const PLUGIN_HOST_MCP_D4_REGISTRY_ROW_IDS = [
  'I10',
  'I11',
  'I12',
  'I13',
  'I14',
  'I15',
  'I21',
  'I22',
  'I23',
  'I24',
] as const;

export type PluginHostMcpD4RegistryRowId = (typeof PLUGIN_HOST_MCP_D4_REGISTRY_ROW_IDS)[number];

export type PluginHostMcpToolFamily = 'agent-public' | 'codex-local' | 'embedded-core';

export interface PluginHostMcpToolFamilyContract {
  family: PluginHostMcpToolFamily;
  registryRowIds: readonly PluginHostMcpD4RegistryRowId[];
  toolNames: readonly string[];
}

export interface PluginHostResidentProviderFixtureReplay {
  fixtureIds: readonly string[];
  registryRowId: PluginHostMcpD4RegistryRowId | 'I03' | 'I05' | 'I06';
  routeFamily: string;
}

export interface PluginHostMcpContractSummary {
  activeToolCount: number;
  cleanOutputToolCount: number;
  providerReplayFixtureCount: number;
  registryRowIds: readonly PluginHostMcpD4RegistryRowId[];
  residentRouteToolCount: number;
  version: typeof PLUGIN_HOST_MCP_CONTRACT_VERSION;
}

export const PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS = [
  {
    family: 'codex-local',
    registryRowIds: ['I13', 'I14', 'I15', 'I23', 'I24'],
    toolNames: CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES,
  },
  {
    family: 'embedded-core',
    registryRowIds: ['I12', 'I13', 'I21', 'I22', 'I23'],
    toolNames: CORE_CLEAN_OUTPUT_TOOL_NAMES,
  },
  {
    family: 'agent-public',
    registryRowIds: ['I10', 'I11', 'I13', 'I21'],
    toolNames: AGENT_PUBLIC_TOOL_NAMES,
  },
] as const satisfies readonly PluginHostMcpToolFamilyContract[];

export const PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES = uniqueStrings(
  PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS.flatMap((contract) => contract.toolNames)
);

export const PLUGIN_HOST_MCP_RESIDENT_ROUTE_TOOL_NAMES = listPluginToolSurfaceCatalog()
  .filter((entry) => entry.residentRoutePolicy !== 'none')
  .map((entry) => entry.name)
  .sort();

export const PLUGIN_HOST_MCP_RESIDENT_ROUTE_POLICIES = uniqueStrings(
  listPluginToolSurfaceCatalog()
    .map((entry) => entry.residentRoutePolicy)
    .filter((policy): policy is Exclude<PluginToolResidentRoutePolicy, 'none'> => policy !== 'none')
);

export const PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY = [
  {
    registryRowId: 'I03',
    routeFamily: '/api/v1/daemon/health',
    fixtureIds: ['runtime-health.ready', 'runtime-health.partial', 'runtime-health.unavailable'],
  },
  {
    registryRowId: 'I05',
    routeFamily: '/api/v1/project-scope',
    fixtureIds: ['project-scope.success', 'project-scope.failure'],
  },
  {
    registryRowId: 'I06',
    routeFamily: '/api/v1/jobs',
    fixtureIds: ['jobs.queued', 'jobs.cancelled', 'jobs.unavailable'],
  },
  {
    registryRowId: 'I10',
    routeFamily: '/api/v1/decision-register',
    fixtureIds: ['decision-register.success', 'decision-register.scope-mismatch'],
  },
  {
    registryRowId: 'I11',
    routeFamily: '/api/v1/intent-episodes',
    fixtureIds: ['intent-episode.success', 'intent-episode.not-found'],
  },
  {
    registryRowId: 'I21',
    routeFamily: '/api/v1/guard',
    fixtureIds: ['guard.success', 'guard.invalid-input'],
  },
  {
    registryRowId: 'I22',
    routeFamily: '/api/v1/search',
    fixtureIds: ['knowledge.success', 'workflow.unavailable'],
  },
  {
    registryRowId: 'I23',
    routeFamily: '/api/v1/diagnostics',
    fixtureIds: ['diagnostic.success', 'diagnostic.failure'],
  },
] as const satisfies readonly PluginHostResidentProviderFixtureReplay[];

export function summarizePluginHostMcpContracts(): PluginHostMcpContractSummary {
  return {
    activeToolCount: PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES.length,
    cleanOutputToolCount: PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES.length,
    providerReplayFixtureCount: uniqueStrings(
      PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY.flatMap((entry) => entry.fixtureIds)
    ).length,
    registryRowIds: PLUGIN_HOST_MCP_D4_REGISTRY_ROW_IDS,
    residentRouteToolCount: PLUGIN_HOST_MCP_RESIDENT_ROUTE_TOOL_NAMES.length,
    version: PLUGIN_HOST_MCP_CONTRACT_VERSION,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
