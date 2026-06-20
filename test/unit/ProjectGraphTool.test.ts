import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectContext } from '@alembic/core/project-context';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { routeGraphTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { ALEMBIC_GRAPH_QUERY_KINDS } from '../../lib/service/project-knowledge-context/contracts/AlembicGraphOutput.js';
import { GRAPH_QUERY_KINDS, GraphInput } from '../../lib/shared/schemas/mcp-tools.js';

const tempRoots: string[] = [];

// The 9 queryKinds that map 1:1 onto ProjectContext request classes.
const PROJECT_CONTEXT_QUERY_KINDS = [
  'space',
  'repo',
  'map',
  'module',
  'module-layers',
  'file-flow',
  'file-symbols',
  'source-slice',
  'anchor-range',
] as const;

const FILE_SCOPED_QUERY_KINDS = new Set([
  'file-flow',
  'file-symbols',
  'source-slice',
  'anchor-range',
]);

const ALLOWED_NODE_TYPES = new Set([
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
]);

type GraphResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: GraphOutput;
};
interface GraphOutput {
  ok: boolean;
  status: string;
  tool: string;
  queryKind: string;
  summary: string;
  project: Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  refs: Array<Record<string, unknown>>;
  slices?: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  nextActions: Array<Record<string, unknown>>;
  limits: { truncated: boolean; itemLimit: number; refLimit: number; relationLimit: number };
  meta: Record<string, unknown>;
}

async function runGraph(projectRoot: string, args: Record<string, unknown>): Promise<GraphOutput> {
  const result = (await routeGraphTool(createContext(projectRoot), {
    projectRoot,
    ...args,
  })) as GraphResult;
  // Visible MCP text must be the summary only.
  expect(result.content).toEqual([{ type: 'text', text: result.structuredContent.summary }]);
  return result.structuredContent;
}

