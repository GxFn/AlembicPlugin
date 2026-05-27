import { describe, expect, it, vi } from 'vitest';
import { search } from '../../lib/external/mcp/handlers/search.js';
import type { McpContext } from '../../lib/external/mcp/handlers/types.js';
import type {
  AlembicResidentProjectScopeIdentity,
  ResidentSearchResult,
} from '../../lib/service/resident/AlembicResidentServiceClient.js';

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
        finalScore: 0.93,
        itemId: 'resident-1',
        rank: 1,
        semanticScore: 0.72,
        signals: ['final-score', 'semantic-score'],
        vectorScore: null,
      },
    ],
    semanticAnchors: [
      {
        kind: 'query',
        source: 'intentSearchPlan.executableQuery',
        value: 'resident search',
        weight: 1,
      },
    ],
    topAnchorMatches: [
      {
        anchor: 'resident search',
        itemId: 'resident-1',
        matchType: 'text',
        rank: 1,
        score: 0.93,
        sourceRefs: ['knowledge:resident-1'],
      },
    ],
    version: 1,
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
          projectScopeIdentity: projectScopeIdentity(),
          requestedMode: 'semantic',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 1,
          route: 'alembic-resident-service',
          intentEvidence: intentEvidenceSummary(),
          searchMeta: {
            route: 'resident-search',
            service: 'alembic-daemon',
            coreRoute: 'semantic(vector)',
            requestedMode: 'semantic',
            actualMode: 'semantic',
            semanticUsed: true,
            vectorUsed: true,
            projectScopeIdentity: projectScopeIdentity(),
            residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
            intentEvidence: intentEvidenceSummary(),
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
        intentEvidence: {
          semanticAnchors: [
            expect.objectContaining({
              value: 'resident search',
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
      },
      intentEvidence: {
        scoreBreakdown: [
          expect.objectContaining({
            itemId: 'resident-1',
            semanticScore: 0.72,
          }),
        ],
        topAnchorMatches: [
          expect.objectContaining({
            itemId: 'resident-1',
          }),
        ],
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

  it('passes host intent context to resident search without changing old fallback shape', async () => {
    const engineSearch = vi.fn(async () => ({ items: [] }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [item('resident-host-1', 'Resident host intent recipe', 0.91)],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          durationMs: 8,
          hostIntentHandoff: {
            degraded: false,
            degradedReasons: [],
            enabled: true,
            requestRoute: 'post-body',
            sessionHistoryCount: 1,
            sourceRefsCount: 2,
          },
          requestedMode: 'auto',
          residentRequestMode: 'semantic',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 1,
          route: 'alembic-resident-service',
          searchMeta: {
            hostIntentApplied: true,
            hostIntentConfidence: 0.7,
            hostIntentSourceRefs: ['host:intent'],
          },
          semanticUsed: true,
          used: true,
          vectorUsed: true,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      query: 'fallback query',
      mode: 'auto',
      limit: 3,
      hostDeclaredIntent: {
        confidence: 0.7,
        keywords: ['intent'],
        query: 'host declared query',
        sourceRefs: ['host:intent', '/Users/example/private.ts'],
      },
      hostTurnMeta: {
        language: 'typescript',
        threadId: 'thread-plain',
      },
      sessionHistory: [{ content: 'previous host turn' }],
      sourceRefs: ['host:top-level', '/tmp/private.ts'],
    })) as { data: Record<string, unknown>; success: boolean };

    expect(result.success).toBe(true);
    expect(residentSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        hostDeclaredIntent: expect.objectContaining({
          query: 'host declared query',
        }),
        hostTurnMeta: expect.objectContaining({
          threadIdHash: expect.any(String),
          redactions: ['threadId'],
        }),
        intentContext: expect.objectContaining({
          recognizedIntentDraft: expect.objectContaining({
            action: 'search',
            confidence: 0.7,
            evidenceSpans: expect.arrayContaining([expect.objectContaining({ field: 'query' })]),
            query: 'host declared query',
            sourceRefs: ['host:intent', 'host:top-level'],
            status: 'recognized',
          }),
          query: 'host declared query',
          sourceRefs: ['host:intent', 'host:top-level'],
        }),
        language: 'typescript',
        sessionHistory: [{ content: 'previous host turn' }],
        sourceRefs: ['host:intent', 'host:top-level'],
      })
    );
    expect(JSON.stringify(residentSearch.mock.calls[0]?.[0])).not.toContain(
      '/Users/example/private.ts'
    );
    expect(JSON.stringify(residentSearch.mock.calls[0]?.[0])).not.toContain('/tmp/private.ts');
    expect(JSON.stringify(residentSearch.mock.calls[0]?.[0])).not.toContain('thread-plain');
    expect(result.data.searchMeta).toMatchObject({
      residentSearch: {
        hostIntentHandoff: {
          enabled: true,
          requestRoute: 'post-body',
        },
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
