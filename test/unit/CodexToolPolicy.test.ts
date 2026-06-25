import { describe, expect, test } from 'vitest';
import {
  type HostKnowledgeState,
  LOCAL_TOOLS,
  PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES,
  resolveToolPolicy,
} from '../../lib/runtime/index.js';
import {
  getPluginToolSurfaceEntry,
  listPluginToolSurfaceCatalog,
} from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';

const tierOrder = { agent: 0, admin: 1 };
const hostWorkflowToolNames = [
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
];
const sourceGraphToolNames: string[] = [];
const publicKnowledgeNavigationToolNames = [...PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES];
// MTC-1: alembic_knowledge/structure/call_context/panorama/task are retired and deleted;
// the ToolPolicy retirement filter is gone, so they are no longer test fixtures here.
const coreTools = [
  ...hostWorkflowToolNames.map((name) => ({
    name,
    tier: 'agent',
    description: name,
    inputSchema: { type: 'object' },
  })),
  ...publicKnowledgeNavigationToolNames.map((name) => ({
    name,
    tier: 'agent',
    description: `public read ${name}`,
    inputSchema: { type: 'object' },
  })),
  {
    name: 'alembic_project_skill',
    tier: 'agent',
    description: 'project skill delivery',
    inputSchema: { type: 'object' },
  },
  {
    name: 'alembic_status',
    tier: 'agent',
    description: 'status',
    inputSchema: { type: 'object' },
  },
  {
    name: 'alembic_knowledge_lifecycle',
    tier: 'admin',
    description: 'lifecycle',
    inputSchema: { type: 'object' },
  },
];

const residentCoreTools = [
  ...coreTools,
];

const notInitialized: HostKnowledgeState = {
  hasKnowledge: false,
  initialized: false,
  recipeCount: 0,
  skillCount: 0,
  status: 'not_initialized',
  usable: false,
};

const initializedEmpty: HostKnowledgeState = {
  ...notInitialized,
  initialized: true,
  status: 'initialized_empty',
};

const knowledgeReady: HostKnowledgeState = {
  hasKnowledge: true,
  initialized: true,
  recipeCount: 1,
  skillCount: 0,
  status: 'knowledge_ready',
  usable: true,
};

