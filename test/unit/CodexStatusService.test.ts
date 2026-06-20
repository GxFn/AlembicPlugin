import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAlembicResidentServiceStatus,
  createProjectRuntimeControlState,
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  resolveDaemonPaths,
} from '@alembic/core/daemon';
import { getProjectRegistryDir, ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DaemonStatus } from '../../lib/runtime/daemon-status.js';
import { buildStatus } from '../../lib/runtime/index.js';
import { buildPostInitActions } from '../../lib/runtime/status/StatusService.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-status-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-status-project-'));
}

function makeInitializedWorkspace(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
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
        createdByTool: 'alembic_bootstrap',
        createdAt: '2026-06-12T08:00:00.000Z',
        updatedAt: '2026-06-12T08:01:00.000Z',
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

function makeDaemonState(projectRoot: string): DaemonState {
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
    token: 'secret-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-08T00:00:00.000Z',
    lastReadyAt: '2026-05-08T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
  };
}

function makeDaemonStatus(projectRoot: string, ready = false): DaemonStatus {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    status: ready ? 'ready' : 'stopped',
    ready,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    lockDir: paths.lockDir,
    logPath: paths.logPath,
    state: ready ? makeDaemonState(projectRoot) : null,
    pidAlive: ready,
    health: null,
  };
}

