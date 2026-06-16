import { describe, expect, test, vi } from 'vitest';
import { taskHandler } from '../../lib/runtime/mcp/handlers/task.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { createIdleIntent } from '../../lib/runtime/mcp/handlers/types.js';
import type { ExtractedIntent } from '../../lib/service/task/IntentExtractor.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';

type TrustLayer =
  | 'trusted-to-obey'
  | 'trusted-to-use'
  | 'context-only'
  | 'requires-verification'
  | 'not-available-or-degraded';

interface PrimeMaterial {
  status: 'delivered' | 'empty' | 'degraded';
  receiptId: string;
  intent: {
    userQuery: string;
    activeFile?: string;
    language?: string;
    module?: string;
    scenario: string;
    queries: string[];
    hostIntentFrame?: {
      source: 'deterministic' | 'host-declared' | 'mixed';
      confidence: number;
      degraded: boolean;
      degradedReasons: string[];
      hostDeclaredIntent?: Record<string, unknown>;
      hostTurnMeta?: Record<string, unknown>;
    };
  };
  acceptedKnowledge: Array<{
    id: string;
    kind: string;
    title: string;
    trigger: string;
    summary: string;
    score: number;
    evidenceRefs: Array<{ path: string; line: number | null }>;
    matchedRegionClasses: string[];
    trustEvidence: Record<string, unknown>;
    usefulSlices: Array<Record<string, unknown>>;
  }>;
  acceptedGuards: Array<{
    id: string;
    title: string;
    trigger: string;
    score: number;
    evidenceRefs: Array<{ path: string; line: number | null }>;
  }>;
  trustPosture: {
    status: 'delivered' | 'empty' | 'degraded';
    receiptChecklist: Array<{
      layer: TrustLayer;
      label: string;
      summary: string;
      items: Array<{
        id: string;
        title: string;
        source: string;
        reason: string;
        status?: string;
        evidenceRefs?: Array<{ path: string; line: number | null }>;
      }>;
      requiredInVisibleReceipt: boolean;
      visibleReceiptDirective: string;
    }>;
    antiEmptyReceipt: {
      required: boolean;
      forbiddenGenericReceipts: string[];
      instruction: string;
    };
  };
  shoutInstruction: string;
  hostResponse: {
    action: string;
    receiptId: string;
    status: 'delivered' | 'empty' | 'degraded';
    timing: 'immediate_after_prime';
    required: boolean;
    requiredBeforeNextAction: boolean;
    visibility: 'developer_visible';
    reason: string;
  };
  nextActions: Array<{ tool: string; args: Record<string, unknown>; required: boolean }>;
  intentEvidence?: Record<string, unknown>;
  primeInjectionPackage?: Record<string, unknown>;
  retrievalConsumer?: Record<string, unknown>;
  intentEpisode?: {
    available: boolean;
    current: {
      episodeId: string;
      query?: string;
      sessionKey: string | null;
      sourceRefs: string[];
      status: string;
    } | null;
    degraded: boolean;
    latest: {
      episodeId: string;
      query?: string;
      sessionKey: string | null;
      sourceRefs: string[];
      status: string;
    } | null;
    recent: Array<{
      episodeId: string;
      query?: string;
      sessionKey: string | null;
      sourceRefs: string[];
      status: string;
    }>;
    requestFields: string[];
    sessionSource: string;
  };
}

interface PrimeEnvelope {
  success: boolean;
  message: string;
  data: {
    knowledge: {
      relatedKnowledge: PrimeSearchResult['relatedKnowledge'];
      guardRules: PrimeSearchResult['guardRules'];
    } | null;
    lifecyclePolicy?: {
      inputSource: string;
      intentKind: string;
      primeDecision: { action: string; curatedQuery?: string; reasonCode: string };
      taskAnchorDecision: { action: string; reasonCode: string };
    };
    primeKnowledgeMaterial: PrimeMaterial;
    searchMeta: PrimeSearchResult['searchMeta'] | null;
  };
}

