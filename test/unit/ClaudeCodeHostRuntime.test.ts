// RC-7 (DH-5) — Claude Code host PATH runtime tests + cross-host parity.
//
// The dual-host refactor (DH-1~DH-4) routes every host-specific operation through
// the L3 HostAdapter; codex had deep runtime coverage (HostMcpServer.test.ts) but the
// cc path was only schematic (adapter selection + schema parity). These tests exercise
// the cc RUNTIME path: cc identity/runtime-context, cc project-root discovery via
// CLAUDE_PROJECT_DIR, cc init-marker / saved-root persistence round-trips through the
// cc adapter, cc env bootstrap, and codex↔cc output parity for host-agnostic behavior.
//
// The cc adapter is selected by physical shell shape (plugins/alembic-claude-code has
// .claude-plugin/plugin.json and no .mcp.json), so a test forces it by pointing
// CODEX_PLUGIN_ROOT_ENV at the cc shell root — the same mechanism resolveHostAdapter
// uses in production (no test-only injection).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CLAUDE_CODE_PLUGIN_HOST,
  ClaudeCodeHostAdapter,
  CODEX_PLUGIN_HOST,
  CODEX_PLUGIN_ROOT_ENV,
  CodexHostAdapter,
  type HostAdapter,
  resolveHostAdapter,
  resolveHostRuntimeContext,
} from '../../lib/runtime/index.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/runtime/mcp/HostMcpServer.js';

const tempRoots: string[] = [];
const ORIGINAL_ENV: Record<string, string | undefined> = {
  ALEMBIC_HOME: process.env.ALEMBIC_HOME,
  [CODEX_PLUGIN_ROOT_ENV]: process.env[CODEX_PLUGIN_ROOT_ENV],
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};

