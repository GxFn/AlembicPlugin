import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KnowledgeModule from '../../lib/injection/modules/KnowledgeModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

const cleanupRoots: string[] = [];

afterEach(() => {
  pathGuard._reset();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeExcludedSourceRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-plugin-source-'));
  cleanupRoots.push(root);
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'alembic-codex-plugin-runtime' }, null, 2)
  );
  return root;
}

function redirectedVectorRoot(projectRoot: string): string {
  const digest = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  const root = path.join(tmpdir(), 'alembic-dev', 'vector', digest);
  cleanupRoots.push(root);
  return root;
}

describe('KnowledgeModule runtime roots', () => {
  test('redirects vector runtime away from excluded source repositories', () => {
    const projectRoot = makeExcludedSourceRepo();
    const expectedRuntimeRoot = redirectedVectorRoot(projectRoot);
    const warn = vi.fn();
    const container = new ServiceContainer();
    container.singletons._projectRoot = projectRoot;
    container.singletons._config = { vector: { adapter: 'hnsw' } };
    container.singletons.logger = { warn };
    KnowledgeModule.register(container);

    container.get('vectorStore');

    expect(existsSync(path.join(projectRoot, '.asd'))).toBe(false);
    expect(existsSync(path.join(expectedRuntimeRoot, '.asd', 'context', 'index'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[vectorStore] Excluded project detected; redirecting vector runtime away from source repository',
      expect.objectContaining({ reason: 'Alembic 生态项目', redirectedRoot: expectedRuntimeRoot })
    );
  });
});
