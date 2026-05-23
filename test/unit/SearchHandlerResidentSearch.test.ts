import { describe, expect, it, vi } from 'vitest';
import { search } from '../../lib/external/mcp/handlers/search.js';
import type { McpContext } from '../../lib/external/mcp/handlers/types.js';
import type { ResidentSearchResult } from '../../lib/service/resident/AlembicResidentServiceClient.js';

function item(id: string, title: string, score: number) {
  return {
    id,
    title,
    trigger: `@${id}`,
    kind: 'pattern',
    language: 'typescript',
    score,
    description: `${title} guidance`,
  };
}

function context(input: {
  engineSearch?: ReturnType<typeof vi.fn>;
  residentSearch?: ReturnType<typeof vi.fn>;
}): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'searchEngine') {
          return { search: input.engineSearch ?? vi.fn(async () => ({ items: [] })) };
        }
        if (name === 'residentServiceClient') {
          return { search: input.residentSearch ?? vi.fn(async () => ({ items: [] })) };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
  };
}

describe('alembic_search resident search enhancement', () => {
  it('uses resident search results for semantic requests and exposes resident metadata', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run when resident search returns items');
    });
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [item('resident-1', 'Resident vector recipe', 0.93)],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          coreRoute: 'semantic(vector)',
          durationMs: 9,
          requestedMode: 'semantic',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 1,
          route: 'alembic-resident-service',
          searchMeta: {
            route: 'resident-search',
            service: 'alembic-daemon',
            coreRoute: 'semantic(vector)',
            requestedMode: 'semantic',
            actualMode: 'semantic',
            semanticUsed: true,
            vectorUsed: true,
            residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          },
          semanticUsed: true,
          service: 'alembic-daemon',
          used: true,
          vectorUsed: true,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      query: 'resident search',
      mode: 'semantic',
      limit: 3,
    })) as { data: Record<string, unknown>; success: boolean };

    expect(result.success).toBe(true);
    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.data.items).toMatchObject([{ id: 'resident-1' }]);
    expect(result.data.searchMeta).toMatchObject({
      residentVector: { available: true },
      residentSearch: {
        available: true,
        route: 'alembic-resident-service',
        semanticUsed: true,
        vectorUsed: true,
      },
    });
  });

  it('keeps Codex auto mode while exposing normalized resident request mode', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error(
        'embedded search should not run when resident auto enhancement returns items'
      );
    });
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [item('resident-auto-1', 'Resident auto vector recipe', 0.91)],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          coreRoute: 'semantic(vector)',
          durationMs: 8,
          residentRequestMode: 'semantic',
          requestedMode: 'auto',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 1,
          route: 'alembic-resident-service',
          searchMeta: {
            route: 'resident-search',
            service: 'alembic-daemon',
            requestedMode: 'semantic',
            actualMode: 'semantic',
            codexRequestedMode: 'auto',
            residentRequestMode: 'semantic',
            semanticUsed: true,
            vectorUsed: true,
          },
          semanticUsed: true,
          service: 'alembic-daemon',
          used: true,
          vectorUsed: true,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      query: 'resident search',
      mode: 'auto',
      limit: 3,
    })) as { data: Record<string, unknown>; success: boolean };

    expect(result.success).toBe(true);
    expect(residentSearch).toHaveBeenCalledWith({
      query: 'resident search',
      mode: 'auto',
      limit: 3,
      rank: true,
      kind: 'all',
    });
    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.data.searchMeta).toMatchObject({
      residentSearch: {
        requestedMode: 'auto',
        residentRequestMode: 'semantic',
        semanticUsed: true,
        vectorUsed: true,
      },
    });
  });

  it('falls back to embedded search when resident search is unavailable', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [item('embedded-1', 'Embedded baseline', 0.81)],
      mode: 'weighted',
      searchMeta: {
        route: 'field-weighted',
        requestedMode: 'semantic',
        actualMode: 'weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [],
        meta: {
          attempted: true,
          available: false,
          durationMs: 0,
          reason: 'daemon_state_missing',
          requestedMode: 'semantic',
          residentVector: { available: false, reason: 'daemon_state_missing' },
          resultCount: 0,
          route: 'alembic-resident-service',
          used: false,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      query: 'resident search',
      mode: 'semantic',
      limit: 3,
    })) as { data: Record<string, unknown>; success: boolean };

    expect(result.success).toBe(true);
    expect(engineSearch).toHaveBeenCalled();
    expect(result.data.items).toMatchObject([{ id: 'embedded-1' }]);
    expect(result.data.searchMeta).toMatchObject({
      residentVector: { available: false, reason: 'daemon_state_missing' },
      residentSearch: {
        available: false,
        reason: 'daemon_state_missing',
        used: false,
      },
    });
  });
});
