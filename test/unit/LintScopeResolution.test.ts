import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/lint-scope-resolution.mjs', import.meta.url)
);
const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

function createFixture(contents: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-plugin-scope-lint-'));
  tempRoots.push(root);
  const workflowDir = path.join(root, 'lib', 'recipe-generation', 'host-agent-workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, 'project-data-root.ts'), contents);
  return root;
}

function runLint(root: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
    encoding: 'utf8',
  });
}

describe('lint-scope-resolution', () => {
  test('rejects bare WorkspaceResolver.fromProject calls in Plugin scan/write paths', () => {
    const root = createFixture(`
      import { WorkspaceResolver } from '@alembic/core/workspace';
      export const dataRoot = WorkspaceResolver.fromProject('/workspace/AlembicPlugin').dataRoot;
    `);

    const result = runLint(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scope-resolution lint failed');
    expect(result.stderr).toContain('project-data-root.ts:3');
  });

  test('accepts project-scope registry calls in Plugin scan/write paths', () => {
    const root = createFixture(`
      import { WorkspaceResolver } from '@alembic/core/workspace';
      export const dataRoot = WorkspaceResolver.fromProjectScopeRegistry('/workspace/AlembicPlugin').dataRoot;
    `);

    const result = runLint(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('scope-resolution lint passed');
  });

  test('accepts explicit single-root annotations for intentional exceptions', () => {
    const root = createFixture(`
      import { WorkspaceResolver } from '@alembic/core/workspace';
      // @scope-singleroot(permanent) - fixture verifies intentional single-root escape.
      export const dataRoot = WorkspaceResolver.fromProject('/workspace/AlembicPlugin').dataRoot;
    `);

    const result = runLint(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('scope-resolution lint passed');
  });
});
