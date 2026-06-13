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

function createContext(projectRoot: string): McpContext {
  return {
    container: {
      get: () => undefined,
      singletons: { _projectRoot: projectRoot },
    },
  };
}
