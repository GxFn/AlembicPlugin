import { describe, expect, it, vi } from 'vitest';
import type {
  AlembicResidentProjectScopeIdentity,
  ResidentSearchAttemptMeta,
  ResidentSearchResult,
} from '../../lib/service/resident/AlembicResidentServiceClient.js';
import type { HostIntentFrame } from '../../lib/service/task/HostIntentFrame.js';
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
    decisionRegister: {
      acceptedDecisionRefs: ['decision-active-1'],
      auditExcludedCount: 2,
      available: true,
      defaultLifecycle: 'active-effective-only',
      excludedStatuses: ['revoked', 'deleted'],
      route: '/api/v1/decision-register/searchable',
    },
    degraded: false,
    degradedReasons: ['vector:evidence-observe-only'],
    feedback: {
      observeOnly: true,
      supportedSignals: ['searchHit', 'view', 'adoption'],
      version: 1,
    },
    relationEvidence: [
      {
        direction: 'outgoing',
        itemId: 'resident-1',
        relatedId: 'recipe-related',
        relation: 'related',
        source: 'knowledgeGraphService',
      },
    ],
    retrievalQuality: {
      decisionRefCount: 1,
      feedbackSignalCount: 3,
      relationEvidenceCount: 1,
      sourceRefCoverage: 1,
      version: 1,
    },
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

