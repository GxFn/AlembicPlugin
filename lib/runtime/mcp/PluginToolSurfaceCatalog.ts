import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type PluginToolSurfaceOwner = 'codex-local' | 'plugin-embedded-core';

export type PluginToolHandlerOwner =
  | 'CodexMcpServer.local'
  | 'CodexMcpServer.resident-dashboard'
  | 'CodexMcpServer.resident-jobs'
  | 'McpServer.host-agent-bootstrap'
  | 'McpServer.host-agent-dimension-completion'
  | 'McpServer.host-agent-evolution'
  | 'McpServer.host-agent-rescan'
  | 'McpServer.agent-public-tools'
  | 'McpServer.knowledge-consolidation'
  | 'McpServer.tool-router'
  | 'McpServer.knowledge-admin';

export type PluginToolKnowledgeGate =
  | 'admin-opt-in'
  | 'cold-start'
  | 'initialized'
  | 'knowledge-ready'
  | 'none'
  | 'resident-project-scope';

export type PluginToolResidentRoutePolicy =
  | 'dashboard-handoff'
  | 'explicit-resident-search'
  | 'none'
  | 'resident-or-embedded-jobs'
  | 'resident-project-scope'
  | 'status-probe';

export interface PluginToolGatewayStaticMapping {
  action: string;
  resource: string;
}

export interface PluginToolGatewayMappingEntry {
  action?: string;
  resource?: string;
  resolver?: (args: Record<string, unknown>) => PluginToolGatewayStaticMapping | null;
}

export interface PluginToolSurfaceEntry {
  admin: boolean;
  annotations: ToolAnnotations;
  gateway: PluginToolGatewayMappingEntry | null;
  handlerOwner: PluginToolHandlerOwner;
  knowledgeGate: PluginToolKnowledgeGate;
  name: string;
  owner: PluginToolSurfaceOwner;
  residentRoutePolicy: PluginToolResidentRoutePolicy;
  schema: string;
  tier: 'admin' | 'agent';
}

type ToolLike = {
  annotations?: ToolAnnotations;
  name: string;
};

function readOnlyTool(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function localWriteTool(title: string, idempotentHint = false): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint,
    openWorldHint: false,
  };
}

function aiBackedWriteTool(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
}

function destructiveTool(title: string, idempotentHint = false): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint,
    openWorldHint: false,
  };
}

function catalogEntry(entry: Omit<PluginToolSurfaceEntry, 'admin'>): PluginToolSurfaceEntry {
  return {
    ...entry,
    admin: entry.tier === 'admin',
  };
}

