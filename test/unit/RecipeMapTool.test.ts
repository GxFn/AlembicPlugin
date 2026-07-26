import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecipeContextServiceFromCore } from '@alembic/core/recipe-context-capabilities';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  routeGraphTool,
  routeRecipeMapTool,
} from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/host-runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/host-runtime/mcp/tools.js';
import { createReadOnlyRecipeMapRepositories } from '../../lib/repository/recipe-map/ReadOnlyRecipeMapServices.js';
import {
  type AlembicRecipeMapOutput,
  AlembicRecipeMapOutputSchema,
} from '../../lib/service/project-knowledge-context/contracts/AlembicRecipeMapOutput.js';
import { defaultProjectGraphProvider } from '../../lib/service/project-knowledge-context/project/ProjectGraphProvider.js';
import {
  defaultRecipeMapProvider,
  normalizeRecipeRef,
  type RecipeMapDeps,
  type RecipeMapRequest,
} from '../../lib/service/project-knowledge-context/recipe-map/index.js';
import { ProjectContextBuildSessionManager } from '../../lib/service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';

const tempRoots: string[] = [];
const BASE_SNAPSHOT_ID = `snapshot-${'a'.repeat(64)}`;
const RECOVERED_SNAPSHOT_ID = `${BASE_SNAPSHOT_ID}-529c0223-fccc-41df-be50-20b6e25826b5`;

const RECIPES = [
  { id: 'r-global', title: 'Architecture overview', scope: 'global', tags: [], sources: [] },
  { id: 'r-file', title: 'Index file rule', tags: [], sources: [] },
  { id: 'r-multi', title: 'Cross-file pattern', tags: [], sources: [] },
  { id: 'r-stale', title: 'Stale rule', tags: [], sources: [] },
];
const ROWS = [
  { recipeId: 'r-file', sourcePath: 'lib/index.ts:2', status: 'active' },
  { recipeId: 'r-multi', sourcePath: 'lib/index.ts', status: 'active' },
  { recipeId: 'r-multi', sourcePath: 'lib/helper.ts', status: 'active' },
  { recipeId: 'r-stale', sourcePath: 'lib/index.ts:99', status: 'stale' },
];

function fakeDeps(): RecipeMapDeps {
  return {
    resolveRegion: (focus, projectRoot) =>
      defaultProjectGraphProvider.resolveProjectContextRegion({ focus, projectRoot }),
    querySourceRefs: async () => ({ rows: ROWS, diagnostics: [] }),
    listRecipes: async () => RECIPES,
  };
}

function request(projectRoot: string, kind: string, filePath?: string): RecipeMapRequest {
  const focus = { kind: kind as never, ...(filePath ? { filePath } : {}) };
  return {
    focus,
    rawFocus: focus,
    projectRoot,
    radius: {},
    includeRecipes: true,
    includeRollups: true,
    recipeMountLimit: 50,
    nodeLimit: 60,
    detailLevel: 'summary',
  };
}

async function recipeMap(projectRoot: string, kind: string, filePath?: string) {
  return defaultRecipeMapProvider.resolveRecipeMap(
    request(projectRoot, kind, filePath),
    fakeDeps()
  );
}

