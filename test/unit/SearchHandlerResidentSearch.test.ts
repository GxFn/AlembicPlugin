import { describe, expect, it, vi } from 'vitest';
import { search } from '../../lib/runtime/mcp/handlers/search.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
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

function primeInjectionPackageSummary() {
  return {
    injection: {
      degradedReasons: [],
      omittedCount: 0,
      selectedCount: 1,
      status: 'ready',
    },
    intent: {
      applied: true,
      confidence: 0.84,
      degraded: false,
      degradedReasons: [],
      executableQuery: 'resident search',
      requestedMode: 'semantic',
      sourceRefs: ['host:intent'],
      whySelected: ['intent-search-plan'],
    },
    omitted: [],
    relations: {
      evidence: [
        {
          direction: 'outgoing',
          itemId: 'resident-1',
          relatedId: 'recipe-related',
          relation: 'related',
          source: 'knowledgeGraphService',
        },
      ],
      omitted: [],
    },
    search: {
      actualMode: 'semantic',
      filteredCount: 1,
      query: 'resident search',
      queries: ['resident search'],
      requestedMode: 'semantic',
      resultCount: 1,
    },
    selectedKnowledge: [
      {
        evidenceRefs: ['scoreBreakdown:resident-1', 'sourceRef:resident-1:1'],
        injectionStatus: 'selected',
        itemId: 'resident-1',
        kind: 'pattern',
        rank: 1,
        score: 0.93,
        sourceRefs: ['knowledge:resident-1'],
        title: 'Resident vector recipe',
        trigger: '@resident-1',
        whySelected: ['semantic-score'],
      },
    ],
    trace: {
      evidenceRefs: ['scoreBreakdown:resident-1'],
      sourcePath: ['searchMeta.primeInjectionPackage'],
      sourceRefs: ['knowledge:resident-1'],
      sources: ['intentSearchPlan', 'intentEvidence'],
    },
    vector: {
      omitted: [],
      scoreBreakdown: [
        {
          finalScore: 0.93,
          itemId: 'resident-1',
          rank: 1,
          semanticScore: 0.72,
          signals: ['semantic-score'],
          vectorScore: null,
        },
      ],
      semanticAnchors: [],
      semanticUsed: true,
      topAnchorMatches: [],
      vectorAvailable: true,
      vectorUsed: true,
    },
    version: 1,
  };
}

