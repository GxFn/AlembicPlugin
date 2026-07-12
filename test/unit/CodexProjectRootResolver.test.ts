import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  resolveProjectRootFromEnv,
  summarizeProjectRootResolution,
} from '../../lib/host-runtime/context/ProjectRootResolver.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('CodexProjectRootResolver', () => {
  test('trusts explicit projectRoot', () => {
    const projectRoot = makeDir('codex-root-explicit-');

    const resolution = resolveProjectRootFromEnv({ projectRoot });

    expect(resolution).toMatchObject({
      path: projectRoot,
      source: 'explicit-option',
      trust: 'trusted',
      rejected: false,
    });
  });

  test('trusts current host workspace environment variables', () => {
    const codexRoot = makeDir('codex-root-codex-');
    const workspaceRoot = makeDir('codex-root-workspace-');

    expect(resolveProjectRootFromEnv({ env: { CODEX_WORKSPACE_DIR: codexRoot } }).source).toBe(
      'CODEX_WORKSPACE_DIR'
    );
    expect(resolveProjectRootFromEnv({ env: { CODEX_WORKSPACE_ROOT: workspaceRoot } }).source).toBe(
      'CODEX_WORKSPACE_ROOT'
    );
  });

  test('trusts the current PWD when the host omits an explicit root', () => {
    const projectRoot = makeDir('codex-root-fallback-');
    const alembicHome = makeDir('codex-home-fallback-');

    const resolution = resolveProjectRootFromEnv({
      env: { ALEMBIC_HOME: alembicHome, PWD: projectRoot },
    });

    expect(resolution).toMatchObject({
      path: projectRoot,
      source: 'PWD',
      trust: 'trusted',
      rejected: false,
    });
  });

  test('rejects Codex plugin cache paths', () => {
    const alembicHome = makeDir('codex-home-cache-');
    const cacheRoot = path.join(
      makeDir('codex-home-'),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(cacheRoot, { recursive: true });

    const resolution = resolveProjectRootFromEnv({
      env: { ALEMBIC_HOME: alembicHome, PWD: cacheRoot },
    });

    expect(resolution).toMatchObject({
      path: cacheRoot,
      source: 'PWD',
      trust: 'rejected',
      rejected: true,
    });
    expect(resolution.reason).toContain('plugin cache');
    expect(summarizeProjectRootResolution(resolution)).toMatchObject({
      requiredActions: expect.arrayContaining([
        'Provide the target project root as an absolute path.',
      ]),
      userMessage: expect.stringContaining('project workflows cannot be used yet'),
    });
  });

  test('rejects missing directories', () => {
    const missingRoot = path.join(makeDir('codex-root-missing-parent-'), 'missing-project');

    const resolution = resolveProjectRootFromEnv({ projectRoot: missingRoot });

    expect(resolution).toMatchObject({
      path: missingRoot,
      source: 'explicit-option',
      trust: 'rejected',
      rejected: true,
    });
    expect(resolution.reason).toContain('does not exist');
  });
});