describe('Codex tool policy', () => {
  test('keeps Codex-visible tool surface metadata in the Plugin catalog', () => {
    const catalog = listPluginToolSurfaceCatalog();
    const catalogNames = catalog.map((entry) => entry.name).sort();
    // MTC-4: alembic_status is a cross-server tool present in both LOCAL_TOOLS
    // and TOOLS, so the catalog lists it once — dedup the union before comparing.
    const visibleSurfaceNames = [
      ...new Set([...LOCAL_TOOLS.map((tool) => tool.name), ...TOOLS.map((tool) => tool.name)]),
    ].sort();

    expect(catalogNames).toEqual(visibleSurfaceNames);
    expect(catalogNames).not.toContain('alembic_skill');
    expect(getPluginToolSurfaceEntry('alembic_project_skill')).toMatchObject({
      handlerOwner: 'McpServer.tool-router',
      knowledgeGate: 'initialized',
      owner: 'plugin-embedded-core',
      residentRoutePolicy: 'none',
      schema: 'ProjectSkillInput',
    });
    expect(getPluginToolSurfaceEntry('alembic_search')).toMatchObject({
      residentRoutePolicy: 'explicit-resident-search',
    });
    // PDR-3: alembic_dashboard tool removed from the surface; the catalog no longer
    // carries an entry for it.
    expect(getPluginToolSurfaceEntry('alembic_dashboard')).toBeNull();
    expect(getPluginToolSurfaceEntry('alembic_source_graph_status')).toBeNull();
  });

  test('keeps uninitialized workspaces on diagnostics/status/init and init-on-demand tools', () => {
    const result = resolveToolPolicy({
      coreTools,
      knowledge: notInitialized,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.hiddenReason).toBe('CODEX_ALEMBIC_KNOWLEDGE_REQUIRED');
    expect(result.state).toBe('needs_init');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_status',
      ...sourceGraphToolNames,
      'alembic_init',
      'alembic_job',
      ...hostWorkflowToolNames,
      'alembic_prime',
    ]);
  });

  test('exposes Codex host-agent workflow and public read tools after initialization and before usable knowledge', () => {
    const result = resolveToolPolicy({
      coreTools,
      knowledge: initializedEmpty,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('needs_bootstrap');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_status',
      ...sourceGraphToolNames,
      'alembic_init',
      'alembic_job',
      ...hostWorkflowToolNames,
      ...publicKnowledgeNavigationToolNames,
      'alembic_project_skill',
    ]);
    expect(result.visibleTools.map((tool) => tool.name)).not.toContain('alembic_skill');
    expect(result.visibleTools.map((tool) => tool.name)).not.toContain('alembic_task');
    // MTC-4: alembic_status is the merged cross-server tool; it must appear exactly
    // once (served via the cold-start local surface, deduped from the core surface).
    expect(result.visibleTools.filter((tool) => tool.name === 'alembic_status')).toHaveLength(1);
  });

  test('exposes resident-backed ProjectScope tools when resident is connected but knowledge is empty', () => {
    const result = resolveToolPolicy({
      coreTools: residentCoreTools,
      knowledge: initializedEmpty,
      residentProjectScopeAvailable: true,
      tierName: 'agent',
      tierOrder,
    });
    const names = result.visibleTools.map((tool) => tool.name);

    expect(result.hiddenReason).toBeNull();
    expect(names).toEqual(
      expect.arrayContaining([
        'alembic_prime',
        'alembic_recipe_map',
        'alembic_search',
        'alembic_graph',
      ])
    );
    expect(names).toContain('alembic_status');
    expect(names).not.toContain('alembic_task');
    expect(names).not.toContain('alembic_skill');
  });

  test('exposes all Codex local tools and agent core tools when knowledge is usable', () => {
    const result = resolveToolPolicy({
      coreTools,
      knowledge: knowledgeReady,
      tierName: 'agent',
      tierOrder,
    });
    const names = result.visibleTools.map((tool) => tool.name);

    expect(result.state).toBe('ready');
    expect(names).toEqual([
      ...LOCAL_TOOLS.map((tool) => tool.name),
      ...hostWorkflowToolNames,
      ...publicKnowledgeNavigationToolNames,
      'alembic_project_skill',
    ]);
    expect(names).not.toContain('alembic_task');
    expect(names).not.toContain('alembic_knowledge_lifecycle');
  });

  test('keeps admin tools hidden unless Codex admin opt-in is explicit', () => {
    const withoutOptIn = resolveToolPolicy({
      adminEnabled: false,
      coreTools,
      knowledge: knowledgeReady,
      tierName: 'admin',
      tierOrder,
    });
    const withOptIn = resolveToolPolicy({
      adminEnabled: true,
      coreTools,
      knowledge: knowledgeReady,
      tierName: 'admin',
      tierOrder,
    });

    expect(withoutOptIn.effectiveTier).toBe('agent');
    expect(withoutOptIn.visibleTools.map((tool) => tool.name)).not.toContain(
      'alembic_knowledge_lifecycle'
    );
    expect(withOptIn.effectiveTier).toBe('admin');
    expect(withOptIn.visibleTools.map((tool) => tool.name)).toContain(
      'alembic_knowledge_lifecycle'
    );
  });

  test('keeps cold-start tools visible while bootstrap is already running', () => {
    const result = resolveToolPolicy({
      coreTools,
      knowledge: {
        ...initializedEmpty,
        jobs: {
          active: [
            {
              id: 'bootstrap_active',
              kind: 'bootstrap',
              status: 'running',
              updatedAt: '2026-05-12T00:01:00Z',
            },
          ],
          bootstrapRunning: true,
          jobsDir: '/tmp/jobs',
          jobsDirExists: true,
          latest: {
            id: 'bootstrap_active',
            kind: 'bootstrap',
            status: 'running',
            updatedAt: '2026-05-12T00:01:00Z',
          },
          latestTerminal: null,
          rescanRunning: false,
          running: true,
          total: 1,
        },
        status: 'bootstrap_running',
      },
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('bootstrap_running');
    expect(result.signals.map((signal) => signal.code)).toContain('CODEX_BOOTSTRAP_RUNNING');
    expect(result.visibleTools.map((tool) => tool.name)).toEqual([
      'alembic_status',
      ...sourceGraphToolNames,
      'alembic_init',
      'alembic_job',
      ...hostWorkflowToolNames,
      ...publicKnowledgeNavigationToolNames,
      'alembic_project_skill',
    ]);
    expect(result.visibleTools.map((tool) => tool.name)).not.toContain('alembic_skill');
    expect(result.visibleTools.map((tool) => tool.name)).not.toContain('alembic_task');
  });

  test('reports stale knowledge and vector skip without hiding agent tools', () => {
    const result = resolveToolPolicy({
      coreTools,
      knowledge: {
        ...knowledgeReady,
        freshness: {
          checkedAt: '2026-05-12T00:02:00Z',
          latestJobAt: '2026-05-12T00:01:00Z',
          latestKnowledgeAt: '2026-05-10T00:00:00Z',
          reason: 'latest rescan job failed',
          stale: true,
          status: 'refresh_failed',
        },
        status: 'knowledge_stale',
        vector: {
          documentCount: 0,
          hnswIndexPath: '/tmp/vector_index.asvec',
          indexDir: '/tmp/index',
          jsonIndexPath: '/tmp/vector_index.json',
          memoryEmbeddingsPath: '/tmp/memory_embeddings.json',
          nonBlocking: true,
          ready: false,
          reason: 'semantic vector index is not built',
          skipped: true,
          status: 'missing',
          updatedAt: null,
        },
      },
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('ready_stale');
    expect(result.visibleTools.map((tool) => tool.name)).toContain('alembic_status');
    expect(result.signals.map((signal) => signal.code)).toEqual([
      'CODEX_KNOWLEDGE_REFRESH_FAILED',
      'CODEX_VECTOR_SKIPPED_NON_BLOCKING',
    ]);
  });

  test('reports stale daemon state without downgrading usable knowledge tools', () => {
    const result = resolveToolPolicy({
      coreTools,
      daemon: {
        message: 'daemon pid is not alive',
        ready: false,
        status: 'stale',
      },
      knowledge: knowledgeReady,
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('daemon_stale');
    expect(result.visibleTools.map((tool) => tool.name)).toContain('alembic_status');
    expect(result.signals.map((signal) => signal.code)).toContain('CODEX_DAEMON_STALE');
  });

  test('reports stale SourceRefs as knowledge stale without hiding usable tools', () => {
    const result = resolveToolPolicy({
      coreTools,
      knowledge: {
        ...knowledgeReady,
        freshness: {
          checkedAt: '2026-05-12T00:02:00Z',
          latestJobAt: null,
          latestKnowledgeAt: '2026-05-10T00:00:00Z',
          reason: '1 stale SourceRef(s) across 1 Recipe(s)',
          stale: true,
          status: 'source_refs_stale',
        },
        status: 'knowledge_stale',
      },
      tierName: 'agent',
      tierOrder,
    });

    expect(result.state).toBe('ready_stale');
    expect(result.visibleTools.map((tool) => tool.name)).toContain('alembic_status');
    expect(result.signals.map((signal) => signal.code)).toContain('CODEX_SOURCE_REFS_STALE');
  });
});
