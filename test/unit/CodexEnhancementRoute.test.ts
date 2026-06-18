import { createAlembicResidentServiceStatus } from '@alembic/core/daemon';
import { describe, expect, it } from 'vitest';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
import {
  buildHostEnhancementRouteChoice,
  summarizeEnhancementDaemon,
} from '../../lib/runtime/EnhancementRoute.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

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
      version: getPackageVersion(),
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
          packageName: 'alembic-codex-plugin-runtime',
          route: 'local-alembic',
          version: '0.9.0',
        },
        capabilities: {
          api: { available: true },
          dashboard: { available: true, url: 'http://127.0.0.1:39127' },
          fileMonitor: { available: true, mode: 'daemon-git-worktree' },
          runtimeBoundary: {
            owner: 'alembic',
            route: 'local-alembic',
            workspace: {
              contract: '@alembic/core/workspace',
              databasePath: '/tmp/project/.asd/alembic.db',
              dataRoot: '/tmp/project/.asd',
              dataRootSource: 'project',
              mode: 'standard',
              projectId: 'project-id',
              projectRoot: '/tmp/project',
              runtimeDir: '/tmp/project/.asd/runtime',
            },
            daemon: {
              apiBaseUrl: 'http://127.0.0.1:39127',
              mode: 'daemon',
              owner: 'alembic',
              stateContract: '@alembic/core/daemon',
            },
            dashboard: {
              frontendOwner: 'AlembicDashboard',
              handoff: 'url',
              serverOwner: 'alembic',
              url: 'http://127.0.0.1:39127',
            },
            fileMonitor: {
              available: true,
              longLivedOwner: 'alembic-daemon',
              source: 'daemon-git-worktree',
            },
            apiAi: {
              available: true,
              owner: 'alembic-api-ai',
              runtimeOwner: 'AlembicAgent',
            },
            jobs: {
              kinds: ['bootstrap', 'rescan'],
              owner: 'alembic',
              store: '@alembic/core/daemon/JobStore',
            },
          },
          apiAi: {
            available: true,
            configSource: 'workspace-settings',
            model: 'deepseek-chat',
            provider: 'deepseek',
          },
          jobs: { available: true, kinds: ['bootstrap', 'rescan'] },
        },
      }
    );

    const route = buildHostEnhancementRouteChoice({
      daemonStatus,
      localInstall: LOCAL_INSTALL_UNAVAILABLE,
      requirement: 'jobs',
    });

    expect(route.selected).toBe('local-alembic-daemon');
    expect(route.hostAgentRoute).toMatchObject({
      requiresAiProvider: false,
      source: 'host-agent',
    });
    expect(route.residentDaemonJobProvider).toMatchObject({
      available: true,
      configSource: 'workspace-settings',
      provider: 'deepseek',
    });
    expect(route.localAlembic.daemon.capabilities).toMatchObject({
      fileMonitorAvailable: true,
      fileMonitorMode: 'daemon-git-worktree',
    });
    expect(route.localAlembic.daemon.runtimeBoundary).toMatchObject({
      available: true,
      source: 'capabilities.runtimeBoundary',
      route: 'local-alembic',
      workspace: {
        databasePath: '/tmp/project/.asd/alembic.db',
        dataRootSource: 'project',
      },
      fileMonitor: {
        longLivedOwner: 'alembic-daemon',
        mode: 'daemon-git-worktree',
      },
      jobs: {
        owner: 'alembic',
        kinds: ['bootstrap', 'rescan'],
      },
    });
    expect(route.localAlembic.daemon.compatibility.runtimeBoundary).toMatchObject({
      activeFallback: false,
      retained: false,
      source: 'capabilities.runtimeBoundary',
    });
    expect(route.reason).toContain('canonical residentService capabilities');
    expect(route.missingCapabilities).toEqual([]);
  });

  it('prefers residentService over legacy capability and runtimeBoundary summaries', () => {
    const residentService = createAlembicResidentServiceStatus({
      apiBaseUrl: 'http://127.0.0.1:39127',
      capabilityOverrides: {
        'dashboard.handoff': { available: false, unavailableReason: 'unsupported-route' },
        'file-monitor.git-worktree': {
          available: false,
          unavailableReason: 'unsupported-route',
        },
        'jobs.api-ai.bootstrap': { available: true },
        'jobs.api-ai.rescan': { available: true },
        'status.health': { available: true },
      },
      owner: 'alembic',
      route: 'local-alembic-daemon',
      serviceScope: {
        diagnosticPaths: {
          projectRoot: '/tmp/project',
          dataRoot: '/tmp/project/.asd',
          databasePath: '/tmp/project/.asd/alembic.db',
          runtimeDir: '/tmp/project/.asd/runtime',
          statePath: '/tmp/project/.asd/runtime/daemon.json',
        },
        kind: 'current-project',
        projectIdentity: {
          dataRootSource: 'project',
          projectId: 'project-id',
          schemaMigrationVersion: '001',
          workspaceMode: 'standard',
        },
      },
    });
    const daemonStatus = makeDaemonStatus(
      {},
      {
        residentService,
        capabilities: {
          dashboard: { available: true, url: 'http://127.0.0.1:39127/dashboard' },
          fileMonitor: { available: true, mode: 'daemon-git-worktree' },
          runtimeBoundary: {
            owner: 'alembic',
            route: 'local-alembic',
            dashboard: {
              url: 'http://127.0.0.1:39127/dashboard',
            },
            fileMonitor: {
              available: true,
              source: 'daemon-git-worktree',
            },
          },
        },
      }
    );

    const route = buildHostEnhancementRouteChoice({
      daemonStatus,
      localInstall: LOCAL_INSTALL_UNAVAILABLE,
      requirement: 'dashboard',
    });

    expect(route.selected).toBe('local-alembic-daemon');
    expect(route.localAlembic.daemon.capabilities).toMatchObject({
      dashboardAvailable: false,
      fileMonitorAvailable: false,
      jobsAvailable: true,
      jobKinds: ['bootstrap', 'rescan'],
    });
    expect(route.localAlembic.daemon.compatibility.runtimeBoundary).toMatchObject({
      activeFallback: false,
      canonicalResidentServicePresent: true,
      retained: false,
    });
    expect(route.reason).toContain('resident service route (alembic/local-alembic-daemon)');
    expect(route.reason).not.toContain('Runtime boundary source');
    expect(route.missingCapabilities).toEqual(['dashboard']);
  });

  it('keeps runtimeBoundary diagnostic only when canonical capability sections are partial', () => {
    const daemonStatus = makeDaemonStatus(
      {},
      {
        version: '0.9.0',
        enhancement: {
          apiVersion: 'v1',
          packageName: 'alembic-codex-plugin-runtime',
          route: 'local-alembic',
          version: '0.9.0',
        },
        capabilities: {
          runtimeBoundary: {
            owner: 'alembic',
            route: 'local-alembic',
            dashboard: {
              frontendOwner: 'AlembicDashboard',
              handoff: 'url',
              serverOwner: 'alembic',
              url: 'http://127.0.0.1:39127',
            },
            fileMonitor: {
              available: true,
              longLivedOwner: 'alembic-daemon',
              source: 'daemon-git-worktree',
            },
            apiAi: {
              available: false,
              owner: 'alembic-api-ai',
              runtimeOwner: 'AlembicAgent',
            },
            jobs: {
              kinds: ['bootstrap', 'rescan'],
              owner: 'alembic',
              store: '@alembic/core/daemon/JobStore',
            },
          },
        },
      }
    );

    const route = buildHostEnhancementRouteChoice({
      daemonStatus,
      localInstall: LOCAL_INSTALL_UNAVAILABLE,
      requirement: 'dashboard',
    });

    expect(route.selected).toBe('local-alembic-daemon');
    expect(route.localAlembic.daemon.capabilities).toMatchObject({
      dashboardAvailable: null,
      dashboardUrl: null,
      fileMonitorAvailable: null,
      fileMonitorMode: null,
      residentDaemonJobsAvailable: null,
      jobsAvailable: null,
      jobKinds: [],
    });
    expect(route.localAlembic.daemon.compatibility.runtimeBoundary).toMatchObject({
      activeFallback: false,
      retained: false,
      source: 'capabilities.runtimeBoundary',
    });
    expect(route.missingCapabilities).toEqual(['dashboard']);
  });

  it('keeps provider config separate from host-agent source when capabilities are missing', () => {
    const daemonStatus = makeDaemonStatus(
      {},
      {
        enhancement: {
          packageName: 'alembic-codex-plugin-runtime',
          route: 'local-alembic',
          version: '0.9.0',
        },
        capabilities: {
          dashboard: { available: false, url: null },
          apiAi: {
            available: false,
            configSource: 'empty',
            model: null,
            provider: null,
          },
          jobs: { available: true, kinds: ['bootstrap', 'rescan'] },
        },
      }
    );

    const route = buildHostEnhancementRouteChoice({
      daemonStatus,
      localInstall: LOCAL_INSTALL_UNAVAILABLE,
      requirement: 'dashboard',
    });

    expect(route.selected).toBe('local-alembic-daemon');
    expect(route.missingCapabilities).toEqual(['dashboard']);
    expect(route.hostAgentRoute.source).toBe('host-agent');
    expect(route.residentDaemonJobProvider).toMatchObject({
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
      version: 'alembic-codex-plugin-runtime 0.9.0',
    };

    expect(
      buildHostEnhancementRouteChoice({
        daemonStatus,
        localInstall,
        requirement: 'status',
      }).selected
    ).toBe('local-alembic-install');
    expect(
      buildHostEnhancementRouteChoice({
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
