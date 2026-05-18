import { describe, expect, it } from 'vitest';
import {
  buildCodexEnhancementRouteChoice,
  summarizeEnhancementDaemon,
} from '../../lib/codex/EnhancementRoute.js';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';

const LOCAL_INSTALL_UNAVAILABLE = {
  available: false,
  command: 'alembic',
  error: 'not found',
  version: null,
};

function makeDaemonStatus(
  overrides: Partial<DaemonStatus> = {},
  healthData: Record<string, unknown> | null = null
): DaemonStatus {
  return {
    status: 'ready',
    ready: true,
    projectRoot: '/tmp/project',
    dataRoot: '/tmp/project/.asd',
    projectId: 'project-id',
    statePath: '/tmp/project/.asd/runtime/daemon.json',
    pidPath: '/tmp/project/.asd/runtime/daemon.pid',
    lockDir: '/tmp/project/.asd/runtime/daemon.lock',
    logPath: '/tmp/project/.asd/runtime/daemon.log',
    state: {
      schemaVersion: 1,
      projectRoot: '/tmp/project',
      dataRoot: '/tmp/project/.asd',
      projectId: 'project-id',
      pid: 123,
      host: '127.0.0.1',
      port: 39127,
      url: 'http://127.0.0.1:39127',
      dashboardUrl: 'http://127.0.0.1:39127',
      token: 'secret',
      version: '0.1.2',
      mode: 'daemon',
      startedAt: '2026-05-18T00:00:00.000Z',
      lastReadyAt: '2026-05-18T00:00:01.000Z',
      databasePath: '/tmp/project/.asd/alembic.db',
      schemaMigrationVersion: '001',
    },
    pidAlive: true,
    health: healthData ? { success: true, data: healthData } : null,
    ...overrides,
  };
}

describe('Codex enhancement route resolver', () => {
  it('selects a local Alembic daemon when the daemon advertises enhancement capabilities', () => {
    const daemonStatus = makeDaemonStatus(
      {},
      {
        version: '0.9.0',
        dashboardUrl: 'http://127.0.0.1:39127',
        enhancement: {
          apiVersion: 'v1',
          packageName: 'alembic-ai',
          route: 'local-alembic',
          version: '0.9.0',
        },
        capabilities: {
          api: { available: true },
          dashboard: { available: true, url: 'http://127.0.0.1:39127' },
          fileMonitor: { available: true, mode: 'daemon-git-worktree' },
          internalAi: {
            available: true,
            configSource: 'workspace-settings',
            model: 'deepseek-chat',
            provider: 'deepseek',
          },
          jobs: { available: true, kinds: ['bootstrap', 'rescan'] },
        },
      }
    );

    const route = buildCodexEnhancementRouteChoice({
      daemonStatus,
      localInstall: LOCAL_INSTALL_UNAVAILABLE,
      requirement: 'jobs',
    });

    expect(route.selected).toBe('local-alembic-daemon');
    expect(route.hostAgentRoute).toMatchObject({
      requiresAiProvider: false,
      source: 'host-agent',
    });
    expect(route.internalAiProvider).toMatchObject({
      available: true,
      configSource: 'workspace-settings',
      provider: 'deepseek',
    });
    expect(route.localAlembic.daemon.capabilities).toMatchObject({
      fileMonitorAvailable: true,
      fileMonitorMode: 'daemon-git-worktree',
    });
    expect(route.missingCapabilities).toEqual([]);
  });

  it('keeps provider config separate from host-agent source when capabilities are missing', () => {
    const daemonStatus = makeDaemonStatus(
      {},
      {
        enhancement: {
          packageName: 'alembic-ai',
          route: 'local-alembic',
          version: '0.9.0',
        },
        capabilities: {
          dashboard: { available: false, url: null },
          internalAi: {
            available: false,
            configSource: 'empty',
            model: null,
            provider: null,
          },
          jobs: { available: true, kinds: ['bootstrap', 'rescan'] },
        },
      }
    );

    const route = buildCodexEnhancementRouteChoice({
      daemonStatus,
      localInstall: LOCAL_INSTALL_UNAVAILABLE,
      requirement: 'dashboard',
    });

    expect(route.selected).toBe('local-alembic-daemon');
    expect(route.missingCapabilities).toEqual(['dashboard']);
    expect(route.hostAgentRoute.source).toBe('host-agent');
    expect(route.internalAiProvider).toMatchObject({
      available: false,
      configSource: 'empty',
      provider: null,
    });
  });

  it('reports a local install for status while plugin actions can still fall back to embedded runtime', () => {
    const daemonStatus = makeDaemonStatus(
      {
        status: 'stopped',
        ready: false,
        state: null,
        pidAlive: false,
        health: null,
      },
      null
    );
    const localInstall = {
      available: true,
      command: 'alembic',
      error: null,
      version: 'alembic-ai 0.9.0',
    };

    expect(
      buildCodexEnhancementRouteChoice({
        daemonStatus,
        localInstall,
        requirement: 'status',
      }).selected
    ).toBe('local-alembic-install');
    expect(
      buildCodexEnhancementRouteChoice({
        daemonStatus,
        localInstall,
        requirement: 'jobs',
      }).selected
    ).toBe('embedded-plugin-runtime');
  });

  it('summarizes older embedded plugin health as an embedded runtime route', () => {
    const daemon = summarizeEnhancementDaemon(makeDaemonStatus());

    expect(daemon.route).toBe('embedded-plugin-runtime');
    expect(daemon.available).toBe(true);
  });
});
