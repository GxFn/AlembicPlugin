import { describe, expect, test, vi } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { search } from '../../lib/host-runtime/mcp/handlers/search.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';

function context(searchEngine: { search: ReturnType<typeof vi.fn> }): McpContext {
  const projectRoot = process.cwd();
  return {
    container: {
      get(name: string) {
        if (name === 'searchEngine') return searchEngine;
        if (name === 'knowledgeService') return { get: vi.fn(), list: vi.fn() };
        return undefined;
      },
    },
    projectRuntime: buildProjectRuntimeContext({ projectRoot }),
  } as unknown as McpContext;
}

describe('alembic_search public SearchEngine route', () => {
  test('returns underlying semantic/vector success instead of legacy zero results', async () => {
    const searchEngine = {
      search: vi.fn().mockResolvedValue({
        items: [{ id: 'recipe-vector', title: 'Feature isolation', kind: 'pattern', score: 0.92 }],
        total: 1,
        mode: 'semantic',
        searchMeta: {
          requestedMode: 'semantic',
          actualMode: 'semantic',
          route: 'semantic',
          semanticUsed: true,
          vectorUsed: true,
          resultCount: 1,
        },
      }),
    };
    const result = (await search(context(searchEngine), {
      operation: 'search',
      query: 'module isolation',
      mode: 'semantic',
      limit: 5,
    })) as { structuredContent: Record<string, any> };

    expect(searchEngine.search).toHaveBeenCalledWith(
      'module isolation',
      expect.objectContaining({ mode: 'semantic', limit: 5 })
    );
    expect(result.structuredContent.items).toHaveLength(1);
    expect(result.structuredContent.result).toMatchObject({
      actualMode: 'semantic',
      route: 'semantic',
      semanticUsed: true,
      vectorUsed: true,
    });
  });

  test('reports an honest bounded keyword fallback without provider details', async () => {
    const searchEngine = {
      search: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        mode: 'keyword',
        searchMeta: {
          requestedMode: 'semantic',
          actualMode: 'keyword',
          route: 'keyword-fallback',
          semanticUsed: false,
          vectorUsed: false,
          resultCount: 0,
          fallbackReason:
            'semantic_search_failed:connect ECONNREFUSED http://127.0.0.1:11434/api/embed',
        },
      }),
    };
    const result = (await search(context(searchEngine), {
      query: 'missing',
      mode: 'semantic',
    })) as { structuredContent: Record<string, any> };

    expect(result.structuredContent.result).toMatchObject({
      actualMode: 'keyword',
      vectorUsed: false,
      fallbackReason: 'semantic-search-failed',
    });
    expect(result.structuredContent.diagnostics.map((item: any) => item.code)).toEqual(
      expect.arrayContaining(['search-keyword-fallback', 'search-zero-match'])
    );
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
  });
});