function context(input: {
  engineSearch?: ReturnType<typeof vi.fn>;
  knowledgeService?: Record<string, unknown>;
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
        if (name === 'knowledgeService' && input.knowledgeService) {
          return input.knowledgeService;
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
  };
}

const alphaContent =
  'Use structuredContent as the machine-readable source of truth. Visible MCP content stays summary-only, while detail refs carry long Recipe evidence within caller budgets.';

function recipeEntries() {
  return [
    {
      id: 'recipe-alpha',
      title: 'Structured search result contract',
      trigger: '@structured-search-result',
      kind: 'pattern',
      language: 'typescript',
      category: 'mcp',
      description: 'Project alembic_search through the knowledge-context output contract.',
      doClause: 'Return compact structuredContent with stable detail refs and source evidence.',
      whenClause: 'When MCP tools expose Recipe or knowledge search results.',
      content: {
        markdown: alphaContent,
      },
      quality: {
        overall: 0.88,
      },
      relations: {
        supports: ['recipe-beta'],
      },
      tags: ['mcp', 'knowledge-context'],
    },
    {
      id: 'recipe-beta',
      title: 'Resident vector fallback contract',
      trigger: '@resident-vector-fallback',
      kind: 'fact',
      language: 'typescript',
      category: 'mcp',
      description:
        'Report resident/vector availability or degraded diagnostics for search surfaces.',
      content: {
        markdown:
          'Resident and vector routes may be unavailable; the output must say so explicitly.',
      },
      quality: {
        overall: 0.73,
      },
      relations: {},
      tags: ['resident', 'vector'],
    },
    {
      id: 'mcp-public-tool-quality',
      title: 'MCP endpoint quality relevance contract',
      trigger: '@mcp-public-tool-quality',
      kind: 'pattern',
      language: 'typescript',
      category: 'mcp',
      description:
        'Keep the four MCP knowledge-context endpoints focused on handler schemas, ranking, and semantic quality.',
      doClause:
        'For alembic_search, alembic_prime, alembic_project_matrix, and alembic_graph quality repairs, inspect handler projections, search.ts ranking, ProjectGraphProvider, zodToMcpSchema, and KnowledgeContextToolOutput contracts.',
      whenClause:
        'When Chinese or English user intent asks to repair MCP tool returned content quality, relevance, ranking, or semantic-quality noise.',
      content: {
        markdown:
          'MCP endpoints return structuredContent from knowledge-context providers; quality fixes belong in handlers, schema projection, relevance ranking, semantic-quality gates, and graph partial-boundary logic.',
      },
      quality: {
        overall: 0.95,
      },
      relations: {},
      tags: ['mcp', 'semantic-quality', 'ranking'],
    },
  ];
}

function knowledgeServiceFixture() {
  const entries = recipeEntries();
  return {
    get: vi.fn(async (refId: string) => {
      const normalized = refId.startsWith('knowledge:') ? refId.slice('knowledge:'.length) : refId;
      return entries.find((entry) => entry.id === normalized) ?? null;
    }),
    list: vi.fn(async () => ({
      data: entries,
    })),
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
          primeInjectionPackage: primeInjectionPackageSummary(),
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
            primeInjectionPackage: primeInjectionPackageSummary(),
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
    })) as { structuredContent: Record<string, unknown> };
    const structured = result.structuredContent as {
      items: Array<Record<string, unknown>>;
      result: Record<string, unknown>;
      ok: boolean;
    };

    expect(structured.ok).toBe(true);
    expect(engineSearch).not.toHaveBeenCalled();
    expect(structured.items).toMatchObject([{ id: 'resident-1' }]);
    expect(structured.items[0]?.scoreBreakdown).toMatchObject({
      semanticScore: 0.72,
    });
    expect(structured.result).toMatchObject({
      residentVector: { available: true },
      residentSearch: {
        available: true,
        projectScopeIdentity: {
          mode: 'project-scope',
          projectScopeId: 'project-scope-workspace',
        },
        route: 'alembic-resident-service',
        semanticUsed: true,
        vectorUsed: true,
      },
      searchMeta: {
        intentEvidence: {
          semanticAnchors: [
            expect.objectContaining({
              value: 'resident search',
            }),
          ],
        },
        primeInjectionPackage: {
          injection: {
            selectedCount: 1,
            status: 'ready',
          },
          trace: {
            sources: ['intentSearchPlan', 'intentEvidence'],
          },
        },
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
    })) as { structuredContent: { result: Record<string, unknown>; ok: boolean } };

    expect(result.structuredContent.ok).toBe(true);
    expect(residentSearch).toHaveBeenCalledWith({
      query: 'resident search',
      mode: 'auto',
      limit: 3,
      rank: true,
      kind: 'all',
    });
    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.structuredContent.result).toMatchObject({
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
    })) as { structuredContent: { result: Record<string, unknown>; ok: boolean } };

    expect(result.structuredContent.ok).toBe(true);
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
    expect(result.structuredContent.result).toMatchObject({
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
      items: [item('embedded-1', 'Resident search embedded baseline', 0.81)],
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
    })) as {
      structuredContent: {
        items: Array<Record<string, unknown>>;
        result: Record<string, unknown>;
        ok: boolean;
      };
    };

    expect(result.structuredContent.ok).toBe(true);
    expect(engineSearch).toHaveBeenCalled();
    expect(result.structuredContent.items).toMatchObject([{ id: 'embedded-1' }]);
    expect(result.structuredContent.result).toMatchObject({
      residentVector: { available: false, reason: 'daemon_state_missing' },
      residentSearch: {
        available: false,
        reason: 'daemon_state_missing',
        used: false,
      },
    });
  });

  it('withholds weak fallback candidates that have no query, keyword, or source evidence', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [item('repo-boundary-ratchet', 'Repo Boundary Ratchet', 0.91)],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      keywords: ['get', 'expand', 'detailRefs'],
      limit: 3,
      mode: 'auto',
      query: 'old public surface retired tools get expand detailRefs',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
        status: string;
        summary: string;
      };
    };

    expect(result.structuredContent.status).toBe('degraded');
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.summary).toContain('no trusted candidate');
    expect(result.structuredContent.inventory).toMatchObject({
      noTrustedMatch: true,
      trustedCandidateCount: 0,
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      noTrustedMatch: true,
      weakCandidateCount: expect.any(Number),
    });
  });

  it('keeps fallback candidates when the lexical evidence matches the caller intent', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [item('repo-boundary-ratchet', 'Repo Boundary Ratchet', 0.91)],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      limit: 3,
      mode: 'auto',
      query: 'repo boundary ratchet',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{ id: string; scoreBreakdown: Record<string, unknown> }>;
      };
    };

    expect(result.structuredContent.items[0]).toMatchObject({
      id: 'repo-boundary-ratchet',
      scoreBreakdown: { queryHits: 3 },
    });
    expect(result.structuredContent.inventory).toMatchObject({
      noTrustedMatch: false,
      trustedCandidateCount: expect.any(Number),
    });
  });

  it('withholds resident vector candidates that miss bounded Recipe detail intent anchors', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run when resident search returns items');
    });
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [
          item('service-container', 'ServiceContainer lazy initialization singleton pattern', 0.95),
          item('layer-contract', 'layer-contract.json hard layer reference contract', 0.93),
        ],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          requestedMode: 'auto',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 2,
          route: 'alembic-resident-service',
          searchMeta: {
            actualMode: 'semantic',
            requestedMode: 'semantic',
            route: 'resident-search',
            semanticUsed: true,
            vectorUsed: true,
          },
          semanticUsed: true,
          used: true,
          vectorUsed: true,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      keywords: ['bounded', 'Recipe', 'detailRefs', 'expand', 'summary-only', 'get'],
      limit: 3,
      mode: 'auto',
      query:
        'how should I fetch bounded Recipe details with get expand detailRefs summary only content contract',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
        summary: string;
      };
    };

    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.summary).toContain('no trusted candidate');
    expect(result.structuredContent.inventory).toMatchObject({
      noTrustedMatch: true,
      trustedCandidateCount: 0,
      weakCandidateCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      degradedReason: expect.stringContaining('bounded Recipe detail/get/expand/detailRefs'),
      noTrustedMatch: true,
    });
  });

  it('withholds low-information semantic candidates without caller context anchors', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run when resident search returns items');
    });
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [
          item('logger', 'Logger transport and CLI output conventions', 0.95),
          item('doctrine', 'Doctrine runtime service container pattern', 0.91),
        ],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          requestedMode: 'auto',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 2,
          route: 'alembic-resident-service',
          searchMeta: {
            actualMode: 'semantic',
            requestedMode: 'semantic',
            route: 'resident-search',
            semanticUsed: true,
            vectorUsed: true,
          },
          semanticUsed: true,
          used: true,
          vectorUsed: true,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      limit: 3,
      mode: 'auto',
      query: 'where do I start',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        nextActions: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
        status: string;
      };
    };

    expect(result.structuredContent.status).toBe('degraded');
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.inventory).toMatchObject({
      noTrustedMatch: true,
      trustedCandidateCount: 0,
      weakCandidateCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      degradedReason: expect.stringContaining('Low-information search intent'),
      noTrustedMatch: true,
    });
    expect(result.structuredContent.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_project_matrix', operation: 'overview' }),
      ])
    );
  });

  it('prioritizes Chinese MCP tool quality intent over noisy general knowledge', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [
        item('repo-boundary-ratchet', 'Repo Boundary Ratchet', 0.97),
        item('logger', 'Logger output formatting conventions', 0.94),
        item('soul-runtime', 'SOUL runtime doctrine', 0.92),
      ],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      limit: 4,
      mode: 'auto',
      query: '我要修四个 MCP 工具返回内容质量和语义相关性噪声',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
      };
    };
    const itemIds = result.structuredContent.items.map((entry) => entry.id);

    expect(itemIds).toContain('mcp-public-tool-quality');
    expect(itemIds).not.toEqual(expect.arrayContaining(['repo-boundary-ratchet', 'logger']));
    expect(JSON.stringify(result.structuredContent.items)).not.toContain('SOUL runtime');
    expect(result.structuredContent.inventory).toMatchObject({
      noTrustedMatch: false,
      trustedCandidateCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      noTrustedMatch: false,
    });
  });

  it('keeps bounded Recipe detail contract candidates with real retrieval anchors', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [
        item('service-container', 'ServiceContainer lazy initialization singleton pattern', 0.95),
        item('layer-contract', 'layer-contract.json hard layer reference contract', 0.93),
      ],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      keywords: ['bounded', 'Recipe', 'detailRefs', 'expand', 'summary-only', 'get'],
      limit: 3,
      mode: 'auto',
      query:
        'how should I fetch bounded Recipe details with get expand detailRefs summary only content contract',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{ id: string; scoreBreakdown: Record<string, unknown> }>;
      };
    };

    expect(result.structuredContent.items).toEqual([
      expect.objectContaining({
        id: 'recipe-alpha',
      }),
    ]);
    expect(result.structuredContent.items[0]?.scoreBreakdown).toMatchObject({
      queryHits: expect.any(Number),
    });
    expect(result.structuredContent.inventory).toMatchObject({
      noTrustedMatch: false,
      trustedCandidateCount: 1,
    });
  });

  it('resolves get and expand through the real handler with stable detail refs and degraded vector diagnostics', async () => {
    const knowledgeService = knowledgeServiceFixture();
    const baseContext = context({ knowledgeService });

    const getResult = (await search(baseContext, {
      operation: 'get',
      refId: 'knowledge:recipe-alpha',
      limit: 5,
      budget: {
        contentCharLimit: 160,
        relationHopLimit: 2,
      },
    })) as {
      content: Array<{ text: string; type: 'text' }>;
      structuredContent: {
        detailRefs: Array<Record<string, unknown>>;
        diagnostics: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        ok: boolean;
        relations: Array<Record<string, unknown>>;
        result: Record<string, unknown>;
        summary: string;
      };
    };

    expect(getResult.content).toEqual([
      { type: 'text', text: getResult.structuredContent.summary },
    ]);
    expect(getResult.structuredContent.ok).toBe(true);
    expect(getResult.structuredContent.items).toMatchObject([
      {
        id: 'recipe-alpha',
        detailRefId: 'knowledge:recipe-alpha',
        whyMatched: ['knowledge-service'],
        scoreBreakdown: {
          vectorUsed: false,
        },
      },
    ]);
    expect(getResult.structuredContent.detailRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge:get:knowledge:recipe-alpha',
          operation: 'get',
          requiredForCompletion: true,
        }),
      ])
    );
    expect(getResult.structuredContent.relations).toEqual([
      expect.objectContaining({
        hops: ['recipe-alpha', 'recipe-beta'],
        relationType: 'supports',
      }),
    ]);
    expect(getResult.structuredContent.result).toMatchObject({
      found: true,
      refId: 'knowledge:recipe-alpha',
      residentSearch: {
        available: false,
        reason: 'detail-operation-uses-knowledge-service',
      },
      residentVector: {
        available: false,
        reason: 'detail-operation-uses-knowledge-service',
      },
      vector: {
        available: false,
        used: false,
      },
    });
    expect(getResult.structuredContent.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: 'vector',
          severity: 'warning',
        }),
      ])
    );

    const expandResult = (await search(baseContext, {
      operation: 'expand',
      detailRefId: 'knowledge:recipe-alpha',
      limit: 5,
      budget: {
        contentCharLimit: 120,
        relationHopLimit: 1,
      },
    })) as {
      content: Array<{ text: string; type: 'text' }>;
      structuredContent: {
        detailRefs: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        ok: boolean;
        relations: Array<Record<string, unknown>>;
        result: {
          expanded?: {
            contentPreview?: string;
            detailRefs?: string[];
          };
          vector?: Record<string, unknown>;
        };
        summary: string;
      };
    };

    expect(expandResult.content[0]?.text).toBe(expandResult.structuredContent.summary);
    expect(expandResult.structuredContent.ok).toBe(true);
    expect(expandResult.structuredContent.detailRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge:expand:knowledge:recipe-alpha',
          operation: 'expand',
          requiredForCompletion: true,
        }),
      ])
    );
    expect(expandResult.structuredContent.result.expanded).toMatchObject({
      detailRefs: ['knowledge:recipe-alpha'],
    });
    expect(expandResult.structuredContent.result.expanded?.contentPreview).toMatch(/\.\.\.$/);
    expect(expandResult.structuredContent.result.vector).toMatchObject({
      available: false,
      used: false,
    });
    expect(expandResult.structuredContent.relations).toHaveLength(1);
  });
});
