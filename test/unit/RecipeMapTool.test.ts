import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { routeGraphTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import { AlembicRecipeMapOutputSchema } from '../../lib/service/project-knowledge-context/contracts/AlembicRecipeMapOutput.js';
import { defaultProjectGraphProvider } from '../../lib/service/project-knowledge-context/project/ProjectGraphProvider.js';
import {
  defaultRecipeMapProvider,
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

  test('top-level focus surfaces global no-code mounts + rollups, not every file Recipe', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'space');
    expect(AlembicRecipeMapOutputSchema.parse(output)).toEqual(output);

    const mountIds = output.recipeMounts.map((mount) => mount.recipeId);
    // Global no-code Recipe is a direct mount; deeper code Recipes are NOT dumped.
    expect(mountIds).toContain('r-global');
    expect(mountIds).not.toContain('r-file');
    expect(mountIds).not.toContain('r-multi');
    expect(output.recipeMounts.find((mount) => mount.recipeId === 'r-global')?.mountType).toBe(
      'global-no-code'
    );
    // The deferred deeper Recipes appear as descendant rollups on the root.
    const rootRollup = output.recipeRollups.find(
      (rollup) => rollup.nodeId === output.region.rootNode.nodeId
    );
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

  test('mounts use only source refs + metadata, with no semantic markers or full Recipe body', async () => {
    const projectRoot = createFixtureProject();
    const output = await recipeMap(projectRoot, 'module');
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
      path.join(process.cwd(), 'lib/runtime/mcp/McpServer.ts'),
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

  test('recipe_map provider and handler never invoke another MCP tool', () => {
    const providerSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'lib/service/project-knowledge-context/recipe-map/RecipeMapProvider.ts'
      ),
      'utf8'
    );
    const handlerSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/runtime/mcp/handlers/recipe-map.ts'),
      'utf8'
    );
    for (const source of [providerSource, handlerSource]) {
      expect(source).not.toContain('routeGraphTool');
      expect(source).not.toContain('routeSearchTool');
      expect(source).not.toContain('routeRecipeMapTool');
      expect(source).not.toContain('McpServer');
    }
    // Recipe data comes from Core RecipeContext, structure from the shared region.
    expect(handlerSource).toContain('@alembic/core/recipe-context');
    expect(handlerSource).toContain('resolveProjectContextRegion');
  });
});

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