// Codex-visible tool metadata lives here so annotations, gateway gates, handler
// owner, and resident-service policy cannot drift across tools.ts, ToolPolicy,
// and the Codex router.
export const PLUGIN_TOOL_SURFACE_CATALOG = {
  // MTC-4: merged alembic_health + alembic_mcp_status + alembic_codex_diagnostics.
  // Cross-server tool — listed once; primary identity is the cold-start local
  // surface (the resident shell also serves it via McpServer.tool-router).
  alembic_status: catalogEntry({
    name: 'alembic_status',
    owner: 'codex-local',
    handlerOwner: 'CodexMcpServer.local',
    tier: 'agent',
    schema: 'StatusInput',
    annotations: readOnlyTool('Check Alembic Status'),
    gateway: null,
    knowledgeGate: 'cold-start',
    residentRoutePolicy: 'status-probe',
  }),
  alembic_mcp_init: catalogEntry({
    name: 'alembic_mcp_init',
    owner: 'codex-local',
    handlerOwner: 'CodexMcpServer.local',
    tier: 'agent',
    schema: 'CodexInitInput',
    annotations: localWriteTool('Initialize Alembic Codex Workspace', true),
    gateway: null,
    knowledgeGate: 'cold-start',
    residentRoutePolicy: 'none',
  }),
  alembic_codex_dashboard: catalogEntry({
    name: 'alembic_codex_dashboard',
    owner: 'codex-local',
    handlerOwner: 'CodexMcpServer.resident-dashboard',
    tier: 'agent',
    schema: 'CodexDashboardInput',
    annotations: localWriteTool('Start Alembic Dashboard', true),
    gateway: null,
    knowledgeGate: 'cold-start',
    residentRoutePolicy: 'dashboard-handoff',
  }),
  // MTC-7: alembic_mcp_bootstrap_job + alembic_mcp_rescan_job + alembic_codex_job
  // merged into the single alembic_job route (op=bootstrap/rescan/status). It can
  // start jobs (op=bootstrap/rescan), so it keeps the AI-backed write annotation.
  alembic_job: catalogEntry({
    name: 'alembic_job',
    owner: 'codex-local',
    handlerOwner: 'CodexMcpServer.resident-jobs',
    tier: 'agent',
    schema: 'CodexJobInput',
    annotations: aiBackedWriteTool('Run Or Read Recoverable Alembic Job'),
    gateway: null,
    knowledgeGate: 'cold-start',
    residentRoutePolicy: 'resident-or-embedded-jobs',
  }),
  // MTC-7: alembic_codex_stop + alembic_codex_cleanup merged into the single
  // alembic_runtime route (action=stop/cleanup). cleanup can delete runtime
  // state, so the merged tool keeps the destructive annotation.
  alembic_runtime: catalogEntry({
    name: 'alembic_runtime',
    owner: 'codex-local',
    handlerOwner: 'CodexMcpServer.local',
    tier: 'agent',
    schema: 'CodexRuntimeInput',
    annotations: destructiveTool('Control Alembic Daemon Runtime'),
    gateway: null,
    knowledgeGate: 'cold-start',
    residentRoutePolicy: 'none',
  }),
  alembic_recipe_map: catalogEntry({
    name: 'alembic_recipe_map',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.tool-router',
    tier: 'agent',
    schema: 'RecipeMapInput',
    annotations: readOnlyTool('Map Alembic Recipes Onto ProjectContext'),
    gateway: null,
    knowledgeGate: 'resident-project-scope',
    residentRoutePolicy: 'resident-project-scope',
  }),
  alembic_search: catalogEntry({
    name: 'alembic_search',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.tool-router',
    tier: 'agent',
    schema: 'SearchInput',
    annotations: readOnlyTool('Search Or Expand Alembic Knowledge'),
    gateway: null,
    knowledgeGate: 'resident-project-scope',
    residentRoutePolicy: 'explicit-resident-search',
  }),
  alembic_graph: catalogEntry({
    name: 'alembic_graph',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.tool-router',
    tier: 'agent',
    schema: 'GraphInput',
    annotations: readOnlyTool('Query Alembic Project Graph'),
    gateway: null,
    knowledgeGate: 'resident-project-scope',
    residentRoutePolicy: 'none',
  }),
  alembic_submit_knowledge: catalogEntry({
    name: 'alembic_submit_knowledge',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.tool-router',
    tier: 'agent',
    schema: 'SubmitKnowledgeInput',
    annotations: aiBackedWriteTool('Submit Alembic Knowledge Candidate'),
    gateway: { action: 'knowledge:create', resource: 'knowledge' },
    knowledgeGate: 'initialized',
    residentRoutePolicy: 'none',
  }),
  alembic_project_skill: catalogEntry({
    name: 'alembic_project_skill',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.tool-router',
    tier: 'agent',
    schema: 'ProjectSkillInput',
    annotations: localWriteTool('Deliver Alembic Project Skills To Codex'),
    gateway: {
      resolver: (args: Record<string, unknown>) =>
        (
          ({
            create: { action: 'create:skills', resource: 'skills' },
            update: { action: 'update:skills', resource: 'skills' },
            delete: { action: 'delete:skills', resource: 'skills' },
            export: { action: 'update:skills', resource: 'skills' },
          }) as Record<string, PluginToolGatewayStaticMapping>
        )[args?.operation as string] || null,
    },
    knowledgeGate: 'initialized',
    residentRoutePolicy: 'none',
  }),
  alembic_bootstrap: catalogEntry({
    name: 'alembic_bootstrap',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.host-agent-bootstrap',
    tier: 'agent',
    schema: 'BootstrapInput',
    annotations: aiBackedWriteTool('Run Codex Host-Agent Bootstrap'),
    gateway: null,
    knowledgeGate: 'initialized',
    residentRoutePolicy: 'none',
  }),
  alembic_rescan: catalogEntry({
    name: 'alembic_rescan',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.host-agent-rescan',
    tier: 'agent',
    schema: 'RescanInput',
    annotations: aiBackedWriteTool('Run Codex Host-Agent Rescan'),
    gateway: { action: 'knowledge:bootstrap', resource: 'knowledge' },
    knowledgeGate: 'initialized',
    residentRoutePolicy: 'none',
  }),
  alembic_evolve: catalogEntry({
    name: 'alembic_evolve',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.host-agent-evolution',
    tier: 'agent',
    schema: 'EvolveInput',
    annotations: destructiveTool('Apply Alembic Evolution Decision'),
    gateway: { action: 'knowledge:evolve', resource: 'knowledge' },
    knowledgeGate: 'knowledge-ready',
    residentRoutePolicy: 'none',
  }),
  alembic_consolidate: catalogEntry({
    name: 'alembic_consolidate',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.knowledge-consolidation',
    tier: 'agent',
    schema: 'ConsolidateInput',
    annotations: localWriteTool('Review Alembic Consolidation Decision'),
    gateway: { action: 'knowledge:consolidate', resource: 'knowledge' },
    knowledgeGate: 'knowledge-ready',
    residentRoutePolicy: 'none',
  }),
  alembic_dimension_complete: catalogEntry({
    name: 'alembic_dimension_complete',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.host-agent-dimension-completion',
    tier: 'agent',
    schema: 'DimensionCompleteInput',
    annotations: localWriteTool('Complete Alembic Dimension Analysis'),
    gateway: { action: 'knowledge:bootstrap', resource: 'knowledge' },
    knowledgeGate: 'initialized',
    residentRoutePolicy: 'none',
  }),
  alembic_prime: catalogEntry({
    name: 'alembic_prime',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.agent-public-tools',
    tier: 'agent',
    schema: 'PrimeInput',
    annotations: readOnlyTool('Prime Agent Knowledge Context'),
    gateway: null,
    knowledgeGate: 'resident-project-scope',
    residentRoutePolicy: 'resident-project-scope',
  }),
  // MTC-7: merged alembic_work_start + alembic_work_finish into the phase-routed
  // alembic_work tool (still a local write surface).
  alembic_work: catalogEntry({
    name: 'alembic_work',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.agent-public-tools',
    tier: 'agent',
    schema: 'WorkInput',
    annotations: localWriteTool('Track Agent Work (start/finish)'),
    gateway: null,
    knowledgeGate: 'resident-project-scope',
    residentRoutePolicy: 'resident-project-scope',
  }),
  alembic_code_guard: catalogEntry({
    name: 'alembic_code_guard',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.agent-public-tools',
    tier: 'agent',
    schema: 'CodeGuardInput',
    annotations: localWriteTool('Run Scoped Agent Code Guard'),
    gateway: null,
    knowledgeGate: 'resident-project-scope',
    residentRoutePolicy: 'resident-project-scope',
  }),
  alembic_knowledge_lifecycle: catalogEntry({
    name: 'alembic_knowledge_lifecycle',
    owner: 'plugin-embedded-core',
    handlerOwner: 'McpServer.knowledge-admin',
    tier: 'admin',
    schema: 'KnowledgeLifecycleInput',
    annotations: localWriteTool('Request Alembic Knowledge Reactivation'),
    gateway: { action: 'knowledge:update', resource: 'knowledge' },
    knowledgeGate: 'admin-opt-in',
    residentRoutePolicy: 'none',
  }),
} as const satisfies Record<string, PluginToolSurfaceEntry>;