function makeProjectScopeHealth(projectRoot: string): Record<string, unknown> {
  const paths = resolveDaemonPaths(projectRoot);
  const projectScope = {
    contractVersion: 1,
    controlRoot: path.dirname(projectRoot),
    controlRootIncludedInFolders: false,
    currentFolderId: 'folder-plugin',
    currentFolderPath: projectRoot,
    dataRoot: paths.dataRoot,
    dataRootSource: 'ghost-registry',
    displayName: 'Alembic Workspace',
    folderCount: 2,
    folders: [
      {
        displayName: 'Plugin',
        folderId: 'folder-plugin',
        path: projectRoot,
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
  return {
    success: true,
    data: {
      residentService: createAlembicResidentServiceStatus({
        apiBaseUrl: 'http://127.0.0.1:39127',
        owner: 'alembic',
        route: 'local-alembic-daemon',
        serviceScope: {
          diagnosticPaths: {
            controlRoot: projectScope.controlRoot,
            databasePath: paths.databasePath,
            dataRoot: paths.dataRoot,
            projectRoot,
            runtimeDir: paths.runtimeDir,
            statePath: paths.statePath,
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
      projectRuntimeSourceOfTruth: {
        contractVersion: 1,
        diagnostics: [],
        failure: null,
        operation: {
          explicitRuntimeActionRequired: true,
          implicitRuntimeActionAllowed: false,
          mode: 'diagnostics-read',
          readOnly: true,
        },
        owner: 'alembic',
        readiness: {
          ready: true,
          reasonCode: 'ready',
          stale: false,
          status: 'ready',
        },
        requiredService: {
          kind: 'local-alembic-daemon',
          owner: 'alembic',
          route: 'local-alembic-daemon',
        },
        route: 'daemon-health',
        runtimeControl: {
          activeMatchesCurrentProject: true,
          activeProject: {
            projectId: projectScope.projectId,
            projectRoot,
            projectScopeId: projectScope.projectScopeId,
            ready: true,
            status: 'ready',
          },
          activeReadyProject: {
            projectId: projectScope.projectId,
            projectRoot,
            projectScopeId: projectScope.projectScopeId,
            ready: true,
            status: 'ready',
          },
          activeStateTrusted: true,
          diagnostics: [],
          projects: { missing: 0, ready: 1, stale: 0, total: 1, unavailable: 0 },
          readOnly: true,
          selectedMatchesCurrentProject: true,
          selectedProject: {
            projectId: projectScope.projectId,
            projectRoot,
            projectScopeId: projectScope.projectScopeId,
            ready: true,
            status: 'ready',
          },
          state: {
            activeProjectId: projectScope.projectId,
            activeProjectRoot: projectRoot,
            schemaVersion: 1,
            selectedAt: '2026-06-05T08:00:00.000Z',
            selectedProjectId: projectScope.projectId,
            selectedProjectRoot: projectRoot,
            updatedAt: '2026-06-05T08:00:00.000Z',
          },
          stateCleanup: {
            activeState: {
              cleaned: false,
              message: null,
              previousProjectId: projectScope.projectId,
              previousProjectRoot: projectRoot,
              reasonCode: null,
            },
          },
          statePath: path.join(getProjectRegistryDir(), 'runtime-control.json'),
        },
        targetProject: {
          projectId: projectScope.projectId,
          projectRoot,
          projectScopeId: projectScope.projectScopeId,
          ready: true,
          status: 'ready',
        },
        writePolicy: {
          activeStateWriteAllowed: false,
          daemonLifecycleWriteAllowed: false,
          jobStoreWriteAllowed: false,
          projectScopeRegistryWriteAllowed: false,
          selectedStateWriteAllowed: false,
          writeOwner: 'alembic',
        },
      },
    },
  };
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Codex status service', () => {
  test('recommends agent-facing prime after init instead of legacy task operations', () => {
    const actions = buildPostInitActions({
      hasKnowledge: true,
      initialized: true,
      recipeCount: 1,
      skillCount: 1,
      status: 'knowledge_ready',
      usable: true,
    });

    expect(actions[0]).toMatchObject({
      arguments: { inputSource: 'host-declared-intent' },
      label: 'Prime agent context',
      tool: 'alembic_prime',
    });
    expect(JSON.stringify(actions)).not.toContain('alembic_task');
    expect(JSON.stringify(actions)).not.toContain('operation=prime');
  });

  test('builds the shared needs-init status without starting the daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, false)),
    };

    const status = await buildStatus(projectRoot, { supervisor });
    const onboarding = status.onboarding as { primaryAction: { tool: string }; state: string };

    expect(status).toMatchObject({
      initialized: false,
      project: {
        root: projectRoot,
        dataRootSource: 'project-root',
        trusted: true,
      },
      workspace: {
        dataRootSource: 'project-root',
        ghost: false,
        mode: 'standard',
      },
    });
    expect(onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { tool: 'alembic_init' },
    });
    expect(status.nextActions).toContain('Initialize Ghost workspace: call alembic_init');
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('reports registered Standard projects as attach targets instead of Ghost defaults', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    ProjectRegistry.register(projectRoot, false);
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, false)),
    };

    const status = await buildStatus(projectRoot, { supervisor });
    const onboarding = status.onboarding as {
      nextActions: Array<{ label: string; tool: string }>;
      notes: string[];
      primaryAction: { label: string; tool: string };
      state: string;
    };

    expect(status.workspace).toMatchObject({
      ghost: false,
      mode: 'standard',
    });
    expect(onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { label: 'Attach Standard workspace', tool: 'alembic_init' },
    });
    expect(status.nextActions).toContain('Attach Standard workspace: call alembic_init');
    expect(status.nextActions).not.toContain('Initialize Ghost workspace: call alembic_init');
    expect(onboarding.notes).toContain(
      'This project is already registered as Standard; Codex init inherits that mode unless the user explicitly migrates it.'
    );
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('reports initialized empty knowledge and summarizes daemon state without token leakage', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, true)),
    };

    const status = await buildStatus(projectRoot, { supervisor });
    const serialized = JSON.stringify(status);
    const onboarding = status.onboarding as {
      bootstrapState?: { singleWriterLease?: { status?: string }; status?: string };
      currentDomainSop?: {
        domainId?: string;
        languageProfile?: Record<string, unknown>;
        recipeGuidanceFloor?: {
          candidateCounts?: { minimumPerDimension?: number; targetPerDimension?: number };
        };
        toolSequence?: string[];
      };
      domainQueue?: Array<{ domainId?: string }>;
      gates?: Record<string, unknown>;
      initialToolBriefing?: {
        agentDecisionChecklist?: Array<Record<string, unknown>>;
        blockedConclusionsField?: string;
      };
      repairState?: { status?: string };
      sopPack?: {
        dimensionCompletionContract?: {
          firstCallExample?: Record<string, unknown>;
          requiredFields?: string[];
          sessionField?: string;
        };
        knowledgeResetContract?: { backupByDefault?: boolean; scopes?: string[] };
        recipeAuthoringRubric?: Record<string, unknown>;
        resumePrompt?: Record<string, unknown>;
        scopeBrief?: Record<string, unknown>;
        stopConditions?: string[];
        submitKnowledgeContract?: {
          exactFields?: string[];
          fieldFloors?: Record<string, unknown>;
          purpose?: string;
          sourceRefCardinality?: Record<string, unknown>;
        };
        toolCapabilityMatrix?: Array<{ name?: string; outputTrustLevel?: string }>;
      };
      toolCapabilities?: {
        canonicalSourceGraph?: Array<{ name?: string }>;
        removedOrBlocked?: Array<{ name?: string }>;
      };
    };

    expect(status).toMatchObject({
      initialized: true,
      knowledge: {
        initialized: true,
        usable: false,
        status: 'initialized_empty',
      },
      daemon: {
        ready: true,
      },
    });
    expect(status.nextActions).toContain(
      'Start Codex host-agent bootstrap: call alembic_bootstrap'
    );
    expect(onboarding).toMatchObject({
      state: 'needs_bootstrap',
      primaryAction: { tool: 'alembic_bootstrap' },
    });
    expect(serialized).not.toContain('secret-token');
  });

  test('reports bootstrap_in_progress with single-writer lease visibility', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    writeRunningBootstrapJob(projectRoot);
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, true)),
    };

    const status = await buildStatus(projectRoot, { supervisor });
    const onboarding = status.onboarding as {
      primaryAction?: { tool?: string };
      state?: string;
    };

    expect(status.knowledge.status).toBe('bootstrap_running');
    expect(onboarding).toMatchObject({
      state: 'bootstrap_in_progress',
      primaryAction: { tool: 'alembic_status' },
    });
  });

  test('exposes resident ProjectScope identity in status and diagnostics', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const supervisor = {
      status: vi.fn(async () => ({
        ...makeDaemonStatus(projectRoot, true),
        health: makeProjectScopeHealth(projectRoot),
      })),
    };

    const status = await buildStatus(projectRoot, { supervisor });

    expect(status.project).toMatchObject({
      hostConnectionState: 'connected',
      handoffAllowed: true,
      root: projectRoot,
    });
  });

  test('treats an active controlRoot resident as aligned for a bound source folder', async () => {
    useTempAlembicHome();
    const controlRoot = makeProjectRoot();
    const boundFolder = path.join(controlRoot, 'AlembicCore');
    fs.mkdirSync(boundFolder, { recursive: true });
    makeInitializedWorkspace(boundFolder);
    writeRuntimeControlState({
      activeProjectId: 'project-workspace',
      activeProjectRoot: controlRoot,
      selectedAt: '2026-05-25T00:00:00.000Z',
      selectedProjectId: 'project-workspace',
      selectedProjectRoot: controlRoot,
      updatedAt: '2026-05-25T00:00:00.000Z',
    });
    const activePaths = resolveDaemonPaths(controlRoot);
    fs.mkdirSync(activePaths.runtimeDir, { recursive: true });
    fs.writeFileSync(activePaths.statePath, `${JSON.stringify(makeDaemonState(controlRoot))}\n`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string'
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);
        if (url.pathname === '/api/v1/daemon/health') {
          return new Response(JSON.stringify(makeProjectScopeHealth(boundFolder)), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        }
        if (url.pathname === '/api/v1/project-scope/resolve-folder') {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                capability: { available: true },
                summary: (
                  makeProjectScopeHealth(boundFolder).data as {
                    residentService: {
                      serviceScope: { projectIdentity: { projectScope: unknown } };
                    };
                  }
                ).residentService.serviceScope.projectIdentity.projectScope,
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 }
          );
        }
        throw new Error(`Unexpected URL: ${url.pathname}`);
      }) as unknown as typeof fetch
    );
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(boundFolder, false)),
    };

    const status = await buildStatus(boundFolder, { supervisor });

    expect(status.project).toMatchObject({
      hostConnectionState: 'connected',
      handoffAllowed: true,
      root: boundFolder,
    });
  });

  test('reports Alembic selected or active project mismatch without starting the daemon', async () => {
    useTempAlembicHome();
    const hostProjectRoot = makeProjectRoot();
    const selectedProjectRoot = makeProjectRoot();
    makeInitializedWorkspace(hostProjectRoot);
    fs.writeFileSync(
      path.join(hostProjectRoot, 'Alembic', 'recipes', 'host-project.md'),
      '# Host Project\n'
    );
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
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(hostProjectRoot, false)),
    };

    const status = await buildStatus(hostProjectRoot, { supervisor });

    expect(status.project).toMatchObject({
      hostConnectionState: 'mismatch',
      handoffAllowed: false,
    });
    expect(status.onboarding).toMatchObject({
      state: 'project_handoff_mismatch',
      primaryAction: { startsDaemon: false, tool: 'alembic_status' },
    });
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('keeps local host-agent bootstrap available when only the selected project differs', async () => {
    useTempAlembicHome();
    const hostProjectRoot = makeProjectRoot();
    const selectedProjectRoot = makeProjectRoot();
    makeInitializedWorkspace(hostProjectRoot);
    ProjectRegistry.register(hostProjectRoot, false);
    const selectedEntry = ProjectRegistry.register(selectedProjectRoot, false);
    writeRuntimeControlState({
      selectedAt: '2026-05-19T00:00:00.000Z',
      selectedProjectId: selectedEntry.id,
      selectedProjectRoot,
      updatedAt: '2026-05-19T00:00:00.000Z',
    });
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(hostProjectRoot, false)),
    };

    const status = await buildStatus(hostProjectRoot, { supervisor });

    expect(status.project).toMatchObject({
      hostConnectionState: 'mismatch',
      handoffAllowed: false,
    });
    expect(status.onboarding).toMatchObject({
      state: 'needs_bootstrap',
      primaryAction: { tool: 'alembic_bootstrap' },
    });
  });
});
