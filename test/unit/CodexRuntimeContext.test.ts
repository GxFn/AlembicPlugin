import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_SCOPE_CONTRACT_VERSION, type ProjectScopeSummary } from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
import {
  ALEMBIC_PLUGIN_HOST_ENV,
  ALEMBIC_RUNTIME_MODE_ENV,
  ALEMBIC_RUNTIME_MODE_PLUGIN,
  buildCodexPluginDiagnostics,
  buildCodexProjectRuntimeContext,
  buildCodexRuntimeDiagnostics,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_MODE_ENV,
  CODEX_MCP_SHIM_ENV,
  CODEX_MCP_TIER_ENV,
  CODEX_PLUGIN_HOST,
  ensureCodexRuntimeEnvironment,
  loadCodexPluginRegistry,
  probeCodexRuntimeCommand,
  resolveCodexRuntimeContext,
} from '../../lib/runtime/index.js';
import type { AlembicResidentProjectScopeIdentity } from '../../lib/service/resident/AlembicResidentServiceClient.js';

const tempRoots: string[] = [];

function makeDaemonStatus(): DaemonStatus {
  return {
    dataRoot: process.cwd(),
    health: null,
    lockDir: '',
    logPath: '',
    pidAlive: false,
    pidPath: '',
    projectId: null,
    projectRoot: process.cwd(),
    ready: false,
    state: null,
    statePath: '',
    status: 'stopped',
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex runtime context', () => {
  test('sets Codex MCP defaults without overwriting explicit tier', () => {
    const env: NodeJS.ProcessEnv = {
      [CODEX_MCP_TIER_ENV]: 'admin',
    };

    ensureCodexRuntimeEnvironment(env);

    expect(env[CODEX_MCP_MODE_ENV]).toBe('1');
    expect(env[CODEX_MCP_SHIM_ENV]).toBe('1');
    expect(env[ALEMBIC_RUNTIME_MODE_ENV]).toBe(ALEMBIC_RUNTIME_MODE_PLUGIN);
    expect(env[ALEMBIC_PLUGIN_HOST_ENV]).toBe(CODEX_PLUGIN_HOST);
    expect(env[CODEX_MCP_TIER_ENV]).toBe('admin');
  });

  test('keeps explicit generic plugin runtime identity when supplied', () => {
    const env: NodeJS.ProcessEnv = {
      [ALEMBIC_PLUGIN_HOST_ENV]: 'custom-host',
      [ALEMBIC_RUNTIME_MODE_ENV]: 'plugin',
    };

    ensureCodexRuntimeEnvironment(env);

    expect(env[ALEMBIC_RUNTIME_MODE_ENV]).toBe('plugin');
    expect(env[ALEMBIC_PLUGIN_HOST_ENV]).toBe('custom-host');
  });

  test('resolves plugin host and tier from the supplied runtime environment', () => {
    const context = resolveCodexRuntimeContext({
      [ALEMBIC_PLUGIN_HOST_ENV]: 'Codex',
      [ALEMBIC_RUNTIME_MODE_ENV]: 'Plugin',
      [CODEX_MCP_TIER_ENV]: 'admin',
    });

    expect(context.runtimeMode).toBe(ALEMBIC_RUNTIME_MODE_PLUGIN);
    expect(context.pluginHost).toBe(CODEX_PLUGIN_HOST);
    expect(context.expectedRuntimeMode).toBe(ALEMBIC_RUNTIME_MODE_PLUGIN);
    expect(context.expectedPluginHost).toBe(CODEX_PLUGIN_HOST);
    expect(context.requestedTier).toBe('admin');
    expect(context.effectiveTier).toBe(CODEX_DEFAULT_MCP_TIER);
  });

  test('resolves the Codex plugin registry from the marketplace manifest', () => {
    const context = resolveCodexRuntimeContext();
    const registry = loadCodexPluginRegistry(context);

    expect(context.runtimeBin).toBe('alembic-codex-mcp');
    expect(context.runtimePackage).toBe('@gxfn/alembic-runtime');
    expect(context.pinnedRuntimeSpecifier).toBe(`@gxfn/alembic-runtime@${context.packageVersion}`);
    expect(registry.marketplace.value?.name).toBe('gxfn');
    expect(registry.plugin.manifest.value?.name).toBe('alembic');
    expect(registry.mcp.server?.command).toBe('node');
    expect(registry.mcp.args).toContain('./bin/alembic-start.mjs');
  });

  test('builds plugin diagnostics from shared Codex registry facts', () => {
    const context = resolveCodexRuntimeContext();
    const diagnostics = buildCodexPluginDiagnostics(context);

    expect(diagnostics.manifest.ok).toBe(true);
    expect(diagnostics.mcp.packagePin).toBe(true);
    expect(diagnostics.mcp.embeddedRuntime).toBe(true);
    expect(diagnostics.mcp.agentTierByDefault).toBe(true);
    expect(diagnostics.mcp.runtimeMode).toBe(true);
    expect(diagnostics.mcp.pluginHost).toBe(true);
    expect(diagnostics.mcp.runtimeSpecifier).toBe(context.pinnedRuntimeSpecifier);
    expect(diagnostics.mcp.entry).toMatchObject({
      mode: 'marketplace-shell',
      nextAction: expect.stringContaining('marketplace shell diagnostics'),
    });
    expect(diagnostics.mcp.wrapper.exists).toBe(true);
    expect(diagnostics.mcp.wrapper.path).toContain('alembic-start.mjs');
    expect(diagnostics.skills.missing).toEqual([]);
    expect(diagnostics.assets.missing).toEqual([]);
    expect(context.defaultTier).toBe(CODEX_DEFAULT_MCP_TIER);
  });

  test('probes npm and npx from a stable plugin cwd instead of inherited process cwd', () => {
    const context = resolveCodexRuntimeContext();
    let observedCwd: string | undefined;

    const probe = probeCodexRuntimeCommand('npm', context, (_command, _args, options) => {
      observedCwd = options.cwd;
      return { status: 0, stdout: '10.9.4\n' };
    });

    expect(observedCwd).toBe(context.pluginRoot);
    expect(probe).toMatchObject({
      available: true,
      cwd: context.pluginRoot,
      staleCwd: false,
      version: '10.9.4',
    });
  });

  test('classifies uv_cwd failures as stale MCP cwd instead of missing npm', () => {
    const diagnostics = buildCodexRuntimeDiagnostics(
      makeDaemonStatus(),
      resolveCodexRuntimeContext(),
      {
        commandProbeRunner() {
          return {
            status: 1,
            stderr: 'Error: ENOENT: no such file or directory, uv_cwd',
          };
        },
      }
    ) as {
      commands: {
        npm: { staleCwd: boolean };
        npx: { staleCwd: boolean };
      };
      issues: Array<{ code: string }>;
    };

    const issueCodes = diagnostics.issues.map((issue) => issue.code);
    expect(issueCodes).toContain('CODEX_STALE_COMMAND_CWD');
    expect(issueCodes).not.toContain('NPM_UNAVAILABLE');
    expect(issueCodes).not.toContain('NPX_UNAVAILABLE');
    expect(diagnostics.commands.npm.staleCwd).toBe(true);
    expect(diagnostics.commands.npx.staleCwd).toBe(true);
  });

  test('uses resident ProjectScope data root while preserving Codex projectRoot identity source', () => {
    const projectRoot = tempDir('source');
    const dataRoot = tempDir('scope-data');
    const controlRoot = tempDir('control');
    const projectScope = makeProjectScopeSummary({ controlRoot, dataRoot, projectRoot });
    const projectScopeIdentity: AlembicResidentProjectScopeIdentity = {
      available: true,
      controlRoot,
      currentFolderId: projectScope.currentFolderId,
      currentFolderPath: projectRoot,
      dataRoot,
      dataRootSource: 'ghost-registry',
      diagnosticProjectRoot: projectRoot,
      folderCount: 1,
      folders: projectScope.folders,
      mode: 'project-scope',
      projectId: projectScope.projectId,
      projectRoot,
      projectScope,
      projectScopeCapability: { available: true, storageKind: 'ghost' },
      projectScopeId: projectScope.projectScopeId,
      reason: null,
      resident: {
        owner: 'alembic',
        route: 'local-alembic-daemon',
        serviceScopeId: 'project-scope:scope-plugin',
      },
      serviceScopeId: 'project-scope:scope-plugin',
      source: 'resident-project-scope-endpoint',
      storageKind: 'ghost',
      workspaceMode: 'ghost',
    };

    const context = buildCodexProjectRuntimeContext({
      includeOptionalServices: false,
      projectRoot,
      projectScopeIdentity,
      requiredServices: ['project-identity', 'project-scope'],
    });

    expect(context.identity).toMatchObject({
      currentFolderId: 'folder-plugin',
      dataRoot,
      dataRootSource: 'ghost-registry',
      databasePath: join(dataRoot, '.asd', 'alembic.db'),
      ghost: true,
      mode: 'ghost',
      projectId: 'project-plugin',
      projectRoot,
      projectScopeId: 'scope-plugin',
      registered: true,
      runtimeDir: join(dataRoot, '.asd'),
      workspaceExists: true,
    });
    expect(context.identity.projectScope).toMatchObject({
      currentFolderPath: projectRoot,
      dataRoot,
      projectScopeId: 'scope-plugin',
    });
    expect(context.sourcePolicy).toMatchObject({
      effectiveIdentitySource: 'codex-current-project',
      projectScopeSource: 'resident-read-only',
      runtimeControlSource: 'read-only-diagnostics',
      selectedOrActiveCanOverrideEffectiveIdentity: false,
    });
    expect(context.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          available: true,
          service: 'project-identity',
          source: 'codex-current-project',
        }),
        expect.objectContaining({
          available: true,
          service: 'project-scope',
          source: 'resident-project-scope-endpoint',
        }),
      ])
    );
    expect(context.blockedFallbacks).toEqual(
      expect.arrayContaining([
        'saved-project-root-effective-identity',
        'runtime-control-selected-active-effective-identity',
        'local-jobstore-default-effective-identity',
      ])
    );
    expect(context.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'embedded-plugin-owned-runtime',
          persistenceRootAllowed: false,
        }),
      ])
    );
  });

  test('preserves runtime-control mismatch diagnostics without identity fallback', () => {
    const projectRoot = tempDir('runtime-control-mismatch');
    const statePath = join(projectRoot, '.asd', 'runtime-control.json');
    const daemonStatus: DaemonStatus = {
      ...makeDaemonStatus(),
      dataRoot: projectRoot,
      health: {
        data: {
          projectRuntimeSourceOfTruth: {
            contractVersion: 1,
            diagnostics: [
              {
                action: 'explicit-runtime-action-required',
                code: 'selected-active-mismatch',
                message: 'Selected project does not match active daemon state.',
                projectId: 'project-active',
                projectRoot: join(projectRoot, 'active'),
                reasonCode: 'runtime-control-selected-mismatch',
                severity: 'error',
                source: 'runtime-control-state',
              },
            ],
            failure: {
              blockedFallbacks: ['plugin-selected-root-fallback', 'implicit-runtime-control-write'],
              blockingCondition: 'Selected project does not match active daemon state.',
              diagnostics: [
                {
                  code: 'selected-active-mismatch',
                  reasonCode: 'runtime-control-selected-mismatch',
                },
              ],
              observedSource: 'alembic-source-of-truth',
              reasonCode: 'runtime-control-selected-mismatch',
              retryable: false,
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
              reasonCode: 'runtime-control-selected-mismatch',
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
              activeProject: {
                projectId: 'project-active',
                projectRoot: join(projectRoot, 'active'),
                ready: true,
                status: 'ready',
              },
              activeReadyProject: {
                projectId: 'project-active',
                projectRoot: join(projectRoot, 'active'),
                ready: true,
                status: 'ready',
              },
              activeStateTrusted: false,
              diagnostics: [
                {
                  code: 'selected-active-mismatch',
                  reasonCode: 'runtime-control-selected-mismatch',
                  severity: 'error',
                },
              ],
              projects: { missing: 0, ready: 1, stale: 1, total: 2, unavailable: 0 },
              readOnly: true,
              selectedMatchesCurrentProject: true,
              selectedProject: {
                projectId: 'project-selected',
                projectRoot,
                ready: true,
                status: 'ready',
              },
              state: {
                activeProjectId: 'project-active',
                selectedProjectId: 'project-selected',
                selectedProjectRoot: projectRoot,
              },
              stateCleanup: {
                activeState: {
                  cleaned: false,
                  message: null,
                  previousProjectId: 'project-active',
                  previousProjectRoot: join(projectRoot, 'active'),
                  reasonCode: null,
                },
              },
              statePath,
            },
            targetProject: {
              projectId: 'project-selected',
              projectRoot,
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
      },
      lockDir: join(projectRoot, '.asd', 'daemon.lock'),
      logPath: join(projectRoot, '.asd', 'daemon.log'),
      pidAlive: true,
      pidPath: join(projectRoot, '.asd', 'daemon.pid'),
      projectId: 'project-selected',
      projectRoot,
      ready: false,
      statePath,
      status: 'stale',
    };

    const context = buildCodexProjectRuntimeContext({
      daemonStatus,
      includeOptionalServices: false,
      projectRoot,
      requiredServices: ['project-identity', 'daemon'],
    });

    expect(context.sourceOfTruth).toMatchObject({
      diagnostics: [
        {
          code: 'selected-active-mismatch',
          reasonCode: 'runtime-control-selected-mismatch',
        },
      ],
      failure: {
        observedSource: 'alembic-source-of-truth',
        reasonCode: 'runtime-control-selected-mismatch',
        retryable: false,
      },
      readiness: {
        ready: false,
        reasonCode: 'runtime-control-selected-mismatch',
        stale: true,
      },
      runtimeControl: {
        activeStateTrusted: false,
        diagnostics: [
          {
            code: 'selected-active-mismatch',
            reasonCode: 'runtime-control-selected-mismatch',
          },
        ],
        readOnly: true,
        selectedMatchesCurrentProject: true,
        stateCleanup: {
          activeState: {
            cleaned: false,
          },
        },
      },
    });
    expect(context.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          available: false,
          reason: 'daemon-stale',
          service: 'daemon',
          source: 'project-runtime-control',
        }),
      ])
    );
    expect(context.sourcePolicy.selectedOrActiveCanOverrideEffectiveIdentity).toBe(false);
    expect(context.blockedFallbacks).toContain(
      'runtime-control-selected-active-effective-identity'
    );
  });

  test('preserves daemon-missing state cleanup diagnostics as source-of-truth evidence', () => {
    const projectRoot = tempDir('runtime-control-cleanup');
    const statePath = join(projectRoot, '.asd', 'runtime-control.json');
    const daemonStatus: DaemonStatus = {
      ...makeDaemonStatus(),
      dataRoot: projectRoot,
      health: {
        data: {
          projectRuntimeSourceOfTruth: {
            contractVersion: 1,
            diagnostics: [
              {
                action: 'cleared-active-state',
                code: 'daemon-state-missing',
                message: 'Persisted active daemon state is missing.',
                projectId: 'project-old',
                projectRoot: join(projectRoot, 'old'),
                reasonCode: 'daemon-missing',
                severity: 'error',
                source: 'daemon-status',
              },
            ],
            failure: {
              diagnostics: [
                {
                  code: 'daemon-state-missing',
                  reasonCode: 'daemon-missing',
                },
              ],
              observedSource: 'alembic-source-of-truth',
              reasonCode: 'daemon-missing',
            },
            owner: 'alembic',
            readiness: {
              ready: false,
              reasonCode: 'daemon-missing',
              stale: false,
              status: 'unavailable',
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
                  code: 'daemon-state-missing',
                  reasonCode: 'daemon-missing',
                  severity: 'error',
                },
              ],
              projects: { missing: 0, ready: 0, stale: 0, total: 1, unavailable: 1 },
              readOnly: true,
              selectedMatchesCurrentProject: true,
              selectedProject: {
                projectId: 'project-selected',
                projectRoot,
                ready: false,
                status: 'unavailable',
              },
              state: {
                activeProjectId: null,
                selectedProjectId: 'project-selected',
                selectedProjectRoot: projectRoot,
              },
              stateCleanup: {
                activeState: {
                  cleaned: true,
                  cleanedAt: '2026-06-05T09:00:00.000Z',
                  message: 'Cleared stale active daemon state.',
                  previousProjectId: 'project-old',
                  previousProjectRoot: join(projectRoot, 'old'),
                  reasonCode: 'daemon-missing',
                },
              },
              statePath,
            },
            targetProject: {
              projectId: 'project-selected',
              projectRoot,
              ready: false,
              status: 'unavailable',
            },
          },
        },
      },
      lockDir: join(projectRoot, '.asd', 'daemon.lock'),
      logPath: join(projectRoot, '.asd', 'daemon.log'),
      pidAlive: false,
      pidPath: join(projectRoot, '.asd', 'daemon.pid'),
      projectId: 'project-selected',
      projectRoot,
      ready: false,
      statePath,
      status: 'stopped',
    };

    const context = buildCodexProjectRuntimeContext({
      daemonStatus,
      includeOptionalServices: false,
      projectRoot,
      requiredServices: ['project-identity', 'daemon'],
    });

    expect(context.sourceOfTruth).toMatchObject({
      readiness: {
        reasonCode: 'daemon-missing',
      },
      runtimeControl: {
        diagnostics: [
          {
            code: 'daemon-state-missing',
            reasonCode: 'daemon-missing',
          },
        ],
        stateCleanup: {
          activeState: {
            cleaned: true,
            previousProjectId: 'project-old',
            reasonCode: 'daemon-missing',
          },
        },
      },
    });
    expect(context.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          available: false,
          reason: 'daemon-missing',
          service: 'daemon',
          source: 'project-runtime-control',
        }),
      ])
    );
  });
});

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `alembic-runtime-${label}-`));
  tempRoots.push(root);
  return root;
}

function makeProjectScopeSummary(input: {
  controlRoot: string;
  dataRoot: string;
  projectRoot: string;
}): ProjectScopeSummary {
  return {
    contractVersion: PROJECT_SCOPE_CONTRACT_VERSION,
    controlRoot: input.controlRoot,
    controlRootIncludedInFolders: false,
    currentFolderId: 'folder-plugin',
    currentFolderPath: input.projectRoot,
    dataRoot: input.dataRoot,
    dataRootSource: 'ghost-registry',
    displayName: 'AlembicPlugin scope',
    folderCount: 1,
    folders: [
      {
        displayName: 'AlembicPlugin',
        folderId: 'folder-plugin',
        path: input.projectRoot,
        realpath: input.projectRoot,
        repositoryId: 'alembic-plugin',
        role: 'source',
        state: 'active',
      },
    ],
    projectId: 'project-plugin',
    projectRootWriteAllowed: false,
    projectScopeId: 'scope-plugin',
    standardWriteAllowed: false,
    storageKind: 'ghost',
  };
}