describe('alembic_graph project graph tool (queryKind / AlembicGraphOutput)', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('public queryKind enum matches the service AlembicGraphOutput enum', () => {
    expect([...GRAPH_QUERY_KINDS]).toEqual([...ALEMBIC_GRAPH_QUERY_KINDS]);
    // 9 ProjectContext kinds + 4 derived traversals.
    expect(GRAPH_QUERY_KINDS).toHaveLength(13);
  });

  test('answers every ProjectContext queryKind with bounded, Recipe-free output', async () => {
    const projectRoot = createFixtureProject();
    for (const queryKind of PROJECT_CONTEXT_QUERY_KINDS) {
      const args: Record<string, unknown> = {
        queryKind,
        budget: { itemLimit: 50, relationHopLimit: 4 },
      };
      if (FILE_SCOPED_QUERY_KINDS.has(queryKind)) {
        args.filePath = 'lib/index.ts';
      }
      const output = await runGraph(projectRoot, args);

      expect(output).toMatchObject({
        ok: true,
        tool: 'alembic_graph',
        toolName: 'alembic_graph',
        queryKind,
        meta: { outputSchema: 'AlembicGraphOutput', contractVersion: 1 },
      });
      expect(['ready', 'partial', 'degraded']).toContain(output.status);

      // Bounded.
      expect(output.nodes.length).toBeLessThanOrEqual(output.limits.itemLimit);
      expect(output.refs.length).toBeLessThanOrEqual(output.limits.refLimit);
      expect(output.relations.length).toBeLessThanOrEqual(output.limits.relationLimit);

      // Detached from the KnowledgeContext middle-layer envelope: graph has its
      // own AlembicGraphOutput schema, with no KnowledgeContextToolOutput
      // `result`/`inventory` bag.
      expect(output).not.toHaveProperty('result');
      expect(output).not.toHaveProperty('inventory');
      expect(output.meta.outputSchema).not.toBe('KnowledgeContextToolOutput');

      // Recipe-free.
      const serialized = JSON.stringify(output).toLowerCase();
      expect(serialized).not.toContain('recipe');
      expect(serialized).not.toContain('coveredbyknowledge');
      expect(serialized).not.toContain('relationchain');
      expect(serialized).not.toContain('mount');
      expect(serialized).not.toContain('scorebreakdown');

      for (const node of output.nodes) {
        expect(ALLOWED_NODE_TYPES).toContain(node.nodeType);
        expect(node).not.toHaveProperty('recipeId');
      }
    }
  });

  test('stats summarizes bounded project graph counts', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'stats',
      budget: { itemLimit: 100, relationHopLimit: 10 },
    });
    expect(output.status).toBe('ready');
    expect(output.queryKind).toBe('stats');
    expect(output.nodes.length).toBeGreaterThan(0);
    expect(output.project).toMatchObject({ displayName: 'fixture-project' });
    expect(JSON.stringify(output.nodes)).not.toContain('recipe');
  });

  test('map and space return ProjectContext orientation nodes', async () => {
    const projectRoot = createFixtureProject();
    const map = await runGraph(projectRoot, { queryKind: 'map' });
    expect(map.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['project:fixture-project'])
    );
    const space = await runGraph(projectRoot, { queryKind: 'space' });
    expect(
      space.nodes.every((node) => ['project', 'package'].includes(String(node.nodeType)))
    ).toBe(true);
  });

  test('file-symbols exposes ProjectContext file + symbol nodes', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
    });
    const nodeTypes = new Set(output.nodes.map((node) => node.nodeType));
    expect(nodeTypes.has('file')).toBe(true);
    expect(output.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);
    expect(JSON.stringify(output)).not.toContain('recipe');
  });

  test('file-scoped queryKinds keep ProjectContext collection focused on the anchor', async () => {
    const projectRoot = createFixtureProject();
    const executeSpy = vi.spyOn(ProjectContext, 'execute');
    try {
      const output = await runGraph(projectRoot, {
        queryKind: 'file-symbols',
        filePath: 'lib/index.ts',
        budget: { itemLimit: 40, relationHopLimit: 4 },
      });
      expect(output.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);

      const requestKinds = executeSpy.mock.calls.map(([request]) => request.kind);
      expect(requestKinds).toEqual(expect.arrayContaining(['space', 'repo', 'file-symbols']));
      expect(requestKinds).not.toContain('map');
      expect(requestKinds).not.toContain('module');
      expect(requestKinds).not.toContain('module-layers');
      expect(requestKinds).not.toContain('file-flow');
      expect(requestKinds).not.toContain('source-slice');
      expect(requestKinds).not.toContain('anchor-range');
    } finally {
      executeSpy.mockRestore();
    }
  });

  test('file-scoped queryKinds suppress unrelated broad repo scan limit diagnostics', async () => {
    const projectRoot = createLargeFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
      budget: { itemLimit: 40, relationHopLimit: 4 },
    });
    expect(output.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);
    expect(output.status).toBe('ready');
    expect(JSON.stringify(output.diagnostics)).not.toContain('repo source file collection');
  });

  test('source-slice returns bounded ProjectContext source slices', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'source-slice',
      filePath: 'lib/index.ts',
    });
    expect(output.status).toBe('ready');
    expect(output.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeType: 'file', path: 'lib/index.ts' }),
      ])
    );
    expect(output.diagnostics).toEqual([]);
    expect(Array.isArray(output.slices)).toBe(true);
    expect((output.slices ?? []).length).toBeGreaterThan(0);
    for (const slice of output.slices ?? []) {
      expect(slice).toHaveProperty('filePath', 'lib/index.ts');
      expect(slice).toHaveProperty('range');
    }
  });

  test('derived impact traversal withholds output until a concrete ProjectContext anchor is supplied', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'impact',
      query: 'what changes if I touch this',
    });
    expect(output.nodes).toEqual([]);
    expect(output.relations).toEqual([]);
    expect(output.status).toBe('partial');
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-anchor-required'
    );
    expect(output.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_graph', queryKind: 'map', required: true }),
      ])
    );
  });

  test('missing-anchor graph requests fast-fail before ProjectContext execution', async () => {
    const projectRoot = createFixtureProject();
    const executeSpy = vi.spyOn(ProjectContext, 'execute').mockImplementation(async () => {
      throw new Error('ProjectContext.execute should not run for graph preflight failures');
    });
    try {
      const impact = await runGraph(projectRoot, { queryKind: 'impact' });
      expect(impact.status).toBe('partial');
      expect(impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'project-graph-anchor-required'
      );

      const pathOutput = await runGraph(projectRoot, { queryKind: 'path', fromRefId: 'module:lib' });
      expect(pathOutput.status).toBe('partial');
      expect(pathOutput.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'project-graph-path-anchor-required'
      );

      const fileSymbols = await runGraph(projectRoot, { queryKind: 'file-symbols' });
      expect(fileSymbols.status).toBe('partial');
      expect(fileSymbols.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'project-graph-file-anchor-required'
      );

      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      executeSpy.mockRestore();
    }
  });

  test('derived impact traversal runs from a resolved ProjectContext ref', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'impact',
      refId: 'file:lib/index.ts',
      budget: { itemLimit: 20, relationHopLimit: 4 },
    });
    expect(output.nodes.some((node) => node.id === 'file:lib/index.ts')).toBe(true);
    expect(output.relations.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).not.toContain('recipe');
  });

  test('file-scoped queryKind without an anchor returns a graph diagnostic, not a fallback', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, { queryKind: 'file-symbols' });
    expect(output.nodes).toEqual([]);
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-file-anchor-required'
    );
    expect(output.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_graph', queryKind: 'map', required: true }),
      ])
    );
  });

  test('legacy operation is normalized onto queryKind without a second behavior branch', async () => {
    const projectRoot = createFixtureProject();
    // Stale operation, no queryKind → normalized.
    expect((await runGraph(projectRoot, { operation: 'stats' })).queryKind).toBe('stats');
    expect(
      (await runGraph(projectRoot, { operation: 'impact', refId: 'file:lib/index.ts' })).queryKind
    ).toBe('impact');
    expect((await runGraph(projectRoot, { operation: 'query' })).queryKind).toBe('map');
    // Explicit queryKind always wins over a stale operation alias.
    expect(
      (await runGraph(projectRoot, { queryKind: 'space', operation: 'stats' })).queryKind
    ).toBe('space');
  });

  test('rejects legacy Recipe graph input at the public schema boundary', () => {
    expect(GraphInput.safeParse({ nodeType: 'recipe' }).success).toBe(false);
    expect(GraphInput.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
    expect(GraphInput.safeParse({ relation: 'hasGap' }).success).toBe(false);
    expect(GraphInput.safeParse({ queryKind: 'recipe' }).success).toBe(false);
    expect(GraphInput.safeParse({ queryKind: 'coverage' }).success).toBe(false);
    // Valid new contract parses.
    expect(
      GraphInput.safeParse({ queryKind: 'source-slice', filePath: 'lib/index.ts' }).success
    ).toBe(true);
  });

  test('keeps alembic_graph on the ProjectContext direct boundary and off the middle layer', () => {
    const providerSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'lib/service/project-knowledge-context/project/ProjectGraphProvider.ts'
      ),
      'utf8'
    );
    expect(providerSource).toContain('ProjectContext.execute');
    expect(providerSource).toContain('ProjectContextProjectGraphProvider');
    expect(providerSource).toContain('resolveAlembicGraph');
    expect(providerSource).not.toContain('walkProject');
    expect(providerSource).not.toContain('fs.readFileSync');

    const handlerSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/runtime/mcp/handlers/structure.ts'),
      'utf8'
    );
    // graph output no longer routes through the KnowledgeContext middle layer.
    expect(handlerSource).not.toContain('resolveMcpResult');
    expect(handlerSource).toContain('resolveAlembicGraph');
    expect(handlerSource).toContain('createAlembicGraphMcpResult');
  });

  test('uses workspace.config repoNames as the default graph boundary', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'stats',
      budget: { itemLimit: 200, relationHopLimit: 10 },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).toContain('AlembicPlugin/lib/index.ts');
    expect(serialized).toContain('AlembicCore/src/index.ts');
    expect(serialized).not.toContain('Test');
    expect(serialized).not.toContain('wakeflow-ledger');
    expect(serialized).not.toContain('legacy-docs-do-not-use');
  });

  test('enriches real workspace file neighborhoods with ProjectContext ownership relations', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'neighborhood',
      refId: 'file:AlembicCore/src/index.ts',
      relationType: 'partOf',
      radius: { maxDepth: 1 },
      budget: { itemLimit: 20, relationHopLimit: 10 },
    });
    expect(output.queryKind).toBe('neighborhood');
    expect(output.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: 'file:alembiccore/src/index.ts',
          relationType: 'partOf',
          toId: 'directory:alembiccore/src',
        }),
        expect.objectContaining({
          fromId: 'file:alembiccore/src/index.ts',
          relationType: 'partOf',
          toType: 'package',
        }),
      ])
    );
    expect(JSON.stringify(output.diagnostics)).not.toContain('project-graph-relation-unavailable');
  });

  test('suppresses generated artifact paths in default ProjectContext graph probes', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'map',
      query: 'ProjectContext generated artifact dist build declaration vendor file-flow',
      budget: { itemLimit: 80, relationHopLimit: 8 },
    });
    const visibleOutput = JSON.stringify({
      nodes: output.nodes,
      relations: output.relations,
      refs: output.refs,
    }).toLowerCase();
    expect(visibleOutput).not.toContain('/dist/');
    expect(visibleOutput).not.toContain('/build/');
    expect(visibleOutput).not.toContain('/vendor/');
    expect(visibleOutput).not.toContain('.d.ts');
  });
});

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-project',
        main: 'lib/index.ts',
        scripts: { build: 'tsc -p tsconfig.json' },
        dependencies: { zod: '^3.0.0' },
      },
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