export const TOOL_GATEWAY_MAP = Object.fromEntries(
  Object.entries(PLUGIN_TOOL_SURFACE_CATALOG)
    .filter(([, entry]) => entry.gateway)
    .map(([name, entry]) => [name, entry.gateway])
) as Record<string, PluginToolGatewayMappingEntry>;

export function getPluginToolSurfaceEntry(name: string): PluginToolSurfaceEntry | null {
  return (PLUGIN_TOOL_SURFACE_CATALOG as Record<string, PluginToolSurfaceEntry>)[name] ?? null;
}

export function getPluginToolAnnotations(name: string): ToolAnnotations | null {
  return getPluginToolSurfaceEntry(name)?.annotations ?? null;
}

export function withPluginToolAnnotations<T extends ToolLike>(
  tool: T
): T & { annotations?: ToolAnnotations } {
  const annotations = getPluginToolAnnotations(tool.name);
  if (!annotations) {
    return tool;
  }
  return {
    ...tool,
    annotations: {
      ...annotations,
      ...tool.annotations,
    },
  };
}

export function listPluginToolSurfaceCatalog(): PluginToolSurfaceEntry[] {
  return Object.values(PLUGIN_TOOL_SURFACE_CATALOG).map((entry) => ({
    ...entry,
    annotations: { ...entry.annotations },
  }));
}
