import { CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES } from '../../runtime/mcp/codex-local-tools/output.js';
import { CORE_CLEAN_OUTPUT_TOOL_NAMES } from '../../runtime/mcp/core-tools/output.js';
import { KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES } from '../../runtime/mcp/knowledge-context-tools/output.js';
import {
  listPluginToolSurfaceCatalog,
  type PluginToolResidentRoutePolicy,
} from '../../runtime/mcp/PluginToolSurfaceCatalog.js';
import { AGENT_PUBLIC_TOOL_NAMES } from '../../runtime/mcp/public-tools/contract.js';

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

export type PluginHostMcpToolFamily =
  | 'agent-public'
  | 'codex-local'
  | 'embedded-core'
  | 'knowledge-context';

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

export type PluginHostD24FailureOwner =
  | 'contract-registry'
  | 'consumer-expectation'
  | 'plugin-mcp-projection'
  | 'plugin-resident-client'
  | 'producer-fixture';

export interface PluginHostD24FailureClassification {
  forbiddenFieldOwner: PluginHostD24FailureOwner;
  missingExpectedFieldOwner: PluginHostD24FailureOwner;
  missingFixtureOwner: PluginHostD24FailureOwner;
  providerShapeOwner: PluginHostD24FailureOwner;
}

export interface PluginHostD24ConsumerReplayScenario {
  consumerScenario: string;
  expectedFields: readonly string[];
  forbiddenOrdinaryOutputFields: readonly string[];
  producerContract: string;
  providerFixtureId: string;
  registryRowId: PluginHostMcpD4RegistryRowId | 'I03' | 'I05' | 'I06';
  failureClassification: PluginHostD24FailureClassification;
  toolName: string;
}

export interface PluginHostMcpContractSummary {
  activeToolCount: number;
  cleanOutputToolCount: number;
  d24ConsumerReplayScenarioCount: number;
  legacyRewriteCandidateCount: number;
  providerReplayFixtureCount: number;
  registryRowIds: readonly PluginHostMcpD4RegistryRowId[];
  residentRouteToolCount: number;
  version: typeof PLUGIN_HOST_MCP_CONTRACT_VERSION;
}

export interface PluginHostLegacyRewriteCandidate {
  candidateId: 'D12-P02' | 'D12-P03' | 'D12-P04';
  cleanupTrigger: string;
  currentCompatibilityOwner: string;
  diagnosticOnlyFields: readonly string[];
  ordinaryOutputAllowed: boolean;
  replacementContract: string;
  status: 'preserved-with-owner' | 'rewritten';
  validationRefs: readonly string[];
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
  {
    family: 'knowledge-context',
    registryRowIds: ['I12', 'I13', 'I22'],
    toolNames: KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES,
  },
] as const satisfies readonly PluginHostMcpToolFamilyContract[];

export const PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES = listPluginToolSurfaceCatalog()
  .map((entry) => entry.name)
  .sort();

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

const MCP_PROJECTION_FAILURE_CLASSIFICATION = {
  forbiddenFieldOwner: 'plugin-mcp-projection',
  missingExpectedFieldOwner: 'consumer-expectation',
  missingFixtureOwner: 'contract-registry',
  providerShapeOwner: 'producer-fixture',
} as const satisfies PluginHostD24FailureClassification;

