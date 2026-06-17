import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import {
  AlembicSearchOutputSchema,
  createAlembicSearchMcpResult,
} from '../../lib/service/project-knowledge-context/contracts/AlembicSearchOutput.js';

const searchSource = fs.readFileSync(
  path.join(process.cwd(), 'lib/runtime/mcp/handlers/search.ts'),
  'utf8'
);
const serverSource = fs.readFileSync(
  path.join(process.cwd(), 'lib/runtime/mcp/McpServer.ts'),
  'utf8'
);

describe('alembic_search detach + alembic_knowledge retire (GMAP-8b)', () => {
  test('alembic_search projects its own AlembicSearchOutput, not KnowledgeContextToolOutput', () => {
    const output = {
      ok: true,
      status: 'ready' as const,
      tool: 'alembic_search' as const,
      toolName: 'alembic_search' as const,
      operation: 'search' as const,
      summary: 'Knowledge search returned 2 of 3 direct match(es).',
      result: { mode: 'auto', residentSearch: { attempted: true, available: true, used: true } },
      inventory: { matchedCount: 3, returnedCount: 2 },
      items: [{ id: 'recipe-a' }, { id: 'recipe-b' }],
      detailRefs: [{ id: 'recipe:recipe-a', kind: 'recipe' }],
      sources: [{ id: 'src-a' }],
      diagnostics: [],
      nextActions: [
        {
          tool: 'alembic_search',
          operation: 'get',
          reason: 'Open a Recipe detail by id.',
          required: false,
        },
      ],
      meta: {
        contractVersion: 1,
        outputSchema: 'AlembicSearchOutput',
        producer: 'alembic-search-handler',
      },
    };
    const parsed = AlembicSearchOutputSchema.parse(output);
    expect(parsed.toolName).toBe('alembic_search');
    expect(parsed.meta.outputSchema).toBe('AlembicSearchOutput');
    // result/inventory are loose passthroughs so resident-search evidence survives.
    expect(parsed.result?.residentSearch).toMatchObject({ available: true });

    const mcpResult = createAlembicSearchMcpResult(output) as {
      content: Array<{ text: string }>;
      structuredContent: { meta: { outputSchema: string } };
    };
    expect(mcpResult.content[0]?.text).toBe(output.summary);
    expect(mcpResult.structuredContent.meta.outputSchema).toBe('AlembicSearchOutput');
  });

  test('search handler no longer routes through the KnowledgeContext middle layer', () => {
    expect(searchSource).not.toContain('defaultProjectKnowledgeContextLayer');
    expect(searchSource).not.toContain('resolveMcpResult(');
    expect(searchSource).toContain('createAlembicSearchMcpResult');
    expect(searchSource).toContain('projectAlembicSearchOutput');
  });

  test('search handler keeps the resident search path and never calls another MCP handler', () => {
    // Resident search execution is preserved (only the output projection changed).
    expect(searchSource).toContain('residentSearch');
    for (const handler of [
      'routeGraphTool',
      'routeRecipeMapTool',
      'routeKnowledgeTool',
      'primeHandler',
      'recipeMap(',
    ]) {
      expect(searchSource).not.toContain(handler);
    }
  });

  test('operation=search/get/expand are the only alembic_search operations', () => {
    expect(searchSource).toContain("operation === 'get' || operation === 'expand'");
  });

  test('alembic_knowledge agent-facing get is retired (not discoverable, forced call retired)', () => {
    const toolNames = TOOLS.map((tool) => tool.name);
    expect(toolNames).toContain('alembic_search');
    expect(toolNames).not.toContain('alembic_knowledge');
    expect(Object.keys(PLUGIN_TOOL_SURFACE_CATALOG)).not.toContain('alembic_knowledge');
    // Forced call resolves to the retired-tool replacement pointing at alembic_search.
    const retiredBlock = serverSource.slice(
      serverSource.indexOf('RETIRED_PUBLIC_TOOL_REPLACEMENTS'),
      serverSource.indexOf('RETIRED_PUBLIC_TOOL_REPLACEMENTS') + 800
    );
    expect(retiredBlock).toContain('alembic_knowledge');
    expect(retiredBlock).toContain('alembic_search');
  });
});
