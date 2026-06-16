import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { routeGraphTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { GraphInput } from '../../lib/shared/schemas/mcp-tools.js';

const tempRoots: string[] = [];

describe('alembic_graph project graph tool', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('returns KnowledgeContextToolOutput for project-internal graph stats', async () => {
    const projectRoot = createFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      operation: 'stats',
      projectRoot,
      budget: { itemLimit: 100, matrixNodeLimit: 100, relationHopLimit: 10 },
    });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.content).toEqual([{ type: 'text', text: structured.summary }]);
    expect(structured).toMatchObject({
      ok: true,
      status: 'ready',
      toolName: 'alembic_graph',
      operation: 'stats',
      meta: { outputSchema: 'KnowledgeContextToolOutput' },
    });
    expect(structured.inventory).toMatchObject({
      allowedNodeTypes: expect.arrayContaining(['project', 'package', 'file', 'symbol']),
      allowedRelationTypes: expect.arrayContaining(['partOf', 'imports', 'definesSymbol']),
    });
    expect(JSON.stringify(structured.items)).not.toContain('recipe');
    expect(JSON.stringify(structured.relations)).not.toContain('coveredByKnowledge');
  });

  test('supports query and neighborhood without Recipe knowledge fallbacks', async () => {
    const projectRoot = createFixtureProject();
    const query = await routeGraphTool(createContext(projectRoot), {
      operation: 'query',
      projectRoot,
      nodeType: 'file',
      query: 'index',
    });
    const queryStructured = query.structuredContent as Record<string, unknown>;
    const queryItems = queryStructured.items as Array<Record<string, unknown>>;

    expect(queryStructured.status).toBe('partial');
    expect(queryItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'file:lib/index.ts', nodeType: 'file' }),
      ])
    );

    const neighborhood = await routeGraphTool(createContext(projectRoot), {
      operation: 'neighborhood',
      projectRoot,
      nodeId: 'file:lib/index.ts',
      relationType: 'imports',
    });
    const neighborhoodStructured = neighborhood.structuredContent as Record<string, unknown>;
    const relations = neighborhoodStructured.relations as Array<Record<string, unknown>>;

    expect(neighborhoodStructured.toolName).toBe('alembic_graph');
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: 'file:lib/index.ts',
          relationType: 'imports',
          toId: 'file:lib/helper.ts',
        }),
      ])
    );
    expect(neighborhoodStructured.result).toMatchObject({ graphKind: 'project-internal' });
  });

  test('uses hostDeclaredIntent query for runtime graph selection', async () => {
    const projectRoot = createFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 5, matrixNodeLimit: 5, relationHopLimit: 2 },
      hostDeclaredIntent: {
        query: 'index',
        sourceRefs: ['host:intent'],
        summary: 'Find the index entrypoint',
      },
      nodeType: 'file',
      operation: 'query',
      projectRoot,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const request = structured.request as Record<string, unknown>;
    const queryItems = structured.items as Array<Record<string, unknown>>;

    expect(request.query).toBe('index');
    expect(queryItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'file:lib/index.ts', nodeType: 'file' }),
      ])
    );
  });

  test('keeps zero-match focused queries compact instead of returning broad matrix nodes', async () => {
    const projectRoot = createFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 5, matrixNodeLimit: 20, relationHopLimit: 1 },
      operation: 'query',
      projectRoot,
      query: 'nonexistent catalog router handler',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const graphResult = structured.result as Record<string, unknown>;

    expect(structured.items).toEqual([]);
    expect(graphResult).toMatchObject({
      projectContextPartial: true,
      matrixNodes: [],
      noMatchReason: 'No bounded project graph nodes matched the focused query terms.',
      queryMatchedNodeCount: 0,
    });
  });

  test('returns compact project orientation for low-information graph queries', async () => {
    const projectRoot = createFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 8, matrixNodeLimit: 8, nextActionLimit: 4, relationHopLimit: 1 },
      operation: 'query',
      projectRoot,
      query: 'where do I start',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const graphResult = structured.result as Record<string, unknown>;
    const itemIds = (structured.items as Array<Record<string, unknown>>).map((item) => item.id);

    expect(graphResult).toMatchObject({
      lowInformationIntent: true,
      operation: 'query',
      orientation: true,
      queryMatchMode: 'project-orientation',
      projectContextRefRequiredForImpact: true,
    });
    expect(itemIds).toEqual(
      expect.arrayContaining(['project:fixture-project', 'package:fixture-project'])
    );
    expect(JSON.stringify(structured.items)).not.toContain('Knowledge');
    expect(structured.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_project_matrix', operation: 'overview' }),
      ])
    );
  });

  test('withholds impact traversal until a concrete ProjectContext anchor is supplied', async () => {
    const projectRoot = createFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      operation: 'impact',
      projectRoot,
      query: 'what changes if I touch this',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const graphResult = structured.result as Record<string, unknown>;

    expect(structured.items).toEqual([]);
    expect(structured.relations).toEqual([]);
    expect(graphResult).toMatchObject({
      impactUnavailableReason: expect.stringContaining('concrete ProjectContext nodeId'),
      missing: 'nodeId',
      operation: 'impact',
      projectContextRefRequiredForImpact: true,
    });
    expect(structured.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'query',
          required: true,
          tool: 'alembic_graph',
        }),
      ])
    );
  });

  test('uses workspace.config repoNames as the default graph boundary', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      operation: 'stats',
      projectRoot,
      budget: { itemLimit: 100, matrixNodeLimit: 200, relationHopLimit: 10 },
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const serialized = JSON.stringify(structured);

    expect(serialized).toContain('AlembicPlugin/lib/index.ts');
    expect(serialized).toContain('AlembicCore/src/index.ts');
    expect(serialized).not.toContain('Test');
    expect(serialized).not.toContain('wakeflow-ledger');
    expect(serialized).not.toContain('workspace-ledger');
    expect(serialized).not.toContain('legacy-docs-do-not-use');
  });

  test('ranks ProjectContext request-kind nodes ahead of weak repository path matches', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 12, matrixNodeLimit: 20, relationHopLimit: 4 },
      operation: 'query',
      projectRoot,
      query:
        'ProjectContext execute request kinds source-slice file-symbols file-flow module map repo space repository',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const graphResult = structured.result as Record<string, unknown>;
    const items = structured.items as Array<Record<string, unknown>>;
    const itemPaths = items.map((item) => String(item.path ?? item.id ?? '').toLowerCase());
    const firstProjectContextIndex = itemPaths.findIndex(
      (value) => value.includes('project-context') || value.includes('projectcontext')
    );
    const firstRepositoryIndex = itemPaths.findIndex(
      (value) => value.includes('/repository/') || value.includes('/vendor/')
    );

    expect(graphResult).toMatchObject({
      operation: 'query',
      queryMatchMode: 'project-context-weighted',
    });
    expect(firstProjectContextIndex).toBeGreaterThanOrEqual(0);
    expect(firstProjectContextIndex).toBeLessThan(5);
    if (firstRepositoryIndex !== -1) {
      expect(firstProjectContextIndex).toBeLessThan(firstRepositoryIndex);
    }
    expect(items.slice(0, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rankingSignals: expect.arrayContaining(['project-context-semantic-node']),
        }),
      ])
    );
    expect(JSON.stringify(items.slice(0, 5))).not.toContain('vendor/AlembicCore/src/repository');
  });

  test('suppresses generated artifact paths in default ProjectContext graph probes', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 80, matrixNodeLimit: 80, relationHopLimit: 8 },
      operation: 'query',
      projectRoot,
      query: 'ProjectContext generated artifact dist build declaration vendor file-flow',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const inventory = structured.inventory as Record<string, unknown>;
    const projectContext = inventory.projectContext as Record<string, unknown>;
    const visibleOutput = JSON.stringify({
      detailRefs: structured.detailRefs,
      items: structured.items,
      matrixNodes: structured.matrixNodes,
      relations: structured.relations,
      sources: structured.sources,
    }).toLowerCase();

    expect(Number(projectContext.generatedArtifactSkipCount ?? 0)).toBeGreaterThan(0);
    expect(visibleOutput).not.toContain('/dist/');
    expect(visibleOutput).not.toContain('/build/');
    expect(visibleOutput).not.toContain('/vendor/');
    expect(visibleOutput).not.toContain('.d.ts');
  });

  test('keeps broad repo-root and config file-flow noise out of default graph probes', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 12, matrixNodeLimit: 20, relationHopLimit: 4 },
      operation: 'query',
      projectRoot,
      query:
        'ProjectContext execute request kinds source-slice file-symbols file-flow module map repo space repository',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const diagnosticsText = JSON.stringify(structured.diagnostics ?? []).toLowerCase();

    expect(diagnosticsText).not.toContain('file-flow parser is unavailable for language json');
    expect(diagnosticsText).not.toContain('file-flow import target was not found: ./vitest.config');
    expect(diagnosticsText).not.toContain('alembicplugin/lib/service/project-knowledge-context');
  });

  test('keeps default ProjectContext graph queries on a bounded file-flow workset', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      operation: 'query',
      projectRoot,
      query:
        'ProjectContext execute request kinds source-slice file-symbols file-flow module map repo space repository',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const inventory = structured.inventory as Record<string, unknown>;
    const projectContext = inventory.projectContext as Record<string, unknown>;

    expect(projectContext).toMatchObject({
      fileFlowTargetLimit: 12,
      explicitFileTraversalFocused: false,
      mapRequestCount: 1,
      moduleRequestCount: 4,
    });
    expect(Number(projectContext.fileFlowTargetCount ?? 0)).toBeLessThanOrEqual(12);
  });

  test('keeps explicit ProjectContext file traversal from fanning out into module parser diagnostics', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const neighborhood = await routeGraphTool(createContext(projectRoot), {
      maxDepth: 1,
      nodeId: 'file:alembiccore/src/project-context.ts',
      operation: 'neighborhood',
      projectRoot,
      relationType: 'partOf',
    });
    const structured = neighborhood.structuredContent as Record<string, unknown>;
    const inventory = structured.inventory as Record<string, unknown>;
    const projectContext = inventory.projectContext as Record<string, unknown>;
    const diagnosticsText = JSON.stringify(structured.diagnostics ?? []).toLowerCase();

    expect(projectContext).toMatchObject({
      explicitFileTraversalFocused: true,
      mapRequestCount: 0,
      moduleRequestCount: 0,
    });
    expect(diagnosticsText).not.toContain('callgraphanalyzer');
    expect(diagnosticsText).not.toContain('missing-call-edge');
    expect(diagnosticsText).not.toContain('alembiccore/src/core/analysis');
  });

  test('enriches real workspace file neighborhoods with ProjectContext ownership relations', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 20, matrixNodeLimit: 20, relationHopLimit: 10 },
      maxDepth: 1,
      nodeId: 'file:AlembicCore/src/index.ts',
      operation: 'neighborhood',
      projectRoot,
      relationType: 'partOf',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const graphResult = structured.result as Record<string, unknown>;
    const relations = structured.relations as Array<Record<string, unknown>>;
    const diagnostics = structured.diagnostics as Array<Record<string, unknown>>;

    expect(graphResult).toMatchObject({
      graphKind: 'project-internal',
      nodeId: 'file:alembiccore/src/index.ts',
      operation: 'neighborhood',
    });
    expect(relations).toEqual(
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
    expect(JSON.stringify(diagnostics)).not.toContain('project-graph-relation-unavailable');
  });

  test('reports unavailable relation classes for anchored graph traversal', async () => {
    const projectRoot = createWorkspaceFixtureProject();
    const result = await routeGraphTool(createContext(projectRoot), {
      budget: { itemLimit: 20, matrixNodeLimit: 20, nextActionLimit: 5, relationHopLimit: 10 },
      maxDepth: 1,
      nodeId: 'file:AlembicCore/src/index.ts',
      operation: 'impact',
      projectRoot,
      relationType: 'calls',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const graphResult = structured.result as Record<string, unknown>;
    const diagnostics = structured.diagnostics as Array<Record<string, unknown>>;
    const nextActions = structured.nextActions as Array<Record<string, unknown>>;

    expect(graphResult).toMatchObject({
      graphKind: 'project-internal',
      nodeId: 'file:alembiccore/src/index.ts',
      operation: 'impact',
      projectContextPartial: true,
      relationUnavailableReason: expect.stringContaining('calls'),
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'project-graph-relation-unavailable' }),
      ])
    );
    expect(nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_graph', operation: 'query' }),
      ])
    );
  });

  test('rejects legacy Recipe graph input at the public schema boundary', () => {
    expect(GraphInput.safeParse({ nodeType: 'recipe' }).success).toBe(false);
    expect(GraphInput.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
    expect(GraphInput.safeParse({ relation: 'hasGap' }).success).toBe(false);
    expect(
      GraphInput.safeParse({ operation: 'neighborhood', nodeType: 'source-graph-node' }).success
    ).toBe(false);
  });

  test('keeps alembic_graph provider on the ProjectContext direct boundary', () => {
    const providerSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'lib/service/project-knowledge-context/project/ProjectGraphProvider.ts'
      ),
      'utf8'
    );

    expect(providerSource).toContain('ProjectContext.execute');
    expect(providerSource).toContain('ProjectContextProjectGraphProvider');
    expect(providerSource).not.toContain('walkProject');
    expect(providerSource).not.toContain('addImportAndSymbolEdges');
    expect(providerSource).not.toContain('extractImportSpecifiers');
    expect(providerSource).not.toContain('fs.readFileSync');
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
    'AlembicCore/src/domain/project-context/source-slice.ts',
    'export const sourceSliceRequest = "source-slice";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/domain/project-context/file-symbols.ts',
    'export const fileSymbolsRequest = "file-symbols";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/domain/project-context/file-flow.ts',
    'export const fileFlowRequest = "file-flow";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/domain/project-context/module-map-repo-space.ts',
    'export const projectContextOrientation = ["module", "map", "repo", "space"];\n'
  );
  writeFile(
    root,
    'AlembicCore/src/repository/RecipeRepository.ts',
    'export class RecipeRepository {}\n'
  );
  writeFile(
    root,
    'AlembicCore/src/core/analysis/CallGraphAnalyzer.ts',
    'import missingCallEdge from "./MissingCallEdge";\nexport const analyzer = missingCallEdge;\n'
  );
  writeFile(
    root,
    'AlembicCore/src/core/analysis/CallSiteExtractor.ts',
    'export const callSiteExtractor = true;\n'
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
  writeFile(
    root,
    'AlembicCore/vendor/AlembicCore/src/project-context/GeneratedVendorProjectContext.ts',
    'export const generatedVendorProjectContext = true;\n'
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
  writeFile(
    root,
    'AlembicPlugin/lib/service/project-knowledge-context/project/NoisyProjectContextAdapter.ts',
    'import missingProjectContext from "./missing-project-context";\nexport const adapter = missingProjectContext;\n'
  );
}

function writeWorkspaceNoiseBoundaryFixture(root: string) {
  writeFile(root, 'Test/lib/index.ts', 'export const testSurface = true;\n');
  writeFile(root, 'wakeflow-ledger/AlembicWorkspace/index.md', '# ledger\n');
  writeFile(root, 'workspace-ledger/index.md', '# workspace ledger\n');
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
  };
}
