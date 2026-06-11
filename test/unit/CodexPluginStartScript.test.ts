import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const projectRoot = process.cwd();
const probePath = join(projectRoot, 'scripts', 'probe-codex-plugin-startup-runtime.mjs');

describe('Codex plugin startup runtime script', () => {
  test('proves first-run install, cached reuse, offline reuse, replacement, and failures', () => {
    const output = execFileSync(process.execPath, [probePath], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const summary = JSON.parse(output) as {
      failureBranches: Record<string, string>;
      firstRunInstall: string;
      lockConcurrency: string;
      networkDisabledCached: string;
      ok: boolean;
      secondRunCached: string;
      staleLock: string;
      versionMismatchReplacement: string;
    };

    expect(summary).toMatchObject({
      ok: true,
      firstRunInstall: 'passed',
      secondRunCached: 'passed',
      networkDisabledCached: 'passed',
      versionMismatchReplacement: 'passed',
      staleLock: 'passed',
      lockConcurrency: 'passed',
    });
    expect(summary.failureBranches).toMatchObject({
      npmMissing: 'passed',
      cacheNotWritable: 'passed',
      installFailed: 'passed',
      versionMismatchAfterInstall: 'passed',
      entrypointMissing: 'passed',
      lockTimeout: 'passed',
    });
  }, 30_000);
});
