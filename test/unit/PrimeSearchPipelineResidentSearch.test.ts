import { describe, expect, it, vi } from 'vitest';
import type {
  ResidentSearchAttemptMeta,
  ResidentSearchResult,
} from '../../lib/service/resident/AlembicResidentServiceClient.js';
import type { ExtractedIntent } from '../../lib/service/task/IntentExtractor.js';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

function intent(): ExtractedIntent {
  return {
    queries: ['VideoURLPreloader async bridge'],
    keywordQueries: ['VideoURLPreloader'],
    language: 'swift',
    module: 'Player',
    scenario: 'search',
    raw: { userQuery: 'Use VideoURLPreloader async bridge', language: 'swift' },
  };
}

function item(id: string, title: string, score: number, kind = 'pattern') {
  return {
    id,
    title,
    trigger: `@${id}`,
    kind,
    language: 'swift',
    score,
    description: `${title} guidance`,
  };
}

function residentMeta(
  overrides: Partial<ResidentSearchAttemptMeta> = {}
): ResidentSearchAttemptMeta {
  return {
    attempted: true,
    available: true,
    actualMode: 'semantic',
    coreRoute: 'semantic(vector)',
    durationMs: 12,
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
    ...overrides,
  };
}

describe('PrimeSearchPipeline resident search enhancement', () => {
  it('requests resident semantic search and merges resident results into prime material', async () => {
    const engine = {
      search: vi.fn(async (_query: string, options?: { mode?: string }) => {
        if (options?.mode === 'auto') {
          return { items: [item('embedded-1', 'Embedded baseline', 0.72)] };
        }
        return { items: [] };
      }),
    };
    const residentServiceClient = {
      search: vi.fn(
        async (): Promise<ResidentSearchResult> => ({
          items: [item('resident-1', 'Resident vector recipe', 0.95)],
          meta: residentMeta(),
        })
      ),
    };

    const pipeline = new PrimeSearchPipeline(engine, { residentServiceClient });
    const result = await pipeline.search(intent());

    expect(residentServiceClient.search).toHaveBeenCalledWith({
      query: 'VideoURLPreloader async bridge',
      mode: 'semantic',
      limit: 6,
      rank: false,
    });
    expect(result?.relatedKnowledge.map((entry) => entry.id)).toContain('resident-1');
    expect(result?.searchMeta.residentSearch).toMatchObject({
      available: true,
      route: 'alembic-resident-service',
      semanticUsed: true,
      vectorUsed: true,
    });
  });

  it('falls back to embedded baseline when resident service is unavailable', async () => {
    const engine = {
      search: vi.fn(async (_query: string, options?: { mode?: string }) => {
        if (options?.mode === 'auto') {
          return { items: [item('embedded-1', 'Embedded baseline', 0.82)] };
        }
        return { items: [] };
      }),
    };
    const residentServiceClient = {
      search: vi.fn(
        async (): Promise<ResidentSearchResult> => ({
          items: [],
          meta: residentMeta({
            available: false,
            reason: 'daemon_state_missing',
            residentVector: { available: false, reason: 'daemon_state_missing' },
            resultCount: 0,
            searchMeta: undefined,
            semanticUsed: false,
            used: false,
            vectorUsed: false,
          }),
        })
      ),
    };

    const pipeline = new PrimeSearchPipeline(engine, { residentServiceClient });
    const result = await pipeline.search(intent());

    expect(result?.relatedKnowledge.map((entry) => entry.id)).toEqual(['embedded-1']);
    expect(result?.searchMeta.residentSearch).toMatchObject({
      available: false,
      reason: 'daemon_state_missing',
      residentVector: { available: false },
      used: false,
    });
  });

  it('keeps resident unavailable metadata even when baseline has no accepted result', async () => {
    const engine = {
      search: vi.fn(async () => ({ items: [] })),
    };
    const residentServiceClient = {
      search: vi.fn(
        async (): Promise<ResidentSearchResult> => ({
          items: [],
          meta: residentMeta({
            available: false,
            reason: 'daemon_state_missing',
            residentVector: { available: false, reason: 'daemon_state_missing' },
            resultCount: 0,
            searchMeta: undefined,
            semanticUsed: false,
            used: false,
            vectorUsed: false,
          }),
        })
      ),
    };

    const pipeline = new PrimeSearchPipeline(engine, { residentServiceClient });
    const result = await pipeline.search(intent());

    expect(result).toMatchObject({
      relatedKnowledge: [],
      guardRules: [],
      searchMeta: {
        filteredCount: 0,
        resultCount: 0,
        residentSearch: {
          available: false,
          reason: 'daemon_state_missing',
          residentVector: { available: false },
        },
      },
    });
  });

  it('records resident search request failures and still returns baseline knowledge', async () => {
    const engine = {
      search: vi.fn(async (_query: string, options?: { mode?: string }) => {
        if (options?.mode === 'auto') {
          return { items: [item('embedded-1', 'Embedded baseline', 0.82)] };
        }
        return { items: [] };
      }),
    };
    const residentServiceClient = {
      search: vi.fn(async () => {
        throw new Error('resident request failed');
      }),
    };

    const pipeline = new PrimeSearchPipeline(engine, { residentServiceClient });
    const result = await pipeline.search(intent());

    expect(result?.relatedKnowledge.map((entry) => entry.id)).toEqual(['embedded-1']);
    expect(result?.searchMeta.residentSearch).toMatchObject({
      available: false,
      reason: 'resident request failed',
      residentVector: { available: false },
      used: false,
    });
  });
});
