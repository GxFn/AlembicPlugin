import { describe, expect, test } from 'vitest';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';
import {
  ALEMBIC_PLUGIN_HOST_ENV,
  ALEMBIC_RUNTIME_MODE_ENV,
  ALEMBIC_RUNTIME_MODE_PLUGIN,
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
      configured: true,
      ownerMetadata: true,
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
});