describe('alembic_recipe_map (GMAP-4-7)', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('top-level focus surfaces global no-code mounts + rollups, code Recipes bucket below root', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'space');
    expect(AlembicRecipeMapOutputSchema.parse(output)).toEqual(output);

    const mountIds = output.recipeMounts.map((mount) => mount.recipeId);
    expect(mountIds).toContain('r-global');
    expect(output.recipeMounts.find((mount) => mount.recipeId === 'r-global')?.mountType).toBe(
      'global-no-code'
    );
    // P-D D2(2026-07-11):space 区域扩容 target/module 后,代码 Recipe 允许出现在
    // 顶层 mounts,但必须桶到 module/target 级锚点,绝不淹没 root——旧断言
    // "not.toContain(r-file)" 写于 space 无 module 节点的年代(彼时文件 Recipe
    // 根本无处可挂,BiliDili 真机 75 条恒 0 mounts)。
    const rootNodeId = output.region.rootNode.nodeId;
    for (const mount of output.recipeMounts) {
      if (mount.recipeId === 'r-global') {
        continue;
      }
      expect(mount.mountNodeId).not.toBe(rootNodeId);
    }
    // The deeper Recipes still appear as descendant rollups on the root.
    const rootRollup = output.recipeRollups.find((rollup) => rollup.nodeId === rootNodeId);
    expect(rootRollup?.descendantRecipeCount ?? 0).toBeGreaterThanOrEqual(2);
    expect(new Set(output.recipeRollups.map((rollup) => rollup.nodeId)).size).toBe(
      output.recipeRollups.length
    );
    const scriptNodes = output.region.nodes.filter((node) => node.label.startsWith('script:'));
    expect(scriptNodes.length).toBeGreaterThan(0);
    expect(scriptNodes.every((node) => node.kind === 'target')).toBe(true);
    expect((output as unknown as Record<string, unknown>).projectCoverageStatus).toBe(
      'unavailable'
    );
    expect((output as unknown as Record<string, unknown>).finalCoverageReceipt).toBeNull();
    expect(
      (output.conservation as unknown as Record<string, unknown>).mountAccountingCompleteness
    ).toBe('complete');
  });

  test('serving coverage consumes the Core strict snapshot-id contract', async () => {
    const output = await recipeMap(createFixtureProject(), 'space');
    const servingCoverage = {
      source: 'strict-publication-v1' as const,
      status: 'complete' as const,
      snapshotId: RECOVERED_SNAPSHOT_ID,
      receiptHash: `sha256:${'b'.repeat(64)}`,
      totalCells: 1,
      coveredByReadyRecipe: 1,
      investigatedEmpty: 0,
      failed: 0,
      unknown: 0,
      displayedCells: 1,
      remainingCells: 0,
      cells: [
        {
          cellId: 'module:strict-snapshot-contract',
          finalDisposition: 'covered-by-ready-recipe' as const,
          finalRecipeCount: 1,
        },
      ],
      continuation: { offset: 0, limit: 25, nextOffset: null, hasMore: false },
    };
    expect(
      AlembicRecipeMapOutputSchema.parse({ ...output, servingCoverage }).servingCoverage?.snapshotId
    ).toBe(RECOVERED_SNAPSHOT_ID);
    expect(
      AlembicRecipeMapOutputSchema.parse({
        ...output,
        servingCoverage: { ...servingCoverage, snapshotId: BASE_SNAPSHOT_ID },
      }).servingCoverage?.snapshotId
    ).toBe(BASE_SNAPSHOT_ID);

    for (const snapshotId of [
      `snapshot-${'A'.repeat(64)}`,
      `${BASE_SNAPSHOT_ID}-529c0223-fccc-31df-be50-20b6e25826b5`,
      `${RECOVERED_SNAPSHOT_ID}-extra`,
      `${BASE_SNAPSHOT_ID}/529c0223-fccc-41df-be50-20b6e25826b5`,
      '../private-candidate',
      `.${path.sep}${BASE_SNAPSHOT_ID}`,
    ]) {
      expect(
        AlembicRecipeMapOutputSchema.safeParse({
          ...output,
          servingCoverage: { ...servingCoverage, snapshotId },
        }).success,
        snapshotId
      ).toBe(false);
    }
  });

  test('public Recipe Map returns opaque deterministic continuation pages without rebuilding facts', async () => {
    const projectRoot = createFixtureProject();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const ctx = createContext(projectRoot);
    ctx.projectContextExecution = { buildSessions: manager };
    const first = (await routeRecipeMapTool(ctx, {
      focus: { kind: 'space' },
      pageSize: 1,
      projectRoot,
    })) as { structuredContent: AlembicRecipeMapOutput };
    expect(first.structuredContent.continuation?.hasMore).toBe(true);
    expect(first.structuredContent.continuation?.resultRef).not.toContain(projectRoot);
    const factSessionRef = first.structuredContent.continuation?.factSessionRef;
    let cursor = first.structuredContent.continuation?.nextCursor ?? null;
    let pages = 1;
    const stableIds = first.structuredContent.region.nodes.map((node) => node.nodeId);
    while (cursor) {
      const next = (await routeRecipeMapTool(ctx, { cursor, projectRoot })) as {
        structuredContent: AlembicRecipeMapOutput;
      };
      pages += 1;
      expect(next.structuredContent.continuation?.factSessionRef).toBe(factSessionRef);
      const typeAccounting = (
        next.structuredContent.continuation as unknown as {
          typeAccounting?: Record<
            string,
            { shown: number; total: number; remaining: number; cumulative: number }
          >;
        }
      ).typeAccounting;
      expect(typeAccounting).toBeDefined();
      for (const accounting of Object.values(typeAccounting ?? {})) {
        expect(accounting.cumulative + accounting.remaining).toBe(accounting.total);
        expect(accounting.shown).toBeGreaterThanOrEqual(0);
      }
      stableIds.push(...next.structuredContent.region.nodes.map((node) => node.nodeId));
      cursor = next.structuredContent.continuation?.nextCursor ?? null;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(stableIds).size).toBe(stableIds.length);
    expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);
    await manager.dispose();
  });

  test('continuation cancellation reports incomplete conservation and removes chunks', async () => {
    const projectRoot = createFixtureProject();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const ctx = createContext(projectRoot);
    ctx.projectContextExecution = { buildSessions: manager };
    try {
      const first = (await routeRecipeMapTool(ctx, {
        focus: { kind: 'space' },
        pageSize: 1,
        projectRoot,
      })) as { structuredContent: AlembicRecipeMapOutput };
      const cursor = first.structuredContent.continuation?.nextCursor;
      expect(cursor).toBeTruthy();
      const cancelled = (await routeRecipeMapTool(ctx, {
        cancelCursor: cursor,
        projectRoot,
      })) as { structuredContent: AlembicRecipeMapOutput };

      expect(cancelled.structuredContent.conservation).toMatchObject({
        completeness: 'incomplete',
        displayedMounts: 0,
      });
      expect(cancelled.structuredContent.continuation).toMatchObject({
        hasMore: false,
        nextCursor: null,
      });
      expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  test('public continuation reconstructs the complete bounded Recipe Map exactly once', async () => {
    const projectRoot = createFixtureProject();
    for (let index = 0; index < 96; index += 1) {
      fs.writeFileSync(
        path.join(projectRoot, 'lib', `page-${String(index).padStart(3, '0')}.ts`),
        `export const page${index} = ${index};\n`
      );
    }
    const recipeIds = Array.from({ length: 30 }, (_, index) => `r-page-${index}`);
    const recipeRecords = recipeIds.map((id, index) => ({
      id,
      sources: [],
      tags: [],
      title: `Page recipe ${index}`,
    }));
    const recipeRows = recipeIds.map((recipeId, index) => ({
      recipeId,
      sourcePath: `lib/page-${String(index).padStart(3, '0')}.ts:1`,
      status: 'active',
    }));
    const completeRecipeContext: RecipeMapDeps = {
      resolveRegion: (focus, root, radius) =>
        defaultProjectGraphProvider.resolveProjectContextRegion({
          focus,
          projectRoot: root,
          radius,
        }),
      querySourceRefs: async () => ({ rows: recipeRows, diagnostics: [] }),
      listRecipes: async () => recipeRecords,
    };
    const baseline = await defaultRecipeMapProvider.resolveBoundedRecipeMap(
      { ...request(projectRoot, 'space'), nodeLimit: 500 },
      completeRecipeContext
    );
    const expectedKeys = recipeMapStableKeys(baseline).sort();

    const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipemap-pages-db-'));
    tempRoots.push(databaseRoot);
    const db = new Database(path.join(databaseRoot, 'alembic.db'));
    db.exec(`
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tags TEXT NOT NULL,
        sources TEXT NOT NULL
      );
      CREATE TABLE recipe_source_refs (
        recipe_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        status TEXT NOT NULL,
        new_path TEXT,
        verified_at INTEGER,
        PRIMARY KEY (recipe_id, source_path)
      );
    `);
    const insertRecipe = db.prepare(
      'INSERT INTO knowledge_entries (id, title, tags, sources) VALUES (?, ?, ?, ?)'
    );
    const insertRef = db.prepare(
      'INSERT INTO recipe_source_refs (recipe_id, source_path, status) VALUES (?, ?, ?)'
    );
    for (let index = 0; index < recipeIds.length; index += 1) {
      insertRecipe.run(recipeIds[index], `Page recipe ${index}`, '[]', '[]');
      insertRef.run(recipeIds[index], recipeRows[index].sourcePath, 'active');
    }
    db.pragma('query_only = ON');
    const repositories = createReadOnlyRecipeMapRepositories(db);
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const ctx = createContext(projectRoot, {
      knowledgeService: repositories.knowledgeService,
      recipeSourceRefRepository: repositories.sourceRefRepository,
    });
    ctx.projectContextExecution = { buildSessions: manager };
    try {
      let result = (await routeRecipeMapTool(ctx, {
        focus: { kind: 'space' },
        nodeLimit: 500,
        pageSize: 10,
        projectRoot,
      })) as { structuredContent: AlembicRecipeMapOutput };
      const factSessionRef = result.structuredContent.continuation?.factSessionRef;
      const actualKeys: string[] = [];
      let pages = 0;
      let terminal = result.structuredContent;
      while (true) {
        pages += 1;
        terminal = result.structuredContent;
        expect(Buffer.byteLength(JSON.stringify(terminal), 'utf8')).toBeLessThanOrEqual(20 * 1024);
        expect(terminal.continuation?.factSessionRef).toBe(factSessionRef);
        actualKeys.push(...recipeMapStableKeys(terminal));
        const cursor = terminal.continuation?.nextCursor;
        if (!cursor) {
          break;
        }
        result = (await routeRecipeMapTool(ctx, { cursor, projectRoot })) as {
          structuredContent: AlembicRecipeMapOutput;
        };
      }

      expect(pages).toBeGreaterThanOrEqual(3);
      expect(new Set(actualKeys).size).toBe(actualKeys.length);
      expect(actualKeys.sort()).toEqual(expectedKeys);
      expect(terminal.status).toBe(baseline.status);
      expect(terminal.region.truncated).toBe(baseline.region.truncated);
      expect(terminal.conservation).toEqual(baseline.conservation);
      expect(terminal.limits.appliedRecipeMountLimit).toBe(baseline.limits.appliedRecipeMountLimit);
      expect(terminal.continuation?.hasMore).toBe(false);
      expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);
    } finally {
      await manager.dispose();
      db.close();
    }
  });

  test('module focus mounts directly and resolves multi-ref to the lowest common ancestor', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'module');
    const byId = new Map(output.recipeMounts.map((mount) => [mount.recipeId, mount]));

    expect(byId.get('r-file')?.mountNodeId).toBe('file:lib/index.ts');
    expect(byId.get('r-file')?.mountType).toBe('source-line');
    // Two refs in lib/ → lowest common ancestor (directory), not the project root.
    expect(byId.get('r-multi')?.mountType).toBe('multi-ref-common-ancestor');
    expect(byId.get('r-multi')?.mountNodeId).toBe('directory:lib');
    expect(byId.get('r-global')?.mountType).toBe('global-no-code');
  });

  test('file focus mounts source refs onto the file node', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'file', 'lib/index.ts');
    expect(output.region.rootNode.nodeId).toBe('file:lib/index.ts');
    const fileMount = output.recipeMounts.find((mount) => mount.recipeId === 'r-file');
    expect(fileMount?.mountNodeId).toBe('file:lib/index.ts');
    expect(['source-line', 'source-file', 'source-range']).toContain(fileMount?.mountType);
  });

  test('falls back to Recipe record sources when recipe_source_refs has no rows', async () => {
    const projectRoot = createFixtureProject();
    const output = await defaultRecipeMapProvider.resolveRecipeMap(
      request(projectRoot, 'file', 'lib/index.ts'),
      {
        ...fakeDeps(),
        querySourceRefs: async () => ({ rows: [], diagnostics: [] }),
        listRecipes: async () => [
          {
            id: 'r-global',
            title: 'Architecture overview',
            scope: 'global',
            tags: [],
            sources: [],
          },
          {
            id: 'r-file',
            title: 'Index file rule',
            tags: [],
            sources: ['lib/index.ts:2'],
          },
          {
            id: 'r-helper',
            title: 'Helper file rule',
            tags: [],
            sources: ['lib/helper.ts:1'],
          },
        ],
      }
    );

    const byId = new Map(output.recipeMounts.map((mount) => [mount.recipeId, mount]));
    expect(byId.get('r-file')?.mountNodeId).toBe('file:lib/index.ts');
    expect(byId.get('r-file')?.sourceRefs).toEqual(['lib/index.ts:2']);
    expect(byId.get('r-helper')?.mountNodeId).toBe('directory:lib');
    expect(byId.get('r-helper')?.sourceRefs).toEqual(['lib/helper.ts:1']);
    expect(byId.has('r-global')).toBe(false);
  });

  test('file focus does not attach unrelated metadata-only Recipes to the file root', async () => {
    const projectRoot = createFixtureProject();
    const output = await defaultRecipeMapProvider.resolveRecipeMap(
      request(projectRoot, 'file', 'lib/index.ts'),
      {
        ...fakeDeps(),
        listRecipes: async () => [
          ...RECIPES,
          {
            id: 'r-unresolved-meta',
            moduleName: 'MissingModule',
            sources: [],
            tags: [],
            title: 'Missing module metadata',
          },
          {
            id: 'r-unspecified-meta',
            sources: [],
            tags: [],
            title: 'Unscoped metadata',
          },
        ],
      }
    );

    const mountIds = output.recipeMounts.map((mount) => mount.recipeId);
    expect(mountIds).toContain('r-file');
    expect(mountIds).not.toContain('r-global');
    expect(mountIds).not.toContain('r-unresolved-meta');
    expect(mountIds).not.toContain('r-unspecified-meta');
    expect(
      output.recipeMounts.filter(
        (mount) =>
          mount.mountNodeId === output.region.rootNode.nodeId &&
          mount.sourceRefs.length === 0 &&
          (mount.mountType === 'metadata-scope' || mount.mountType === 'global-no-code')
      )
    ).toEqual([]);
  });

  test('stale source refs degrade to a diagnostic and a degraded mount, never dropped', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'module');
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain('recipe-stale-ref');
    const staleMount = output.recipeMounts.find((mount) => mount.recipeId === 'r-stale');
    expect(staleMount?.mountType).toBe('degraded-stale');
    expect(output.status).toBe('partial');
  });

  test('dedupes equivalent single-line anchors and recommends bounded source-ref reconciliation', async () => {
    const projectRoot = createFixtureProject();
    const output = await defaultRecipeMapProvider.resolveRecipeMap(request(projectRoot, 'module'), {
      ...fakeDeps(),
      querySourceRefs: async () => ({
        rows: ROWS,
        diagnostics: [
          {
            code: 'recipe-context-unresolved',
            severity: 'warning',
            message: 'Recipe r-file source ref lib/index.ts:330 could not be resolved.',
            recipeId: 'r-file',
            path: 'lib/index.ts:330',
            retryable: true,
          },
          {
            code: 'recipe-context-unresolved',
            severity: 'warning',
            message: 'Recipe r-file source ref lib/index.ts:330-330 could not be resolved.',
            recipeId: 'r-file',
            path: 'lib/index.ts:330-330',
            retryable: true,
          },
        ],
      }),
    });

    expect(
      output.diagnostics.filter((diagnostic) => diagnostic.code === 'recipe-context-unresolved')
    ).toHaveLength(1);
    expect(output.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'alembic_rescan', required: false })])
    );
    expect(JSON.stringify(output.nextActions)).toContain('source-ref');
  });

  test('request-scoped read-only RecipeContext preserves drifted source refs in listAll', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipemap-db-'));
    tempRoots.push(root);
    const db = new Database(path.join(root, 'alembic.db'));
    db.exec(`
      CREATE TABLE recipe_source_refs (
        recipe_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        status TEXT NOT NULL,
        new_path TEXT,
        verified_at INTEGER,
        PRIMARY KEY (recipe_id, source_path)
      );
      INSERT INTO recipe_source_refs VALUES
        ('r-active', 'lib/active.ts:1', 'active', NULL, 1),
        ('r-drift-1', 'lib/drift-1.ts:1', 'drifted', NULL, 2),
        ('r-drift-2', 'lib/drift-2.ts:1', 'drifted', NULL, 3),
        ('r-drift-3', 'lib/drift-3.ts:1', 'drifted', NULL, 4),
        ('r-drift-4', 'lib/drift-4.ts:1', 'drifted', NULL, 5),
        ('r-drift-5', 'lib/drift-5.ts:1', 'drifted', NULL, 6);
    `);
    try {
      db.pragma('query_only = ON');
      const repositories = createReadOnlyRecipeMapRepositories(db);
      const recipeContext = createRecipeContextServiceFromCore({
        knowledge: repositories.knowledgeService,
        sourceRefRepository: repositories.sourceRefRepository,
      });
      const envelope = await recipeContext.execute({ kind: 'source-refs', payload: {} });
      const refs =
        (envelope.data as { refs?: Array<{ recipeId: string; status: string }> }).refs ?? [];

      expect(refs.map((ref) => ref.recipeId)).toEqual([
        'r-active',
        'r-drift-1',
        'r-drift-2',
        'r-drift-3',
        'r-drift-4',
        'r-drift-5',
      ]);
      expect(refs.filter((ref) => ref.status === 'drifted')).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  test('keeps drifted refs mounted as existing files with deduped drift diagnostics', async () => {
    const projectRoot = createFixtureProject();
    expect(normalizeRecipeRef('r-drift-a', 'lib/index.ts:330', 'drifted')).toMatchObject({
      filePath: 'lib/index.ts',
      startLine: 330,
      endLine: 330,
      status: 'drifted',
    });

    const output = await defaultRecipeMapProvider.resolveRecipeMap(request(projectRoot, 'module'), {
      ...fakeDeps(),
      listRecipes: async () => [
        { id: 'r-drift-a', title: 'Drifted A', tags: [], sources: [] },
        { id: 'r-drift-b', title: 'Drifted B', tags: [], sources: [] },
      ],
      querySourceRefs: async () => ({
        diagnostics: [],
        rows: [
          { recipeId: 'r-drift-a', sourcePath: 'lib/index.ts:330', status: 'drifted' },
          { recipeId: 'r-drift-a', sourcePath: 'lib/index.ts:330-330', status: 'drifted' },
          { recipeId: 'r-drift-b', sourcePath: 'lib/index.ts:330', status: 'drifted' },
        ],
      }),
    });

    const mounts = new Map(output.recipeMounts.map((mount) => [mount.recipeId, mount]));
    expect(mounts.get('r-drift-a')).toMatchObject({
      mountNodeId: 'file:lib/index.ts',
      mountType: 'source-line',
    });
    expect(mounts.get('r-drift-b')).toMatchObject({
      mountNodeId: 'file:lib/index.ts',
      mountType: 'source-line',
    });
    expect(output.diagnostics.filter((item) => item.code === 'recipe-unresolved-ref')).toEqual([]);
    expect(output.diagnostics.filter((item) => item.code === 'recipe-drifted-ref')).toHaveLength(2);
    expect(output.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'alembic_rescan', required: false })])
    );
    expect(output.status).toBe('partial');
  });

  test('mounts use only source refs + metadata, with no semantic markers or full Recipe body', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'module');
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(20 * 1024);
    expect(output.meta.fullMapRef ?? null).toBeNull();
    const serialized = JSON.stringify(output).toLowerCase();
    // No semantic/keyword search artifacts leak into deterministic mounting.
    expect(serialized).not.toContain('vectorscore');
    expect(serialized).not.toContain('semanticused');
    expect(serialized).not.toContain('vectorused');
    expect(serialized).not.toContain('scorebreakdown');
    // No full Recipe body.
    expect(serialized).not.toContain('"content"');
    for (const mount of output.recipeMounts) {
      expect(mount).not.toHaveProperty('content');
      expect(mount).not.toHaveProperty('score');
    }
    // nextActions delegate detail/structure/semantics to the right tools.
    expect(output.nextActions.map((action) => action.tool)).toEqual(
      expect.arrayContaining(['alembic_graph', 'alembic_search', 'alembic_prime'])
    );
  });

  test('output is deterministic for the same input', async () => {
    const projectRoot = createFixtureProject();
    const a = await recipeMap(projectRoot, 'module');
    const b = await recipeMap(projectRoot, 'module');
    expect(JSON.stringify(b.recipeMounts)).toEqual(JSON.stringify(a.recipeMounts));
  });

  test.each([
    199, 200, 201, 205,
  ])('recipe mount display limits preserve complete truth projection at %i candidates', async (candidateCount) => {
    const projectRoot = createFixtureProject();
    const sourcePaths = Array.from({ length: 80 }, (_, index) => {
      const relativePath = `lib/count-${String(index + 1).padStart(3, '0')}.ts`;
      fs.writeFileSync(
        path.join(projectRoot, relativePath),
        `export const count${index + 1} = ${index + 1};\n`
      );
      return relativePath;
    });
    const recipeIds = Array.from({ length: candidateCount }, (_, index) => `r-count-${index + 1}`);
    const deps: RecipeMapDeps = {
      ...fakeDeps(),
      listRecipes: async () =>
        recipeIds.map((id) => ({ id, sources: [], tags: [], title: `Count recipe ${id}` })),
      querySourceRefs: async () => ({
        diagnostics: [],
        rows: recipeIds.map((recipeId, index) => ({
          recipeId,
          sourcePath: `${sourcePaths[index % sourcePaths.length]}:1`,
          status: 'active',
        })),
      }),
    };
    const lowRequest = { ...request(projectRoot, 'module'), recipeMountLimit: 1 };
    const highRequest = { ...request(projectRoot, 'module'), recipeMountLimit: 50 };
    const low = await defaultRecipeMapProvider.resolveRecipeMap(lowRequest, deps);
    const high = await defaultRecipeMapProvider.resolveRecipeMap(highRequest, deps);

    expect(low.conservation).toMatchObject({
      candidateRecipes: candidateCount,
      mountedTotal: candidateCount,
      deferredTotal: 0,
      uncoveredTotal: 0,
      displayedMounts: 1,
      omittedMounts: candidateCount - 1,
      completeness: 'complete',
    });
    expect(low.limits).toMatchObject({
      recipeMountLimit: 1,
      appliedRecipeMountLimit: 1,
      recipeMountLimitReason: 'requested-limit',
    });
    expect(high.conservation.mountedTotal).toBe(low.conservation.mountedTotal);
    expect(high.region).toEqual(low.region);
    expect(high.recipeRollups).toEqual(low.recipeRollups);
    expect(high.refs).toEqual(low.refs);
    expect(high.diagnostics).toEqual(low.diagnostics);
    expect(
      low.conservation.mountedTotal +
        low.conservation.deferredTotal +
        low.conservation.uncoveredTotal
    ).toBe(low.conservation.candidateRecipes);
    expect(Buffer.byteLength(JSON.stringify(low), 'utf8')).toBeLessThanOrEqual(20 * 1024);
    expect(Buffer.byteLength(JSON.stringify(high), 'utf8')).toBeLessThanOrEqual(20 * 1024);
  });

  test('large recipe_map reads remain inline and leave the project filesystem unchanged', async () => {
    const projectRoot = createFixtureProject();
    const recipeIds = Array.from({ length: 60 }, (_, index) => `r-large-${index + 1}`);
    const before = filesystemManifest(projectRoot);
    const output = await defaultRecipeMapProvider.resolveRecipeMap(request(projectRoot, 'module'), {
      ...fakeDeps(),
      listRecipes: async () =>
        recipeIds.map((id) => ({ id, sources: [], tags: [], title: `Large recipe ${id}` })),
      querySourceRefs: async () => ({
        diagnostics: [],
        rows: recipeIds.flatMap((recipeId) =>
          Array.from({ length: 80 }, (_, index) => ({
            recipeId,
            sourcePath: `lib/index.ts:${(index % 2) + 1}`,
            status: 'active',
          }))
        ),
      }),
    });

    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(20 * 1024);
    expect(output.meta.fullMapRef ?? null).toBeNull();
    expect(output.recipeMounts.every((mount) => mount.sourceRefs.length <= 8)).toBe(true);
    expect(output.conservation.displayedMounts).toBeLessThan(50);
    expect(output.limits).toMatchObject({
      recipeMountLimit: 50,
      appliedRecipeMountLimit: output.recipeMounts.length,
      recipeMountLimitReason: 'inline-byte-budget',
    });
    expect(filesystemManifest(projectRoot)).toEqual(before);
    expect(output.meta).not.toHaveProperty('fullMapRef.path');
  });

  test('renamed refs use newPath and unknown statuses fail closed as unresolved', () => {
    expect(
      normalizeRecipeRef('r-renamed', 'old/file.ts:10', 'renamed', 'new/file.ts')
    ).toMatchObject({
      raw: 'old/file.ts:10',
      filePath: 'new/file.ts',
      status: 'renamed',
      newPath: 'new/file.ts',
    });
    expect(normalizeRecipeRef('r-missing', 'old/file.ts:10', 'renamed')).toMatchObject({
      filePath: 'old/file.ts',
      status: 'unresolved',
    });
    expect(normalizeRecipeRef('r-future', 'old/file.ts:10', 'future-status')).toMatchObject({
      status: 'unresolved',
    });
  });

  test('discovery shows alembic_recipe_map and not alembic_project_matrix (no alias)', () => {
    const toolNames = TOOLS.map((tool) => tool.name);
    expect(toolNames).toContain('alembic_recipe_map');
    expect(toolNames).not.toContain('alembic_project_matrix');
    const catalogNames = Object.keys(PLUGIN_TOOL_SURFACE_CATALOG);
    expect(catalogNames).toContain('alembic_recipe_map');
    expect(catalogNames).not.toContain('alembic_project_matrix');
  });

  test('alembic_project_matrix is wired as a retired tool pointing to alembic_recipe_map', () => {
    const serverSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/host-runtime/mcp/McpServer.ts'),
      'utf8'
    );
    // Retired-tool replacement map carries the retired matrix name + recipe_map pointer.
    const retiredBlock = serverSource.slice(
      serverSource.indexOf('RETIRED_PUBLIC_TOOL_REPLACEMENTS'),
      serverSource.indexOf('RETIRED_PUBLIC_TOOL_REPLACEMENTS') + 800
    );
    expect(retiredBlock).toContain('alembic_project_matrix');
    expect(retiredBlock).toContain('alembic_recipe_map');
    // The retired matrix is not re-registered as a live dispatch route.
    expect(serverSource).not.toContain('routeProjectMatrixTool');
  });

  test('graph and recipe_map round-trip the same ProjectContext ref ids', async () => {
    const projectRoot = createFixtureProject();
    const map = await recipeMap(projectRoot, 'file', 'lib/index.ts');
    const nodeId = map.region.rootNode.nodeId;
    expect(nodeId).toBe('file:lib/index.ts');
    // A recipe_map region node id is usable as alembic_graph.refId.
    const graph = (await routeGraphTool(createContext(projectRoot), {
      queryKind: 'neighborhood',
      refId: nodeId,
      projectRoot,
    })) as { structuredContent: { nodes: Array<{ id: string }> } };
    expect(graph.structuredContent.nodes.some((node) => node.id === nodeId)).toBe(true);
  });

  test('sourceRef, moduleName, repoId, and radius change the selected map region', async () => {
    const projectRoot = createFixtureProject();
    const context = createContext(projectRoot);
    const sourceFocused = (await routeRecipeMapTool(context, {
      focus: { sourceRef: 'lib/index.ts:2' },
      projectRoot,
    })) as { structuredContent: AlembicRecipeMapOutput };
    expect(sourceFocused.structuredContent.focus.kind).toBe('file');
    expect(sourceFocused.structuredContent.region.rootNode.path).toBe('lib/index.ts');

    const moduleFocused = (await routeRecipeMapTool(context, {
      focus: { moduleName: 'lib' },
      projectRoot,
    })) as { structuredContent: AlembicRecipeMapOutput };
    expect(moduleFocused.structuredContent.focus.kind).toBe('module');
    expect(moduleFocused.structuredContent.region.rootNode.path).toBe('lib');

    const repoFocused = (await routeRecipeMapTool(context, {
      focus: { repoId: 'fixture-project' },
      projectRoot,
    })) as { structuredContent: AlembicRecipeMapOutput };
    expect(repoFocused.structuredContent.focus.kind).toBe('repo');
    expect(repoFocused.structuredContent.region.rootNode.label).toBe('fixture-project');

    const zeroRadius = (await routeRecipeMapTool(context, {
      focus: { moduleName: 'lib' },
      projectRoot,
      radius: { downLevels: 0, relationHops: 0 },
    })) as { structuredContent: AlembicRecipeMapOutput };
    expect(zeroRadius.structuredContent.region.nodes).toEqual([]);
  });

  test('recipe_map provider and handler never invoke another MCP tool', () => {
    const providerSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'lib/service/project-knowledge-context/recipe-map/RecipeMapProvider.ts'
      ),
      'utf8'
    );
    const handlerSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/host-runtime/mcp/handlers/recipe-map.ts'),
      'utf8'
    );
    for (const source of [providerSource, handlerSource]) {
      expect(source).not.toContain('routeGraphTool');
      expect(source).not.toContain('routeSearchTool');
      expect(source).not.toContain('routeRecipeMapTool');
      expect(source).not.toContain('McpServer');
    }
    // Recipe data comes from the Core recipe context capability facade, structure
    // from the shared ProjectContext region.
    expect(handlerSource).toContain('@alembic/core/recipe-context-capabilities');
    expect(handlerSource).toContain('resolveProjectContextRegion');
  });
});

