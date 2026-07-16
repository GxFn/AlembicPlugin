import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { EmbeddedToolExecutor } from '../../lib/host-runtime/mcp/host/embedded-executor.js';

const FIXTURE_ROOT = path.resolve('test/fixtures/strict-publication-v1/recipe-publications');
const SNAPSHOT_ID = 'snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d';
const SNAPSHOT_PATH = `snapshots/${SNAPSHOT_ID}`;
const roots: string[] = [];
const previousHome = process.env.ALEMBIC_HOME;

afterEach(() => {
  process.env.ALEMBIC_HOME = previousHome;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('strict-publication-v1 formal five-tool compatibility', () => {
  test('routes all five formal tools through one accepted publication and keeps calls read-only', async () => {
    const fixture = installFixture();
    const before = fingerprintTree(fixture.dataRoot);
    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    expect(runtime.contractVersion).toBe(3);
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'strict-publication-plugin-test',
      hostProjectRoot: fixture.projectRoot,
    });
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        [
          'alembic_search',
          { operation: 'search', query: 'strict result boundary', mode: 'semantic', limit: 3 },
        ],
        ['alembic_prime', { query: 'strict result boundary', limit: 3 }],
        ['alembic_recipe_map', { focus: { kind: 'space' }, nodeLimit: 40, recipeMountLimit: 20 }],
        [
          'alembic_code_guard',
          {
            operation: 'check',
            code: 'export function strictResult(value: string): string { return value; }',
            language: 'typescript',
          },
        ],
        ['alembic_graph', { queryKind: 'stats', budget: { itemLimit: 80 } }],
      ];
      const outputs: Record<string, Record<string, unknown>> = {};
      for (const [name, args] of calls) {
        outputs[name] = (await executor.execute(name, args, {
          projectRoot: fixture.projectRoot,
          projectRuntime: runtime,
        })) as Record<string, unknown>;
        expect(JSON.stringify(outputs[name])).not.toContain(
          'Plugin-owned Codex tool execution failed'
        );
        expect(asRecord(asRecord(outputs[name]._meta)?.alembicPublication)).toMatchObject({
          mode: 'strict-v1',
          routeState: 'ready',
          sessionId: 'strict-integration-run',
          snapshotId: 'snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d',
          vectorGenerationId: '75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5',
        });
      }
      const search = asRecord(outputs.alembic_search.structuredContent);
      expect(asRecord(search?.result)).toMatchObject({ semanticUsed: true, vectorUsed: true });
      const recipeMap = asRecord(outputs.alembic_recipe_map.structuredContent);
      expect(asRecord(recipeMap?.servingCoverage)).toMatchObject({
        source: 'strict-publication-v1',
        status: 'complete',
        totalCells: 6,
        coveredByReadyRecipe: 6,
        receiptHash: 'sha256:8d50b0a1820f94db3fe75a627e2c663bd384a5c0cb2973e5e4951339d140656a',
      });
      expect(JSON.stringify(outputs.alembic_graph)).not.toContain('strict-expression-module');
      expect(fingerprintTree(fixture.dataRoot)).toEqual(before);
      expect(findSidecars(fixture.dataRoot)).toEqual([]);
    } finally {
      await executor.dispose();
    }
  }, 30_000);

  test('strict route-null isolates legacy knowledge while Graph remains live-source', async () => {
    const fixture = installFixture();
    fs.rmSync(path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json'));
    fs.copyFileSync(
      path.join(
        FIXTURE_ROOT,
        'snapshots/snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d/data/.asd/alembic.db'
      ),
      path.join(fixture.dataRoot, '.asd/alembic.db')
    );
    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'strict-route-null-test',
      hostProjectRoot: fixture.projectRoot,
    });
    try {
      for (const [name, args] of [
        ['alembic_search', { query: 'strict' }],
        ['alembic_prime', { query: 'strict' }],
        ['alembic_recipe_map', {}],
        ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await executor.execute(name, args, {
          projectRoot: fixture.projectRoot,
          projectRuntime: runtime,
        });
        expect(JSON.stringify(result)).toContain('strict-publication-route-unavailable');
        expect(JSON.stringify(result)).not.toContain('strict-expression-module');
      }
      const graph = await executor.execute(
        'alembic_graph',
        {
          queryKind: 'file-symbols',
          filePath: 'src/index.ts',
          budget: { itemLimit: 80 },
        },
        { projectRoot: fixture.projectRoot, projectRuntime: runtime }
      );
      expect(JSON.stringify(graph)).toContain('src/index.ts');
      expect(JSON.stringify(graph)).not.toContain('strict-expression-module');
    } finally {
      await executor.dispose();
    }
  }, 30_000);

  test.each([
    [
      'database is missing',
      (publicationRoot: string) => {
        fs.rmSync(path.join(publicationRoot, SNAPSHOT_PATH, 'data/.asd/alembic.db'));
      },
    ],
    [
      'Recipe is tampered',
      (publicationRoot: string) => {
        tamper(
          path.join(
            publicationRoot,
            SNAPSHOT_PATH,
            'data/Alembic/recipes/testing-quality/strict-expression-module-src-testing-quality.md'
          )
        );
      },
    ],
    [
      'vector store is missing',
      (publicationRoot: string) => {
        fs.rmSync(
          path.join(
            publicationRoot,
            SNAPSHOT_PATH,
            'data/.asd/context/recipe-vector-generations/75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5/store/.asd/context/index/vector_index.json'
          )
        );
      },
    ],
    [
      'final coverage is tampered',
      (publicationRoot: string) => {
        tamper(path.join(publicationRoot, SNAPSHOT_PATH, 'final-coverage.json'));
      },
    ],
  ])(
    'keeps formal Graph live when pointed knowledge %s and fails four knowledge tools closed',
    async (_label, mutatePublication) => {
      const fixture = installFixture();
      const publicationRoot = path.join(fixture.dataRoot, '.asd/context/recipe-publications');
      mutatePublication(publicationRoot);
      const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
      const executor = new EmbeddedToolExecutor({
        getSessionId: () => 'strict-graph-isolation-test',
        hostProjectRoot: fixture.projectRoot,
      });
      try {
        const graph = await executor.execute(
          'alembic_graph',
          {
            queryKind: 'file-symbols',
            filePath: 'src/index.ts',
            budget: { itemLimit: 80 },
          },
          { projectRoot: fixture.projectRoot, projectRuntime: runtime }
        );
        expect(JSON.stringify(graph)).toContain('src/index.ts');
        expect(JSON.stringify(graph)).not.toContain('Plugin-owned Codex tool execution failed');
        const graphRecord = asRecord(graph);
        const graphMeta = asRecord(graphRecord?._meta);
        expect(asRecord(graphMeta?.alembicPublication)).toMatchObject({
          mode: 'strict-v1',
          routeState: 'ready',
          sessionId: 'strict-integration-run',
          snapshotId: SNAPSHOT_ID,
        });

        for (const [name, args] of [
          ['alembic_search', { query: 'strict' }],
          ['alembic_prime', { query: 'strict' }],
          ['alembic_recipe_map', {}],
          ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
        ] as Array<[string, Record<string, unknown>]>) {
          const result = await executor.execute(name, args, {
            projectRoot: fixture.projectRoot,
            projectRuntime: runtime,
          });
          expect(JSON.stringify(result), name).toContain('STRICT_PUBLICATION_');
        }
      } finally {
        await executor.dispose();
      }
    },
    30_000
  );
});

