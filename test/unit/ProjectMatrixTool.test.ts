import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { routeProjectMatrixTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { getPluginToolSurfaceEntry } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import type { KnowledgeContextToolOutput } from '../../lib/service/project-knowledge-context/index.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const projectRoot = path.resolve(process.cwd());
const tempRoots: string[] = [];

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
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

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
      sourceRefs: ['knowledge:recipe-runtime-boundary'],
    })) as CallToolResult;
    const output = structured(result);
    const serialized = JSON.stringify(output);

    expect(result.content).toEqual([{ type: 'text', text: output.summary }]);
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('alembic_project_matrix');
    expect(output.operation).toBe('overview');
    expect(output.project?.projectRoot).toBe(projectRoot);
    expect(output.result?.projectContext).toMatchObject({ refCount: expect.any(Number) });
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

  test('uses workspace.config repoNames as the project matrix boundary', async () => {
    const root = createWorkspaceFixtureProject();
    const result = (await routeProjectMatrixTool(createContext(), {
      budget: { itemLimit: 20, matrixNodeLimit: 80, relationHopLimit: 10 },
      operation: 'overview',
      projectRoot: root,
    })) as CallToolResult;
    const output = structured(result);
    const serialized = JSON.stringify(output);

    expect(serialized).toContain('AlembicPlugin');
    expect(serialized).toContain('AlembicCore');
    expect(serialized).not.toContain('.DS_Store');
    expect(serialized).not.toContain('Test');
    expect(serialized).not.toContain('wakeflow-ledger');
    expect(serialized).not.toContain('workspace-ledger');
    expect(serialized).not.toContain('legacy-docs-do-not-use');
    expect(serialized).not.toContain('file-flow parser is unavailable');
    expect(serialized).not.toContain('file-flow import target was not found');
  });

  test('derives useful catalog categories from coarse Utility and Service entries', async () => {
    const result = (await routeProjectMatrixTool(
      createContext([
        {
          category: 'Utility',
          description: 'Controller return delivery envelope and task package routing.',
          id: 'recipe-wakeflow-dispatch-gate',
          kind: 'pattern',
          language: 'typescript',
          title: 'Wakeflow dispatch gate',
        },
        {
          category: 'Service',
          description: 'Callers, callees, and validation plan source graph workflow.',
          id: 'recipe-source-graph-callers',
          kind: 'rule',
          language: 'typescript',
          title: 'Source graph callers',
        },
      ]),
      {
        operation: 'catalog',
        projectRoot,
      }
    )) as CallToolResult;
    const output = structured(result);
    const categories = (
      (output.result?.catalog as { categories?: Array<{ category: string }> }).categories ?? []
    ).map((entry) => entry.category);

    expect(categories).toEqual(expect.arrayContaining(['Source Graph', 'Wakeflow']));
    expect(categories).not.toEqual(expect.arrayContaining(['Service', 'Utility']));
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
        expect.objectContaining({ domain: 'document' }),
      ])
    );
  });
});

function createWorkspaceFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-matrix-workspace-fixture-'));
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
  writeFile(root, 'AlembicCore/.claude/settings.json', '{}\n');
  writeFile(
    root,
    'AlembicCore/vitest.unit.config.ts',
    'import baseConfig from "./vitest.config";\nexport default baseConfig;\n'
  );
  writeFile(root, 'AlembicPlugin/.DS_Store', 'noise');
  writeFile(root, 'AlembicPlugin/lib/index.ts', 'export const plugin = "plugin";\n');
  writeFile(
    root,
    'AlembicPlugin/lib/service/project-knowledge-context/project/NoisyProjectContextAdapter.ts',
    'import missingProjectContext from "./missing-project-context";\nexport const adapter = missingProjectContext;\n'
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
