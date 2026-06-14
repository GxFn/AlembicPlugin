import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = join(projectRoot, 'scripts', 'dev-reload-codex-plugin.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex plugin local-dev reload script', () => {
  test('prints a canonical dry-run plan for local cache rewrite and probe', () => {
    const root = tempDir();
    const reportPath = join(root, 'reload-report.json');
    const output = runReloadScript(
      '--dry-run',
      '--codex-home',
      join(root, 'codex-home'),
      '--sync-target',
      join(root, 'installed-cache'),
      '--project-root',
      root,
      '--report-path',
      reportPath
    );
    const report = JSON.parse(output) as {
      canonicalCommand: string;
      mcpProcessHandling: string;
      mode: string;
      ok: boolean;
      plan: {
        currentHostMcpProcessLifecycle: string;
        freshMcpReadback: {
          expectedDiagnosticsTool: string;
          expectedToolCall: string;
          expectedToolCalls: string[];
          requiresFreshProcess: boolean;
        };
        syncCommand: string[];
      };
      readbackProof: {
        expectedDiagnosticsTool: string;
        expectedToolCall: string;
        expectedToolCalls: string[];
        requiresFreshProcess: boolean;
      };
      reportPath: string;
      runtimeModeSeparation: {
        activeMode: string;
        localDev: { entryMode: string };
        packaged: { cacheIsolation: string; entryMode: string; usedByReload: boolean };
      };
    };

    expect(report).toMatchObject({
      canonicalCommand: 'npm run dev:codex-plugin:reload',
      mcpProcessHandling: 'not-managed-by-plugin',
      mode: 'local-dev-reload',
      ok: true,
      reportPath,
    });
    expect(report.plan.currentHostMcpProcessLifecycle).toBe('not-managed-by-plugin');
    expect(report.readbackProof).toMatchObject({
      expectedEntryMode: 'local-dev-direct-dist',
      expectedDiagnosticsTool: 'alembic_codex_diagnostics',
      expectedToolCall: 'alembic_mcp_status',
      expectedToolCalls: ['alembic_mcp_status', 'alembic_codex_diagnostics'],
      requiresFreshProcess: true,
    });
    expect(report.runtimeModeSeparation).toMatchObject({
      activeMode: 'local-dev-direct-dist',
      localDev: { entryMode: 'local-dev-direct-dist' },
      packaged: {
        entryMode: 'marketplace-shell',
        usedByReload: false,
      },
    });
    expect(report.runtimeModeSeparation.packaged.cacheIsolation).toContain('shell bootstrap');
    expect(report.plan.freshMcpReadback).toMatchObject({
      expectedEntryMode: 'local-dev-direct-dist',
      expectedDiagnosticsTool: 'alembic_codex_diagnostics',
      expectedToolCall: 'alembic_mcp_status',
      expectedToolCalls: ['alembic_mcp_status', 'alembic_codex_diagnostics'],
      requiresFreshProcess: true,
    });
    expect(report.plan.syncCommand).toEqual(
      expect.arrayContaining([
        '--clean',
        '--all-installed',
        '--local-mcp',
        '--codex-home',
        join(root, 'codex-home'),
        '--target-root',
        join(root, 'installed-cache'),
      ])
    );
    expect(existsSync(reportPath)).toBe(true);
  });

  test('marks dev refresh as a compatibility alias only', () => {
    const root = tempDir();
    const output = runReloadScript(
      '--dry-run',
      '--legacy-refresh',
      '--report-path',
      join(root, 'refresh-report.json')
    );
    const report = JSON.parse(output) as {
      canonicalCommand: string;
      legacyAlias: string;
      ok: boolean;
      runtimeModeSeparation: {
        activeMode: string;
        localDev: { command: string };
        packaged: { usedByReload: boolean };
      };
    };
    const persisted = JSON.parse(readFileSync(join(root, 'refresh-report.json'), 'utf8')) as {
      legacyAlias: string;
    };

    expect(report).toMatchObject({
      canonicalCommand: 'npm run dev:codex-plugin:reload',
      legacyAlias: 'refresh',
      ok: true,
      runtimeModeSeparation: {
        activeMode: 'local-dev-direct-dist',
        localDev: { command: 'npm run dev:codex-plugin:reload' },
        packaged: { usedByReload: false },
      },
    });
    expect(persisted.legacyAlias).toBe('refresh');
  });

  test('rejects removed current MCP lifecycle flags', () => {
    const root = tempDir();

    expect(() =>
      runReloadScript('--dry-run', '--stop-mcp', '--report-path', join(root, 'reload-report.json'))
    ).toThrow(/does not manage the current Codex MCP process lifecycle/);

    expect(() =>
      runReloadScript(
        '--dry-run',
        '--no-stop-mcp',
        '--report-path',
        join(root, 'reload-report.json')
      )
    ).toThrow(/does not manage the current Codex MCP process lifecycle/);
  });

  test('watch mode rejects removed current MCP lifecycle flags', () => {
    const root = tempDir();
    const watchScriptPath = join(projectRoot, 'scripts', 'dev-watch-codex-plugin.mjs');

    expect(() =>
      execFileSync(
        process.execPath,
        [watchScriptPath, '--once', '--restart-mcp', '--report-path', join(root, 'watch.json')],
        {
          cwd: projectRoot,
          encoding: 'utf8',
        }
      )
    ).toThrow(/does not manage the current Codex MCP process lifecycle/);

    expect(() =>
      execFileSync(
        process.execPath,
        [watchScriptPath, '--once', '--no-restart-mcp', '--report-path', join(root, 'watch.json')],
        {
          cwd: projectRoot,
          encoding: 'utf8',
        }
      )
    ).toThrow(/does not manage the current Codex MCP process lifecycle/);
  });

  test('help text does not advertise current MCP lifecycle flags', () => {
    const output = runReloadScript('--help');
    const watchOutput = execFileSync(
      process.execPath,
      [join(projectRoot, 'scripts', 'dev-watch-codex-plugin.mjs'), '--help'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      }
    );

    expect(output).not.toContain('--stop-mcp');
    expect(output).not.toContain('--no-stop-mcp');
    expect(watchOutput).not.toContain('--restart-mcp');
    expect(watchOutput).not.toContain('--no-restart-mcp');
    expect(output).toContain('It never inspects, stops, or restarts the current');
    expect(output).toContain('validates');
    expect(output).toContain('projectRuntime identity');
    expect(watchOutput).toContain('It never restarts the current Codex MCP transport.');
  });

  test('dry run keeps current MCP process management out of the report', () => {
    const root = tempDir();
    const output = runReloadScript('--dry-run', '--report-path', join(root, 'reload-report.json'));
    const report = JSON.parse(output) as {
      mcpProcessHandling: string;
      plan: Record<string, unknown>;
    };

    expect(report.mcpProcessHandling).toBe('not-managed-by-plugin');
    expect(report.plan).not.toHaveProperty('stopOldMcpProcesses');
  });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'alembic-codex-dev-reload-'));
  roots.push(dir);
  return dir;
}

function runReloadScript(...args: string[]) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}
