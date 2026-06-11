import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAlembicResidentServiceStatus,
  createProjectRuntimeControlState,
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  JobStore,
  resolveDaemonPaths,
} from '@alembic/core/daemon';
import { pathGuard } from '@alembic/core/io';
import { PROJECT_SCOPE_CONTRACT_VERSION, type ProjectScopeSummary } from '@alembic/core/shared';
import {
  getGhostWorkspaceDir,
  getProjectRegistryDir,
  ProjectRegistry,
} from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CodexMcpServer,
  getVisibleCodexTools,
  resetCodexPluginOwnedMcpServerForTests,
} from '../../lib/codex/mcp/CodexMcpServer.js';
import {
  getCodexSavedProjectRootPath,
  readCodexInitMarker,
} from '../../lib/codex/ProjectRootResolver.js';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { buildCodexMcpGuidance } from '../../lib/codex/mcp/host/guidance.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_ALEMBIC_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_CODEX_ENABLE_ADMIN = process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
const ORIGINAL_CODEX_WORKSPACE_DIR = process.env.CODEX_WORKSPACE_DIR;
const ORIGINAL_CODEX_WORKSPACE_ROOT = process.env.CODEX_WORKSPACE_ROOT;
const ORIGINAL_CODEX_PROJECT_SCOPE_SUMMARY = process.env.ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY;
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;
const ORIGINAL_MCP_TIER = process.env.ALEMBIC_MCP_TIER;
const ORIGINAL_PWD = process.env.PWD;
const CODEX_HOST_AGENT_TOOL_NAMES = [
  'alembic_submit_knowledge',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_dimension_complete',
];
const CODEX_AGENT_PUBLIC_TOOL_NAMES = [
  'alembic_intent',
  'alembic_prime',
  'alembic_work_start',
  'alembic_work_finish',
  'alembic_code_guard',
  'alembic_decision_record',
];
const CODEX_SOURCE_GRAPH_TOOL_NAMES = [
  'alembic_source_graph_status',
  'alembic_symbol_search',
  'alembic_code_explore',
  'alembic_source_node',
  'alembic_callers',
  'alembic_callees',
  'alembic_code_impact',
  'alembic_affected_tests',
  'alembic_validation_plan',
];
const CODEX_INITIALIZED_NO_KNOWLEDGE_TOOL_NAMES = [
  ...CODEX_AGENT_PUBLIC_TOOL_NAMES,
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_dimension_complete',
];

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-codex-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-codex-project-'));
}

function makeInitializedWorkspace(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
}

function makeUsableKnowledgeBase(projectRoot: string): void {
  makeInitializedWorkspace(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, 'Alembic', 'recipes', 'http-client.md'),
    '---\ntitle: HTTP Client\n---\nUse the project HTTP client.\n'
  );
}

function makeDirtyGitRepo(projectRoot: string): void {
  fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const value = 1;\n');
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Alembic Test']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const value = 2;\n');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function writeRunningBootstrapJob(projectRoot: string): void {
  const jobsDir = path.join(projectRoot, '.asd', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, 'bootstrap_active.json'),
    `${JSON.stringify(
      {
        id: 'bootstrap_active',
        kind: 'bootstrap',
        status: 'running',
        source: 'codex',
        channelId: 'codex',
        createdByTool: 'alembic_codex_bootstrap',
        createdAt: '2026-05-24T08:00:00.000Z',
        updatedAt: '2026-05-24T08:01:00.000Z',
      },
      null,
      2
    )}\n`
  );
}

function writeRuntimeControlState(
  state: Parameters<typeof createProjectRuntimeControlState>[0]
): void {
  fs.mkdirSync(getProjectRegistryDir(), { recursive: true });
  fs.writeFileSync(
    path.join(getProjectRegistryDir(), 'runtime-control.json'),
    `${JSON.stringify(createProjectRuntimeControlState(state), null, 2)}\n`
  );
}

function makeDaemonState(projectRoot: string, overrides: Partial<DaemonState> = {}): DaemonState {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    pid: 12345,
    host: '127.0.0.1',
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-08T00:00:00.000Z',
    lastReadyAt: '2026-05-08T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
    ...overrides,
  };
}

function makeDaemonStatus(
  projectRoot: string,
  overrides: Partial<DaemonStatus> = {}
): DaemonStatus {
  const paths = resolveDaemonPaths(projectRoot);
  const state = makeDaemonState(projectRoot);
  return {
    status: 'ready',
    ready: true,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    lockDir: paths.lockDir,
    logPath: paths.logPath,
    state,
    pidAlive: true,
    health: null,
    ...overrides,
  };
}