export const PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS = [
  {
    consumerScenario: 'Plugin MCP health projection consumes daemon health fixture',
    expectedFields: ['checks', 'services', 'version'],
    forbiddenOrdinaryOutputFields: [
      'apiKey',
      'diagnostics',
      'internalTelemetry',
      'projectRuntime',
      'providerPrivateTrace',
      'secretToken',
      'telemetry',
    ],
    failureClassification: MCP_PROJECTION_FAILURE_CLASSIFICATION,
    producerContract: '/api/v1/daemon/health',
    providerFixtureId: 'runtime-health.ready',
    registryRowId: 'I03',
    toolName: 'alembic_status',
  },
  {
    consumerScenario:
      'Plugin MCP search projection consumes resident knowledge search fixture through KnowledgeContextToolOutput',
    expectedFields: [
      'detailRefs',
      'items',
      'request.query',
      'result.totalResults',
      'sources',
      'toolName',
    ],
    forbiddenOrdinaryOutputFields: [
      'apiKey',
      'diagnostics',
      'providerPrivateTrace',
      'residentSearch',
      'searchMeta',
      'secretToken',
      'telemetry',
    ],
    failureClassification: MCP_PROJECTION_FAILURE_CLASSIFICATION,
    producerContract: '/api/v1/search',
    providerFixtureId: 'knowledge.success',
    registryRowId: 'I22',
    toolName: 'alembic_search',
  },
  {
    consumerScenario: 'Plugin Codex status projection consumes runtime status fixture',
    expectedFields: [
      'initialized',
      'projectRoot',
      'projectRuntime.identity.projectRoot',
      'statusDiagnostics',
      'workspace',
    ],
    forbiddenOrdinaryOutputFields: [
      'apiKey',
      'diagnostics',
      'internalTelemetry',
      'privateDaemonUrl',
      'providerPrivateTrace',
      'secretToken',
    ],
    failureClassification: MCP_PROJECTION_FAILURE_CLASSIFICATION,
    producerContract: '/api/v1/daemon/health',
    providerFixtureId: 'runtime-health.partial',
    registryRowId: 'I03',
    toolName: 'alembic_status',
  },
  {
    consumerScenario: 'Plugin Codex job projection consumes resident job queue fixture',
    expectedFields: ['jobRoute', 'jobs', 'projectRuntime.identity.projectRoot'],
    forbiddenOrdinaryOutputFields: [
      'apiKey',
      'diagnostics',
      'internalTelemetry',
      'privateDaemonUrl',
      'providerPrivateTrace',
      'secretToken',
    ],
    failureClassification: MCP_PROJECTION_FAILURE_CLASSIFICATION,
    producerContract: '/api/v1/jobs',
    providerFixtureId: 'jobs.queued',
    registryRowId: 'I06',
    toolName: 'alembic_job',
  },
] as const satisfies readonly PluginHostD24ConsumerReplayScenario[];

export const PLUGIN_HOST_LEGACY_REWRITE_CANDIDATES = [
  {
    candidateId: 'D12-P03',
    cleanupTrigger:
      'Remove fallback project-root diagnostics only after Codex always provides a trusted explicit workspace root.',
    currentCompatibilityOwner: 'AlembicPlugin Codex project-root resolver',
    diagnosticOnlyFields: ['projectRootResolution', 'requiredActions', 'userMessage'],
    ordinaryOutputAllowed: false,
    replacementContract:
      'Project-scoped write/init routes require a trusted explicit projectRoot and reject fallback roots.',
    status: 'preserved-with-owner',
    validationRefs: [
      'test/unit/CodexProjectRootResolver.test.ts',
      'test/unit/CodexMcpServer.test.ts',
      'test/unit/PluginHostLegacyRewriteContract.test.ts',
    ],
  },
  {
    candidateId: 'D12-P04',
    cleanupTrigger:
      'Remove dev:codex-plugin:refresh after local Plugin developer workflows use dev:codex-plugin:reload only.',
    currentCompatibilityOwner: 'AlembicPlugin local Codex plugin developer workflow',
    diagnosticOnlyFields: ['legacyAlias'],
    ordinaryOutputAllowed: false,
    replacementContract:
      'Codex-local MCP tools expose clean per-tool structuredContent and release/local-dev scripts keep refresh as a named compatibility alias.',
    status: 'preserved-with-owner',
    validationRefs: [
      'scripts/probe-mcp-codex-local-tools-clean-output.mjs',
      'scripts/probe-mcp-core-tools-clean-output.mjs',
      'scripts/probe-agent-public-tools-evaluation.mjs',
      'test/unit/PluginHostLegacyRewriteContract.test.ts',
    ],
  },
] as const satisfies readonly PluginHostLegacyRewriteCandidate[];

export function summarizePluginHostMcpContracts(): PluginHostMcpContractSummary {
  return {
    activeToolCount: PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES.length,
    cleanOutputToolCount: PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES.length,
    d24ConsumerReplayScenarioCount: PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS.length,
    legacyRewriteCandidateCount: PLUGIN_HOST_LEGACY_REWRITE_CANDIDATES.length,
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
