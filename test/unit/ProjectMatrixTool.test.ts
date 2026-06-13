import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, test } from 'vitest';
import { routeProjectMatrixTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { getPluginToolSurfaceEntry } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import type { KnowledgeContextToolOutput } from '../../lib/service/project-knowledge-context/index.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const projectRoot = path.resolve(process.cwd());

function createContext(entries = representativeKnowledgeEntries()): McpContext {
  return {
    container: {
      get(name: string) {
        if (name === 'knowledgeService') {
          return {
            async list() {
              return { data: entries, pagination: { total: entries.length } };
            },
          };
        }
        throw new Error(`Unexpected service lookup: ${name}`);
      },
    },
  } as unknown as McpContext;
}

function representativeKnowledgeEntries() {
  return [
    {
      category: 'Runtime',
      description: 'Keep runtime boundaries explicit and ref-based.',
      id: 'recipe-runtime-boundary',
      kind: 'rule',
      language: 'typescript',
      title: 'Runtime boundary contract',
    },
    {
      category: 'MCP',
      description: 'Public MCP tools return compact structuredContent and detailRefs.',
      id: 'recipe-mcp-output-contract',
      kind: 'pattern',
      language: 'typescript',
      title: 'MCP output contract',
    },
  ];
}

function structured(result: CallToolResult): KnowledgeContextToolOutput {
  return result.structuredContent as KnowledgeContextToolOutput;
}

describe('alembic_project_matrix public MCP tool', () => {
  test('is exposed through schema, tools list, and catalog surfaces', () => {
    expect(TOOL_SCHEMAS.alembic_project_matrix.safeParse({ operation: 'overview' }).success).toBe(
      true
    );
    expect(TOOLS.map((tool) => tool.name)).toContain('alembic_project_matrix');
    expect(getPluginToolSurfaceEntry('alembic_project_matrix')).toMatchObject({
      annotations: expect.objectContaining({ readOnlyHint: true }),
      handlerOwner: 'McpServer.tool-router',
      knowledgeGate: 'resident-project-scope',
      residentRoutePolicy: 'resident-project-scope',
      schema: 'ProjectMatrixInput',
    });
  });

  test('returns compact overview for the real AlembicPlugin project root', async () => {
    const result = (await routeProjectMatrixTool(createContext(), {
      budget: {
        contentCharLimit: 1200,
        detailLimit: 12,
        itemLimit: 8,
        matrixNodeLimit: 80,
        nextActionLimit: 3,
        relationHopLimit: 10,
      },
      operation: 'overview',
      projectRoot,
      sourceEvidenceRefs: ['recipeRelation:test'],
      sourceGraphRef: 'source-graph:test',
      sourceRefs: ['knowledge:recipe-runtime-boundary'],
    })) as CallToolResult;
    const output = structured(result);
    const serialized = JSON.stringify(output);

    expect(result.content).toEqual([{ type: 'text', text: output.summary }]);
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('alembic_project_matrix');
    expect(output.operation).toBe('overview');
    expect(output.project?.projectRoot).toBe(projectRoot);
    expect(output.result?.sourceGraphStatus).toMatchObject({ state: 'ready' });
    expect(output.result?.matrixNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'project' })])
    );
    expect(output.inventory?.catalogCategories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'MCP' }),
        expect.objectContaining({ category: 'Runtime' }),
      ])
    );
    expect(output.nextActions.map((action) => action.tool)).toEqual(
      expect.arrayContaining(['alembic_project_matrix', 'alembic_search', 'alembic_graph'])
    );
    expect(serialized).not.toContain('coveredByKnowledge');
    expect(serialized).not.toContain('hasGap');
  });

  test('catalog operation summarizes categories without recipe bodies', async () => {
    const result = (await routeProjectMatrixTool(createContext(), {
      operation: 'catalog',
      projectRoot,
      sourceEvidenceRefs: ['recipeRelation:test'],
      sourceGraphRef: 'source-graph:test',
    })) as CallToolResult;
    const output = structured(result);
    const serialized = JSON.stringify(output);

    expect(output.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'MCP',
          kind: 'knowledge-category',
          representativeRefs: expect.arrayContaining(['knowledge:recipe-mcp-output-contract']),
        }),
      ])
    );
    expect(output.result?.catalog).toMatchObject({ itemCount: 2 });
    expect(serialized).not.toContain('full Recipe');
    expect(serialized).not.toContain('content markdown');
  });

  test('reports degraded or partial data instead of pretending missing domains are ready', async () => {
    const result = (await routeProjectMatrixTool(createContext([]), {
      operation: 'overview',
      projectRoot: path.join(projectRoot, '.missing-project-matrix-fixture'),
    })) as CallToolResult;
    const output = structured(result);

    expect(output.ok).toBe(true);
    expect(output.status).toBe('degraded');
    expect(output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'project' }),
        expect.objectContaining({ domain: 'knowledge' }),
        expect.objectContaining({ domain: 'sourceGraph' }),
      ])
    );
  });
});
