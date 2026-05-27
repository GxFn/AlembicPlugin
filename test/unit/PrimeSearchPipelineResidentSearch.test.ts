import { describe, expect, it, vi } from 'vitest';
import type {
  AlembicResidentProjectScopeIdentity,
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

function projectScopeIdentity(): AlembicResidentProjectScopeIdentity {
  return {
    available: true,
    controlRoot: '/workspace',
    currentFolderId: 'folder-plugin',
    currentFolderPath: '/workspace/AlembicPlugin',
    dataRoot: '/tmp/alembic-scope',
    dataRootSource: 'ghost-registry',
    diagnosticProjectRoot: '/workspace/AlembicPlugin',
    folderCount: 2,
    folders: [],
    mode: 'project-scope',
    projectId: 'project-workspace',
    projectRoot: '/workspace/AlembicPlugin',
    projectScope: null,
    projectScopeCapability: null,
    projectScopeId: 'project-scope-workspace',
    reason: null,
    resident: {
      owner: 'alembic',
      route: 'local-alembic-daemon',
      serviceScopeId: 'project-scope:project-scope-workspace',
    },
    serviceScopeId: 'project-scope:project-scope-workspace',
    source: 'resident-service-scope',
    storageKind: 'ghost',
    workspaceMode: 'ghost',
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
    projectScopeIdentity: projectScopeIdentity(),
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
      projectScopeIdentity: projectScopeIdentity(),
    },
    semanticUsed: true,
    service: 'alembic-daemon',
    used: true,
    vectorUsed: true,
    ...overrides,
  };
}

function intentEvidenceSummary() {
  return {
    degraded: false,
    degradedReasons: ['vector:evidence-observe-only'],
    relationEvidence: [
      {
        direction: 'outgoing',
        itemId: 'resident-1',
        relatedId: 'recipe-related',
        relation: 'related',
        source: 'knowledgeGraphService',
      },
    ],
    scoreBreakdown: [
      {
        finalScore: 0.95,
        itemId: 'resident-1',
        rank: 1,
        semanticScore: 0.85,
        signals: ['final-score', 'semantic-score'],
        vectorScore: null,
      },
    ],
    semanticAnchors: [
      {
        kind: 'query',
        source: 'intentSearchPlan.executableQuery',
        value: 'VideoURLPreloader async bridge',
        weight: 1,
      },
    ],
    topAnchorMatches: [
      {
        anchor: 'VideoURLPreloader',
        itemId: 'resident-1',
        matchType: 'text',
        rank: 1,
        score: 0.95,
        sourceRefs: ['knowledge:resident-1'],
      },
    ],
    version: 1,
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
          meta: residentMeta({
            intentEvidence: intentEvidenceSummary(),
            searchMeta: {
              intentEvidence: intentEvidenceSummary(),
            },
          }),
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
      intentEvidence: {
        semanticAnchors: [
          expect.objectContaining({
            value: 'VideoURLPreloader async bridge',
          }),
        ],
      },
      projectScopeIdentity: {
        mode: 'project-scope',
        projectScopeId: 'project-scope-workspace',
      },
      route: 'alembic-resident-service',
      semanticUsed: true,
      vectorUsed: true,
    });
    expect(result?.searchMeta.intentEvidence).toMatchObject({
      scoreBreakdown: [
        expect.objectContaining({
          itemId: 'resident-1',
          semanticScore: 0.85,
        }),
      ],
      topAnchorMatches: [
        expect.objectContaining({
          itemId: 'resident-1',
        }),
      ],
    });
  });

  it('passes redacted host intent context to resident semantic search', async () => {
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
          meta: residentMeta({
            hostIntentHandoff: {
              degraded: false,
              degradedReasons: [],
              enabled: true,
              requestRoute: 'post-body',
              sessionHistoryCount: 0,
              sourceRefsCount: 1,
            },
            searchMeta: {
              hostIntentApplied: true,
              hostIntentConfidence: 0.82,
              hostIntentSourceRefs: ['host:intent'],
            },
          }),
        })
      ),
    };

    const pipeline = new PrimeSearchPipeline(engine, { residentServiceClient });
    const result = await pipeline.search(intent(), {
      hostIntentFrame: {
        confidence: 0.82,
        degraded: false,
        degradedReasons: [],
        extracted: {
          language: 'swift',
          module: 'Player',
          queries: ['VideoURLPreloader async bridge'],
          scenario: 'search',
        },
        hostDeclaredIntent: {
          keywords: ['async'],
          query: 'VideoURLPreloader async bridge',
          sourceRefs: ['host:intent', '/Users/example/private.ts'],
        },
        hostTurnMeta: {
          redactions: ['threadId', 'activeFile'],
          threadIdHash: 'thread-hash',
        },
        recognizedIntentDraft: {
          action: 'search',
          confidence: 0.82,
          constraints: ['async'],
          degraded: false,
          degradedReasons: [],
          evidenceSpans: [
            {
              field: 'query',
              source: 'hostDeclaredIntent',
              start: 0,
              end: 31,
              text: 'VideoURLPreloader async bridge',
            },
          ],
          query: 'VideoURLPreloader async bridge',
          source: 'host-declared',
          sourceRefs: ['host:intent'],
          status: 'recognized',
          target: 'VideoURLPreloader',
        },
        source: 'host-declared',
      },
    });

    expect(residentServiceClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        hostDeclaredIntent: expect.objectContaining({
          query: 'VideoURLPreloader async bridge',
        }),
        hostTurnMeta: expect.objectContaining({
          threadIdHash: 'thread-hash',
        }),
        intentContext: expect.objectContaining({
          confidence: 0.82,
          query: 'VideoURLPreloader async bridge',
          recognizedIntentDraft: expect.objectContaining({
            action: 'search',
            confidence: 0.82,
            evidenceSpans: expect.arrayContaining([expect.objectContaining({ field: 'query' })]),
            query: 'VideoURLPreloader async bridge',
            sourceRefs: ['host:intent'],
            status: 'recognized',
          }),
          sourceRefs: ['host:intent'],
        }),
        language: 'swift',
        sourceRefs: ['host:intent'],
      })
    );
    expect(JSON.stringify(residentServiceClient.search.mock.calls[0]?.[0])).not.toContain(
      '/Users/example/private.ts'
    );
    expect(result?.searchMeta.residentSearch).toMatchObject({
      hostIntentHandoff: {
        enabled: true,
        requestRoute: 'post-body',
      },
      searchMeta: {
        hostIntentApplied: true,
      },
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
