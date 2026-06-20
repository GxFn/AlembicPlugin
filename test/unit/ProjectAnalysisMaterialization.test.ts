import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateProjectAnalysisIncrementalPlan,
  FileDiffSnapshotStore,
  LanguageService,
} from '@alembic/core/test-fixtures';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = resolve(repoRoot, '..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('ProjectAnalysis materialization route boundary', () => {
  test('does not keep the retired project-intelligence aggregate as a plugin residual', () => {
    const corePackage = readJson<{ exports: Record<string, unknown> }>(
      resolve(workspaceRoot, 'AlembicCore/package.json')
    );
    const allowlist = readJson<{
      allowedSpecifiers: string[];
      keepWithOwner: Record<string, unknown>;
      referenceLimits: Record<string, number>;
    }>(resolve(repoRoot, 'config/core-import-boundary-allowlist.json'));

    expect(corePackage.exports['./project-intelligence']).toBeUndefined();
    expect(corePackage.exports['./test-fixtures']).toMatchObject({
      import: './dist/test-fixtures.js',
    });
    expect(allowlist.referenceLimits['@alembic/core/project-intelligence']).toBeUndefined();
    expect(allowlist.keepWithOwner['@alembic/core/project-intelligence']).toBeUndefined();
    expect(allowlist.allowedSpecifiers).not.toContain('@alembic/core/project-intelligence');
  });

  test('keeps migrated project-analysis fixtures on a resolvable test-fixtures route', () => {
    expect(LanguageService.detectProjectLanguages('/project', { discovererIds: ['go'] })).toEqual([
      'go',
    ]);
    expect(evaluateProjectAnalysisIncrementalPlan).toBeTypeOf('function');
    expect(FileDiffSnapshotStore).toBeTypeOf('function');
  });
});
