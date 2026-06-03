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
      mode: string;
      ok: boolean;
      plan: { syncCommand: string[] };
      reportPath: string;
    };

    expect(report).toMatchObject({
      canonicalCommand: 'npm run dev:codex-plugin:reload',
      mode: 'local-dev-reload',
      ok: true,
      reportPath,
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
    };
    const persisted = JSON.parse(readFileSync(join(root, 'refresh-report.json'), 'utf8')) as {
      legacyAlias: string;
    };

    expect(report).toMatchObject({
      canonicalCommand: 'npm run dev:codex-plugin:reload',
      legacyAlias: 'refresh',
      ok: true,
    });
    expect(persisted.legacyAlias).toBe('refresh');
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
