import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectRuntimeControlState,
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  resolveDaemonPaths,
} from '@alembic/core/daemon';
import { getProjectRegistryDir, ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildCodexStatus } from '../../lib/codex/index.js';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
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

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.restoreAllMocks();
});

describe('Codex status service', () => {
  test('builds the shared needs-init status without starting the daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, false)),
    };

    const status = await buildCodexStatus(projectRoot, { supervisor });
    const onboarding = status.onboarding as { primaryAction: { tool: string }; state: string };

    expect(status).toMatchObject({
      initialized: false,
      channel: { id: 'codex', expectedId: 'codex' },
      profile: 'codex-plugin',
      projectRoot,
    });
    expect(onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { tool: 'alembic_codex_init' },
    });
    expect(status.policy.state).toBe('needs_init');
    expect(status.enhancementRoute).toMatchObject({
      hostAgentRoute: {
        requiresAiProvider: false,
        source: 'host-agent',
      },
      internalAiProvider: {
        available: false,
        configSource: null,
      },
    });
    expect(status.moduleBoundary.dashboard).toMatchObject({
      artifactPath: null,
      deletionCompletedThisWave: true,
      sourceOwner: 'Alembic/AlembicDashboard',
    });
    expect(status.moduleBoundary.adapters.embeddedRuntime.role).toContain(
      'not the long-term Alembic daemon'
    );
    expect(status.diagnostics).toMatchObject({
      moduleBoundary: {
        dashboard: {
          artifactPath: null,
          sourceOwner: 'Alembic/AlembicDashboard',
        },
      },
    });
    expect(status.nextActions).toContain('Initialize Ghost workspace: call alembic_codex_init');
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('reports registered Standard projects as attach targets instead of Ghost defaults', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    ProjectRegistry.register(projectRoot, false);
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, false)),
    };

    const status = await buildCodexStatus(projectRoot, { supervisor });
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
      primaryAction: { label: 'Attach Standard workspace', tool: 'alembic_codex_init' },
    });
    expect(status.nextActions).toContain('Attach Standard workspace: call alembic_codex_init');
    expect(status.nextActions).not.toContain('Initialize Ghost workspace: call alembic_codex_init');
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

    const status = await buildCodexStatus(projectRoot, { supervisor });
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({
      initialized: true,
      knowledge: {
        initialized: true,
        usable: false,
        status: 'initialized_empty',
      },
      daemon: {
        ready: true,
        state: {
          url: 'http://127.0.0.1:39127',
          dashboardUrl: 'http://127.0.0.1:39127',
        },
      },
    });
    expect(status.enhancementRoute.internalAiProvider).toMatchObject({
      available: false,
      configSource: null,
      provider: null,
    });
    expect(status.policy.state).toBe('needs_bootstrap');
    expect(status.nextActions).toContain(
      'Start Codex host-agent bootstrap: call alembic_bootstrap'
    );
    expect(serialized).not.toContain('secret-token');
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

    const status = await buildCodexStatus(hostProjectRoot, { supervisor });

    expect(status.hostProjectAlignment).toMatchObject({
      connectionState: 'mismatch',
      handoffAllowed: false,
      handoffMismatch: {
        reason: 'selected-project-differs',
      },
      selectedProject: {
        projectId: selectedEntry.id,
      },
    });
    expect(status.onboarding).toMatchObject({
      state: 'project_handoff_mismatch',
      primaryAction: { startsDaemon: false, tool: 'alembic_codex_status' },
    });
    expect(status.diagnostics).toMatchObject({
      hostProjectAlignment: {
        connectionState: 'mismatch',
      },
    });
    expect(status.moduleBoundary.adapters.hostProjectAlignment).toMatchObject({
      connectionState: 'mismatch',
      handoffAllowed: false,
      switchOwnership: 'Alembic/Dashboard',
    });
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });
});