function writeDaemonState(projectRoot: string, state: DaemonState = makeDaemonState(projectRoot)) {
  const paths = resolveDaemonPaths(projectRoot);
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function makeProjectScopeSummary(input: {
  controlRoot: string;
  currentFolderPath: string;
  dataRoot: string;
}): ProjectScopeSummary {
  return {
    contractVersion: PROJECT_SCOPE_CONTRACT_VERSION,
    controlRoot: input.controlRoot,
    controlRootIncludedInFolders: false,
    currentFolderId: 'folder-plugin',
    currentFolderPath: input.currentFolderPath,
    dataRoot: input.dataRoot,
    dataRootSource: 'ghost-registry',
    displayName: 'Alembic workspace',
    folderCount: 1,
    folders: [
      {
        displayName: 'AlembicPlugin',
        folderId: 'folder-plugin',
        path: input.currentFolderPath,
        realpath: input.currentFolderPath,
        repositoryId: 'alembic-plugin',
        role: 'source',
        state: 'active',
      },
    ],
    projectId: 'project-workspace',
    projectRootWriteAllowed: false,
    projectScopeId: 'project-scope-workspace',
    standardWriteAllowed: false,
    storageKind: 'ghost',
  };
}

function makeProjectScopeHealthPayload(projectScope: ProjectScopeSummary) {
  return {
    success: true,
    data: {
      residentService: createAlembicResidentServiceStatus({
        apiBaseUrl: 'http://127.0.0.1:39127',
        owner: 'alembic',
        route: 'local-alembic-daemon',
        capabilityOverrides: {
          'dashboard.handoff': { available: true, message: 'Dashboard handoff available.' },
          'jobs.api-ai.bootstrap': { available: true, message: 'Bootstrap jobs available.' },
          'jobs.api-ai.rescan': { available: true, message: 'Rescan jobs available.' },
          'search.keyword': { available: true, message: 'Keyword search available.' },
          'search.semantic': { available: true, message: 'Semantic search available.' },
          'status.health': { available: true, message: 'Health available.' },
        },
        serviceScope: {
          diagnosticPaths: {
            controlRoot: projectScope.controlRoot,
            databasePath: path.join(projectScope.dataRoot, '.asd', 'alembic.db'),
            dataRoot: projectScope.dataRoot,
            projectRoot: projectScope.currentFolderPath,
            runtimeDir: path.join(projectScope.dataRoot, '.asd', 'daemon'),
            statePath: path.join(projectScope.dataRoot, '.asd', 'daemon', 'state.json'),
          },
          displayName: projectScope.displayName,
          kind: 'current-project',
          projectIdentity: {
            dataRootSource: 'ghost-registry',
            projectId: projectScope.projectId,
            projectScope,
            projectScopeId: projectScope.projectScopeId,
            schemaMigrationVersion: null,
            workspaceMode: 'ghost',
          },
          scopeId: `project-scope:${projectScope.projectScopeId}`,
        },
      }),
    },
  };
}

function makeRuntimeControlSourceOfTruth(projectRoot: string): Record<string, unknown> {
  const staleRoot = path.join(projectRoot, 'stale-active');
  return {
    contractVersion: 1,
    diagnostics: [
      {
        action: 'cleared-active-state',
        code: 'active-runtime-state-stale',
        message: 'Alembic cleared stale active runtime state.',
        projectId: 'project-stale',
        projectRoot: staleRoot,
        reasonCode: 'runtime-control-active-stale',
        severity: 'error',
        source: 'runtime-control-state',
      },
    ],
    failure: {
      blockedFallbacks: ['plugin-selected-root-fallback', 'implicit-runtime-control-write'],
      blockingCondition: 'Alembic cleared stale active runtime state.',
      diagnostics: [
        {
          code: 'active-runtime-state-stale',
          reasonCode: 'runtime-control-active-stale',
        },
      ],
      observedSource: 'alembic-source-of-truth',
      reasonCode: 'runtime-control-active-stale',
      retryable: true,
    },
    operation: {
      explicitRuntimeActionRequired: true,
      implicitRuntimeActionAllowed: false,
      mode: 'diagnostics-read',
      readOnly: true,
    },
    owner: 'alembic',
    readiness: {
      ready: false,
      reasonCode: 'runtime-control-active-stale',
      stale: true,
      status: 'stale',
    },
    requiredService: {
      kind: 'project-runtime-control',
      owner: 'alembic',
      route: 'project-runtime-control',
    },
    route: 'project-runtime-control',
    runtimeControl: {
      activeMatchesCurrentProject: false,
      activeProject: null,
      activeReadyProject: null,
      activeStateTrusted: false,
      diagnostics: [
        {
          code: 'active-runtime-state-stale',
          reasonCode: 'runtime-control-active-stale',
          severity: 'error',
        },
      ],
      projects: { missing: 0, ready: 0, stale: 1, total: 1, unavailable: 0 },
      readOnly: true,
      selectedMatchesCurrentProject: true,
      selectedProject: {
        projectId: 'project-current',
        projectRoot,
        ready: false,
        status: 'stale',
      },
      state: {
        activeProjectId: null,
        activeProjectRoot: null,
        schemaVersion: 1,
        selectedAt: '2026-06-05T09:00:00.000Z',
        selectedProjectId: 'project-current',
        selectedProjectRoot: projectRoot,
        updatedAt: '2026-06-05T09:01:00.000Z',
      },
      stateCleanup: {
        activeState: {
          cleaned: true,
          cleanedAt: '2026-06-05T09:01:00.000Z',
          message: 'Cleared stale active runtime state.',
          previousProjectId: 'project-stale',
          previousProjectRoot: staleRoot,
          reasonCode: 'runtime-control-active-stale',
        },
      },
      statePath: path.join(projectRoot, '.asd', 'runtime-control.json'),
    },
    targetProject: {
      projectId: 'project-current',
      projectRoot,
      ready: false,
      status: 'stale',
    },
    writePolicy: {
      activeStateWriteAllowed: false,
      daemonLifecycleWriteAllowed: false,
      jobStoreWriteAllowed: false,
      projectScopeRegistryWriteAllowed: false,
      selectedStateWriteAllowed: false,
      writeOwner: 'alembic',
    },
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function makeSupervisor(status: DaemonStatus) {
  return {
    status: vi.fn(async () => status),
    ensure: vi.fn(async () => status),
    stop: vi.fn(async () => ({ ...status, status: 'stopped' as const, ready: false, state: null })),
  };
}

afterEach(async () => {
  // Codex-facing tools now execute in the Plugin process, so tests must clear
  // per-project globals between temporary workspaces.
  await resetCodexPluginOwnedMcpServerForTests();
  resetServiceContainer();
  pathGuard._reset();
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  if (ORIGINAL_CODEX_ENABLE_ADMIN === undefined) {
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
  } else {
    process.env.ALEMBIC_CODEX_ENABLE_ADMIN = ORIGINAL_CODEX_ENABLE_ADMIN;
  }
  if (ORIGINAL_ALEMBIC_PROJECT_DIR === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = ORIGINAL_ALEMBIC_PROJECT_DIR;
  }
  if (ORIGINAL_CODEX_WORKSPACE_DIR === undefined) {
    delete process.env.CODEX_WORKSPACE_DIR;
  } else {
    process.env.CODEX_WORKSPACE_DIR = ORIGINAL_CODEX_WORKSPACE_DIR;
  }
  if (ORIGINAL_CODEX_WORKSPACE_ROOT === undefined) {
    delete process.env.CODEX_WORKSPACE_ROOT;
  } else {
    process.env.CODEX_WORKSPACE_ROOT = ORIGINAL_CODEX_WORKSPACE_ROOT;
  }
  if (ORIGINAL_CODEX_PROJECT_SCOPE_SUMMARY === undefined) {
    delete process.env.ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY;
  } else {
    process.env.ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY = ORIGINAL_CODEX_PROJECT_SCOPE_SUMMARY;
  }
  if (ORIGINAL_INIT_CWD === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = ORIGINAL_INIT_CWD;
  }
  if (ORIGINAL_MCP_TIER === undefined) {
    delete process.env.ALEMBIC_MCP_TIER;
  } else {
    process.env.ALEMBIC_MCP_TIER = ORIGINAL_MCP_TIER;
  }
  if (ORIGINAL_PWD === undefined) {
    delete process.env.PWD;
  } else {
    process.env.PWD = ORIGINAL_PWD;
  }
  vi.restoreAllMocks();
});

describe('CodexMcpServer', () => {
  test('lists Codex local tools alongside agent-tier Alembic tools', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const tools = getVisibleCodexTools('agent', projectRoot);
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('alembic_codex_status');
    expect(names).toContain('alembic_codex_diagnostics');
    expect(names).not.toContain(['alembic', 'codex', 'ai', 'config'].join('_'));
    expect(names).toContain('alembic_codex_dashboard');
    expect(names).toContain('alembic_codex_bootstrap');
    expect(names).toContain('alembic_codex_job');
    expect(names).toContain('alembic_codex_cleanup');
    expect(names).toContain('alembic_bootstrap');
    expect(names).toContain('alembic_rescan');
    expect(names).toContain('alembic_project_skill');
    expect(names).toContain('alembic_health');
    expect(names).not.toContain('alembic_knowledge_lifecycle');
  });

  test('builds initialize guidance from the visible Codex tool catalog', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const server = new CodexMcpServer({ projectRoot });
    const instructions = server.getInitializeInstructions();

    expect(instructions).toContain('`alembic_source_graph_status`');
    expect(instructions).toContain('`alembic_code_explore`');
    expect(instructions).toContain('`alembic_symbol_search`');
    expect(instructions).toContain('`alembic_search`');
    expect(instructions).toContain('`alembic_code_guard`');
    expect(instructions).toContain('`bootstrapState`');
    expect(instructions).toContain('`currentDomainSop`');
    expect(instructions).toContain('`toolCapabilities`');
    expect(instructions).toContain('raw file reads/search');
    expect(instructions).toContain('Validation is still required');
  });

  test('does not advertise source graph tools filtered out of the visible catalog', () => {
    const guidance = buildCodexMcpGuidance([
      { name: 'alembic_source_graph_status' },
      { name: 'alembic_code_explore' },
      { name: 'alembic_prime' },
    ]);

    expect(guidance.sourceGraphTools).toEqual([
      'alembic_source_graph_status',
      'alembic_code_explore',
    ]);
    expect(guidance.instructions).toContain('`alembic_code_explore`');
    expect(guidance.instructions).not.toContain('alembic_symbol_search');
    expect(guidance.instructions).not.toContain('alembic_callers');
    expect(guidance.instructions).not.toContain('alembic_affected_tests');
    expect(guidance.instructions).not.toContain('alembic_validation_plan');
  });

  test('keeps source graph tool-list descriptions aligned with first-tool guidance', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const byName = new Map(
      getVisibleCodexTools('agent', projectRoot).map((tool) => [tool.name, tool])
    );

    expect(byName.get('alembic_source_graph_status')?.description).toContain(
      'First source graph check'
    );
    expect(byName.get('alembic_code_explore')?.description).toContain(
      'Primary first tool for current-code understanding'
    );
    expect(byName.get('alembic_symbol_search')?.description).toContain(
      'Use before broad raw Read/Grep'
    );
    expect(byName.get('alembic_code_impact')?.description).toContain(
      'pair with Guard and repository tests'
    );
    expect(byName.get('alembic_affected_tests')?.description).toContain(
      'do not replace repository validation'
    );
    expect(byName.get('alembic_validation_plan')?.description).toContain(
      'mustRun, recommended, manualReview, and unknown'
    );
  });

  test('exposes MCP tool annotations so clients can reduce approval prompts', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const tools = getVisibleCodexTools('agent', projectRoot);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(tools.every((tool) => tool.annotations)).toBe(true);
    expect(byName.get('alembic_codex_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('alembic_guard')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get('alembic_codex_bootstrap')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.get('alembic_codex_cleanup')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  test('exposes cold-start and init-on-demand tools before workspace initialization', () => {
    const projectRoot = makeProjectRoot();
    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      ...CODEX_SOURCE_GRAPH_TOOL_NAMES,
      'alembic_codex_init',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
      ...CODEX_AGENT_PUBLIC_TOOL_NAMES,
      ...CODEX_HOST_AGENT_TOOL_NAMES,
    ]);
  });

  test('exposes cold-start plus Codex host-agent workflow tools when initialized workspace has no usable knowledge', () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      ...CODEX_SOURCE_GRAPH_TOOL_NAMES,
      'alembic_codex_init',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
      ...CODEX_INITIALIZED_NO_KNOWLEDGE_TOOL_NAMES,
    ]);
    expect(names).not.toContain('alembic_health');
    expect(names).not.toContain('alembic_search');
    expect(names).not.toContain('alembic_guard');
    expect(names).not.toContain('alembic_skill');
  });

  test('exposes resident-backed tools for ProjectScope resident even when local folder knowledge is empty', () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const names = getVisibleCodexTools('agent', projectRoot, {
      residentProjectScopeAvailable: true,
    }).map((tool) => tool.name);

    expect(names).toContain('alembic_search');
    expect(names).toContain('alembic_health');
    expect(names).not.toContain('alembic_task');
    expect(names).not.toContain('alembic_skill');
  });

  test('executes ProjectScope resident-backed tools from an excluded source folder without source writes', async () => {
    useTempAlembicHome();
    const controlRoot = makeProjectRoot();
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'AlembicPlugin-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-scope-data-'));
    fs.writeFileSync(
      path.join(sourceRoot, 'package.json'),
      `${JSON.stringify({ name: '@alembic/plugin' }, null, 2)}\n`
    );
    makeInitializedWorkspace(dataRoot);
    writeDaemonState(controlRoot);
    const projectScope = makeProjectScopeSummary({
      controlRoot,
      currentFolderPath: sourceRoot,
      dataRoot,
    });
    writeRuntimeControlState({
      activeProjectId: projectScope.projectId,
      activeProjectRoot: controlRoot,
      selectedAt: '2026-05-25T00:00:00.000Z',
      selectedProjectId: projectScope.projectId,
      selectedProjectRoot: controlRoot,
      updatedAt: '2026-05-25T00:00:00.000Z',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(makeProjectScopeHealthPayload(projectScope)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/v1/project-scope/resolve-folder') {
        expect(url.searchParams.get('folderPath')).toBe(sourceRoot);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              capability: { available: true, storageKind: 'ghost' },
              summary: projectScope,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.pathname === '/api/v1/search') {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: 'scope-recipe',
                  title: 'ProjectScope recipe',
                  trigger: '@project-scope',
                  kind: 'pattern',
                  language: 'typescript',
                  score: 0.94,
                  description: 'Use ProjectScope resident knowledge.',
                },
              ],
              searchMeta: {
                route: 'resident-search',
                requestedMode: url.searchParams.get('mode'),
                actualMode: 'semantic',
                semanticUsed: true,
                vectorUsed: true,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected resident request: ${url.toString()}`);
    });
    const supervisor = makeSupervisor(
      makeDaemonStatus(sourceRoot, {
        message: 'source folder has no direct daemon state',
        ready: false,
        state: null,
        status: 'stopped',
      })
    );
    const server = new CodexMcpServer({ projectRoot: sourceRoot, supervisor });

    const healthResult = (await server.handleToolCall('alembic_health', {})) as {
      data: {
        codexProjectScopeExecution: { dataRoot: string; enabled: boolean; projectScopeId: string };
        projectRuntime: {
          fallbackIsolation: Array<{ effectiveIdentityAllowed: boolean; id: string }>;
          identity: {
            dataRoot: string;
            databasePath: string;
            projectRoot: string;
            projectScopeId: string;
            runtimeDir: string;
          };
          sourcePolicy: { effectiveIdentitySource: string; projectScopeSource: string };
        };
        projectRoot: string;
      };
      success: boolean;
    };
    const searchResult = (await server.handleToolCall('alembic_search', {
      query: 'ProjectScope recipe',
      mode: 'auto',
      limit: 1,
    })) as {
      data: {
        searchMeta: { residentSearch: { projectScopeIdentity: { projectScopeId: string } } };
      };
      success: boolean;
    };
    const primeResult = (await server.handleToolCall('alembic_prime', {
      hostDeclaredIntent: {
        action: 'implement',
        query: 'Use ProjectScope recipe',
      },
      inputSource: 'host-declared-intent',
      language: 'typescript',
    })) as {
      ok: boolean;
      primePackage: {
        trustReceipt: { status: string };
      };
      status: string;
    };

    expect(healthResult.success).toBe(true);
    expect(healthResult.data.projectRoot).toBe(sourceRoot);
    expect(healthResult.data.codexProjectScopeExecution).toMatchObject({
      dataRoot,
      enabled: true,
      projectScopeId: projectScope.projectScopeId,
    });
    expect(healthResult.data.projectRuntime).toMatchObject({
      identity: {
        dataRoot,
        databasePath: path.join(dataRoot, '.asd', 'alembic.db'),
        projectRoot: sourceRoot,
        projectScopeId: projectScope.projectScopeId,
        runtimeDir: path.join(dataRoot, '.asd'),
      },
      sourcePolicy: {
        effectiveIdentitySource: 'codex-current-project',
        projectScopeSource: 'resident-read-only',
      },
    });
    expect(healthResult.data.projectRuntime.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'embedded-plugin-owned-runtime',
        }),
      ])
    );
    expect(searchResult.success).toBe(true);
    expect(searchResult.data.searchMeta.residentSearch.projectScopeIdentity).toMatchObject({
      projectScopeId: projectScope.projectScopeId,
    });
    expect(primeResult.ok).toBe(true);
    expect(['ready', 'degraded']).toContain(primeResult.status);
    expect(primeResult.primePackage.trustReceipt.status).toBe('delivered');
    expect(fs.existsSync(path.join(sourceRoot, '.asd'))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, 'Alembic'))).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('alembic_codex_diagnostics exposes runtime-control diagnostics and state cleanup read-only', async () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const sourceOfTruth = makeRuntimeControlSourceOfTruth(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        health: { data: { projectRuntimeSourceOfTruth: sourceOfTruth } },
        message: 'Alembic cleared stale active runtime state.',
        ready: false,
        status: 'stale',
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_diagnostics', {})) as {
      data: {
        projectRuntime: {
          blockedFallbacks: string[];
          fallbackIsolation: Array<{ effectiveIdentityAllowed: boolean; id: string }>;
          requiredServices: Array<{ reason: string | null; service: string; source: string }>;
          sourceOfTruth: {
            readiness: { reasonCode: string };
            runtimeControl: {
              diagnostics: Array<{ code: string; reasonCode: string }>;
              stateCleanup: {
                activeState: {
                  cleaned: boolean;
                  previousProjectId: string | null;
                  reasonCode: string | null;
                };
              };
            };
          };
          sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: boolean };
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.projectRuntime.sourceOfTruth).toMatchObject({
      readiness: {
        reasonCode: 'runtime-control-active-stale',
      },
      runtimeControl: {
        diagnostics: [
          {
            code: 'active-runtime-state-stale',
            reasonCode: 'runtime-control-active-stale',
          },
        ],
        stateCleanup: {
          activeState: {
            cleaned: true,
            previousProjectId: 'project-stale',
            reasonCode: 'runtime-control-active-stale',
          },
        },
      },
    });
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'daemon-stale',
          service: 'daemon',
          source: 'project-runtime-control',
        }),
      ])
    );
    expect(result.data.projectRuntime.sourcePolicy).toMatchObject({
      selectedOrActiveCanOverrideEffectiveIdentity: false,
    });
    expect(result.data.projectRuntime.blockedFallbacks).toContain(
      'runtime-control-selected-active-effective-identity'
    );
    expect(result.data.projectRuntime.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'runtime-control-selected-active',
        }),
      ])
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('keeps project skill delivery visible while initialized knowledge is not usable and bootstrap is running', async () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    writeRunningBootstrapJob(projectRoot);

    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toContain('alembic_project_skill');
    expect(names).not.toContain('alembic_skill');
    expect(names).not.toContain('alembic_health');

    const server = new CodexMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_project_skill', {
      operation: 'list',
    })) as {
      data?: { codexRuntime?: { root?: string }; replacementFor?: string };
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data?.replacementFor).toBeUndefined();
    expect(result.data?.codexRuntime?.root).toBe(path.join(projectRoot, '.agents', 'skills'));
  });

  test('detects usable knowledge from the registered ghost data root', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const ghostRoot = getGhostWorkspaceDir(entry.id);
    makeInitializedWorkspace(ghostRoot);
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'Alembic', 'recipes', 'project-tree-should-not-count.md'),
      '# Ignored Project Tree Recipe\n'
    );

    expect(getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name)).toEqual([
      'alembic_codex_status',
      'alembic_codex_diagnostics',
      ...CODEX_SOURCE_GRAPH_TOOL_NAMES,
      'alembic_codex_init',
      'alembic_codex_dashboard',
      'alembic_codex_bootstrap',
      'alembic_codex_rescan',
      'alembic_codex_job',
      ...CODEX_INITIALIZED_NO_KNOWLEDGE_TOOL_NAMES,
    ]);
    expect(getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name)).not.toContain(
      'alembic_skill'
    );

    fs.writeFileSync(
      path.join(ghostRoot, 'Alembic', 'recipes', 'ghost-recipe.md'),
      '# Ghost Recipe\n'
    );

    const names = getVisibleCodexTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).not.toContain('alembic_task');
    expect(names).toContain('alembic_health');
    expect(names).toContain('alembic_codex_dashboard');
  });

  test('requires a second Codex admin opt-in before exposing admin-tier tools', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;

    expect(getVisibleCodexTools(undefined, projectRoot).map((tool) => tool.name)).not.toContain(
      'alembic_knowledge_lifecycle'
    );

    process.env.ALEMBIC_CODEX_ENABLE_ADMIN = '1';

    expect(getVisibleCodexTools(undefined, projectRoot).map((tool) => tool.name)).toContain(
      'alembic_knowledge_lifecycle'
    );
  });

  test('status inspects workspace and daemon state without ensuring daemon startup', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
        message: 'daemon is not started',
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_status', {})) as {
      success: boolean;
      data: {
        initialized: boolean;
        daemon: { ready: boolean };
        diagnostics: {
          moduleBoundary: { dashboard: { artifactPath: string; sourceOwner: string } };
          node: { ok: boolean };
        };
        nextActions: string[];
        onboarding: {
          primaryAction: { startsDaemon: boolean; tool: string };
          state: string;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.initialized).toBe(false);
    expect(result.data.daemon.ready).toBe(false);
    expect(result.data.diagnostics.node.ok).toBe(true);
    expect(result.data.diagnostics.moduleBoundary.dashboard).toMatchObject({
      artifactPath: null,
      sourceOwner: 'Alembic/AlembicDashboard',
    });
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { startsDaemon: false, tool: 'alembic_codex_init' },
    });
    expect(result.data.nextActions).toContain(
      'Initialize Ghost workspace: call alembic_codex_init'
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('tool-call projectRoot override scopes status to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_codex_status', { projectRoot })) as {
      data: {
        projectRoot: string;
        projectRootResolution: { path: string; source: string; trust: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.projectRoot).toBe(projectRoot);
    expect(result.data.projectRootResolution).toMatchObject({
      path: projectRoot,
      source: 'explicit-option',
      trust: 'trusted',
    });
    expect(supervisor.status).toHaveBeenCalledWith(projectRoot);
  });

  test('tool-call projectRoot override saves diagnostics but is not reused as effective identity', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.INIT_CWD = pluginRoot;
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const firstServer = new CodexMcpServer({ supervisor });
    await firstServer.handleToolCall('alembic_codex_status', { projectRoot });

    const secondServer = new CodexMcpServer({ supervisor });
    const result = (await secondServer.handleToolCall('alembic_codex_status', {})) as {
      data: {
        errorCode?: string;
        projectRoot?: string;
        projectRootResolution: { path: string; source: string; trust: string };
      };
      success: boolean;
    };

    expect(fs.existsSync(getCodexSavedProjectRootPath())).toBe(true);
    expect(result.data.projectRoot).not.toBe(projectRoot);
    expect(result.data.projectRootResolution.path).not.toBe(projectRoot);
    expect(result.data.projectRootResolution.source).not.toBe('saved-project-root');
    if (!result.success) {
      expect(result.data.errorCode).toBe('CODEX_PROJECT_ROOT_REJECTED');
      expect(result.data.projectRootResolution).toMatchObject({
        source: 'INIT_CWD',
        trust: 'rejected',
      });
    }
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
  });

  test('status recommends bootstrap after initialization when knowledge is still empty', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_status', {})) as {
      success: boolean;
      data: {
        initialized: boolean;
        knowledge: { usable: boolean; recipeCount: number; skillCount: number };
        onboarding: { primaryAction: { tool: string }; state: string };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.initialized).toBe(true);
    expect(result.data.knowledge).toMatchObject({ usable: false, recipeCount: 0, skillCount: 0 });
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_bootstrap',
      primaryAction: { tool: 'alembic_bootstrap' },
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('explicit Codex init creates a Ghost workspace marker without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', {})) as {
      success: boolean;
      data: {
        status: {
          autoInit: { markerExists: boolean; route: string };
          initialized: boolean;
          workspace: { dataRoot: string; ghost: boolean };
        };
      };
    };
    const marker = readCodexInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.status.initialized).toBe(true);
    expect(result.data.status.workspace.ghost).toBe(true);
    expect(result.data.status.autoInit).toMatchObject({
      markerExists: true,
      route: 'explicit',
    });
    expect(marker).toMatchObject({
      initializedBy: 'alembic_codex_init',
      route: 'explicit',
      projectRoot,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('explicit Codex init inherits an existing Standard registry mode', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, false);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', {})) as {
      data: {
        mode: string;
        status: {
          initialized: boolean;
          workspace: { dataRoot: string; ghost: boolean; mode: string };
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.mode).toBe('standard');
    expect(result.data.status.workspace).toMatchObject({
      dataRoot: projectRoot,
      ghost: false,
      mode: 'standard',
    });
    expect(ProjectRegistry.get(projectRoot)).toMatchObject({ id: entry.id, ghost: false });
    expect(fs.existsSync(path.join(projectRoot, '.asd', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(getGhostWorkspaceDir(entry.id), '.asd', 'config.json'))).toBe(
      false
    );
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('explicit Standard init fails closed on an existing Ghost registry mode', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', {
      standard: true,
    })) as {
      data: {
        errorCode: string;
        existingMode: string;
        needsUserInput: boolean;
        projectId: string;
        requestedMode: string;
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_WORKSPACE_MODE_CONFLICT',
      existingMode: 'ghost',
      needsUserInput: true,
      projectId: entry.id,
      requestedMode: 'standard',
    });
    expect(ProjectRegistry.get(projectRoot)).toMatchObject({ id: entry.id, ghost: true });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('removed AI config tool is not exposed as a Plugin configuration surface', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const removedToolName = ['alembic', 'codex', 'ai', 'config'].join('_');
    const result = (await server.handleToolCall(removedToolName, {
      mode: 'status',
    })) as {
      data: { errorCode: string };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.errorCode).toBe('CODEX_UNKNOWN_TOOL');
    expect(readCodexInitMarker(projectRoot)).toBeNull();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('init-on-demand initializes before reading Codex job status', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', { limit: 5 })) as {
      success: boolean;
      data: { jobs: unknown[] };
    };
    const marker = readCodexInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.jobs).toEqual([]);
    expect(marker).toMatchObject({
      initializedBy: 'codex-plugin-init-on-demand',
      requestedTool: 'alembic_codex_job',
      route: 'tool-call',
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('tool-call projectRoot override sends init to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', { projectRoot })) as {
      data: { status: { initialized: boolean; workspace: { ghost: boolean } } };
      success: boolean;
    };
    const marker = readCodexInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.status.workspace.ghost).toBe(true);
    expect(marker).toMatchObject({
      initializedBy: 'alembic_codex_init',
      projectRoot,
      route: 'explicit',
    });
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('status and diagnostics do not initialize a fresh workspace', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    await server.handleToolCall('alembic_codex_status', {});
    await server.handleToolCall('alembic_codex_diagnostics', {});

    expect(readCodexInitMarker(projectRoot)).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('manual init fails closed when only a plugin-cache fallback root is available', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    delete process.env.INIT_CWD;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic-codex',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;
    const supervisor = makeSupervisor(
      makeDaemonStatus(pluginRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_codex_init', {})) as {
      data: {
        errorCode: string;
        needsUserInput: boolean;
        projectRootResolution: { trust: string; userMessage: string };
        required: { projectRoot: string };
        requiredActions: string[];
      };
      message: string;
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot determine the target project directory');
    expect(result.data.errorCode).toBe('CODEX_PROJECT_ROOT_REJECTED');
    expect(result.data.needsUserInput).toBe(true);
    expect(result.data.required.projectRoot).toBe('absolute path');
    expect(result.data.requiredActions).toContain(
      'Provide the target project root as an absolute path.'
    );
    expect(result.data.projectRootResolution.trust).toBe('rejected');
    expect(result.data.projectRootResolution.userMessage).toContain(
      'project workflows cannot be used yet'
    );
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('unresolved Desktop project root exposes tools that require explicit projectRoot', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    delete process.env.INIT_CWD;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'alembic-codex',
      'alembic-codex',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const tools = getVisibleCodexTools('agent');
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const supervisor = makeSupervisor(
      makeDaemonStatus(pluginRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ supervisor });

    const result = (await server.handleToolCall('alembic_health', {})) as {
      data: { errorCode: string; needsUserInput: boolean; required: { projectRoot: string } };
      success: boolean;
    };

    expect(byName.has('alembic_task')).toBe(false);
    expect(byName.get('alembic_code_guard')?.inputSchema?.properties).toMatchObject({
      projectRoot: {
        type: 'string',
      },
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_PROJECT_ROOT_REJECTED',
      needsUserInput: true,
      required: { projectRoot: 'absolute path' },
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('diagnostics reports runtime version and artifact guidance without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_diagnostics', {})) as {
      success: boolean;
      data: {
        cleanup: { automaticOnUninstall: boolean; command: string };
        checks: {
          packagePin: boolean;
          pluginAssets: boolean;
          pluginMcpEntry: boolean;
          pluginSkills: boolean;
        };
        nextActions: string[];
        offlineFallback: { localPackage: string; registryPackageFallback: boolean };
        package: { pinnedSpecifier: string; version: string };
        plugin: {
          mcp: {
            entry: {
              mode: string;
              runtimeTarball: { exists: boolean };
              staleReasons: string[];
            };
            ok: boolean;
            packagePin: boolean;
            wrapper: {
              startupLockDiagnostics: {
                cacheParentCreation: boolean;
                releaseSignals: string[];
                runtimeTarballPreflight: boolean;
                scope: string;
                waitDiagnostics: boolean;
              };
            };
          };
          skills: { ok: boolean };
        };
        projectRuntime: {
          entryMode: { mode: string };
          fallbackIsolation: Array<{ effectiveIdentityAllowed: boolean; id: string }>;
          requiredServices: Array<{ service: string; source: string }>;
          sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: boolean };
        };
        primaryAction: { tool: string };
        summary: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.package.pinnedSpecifier).toBe(
      `@gxfn/alembic-codex-runtime@${getPackageVersion()}`
    );
    expect(result.data.checks).toMatchObject({
      packagePin: true,
      pluginAssets: true,
      pluginMcpEntry: true,
      pluginSkills: true,
    });
    expect(result.data.plugin.mcp).toMatchObject({ ok: true, packagePin: true });
    expect(result.data.plugin.mcp.entry).toMatchObject({
      mode: 'marketplace-shell',
      staleReasons: [],
    });
    expect(result.data.plugin.mcp.wrapper.path).toContain('alembic-codex-start.mjs');
    expect(result.data.plugin.skills.ok).toBe(true);
    expect(result.data.nextActions).toContain('Alembic Codex runtime checks passed.');
    expect(result.data.primaryAction.tool).toBe('alembic_codex_status');
    expect(result.data.summary).toContain('runtime checks passed');
    expect(result.data.offlineFallback).toMatchObject({
      localPackage: `@gxfn/alembic-codex-runtime@${getPackageVersion()}`,
      registryPackageFallback: false,
    });
    expect(result.data.cleanup).toMatchObject({
      automaticOnUninstall: false,
      command: 'alembic_codex_cleanup',
    });
    expect(result.data.projectRuntime).toMatchObject({
      entryMode: { mode: 'marketplace-shell' },
      sourcePolicy: {
        selectedOrActiveCanOverrideEffectiveIdentity: false,
      },
    });
    expect(result.data.projectRuntime.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'embedded-plugin-owned-runtime',
        }),
      ])
    );
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'project-identity', source: 'codex-current-project' }),
      ])
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('diagnostics reports explicit admin opt-in guidance when admin tier is requested', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_diagnostics', {})) as {
      success: boolean;
      data: {
        checks: { adminGate: boolean };
        issues: Array<{ code: string }>;
        nextActions: string[];
        ok: boolean;
        primaryAction: { tool: string };
        summary: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(false);
    expect(result.data.checks.adminGate).toBe(false);
    expect(result.data.issues.map((issue) => issue.code)).toContain('CODEX_ADMIN_OPT_IN_REQUIRED');
    expect(result.data.primaryAction.tool).toBe('alembic_codex_diagnostics');
    expect(result.data.summary).toContain('warning');
    expect(result.data.nextActions).toContain(
      'Set ALEMBIC_CODEX_ENABLE_ADMIN=1 only for explicit admin workflows.'
    );
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('dashboard handoff fails closed on host project mismatch without starting runtime', async () => {
    useTempAlembicHome();
    const hostProjectRoot = makeProjectRoot();
    const selectedProjectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(hostProjectRoot);
    ProjectRegistry.register(hostProjectRoot, false);
    const selectedEntry = ProjectRegistry.register(selectedProjectRoot, false);
    writeRuntimeControlState({
      activeProjectId: selectedEntry.id,
      activeProjectRoot: selectedProjectRoot,
      selectedAt: '2026-05-19T00:00:00.000Z',
      selectedProjectId: selectedEntry.id,
      selectedProjectRoot,
      updatedAt: '2026-05-19T00:00:00.000Z',
    });
    const supervisor = makeSupervisor(
      makeDaemonStatus(hostProjectRoot, {
        message: 'daemon is not started',
        pidAlive: false,
        ready: false,
        state: null,
        status: 'stopped',
      })
    );
    const server = new CodexMcpServer({ projectRoot: hostProjectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_dashboard', {})) as {
      data: {
        errorCode: string;
        hostProjectAlignment: { connectionState: string; handoffAllowed: boolean };
        needsUserInput: boolean;
        projectRuntime: {
          failureEnvelopes: Array<{ service: string | null }>;
          requiredServices: Array<{ required: boolean; service: string }>;
          sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: boolean };
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_HOST_PROJECT_MISMATCH',
      hostProjectAlignment: {
        connectionState: 'mismatch',
        handoffAllowed: false,
      },
      needsUserInput: true,
      projectRuntime: {
        sourcePolicy: {
          selectedOrActiveCanOverrideEffectiveIdentity: false,
        },
      },
    });
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ required: true, service: 'dashboard' })])
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('dashboard handoff fails closed without local Dashboard daemon or API URL fallback', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_dashboard', {})) as {
      data: {
        dashboardUrl?: string;
        errorCode: string;
        enhancementRoute: { selected: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.errorCode).toBe('CODEX_DASHBOARD_HANDOFF_UNAVAILABLE');
    expect(result.data.enhancementRoute.selected).not.toBe('local-alembic-daemon');
    expect(result.data.dashboardUrl).toBeUndefined();
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('core Alembic tools stay Plugin-owned and do not call the removed daemon MCP bridge', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        pidAlive: false,
        ready: false,
        state: null,
        status: 'stopped',
      })
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`Codex-facing tools must not call daemon MCP bridge: ${String(input)}`);
    });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_health', {})) as {
      data: {
        serviceBoundary: {
          executionPath: string;
          owner: string;
          residentServiceRequested: boolean;
          tool: string;
        };
        codexProjectScopeExecution?: unknown;
        projectRuntime: {
          fallbackIsolation: Array<{
            effectiveIdentityAllowed: boolean;
            id: string;
          }>;
          identity: { projectRoot: string };
          sourcePolicy: {
            effectiveIdentitySource: string;
            projectScopeSource: string;
          };
        };
        status: string;
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.status).toBeTruthy();
    expect(result.data.serviceBoundary).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      residentServiceRequested: false,
      tool: 'alembic_health',
    });
    expect(result.data.projectRuntime).toMatchObject({
      identity: { projectRoot },
      sourcePolicy: {
        effectiveIdentitySource: 'codex-current-project',
        projectScopeSource: 'single-folder-baseline',
      },
    });
    expect(result.data.projectRuntime.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'embedded-plugin-owned-runtime',
        }),
      ])
    );
    expect(result.data.codexProjectScopeExecution).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('alembic_task prime direct call is retired before daemon bridge execution', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('alembic_task prime must not call the daemon MCP bridge');
    });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_task', {
      operation: 'prime',
      userQuery: 'Use Alembic knowledge before editing',
      language: 'typescript',
    })) as {
      error: { code: string };
      ok: boolean;
      status: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('retired');
    expect(result.error.code).toBe('CODEX_TOOL_RETIRED');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('blocks project-knowledge tools when no usable knowledge base exists', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_health', {})) as {
      data: { errorCode?: string };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.errorCode).toBe('CODEX_ALEMBIC_KNOWLEDGE_REQUIRED');
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('blocks legacy guard no-scope review and allows explicit file scope', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    makeDirtyGitRepo(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const noScope = (await server.handleToolCall('alembic_guard', {})) as {
      data: { reasonCode?: string };
      errorCode?: string;
      success: boolean;
    };
    const explicitScope = (await server.handleToolCall('alembic_guard', {
      files: ['index.ts'],
    })) as {
      data: { fileSource?: string; summary?: { filesChecked?: number } };
      success: boolean;
    };

    expect(noScope.success).toBe(false);
    expect(noScope).toMatchObject({
      errorCode: 'GUARD_SCOPE_REQUIRED',
      data: { reasonCode: 'missing-guard-scope' },
    });
    expect(explicitScope.success).toBe(true);
    expect(explicitScope.data).toMatchObject({
      fileSource: 'explicit',
      summary: { filesChecked: 1 },
    });
  });

  test('blocks retired task close before Plugin evidence/evolution execution', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    makeDirtyGitRepo(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        ready: false,
        status: 'stopped',
        state: null,
      })
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`alembic_task close must stay Plugin-owned: ${String(input)}`);
    });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_task', {
      operation: 'close',
      id: 'acceptance-smoke',
      reason: 'dirty diff acceptance smoke',
      changedFiles: ['index.ts'],
    })) as {
      error: { code: string };
      ok: boolean;
      status: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('retired');
    expect(result.error.code).toBe('CODEX_TOOL_RETIRED');
    expect(JSON.stringify(result)).not.toContain('guardDecision');
    expect(JSON.stringify(result)).not.toContain('opportunisticEvolution');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('blocks retired task close with unrelated dirty diff before Guard/evolution checks', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    makeDirtyGitRepo(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        ready: false,
        status: 'stopped',
        state: null,
      })
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`alembic_task close must stay Plugin-owned: ${String(input)}`);
    });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_task', {
      operation: 'close',
      id: 'acceptance-smoke',
      reason: 'close without task-scoped files',
    })) as {
      error: { code: string };
      ok: boolean;
      status: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('retired');
    expect(result.error.code).toBe('CODEX_TOOL_RETIRED');
    expect(JSON.stringify(result)).not.toContain('guardDecision');
    expect(JSON.stringify(result)).not.toContain('opportunisticEvolution');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex bootstrap job follows the resident or embedded job boundary', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { jobId: 'bootstrap_test', job: { id: 'bootstrap_test' } },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } }
        )
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = await server.handleToolCall('alembic_codex_bootstrap', { maxFiles: 25 });

    expect(result).toMatchObject({ success: true, data: { jobId: 'bootstrap_test' } });
    expect(supervisor.ensure).toHaveBeenCalledWith({ projectRoot, waitUntilReadyMs: 3000 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('Codex host-agent bootstrap runs in the Plugin without the daemon MCP bridge', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const answer = 42;\n');
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(
        `Codex host-agent bootstrap must not call daemon MCP bridge: ${String(input)}`
      );
    });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_bootstrap', {})) as {
      data?: {
        bootstrapState?: {
          runtime?: { daemonRequiredForBootstrap?: boolean; owner?: string };
          singleWriterLease?: { publicStatus?: string; status?: string };
          sourceGraph?: { firstTool?: string };
          status?: string;
        };
        currentDomainSop?: {
          domainId?: string;
          recipeGuidanceFloor?: {
            candidateCounts?: { minimumPerDimension?: number; targetPerDimension?: number };
          };
          toolSequence?: string[];
        };
        domainQueue?: Array<{ domainId?: string }>;
        dimensions?: unknown;
        executionPlan?: unknown;
        gates?: Record<string, unknown>;
        sopPack?: {
          knowledgeResetContract?: { backupByDefault?: boolean; scopes?: string[] };
          recipeAuthoringRubric?: Record<string, unknown>;
          resumePrompt?: Record<string, unknown>;
          scopeBrief?: Record<string, unknown>;
          stopConditions?: string[];
          toolCapabilityMatrix?: Array<{ name?: string }>;
        };
        serviceBoundary?: {
          executionPath: string;
          owner: string;
          tool: string;
        };
        toolCapabilities?: {
          canonicalSourceGraph?: Array<{ name?: string }>;
          removedOrBlocked?: Array<{ name?: string; replacementTools?: string[] }>;
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data?.executionPlan).toBeTruthy();
    expect(result.data?.dimensions).toBeTruthy();
    expect(result.data?.serviceBoundary).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      tool: 'alembic_bootstrap',
    });
    expect(result.data?.bootstrapState).toMatchObject({
      runtime: {
        daemonRequiredForBootstrap: false,
        owner: 'alembic-plugin',
      },
      sourceGraph: {
        firstTool: 'alembic_source_graph_status',
      },
      singleWriterLease: {
        publicStatus: 'no_active_bootstrap',
        status: 'available',
      },
      status: 'bootstrap_ready',
    });
    expect(result.data?.domainQueue?.[0]).toMatchObject({
      domainId: 'D1-runtime-entrypoints',
    });
    expect(result.data?.currentDomainSop).toMatchObject({
      domainId: 'D1-runtime-entrypoints',
      toolSequence: expect.arrayContaining(['alembic_source_graph_status', 'alembic_code_explore']),
      recipeGuidanceFloor: expect.objectContaining({
        candidateCounts: expect.objectContaining({
          minimumPerDimension: 3,
          targetPerDimension: 5,
        }),
      }),
    });
    expect(result.data?.toolCapabilities?.canonicalSourceGraph?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'alembic_source_graph_status',
        'alembic_code_explore',
        'alembic_symbol_search',
        'alembic_validation_plan',
      ])
    );
    expect(result.data?.toolCapabilities?.removedOrBlocked?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['alembic_call_context', 'alembic_affected_tests'])
    );
    expect(JSON.stringify(result.data?.currentDomainSop)).not.toContain('alembic_call_context');
    expect(JSON.stringify(result.data?.currentDomainSop)).not.toContain('alembic_affected_tests');
    expect(JSON.stringify(result.data?.sopPack)).not.toContain('alembic_call_context');
    expect(JSON.stringify(result.data?.sopPack)).not.toContain('alembic_affected_tests');
    expect(result.data?.sopPack).toMatchObject({
      scopeBrief: expect.any(Object),
      recipeAuthoringRubric: expect.objectContaining({
        futureActionability: expect.any(String),
      }),
      knowledgeResetContract: expect.objectContaining({
        backupByDefault: true,
        scopes: expect.arrayContaining(['host-agent bootstrap session state']),
      }),
      resumePrompt: expect.objectContaining({
        bootstrapSessionRefField: 'bootstrapState.session.id',
      }),
      stopConditions: expect.arrayContaining(['another bootstrap writer holds the lease']),
    });
    expect(result.data?.sopPack?.toolCapabilityMatrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alembic_source_graph_status',
        }),
      ])
    );
    expect(result.data?.gates).toHaveProperty('runtimeTransport');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('projectRoot override can switch Plugin-owned bootstrap between projects', async () => {
    useTempAlembicHome();
    const firstProjectRoot = makeProjectRoot();
    const secondProjectRoot = makeProjectRoot();
    makeInitializedWorkspace(firstProjectRoot);
    makeInitializedWorkspace(secondProjectRoot);
    fs.writeFileSync(path.join(firstProjectRoot, 'index.ts'), 'export const first = 1;\n');
    fs.writeFileSync(path.join(secondProjectRoot, 'index.ts'), 'export const second = 2;\n');
    const supervisor = makeSupervisor(makeDaemonStatus(firstProjectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(
        `Codex host-agent bootstrap must not call daemon MCP bridge: ${String(input)}`
      );
    });
    const server = new CodexMcpServer({ supervisor });

    const first = (await server.handleToolCall('alembic_bootstrap', {
      projectRoot: firstProjectRoot,
    })) as { message?: string; success: boolean };
    const second = (await server.handleToolCall('alembic_bootstrap', {
      projectRoot: secondProjectRoot,
    })) as { message?: string; success: boolean };

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.message || '').not.toContain('不允许在同一进程中切换项目');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex bootstrap job ensures runtime and posts through the resident service client', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { jobId: 'bootstrap_test', job: { id: 'bootstrap_test' } },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } }
        )
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = await server.handleToolCall('alembic_codex_bootstrap', { maxFiles: 25 });
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, data: { jobId: 'bootstrap_test' } });
    expect(supervisor.ensure).toHaveBeenCalledWith({ projectRoot, waitUntilReadyMs: 3000 });
    expect(String(url)).toBe('http://127.0.0.1:39127/api/v1/jobs/bootstrap');
    expect(headers['x-alembic-daemon-token']).toBe('test-token');
    expect(body).toMatchObject({
      jobContext: {
        actor: { role: 'external_agent' },
        channelId: 'codex',
        client: 'codex-plugin',
        createdByTool: 'alembic_codex_bootstrap',
      },
      maxFiles: 25,
    });
    expect(typeof (body.jobContext as { sessionId?: unknown }).sessionId).toBe('string');
  });

  test('blocks direct admin tool calls without Codex admin opt-in', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_knowledge_lifecycle', {
      operation: 'approve',
    })) as {
      data: { errorCode: string; needsUserInput: boolean };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      needsUserInput: true,
    });
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex job status reads local JobStore without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(
      makeDaemonStatus(projectRoot, {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
      })
    );
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'rescan', request: { reason: 'codex' }, source: 'codex' });
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', { jobId: job.id })) as {
      success: boolean;
      data: {
        job: { id: string };
        jobRoute: {
          fallback: boolean;
          fallbackIsolation: { effectiveIdentityAllowed: boolean; id: string };
          selected: string;
        };
        projectRuntime: { blockedFallbacks: string[]; fallbackIsolation: Array<{ id: string }> };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.job.id).toBe(job.id);
    expect(result.data.jobRoute).toMatchObject({
      fallback: true,
      fallbackIsolation: {
        effectiveIdentityAllowed: false,
        id: 'local-jobstore',
      },
      selected: 'embedded-host-agent-recoverable',
    });
    expect(result.data.projectRuntime.blockedFallbacks).toContain(
      'local-jobstore-default-effective-identity'
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
    expect(supervisor.ensure).not.toHaveBeenCalled();
  });

  test('Codex job status uses resident service client when runtime is already running', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { job: { id: 'bootstrap_live', progress: { percent: 60 } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', {
      jobId: 'bootstrap_live',
    })) as {
      success: boolean;
      data: {
        job: { progress: { percent: number } };
        projectRuntime: { requiredServices: Array<{ service: string }> };
      };
    };
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;

    expect(result.success).toBe(true);
    expect(result.data.job.progress.percent).toBe(60);
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ service: 'jobs' })])
    );
    expect(String(url)).toBe('http://127.0.0.1:39127/api/v1/jobs/bootstrap_live');
    expect(headers['x-alembic-daemon-token']).toBe('test-token');
    expect(supervisor.ensure).not.toHaveBeenCalled();
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('Codex job status falls back to local JobStore when daemon job API is unavailable', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'bootstrap', request: { maxFiles: 25 }, source: 'codex' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection closed'));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_job', { jobId: job.id })) as {
      success: boolean;
      data: {
        job: { id: string };
        jobRoute: {
          fallback: boolean;
          fallbackIsolation: { allowedUse: string; effectiveIdentityAllowed: boolean; id: string };
          reason: string;
          selected: string;
        };
        projectRuntime: { blockedFallbacks: string[]; fallbackIsolation: Array<{ id: string }> };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.job.id).toBe(job.id);
    expect(result.data.jobRoute).toMatchObject({
      fallback: true,
      fallbackIsolation: {
        allowedUse: 'embedded-host-agent-recovery',
        effectiveIdentityAllowed: false,
        id: 'local-jobstore',
      },
      reason: 'resident-job-api-unavailable-or-not-ready',
      selected: 'embedded-host-agent-recoverable',
    });
    expect(result.data.projectRuntime.blockedFallbacks).toContain(
      'local-jobstore-default-effective-identity'
    );
    expect(supervisor.ensure).not.toHaveBeenCalled();
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('cleanup defaults to dry-run and does not stop daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const supervisor = makeSupervisor(makeDaemonStatus(projectRoot));
    const server = new CodexMcpServer({ projectRoot, supervisor });

    const result = (await server.handleToolCall('alembic_codex_cleanup', {})) as {
      success: boolean;
      data: {
        dryRun: boolean;
        projectRuntime: {
          identity: { projectRoot: string; runtimeDir: string };
          requiredServices: Array<{ required: boolean; service: string }>;
        };
        targets: { runtimeDir: string; statePath: string };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.dryRun).toBe(true);
    expect(result.data.targets.runtimeDir).toContain('.asd');
    expect(result.data.targets.statePath).toBe(
      path.join(result.data.projectRuntime.identity.runtimeDir, 'daemon.json')
    );
    expect(result.data.projectRuntime.identity.projectRoot).toBe(projectRoot);
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ required: true, service: 'daemon' })])
    );
    expect(supervisor.stop).not.toHaveBeenCalled();
  });

  test('package and plugin config point Codex to the packaged MCP runtime tarball', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    const pluginMcp = JSON.parse(
      fs.readFileSync(path.resolve('plugins/alembic-codex/.mcp.json'), 'utf8')
    ) as {
      mcpServers: {
        alembic: { args: string[]; command: string; cwd: string; env: Record<string, string> };
      };
    };
    const pluginJson = JSON.parse(
      fs.readFileSync(path.resolve('plugins/alembic-codex/.codex-plugin/plugin.json'), 'utf8')
    ) as { interface: { defaultPrompt: string[]; screenshots: string[] } };

    expect(packageJson.bin['alembic-codex-mcp']).toBe('dist/bin/codex-mcp.js');
    expect(packageJson.scripts['dev:codex-plugin:reload']).toBe(
      'node scripts/dev-reload-codex-plugin.mjs'
    );
    expect(packageJson.scripts['dev:codex-plugin:refresh']).toBe(
      'node scripts/dev-reload-codex-plugin.mjs --legacy-refresh'
    );
    expect(packageJson.scripts['verify:codex-plugin']).toBe('node scripts/verify-codex-plugin.mjs');
    expect(pluginMcp.mcpServers.alembic.command).toBe('node');
    expect(pluginMcp.mcpServers.alembic.args).toContain('./bin/alembic-codex-start.mjs');
    expect(
      fs
        .readFileSync(path.resolve('plugins/alembic-codex/bin/alembic-codex-start.mjs'), 'utf8')
        .includes(`@gxfn/alembic-codex-runtime@${getPackageVersion()}`)
    ).toBe(true);
    expect(pluginMcp.mcpServers.alembic.cwd).toBe('.');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_RUNTIME_MODE).toBe('plugin');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_PLUGIN_HOST).toBe('codex');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_MCP_MODE).toBe('1');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_MCP_MODE).toBe('1');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_PLUGIN_ROOT).toBe('.');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_ENABLE_ADMIN).toBe('0');
    expect(pluginMcp.mcpServers.alembic.env.npm_config_cache).toBeUndefined();
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Guide me through Alembic Codex first-minute setup for this project'
    );
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Initialize Alembic Codex in Ghost mode for this project'
    );
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Run Alembic Codex diagnostics for this project'
    );
    expect(pluginJson.interface.screenshots).toContain('./assets/alembic-codex-status.svg');
    expect(fs.existsSync(path.resolve('plugins/alembic-codex/skills/alembic/SKILL.md'))).toBe(true);
  });
});
