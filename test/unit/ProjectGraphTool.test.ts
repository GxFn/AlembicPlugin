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
      sourceGraphRef: 'source-graph:fixture',
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
      sourceGraphStatus: 'linked',
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
      insufficientSourceGraph: true,
      matrixNodes: [],
      noMatchReason: 'No bounded project graph nodes matched the focused query terms.',
      queryMatchedNodeCount: 0,
    });
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

  test('rejects legacy Recipe graph input at the public schema boundary', () => {
    expect(GraphInput.safeParse({ nodeType: 'recipe' }).success).toBe(false);
    expect(GraphInput.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
    expect(GraphInput.safeParse({ relation: 'hasGap' }).success).toBe(false);
    expect(
      GraphInput.safeParse({ operation: 'neighborhood', nodeType: 'source-graph-node' }).success
    ).toBe(true);
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
  writeFile(root, 'AlembicCore/src/index.ts', 'export const core = "core";\n');
  writeFile(
    root,
    'AlembicPlugin/lib/index.ts',
    'import { core } from "../../AlembicCore/src/index";\nexport const plugin = core;\n'
  );
  writeFile(root, 'Test/lib/index.ts', 'export const testSurface = true;\n');
  writeFile(root, 'wakeflow-ledger/AlembicWorkspace/index.md', '# ledger\n');
  writeFile(root, 'workspace-ledger/index.md', '# workspace ledger\n');
  writeFile(root, 'legacy-docs-do-not-use/index.md', '# legacy\n');
  return root;
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