function createLargeFixtureProject(): string {
  const root = createFixtureProject();
  for (let index = 0; index < 260; index += 1) {
    writeFile(root, `lib/generated/noise-${String(index).padStart(3, '0')}.ts`, 'export const noise = true;\n');
  }
  return root;
}

function createWorkspaceFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-workspace-fixture-'));
  tempRoots.push(root);
  writeWorkspaceFixtureConfig(root);
  writeWorkspaceCoreFixture(root);
  writeWorkspacePluginFixture(root);
  writeWorkspaceNoiseBoundaryFixture(root);
  return root;
}

function writeWorkspaceFixtureConfig(root: string) {
  fs.writeFileSync(
    path.join(root, 'workspace.config.json'),
    JSON.stringify(
      {
        repoNames: ['AlembicCore', 'AlembicPlugin'],
        repositories: [
          { name: 'AlembicCore', mode: 'external', path: 'AlembicCore' },
          { name: 'AlembicPlugin', mode: 'external', path: 'AlembicPlugin' },
          { name: 'Test', mode: 'internal', path: 'Test' },
        ],
      },
      null,
      2
    )
  );
}

function writeWorkspaceCoreFixture(root: string) {
  writeFile(
    root,
    'AlembicCore/package.json',
    JSON.stringify(
      {
        name: '@fixture/core',
        main: 'dist/project-context/GeneratedProjectContext.js',
        types: 'dist/project-context/GeneratedProjectContext.d.ts',
      },
      null,
      2
    )
  );
  writeFile(root, 'AlembicCore/.claude/settings.json', '{}\n');
  writeFile(
    root,
    'AlembicCore/vitest.unit.config.ts',
    'import baseConfig from "./vitest.config";\nexport default baseConfig;\n'
  );
  writeFile(root, 'AlembicCore/src/index.ts', 'export const core = "core";\n');
  writeFile(
    root,
    'AlembicCore/src/project-context.ts',
    'export * from "./domain/project-context/ProjectContextRequestKinds";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/domain/project-context/ProjectContextRequestKinds.ts',
    'export type ProjectContextRequestKind = "source-slice" | "file-symbols" | "file-flow" | "module" | "map" | "repo" | "space";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/repository/RecipeRepository.ts',
    'export class RecipeRepository {}\n'
  );
  writeFile(
    root,
    'AlembicCore/dist/project-context/GeneratedProjectContext.js',
    'export const generatedProjectContext = true;\n'
  );
  writeFile(
    root,
    'AlembicCore/dist/project-context/GeneratedProjectContext.d.ts',
    'export declare const generatedProjectContext: boolean;\n'
  );
  writeFile(
    root,
    'AlembicCore/build/project-context/GeneratedBuildOutput.js',
    'export const generatedBuildOutput = true;\n'
  );
  writeFile(
    root,
    'AlembicCore/vendor/AlembicCore/src/repository/LegacyRepository.ts',
    'export class LegacyRepository {}\n'
  );
}

function writeWorkspacePluginFixture(root: string) {
  writeFile(
    root,
    'AlembicPlugin/lib/index.ts',
    'import { core } from "../../AlembicCore/src/index";\nexport const plugin = core;\n'
  );
  writeFile(
    root,
    'AlembicPlugin/lib/runtime/mcp/handlers/structure.ts',
    'export const projectContextGraphHandler = true;\n'
  );
}

function writeWorkspaceNoiseBoundaryFixture(root: string) {
  writeFile(root, 'Test/lib/index.ts', 'export const testSurface = true;\n');
  writeFile(root, 'wakeflow-ledger/AlembicWorkspace/index.md', '# ledger\n');
  writeFile(root, 'legacy-docs-do-not-use/index.md', '# legacy\n');
}

function writeFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createContext(projectRoot: string): McpContext {
  return {
    container: {
      get: () => undefined,
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}