function filesystemManifest(root: string): string[] {
  const values: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      values.push(`${entry.isDirectory() ? 'd' : 'f'}:${relativePath}`);
      if (entry.isDirectory()) {
        visit(absolutePath);
      }
    }
  };
  visit(root);
  return values.sort();
}

function recipeMapStableKeys(output: AlembicRecipeMapOutput): string[] {
  return [
    ...output.region.nodes.map((node) => `node:${node.nodeId}`),
    ...output.region.relations.map(
      (relation) => `relation:${relation.fromId}\0${relation.relationType}\0${relation.toId}`
    ),
    ...output.refs.map((ref) => `ref:${ref.id}`),
    ...output.recipeMounts.map(
      (mount) => `mount:${mount.recipeId}\0${mount.mountNodeId}\0${mount.mountType}`
    ),
    ...output.recipeRollups.map((rollup) => `rollup:${rollup.nodeId}`),
  ];
}

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipemap-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: 'fixture-project', main: 'lib/index.ts', scripts: { build: 'tsc -p .' } },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'helper.ts'),
    'export function helper() { return "ok"; }\n'
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'index.ts'),
    'import { helper } from "./helper";\nexport function run() { return helper(); }\n'
  );
  return root;
}

function createContext(projectRoot: string, services: Record<string, unknown> = {}): McpContext {
  return {
    container: {
      get: (name: string) => services[name],
      singletons: { _projectRoot: projectRoot },
    },
    projectRuntime: buildProjectRuntimeContext({ projectRoot }),
  } as unknown as McpContext;
}
