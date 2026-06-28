import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = join(projectRoot, 'scripts', 'sync-codex-plugin-cache.mjs');
const pluginManifestPath = join(
  projectRoot,
  'plugins',
  'alembic-codex',
  '.codex-plugin',
  'plugin.json'
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex plugin cache sync script', () => {
  test('prints the gxfn cache target without writing during dry-run', () => {
    const codexHome = tempDir();
    const output = runSyncScript('--dry-run', '--codex-home', codexHome);
    const summary = JSON.parse(output) as { targetRoots: string[] };
    const [targetRoot] = summary.targetRoots;
    const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as {
      version: string;
    };

    expect(targetRoot).toBe(
      join(codexHome, 'plugins', 'cache', 'gxfn', 'alembic', pluginManifest.version)
    );
    expect(existsSync(targetRoot)).toBe(false);
  });

  test('canonicalizes enabled Codex config aliases to the manifest plugin name', () => {
    const codexHome = tempDir();
    const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as {
      version: string;
    };
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        '[plugins."alembic-codex@gxfn"]',
        'enabled = true',
        '',
        '[plugins."alembic@gxfn"]',
        'enabled = false',
        '',
      ].join('\n')
    );

    const output = runSyncScript('--dry-run', '--all-installed', '--codex-home', codexHome);
    const summary = JSON.parse(output) as { targetRoots: string[] };

    expect(summary.targetRoots).toEqual([
      join(codexHome, 'plugins', 'cache', 'gxfn', 'alembic', pluginManifest.version),
    ]);
  });

  test('copies the plugin and rewrites only the cached MCP config for local dist', () => {
    const codexHome = tempDir();
    const localEntry = join(tempDir(), 'host-mcp.js');
    writeFileSync(localEntry, '#!/usr/bin/env node\n');

    const output = runSyncScript(
      '--codex-home',
      codexHome,
      '--local-mcp',
      '--local-mcp-entry',
      localEntry
    );
    const summary = JSON.parse(output) as { targetRoots: string[] };
    const [targetRoot] = summary.targetRoots;
    const cachedMcpPath = join(targetRoot, '.mcp.json');
    const markerPath = join(targetRoot, '.alembic-dev-refresh.json');
    const repoMcpPath = join(projectRoot, 'plugins', 'alembic-codex', '.mcp.json');
    const cachedMcp = JSON.parse(readFileSync(cachedMcpPath, 'utf8'));
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      canonicalLocalDevCommand: string;
      entryMode: string;
      hashes: { mcp: string; startup: string };
      localMcpEntry: string;
      localProjection: {
        allRequiredMarkersPresent: boolean;
        files: Array<{
          allRequiredMarkersPresent: boolean;
          id: string;
          markerStatus: Record<string, boolean>;
        }>;
        mcpEntry: { exists: boolean; hash: string | null; path: string };
        requiredMarkerNames: string[];
      };
      mode: string;
      runtimeModeSeparation: {
        localDev: { cacheRewrite: boolean; entryMode: string; localMcpEntry: string };
        packaged: { cacheIsolation: string; entryMode: string; runtimeSpecifier: string };
      };
    };
    const repoMcp = JSON.parse(readFileSync(repoMcpPath, 'utf8'));

    expect(existsSync(join(targetRoot, '.codex-plugin', 'plugin.json'))).toBe(true);
    expect(cachedMcp.mcpServers.alembic.command).toBe(process.execPath);
    expect(cachedMcp.mcpServers.alembic.args).toEqual([localEntry]);
    expect(cachedMcp.mcpServers.alembic.env.ALEMBIC_CHANNEL_ID).toBeUndefined();
    expect(cachedMcp.mcpServers.alembic.env.ALEMBIC_RUNTIME_MODE).toBe('plugin');
    expect(cachedMcp.mcpServers.alembic.env.ALEMBIC_PLUGIN_HOST).toBe('codex');
    expect(repoMcp.mcpServers.alembic.command).toBe('node');
    expect(repoMcp.mcpServers.alembic.args).toContain('./bin/alembic-start.mjs');
    expect(marker).toMatchObject({
      canonicalLocalDevCommand: 'npm run dev:codex-plugin:reload',
      entryMode: 'local-dev-direct-dist',
      localMcpEntry: localEntry,
      mode: 'local-mcp',
      runtimeModeSeparation: {
        localDev: {
          cacheRewrite: true,
          entryMode: 'local-dev-direct-dist',
          localMcpEntry: localEntry,
        },
        packaged: {
          entryMode: 'marketplace-shell',
          runtimeSpecifier: '@gxfn/alembic-runtime@0.2.0',
        },
      },
    });
    expect(marker.runtimeModeSeparation.packaged.cacheIsolation).toContain('shell bootstrap');
    expect(marker.localProjection.mcpEntry).toMatchObject({
      exists: true,
      path: localEntry,
    });
    expect(marker.localProjection.requiredMarkerNames).toEqual(
      expect.arrayContaining([
        'releasedEmptySession',
        'coverageLedgerSeed',
        'noActionableHostAgentWork',
      ])
    );
    expect(marker.localProjection.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allRequiredMarkersPresent: true,
          id: 'knowledge-rescan-source',
          markerStatus: expect.objectContaining({
            coverageLedgerSeed: true,
            noActionableHostAgentWork: true,
            releasedEmptySession: true,
          }),
        }),
      ])
    );
    expect(marker.hashes.mcp).toMatch(/^[a-f0-9]{64}$/);
    expect(marker.hashes.startup).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'alembic-codex-cache-sync-'));
  roots.push(dir);
  return dir;
}

function runSyncScript(...args: string[]) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}
