import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecipeContextServiceFromCore } from '@alembic/core/recipe-context-capabilities';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
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

const tempRoots: string[] = [];

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
      const refs = (envelope.data as { refs?: Array<{ recipeId: string; status: string }> }).refs ?? [];

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

  test.each([199, 200, 201, 205])(
    'recipe mount display limits preserve complete truth projection at %i candidates',
    async (candidateCount) => {
    const projectRoot = createFixtureProject();
    const sourcePaths = Array.from({ length: 80 }, (_, index) => {
      const relativePath = `lib/count-${String(index + 1).padStart(3, '0')}.ts`;
      fs.writeFileSync(path.join(projectRoot, relativePath), `export const count${index + 1} = ${index + 1};\n`);
      return relativePath;
    });
    const recipeIds = Array.from(
      { length: candidateCount },
      (_, index) => `r-count-${index + 1}`
    );
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
  }
  );

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
    expect(normalizeRecipeRef('r-renamed', 'old/file.ts:10', 'renamed', 'new/file.ts')).toMatchObject(
      {
        raw: 'old/file.ts:10',
        filePath: 'new/file.ts',
        status: 'renamed',
        newPath: 'new/file.ts',
      }
    );
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

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipemap-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-project', main: 'lib/index.ts' }, null, 2)
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

function createContext(projectRoot: string): McpContext {
  return {
    container: { get: () => undefined, singletons: { _projectRoot: projectRoot } },
  } as unknown as McpContext;
}
