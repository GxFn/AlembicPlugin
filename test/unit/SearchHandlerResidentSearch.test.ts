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
    {
      id: 'project-graph-provider-selection',
      title: 'ProjectGraphProvider ProjectContext request selection',
      trigger: '@project-graph-provider-selection',
      kind: 'fact',
      language: 'typescript',
      category: 'project-knowledge-context',
      description:
        'ProjectGraphProvider chooses bounded ProjectContext repo, map, module, file-flow, neighborhood, and impact requests for alembic_graph.',
      doClause:
        'Use ProjectGraphProvider.ts when repairing graph operation query, neighborhood, impact, and ProjectContext public contract request fan-out.',
      content: {
        markdown:
          'Active file AlembicPlugin/lib/service/project-knowledge-context/project/ProjectGraphProvider.ts owns ProjectContext-backed graph request selection and diagnostics.',
      },
      metadata: {
        moduleName: 'project-knowledge-context',
        path: 'AlembicPlugin/lib/service/project-knowledge-context/project/ProjectGraphProvider.ts',
        tags: ['ProjectGraphProvider', 'ProjectContext', 'alembic_graph'],
      },
      quality: {
        overall: 0.9,
      },
      relations: {},
      tags: ['ProjectGraphProvider', 'ProjectContext'],
    },
    {
      id: 'wakeflow-thread-id-local-runtime',
      title: 'Wakeflow direct-thread ids stay in local runtime only',
      trigger: '@wakeflow-thread-id-local-runtime',
      kind: 'rule',
      language: 'typescript',
      category: 'wakeflow-governance',
      description:
        'Direct-thread delivery uses Wakeflow local runtime for real thread ids and must not write them to tracked documents, GitHub, prompts, or backfill text.',
      doClause:
        'Keep controller-return delivery proof in Wakeflow delivery runs; tracked documents record only redacted evidence.',
      content: {
        markdown:
          'Wakeflow direct-thread dispatch, controller-return, and record-delivery-run keep real thread ids in .workspace-local runtime state only.',
      },
      quality: {
        overall: 0.93,
      },
      relations: {},
      tags: ['Wakeflow', 'direct-thread', 'thread-id'],
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

function expectPublicSearchJsonToOmitRelationAndPrimeMaterial(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    '"relations"',
    'recipeRelation',
    'relationHops',
    'relationHopLimit',
    'relation-chain',
    'relation health',
    'primeInjectionPackage',
    'intentEvidence',
    'Trust Receipt',
    'DecisionRegister',
    'retrievalConsumer',
    '"sourceRefs":',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
}

describe('alembic_search resident search enhancement', () => {
  it('rejects unsupported public search modes before routing to resident or embedded search', async () => {
    const engineSearch = vi.fn(async () => ({ items: [] }));
    const residentSearch = vi.fn(async () => ({ items: [] }));

    for (const mode of ['bm25', 'context', 'unsupported-mode', 'legacy-mode']) {
      await expect(
        search(context({ engineSearch, residentSearch }), {
          query: 'unsupported mode',
          mode,
        })
      ).rejects.toThrow(/Supported modes: auto, keyword, semantic/u);
    }

    expect(engineSearch).not.toHaveBeenCalled();
    expect(residentSearch).not.toHaveBeenCalled();
  });

  it('uses resident search results for semantic requests without exposing prime-only metadata', async () => {
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
          primeInjectionPackage: primeInjectionPackageSummary(),
          searchMeta: {
            route: 'resident-search',
            service: 'alembic-daemon',
            coreRoute: 'semantic(vector)',
            requestedMode: 'semantic',
            actualMode: 'semantic',
            semanticUsed: true,
            vectorUsed: true,
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
            projectScopeIdentity: projectScopeIdentity(),
            residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
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
    expect(structured).not.toHaveProperty('relations');
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
    });
    const serialized = JSON.stringify(structured);
    expect(serialized).not.toContain('intentEvidence');
    expect(serialized).not.toContain('primeInjectionPackage');
    expect(serialized).not.toContain('recipe-related');
  });

  it('keeps Codex auto mode while exposing normalized resident request mode', async () => {
    const engineSearch = vi.fn(async () => ({ items: [], mode: 'weighted' }));
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
      rank: false,
      kind: 'all',
    });
    expect(engineSearch).toHaveBeenCalled();
    expect(result.structuredContent.result).toMatchObject({
      residentSearch: {
        requestedMode: 'auto',
        residentRequestMode: 'semantic',
        semanticUsed: true,
        vectorUsed: true,
      },
    });
  });

  it('ignores host intent context for resident request shape and result ranking metadata', async () => {
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
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        result: Record<string, unknown>;
        ok: boolean;
      };
    };

    expect(result.structuredContent.ok).toBe(true);
    expect(residentSearch).toHaveBeenCalledWith({
      query: 'fallback query',
      mode: 'auto',
      limit: 3,
      rank: false,
      kind: 'all',
    });
    const residentRequest = JSON.stringify(residentSearch.mock.calls[0]?.[0]);
    expect(residentRequest).not.toContain('hostDeclaredIntent');
    expect(residentRequest).not.toContain('hostTurnMeta');
    expect(residentRequest).not.toContain('sessionHistory');
    expect(residentRequest).not.toContain('sourceRefs');
    expect(residentRequest).not.toContain('thread-plain');
    expect(result.structuredContent.inventory).toMatchObject({
      ignoredInputs: expect.arrayContaining([
        'hostDeclaredIntent',
        'hostTurnMeta',
        'sessionHistory',
        'sourceRefs',
      ]),
    });
    expect(JSON.stringify(result.structuredContent.result)).not.toContain('hostIntentHandoff');
  });

  it('passes explicit metadata filters to resident search without host context leakage', async () => {
    const engineSearch = vi.fn(async () => ({ items: [] }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [],
        meta: {
          attempted: true,
          available: false,
          durationMs: 0,
          reason: 'empty-vector-index',
          requestedMode: 'auto',
          residentVector: { available: false, reason: 'empty-vector-index' },
          resultCount: 0,
          route: 'alembic-resident-service',
          used: false,
        },
      })
    );

    const result = (await search(context({ engineSearch, residentSearch }), {
      category: 'mcp',
      dimensionId: 'asq-r4',
      hostDeclaredIntent: { query: 'hidden query', sourceRefs: ['host:intent'] },
      hostTurnMeta: { threadId: 'thread-plain' },
      knowledgeType: 'semantic-quality',
      language: 'typescript',
      limit: 2,
      mode: 'auto',
      query: 'resident semantic vector truth',
      scope: 'workspace',
      tags: ['search', 'resident'],
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        ok: boolean;
      };
    };

    expect(result.structuredContent.ok).toBe(true);
    expect(residentSearch).toHaveBeenCalledWith({
      category: 'mcp',
      dimensionId: 'asq-r4',
      kind: 'all',
      knowledgeType: 'semantic-quality',
      language: 'typescript',
      limit: 2,
      mode: 'auto',
      query: 'resident semantic vector truth',
      rank: false,
      scope: 'workspace',
      tags: ['search', 'resident'],
    });
    const residentRequest = JSON.stringify(residentSearch.mock.calls[0]?.[0]);
    expect(residentRequest).not.toContain('hidden query');
    expect(residentRequest).not.toContain('thread-plain');
    expect(result.structuredContent.inventory).toMatchObject({
      ignoredInputs: expect.arrayContaining(['hostDeclaredIntent', 'hostTurnMeta']),
      normalizedFilters: {
        category: 'mcp',
        dimensionId: 'asq-r4',
        knowledgeType: 'semantic-quality',
        language: 'typescript',
        scope: 'workspace',
        tags: ['search', 'resident'],
      },
    });
  });

  it('returns semantic-unavailable diagnostics instead of falling back to embedded search', async () => {
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
    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.result).toMatchObject({
      residentVector: { available: false, reason: 'daemon_state_missing' },
      residentSearch: {
        available: false,
        reason: 'daemon_state_missing',
        used: false,
      },
    });
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
  });

  it('withholds local keyword and filter candidates in semantic mode when resident vector is unavailable', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run for semantic fallback');
    });
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [],
        meta: {
          attempted: true,
          available: false,
          durationMs: 0,
          reason: 'empty-vector-index',
          requestedMode: 'semantic',
          residentVector: { available: false, reason: 'empty-vector-index' },
          resultCount: 0,
          route: 'alembic-resident-service',
          used: false,
        },
      })
    );
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService, residentSearch }), {
      category: 'mcp',
      limit: 5,
      mode: 'semantic',
      query: 'MCP endpoint quality relevance contract',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
        summary: string;
      };
    };

    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.summary).toContain('zero direct matches');
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 0,
      returnedCount: 0,
      laneEvidence: {
        semantic: expect.objectContaining({
          available: false,
          returnedCount: 0,
          unavailableReason: 'empty-vector-index',
          used: false,
        }),
      },
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      degradedReason: expect.stringContaining('Plugin keyword/filter fallback was withheld'),
      zeroMatch: true,
    });
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
  });

  it('withholds direct search candidates that miss explicit admission evidence', async () => {
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

    const result = (await search(context({ engineSearch }), {
      keywords: ['legacy', 'shell'],
      limit: 3,
      mode: 'auto',
      query: 'old legacy shell retired surface',
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
    expect(result.structuredContent.summary).toContain('zero direct matches');
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 0,
      returnedCount: 0,
      belowThresholdCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      zeroMatch: true,
      belowThresholdCount: expect.any(Number),
    });
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
  });

  it('admits filter-only matches with AND metadata fields and OR tag filters', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run for filter-only requests');
    });
    const residentSearch = vi.fn(async () => {
      throw new Error('resident search should not run for filter-only requests');
    });
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService, residentSearch }), {
      category: 'mcp',
      limit: 5,
      mode: 'keyword',
      tags: ['ranking', 'vector'],
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{ id: string; matchRoutes: string[]; matchedFilters: string[] }>;
        result: { searchQuality?: Record<string, unknown> };
        summary: string;
      };
    };
    const ids = result.structuredContent.items.map((entry) => entry.id);

    expect(engineSearch).not.toHaveBeenCalled();
    expect(residentSearch).not.toHaveBeenCalled();
    expect(knowledgeService.list).toHaveBeenCalledWith({ category: 'mcp' }, expect.any(Object));
    expect(ids).toEqual(expect.arrayContaining(['mcp-public-tool-quality', 'recipe-beta']));
    expect(ids).not.toContain('recipe-alpha');
    expect(result.structuredContent.items[0]).toMatchObject({
      matchRoutes: expect.arrayContaining(['filter']),
      matchedFilters: expect.arrayContaining(['filter:category', 'filter:tags']),
    });
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 2,
      returnedCount: 2,
      normalizedFilters: {
        category: 'mcp',
        tags: ['ranking', 'vector'],
      },
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      zeroMatch: false,
    });
    expect(result.structuredContent.summary).toContain('metadata filters');
    expect(JSON.stringify(result.structuredContent)).not.toContain('"query":"knowledge"');
    expect(JSON.stringify(result.structuredContent)).not.toContain('request-failed');
  });

  it('does not append broad filter-only fact tails behind a concrete title query', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [],
      mode: 'keyword',
      searchMeta: {
        actualMode: 'keyword',
        requestedMode: 'keyword',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      kind: 'fact',
      limit: 5,
      mode: 'keyword',
      query: 'Resident vector fallback contract',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{ id: string; matchRoutes: string[]; matchedFilters: string[] }>;
        result: { searchQuality?: Record<string, unknown> };
      };
    };
    const ids = result.structuredContent.items.map((entry) => entry.id);

    expect(ids).toEqual(['recipe-beta']);
    expect(ids).not.toContain('project-graph-provider-selection');
    expect(result.structuredContent.items[0]).toMatchObject({
      matchRoutes: expect.arrayContaining(['exact', 'keyword']),
      matchedFilters: expect.arrayContaining(['filter:kind']),
    });
    expect(result.structuredContent.items[0]?.matchRoutes).not.toContain('filter');
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 1,
      normalizedFilters: {
        kind: 'fact',
      },
      returnedCount: 1,
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      zeroMatch: false,
    });
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
  });

  it('unions auto keyword and resident semantic lanes while deduplicating stable ids', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [item('recipe-alpha', 'Structured search result contract', 0.78)],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [
          item('recipe-alpha', 'Structured search result contract', 0.89),
          item('resident-semantic-only', 'Resident semantic-only Recipe', 0.86),
        ],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          durationMs: 6,
          requestedMode: 'auto',
          residentRequestMode: 'semantic',
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
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService, residentSearch }), {
      limit: 5,
      mode: 'auto',
      query: 'Structured search result contract',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{
          id: string;
          matchRoutes: string[];
          scoreBreakdown: Record<string, unknown>;
        }>;
      };
    };
    const ids = result.structuredContent.items.map((entry) => entry.id);
    const recipeAlpha = result.structuredContent.items.find((entry) => entry.id === 'recipe-alpha');

    expect(ids.filter((id) => id === 'recipe-alpha')).toHaveLength(1);
    expect(ids).toEqual(expect.arrayContaining(['recipe-alpha', 'resident-semantic-only']));
    expect(recipeAlpha?.matchRoutes).toEqual(
      expect.arrayContaining(['exact', 'keyword', 'semantic'])
    );
    expect(recipeAlpha?.scoreBreakdown.laneRoutes).toEqual(
      expect.arrayContaining(['keyword', 'semantic'])
    );
    expect(result.structuredContent.inventory).toMatchObject({
      laneEvidence: {
        keyword: expect.objectContaining({ returnedCount: expect.any(Number) }),
        semantic: expect.objectContaining({ returnedCount: expect.any(Number) }),
      },
    });
    expect(result.structuredContent.inventory.returnedCount).toBeGreaterThanOrEqual(2);
  });

  it('keeps semantic mode consistent with auto semantic lane evidence', async () => {
    const serviceContainerItem = item(
      'service-container',
      'ServiceContainer constructor injection DI container',
      0.89
    );
    const engineSearch = vi.fn(async () => ({
      items: [],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [serviceContainerItem],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          durationMs: 6,
          requestedMode: 'semantic',
          residentRequestMode: 'semantic',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 1,
          route: 'alembic-resident-service',
          searchMeta: {
            actualMode: 'semantic',
            requestedMode: 'semantic',
            residentRequestMode: 'semantic',
            route: 'resident-search',
            scoreBreakdown: [
              {
                finalScore: 0.89,
                itemId: 'service-container',
                semanticScore: 0.89,
              },
            ],
            semanticUsed: true,
            vectorUsed: true,
          },
          semanticUsed: true,
          used: true,
          vectorUsed: true,
        },
      })
    );
    const query = 'ServiceContainer constructor injection DI container';

    const autoResult = (await search(context({ engineSearch, residentSearch }), {
      limit: 5,
      mode: 'auto',
      query,
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{ id: string; matchRoutes: string[] }>;
      };
    };
    const semanticResult = (await search(context({ engineSearch, residentSearch }), {
      limit: 5,
      mode: 'semantic',
      query,
    })) as {
      structuredContent: {
        inventory: {
          laneEvidence?: {
            keyword?: Record<string, unknown>;
            semantic?: Record<string, unknown>;
          };
        };
        items: Array<{ id: string; matchRoutes: string[]; routeEvidence: string[] }>;
      };
    };

    expect(autoResult.structuredContent.items.map((entry) => entry.id)).toContain(
      'service-container'
    );
    expect(semanticResult.structuredContent.items).toEqual([
      expect.objectContaining({
        id: 'service-container',
        matchRoutes: expect.arrayContaining(['semantic']),
      }),
    ]);
    expect(semanticResult.structuredContent.items[0]?.matchRoutes).not.toContain('keyword');
    expect(semanticResult.structuredContent.items[0]?.routeEvidence).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^keyword:/u)])
    );
    expect(semanticResult.structuredContent.inventory.laneEvidence).toMatchObject({
      keyword: expect.objectContaining({ attempted: false, returnedCount: 0 }),
      semantic: expect.objectContaining({ attempted: true, returnedCount: 1 }),
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
      matchedCount: expect.any(Number),
      returnedCount: expect.any(Number),
    });
  });

  it('omits resident semantic candidates below the semantic threshold', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run when resident search returns items');
    });
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [
          item('service-container', 'ServiceContainer lazy initialization singleton pattern', 0.42),
          item('layer-contract', 'layer-contract.json hard layer reference contract', 0.31),
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
    expect(result.structuredContent.summary).toContain('zero direct matches');
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 0,
      returnedCount: 0,
      belowThresholdCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      degradedReason: expect.stringContaining('admission'),
      zeroMatch: true,
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
      matchedCount: 0,
      returnedCount: 0,
      belowThresholdCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      degradedReason: expect.stringContaining('Low-information search'),
      zeroMatch: true,
    });
    expect(result.structuredContent.nextActions).toEqual([
      expect.objectContaining({ tool: 'alembic_search', operation: 'search' }),
    ]);
  });

  it('withholds Chinese low-information semantic candidates even when vector scores look strong', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [
          item('permission-denied', 'PermissionDenied unified auth failure pipeline', 0.98),
          item('error-handler', 'Global errorHandler Problem Details middleware', 0.96),
        ],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          durationMs: 7,
          requestedMode: 'auto',
          residentRequestMode: 'semantic',
          residentVector: {
            available: true,
            endpoint: '/api/v1/search',
            reason: null,
            stats: {
              count: 140,
              dimension: 1024,
              embedProviderAvailable: true,
              hasIndex: true,
              indexSize: 140,
            },
          },
          resultCount: 2,
          route: 'alembic-resident-service',
          searchMeta: {
            actualMode: 'semantic',
            requestedMode: 'semantic',
            route: 'resident-search',
            scoreBreakdown: [
              {
                finalScore: 0.98,
                itemId: 'permission-denied',
                rank: 1,
                semanticScore: 0.98,
              },
              {
                finalScore: 0.96,
                itemId: 'error-handler',
                rank: 2,
                semanticScore: 0.96,
              },
            ],
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
      limit: 5,
      mode: 'auto',
      query: '这个怎么处理',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        nextActions: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
        status: string;
        summary: string;
      };
    };

    expect(result.structuredContent.status).toBe('degraded');
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.summary).toContain('zero direct matches');
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 0,
      returnedCount: 0,
      laneEvidence: {
        semantic: expect.objectContaining({
          candidateCount: 2,
          returnedCount: 0,
        }),
      },
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      degradedReason: expect.stringContaining('Low-information search'),
      zeroMatch: true,
    });
    expect(result.structuredContent.nextActions).toEqual([
      expect.objectContaining({ tool: 'alembic_search', operation: 'search' }),
    ]);
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
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
      matchedCount: expect.any(Number),
      returnedCount: expect.any(Number),
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      zeroMatch: false,
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

    expect(result.structuredContent.items[0]).toEqual(
      expect.objectContaining({
        id: 'recipe-alpha',
      })
    );
    expect(result.structuredContent.items[0]?.scoreBreakdown).toMatchObject({
      queryHits: expect.any(Number),
    });
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: expect.any(Number),
      returnedCount: expect.any(Number),
    });
  });

  it('routes graph/search output-quality auto intent to tool-quality knowledge instead of generic AGENTS policy', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [],
      mode: 'weighted',
      searchMeta: {
        actualMode: 'weighted',
        requestedMode: 'auto',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const residentSearch = vi.fn(
      async (): Promise<ResidentSearchResult> => ({
        items: [
          item('agents-phase-policy', 'AGENTS.md LLM Agent phase policy and tool contract', 0.34),
        ],
        meta: {
          attempted: true,
          available: true,
          actualMode: 'semantic',
          durationMs: 8,
          requestedMode: 'semantic',
          residentVector: { available: true, endpoint: '/api/v1/search', reason: null },
          resultCount: 1,
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
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService, residentSearch }), {
      limit: 3,
      mode: 'auto',
      query:
        'why graph/search output quality must return useful semantic content ranking evidence detailRefs diagnostics instead of schema-only summaries',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
      };
    };
    const itemIds = result.structuredContent.items.map((entry) => entry.id);

    expect(itemIds[0]).toBe('mcp-public-tool-quality');
    expect(itemIds).not.toContain('agents-phase-policy');
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: expect.any(Number),
      returnedCount: expect.any(Number),
    });
  });

  it('ignores activeFile and module anchors while ranking by explicit query evidence', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [item('repo-boundary-ratchet', 'Repo Boundary Ratchet', 0.97)],
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
      activeFile:
        'AlembicPlugin/lib/service/project-knowledge-context/project/ProjectGraphProvider.ts',
      limit: 3,
      mode: 'auto',
      module: 'project-knowledge-context',
      query:
        'ProjectGraphProvider ProjectContext request selection graph operation query neighborhood impact ProjectContext public contract',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<{ id: string; scoreBreakdown: Record<string, unknown> }>;
      };
    };

    expect(result.structuredContent.items[0]).toMatchObject({
      id: 'project-graph-provider-selection',
      scoreBreakdown: {
        queryHits: expect.any(Number),
      },
    });
    expect(JSON.stringify(result.structuredContent.items[0]?.scoreBreakdown)).not.toContain(
      'activeFileHits'
    );
    expect(JSON.stringify(result.structuredContent.items[0]?.scoreBreakdown)).not.toContain(
      'moduleHits'
    );
    expect(result.structuredContent.inventory).toMatchObject({
      ignoredInputs: expect.arrayContaining(['activeFile', 'module']),
    });
  });

  it('withholds unrelated implementation rules for Wakeflow direct-thread governance intent', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [
        item('ecmascript-private-fields', 'Use ECMAScript private fields', 0.99),
        item('repo-boundary-ratchet', 'Repo Boundary Ratchet', 0.97),
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
      hostDeclaredIntent: {
        action: 'retrieve-rule',
        query:
          'thread ids only Wakeflow local runtime never tracked documents GitHub backfill rule direct-thread delivery',
      },
      kind: 'rule',
      limit: 4,
      mode: 'auto',
      query:
        'thread ids only Wakeflow local runtime never tracked documents GitHub backfill rule direct-thread delivery',
    })) as {
      structuredContent: {
        items: Array<Record<string, unknown>>;
        result: { searchQuality?: Record<string, unknown> };
      };
    };
    const itemIds = result.structuredContent.items.map((entry) => entry.id);

    expect(itemIds).toEqual(['wakeflow-thread-id-local-runtime']);
    expect(itemIds).not.toEqual(
      expect.arrayContaining(['ecmascript-private-fields', 'repo-boundary-ratchet'])
    );
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      zeroMatch: false,
    });
  });

  it('strips resident relation and prime metadata while downgrading empty vector index usage', async () => {
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
          durationMs: 9,
          requestedMode: 'semantic',
          residentVector: {
            available: true,
            endpoint: '/api/v1/search',
            reason: 'empty-vector-index',
            stats: {
              count: 140,
              dimension: 1024,
              embedProviderAvailable: true,
              hasIndex: true,
              indexSize: 0,
            },
          },
          resultCount: 1,
          route: 'alembic-resident-service',
          searchMeta: {
            actualMode: 'semantic',
            requestedMode: 'semantic',
            residentVector: {
              available: true,
              endpoint: '/api/v1/search',
              reason: 'empty-vector-index',
              stats: {
                count: 140,
                dimension: 1024,
                embedProviderAvailable: true,
                hasIndex: true,
                indexSize: 0,
              },
            },
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
      mode: 'semantic',
      query: 'resident search',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        result: Record<string, unknown>;
        status: string;
      };
    };

    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.structuredContent.status).toBe('degraded');
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 0,
      returnedCount: 0,
      laneEvidence: {
        semantic: expect.objectContaining({
          available: false,
          returnedCount: 0,
          unavailableReason: 'empty-vector-index',
          used: false,
        }),
      },
    });
    expect(result.structuredContent).not.toHaveProperty('relations');
    expect(result.structuredContent.result).toMatchObject({
      residentSearch: {
        available: true,
        semanticUsed: false,
        vectorUsed: false,
      },
      residentVector: {
        available: false,
        reason: 'empty-vector-index',
        stats: {
          indexSize: 0,
        },
      },
      vector: {
        available: false,
        used: false,
      },
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toContain('intentEvidence');
    expect(serialized).not.toContain('primeInjectionPackage');
    expect(serialized).not.toContain('recipe-related');
  });

  it('surfaces structured resident vector availability degradation in public output', async () => {
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
          durationMs: 9,
          requestedMode: 'semantic',
          residentVector: {
            available: false,
            availability: {
              available: false,
              embedProviderConfigured: true,
              probeStatus: 'unavailable',
              reason: 'embed-provider-unavailable',
              status: 'degraded',
            },
            endpoint: '/api/v1/search',
            reason: 'embed-provider-unavailable',
            stats: {
              count: 140,
              dimension: 1024,
              hasIndex: true,
              indexSize: 140,
            },
          },
          resultCount: 1,
          route: 'alembic-resident-service',
          searchMeta: {
            actualMode: 'semantic',
            requestedMode: 'semantic',
            residentVector: {
              available: false,
              availability: {
                available: false,
                embedProviderConfigured: true,
                probeStatus: 'unavailable',
                reason: 'embed-provider-unavailable',
                status: 'degraded',
              },
              endpoint: '/api/v1/search',
              reason: 'embed-provider-unavailable',
              stats: {
                count: 140,
                dimension: 1024,
                hasIndex: true,
                indexSize: 140,
              },
            },
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
      mode: 'semantic',
      query: 'resident search',
    })) as {
      structuredContent: {
        inventory: Record<string, unknown>;
        result: Record<string, unknown>;
        status: string;
      };
    };

    expect(engineSearch).not.toHaveBeenCalled();
    expect(result.structuredContent.status).toBe('degraded');
    expect(result.structuredContent.inventory).toMatchObject({
      laneEvidence: {
        semantic: expect.objectContaining({
          available: false,
          unavailableReason: 'embed-provider-unavailable',
          used: false,
        }),
      },
    });
    expect(result.structuredContent.result).toMatchObject({
      residentSearch: {
        available: true,
        semanticUsed: false,
        vectorUsed: false,
      },
      residentVector: {
        available: false,
        availability: {
          available: false,
          probeStatus: 'unavailable',
          reason: 'embed-provider-unavailable',
          status: 'degraded',
        },
        reason: 'embed-provider-unavailable',
      },
      vector: {
        available: false,
        used: false,
      },
    });
  });

  it('strips top-level search item relation targets from public search output', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [
        {
          ...item('asq-search-handler', 'alembic_search handler projection', 0.97),
          relations: {
            implements: [
              {
                description: 'ASQ output quality governance entry',
                target: 'knowledge:asq-quality-fact',
              },
            ],
          },
        },
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

    const result = (await search(context({ engineSearch }), {
      limit: 3,
      mode: 'auto',
      query: 'alembic_search handler projection',
    })) as {
      structuredContent: {
        items: Array<{ relationRefs?: string[] }>;
      };
    };

    expect(result.structuredContent.items[0]?.relationRefs).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty('relations');
  });

  it('reports budget truncation with stable detail handles and summary-only search items', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [],
      mode: 'keyword',
      searchMeta: {
        actualMode: 'keyword',
        requestedMode: 'keyword',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      category: 'mcp',
      limit: 1,
      mode: 'keyword',
      tags: ['ranking', 'vector'],
    })) as {
      content: Array<{ text: string; type: 'text' }>;
      structuredContent: {
        detailRefs: Array<{ id?: string; operation?: string }>;
        diagnostics: Array<Record<string, unknown>>;
        inventory: Record<string, unknown>;
        items: Array<{ contentPreview?: string; detailRefId?: string; id: string; refId?: string }>;
        nextActions: Array<{ detailRefId?: string; operation?: string; refId?: string }>;
        result: { searchQuality?: Record<string, unknown> };
        summary: string;
      };
    };

    expect(result.content).toEqual([{ type: 'text', text: result.structuredContent.summary }]);
    expect(result.structuredContent.items).toHaveLength(1);
    expect(result.structuredContent.items[0]).toMatchObject({
      detailRefId: expect.stringMatching(/^knowledge:/u),
      refId: expect.stringMatching(/^knowledge:/u),
    });
    expect(result.structuredContent.items[0]?.contentPreview).toBeUndefined();
    const knowledgeDetailRefs = result.structuredContent.detailRefs.filter((ref) =>
      ref.id?.startsWith('knowledge:')
    );
    expect(knowledgeDetailRefs).toEqual([
      expect.objectContaining({
        id: result.structuredContent.nextActions[0]?.detailRefId,
        operation: 'search',
      }),
    ]);
    expect(result.structuredContent.nextActions[0]).toMatchObject({
      operation: 'expand',
      refId: result.structuredContent.items[0]?.refId,
    });
    expect(result.structuredContent.inventory).toMatchObject({
      matchedCount: 2,
      normalizedFilters: {
        category: 'mcp',
        tags: ['ranking', 'vector'],
      },
      omittedCount: 1,
      returnedCount: 1,
    });
    expect(result.structuredContent.result.searchQuality).toMatchObject({
      matchedCount: 2,
      omittedCount: 1,
      returnedCount: 1,
      zeroMatch: false,
    });
    expect(JSON.stringify(result.structuredContent.diagnostics)).not.toContain('vector');
    expect(result.structuredContent.summary).toContain('metadata filters');
  });

  it('omits relation-only budget fields from public alembic_search responses', async () => {
    const engineSearch = vi.fn(async () => ({
      items: [],
      mode: 'keyword',
      searchMeta: {
        actualMode: 'keyword',
        requestedMode: 'keyword',
        route: 'field-weighted',
        semanticUsed: false,
        vectorUsed: false,
      },
    }));
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService }), {
      budget: {
        contentCharLimit: 240,
        detailLimit: 2,
        itemLimit: 2,
        relationHopLimit: 7,
      },
      category: 'mcp',
      mode: 'keyword',
      tags: ['knowledge-context'],
    })) as {
      structuredContent: {
        detailRefs: Array<{ budget?: Record<string, unknown> }>;
      };
    };

    // GMAP-8b: AlembicSearchOutput is the search-owned envelope and no longer echoes
    // the retired middle layer's request.budget / result.budgetUsed / result.retrievalTrace.
    // The security intent stands: the relation-only budget field (relationHopLimit) and
    // any recipeRelation material never reach the public search surface.
    expect(JSON.stringify(result.structuredContent)).not.toContain('relationHopLimit');
    for (const detailRef of result.structuredContent.detailRefs) {
      expect(detailRef.budget ?? {}).not.toHaveProperty('relationHopLimit');
    }
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
  });

  it('resolves get and expand through the real handler with stable detail refs and clean detail diagnostics', async () => {
    const knowledgeService = knowledgeServiceFixture();
    const baseContext = context({ knowledgeService });

    const getResult = (await search(baseContext, {
      operation: 'get',
      refId: 'knowledge:recipe-alpha',
      limit: 5,
      budget: {
        contentCharLimit: 160,
      },
    })) as {
      content: Array<{ text: string; type: 'text' }>;
      structuredContent: {
        detailRefs: Array<Record<string, unknown>>;
        diagnostics: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        ok: boolean;
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
    expect(getResult.structuredContent).not.toHaveProperty('relations');
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
    expect(JSON.stringify(getResult.structuredContent.diagnostics)).not.toContain('vector');
    expect(JSON.stringify(getResult.structuredContent.diagnostics)).not.toContain('recipeRelation');
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(getResult.structuredContent);

    const expandResult = (await search(baseContext, {
      operation: 'expand',
      detailRefId: 'knowledge:recipe-alpha',
      limit: 5,
      budget: {
        contentCharLimit: 120,
      },
    })) as {
      content: Array<{ text: string; type: 'text' }>;
      structuredContent: {
        detailRefs: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        ok: boolean;
        result: {
          expanded?: {
            contentPreview?: string;
            detailRefs?: string[];
            refId?: string;
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
      refId: 'knowledge:recipe-alpha',
    });
    expect(expandResult.structuredContent.result.expanded?.contentPreview).toMatch(/\.\.\.$/);
    expect(expandResult.structuredContent.result.vector).toMatchObject({
      available: false,
      used: false,
    });
    expect(expandResult.structuredContent).not.toHaveProperty('relations');
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(expandResult.structuredContent);
  });

  it('reports exact detail failures without broad search or relation traversal fallback', async () => {
    const engineSearch = vi.fn(async () => {
      throw new Error('embedded search should not run for exact detail misses');
    });
    const residentSearch = vi.fn(async () => {
      throw new Error('resident search should not run for exact detail misses');
    });
    const knowledgeService = knowledgeServiceFixture();

    const result = (await search(context({ engineSearch, knowledgeService, residentSearch }), {
      operation: 'get',
      refId: 'knowledge:missing-recipe',
    })) as {
      structuredContent: {
        detailRefs: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        nextActions: Array<Record<string, unknown>>;
        result: Record<string, unknown>;
        status: string;
        summary: string;
      };
    };

    expect(engineSearch).not.toHaveBeenCalled();
    expect(residentSearch).not.toHaveBeenCalled();
    expect(result.structuredContent.status).toBe('degraded');
    expect(result.structuredContent.summary).toContain(
      'Knowledge get could not resolve knowledge:missing-recipe'
    );
    expect(
      result.structuredContent.detailRefs.filter(
        (ref) => typeof ref.id === 'string' && ref.id.startsWith('knowledge:')
      )
    ).toEqual([]);
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.nextActions).toEqual([]);
    expect(result.structuredContent).not.toHaveProperty('relations');
    expectPublicSearchJsonToOmitRelationAndPrimeMaterial(result.structuredContent);
    expect(result.structuredContent.result).toMatchObject({
      found: false,
      refId: 'knowledge:missing-recipe',
      residentSearch: {
        attempted: false,
        used: false,
      },
      residentVector: {
        available: false,
        reason: 'detail-operation-uses-knowledge-service',
      },
    });
  });

  it('canonicalizes generated operation detail refs for bounded get and expand', async () => {
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
    const baseContext = context({ engineSearch, knowledgeService });

    const searchResult = (await search(baseContext, {
      keywords: ['bounded', 'Recipe', 'detailRefs', 'expand', 'summary-only', 'get'],
      limit: 3,
      mode: 'auto',
      query:
        'how should I fetch bounded Recipe details with get expand detailRefs summary only content contract',
    })) as {
      structuredContent: {
        detailRefs: Array<{ id?: string; operation?: string }>;
        items: Array<{ id: string }>;
        nextActions: Array<{ detailRefId?: string; refId?: string }>;
        sources: Array<{ detailRefId?: string }>;
      };
    };

    expect(searchResult.structuredContent.items[0]?.id).toBe('recipe-alpha');
    const searchDetailRefId = searchResult.structuredContent.detailRefs.find(
      (ref) => ref.operation === 'search' && ref.id?.includes('recipe-alpha')
    )?.id;
    expect(searchDetailRefId).toBe('knowledge:search:knowledge:recipe-alpha');
    expect(searchResult.structuredContent.sources[0]?.detailRefId).toBe(searchDetailRefId);
    expect(searchResult.structuredContent.nextActions[0]).toMatchObject({
      detailRefId: searchDetailRefId,
      refId: 'knowledge:recipe-alpha',
    });

    const getFromSearchDetailRef = (await search(baseContext, {
      operation: 'get',
      refId: searchDetailRefId,
      budget: {
        contentCharLimit: 160,
        relationHopLimit: 2,
      },
    })) as {
      structuredContent: {
        detailRefs: Array<{ id?: string; operation?: string }>;
        items: Array<{ id: string }>;
        ok: boolean;
        result: { found?: boolean; refId?: string };
      };
    };

    expect(getFromSearchDetailRef.structuredContent.ok).toBe(true);
    expect(getFromSearchDetailRef.structuredContent.result).toMatchObject({
      found: true,
      refId: 'knowledge:recipe-alpha',
    });
    expect(getFromSearchDetailRef.structuredContent.items[0]?.id).toBe('recipe-alpha');
    const getDetailRefId = getFromSearchDetailRef.structuredContent.detailRefs.find(
      (ref) => ref.operation === 'get'
    )?.id;
    expect(getDetailRefId).toBe('knowledge:get:knowledge:recipe-alpha');

    const expandFromGetDetailRef = (await search(baseContext, {
      operation: 'expand',
      detailRefId: getDetailRefId,
      budget: {
        contentCharLimit: 120,
        relationHopLimit: 1,
      },
    })) as {
      structuredContent: {
        detailRefs: Array<{ id?: string; operation?: string }>;
        items: Array<{ id: string }>;
        ok: boolean;
        result: {
          expanded?: { detailRefs?: string[]; refId?: string };
          found?: boolean;
          refId?: string;
        };
      };
    };

    expect(expandFromGetDetailRef.structuredContent.ok).toBe(true);
    expect(expandFromGetDetailRef.structuredContent.result).toMatchObject({
      found: true,
      refId: 'knowledge:recipe-alpha',
      expanded: { detailRefs: ['knowledge:recipe-alpha'], refId: 'knowledge:recipe-alpha' },
    });
    expect(expandFromGetDetailRef.structuredContent.items[0]?.id).toBe('recipe-alpha');
    const expandDetailRefId = expandFromGetDetailRef.structuredContent.detailRefs.find(
      (ref) => ref.operation === 'expand'
    )?.id;
    expect(expandDetailRefId).toBe('knowledge:expand:knowledge:recipe-alpha');

    const getFromExpandDetailRef = (await search(baseContext, {
      operation: 'get',
      detailRefId: expandDetailRefId,
      budget: {
        contentCharLimit: 160,
        relationHopLimit: 1,
      },
    })) as {
      structuredContent: {
        items: Array<{ id: string }>;
        ok: boolean;
        result: { found?: boolean; refId?: string };
      };
    };

    expect(getFromExpandDetailRef.structuredContent.ok).toBe(true);
    expect(getFromExpandDetailRef.structuredContent.result).toMatchObject({
      found: true,
      refId: 'knowledge:recipe-alpha',
    });
    expect(getFromExpandDetailRef.structuredContent.items[0]?.id).toBe('recipe-alpha');
  });
});
