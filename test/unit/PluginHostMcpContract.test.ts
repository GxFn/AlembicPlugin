import { describe, expect, test } from 'vitest';
import { CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/local-tools/output.js';
import { CORE_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/core-tools/output.js';
import { GRAPH_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/knowledge-context-tools/graph-output.js';
import { KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/knowledge-context-tools/output.js';
import { RECIPE_MAP_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/knowledge-context-tools/recipe-map-output.js';
import { SEARCH_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/knowledge-context-tools/search-output.js';
import {
  getMcpOutputProjector,
  withMcpOutputSchema,
} from '../../lib/runtime/mcp/output-contract.js';
import {
  listPluginToolSurfaceCatalog,
  PLUGIN_TOOL_SURFACE_CATALOG,
} from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import {
  PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS,
  PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES,
  PLUGIN_HOST_MCP_D4_REGISTRY_ROW_IDS,
  PLUGIN_HOST_MCP_RESIDENT_ROUTE_POLICIES,
  PLUGIN_HOST_MCP_RESIDENT_ROUTE_TOOL_NAMES,
  PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS,
  PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY,
  summarizePluginHostMcpContracts,
} from '../../lib/runtime/mcp/plugin-host-contracts.js';
import { AGENT_PUBLIC_TOOL_NAMES } from '../../lib/runtime/mcp/public-tools/contract.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';

describe('Plugin host MCP D4 contract', () => {
  test('maps accepted D4 registry rows to executable Plugin tool families', () => {
    expect(PLUGIN_HOST_MCP_D4_REGISTRY_ROW_IDS).toEqual([
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
    ]);
    expect(PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS.map((contract) => contract.family)).toEqual([
      'codex-local',
      'embedded-core',
      'agent-public',
      'knowledge-context',
    ]);
    expect(PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS[0]?.toolNames).toEqual(
      CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES
    );
    expect(PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS[1]?.toolNames).toEqual(
      CORE_CLEAN_OUTPUT_TOOL_NAMES
    );
    expect(PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS[2]?.toolNames).toEqual(AGENT_PUBLIC_TOOL_NAMES);
    expect(PLUGIN_HOST_MCP_TOOL_FAMILY_CONTRACTS[3]?.toolNames).toEqual(
      KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES
    );
  });

  test('requires every active Plugin MCP tool to have a clean projector and output schema', () => {
    const catalogNames = Object.keys(PLUGIN_TOOL_SURFACE_CATALOG).sort();
    const mcpToolNames = TOOLS.map((tool) => tool.name).sort();

    expect(PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES).toEqual(catalogNames);
    expect(
      PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES.every((toolName) =>
        uniqueStrings([
          ...CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES,
          ...CORE_CLEAN_OUTPUT_TOOL_NAMES,
          ...AGENT_PUBLIC_TOOL_NAMES,
          ...KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES,
          ...GRAPH_CLEAN_OUTPUT_TOOL_NAMES,
          ...RECIPE_MAP_CLEAN_OUTPUT_TOOL_NAMES,
          ...SEARCH_CLEAN_OUTPUT_TOOL_NAMES,
        ]).includes(toolName)
      )
    ).toBe(true);
    expect(mcpToolNames.every((toolName) => catalogNames.includes(toolName))).toBe(true);

    for (const toolName of PLUGIN_HOST_MCP_ACTIVE_TOOL_NAMES) {
      expect(getMcpOutputProjector(toolName), `${toolName} has projector`).toMatchObject({
        outputSchemaName: `${toolName}_clean_output`,
      });
      const outputSchema = withMcpOutputSchema({ name: toolName }).outputSchema as
        | { additionalProperties?: unknown; properties?: Record<string, unknown> }
        | undefined;
      expect(outputSchema, `${toolName} has outputSchema`).toBeTruthy();
      expect(outputSchema?.additionalProperties, `${toolName} outputSchema is not a bag`).not.toBe(
        true
      );
      expect(outputSchema?.properties, `${toolName} outputSchema has summary`).toHaveProperty(
        'summary'
      );
      expect(outputSchema?.properties, `${toolName} outputSchema has toolName`).toHaveProperty(
        'toolName'
      );
    }
  });

  test('locks resident-route policy to catalog entries instead of implicit fallbacks', () => {
    const residentCatalogEntries = listPluginToolSurfaceCatalog()
      .filter((entry) => entry.residentRoutePolicy !== 'none')
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(PLUGIN_HOST_MCP_RESIDENT_ROUTE_TOOL_NAMES).toEqual(
      residentCatalogEntries.map((entry) => entry.name)
    );
    expect(PLUGIN_HOST_MCP_RESIDENT_ROUTE_POLICIES).toEqual([
      'dashboard-handoff',
      'explicit-resident-search',
      'resident-or-embedded-jobs',
      'resident-project-scope',
      'status-probe',
    ]);
    expect(residentCatalogEntries.map((entry) => [entry.name, entry.residentRoutePolicy])).toEqual([
      ['alembic_code_guard', 'resident-project-scope'],
      ['alembic_dashboard', 'dashboard-handoff'],
      ['alembic_job', 'resident-or-embedded-jobs'],
      ['alembic_prime', 'resident-project-scope'],
      ['alembic_recipe_map', 'resident-project-scope'],
      ['alembic_search', 'explicit-resident-search'],
      ['alembic_status', 'status-probe'],
      ['alembic_work', 'resident-project-scope'],
    ]);
  });

  test('records accepted D3 provider fixtures for Plugin resident-client replay', () => {
    const fixtureIds = uniqueStrings(
      PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY.flatMap((entry) => entry.fixtureIds)
    );

    expect(
      PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY.map((entry) => entry.registryRowId)
    ).toEqual(['I03', 'I05', 'I06', 'I10', 'I11', 'I21', 'I22', 'I23']);
    expect(fixtureIds).toEqual([
      'decision-register.scope-mismatch',
      'decision-register.success',
      'diagnostic.failure',
      'diagnostic.success',
      'guard.invalid-input',
      'guard.success',
      'intent-episode.not-found',
      'intent-episode.success',
      'jobs.cancelled',
      'jobs.queued',
      'jobs.unavailable',
      'knowledge.success',
      'project-scope.failure',
      'project-scope.success',
      'runtime-health.partial',
      'runtime-health.ready',
      'runtime-health.unavailable',
      'workflow.unavailable',
    ]);
    expect(summarizePluginHostMcpContracts()).toMatchObject({
      activeToolCount: 19,
      cleanOutputToolCount: 19,
      d24ConsumerReplayScenarioCount: 4,
      providerReplayFixtureCount: 18,
      residentRouteToolCount: 8,
      version: 1,
    });
  });

  test('defines D24 consumer-driven replay scenarios for Plugin MCP projections', () => {
    const acceptedFixtureIds = new Set(
      PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY.flatMap((entry) => entry.fixtureIds)
    );

    expect(PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS.map((scenario) => scenario.toolName)).toEqual([
      'alembic_status',
      'alembic_search',
      'alembic_status',
      'alembic_job',
    ]);

    for (const scenario of PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS) {
      expect(acceptedFixtureIds.has(scenario.providerFixtureId)).toBe(true);
      expect(scenario.expectedFields.length).toBeGreaterThan(0);
      expect(scenario.forbiddenOrdinaryOutputFields).toEqual(
        expect.arrayContaining(['apiKey', 'providerPrivateTrace', 'secretToken'])
      );
      expect(scenario.failureClassification).toMatchObject({
        forbiddenFieldOwner: 'plugin-mcp-projection',
        missingExpectedFieldOwner: 'consumer-expectation',
        missingFixtureOwner: 'contract-registry',
        providerShapeOwner: 'producer-fixture',
      });
    }
  });
});

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