afterEach(async () => {
  await resetPluginOwnedMcpServerForTests();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// codex shell = default pluginRoot (plugins/alembic-codex, ships .mcp.json);
// cc shell = sibling plugins/alembic-claude-code (.claude-plugin/plugin.json, no .mcp.json).
function shellRoots(): { codexShellRoot: string; claudeShellRoot: string } {
  const codexShellRoot = resolveHostRuntimeContext().pluginRoot;
  return { codexShellRoot, claudeShellRoot: join(codexShellRoot, '..', 'alembic-claude-code') };
}

function ccAdapter(extraEnv: NodeJS.ProcessEnv = {}): HostAdapter {
  return resolveHostAdapter({ [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot, ...extraEnv });
}
function codexAdapter(extraEnv: NodeJS.ProcessEnv = {}): HostAdapter {
  return resolveHostAdapter({ [CODEX_PLUGIN_ROOT_ENV]: shellRoots().codexShellRoot, ...extraEnv });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// Isolate ALEMBIC_HOME (saved-root marker lives under <home>/.asd) so persistence
// round-trips do not touch the real home.
function useTempHome(): string {
  const home = tempDir('alembic-cc-home-');
  process.env.ALEMBIC_HOME = home;
  return home;
}

describe('RC-7 cc host runtime — identity & runtime context', () => {
  test('cc adapter resolves the claude-code runtime context (host identity per shell shape)', () => {
    const env = { [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot };
    const ctx = ccAdapter().resolveRuntimeContext(env);

    expect(ctx.pluginHost).toBe(CLAUDE_CODE_PLUGIN_HOST);
    expect(ctx.expectedPluginHost).toBe(CLAUDE_CODE_PLUGIN_HOST);
    expect(ctx.runtimeMode).toBe('plugin');
    // Runtime package/bin identity is shared (host-agnostic distribution), not codex-only.
    expect(ctx.runtimePackage).toBe(resolveHostRuntimeContext().runtimePackage);
  });

  test('cc adapter exposes claude-code identity, cc manifest layout, empty-asset health', () => {
    const adapter = ccAdapter();
    expect(adapter).toBeInstanceOf(ClaudeCodeHostAdapter);
    expect(adapter.hostId).toBe(CLAUDE_CODE_PLUGIN_HOST);
    // cc spec-form manifest has no interface block → empty assets are healthy (F-V2-2).
    expect(adapter.allowsEmptyPluginAssets).toBe(true);
    expect(adapter.pluginMcpManifestPath('/p')).toBe(join('/p', '.claude-plugin', 'plugin.json'));
  });

  test('cc adapter normalizes ${CLAUDE_PLUGIN_ROOT} args to plugin-root-relative "."', () => {
    expect(ccAdapter().normalizePluginMcpArg('${CLAUDE_PLUGIN_ROOT}/bin/alembic-start.mjs')).toBe(
      './bin/alembic-start.mjs'
    );
  });

  test('cc env bootstrap derives claude-code host and seeds MCP env defaults', () => {
    const env: NodeJS.ProcessEnv = { [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot };
    ccAdapter().ensureRuntimeEnvironment(env);
    expect(env.ALEMBIC_PLUGIN_HOST).toBe(CLAUDE_CODE_PLUGIN_HOST);
    expect(env.ALEMBIC_RUNTIME_MODE).toBe('plugin');
    expect(env.ALEMBIC_MCP_MODE).toBe('1');
  });
});

describe('RC-7 cc host runtime — project root discovery', () => {
  test('cc resolveProjectRoot trusts CLAUDE_PROJECT_DIR (cc workspace no longer fail-closed)', () => {
    const projectDir = tempDir('alembic-cc-projroot-');
    const resolution = ccAdapter().resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: projectDir, [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot },
    });
    expect(resolution.source).toBe('CLAUDE_PROJECT_DIR');
    expect(resolution.trust).toBe('trusted');
    expect(resolution.rejected).toBe(false);
    expect(resolution.path).toBe(projectDir);
  });

  test('cc resolveProjectRoot falls back (untrusted) without an explicit/host project source', () => {
    // No CLAUDE_PROJECT_DIR / ALEMBIC_PROJECT_DIR → only cwd/PWD fallback candidates.
    const resolution = ccAdapter().resolveProjectRoot({
      env: { [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot, PWD: tempDir('alembic-cc-pwd-') },
    });
    expect(resolution.trust).not.toBe('trusted');
  });

  test('explicit projectRoot is trusted on the cc path', () => {
    const projectDir = tempDir('alembic-cc-explicit-');
    const resolution = ccAdapter().resolveProjectRoot({
      projectRoot: projectDir,
      env: { [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot },
    });
    expect(resolution.trust).toBe('trusted');
    expect(resolution.source).toBe('explicit-option');
    expect(resolution.path).toBe(projectDir);
  });
});

describe('RC-7 cc host runtime — persistence round-trips via the cc adapter', () => {
  test('cc adapter writes then reads an init marker for a project', () => {
    useTempHome();
    const projectRoot = tempDir('alembic-cc-init-');
    const adapter = ccAdapter();

    expect(adapter.readInitMarker(projectRoot)).toBeNull();
    const written = adapter.writeInitMarker(projectRoot, {
      initializedBy: 'alembic_init',
      route: 'explicit',
      results: [],
    });
    expect(written.schemaVersion).toBe(1);
    expect(adapter.initMarkerPath(projectRoot)).toContain('codex-init.json');

    const read = adapter.readInitMarker(projectRoot);
    expect(read).not.toBeNull();
    expect(read?.initializedBy).toBe('alembic_init');
    // On-disk marker profile stays the persistence-frozen value (cc reuses it; DH-5/CC3).
    expect(read?.profile).toBe(written.profile);
  });

  test('cc adapter writes then reads a saved project-root marker', () => {
    useTempHome();
    const projectDir = tempDir('alembic-cc-saved-');
    const adapter = ccAdapter();

    const saved = adapter.writeSavedProjectRoot(projectDir);
    expect(saved.projectRoot).toBe(projectDir);
    const read = adapter.readSavedProjectRoot();
    expect(read?.projectRoot).toBe(projectDir);
  });
});

describe('RC-7 cross-host parity — codex vs claude-code', () => {
  test('both adapters share host-AGNOSTIC runtime context (only host identity differs)', () => {
    const codex = codexAdapter().resolveRuntimeContext({
      [CODEX_PLUGIN_ROOT_ENV]: shellRoots().codexShellRoot,
    });
    const cc = ccAdapter().resolveRuntimeContext({
      [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot,
    });

    // Host identity legitimately diverges per host…
    expect(codex.pluginHost).toBe(CODEX_PLUGIN_HOST);
    expect(cc.pluginHost).toBe(CLAUDE_CODE_PLUGIN_HOST);
    // …while the host-agnostic distribution facts are identical (no codex-centric drift).
    expect(cc.runtimePackage).toBe(codex.runtimePackage);
    expect(cc.runtimeBin).toBe(codex.runtimeBin);
    expect(cc.defaultTier).toBe(codex.defaultTier);
    expect(cc.runtimeMode).toBe(codex.runtimeMode);
  });

  test('both adapters resolve the same explicit project root identically (host-agnostic resolution)', () => {
    const projectDir = tempDir('alembic-parity-projroot-');
    const codex = codexAdapter().resolveProjectRoot({
      projectRoot: projectDir,
      env: { [CODEX_PLUGIN_ROOT_ENV]: shellRoots().codexShellRoot },
    });
    const cc = ccAdapter().resolveProjectRoot({
      projectRoot: projectDir,
      env: { [CODEX_PLUGIN_ROOT_ENV]: shellRoots().claudeShellRoot },
    });
    expect(cc.path).toBe(codex.path);
    expect(cc.trust).toBe(codex.trust);
    expect(cc.source).toBe(codex.source);
  });

  test('only L3 selects the host: same factory returns CodexHostAdapter vs ClaudeCodeHostAdapter by shell shape', () => {
    expect(codexAdapter()).toBeInstanceOf(CodexHostAdapter);
    expect(ccAdapter()).toBeInstanceOf(ClaudeCodeHostAdapter);
    expect(codexAdapter().hostId).toBe(CODEX_PLUGIN_HOST);
    expect(ccAdapter().hostId).toBe(CLAUDE_CODE_PLUGIN_HOST);
  });
});

// HostMcpServer integration: construct the real MCP entry on each shell (it resolves
// its L3 adapter from process.env at construction, exactly as in production) and drive
// a real tool dispatch through the cc path.
type StatusResult = { success: boolean; data: { initialized: boolean; project: { root: string } } };

async function dispatchStatusOnShell(shellRoot: string, projectRoot: string): Promise<StatusResult> {
  process.env[CODEX_PLUGIN_ROOT_ENV] = shellRoot;
  await resetPluginOwnedMcpServerForTests();
  const server = new HostMcpServer({ projectRoot });
  return (await server.handleToolCall('alembic_status', {})) as StatusResult;
}

describe('RC-7 cc host runtime — HostMcpServer cc path + dispatch parity', () => {
  test('HostMcpServer on the cc shell dispatches alembic_status through the cc adapter (explicit projectRoot)', async () => {
    useTempHome();
    const projectRoot = tempDir('alembic-cc-server-');
    const result = await dispatchStatusOnShell(shellRoots().claudeShellRoot, projectRoot);

    expect(result.data.project.root).toBe(projectRoot);
  });

  test('codex and cc HostMcpServer return parity status for the same project (host-agnostic dispatch)', async () => {
    useTempHome();
    const projectRoot = tempDir('alembic-parity-server-');

    const codex = await dispatchStatusOnShell(shellRoots().codexShellRoot, projectRoot);
    const cc = await dispatchStatusOnShell(shellRoots().claudeShellRoot, projectRoot);

    // The MCP dispatch + status projection is host-agnostic: same project → same view.
    expect(cc.success).toBe(codex.success);
    expect(cc.data.initialized).toBe(codex.data.initialized);
    expect(cc.data.project.root).toBe(codex.data.project.root);
    expect(cc.data.project.root).toBe(projectRoot);
  });
});