function primeInjectionPackageSummary() {
  return {
    decisionRegister: {
      acceptedDecisionRefs: ['decision-active-1'],
      auditExcludedCount: 2,
      available: true,
      defaultLifecycle: 'active-effective-only',
      excludedStatuses: ['revoked', 'deleted'],
      route: '/api/v1/decision-register/searchable',
      source: 'alembic-decision-register',
      vectorAdmission: 'accepted-only',
    },
    feedback: {
      observeOnly: true,
      recorder: 'HitRecorder',
      supportedSignals: ['searchHit', 'view', 'adoption'],
      version: 1,
    },
    injection: {
      degradedReasons: [],
      omittedCount: 0,
      selectedCount: 1,
      status: 'ready',
    },
    intent: {
      applied: true,
      confidence: 0.86,
      degraded: false,
      degradedReasons: [],
      executableQuery: 'VideoURLPreloader async bridge',
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
    retrievalQuality: {
      decisionRefCount: 1,
      feedbackSignalCount: 3,
      relationEvidenceCount: 1,
      selectedWithSourceRefs: 1,
      sourceRefCoverage: 1,
      version: 1,
    },
    search: {
      actualMode: 'semantic',
      filteredCount: 1,
      query: 'VideoURLPreloader async bridge',
      queries: ['VideoURLPreloader async bridge'],
      requestedMode: 'semantic',
      resultCount: 1,
    },
    selectedKnowledge: [
      {
        evidenceRefs: ['scoreBreakdown:resident-1'],
        injectionStatus: 'selected',
        itemId: 'resident-1',
        kind: 'pattern',
        rank: 1,
        score: 0.95,
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
          finalScore: 0.95,
          itemId: 'resident-1',
          rank: 1,
          semanticScore: 0.85,
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

function retrievalConsumerSummary() {
  return {
    decisionRegister: {
      acceptedDecisionRefs: ['decision-active-1'],
      auditExcludedCount: 2,
      available: true,
      defaultLifecycle: 'active-effective-only' as const,
      excludedStatuses: ['revoked', 'deleted'],
      route: '/api/v1/decision-register/searchable',
    },
    feedback: {
      observeOnly: true,
      supportedSignals: ['searchHit', 'view', 'adoption'],
      version: 1,
    },
    producerContract: {
      available: true,
      missingFields: [],
      reasonCode: 'resident-search-stage1a-contract-present' as const,
      requiredFields: ['decisionRegister', 'feedback', 'retrievalQuality'],
      stage: 'AFAPI-FULL-STAGE1A' as const,
    },
    relationEvidence: {
      count: 1,
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
    retrievalQuality: {
      decisionRefCount: 1,
      feedbackSignalCount: 3,
      relationEvidenceCount: 1,
      sourceRefCoverage: 1,
      version: 1,
    },
    source: 'resident-search-meta' as const,
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
            primeInjectionPackage: primeInjectionPackageSummary(),
            retrievalConsumer: retrievalConsumerSummary(),
            searchMeta: {
              intentEvidence: intentEvidenceSummary(),
              primeInjectionPackage: primeInjectionPackageSummary(),
              retrievalConsumer: retrievalConsumerSummary(),
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
      decisionRegister: {
        acceptedDecisionRefs: ['decision-active-1'],
        auditExcludedCount: 2,
        defaultLifecycle: 'active-effective-only',
        excludedStatuses: ['revoked', 'deleted'],
      },
      feedback: {
        observeOnly: true,
      },
      retrievalQuality: {
        decisionRefCount: 1,
        feedbackSignalCount: 3,
        relationEvidenceCount: 1,
      },
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
    expect(result?.searchMeta.primeInjectionPackage).toMatchObject({
      decisionRegister: {
        acceptedDecisionRefs: ['decision-active-1'],
        auditExcludedCount: 2,
        vectorAdmission: 'accepted-only',
      },
      feedback: {
        observeOnly: true,
        recorder: 'HitRecorder',
      },
      injection: {
        selectedCount: 1,
        status: 'ready',
      },
      retrievalQuality: {
        decisionRefCount: 1,
        selectedWithSourceRefs: 1,
        sourceRefCoverage: 1,
      },
      selectedKnowledge: [
        expect.objectContaining({
          injectionStatus: 'selected',
          itemId: 'resident-1',
        }),
      ],
      trace: {
        evidenceRefs: ['scoreBreakdown:resident-1'],
      },
    });
    expect(result?.searchMeta.retrievalConsumer).toMatchObject({
      decisionRegister: {
        acceptedDecisionRefs: ['decision-active-1'],
        auditExcludedCount: 2,
      },
      feedback: {
        observeOnly: true,
      },
      producerContract: {
        available: true,
        missingFields: [],
        reasonCode: 'resident-search-stage1a-contract-present',
      },
      relationEvidence: {
        count: 1,
      },
      retrievalQuality: {
        decisionRefCount: 1,
        feedbackSignalCount: 3,
      },
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
      projectRoot: '/workspace/AlembicWorkspace',
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
        projectRoot: '/workspace/AlembicWorkspace',
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

  it('uses the resident prime route for standalone public prime searches', async () => {
    const engine = {
      search: vi.fn(async (_query: string, options?: { mode?: string }) => {
        if (options?.mode === 'auto') {
          return { items: [item('embedded-1', 'Embedded baseline', 0.72)] };
        }
        return { items: [] };
      }),
    };
    const residentServiceClient = {
      prime: vi.fn(
        async (): Promise<ResidentSearchResult> => ({
          items: [item('resident-prime-route', 'Resident task prime route', 0.96)],
          meta: residentMeta({
            actualMode: 'prime',
            primeInjectionPackage: {
              ...primeInjectionPackageSummary(),
              residentRegionRetrieval: {
                attempted: true,
                degradedReasons: [],
                queryCount: 3,
                regionHitCount: 9,
                route: 'resident-vector-recipe-semantic-region',
                selectedRecipes: [
                  {
                    itemId: 'resident-prime-route',
                    matchedRegionClasses: ['applicability', 'architectureConvention'],
                    matchedRegions: [
                      {
                        recipeId: 'resident-prime-route',
                        regionClass: 'applicability',
                        score: 0.96,
                        snippet: 'Use resident task prime route for public prime material.',
                        sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
                      },
                    ],
                    score: 0.96,
                    sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
                    title: 'Resident task prime route',
                  },
                ],
                used: true,
                vectorAvailable: true,
              },
            },
            requestedMode: 'prime',
            residentRequestMode: 'prime',
            residentVector: { available: true, endpoint: '/api/v1/task', reason: null },
            searchMeta: {
              actualMode: 'prime',
              primeInjectionPackage: {
                ...primeInjectionPackageSummary(),
                residentRegionRetrieval: {
                  attempted: true,
                  route: 'resident-vector-recipe-semantic-region',
                  used: true,
                  vectorAvailable: true,
                },
              },
              requestedMode: 'prime',
              residentVector: { available: true, endpoint: '/api/v1/task', reason: null },
              retrievalConsumer: retrievalConsumerSummary(),
              semanticUsed: true,
              vectorUsed: true,
            },
            semanticUsed: true,
            vectorUsed: true,
          }),
        })
      ),
      search: vi.fn(
        async (): Promise<ResidentSearchResult> => ({
          items: [],
          meta: residentMeta({ available: false, resultCount: 0, used: false }),
        })
      ),
    };
    const hostIntentFrame: HostIntentFrame = {
      confidence: 0.88,
      degraded: false,
      degradedReasons: [],
      extracted: {
        language: 'typescript',
        module: 'HTTP API',
        queries: ['Implement HTTP route with Zod validation'],
        scenario: 'implementation',
      },
      hostDeclaredIntent: {
        action: 'implement',
        goal: 'Implement HTTP route with Zod request validation',
        keywords: ['HTTP route', 'Zod', 'request schema'],
        language: 'typescript',
        query: 'Implement HTTP route with Zod validation',
        scenario: 'implementation',
        sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
      },
      hostTurnMeta: {
        activeFile: 'lib/runtime/mcp/handlers/agent-public-tools.ts',
        redactions: ['threadId'],
        threadIdHash: 'thread-hash',
      },
      recognizedIntentDraft: {
        action: 'implement',
        confidence: 0.88,
        constraints: ['Zod request validation'],
        degraded: false,
        degradedReasons: [],
        evidenceSpans: [
          {
            end: 36,
            field: 'query',
            source: 'hostDeclaredIntent',
            start: 0,
            text: 'Implement HTTP route with Zod validation',
          },
        ],
        language: 'typescript',
        query: 'Implement HTTP route with Zod validation',
        source: 'host-declared',
        sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
        status: 'recognized',
        target: 'HTTP route',
      },
      source: 'host-declared',
    };

    const pipeline = new PrimeSearchPipeline(engine, { residentServiceClient });
    const result = await pipeline.search(intent(), {
      hostIntentFrame,
      projectRoot: '/workspace/AlembicPlugin',
      sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
      standalonePrime: true,
      standalonePrimeRequirement: {
        capability: 'HTTP API request validation',
        requirementGoal: 'Implement HTTP route with Zod request validation',
        taskAction: 'implement',
      },
    });

    expect(residentServiceClient.prime).toHaveBeenCalledWith(
      expect.objectContaining({
        activeFile: 'lib/runtime/mcp/handlers/agent-public-tools.ts',
        hostDeclaredIntent: expect.objectContaining({
          query: 'Implement HTTP route with Zod validation',
        }),
        intentContext: expect.objectContaining({
          capability: 'HTTP API request validation',
          query: 'Implement HTTP route with Zod validation',
          recognizedIntentDraft: expect.objectContaining({
            action: 'implement',
          }),
          requirementGoal: 'Implement HTTP route with Zod request validation',
          sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
          standalonePrime: true,
          taskAction: 'implement',
        }),
        language: 'typescript',
        mode: 'semantic',
        projectRoot: '/workspace/AlembicPlugin',
        sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
      })
    );
    expect(residentServiceClient.search).not.toHaveBeenCalled();
    expect(result?.relatedKnowledge.map((entry) => entry.id)).toContain('resident-prime-route');
    expect(result?.searchMeta.residentSearch).toMatchObject({
      actualMode: 'prime',
      residentRequestMode: 'prime',
      requestedMode: 'prime',
      residentVector: { available: true, endpoint: '/api/v1/task' },
      searchMeta: {
        primeInjectionPackage: {
          residentRegionRetrieval: {
            route: 'resident-vector-recipe-semantic-region',
            used: true,
          },
        },
        retrievalConsumer: {
          producerContract: {
            available: true,
            missingFields: [],
          },
        },
      },
      semanticUsed: true,
      vectorUsed: true,
    });
    expect(result?.searchMeta.primeInjectionPackage).toMatchObject({
      residentRegionRetrieval: {
        route: 'resident-vector-recipe-semantic-region',
        used: true,
        vectorAvailable: true,
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
