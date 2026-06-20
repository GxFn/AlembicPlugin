import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildProjectRootRequiredMessage,
  getSavedProjectRootPath,
  readSavedProjectRoot,
  resolveProjectRootFromEnv,
  summarizeProjectRootResolution,
  writeSavedProjectRoot,
} from '../../lib/runtime/ProjectRootResolver.js';
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

  test('saves explicit projectRoot as diagnostics without reusing it as effective identity', () => {
    const projectRoot = makeDir('codex-root-saved-');
    const alembicHome = makeDir('codex-home-saved-');
    const env = { ALEMBIC_HOME: alembicHome } as NodeJS.ProcessEnv;

    const saved = writeSavedProjectRoot(projectRoot, env);
    const resolution = resolveProjectRootFromEnv({ env });

    expect(fs.existsSync(getSavedProjectRootPath(env))).toBe(true);
    expect(readSavedProjectRoot(env)).toMatchObject({
      projectRoot,
      source: 'explicit-projectRoot',
    });
    expect(saved.projectRoot).toBe(projectRoot);
    expect(resolution).toMatchObject({
      source: 'process.cwd',
      trust: 'fallback',
      rejected: false,
    });
    expect(resolution.path).not.toBe(projectRoot);
  });

  test('trusts Alembic and Codex workspace environment variables', () => {
    const alembicRoot = makeDir('codex-root-alembic-');
    const codexRoot = makeDir('codex-root-codex-');
    const workspaceRoot = makeDir('codex-root-workspace-');

    expect(resolveProjectRootFromEnv({ env: { ALEMBIC_PROJECT_DIR: alembicRoot } }).source).toBe(
      'ALEMBIC_PROJECT_DIR'
    );
    expect(resolveProjectRootFromEnv({ env: { CODEX_WORKSPACE_DIR: codexRoot } }).source).toBe(
      'CODEX_WORKSPACE_DIR'
    );
    expect(resolveProjectRootFromEnv({ env: { CODEX_WORKSPACE_ROOT: workspaceRoot } }).source).toBe(
      'CODEX_WORKSPACE_ROOT'
    );
  });

  test('reports fallback roots without trusting them for initialization', () => {
    const projectRoot = makeDir('codex-root-fallback-');
    const alembicHome = makeDir('codex-home-fallback-');

    const resolution = resolveProjectRootFromEnv({
      env: { ALEMBIC_HOME: alembicHome, PWD: projectRoot },
    });

    expect(resolution).toMatchObject({
      path: projectRoot,
      source: 'PWD',
      trust: 'fallback',
      rejected: false,
    });
    expect(buildProjectRootRequiredMessage(resolution)).toContain(
      'cannot determine the target project directory'
    );
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
