import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_SCOPE_CONTRACT_VERSION, type ProjectScopeSummary } from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
import type { AlembicResidentProjectScopeIdentity } from '../../lib/service/resident/AlembicResidentServiceClient.js';
import {
  ALEMBIC_PLUGIN_HOST_ENV,
  ALEMBIC_RUNTIME_MODE_ENV,
  ALEMBIC_RUNTIME_MODE_PLUGIN,
  buildCodexProjectRuntimeContext,
  buildCodexRuntimeDiagnostics,
  buildCodexPluginDiagnostics,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_MODE_ENV,
  CODEX_MCP_SHIM_ENV,
  CODEX_MCP_TIER_ENV,
  CODEX_PLUGIN_HOST,
  ensureCodexRuntimeEnvironment,
  loadCodexPluginRegistry,
  probeCodexRuntimeCommand,
  resolveCodexRuntimeContext,
} from '../../lib/codex/index.js';
import { ALEMBIC_CHANNEL_ID_ENV } from '../../lib/shared/channel.js';

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
  test('sets Codex MCP defaults without overwriting explicit channel and tier', () => {
    const env: NodeJS.ProcessEnv = {
      [ALEMBIC_CHANNEL_ID_ENV]: 'custom-codex',
      [CODEX_MCP_TIER_ENV]: 'admin',
    };

    ensureCodexRuntimeEnvironment(env);

    expect(env[CODEX_MCP_MODE_ENV]).toBe('1');
    expect(env[CODEX_MCP_SHIM_ENV]).toBe('1');
    expect(env[ALEMBIC_RUNTIME_MODE_ENV]).toBe(ALEMBIC_RUNTIME_MODE_PLUGIN);
    expect(env[ALEMBIC_PLUGIN_HOST_ENV]).toBe(CODEX_PLUGIN_HOST);
    expect(env[ALEMBIC_CHANNEL_ID_ENV]).toBe('custom-codex');
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

  test('resolves channel and tier from the supplied runtime environment', () => {
    const context = resolveCodexRuntimeContext({
      [ALEMBIC_CHANNEL_ID_ENV]: 'Custom-Codex',
      [ALEMBIC_PLUGIN_HOST_ENV]: 'Codex',
      [ALEMBIC_RUNTIME_MODE_ENV]: 'Plugin',
      [CODEX_MCP_TIER_ENV]: 'admin',
    });

    expect(context.channelId).toBe('custom-codex');
    expect(context.runtimeMode).toBe(ALEMBIC_RUNTIME_MODE_PLUGIN);
    expect(context.pluginHost).toBe(CODEX_PLUGIN_HOST);
    expect(context.expectedRuntimeMode).toBe(ALEMBIC_RUNTIME_MODE_PLUGIN);
    expect(context.expectedPluginHost).toBe(CODEX_PLUGIN_HOST);
    expect(context.requestedTier).toBe('admin');
    expect(context.effectiveTier).toBe(CODEX_DEFAULT_MCP_TIER);
  });

  test('resolves the Codex plugin registry from the channel manifest', () => {
    const context = resolveCodexRuntimeContext();
    const registry = loadCodexPluginRegistry(context);

    expect(context.expectedChannelId).toBe('codex');
    expect(context.runtimeBin).toBe('alembic-codex-mcp');
    expect(registry.channel.value?.id).toBe('codex');
    expect(registry.plugin.manifest.value?.name).toBe('alembic-codex');
    expect(registry.mcp.server?.command).toBe('node');
    expect(registry.mcp.args).toContain('./bin/alembic-codex-mcp-wrapper.mjs');
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
    expect(diagnostics.mcp.runtimeSpecifier).toBe(context.embeddedRuntimeSpecifier);
    expect(diagnostics.mcp.entry).toMatchObject({
      mode: 'packaged-wrapper',
      nextAction: expect.stringContaining('packaged runtime diagnostics'),
      runtimeTarball: {
        exists: true,
      },
    });
    expect(diagnostics.mcp.wrapper.startupLockDiagnostics).toMatchObject({
      cacheParentCreation: true,
      configured: true,
      ownerMetadata: true,
      runtimeTarballPreflight: true,
      scope: 'plugin-root-runtime-tarball',
      waitDiagnostics: true,
    });
    expect(diagnostics.mcp.wrapper.startupLockDiagnostics.releaseSignals).toEqual(
      expect.arrayContaining(['stdout', 'stderr', 'child-exit', 'child-error', 'hold-timeout'])
    );
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
});

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `alembic-codex-runtime-${label}-`));
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