function tamper(filePath: string): void {
  fs.chmodSync(filePath, 0o600);
  fs.appendFileSync(filePath, '\n ');
}

function installFixture(): { dataRoot: string; projectRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-five-tool-plugin-'));
  roots.push(root);
  process.env.ALEMBIC_HOME = root;
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src/index.ts'),
    'export function liveProjectSource(value: string): string { return value; }\n'
  );
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'strict-publication-live-project', type: 'module' })
  );
  fs.mkdirSync(dataRoot, { recursive: true });
  const descriptor = createProjectDescriptor({
    controlRoot: root,
    dataRoot,
    projectId: 'project-strict-main',
    projectScopeId: 'scope-strict-main',
    currentFolderId: 'folder-strict-main',
    folders: [{ id: 'folder-strict-main', path: projectRoot }],
  });
  fs.mkdirSync(path.join(root, '.asd'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([descriptor]))
  );
  fs.mkdirSync(path.join(dataRoot, '.asd/context'), { recursive: true });
  fs.cpSync(FIXTURE_ROOT, path.join(dataRoot, '.asd/context/recipe-publications'), {
    recursive: true,
  });
  return { dataRoot, projectRoot };
}

function fingerprintTree(root: string): Record<string, string> {
  return Object.fromEntries(
    walk(root).map((file) => [path.relative(root, file), fs.readFileSync(file).toString('base64')])
  );
}

function findSidecars(root: string): string[] {
  return walk(root)
    .filter((file) => /(?:-wal|-shm)$/u.test(file))
    .map((file) => path.relative(root, file));
}

function walk(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