function makeContext(
  search: (
    intent: ExtractedIntent,
    options?: { hostIntentFrame?: unknown }
  ) => Promise<PrimeSearchResult | null>,
  services: Record<string, unknown> = {}
): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return { search };
        }
        if (Object.hasOwn(services, name)) {
          return services[name];
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
    session: {
      id: 'session-1',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

function makeContextWithoutPipeline(): McpContext {
  return {
    container: {
      get: vi.fn(() => null),
    },
    session: {
      id: 'session-1',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

function trustLayer(material: PrimeMaterial, layer: TrustLayer) {
  const entry = material.trustPosture.receiptChecklist.find((item) => item.layer === layer);
  if (!entry) {
    throw new Error(`Missing trust layer ${layer}`);
  }
  return entry;
}

function intentEvidenceSummary() {
  return {
    decisionRegister: {
      acceptedDecisionRefs: ['decision-active-1'],
      auditExcludedCount: 1,
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
        itemId: 'recipe-episode',
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
        finalScore: 0.91,
        itemId: 'recipe-episode',
        rank: 1,
        semanticScore: 0.81,
        signals: ['final-score', 'semantic-score'],
        vectorScore: null,
      },
    ],
    semanticAnchors: [
      {
        kind: 'query',
        source: 'intentSearchPlan.executableQuery',
        value: 'Create episode handoff',
        weight: 1,
      },
    ],
    topAnchorMatches: [
      {
        anchor: 'episode handoff',
        itemId: 'recipe-episode',
        matchType: 'text',
        rank: 1,
        score: 0.91,
        sourceRefs: ['knowledge:recipe-episode'],
      },
    ],
    version: 1,
  };
}

function primeInjectionPackageSummary() {
  return {
    decisionRegister: primePackageDecisionRegister(),
    feedback: primePackageFeedback(),
    injection: primePackageInjection(),
    intent: primePackageIntent(),
    omitted: [],
    relations: primePackageRelations(),
    retrievalQuality: primePackageRetrievalQuality(),
    search: primePackageSearch(),
    selectedKnowledge: [primePackageSelectedKnowledge()],
    trace: primePackageTrace(),
    vector: primePackageVector(),
    version: 1,
  };
}

function primePackageDecisionRegister() {
  return {
    acceptedDecisionRefs: ['decision-active-1'],
    auditExcludedCount: 1,
    available: true,
    defaultLifecycle: 'active-effective-only',
    excludedStatuses: ['revoked', 'deleted'],
    route: '/api/v1/decision-register/searchable',
    source: 'alembic-decision-register',
    vectorAdmission: 'accepted-only',
  };
}

function primePackageFeedback() {
  return {
    observeOnly: true,
    recorder: 'HitRecorder',
    supportedSignals: ['searchHit', 'view', 'adoption'],
    version: 1,
  };
}

function primePackageInjection() {
  return {
    degradedReasons: [],
    omittedCount: 0,
    selectedCount: 1,
    status: 'ready',
  };
}

function primePackageIntent() {
  return {
    applied: true,
    confidence: 0.86,
    degraded: false,
    degradedReasons: [],
    executableQuery: 'Create episode handoff',
    requestedMode: 'semantic',
    sourceRefs: ['host:intent'],
    whySelected: ['intent-search-plan'],
  };
}

function primePackageRelations() {
  return {
    evidence: [
      {
        direction: 'outgoing',
        itemId: 'recipe-episode',
        relatedId: 'recipe-related',
        relation: 'related',
        source: 'knowledgeGraphService',
      },
    ],
    omitted: [],
  };
}

function primePackageRetrievalQuality() {
  return {
    decisionRefCount: 1,
    feedbackSignalCount: 3,
    relationEvidenceCount: 1,
    selectedWithSourceRefs: 1,
    sourceRefCoverage: 1,
    version: 1,
  };
}

function primePackageSearch() {
  return {
    actualMode: 'semantic',
    filteredCount: 1,
    query: 'Create episode handoff',
    queries: ['episode handoff'],
    requestedMode: 'semantic',
    resultCount: 1,
  };
}

function primePackageSelectedKnowledge() {
  return {
    evidenceRefs: ['scoreBreakdown:recipe-episode'],
    injectionStatus: 'selected',
    itemId: 'recipe-episode',
    kind: 'pattern',
    matchedRegionClasses: ['applicability', 'integrationBoundary'],
    matchedRegions: primePackageMatchedRegions(),
    rank: 1,
    score: 0.91,
    sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
    title: 'Episode handoff',
    trigger: '@episode-handoff',
    whySelected: ['semantic-score'],
  };
}

function primePackageMatchedRegions() {
  return [
    {
      regionClass: 'applicability',
      score: 0.93,
      snippet: 'Use this Recipe when a prime tool must project compact trusted material.',
      sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
      sourceRefsBridge: 'active',
      vectorId: 'recipe_region_recipe-episode_applicability_hash',
    },
    {
      regionClass: 'integrationBoundary',
      score: 0.88,
      snippet:
        'Keep producer-only prime injection metadata resident-owned and expose only compact evidence.',
      sourceRefs: ['lib/runtime/mcp/handlers/task.ts:43'],
      sourceRefsBridge: 'active',
      vectorId: 'recipe_region_recipe-episode_integrationBoundary_hash',
    },
  ];
}

function primePackageTrace() {
  return {
    evidenceRefs: ['scoreBreakdown:recipe-episode'],
    sourcePath: ['searchMeta.primeInjectionPackage'],
    sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
    sources: ['intentSearchPlan', 'intentEvidence'],
  };
}

function primePackageVector() {
  return {
    omitted: [],
    scoreBreakdown: [
      {
        finalScore: 0.91,
        itemId: 'recipe-episode',
        rank: 1,
        semanticScore: 0.81,
        signals: ['semantic-score'],
        vectorScore: null,
      },
    ],
    semanticAnchors: [],
    semanticUsed: true,
    topAnchorMatches: [],
    vectorAvailable: true,
    vectorUsed: true,
  };
}

describe('alembic_task prime knowledge material', () => {
  test('blocks legacy record_decision direct calls without writing Plugin-local decisions', async () => {
    const ctx = makeContext(async () => null);
    if (!ctx.session) {
      throw new Error('expected test session');
    }
    ctx.session.intent.phase = 'active';

    const result = (await taskHandler(ctx, {
      description: 'Old hidden direct-call path must not create a local fake decision.',
      operation: 'record_decision',
      rationale: 'Durable Decision Register is the only confirmed-decision writer.',
      tags: ['afapi-08'],
      title: 'Do not write local decisions',
    })) as {
      data: {
        durablePersistence: { reason: string; requiredRoute: string };
        legacyCompatibility: {
          operation: string;
          replacementTool: string;
          status: string;
          writesLocalDecision: boolean;
        };
      };
      errorCode: string | null;
      message: string;
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('legacy-record-decision-disabled');
    expect(result.message).toContain('no Plugin-local fake decision was written');
    expect(result.data.legacyCompatibility).toMatchObject({
      operation: 'record_decision',
      replacementTool: 'alembic_decision_record',
      status: 'blocked',
      writesLocalDecision: false,
    });
    expect(result.data.durablePersistence).toMatchObject({
      reason: 'legacy-record-decision-disabled',
      requiredRoute: 'Alembic durable Decision Register route',
    });
    expect(ctx.session.intent.decisions).toEqual([]);
  });

  test('returns delivered primeKnowledgeMaterial with recipe, guard, and evidence refs', async () => {
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-1',
          title: 'Use codex plugin boundaries',
          trigger: '@codex-plugin-boundary',
          kind: 'pattern',
          language: 'typescript',
          score: 0.91,
          description: 'Keep Codex MCP wiring in the plugin layer.',
          actionHint: 'Use plugin adapter APIs instead of reintroducing agent runtime.',
          knowledgeType: 'code-standard',
          sourceRefs: [
            'lib/runtime/mcp/handlers/task.ts:42',
            'lib/runtime/status/StatusService.ts',
          ],
        },
      ],
      guardRules: [
        {
          id: 'guard-1',
          title: 'Do not restore agent runtime',
          trigger: '@no-agent-runtime',
          kind: 'rule',
          language: 'typescript',
          score: 0.84,
          description: 'Plugin must not own agent runtime.',
          actionHint: 'Keep agent runtime out of AlembicPlugin.',
          sourceRefs: ['AGENTS.md:22'],
        },
      ],
      searchMeta: {
        queries: ['prime knowledge shout'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 2,
        filteredCount: 2,
        primeInjectionPackage: {
          ...primeInjectionPackageSummary(),
          selectedKnowledge: [
            {
              evidenceRefs: ['scoreBreakdown:recipe-1'],
              injectionStatus: 'selected',
              itemId: 'recipe-1',
              kind: 'pattern',
              matchedRegionClasses: ['applicability', 'integrationBoundary'],
              matchedRegions: [
                {
                  regionClass: 'applicability',
                  score: 0.93,
                  snippet: 'Use this Recipe when Codex MCP wiring must stay in the plugin layer.',
                  sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
                  sourceRefsBridge: 'active',
                  vectorId: 'recipe_region_recipe-1_applicability_hash',
                },
              ],
              rank: 1,
              score: 0.91,
              sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
              title: 'Use codex plugin boundaries',
              trigger: '@codex-plugin-boundary',
              whySelected: ['resident-region'],
            },
          ],
        },
        residentSearch: {
          attempted: true,
          available: true,
          route: 'alembic-resident-service',
          semanticUsed: true,
          vectorUsed: true,
          residentVector: { available: true },
        },
      },
    };
    const ctx = makeContext(async () => searchResult);
    const result = (await taskHandler(ctx, {
      operation: 'prime',
      userQuery: 'Add prime knowledge shout',
      activeFile: 'lib/runtime/mcp/handlers/task.ts',
      language: 'typescript',
    })) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge?.relatedKnowledge).toEqual(searchResult.relatedKnowledge);
    expect(result.data.searchMeta).toMatchObject(searchResult.searchMeta);
    expect(result.data.searchMeta).toMatchObject({ projectRuntime: expect.any(Object) });
    expect(ctx.session?.intent.searchMeta?.residentSearch).toMatchObject({
      route: 'alembic-resident-service',
      vectorUsed: true,
    });
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      intent: {
        userQuery: 'Add prime knowledge shout',
        hostIntentFrame: {
          source: 'deterministic',
          confidence: 1,
          degraded: false,
          degradedReasons: [],
        },
      },
      acceptedKnowledge: [
        {
          id: 'recipe-1',
          kind: 'pattern',
          title: 'Use codex plugin boundaries',
          trigger: '@codex-plugin-boundary',
          summary: 'Keep Codex MCP wiring in the plugin layer.',
          score: 0.91,
          evidenceRefs: [
            { path: 'lib/runtime/mcp/handlers/task.ts', line: 42 },
            { path: 'lib/runtime/status/StatusService.ts', line: null },
          ],
        },
      ],
      acceptedGuards: [
        {
          id: 'guard-1',
          title: 'Do not restore agent runtime',
          trigger: '@no-agent-runtime',
          score: 0.84,
          evidenceRefs: [{ path: 'AGENTS.md', line: 22 }],
        },
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-obey')).toMatchObject({
      requiredInVisibleReceipt: true,
      items: [
        expect.objectContaining({
          id: 'guard:guard-1',
          source: 'accepted-guard',
          title: '@no-agent-runtime',
        }),
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use')).toMatchObject({
      requiredInVisibleReceipt: true,
      items: [
        expect.objectContaining({
          id: 'knowledge:recipe-1',
          source: 'accepted-knowledge',
          title: '@codex-plugin-boundary',
        }),
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'context-only')).toMatchObject({
      requiredInVisibleReceipt: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'prime-query-context',
          source: 'search-context',
        }),
        expect.objectContaining({
          id: 'host-intent-frame',
          source: 'host-intent',
        }),
      ]),
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'requires-verification')).toMatchObject({
      requiredInVisibleReceipt: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'accepted-material-evidence',
          source: 'evidence-ref',
          evidenceRefs: expect.arrayContaining([
            { path: 'lib/runtime/mcp/handlers/task.ts', line: 42 },
            { path: 'AGENTS.md', line: 22 },
          ]),
        }),
      ]),
    });
    expect(
      trustLayer(result.data.primeKnowledgeMaterial, 'not-available-or-degraded').items
    ).toHaveLength(0);
    expect(result.data.primeKnowledgeMaterial.trustPosture.antiEmptyReceipt).toMatchObject({
      required: true,
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Immediately after this prime tool result'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'short, active knowledge receipt'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Use Codex/first-person as the speaker'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'what I accepted or what Codex received'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'trusted-to-obey Guard constraints'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'trusted-to-use Recipe or pattern knowledge'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'context-only host intent or evidence hints'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'requires-verification source refs or candidates'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'not-available-or-degraded=0'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not collapse the receipt into an empty'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'do not list evidenceRefs paths or line numbers by default'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Keep evidenceRefs for your later code reading'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).not.toContain(
      'Cite evidenceRefs as path:line'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).not.toContain(
      'line number is missing'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'delivered',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain('As Codex');
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain('trusted-to-obey');
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain('trusted-to-use');
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain('context-only');
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain(
      'requires-verification'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain(
      'do not make Alembic prime'
    );
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)).toContain(
      'alembic_work_start'
    );
    expect(JSON.stringify(result.data.primeKnowledgeMaterial.nextActions)).not.toContain(
      'alembic_task'
    );
    expect(result.message).toContain('Codex must immediately shout');
    expect(result.message).toContain('short knowledge receipt');
    expect(result.message).toContain('Speak as Codex or I');
    expect(result.message).toContain('Trust posture checklist');
    expect(result.message).toContain('trusted-to-obey=1');
    expect(result.message).toContain('trusted-to-use=1');
    expect(result.message).toContain('context-only=2');
    expect(result.message).toContain('requires-verification=2');
    expect(result.message).toContain('not as Alembic prime');
    expect(result.message).toContain('keep evidenceRefs in the payload');
    expect(result.message).not.toContain('📍');
    expect(result.message).not.toContain('lib/runtime/mcp/handlers/task.ts:42');
    expect(result.message).not.toContain('Alembic prime has received');
    expect(result.message).not.toContain('Alembic prime received');
    expect(result.message).toContain('before any further tool call');
  });

  test('accepts trusted selected material from a partially degraded resident package', async () => {
    const residentPackage = primeInjectionPackageSummary();
    residentPackage.injection = {
      degradedReasons: ['selected-material-partial'],
      omittedCount: 5,
      selectedCount: 6,
      status: 'degraded',
    };
    residentPackage.omitted = [
      { itemId: 'recipe-weak-1', reason: 'missing-semantic-region-evidence' },
      { itemId: 'recipe-weak-2', reason: 'missing-semantic-region-evidence' },
      { itemId: 'recipe-weak-3', reason: 'missing-semantic-region-evidence' },
      { itemId: 'recipe-weak-4', reason: 'missing-semantic-region-evidence' },
      { itemId: 'recipe-weak-5', reason: 'missing-semantic-region-evidence' },
    ];
    residentPackage.selectedKnowledge = [primePackageSelectedKnowledge()];
    residentPackage.search = {
      actualMode: 'semantic',
      filteredCount: 6,
      query: 'Fix prime output selected material projection',
      queries: ['prime output selected material projection'],
      requestedMode: 'semantic',
      resultCount: 6,
    };

    const searchResult: PrimeSearchResult = {
      guardRules: [],
      relatedKnowledge: [],
      searchMeta: {
        filteredCount: 6,
        language: 'typescript',
        module: 'prime',
        primeInjectionPackage: residentPackage,
        queries: ['prime output selected material projection'],
        residentSearch: {
          attempted: true,
          available: true,
          residentVector: { available: true },
          route: 'alembic-resident-service',
          semanticUsed: true,
          vectorUsed: true,
        },
        resultCount: 6,
        scenario: 'implementation',
      },
    };

    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        operation: 'prime',
        userQuery: 'Fix prime output selected material projection',
        activeFile: 'lib/runtime/mcp/handlers/agent-public-tools.ts',
        language: 'typescript',
      }
    )) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        expect.objectContaining({
          id: 'recipe-episode',
          matchedRegionClasses: expect.arrayContaining(['applicability', 'integrationBoundary']),
          trustEvidence: expect.objectContaining({ kind: 'recipe-semantic-region' }),
          usefulSlices: expect.arrayContaining([
            expect.objectContaining({ regionClass: 'applicability' }),
          ]),
        }),
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use')).toMatchObject({
      requiredInVisibleReceipt: true,
      items: [expect.objectContaining({ id: 'knowledge:recipe-episode' })],
    });
    expect(
      trustLayer(result.data.primeKnowledgeMaterial, 'not-available-or-degraded').items
    ).toHaveLength(0);
  });

  test('accepts p21-shaped resident vector selectedRecipes when selectedKnowledge is absent', async () => {
    const residentPackage = primeInjectionPackageSummary();
    residentPackage.injection = {
      degradedReasons: ['knowledge:stale', 'document:partial'],
      omittedCount: 4,
      selectedCount: 6,
      status: 'degraded',
    };
    residentPackage.selectedKnowledge = [];
    residentPackage.residentRegionRetrieval = {
      attempted: true,
      degradedReasons: ['knowledge:stale', 'document:partial'],
      metadataOnlyFallback: { attempted: false, used: false },
      queryCount: 6,
      regionHitCount: 18,
      route: 'resident-vector-recipe-semantic-region',
      selectedRecipes: [
        {
          itemId: 'recipe-episode',
          matchedRegionClasses: ['applicability', 'integrationBoundary'],
          matchedRegions: primePackageMatchedRegions(),
          score: 0.91,
          sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
          title: 'Episode handoff',
          trigger: '@episode-handoff',
        },
      ],
      used: true,
      vectorAvailable: true,
      wholeEntryOnlyRejectedCount: 0,
    };
    residentPackage.search = {
      actualMode: 'semantic',
      filteredCount: 6,
      query: 'Fix prime output selected material projection',
      queries: ['prime output selected material projection'],
      requestedMode: 'semantic',
      resultCount: 6,
    };

    const searchResult: PrimeSearchResult = {
      guardRules: [],
      relatedKnowledge: [],
      searchMeta: {
        filteredCount: 6,
        language: 'typescript',
        module: 'prime',
        primeInjectionPackage: residentPackage,
        queries: ['prime output selected material projection'],
        residentSearch: {
          attempted: true,
          available: true,
          residentVector: { available: true },
          route: 'alembic-resident-service',
          semanticUsed: true,
          vectorUsed: true,
        },
        resultCount: 6,
        scenario: 'implementation',
      },
    };

    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        activeFile: 'lib/runtime/mcp/handlers/agent-public-tools.ts',
        language: 'typescript',
        operation: 'prime',
        userQuery: 'Fix prime output selected material projection',
      }
    )) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        expect.objectContaining({
          id: 'recipe-episode',
          matchedRegionClasses: expect.arrayContaining(['applicability', 'integrationBoundary']),
          trustEvidence: expect.objectContaining({
            kind: 'recipe-semantic-region',
            source: 'prime-injection-package',
          }),
          usefulSlices: expect.arrayContaining([
            expect.objectContaining({ regionClass: 'applicability' }),
            expect.objectContaining({ regionClass: 'integrationBoundary' }),
          ]),
        }),
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use').items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge:recipe-episode',
          source: 'accepted-knowledge',
        }),
      ])
    );
    expect(result.data.primeKnowledgeMaterial.degradedReason).toBeUndefined();
  });

  test('returns empty material when prime finds no matching recipes or guards', async () => {
    const result = (await taskHandler(
      makeContext(async () => null),
      {
        operation: 'prime',
        userQuery: 'Implement quick Recipe lookup route',
      }
    )) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge).toBeNull();
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'empty',
      acceptedKnowledge: [],
      acceptedGuards: [],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-obey').items).toHaveLength(0);
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use').items).toHaveLength(0);
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'context-only').items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'prime-query-context',
          source: 'search-context',
        }),
        expect.objectContaining({
          id: 'host-intent-frame',
          source: 'host-intent',
        }),
      ])
    );
    expect(
      trustLayer(result.data.primeKnowledgeMaterial, 'not-available-or-degraded')
    ).toMatchObject({
      requiredInVisibleReceipt: true,
      items: [
        expect.objectContaining({
          id: 'prime-status:empty',
          source: 'prime-status',
          status: 'empty',
        }),
      ],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'I did not receive matching Recipe or Guard knowledge'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('shout a clear receipt');
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'not-available-or-degraded'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'no trusted-to-obey or trusted-to-use project knowledge'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'empty',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(result.message).toContain('No matching recipes found.');
    expect(result.message).toContain('not-available-or-degraded=1');
    expect(result.message).toContain('it did not receive usable project knowledge');
    expect(result.message).toContain('Do not make Alembic prime');
  });

  test('skips host-declared non-code automation context before prime retrieval', async () => {
    let searchedIntent: ExtractedIntent | null = null;
    let searchedOptions: { hostIntentFrame?: unknown } | null = null;
    const ctx = makeContext(async (intent, options) => {
      searchedIntent = intent;
      searchedOptions = options ?? null;
      return null;
    });
    ctx.hostTurnMeta = {
      threadId: 'raw-request-thread-id',
      conversationId: 'raw-request-conversation-id',
      turnId: 'turn-from-request',
      cwd: '/Users/example/private-project',
      surface: 'codex',
    };

    const result = (await taskHandler(ctx, {
      operation: 'prime',
      userQuery:
        '<codex_delegation><input>dispatchGroup: PCTL-STAGE1-PLUGIN-IMPLEMENTATION-20260603</input></codex_delegation>',
      hostDeclaredIntent: {
        summary: 'Route host intent into the prime flow',
        confidence: 0.73,
        labels: ['intent', 'prime'],
        source: 'codex-host',
        ignoredPayload: 'not retained',
      },
      hostTurnMeta: {
        threadId: 'raw-explicit-thread-id',
        messageId: 'message-1',
        activeFile: '/Users/example/private-project/lib/file.ts',
      },
    })) as PrimeEnvelope;

    expect(searchedIntent).toBeNull();
    expect(searchedOptions).toBeNull();
    expect(result.data.lifecyclePolicy).toMatchObject({
      inputSource: 'user-intent',
      intentKind: 'knowledge-query',
      primeDecision: {
        action: 'skip',
        curatedQuery: 'Route host intent into the prime flow',
        reasonCode: 'non-code-development-turn',
      },
      taskAnchorDecision: {
        action: 'skip',
        reasonCode: 'readonly-no-anchor',
      },
    });
    expect(result.data.primeKnowledgeMaterial.status).toBe('empty');
    expect(result.data.primeKnowledgeMaterial.intent.userQuery).toBe(
      'Route host intent into the prime flow'
    );
    expect(result.data.primeKnowledgeMaterial.intent.hostIntentFrame).toMatchObject({
      source: 'mixed',
      confidence: 0.73,
      degraded: false,
      hostDeclaredIntent: {
        summary: 'Route host intent into the prime flow',
        labels: ['intent', 'prime'],
        source: 'codex-host',
      },
      recognizedIntentDraft: {
        action: 'search',
        confidence: 0.73,
        constraints: expect.arrayContaining(['intent', 'prime']),
        degraded: false,
        evidenceSpans: expect.arrayContaining([
          expect.objectContaining({ field: 'query', source: 'hostDeclaredIntent' }),
        ]),
        query: 'Route host intent into the prime flow',
        source: 'mixed',
        status: 'recognized',
      },
      hostTurnMeta: {
        turnId: 'turn-from-request',
        messageId: 'message-1',
        surface: 'codex',
        threadIdHash: expect.any(String),
        conversationIdHash: expect.any(String),
        redactions: expect.arrayContaining(['threadId', 'conversationId', 'cwd', 'activeFile']),
      },
    });
    const serializedFrame = JSON.stringify(
      result.data.primeKnowledgeMaterial.intent.hostIntentFrame
    );
    expect(serializedFrame).not.toContain('raw-request-thread-id');
    expect(serializedFrame).not.toContain('raw-explicit-thread-id');
    expect(serializedFrame).not.toContain('/Users/example/private-project');
    expect(serializedFrame).not.toContain('dispatchGroup');
    expect(serializedFrame).not.toContain('ignoredPayload');
    expect(ctx.session?.intent.primeQuery).toBe('Route host intent into the prime flow');
    expect(ctx.session?.intent.hostIntentFrame?.source).toBe('mixed');
  });

  test('hands off prime intent episodes to resident service with redacted host identifiers', async () => {
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-episode',
          title: 'Episode handoff',
          trigger: '@episode-handoff',
          kind: 'pattern',
          language: 'typescript',
          score: 0.91,
          description: 'Persist prime intent episodes in Alembic resident service.',
          actionHint: 'Send redacted host intent facts and search meta to the resident API.',
          knowledgeType: 'code-standard',
          sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
        },
      ],
      guardRules: [],
      searchMeta: {
        queries: ['episode handoff'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 1,
        filteredCount: 1,
        intentEvidence: intentEvidenceSummary(),
        primeInjectionPackage: primeInjectionPackageSummary(),
        residentSearch: {
          attempted: true,
          available: true,
          route: 'alembic-resident-service',
          searchMeta: {
            hostIntentApplied: true,
            hostIntentConfidence: 0.86,
            hostIntentDegraded: false,
            hostIntentSourceRefs: ['host:intent'],
            intentEvidence: intentEvidenceSummary(),
            primeInjectionPackage: primeInjectionPackageSummary(),
          },
        },
      },
    };
    const residentStatus = { owner: 'alembic', route: 'local-alembic-daemon' };
    const residentServiceClient = {
      latestIntentEpisode: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          episode: {
            episodeId: 'episode-prev',
            query: 'previous query',
            sessionKey: 'sha256:previous',
            sourceRefs: ['host:previous'],
            status: 'completed',
          },
        },
      })),
      recentIntentEpisodes: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          count: 1,
          episode: null,
          episodes: [
            {
              episodeId: 'episode-prev',
              query: 'previous query',
              sessionKey: 'sha256:previous',
              sourceRefs: ['host:previous'],
              status: 'completed',
            },
          ],
        },
      })),
      startIntentEpisode: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          episode: {
            episodeId: 'episode-current',
            query: 'Create episode handoff',
            sessionKey: 'sha256:current',
            sourceRefs: ['host:intent', 'knowledge:recipe-episode'],
            status: 'active',
          },
        },
      })),
      updateIntentEpisodeOutcome: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          episode: {
            episodeId: 'episode-current',
            sessionKey: 'sha256:current',
            status: 'completed',
          },
        },
      })),
    };
    const ctx = makeContext(async () => searchResult, { residentServiceClient });

    const primeResult = (await taskHandler(ctx, {
      operation: 'prime',
      activeFile: '/Users/example/private-project/lib/task.ts',
      hostDeclaredIntent: {
        confidence: 0.86,
        sourceRefs: ['host:intent'],
        summary: 'Create episode handoff',
      },
      hostTurnMeta: {
        activeFile: '/Users/example/private-project/lib/task.ts',
        threadId: 'raw-thread-id',
        turnId: 'turn-1',
      },
      language: 'typescript',
    })) as PrimeEnvelope;

    expect(residentServiceClient.latestIntentEpisode).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(/^thread:/),
    });
    expect(residentServiceClient.recentIntentEpisodes).toHaveBeenCalledWith({
      limit: 3,
      sessionId: expect.stringMatching(/^thread:/),
    });
    expect(residentServiceClient.startIntentEpisode).toHaveBeenCalledTimes(1);
    const startRequest = residentServiceClient.startIntentEpisode.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(startRequest).toMatchObject({
      activeFile: '/Users/example/private-project/lib/task.ts',
      language: 'typescript',
      query: 'Create episode handoff',
      scenario: 'generate',
      sessionId: expect.stringMatching(/^thread:/),
      sourceRefs: ['host:intent', 'knowledge:recipe-episode'],
      turnId: 'turn-1',
    });
    expect(startRequest.sessionId).not.toBe('raw-thread-id');
    expect(JSON.stringify(startRequest.hostIntent)).not.toContain('raw-thread-id');
    expect(JSON.stringify(startRequest.hostIntent)).not.toContain('/Users/example/private-project');
    expect(startRequest.searchMeta).toMatchObject({
      filteredCount: 1,
      hostIntentApplied: true,
      hostIntentConfidence: 0.86,
      hostIntentDegraded: false,
      hostIntentSourceRefs: ['host:intent'],
      intentEvidence: {
        semanticAnchors: [
          expect.objectContaining({
            value: 'Create episode handoff',
          }),
        ],
        scoreBreakdown: [
          expect.objectContaining({
            itemId: 'recipe-episode',
            semanticScore: 0.81,
          }),
        ],
      },
      queries: ['episode handoff'],
      primeInjectionPackage: {
        injection: {
          selectedCount: 1,
          status: 'ready',
        },
        selectedKnowledge: [
          expect.objectContaining({
            injectionStatus: 'selected',
            itemId: 'recipe-episode',
          }),
        ],
      },
      resultCount: 1,
    });
    expect(ctx.session?.intent.searchMeta?.intentEvidence).toMatchObject({
      topAnchorMatches: [
        expect.objectContaining({
          itemId: 'recipe-episode',
        }),
      ],
    });
    expect(ctx.session?.intent.searchMeta?.primeInjectionPackage).toMatchObject({
      trace: {
        evidenceRefs: ['scoreBreakdown:recipe-episode'],
      },
    });
    expect(primeResult.data.primeKnowledgeMaterial.intent.activeFile).toBe(
      '[absolute-path]/task.ts'
    );
    expect(primeResult.data.primeKnowledgeMaterial.intentEvidence).toMatchObject({
      relationEvidence: [
        expect.objectContaining({
          relatedId: 'recipe-related',
        }),
      ],
      semanticAnchors: [
        expect.objectContaining({
          source: 'intentSearchPlan.executableQuery',
        }),
      ],
    });
    expect(primeResult.data.primeKnowledgeMaterial.primeInjectionPackage).toMatchObject({
      injection: {
        status: 'ready',
      },
      trace: {
        sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
      },
    });
    expect(primeResult.data.primeKnowledgeMaterial.intentEpisode).toMatchObject({
      available: true,
      current: {
        episodeId: 'episode-current',
        sessionKey: 'sha256:current',
        status: 'active',
      },
      latest: {
        episodeId: 'episode-prev',
        sessionKey: 'sha256:previous',
        status: 'completed',
      },
      recent: [
        {
          episodeId: 'episode-prev',
          sessionKey: 'sha256:previous',
          status: 'completed',
        },
      ],
      sessionSource: 'host-thread-hash',
    });
    const visibleEpisodePayload = JSON.stringify(primeResult.data.primeKnowledgeMaterial);
    expect(visibleEpisodePayload).not.toContain('raw-thread-id');
    expect(visibleEpisodePayload).not.toContain('/Users/example/private-project');
    expect(ctx.session?.intent.intentEpisode).toMatchObject({
      episodeId: 'episode-current',
      sessionKey: 'sha256:current',
      startAvailable: true,
    });

    const createResult = (await taskHandler(ctx, {
      operation: 'create',
      title: 'Episode task',
    })) as { data: { id: string } };
    await taskHandler(ctx, {
      operation: 'close',
      id: createResult.data.id,
      reason: 'done',
    });
    expect(residentServiceClient.updateIntentEpisodeOutcome).toHaveBeenCalledWith(
      'episode-current',
      expect.objectContaining({
        reason: 'done',
        searchMeta: expect.objectContaining({
          primeInjectionPackage: expect.objectContaining({
            injection: expect.objectContaining({
              status: 'ready',
            }),
          }),
        }),
        status: 'completed',
        taskId: createResult.data.id,
      })
    );
  });

  test('degrades candidate prime package knowledge as requiring verification, not trusted use', async () => {
    const candidatePackage = primeInjectionPackageSummary();
    candidatePackage.injection.status = 'candidate';
    candidatePackage.injection.degradedReasons = [
      'selectedKnowledge:recipe-candidate:sourceRefs-missing',
    ];
    candidatePackage.trace.sourceRefs = [];
    candidatePackage.selectedKnowledge = [
      {
        evidenceRefs: ['scoreBreakdown:recipe-candidate'],
        injectionStatus: 'candidate',
        itemId: 'recipe-candidate',
        kind: 'pattern',
        rank: 1,
        score: 0.64,
        sourceRefs: [],
        title: 'Candidate episode handoff',
        trigger: '@candidate-episode',
        whySelected: ['semantic-score'],
      },
    ];
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-candidate',
          title: 'Candidate episode handoff',
          trigger: '@candidate-episode',
          kind: 'pattern',
          language: 'typescript',
          score: 0.64,
          description: 'A plausible but unverified candidate pattern.',
          sourceRefs: [],
        },
      ],
      guardRules: [],
      searchMeta: {
        queries: ['candidate episode'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 1,
        filteredCount: 1,
        primeInjectionPackage: candidatePackage,
      },
    };

    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        hostDeclaredIntent: {
          action: 'implement',
          goal: 'Implement candidate knowledge validation',
          keywords: ['candidate', 'verification'],
          query: 'Implement candidate knowledge validation carefully',
        },
        operation: 'prime',
        userQuery: 'Implement candidate knowledge validation carefully',
      }
    )) as PrimeEnvelope;

    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'degraded',
      degradedReason: { code: 'trusted-material-evidence-missing' },
      acceptedKnowledge: [],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use')).toMatchObject({
      requiredInVisibleReceipt: false,
      items: [],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'requires-verification')).toMatchObject({
      requiredInVisibleReceipt: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'prime-package-status:candidate',
          source: 'prime-injection-package',
          status: 'candidate',
        }),
        expect.objectContaining({
          id: 'candidate-knowledge:recipe-candidate',
          source: 'prime-injection-package',
          status: 'candidate',
        }),
      ]),
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'I did not receive usable project knowledge because prime degraded'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain(
      'not-available-or-degraded'
    );
    expect(result.message).toContain('trusted-to-use=0');
    expect(result.message).toContain('requires-verification=3');
  });

  test('degrades ready sourceRefs-only prime package knowledge without region or locator evidence', async () => {
    const sourceOnlyPackage = primeInjectionPackageSummary();
    sourceOnlyPackage.selectedKnowledge = [
      {
        evidenceRefs: ['scoreBreakdown:recipe-source-only'],
        injectionStatus: 'selected',
        itemId: 'recipe-source-only',
        kind: 'pattern',
        rank: 1,
        score: 0.81,
        sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
        title: 'Source only handoff',
        trigger: '@source-only',
        whySelected: ['semantic-score'],
      },
    ];
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-source-only',
          title: 'Source only handoff',
          trigger: '@source-only',
          kind: 'pattern',
          language: 'typescript',
          score: 0.81,
          description: 'A sourceRefs-only semantic hit must not become trusted material.',
          sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
        },
      ],
      guardRules: [],
      searchMeta: {
        queries: ['source only'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 1,
        filteredCount: 1,
        primeInjectionPackage: sourceOnlyPackage,
      },
    };

    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        hostDeclaredIntent: {
          action: 'implement',
          goal: 'Implement source-only trust gating',
          keywords: ['source', 'trust'],
          query: 'Implement source-only trust gating',
        },
        operation: 'prime',
        userQuery: 'Implement source-only trust gating',
      }
    )) as PrimeEnvelope;

    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'degraded',
      degradedReason: {
        code: 'trusted-material-evidence-missing',
        message: expect.stringContaining('selectedKnowledge[].matchedRegionClasses|matchedRegions'),
      },
      acceptedKnowledge: [],
    });
    expect(result.data.primeKnowledgeMaterial.degradedReason?.message).toContain(
      'selectedKnowledge[].evidenceRefs|whySelected recipe locator signal'
    );
    expect(result.data.primeKnowledgeMaterial.degradedReason?.message).toContain(
      'SourceRefs alone remain verification anchors'
    );
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use').items).toHaveLength(0);
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'requires-verification')).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'selected-knowledge-untrusted:recipe-source-only',
          source: 'prime-injection-package',
        }),
      ]),
    });
  });

  test('accepts resident selected semantic-region material when relatedKnowledge omits the selected item', async () => {
    const selectedOnlyPackage = primeInjectionPackageSummary();
    selectedOnlyPackage.selectedKnowledge = [
      {
        evidenceRefs: ['scoreBreakdown:recipe-selected-only'],
        injectionStatus: 'selected',
        itemId: 'recipe-selected-only',
        kind: 'pattern',
        matchedRegionClasses: ['applicability', 'implementationSteps'],
        matchedRegions: [
          {
            recipeId: 'recipe-selected-only',
            regionClass: 'applicability',
            score: 0.94,
            snippet:
              'Use this Recipe when resident selectedKnowledge already carries compact semantic-region evidence.',
            sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:42'],
            sourceRefsBridge: 'active',
          },
          {
            recipeId: 'recipe-selected-only',
            regionClass: 'implementationSteps',
            score: 0.89,
            snippet:
              'Project accepted material directly from the selected resident record when the filtered public pool omitted it.',
            sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:43'],
            sourceRefsBridge: 'active',
          },
        ],
        rank: 1,
        score: 0.94,
        sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:42'],
        title: 'Selected-only resident bridge',
        trigger: '@selected-only-resident-bridge',
        whySelected: ['resident-region'],
      },
    ];
    selectedOnlyPackage.injection.selectedCount = 1;
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [],
      guardRules: [],
      searchMeta: {
        queries: ['selected resident bridge'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'prime',
        resultCount: 1,
        filteredCount: 0,
        primeInjectionPackage: selectedOnlyPackage,
        residentSearch: {
          attempted: true,
          available: true,
          route: 'alembic-resident-service',
          semanticUsed: true,
          vectorUsed: true,
          residentVector: { available: true },
        },
      },
    };

    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        hostDeclaredIntent: {
          action: 'implement',
          goal: 'Implement selected-only resident trust bridge',
          keywords: ['resident', 'semantic-region'],
          query: 'Implement selected-only resident trust bridge',
        },
        operation: 'prime',
        userQuery: 'Implement selected-only resident trust bridge',
      }
    )) as PrimeEnvelope;

    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        expect.objectContaining({
          id: 'recipe-selected-only',
          matchedRegionClasses: ['applicability', 'implementationSteps'],
          score: 0.94,
          title: 'Selected-only resident bridge',
          trigger: '@selected-only-resident-bridge',
          trustEvidence: expect.objectContaining({ kind: 'recipe-semantic-region' }),
          usefulSlices: [
            expect.objectContaining({ regionClass: 'applicability' }),
            expect.objectContaining({ regionClass: 'implementationSteps' }),
          ],
        }),
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use').items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge:recipe-selected-only',
          source: 'accepted-knowledge',
        }),
      ])
    );
    expect(result.data.primeKnowledgeMaterial.degradedReason).toBeUndefined();
  });

  test('accepts selected resident semantic-region evidence when selected knowledge uses recipe id alias', async () => {
    const aliasPackage = primeInjectionPackageSummary();
    aliasPackage.selectedKnowledge = [
      {
        evidenceRefs: ['scoreBreakdown:recipe-alias'],
        injectionStatus: 'selected',
        kind: 'pattern',
        matchedRegionClasses: ['applicability'],
        matchedRegions: [
          {
            recipeId: 'knowledge:recipe-alias',
            regionClass: 'applicability',
            score: 0.93,
            snippet:
              'Use this Recipe when selected resident evidence is keyed by recipeId instead of itemId.',
            sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
            sourceRefsBridge: 'active',
          },
        ],
        rank: 1,
        recipeId: 'knowledge:recipe-alias',
        score: 0.83,
        sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
        title: 'Alias keyed handoff',
        trigger: '@alias-handoff',
        whySelected: ['resident-region'],
      },
    ];
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-alias',
          title: 'Alias keyed handoff',
          trigger: '@alias-handoff',
          kind: 'pattern',
          language: 'typescript',
          score: 0.83,
          description: 'Selected evidence should bridge through recipeId alias keys.',
          sourceRefs: ['lib/runtime/mcp/handlers/task.ts:42'],
        },
      ],
      guardRules: [],
      searchMeta: {
        queries: ['alias keyed handoff'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 1,
        filteredCount: 1,
        primeInjectionPackage: aliasPackage,
      },
    };

    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        hostDeclaredIntent: {
          action: 'implement',
          goal: 'Implement selected knowledge alias bridge',
          keywords: ['alias', 'resident-region'],
          query: 'Implement selected knowledge alias bridge',
        },
        operation: 'prime',
        userQuery: 'Implement selected knowledge alias bridge',
      }
    )) as PrimeEnvelope;

    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        expect.objectContaining({
          id: 'recipe-alias',
          matchedRegionClasses: ['applicability'],
          trustEvidence: expect.objectContaining({ kind: 'recipe-semantic-region' }),
          usefulSlices: [expect.objectContaining({ regionClass: 'applicability' })],
        }),
      ],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use').items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge:recipe-alias',
          source: 'accepted-knowledge',
        }),
      ])
    );
  });

  test('returns degraded material when the prime search pipeline is unavailable', async () => {
    const result = (await taskHandler(makeContextWithoutPipeline(), {
      operation: 'prime',
      userQuery: 'Implement something with project knowledge',
    })) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge).toBeNull();
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'degraded',
      acceptedKnowledge: [],
      acceptedGuards: [],
    });
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-obey').items).toHaveLength(0);
    expect(trustLayer(result.data.primeKnowledgeMaterial, 'trusted-to-use').items).toHaveLength(0);
    expect(
      trustLayer(result.data.primeKnowledgeMaterial, 'not-available-or-degraded')
    ).toMatchObject({
      requiredInVisibleReceipt: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'prime-status:degraded',
          source: 'prime-status',
          status: 'degraded',
        }),
      ]),
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'I did not receive usable project knowledge because prime degraded'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('shout a clear receipt');
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'not-available-or-degraded'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain(
      'not-available-or-degraded'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'degraded',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Prime knowledge search degraded');
    expect(result.message).toContain('not-available-or-degraded=2');
  });
});
