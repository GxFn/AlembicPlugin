import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  codeGuardHandler,
  primeHandler,
  workFinishHandler,
  workStartHandler,
} from '../../lib/runtime/mcp/handlers/agent-public-tools.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import type { ResidentSearchResult } from '../../lib/service/resident/AlembicResidentServiceClient.js';
import {
  PrimeSearchPipeline,
  type PrimeSearchResult,
} from '../../lib/service/task/PrimeSearchPipeline.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

function makeContext(
  search?: (intent: unknown, options?: unknown) => Promise<PrimeSearchResult | null>,
  services: Record<string, unknown> = {}
): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return search ? { search } : null;
        }
        if (name in services) {
          return services[name];
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
    session: {
      id: 'session-public-tools',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
    },
  };
}

function publicToolLegacyTestView(output: unknown) {
  const clean = asRecord(output);
  expect(clean).not.toHaveProperty('success');
  expect(clean).not.toHaveProperty('data');
  expect(clean).not.toHaveProperty('errorCode');
  expect(clean).not.toHaveProperty('message');
  if (clean.toolName !== 'alembic_prime') {
    expect(clean).not.toHaveProperty('result');
  }
  expect(JSON.stringify(clean)).not.toContain('legacyCompatibility');
  expect(JSON.stringify(clean)).not.toContain('outputBudget');

  const data: Record<string, unknown> = { ...clean };
  data.result = {
    ...clean,
    legacyCompatibility: { usesLegacyTaskHandler: false },
  };

  attachIntentLegacyView(clean, data);
  attachPrimeLegacyView(clean, data);
  return {
    success: clean.ok === true,
    data,
  };
}

function attachIntentLegacyView(clean: Record<string, unknown>, data: Record<string, unknown>) {
  const intentPersistence = asRecord(clean.intentPersistence);
  if (Object.keys(intentPersistence).length > 0) {
    const created = intentPersistence.created === true;
    data.persistence = {
      consumable: intentPersistence.consumable === true,
      kind: intentPersistence.kind,
      localRecordCreated: created,
    };
    data.sourcePolicy = {
      localIntentRecord: {
        consumable: intentPersistence.consumable === true,
        created,
        persistenceKind: intentPersistence.kind,
      },
    };
  }

  const retrievalPlan = asRecord(clean.retrievalPlan);
  if (Object.keys(retrievalPlan).length > 0) {
    data.recipeRetrievalHint = {
      profiles: ['structured-recipe', 'implementation-pattern'],
      route: retrievalPlan.route,
      vectorUseKind: retrievalPlan.vectorUseKind,
    };
    data.vectorPlan = {
      queries: stringArray([asRecord(clean.recognizedIntent).query]),
      route: 'structure-first-recipe-retrieval',
      vectorUseKind: retrievalPlan.vectorUseKind,
    };
  }

  const intentClassification = asRecord(clean.intentClassification);
  const toolPlan = asRecord(clean.toolPlan);
  if (Object.keys(intentClassification).length > 0 || Object.keys(toolPlan).length > 0) {
    data.diagnostics = {
      enumRequirementMapping: [
        'agentHost',
        'hostSurface',
        'inputSource',
        'intentKind',
        'actionKind',
        'objectKind',
        'scopeKind',
        'persistenceKind',
        'primeNeed',
        'workNeed',
        'guardNeed',
        'vectorUseKind',
        'confidenceBand',
      ].map((field) => ({ field })),
      normalized: {
        confidenceBand: intentClassification.confidenceBand,
        persistenceKind: intentPersistence.kind,
        vectorUseKind: retrievalPlan.vectorUseKind,
      },
      toolNeeds: {
        guardNeed: toolPlan.guardNeed,
        primeNeed: toolPlan.primeNeed,
        workNeed: toolPlan.workNeed,
      },
    };
  }
}

function attachPrimeLegacyView(clean: Record<string, unknown>, data: Record<string, unknown>) {
  const primePackage = asRecord(clean.primePackage);
  if (Object.keys(primePackage).length === 0) {
    return;
  }
  const compactPackage = asRecord(primePackage.compactPackage);
  const feedbackDigest = asRecord(primePackage.feedbackDigest);
  const primeInjectionPackage = asRecord(compactPackage.primeInjectionPackage);
  const acceptedDecisionRefs =
    numberValue(feedbackDigest.decisionRefCount) > 0 ? ['decision-active-1'] : [];
  const producerMissingFields = stringArray(primeInjectionPackage.missingProducerFields);
  const producerAvailable = producerMissingFields.length === 0;
  const retrievalConsumer = {
    decisionRegister: {
      acceptedDecisionRefs,
      auditExcludedCount: acceptedDecisionRefs.length,
    },
    producerContract: {
      available: producerAvailable,
      missingFields: producerMissingFields,
    },
    retrievalQuality: {
      decisionRefCount: numberValue(feedbackDigest.decisionRefCount),
      feedbackSignalCount: numberValue(feedbackDigest.feedbackSignalCount),
      relationEvidenceCount: numberValue(feedbackDigest.relationEvidenceCount),
      sourceRefCoverage: numberValue(feedbackDigest.sourceRefCoverage),
    },
  };
  const materialStatus =
    primePackage.status === 'degraded' && asRecord(primePackage.reason).code === 'knowledge-empty'
      ? 'empty'
      : (asRecord(primePackage.trustReceipt).status ?? 'delivered');
  data.primeKnowledgeMaterial = {
    acceptedGuards: arrayValue(compactPackage.acceptedGuards),
    acceptedKnowledge: arrayValue(compactPackage.acceptedKnowledge),
    hostResponse: { requiredBeforeNextAction: true },
    retrievalConsumer,
    status: materialStatus,
    trustPosture: {
      receiptChecklist: arrayValue(asRecord(primePackage.trustPosture).receiptChecklist).map(
        (entry) => ({
          ...asRecord(entry),
          items: [],
        })
      ),
    },
  };
  data.primePackage = {
    ...primePackage,
    diagnostics: {
      outputBudget: { maxChars: 1600, truncated: false, usedChars: 0 },
      retrieval: { residentAvailable: producerAvailable, searchAttempted: true },
    },
    retrievalConsumer,
    runtimePolicy: {
      available: producerAvailable,
      sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: false },
    },
    sourcePolicy: {
      automationEnvelope: {
        blockedWithoutSourceRefs: clean.ok === false,
        requiredSourceRefsForPrime: clean.ok === false,
        sourceRefsCount: 0,
      },
      rawAutomationEnvelopeUsedAsQuery: false,
      rawThreadIdsPersisted: false,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function deliveredGuardRules(): PrimeSearchResult['guardRules'] {
  return [
    {
      actionHint: 'Keep Plugin-owned Codex MCP boundaries.',
      description: 'Do not route Codex public tools through legacy task operations.',
      id: 'guard-public-api',
      kind: 'rule',
      language: 'typescript',
      score: 0.86,
      sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts:42'],
      title: 'Keep public tools Plugin-owned',
      trigger: '@plugin-public-tools',
    },
  ];
}

function deliveredRelatedKnowledge(): PrimeSearchResult['relatedKnowledge'] {
  return [
    {
      actionHint: 'Use structure-first Recipe retrieval.',
      description: 'Prime should search with extracted structure and host intent context.',
      id: 'recipe-public-prime',
      kind: 'pattern',
      language: 'typescript',
      score: 0.92,
      sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:112'],
      title: 'Agent public prime',
      trigger: '@agent-public-prime',
    },
  ];
}

function deliveredRelationEvidence() {
  return {
    count: 1,
    evidence: [
      {
        direction: 'outgoing',
        itemId: 'recipe-public-prime',
        relatedId: 'decision-active-1',
        relation: 'supports',
        source: 'knowledgeGraphService',
      },
    ],
    omitted: [],
  };
}

function deliveredRetrievalConsumer(): NonNullable<
  PrimeSearchResult['searchMeta']['retrievalConsumer']
> {
  return {
    decisionRegister: {
      acceptedDecisionRefs: ['decision-active-1'],
      auditExcludedCount: 1,
      available: true,
      defaultLifecycle: 'active-effective-only',
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
      reasonCode: 'resident-search-stage1a-contract-present',
      requiredFields: ['decisionRegister', 'feedback', 'retrievalQuality'],
      stage: 'AFAPI-FULL-STAGE1A',
    },
    relationEvidence: deliveredRelationEvidence(),
    retrievalQuality: {
      decisionRefCount: 1,
      feedbackSignalCount: 3,
      relationEvidenceCount: 1,
      sourceRefCoverage: 1,
      version: 1,
    },
    source: 'resident-search-meta',
    version: 1,
  };
}

function deliveredPrimeInjectionPackage(): NonNullable<
  PrimeSearchResult['searchMeta']['primeInjectionPackage']
> {
  return {
    decisionRegister: {
      acceptedDecisionRefs: ['decision-active-1'],
      auditExcludedCount: 1,
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
      confidence: 0.9,
      degraded: false,
      degradedReasons: [],
      executableQuery: 'Implement public prime active tool',
      requestedMode: 'semantic',
      sourceRefs: ['host:intent'],
      whySelected: ['intent-search-plan'],
    },
    omitted: [],
    relations: { evidence: [], omitted: [] },
    residentRegionRetrieval: {
      attempted: true,
      degradedReasons: [],
      metadataOnlyFallback: { attempted: false, used: false },
      queryCount: 2,
      regionHitCount: 2,
      route: 'resident-vector-recipe-semantic-region',
      selectedRecipes: [],
      used: true,
      vectorAvailable: true,
      wholeEntryOnlyRejectedCount: 0,
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
      query: 'Implement public prime active tool',
      queries: ['Implement public prime active tool'],
      requestedMode: 'semantic',
      resultCount: 1,
    },
    selectedKnowledge: [
      {
        evidenceRefs: ['scoreBreakdown:recipe-public-prime'],
        injectionStatus: 'selected',
        itemId: 'recipe-public-prime',
        kind: 'pattern',
        matchedRegionClasses: ['applicability', 'integrationBoundary'],
        matchedRegions: [
          {
            regionClass: 'applicability',
            score: 0.94,
            snippet: 'Use structure-first Recipe retrieval for public prime projections.',
            sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:112'],
            sourceRefsBridge: 'active',
            vectorId: 'recipe_region_recipe-public-prime_applicability_hash',
          },
        ],
        rank: 1,
        score: 0.92,
        sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:112'],
        title: 'Agent public prime',
        trigger: '@agent-public-prime',
        whySelected: ['resident-region'],
      },
    ],
    trace: {
      evidenceRefs: ['scoreBreakdown:recipe-public-prime'],
      sourcePath: ['searchMeta.primeInjectionPackage'],
      sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:112'],
      sources: ['intentSearchPlan', 'intentEvidence'],
    },
    vector: {
      omitted: [],
      scoreBreakdown: [],
      semanticAnchors: [],
      semanticUsed: true,
      topAnchorMatches: [],
      vectorAvailable: true,
      vectorUsed: true,
    },
    version: 1,
  };
}

function deliveredSearchMeta(): PrimeSearchResult['searchMeta'] {
  return {
    filteredCount: 2,
    language: 'typescript',
    module: 'codex/mcp',
    queries: ['Implement public prime active tool'],
    resultCount: 2,
    scenario: 'generate',
    primeInjectionPackage: deliveredPrimeInjectionPackage(),
    retrievalConsumer: deliveredRetrievalConsumer(),
    residentSearch: {
      attempted: true,
      available: true,
      retrievalConsumer: deliveredRetrievalConsumer(),
      route: 'alembic-resident-service',
      semanticUsed: true,
      vectorUsed: true,
      residentVector: { available: true },
    },
  };
}

function deliveredSearchResult(): PrimeSearchResult {
  return {
    guardRules: deliveredGuardRules(),
    relatedKnowledge: deliveredRelatedKnowledge(),
    searchMeta: deliveredSearchMeta(),
  };
}

function selectedOnlySearchResult(): PrimeSearchResult {
  const primeInjectionPackage = deliveredPrimeInjectionPackage();
  primeInjectionPackage.injection.selectedCount = 1;
  primeInjectionPackage.search.filteredCount = 0;
  primeInjectionPackage.search.resultCount = 1;
  primeInjectionPackage.selectedKnowledge = [
    {
      body: 'FULL_RECIPE_BODY_MARKER_SHOULD_NOT_LEAK',
      description: 'FULL_RECIPE_BODY_MARKER_SHOULD_NOT_LEAK',
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
  return {
    guardRules: [],
    relatedKnowledge: [],
    searchMeta: {
      ...deliveredSearchMeta(),
      filteredCount: 0,
      resultCount: 1,
      primeInjectionPackage,
    },
  };
}

function realResidentDegradedSelectedSearchResult(): PrimeSearchResult {
  const result = selectedOnlySearchResult();
  const primeInjectionPackage = result.searchMeta.primeInjectionPackage;
  if (!primeInjectionPackage) {
    throw new Error('expected selected-only prime injection package');
  }
  primeInjectionPackage.injection = {
    degradedReasons: ['selected-material-partial'],
    omittedCount: 5,
    selectedCount: 6,
    status: 'degraded',
  };
  primeInjectionPackage.omitted = [
    { itemId: 'recipe-weak-1', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-2', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-3', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-4', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-5', reason: 'missing-semantic-region-evidence' },
  ];
  primeInjectionPackage.search.filteredCount = 6;
  primeInjectionPackage.search.resultCount = 6;
  result.searchMeta.filteredCount = 6;
  result.searchMeta.resultCount = 6;
  return result;
}

function p21VectorSelectedRecipesSearchResult(): PrimeSearchResult {
  const result = selectedOnlySearchResult();
  const primeInjectionPackage = result.searchMeta.primeInjectionPackage;
  if (!primeInjectionPackage) {
    throw new Error('expected selected-only prime injection package');
  }
  primeInjectionPackage.injection = {
    degradedReasons: ['knowledge:stale', 'document:partial'],
    omittedCount: 4,
    selectedCount: 6,
    status: 'degraded',
  };
  primeInjectionPackage.selectedKnowledge = [];
  primeInjectionPackage.residentRegionRetrieval = {
    attempted: true,
    degradedReasons: ['knowledge:stale', 'document:partial'],
    metadataOnlyFallback: { attempted: false, used: false },
    queryCount: 6,
    regionHitCount: 18,
    route: 'resident-vector-recipe-semantic-region',
    selectedRecipes: [
      {
        itemId: 'recipe-selected-only',
        matchedRegionClasses: ['applicability', 'implementationSteps'],
        matchedRegions: [
          {
            recipeId: 'recipe-selected-only',
            regionClass: 'applicability',
            score: 0.94,
            snippet:
              'Use this Recipe when resident region retrieval selected compact semantic evidence.',
            sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:42'],
            sourceRefsBridge: 'active',
          },
          {
            recipeId: 'recipe-selected-only',
            regionClass: 'implementationSteps',
            score: 0.89,
            snippet:
              'Project accepted material from residentRegionRetrieval.selectedRecipes when selectedKnowledge is absent.',
            sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:43'],
            sourceRefsBridge: 'active',
          },
        ],
        score: 0.94,
        sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:42'],
        title: 'Selected-only resident bridge',
        trigger: '@selected-only-resident-bridge',
      },
    ],
    used: true,
    vectorAvailable: true,
    wholeEntryOnlyRejectedCount: 0,
  };
  primeInjectionPackage.omitted = [
    { itemId: 'recipe-weak-1', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-2', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-3', reason: 'missing-semantic-region-evidence' },
    { itemId: 'recipe-weak-4', reason: 'missing-semantic-region-evidence' },
  ];
  primeInjectionPackage.search.filteredCount = 6;
  primeInjectionPackage.search.resultCount = 6;
  result.searchMeta.filteredCount = 6;
  result.searchMeta.resultCount = 6;
  return result;
}

function p23ResidentVectorSelectedRecipesResult(): ResidentSearchResult {
  return {
    items: [],
    meta: {
      attempted: true,
      available: true,
      actualMode: 'semantic',
      durationMs: 12,
      requestedMode: 'semantic',
      residentVector: { available: true, reason: null },
      resultCount: 6,
      route: 'alembic-resident-service',
      semanticUsed: true,
      used: true,
      vectorUsed: true,
      primeInjectionPackage: {
        ...deliveredPrimeInjectionPackage(),
        injection: {
          degradedReasons: ['knowledge:stale', 'document:partial'],
          omittedCount: 6,
          selectedCount: 6,
          status: 'degraded',
        },
        omitted: [
          { itemId: 'recipe-weak-1', reason: 'missing-semantic-region-evidence' },
          { itemId: 'recipe-weak-2', reason: 'missing-semantic-region-evidence' },
          { itemId: 'recipe-weak-3', reason: 'missing-semantic-region-evidence' },
          { itemId: 'recipe-weak-4', reason: 'missing-semantic-region-evidence' },
          { itemId: 'recipe-weak-5', reason: 'missing-semantic-region-evidence' },
          { itemId: 'recipe-weak-6', reason: 'missing-semantic-region-evidence' },
        ],
        residentRegionRetrieval: {
          attempted: true,
          degradedReasons: ['knowledge:stale', 'document:partial'],
          metadataOnlyFallback: { attempted: false, used: false },
          queryCount: 6,
          regionHitCount: 18,
          route: 'resident-vector-recipe-semantic-region',
          selectedRecipes: [
            {
              itemId: 'recipe-selected-only',
              matchedRegionClasses: ['applicability', 'implementationSteps'],
              matchedRegions: [
                {
                  recipeId: 'recipe-selected-only',
                  regionClass: 'applicability',
                  score: 0.94,
                  snippet:
                    'Use this Recipe when resident region retrieval selected compact semantic evidence.',
                  sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:42'],
                  sourceRefsBridge: 'active',
                },
                {
                  recipeId: 'recipe-selected-only',
                  regionClass: 'implementationSteps',
                  score: 0.89,
                  snippet:
                    'Project accepted material from residentRegionRetrieval.selectedRecipes when selectedKnowledge is absent.',
                  sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:43'],
                  sourceRefsBridge: 'active',
                },
              ],
              score: 0.94,
              sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts:42'],
              title: 'Selected-only resident bridge',
              trigger: '@selected-only-resident-bridge',
            },
          ],
          used: true,
          vectorAvailable: true,
          wholeEntryOnlyRejectedCount: 0,
        },
        search: {
          actualMode: 'semantic',
          filteredCount: 6,
          query: 'resident vector selected material',
          queries: ['resident vector selected material'],
          requestedMode: 'semantic',
          resultCount: 6,
        },
        selectedKnowledge: [],
      },
    },
  };
}

describe('agent-facing active public tools', () => {
  test('registers all agent public tools with active schemas', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['alembic_prime', 'alembic_work', 'alembic_code_guard'])
    );

    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        capability: 'MCP runtime',
        integrationBoundary: 'Codex MCP tool',
        projectRoot: '/tmp/project',
        requirementGoal: 'Implement standalone prime gate',
        taskAction: 'implement',
      }).success
    ).toBe(true);
    const primeTool = TOOLS.find((tool) => tool.name === 'alembic_prime');
    const primeProperties = Object.keys(primeTool?.inputSchema?.properties ?? {});
    expect(primeProperties).toEqual(
      expect.arrayContaining(['taskAction', 'requirementGoal', 'capability'])
    );
    for (const legacyField of [
      'hostDeclaredIntent',
      'intentRef',
      'query',
      'recognizedIntent',
      'userQuery',
    ]) {
      expect(primeProperties).not.toContain(legacyField);
    }
    expect(primeTool?.inputSchema?.required).toEqual(
      expect.arrayContaining(['taskAction', 'requirementGoal'])
    );
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        intentRef: 'intent-1',
        projectRoot: '/tmp/project',
      }).success
    ).toBe(false);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        projectRoot: '/tmp/project',
        query: 'Implement standalone prime gate',
      }).success
    ).toBe(false);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        projectRoot: '/tmp/project',
        userQuery: 'where do I start',
      }).success
    ).toBe(false);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        projectRoot: '/tmp/project',
        requirementGoal: 'Implement standalone prime gate',
        taskAction: 'implement',
      }).success
    ).toBe(false);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        hostDeclaredIntent: {
          action: 'implement',
          query: 'Implement standalone prime gate',
        },
        projectRoot: '/tmp/project',
      }).success
    ).toBe(false);
    expect(
      TOOL_SCHEMAS.alembic_work.safeParse({
        phase: 'start',
        title: 'Implement active work public tool',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_work.safeParse({
        phase: 'finish',
        changedFiles: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
        workRef: 'work-public-1',
      }).success
    ).toBe(true);
    expect(TOOL_SCHEMAS.alembic_code_guard.safeParse({}).success).toBe(true);
    expect(TOOL_SCHEMAS.alembic_code_guard.safeParse({ workRef: 'work-public-1' }).success).toBe(
      true
    );
    const codeGuardTool = TOOLS.find((tool) => tool.name === 'alembic_code_guard');
    const codeGuardProperties = Object.keys(codeGuardTool?.inputSchema?.properties ?? {});
    expect(codeGuardProperties).toEqual(expect.arrayContaining(['code', 'files', 'workRef']));
    for (const unsupportedScopeField of [
      'diffRef',
      'primeRef',
      'acceptedGuards',
      'applicableRecipe',
    ]) {
      expect(codeGuardProperties).not.toContain(unsupportedScopeField);
    }
  });

  test('primes from a standalone code-development frame using PrimeSearchPipeline and Trust Receipt material', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP public tools',
      integrationBoundary: 'MCP tool handler',
      inputSource: 'host-declared-intent',
      keywords: ['prime', 'public tools'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: 'Implement public prime active tool',
      taskAction: 'implement',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        primeKnowledgeMaterial: {
          acceptedGuards: unknown[];
          acceptedKnowledge: unknown[];
          hostResponse: { requiredBeforeNextAction: boolean };
          retrievalConsumer: {
            decisionRegister: { acceptedDecisionRefs: string[]; auditExcludedCount: number };
            producerContract: { available: boolean; missingFields: string[] };
            retrievalQuality: { decisionRefCount: number; feedbackSignalCount: number };
          };
          status: string;
          trustPosture: { receiptChecklist: Array<{ layer: string; items: unknown[] }> };
        };
        primePackage: {
          compactPackage: {
            counts: { acceptedGuards: number; acceptedKnowledge: number; detailRefs: number };
            detailRefsMode: string;
            evidenceDelivery: string;
            primeInjectionPackage: {
              availability: string;
              missingProducerFields: string[];
              pluginSynthesized: boolean;
              producerBoundary: string;
            };
          };
          diagnostics: {
            outputBudget: { maxChars: number; truncated: boolean; usedChars: number };
            retrieval: { residentAvailable: boolean | null; searchAttempted: boolean };
          };
          primeRef: string;
          retrievalConsumer: {
            decisionRegister: { acceptedDecisionRefs: string[] };
            producerContract: { available: boolean };
          };
          runtimePolicy: {
            available: boolean;
            sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: boolean };
          };
          sourcePolicy: {
            rawAutomationEnvelopeUsedAsQuery: boolean;
            rawThreadIdsPersisted: boolean;
          };
          trustPosture: {
            noTrustedClaimRequired: boolean;
            receiptChecklist: Array<{ itemCount: number; layer: string }>;
          };
          trustReceipt: { receiptId: string; status: string };
        };
        result: { refs: { primeRef: { id: string }; detailRefs: unknown[] }; status: string };
      };
      success: boolean;
    };

    // GMAP-8: prime is decoupled from KnowledgeContext — the prime-native output
    // carries the positioning in primePackage (no tool/operation/result/matrix fields).
    expect(cleanPrime).toMatchObject({
      toolName: 'alembic_prime',
      status: 'ready',
      primePackage: {
        kind: 'PrimePublicPackage',
        compactPackage: {
          acceptedKnowledge: [expect.objectContaining({ id: 'recipe-public-prime' })],
        },
      },
    });
    expect(arrayValue(cleanPrime.detailRefs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'prime-knowledge:recipe-public-prime' }),
        expect.objectContaining({ id: 'prime-guard:guard-public-api' }),
      ])
    );
    expect(JSON.stringify(cleanPrime)).not.toContain('relationChainCount');
    expect(JSON.stringify(cleanPrime)).not.toContain('relationHopLimit');
    expect(JSON.stringify(cleanPrime)).not.toContain('prime-relation-chain-empty');
    expect(JSON.stringify(cleanPrime)).not.toContain('"domain":"recipeRelation"');
    expect(JSON.stringify(asRecord(asRecord(cleanPrime.primePackage).trustReceipt))).not.toContain(
      'As Codex'
    );
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      query: expect.stringContaining('Implement public prime active tool'),
      queries: [expect.stringContaining('Implement public prime active tool')],
    });
    expect(result.success).toBe(true);
    expect(result.data.result.status).toBe('ready');
    expect(result.data.result.refs.primeRef.id).toMatch(/^prime-public-/);
    expect(result.data.result.refs.detailRefs).not.toHaveLength(0);
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      hostResponse: { requiredBeforeNextAction: true },
      retrievalConsumer: {
        decisionRegister: {
          acceptedDecisionRefs: ['decision-active-1'],
          auditExcludedCount: 1,
        },
        producerContract: {
          available: true,
          missingFields: [],
        },
        retrievalQuality: {
          decisionRefCount: 1,
          feedbackSignalCount: 3,
        },
      },
    });
    expect(result.data.primePackage.retrievalConsumer).toMatchObject({
      decisionRegister: {
        acceptedDecisionRefs: ['decision-active-1'],
      },
      producerContract: {
        available: true,
      },
    });
    expect(result.data.primePackage).toMatchObject({
      kind: 'PrimePublicPackage',
      primeRef: result.data.result.refs.primeRef.id,
      sourcePolicy: {
        rawAutomationEnvelopeUsedAsQuery: false,
        rawThreadIdsPersisted: false,
      },
      runtimePolicy: {
        available: true,
        sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: false },
      },
      compactPackage: {
        counts: {
          acceptedGuards: 1,
          acceptedKnowledge: 1,
          detailRefs: result.data.result.refs.detailRefs.length,
        },
        detailRefsMode: 'ref-based',
        evidenceDelivery: 'detailRefs-and-primeKnowledgeMaterial',
        primeInjectionPackage: {
          availability: 'resident-provided',
          missingProducerFields: [],
          pluginSynthesized: false,
        },
      },
      diagnostics: {
        outputBudget: { maxChars: 1600, truncated: false },
        retrieval: { residentAvailable: true, searchAttempted: true },
      },
      trustPosture: {
        noTrustedClaimRequired: false,
        receiptChecklist: expect.arrayContaining([
          expect.objectContaining({ layer: 'trusted-to-obey', itemCount: 1 }),
          expect.objectContaining({ layer: 'trusted-to-use', itemCount: 1 }),
        ]),
      },
    });
    expect(
      result.data.primePackage.compactPackage.primeInjectionPackage.producerBoundary
    ).toContain('AlembicPlugin only passes through');
    expect(result.data.primePackage.compactPackage.acceptedKnowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'recipe-public-prime',
          matchedRegionClasses: expect.arrayContaining(['applicability']),
          usefulSlices: expect.arrayContaining([
            expect.objectContaining({ regionClass: 'applicability' }),
          ]),
        }),
      ])
    );
    expect(result.data.primeKnowledgeMaterial.acceptedKnowledge).toHaveLength(1);
    expect(result.data.primeKnowledgeMaterial.acceptedGuards).toHaveLength(1);
    expect(result.data.primeKnowledgeMaterial.trustPosture.receiptChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'trusted-to-obey' }),
        expect.objectContaining({ layer: 'trusted-to-use' }),
        expect.objectContaining({ layer: 'requires-verification' }),
      ])
    );
    expect(result.data.primePackage.trustReceipt.receiptId).toMatch(/^prime-/);
  });

  test('reports selected-only accepted resident material as ready public prime output', async () => {
    const search = vi.fn(async () => selectedOnlySearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP runtime',
      integrationBoundary: 'MCP prime handler',
      inputSource: 'host-declared-intent',
      keywords: ['resident', 'semantic-region'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: 'Implement selected-only resident trust bridge',
      taskAction: 'implement',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        primeKnowledgeMaterial: { status: string };
        primePackage: {
          compactPackage: {
            acceptedKnowledge: Array<{ id: string; trustEvidence?: unknown }>;
            counts: { acceptedKnowledge: number };
          };
          reason?: { code?: string };
          status: string;
          trustPosture: { noTrustedClaimRequired: boolean };
          trustReceipt: { status: string };
        };
        result: { reason?: { code?: string }; status: string; summary: string };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      status: 'ready',
      summary: expect.stringContaining('1 accepted Recipe/pattern item'),
    });
    expect(result.data.result.reason?.code).not.toBe('knowledge-empty');
    expect(result.data.primePackage).toMatchObject({
      status: 'ready',
      compactPackage: {
        counts: { acceptedKnowledge: 1 },
        acceptedKnowledge: [
          expect.objectContaining({
            id: 'recipe-selected-only',
            trustEvidence: expect.objectContaining({ kind: 'recipe-semantic-region' }),
          }),
        ],
      },
      trustPosture: { noTrustedClaimRequired: false },
      trustReceipt: { status: 'delivered' },
    });
    expect(result.data.primePackage.reason?.code).not.toBe('knowledge-empty');
    expect(result.data.primeKnowledgeMaterial.status).toBe('delivered');
    expect(arrayValue(cleanPrime.detailRefs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'prime-knowledge:recipe-selected-only' }),
      ])
    );
    expect(JSON.stringify(cleanPrime)).not.toContain('FULL_RECIPE_BODY_MARKER_SHOULD_NOT_LEAK');
    expect(JSON.stringify(cleanPrime)).not.toContain('relationChainCount');
    expect(JSON.stringify(cleanPrime)).not.toContain('relationHopLimit');
  });

  test('projects real resident selected material from a partially degraded package as acceptedKnowledge', async () => {
    const search = vi.fn(async () => realResidentDegradedSelectedSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP runtime',
      integrationBoundary: 'MCP prime handler',
      inputSource: 'host-declared-intent',
      keywords: ['resident', 'semantic-region', 'acceptedKnowledge'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: 'Fix prime output selected material projection',
      taskAction: 'fix',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        primeKnowledgeMaterial: { acceptedKnowledge: unknown[]; status: string };
        primePackage: {
          compactPackage: {
            acceptedKnowledge: Array<{ id: string; matchedRegionClasses?: string[] }>;
            counts: { acceptedKnowledge: number };
          };
          status: string;
          trustPosture: { noTrustedClaimRequired: boolean };
          trustReceipt: { status: string };
        };
        result: { reason?: { code?: string }; status: string };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({ status: 'ready' });
    expect(result.data.result.reason?.code).not.toBe('knowledge-empty');
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        expect.objectContaining({
          id: 'recipe-selected-only',
          matchedRegionClasses: expect.arrayContaining(['applicability']),
          trustEvidence: expect.objectContaining({ kind: 'recipe-semantic-region' }),
          usefulSlices: expect.arrayContaining([
            expect.objectContaining({ regionClass: 'applicability' }),
          ]),
        }),
      ],
    });
    expect(result.data.primePackage).toMatchObject({
      compactPackage: {
        counts: { acceptedKnowledge: 1 },
        acceptedKnowledge: [
          expect.objectContaining({
            id: 'recipe-selected-only',
            matchedRegionClasses: expect.arrayContaining(['applicability']),
          }),
        ],
      },
      status: 'ready',
      trustPosture: { noTrustedClaimRequired: false },
      trustReceipt: { status: 'delivered' },
    });
    expect(arrayValue(cleanPrime.detailRefs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'prime-knowledge:recipe-selected-only' }),
      ])
    );
    expect(JSON.stringify(cleanPrime)).not.toContain('FULL_RECIPE_BODY_MARKER_SHOULD_NOT_LEAK');
    expect(JSON.stringify(cleanPrime)).not.toContain('recipeRelation');
    expect(JSON.stringify(cleanPrime)).not.toContain('relationHops');
  });

  test('projects p21 resident vector selectedRecipes as acceptedKnowledge when selectedKnowledge is absent', async () => {
    const search = vi.fn(async () => p21VectorSelectedRecipesSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP runtime',
      domainObjects: ['Recipe', 'residentRegionRetrieval', 'selectedRecipes'],
      inputSource: 'host-declared-intent',
      integrationBoundary: 'MCP prime handler',
      keywords: ['resident', 'vector', 'semantic-region', 'acceptedKnowledge'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      qualityConcerns: ['trust gating', 'public output projection'],
      requirementGoal:
        'Fix resident vector selectedRecipes so semantic-region Recipe evidence becomes acceptedKnowledge',
      scenario: 'APQ6 p21 positive code-development probe',
      taskAction: 'fix',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        primeKnowledgeMaterial: { acceptedKnowledge: unknown[]; status: string };
        primePackage: {
          compactPackage: {
            acceptedKnowledge: Array<{ id: string; matchedRegionClasses?: string[] }>;
            counts: { acceptedKnowledge: number };
            primeInjectionPackage: { selectedCount: number | null; status: string | null };
          };
          status: string;
          trustPosture: { noTrustedClaimRequired: boolean };
          trustReceipt: { status: string };
        };
        result: { reason?: { code?: string }; status: string };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({ status: 'ready' });
    expect(result.data.result.reason?.code).not.toBe('knowledge-empty');
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        expect.objectContaining({
          id: 'recipe-selected-only',
          matchedRegionClasses: expect.arrayContaining(['applicability', 'implementationSteps']),
          trustEvidence: expect.objectContaining({ kind: 'recipe-semantic-region' }),
          usefulSlices: expect.arrayContaining([
            expect.objectContaining({ regionClass: 'applicability' }),
            expect.objectContaining({ regionClass: 'implementationSteps' }),
          ]),
        }),
      ],
    });
    expect(result.data.primePackage).toMatchObject({
      compactPackage: {
        counts: { acceptedKnowledge: 1 },
        acceptedKnowledge: [
          expect.objectContaining({
            id: 'recipe-selected-only',
            matchedRegionClasses: expect.arrayContaining(['applicability', 'implementationSteps']),
          }),
        ],
        primeInjectionPackage: {
          selectedCount: 6,
          status: 'degraded',
        },
      },
      status: 'ready',
      trustPosture: { noTrustedClaimRequired: false },
      trustReceipt: { status: 'delivered' },
    });
    expect(arrayValue(cleanPrime.detailRefs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'prime-knowledge:recipe-selected-only' }),
      ])
    );
    expect(JSON.stringify(cleanPrime)).not.toContain('FULL_RECIPE_BODY_MARKER_SHOULD_NOT_LEAK');
    expect(JSON.stringify(cleanPrime)).not.toContain('recipeRelation');
    expect(JSON.stringify(cleanPrime)).not.toContain('relationHops');
  });

  test('direct method chain does not synthesize removed resident selectedRecipes evidence', async () => {
    const engine = {
      search: vi.fn(async () => ({ items: [] })),
    };
    const pipeline = new PrimeSearchPipeline(engine);
    const search = vi.fn((intent: unknown, options?: unknown) =>
      pipeline.search(
        intent as Parameters<PrimeSearchPipeline['search']>[0],
        options as Parameters<PrimeSearchPipeline['search']>[1]
      )
    );
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP runtime',
      domainObjects: ['Recipe', 'residentRegionRetrieval', 'selectedRecipes'],
      inputSource: 'host-declared-intent',
      integrationBoundary: 'MCP prime handler',
      keywords: ['resident', 'vector', 'semantic-region', 'acceptedKnowledge'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      qualityConcerns: ['trust gating', 'public output projection'],
      requirementGoal:
        'Fix resident vector selected material projection so semantic-region Recipe evidence becomes acceptedKnowledge',
      scenario: 'APQ6 p24 direct non-MCP method-chain probe',
      taskAction: 'fix',
    });
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        primeKnowledgeMaterial: { acceptedKnowledge: unknown[]; status: string };
        primePackage: {
          compactPackage: {
            acceptedKnowledge: unknown[];
            counts: { acceptedKnowledge: number };
          };
          status: string;
          trustPosture: { noTrustedClaimRequired: boolean };
          trustReceipt: { status: string };
        };
        result: { reason?: { code?: string }; status: string };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      query: expect.stringContaining('resident vector selected material projection'),
      queries: [expect.stringContaining('resident vector selected material projection')],
    });
    expect(result.success).toBe(true);
    expect(engine.search).toHaveBeenCalledWith(expect.any(String), {
      limit: 8,
      mode: 'auto',
      rank: false,
    });
    expect(result.data.result).toMatchObject({
      reason: { code: 'knowledge-empty' },
      status: 'degraded',
    });
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'empty',
      acceptedKnowledge: [],
    });
    expect(result.data.primePackage).toMatchObject({
      compactPackage: {
        acceptedKnowledge: [],
        counts: { acceptedKnowledge: 0 },
      },
      status: 'degraded',
      trustPosture: { noTrustedClaimRequired: true },
      trustReceipt: { status: 'empty' },
    });
    expect(JSON.stringify(primeOutput)).not.toContain('FULL_RECIPE_BODY_MARKER_SHOULD_NOT_LEAK');
    expect(JSON.stringify(primeOutput)).not.toContain('recipeRelation');
    expect(JSON.stringify(primeOutput)).not.toContain('relationHops');
  });

  test('does not skip a complete standalone code frame when the requirement mentions status output', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP runtime',
      integrationBoundary: 'MCP prime handler',
      inputSource: 'host-declared-intent',
      keywords: ['resident', 'trust bridge'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: 'Implement prime status receipt projection for resident selected material',
      taskAction: 'implement',
    });
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        primeKnowledgeMaterial: { status: string };
        result: { reason?: { code: string }; status: string };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      query: expect.stringContaining('Implement prime status receipt projection'),
      queries: [expect.stringContaining('Implement prime status receipt projection')],
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        result: { status: 'ready' },
        primeKnowledgeMaterial: { status: 'delivered' },
      },
    });
    expect(result.data.result.reason?.code).not.toBe('status-only-turn');
  });

  test('does not report vector evidence unavailable when local region evidence was accepted', async () => {
    const search = vi.fn(async () => null);
    const vectorService = {
      hybridSearch: vi.fn(async () => [
        {
          content: 'Use local semantic-region evidence to prime public tool guidance.',
          id: 'recipe-region-diagnostics#applicability',
          recipeId: 'recipe-region-diagnostics',
          regionClass: 'applicability',
          score: 0.93,
          vectorUsed: true,
        },
      ]),
    };
    const ctx = makeContext(search, { vectorService });

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP public tools',
      integrationBoundary: 'MCP prime handler',
      inputSource: 'host-declared-intent',
      keywords: ['prime', 'diagnostics'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: 'Use semantic-region evidence for alembic_prime diagnostics',
      taskAction: 'implement',
    });
    const cleanPrime = asRecord(primeOutput);
    const diagnosticCodes = arrayValue(cleanPrime.diagnostics)
      .map(asRecord)
      .map((diagnostic) => diagnostic.code);
    const compactPackage = asRecord(asRecord(cleanPrime.primePackage).compactPackage);

    expect(cleanPrime.status).toBe('ready');
    expect(vectorService.hybridSearch).toHaveBeenCalledWith(
      expect.stringContaining('semantic-region evidence'),
      expect.objectContaining({
        filter: expect.objectContaining({ type: 'recipe-semantic-region' }),
        topK: 10,
      })
    );
    expect(diagnosticCodes).not.toContain('prime-vector-evidence-unavailable');
    expect(compactPackage.acceptedKnowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'recipe-region-diagnostics',
          matchedRegionClasses: expect.arrayContaining(['applicability']),
        }),
      ])
    );
  });

  test('bounds public project context recommended queries for long standalone prime frames', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);
    const longGoal = [
      'Implement a realistic host-facing prime projection repair that keeps taskAction and requirementGoal standalone',
      'while preserving APQ schema guarantees, active locator facets, compact trusted Recipe guidance,',
      'resident semantic-region evidence, public package diagnostics, Chinese and English code-development wording,',
      'and no relation-chain fields in the primary output for Codex MCP installed runtime validation.',
    ].join(' ');

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'Codex MCP public tools',
      integrationBoundary: 'MCP tool handler',
      inputSource: 'host-declared-intent',
      keywords: ['prime', 'projection', 'schema', 'diagnostics'],
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: longGoal,
      taskAction: 'implement',
    });
    const cleanPrime = asRecord(primeOutput);
    const primePackage = asRecord(cleanPrime.primePackage);
    const projectContextGuidance = asRecord(primePackage.projectContextGuidance);
    const recommendedQueries = arrayValue(projectContextGuidance.recommendedQueries).map(asRecord);

    expect(cleanPrime.ok).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(recommendedQueries[0]?.query).toEqual(expect.any(String));
    expect(String(recommendedQueries[0]?.query).length).toBeLessThanOrEqual(240);
  });

  test.each([
    {
      requirementGoal: 'Where is the Dashboard module location?',
      capability: 'project navigation',
      scenario: 'module location lookup',
    },
    {
      requirementGoal: 'What is Alembic?',
      capability: 'general knowledge',
      scenario: 'concept overview',
    },
    {
      requirementGoal: 'Plan APQ rollout options without code changes',
      capability: 'design planning',
      scenario: 'read-only planning discussion',
    },
  ])('skips non-code prime frame before retrieval: $requirementGoal', async (primeArgs) => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        integrationBoundary: 'workspace orientation',
        inputSource: 'host-declared-intent',
        projectRoot: '/tmp/alembic-plugin-public-tools',
        taskAction: 'implement',
        ...primeArgs,
      })
    ) as {
      data: { result: { reason: { code: string }; status: string } };
      success: boolean;
    };

    expect(search).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      reason: { code: 'not-relevant-to-project-knowledge' },
      status: 'skipped',
    });
  });

  test.each([
    {
      expectedReason: 'not-relevant-to-project-knowledge',
      intentKind: 'read-only-analysis' as const,
      requirementGoal: 'Find where the prime output projection handler lives before editing',
    },
    {
      expectedReason: 'status-only-turn',
      intentKind: 'status-only' as const,
      requirementGoal: 'Report current APQ prime projection status for the runtime handler',
    },
  ])('skips explicit non-code prime frame before retrieval even with locator facets: $intentKind', async ({
    expectedReason,
    intentKind,
    requirementGoal,
  }) => {
    const search = vi.fn(async () => realResidentDegradedSelectedSearchResult());
    const ctx = makeContext(search);

    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        capability: 'Codex MCP runtime',
        inputSource: 'host-declared-intent',
        integrationBoundary: 'MCP prime handler',
        intentKind,
        keywords: ['prime', 'handler', 'projection'],
        projectRoot: '/tmp/alembic-plugin-public-tools',
        requirementGoal,
        taskAction: 'fix',
      })
    ) as {
      data: { result: { reason: { code: string }; status: string } };
      success: boolean;
    };

    expect(search).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      reason: { code: expectedReason },
      status: 'skipped',
    });
  });

  test('blocks obsolete prime intent inputs before retrieval', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const intentRefOnly = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        inputSource: 'host-declared-intent',
        intentRef: 'intent-obsolete',
        projectRoot: '/tmp/alembic-plugin-public-tools',
      })
    ) as {
      data: { result: { reason: { code: string; message: string }; status: string } };
      success: boolean;
    };

    const recognizedOnly = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        inputSource: 'host-declared-intent',
        projectRoot: '/tmp/alembic-plugin-public-tools',
        recognizedIntent: { action: 'implement', query: 'Implement public prime active tool' },
      })
    ) as {
      data: { result: { reason: { code: string; message: string }; status: string } };
      success: boolean;
    };

    expect(intentRefOnly.success).toBe(false);
    expect(intentRefOnly.data.result).toMatchObject({
      reason: {
        code: 'obsolete-prime-intent-input',
        message: expect.stringContaining('taskAction'),
      },
      status: 'blocked',
    });
    expect(recognizedOnly.success).toBe(false);
    expect(recognizedOnly.data.result).toMatchObject({
      reason: { code: 'obsolete-prime-intent-input' },
      status: 'blocked',
    });
    expect(search).not.toHaveBeenCalled();
  });

  test('skips low-information prime input before retrieval', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      inputSource: 'host-declared-intent',
      projectRoot: '/tmp/alembic-plugin-public-tools',
      userQuery: 'where do I start',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        items: unknown[];
        primeKnowledgeMaterial: {
          acceptedGuards: unknown[];
          acceptedKnowledge: unknown[];
          status: string;
          trustPosture: { receiptChecklist: Array<{ layer: string; items: unknown[] }> };
        };
        primePackage: {
          trustPosture: { noTrustedClaimRequired: boolean };
          trustReceipt: { status: string };
        };
        result: { reason: { code: string; message: string }; status: string };
      };
      success: boolean;
    };

    expect(search).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      reason: {
        code: 'not-relevant-to-project-knowledge',
        message: expect.stringContaining('Prime skipped'),
      },
      status: 'skipped',
    });
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      acceptedGuards: [],
      acceptedKnowledge: [],
      status: 'degraded',
    });
    expect(result.data.primePackage).toMatchObject({
      trustPosture: { noTrustedClaimRequired: true },
      trustReceipt: { status: 'degraded' },
    });
    expect(arrayValue(cleanPrime.items)).toEqual([]);
    expect(JSON.stringify(cleanPrime)).not.toContain('"trustLayer":"trusted-to-use"');
  });

  test('skips low-information standalone prime frames before retrieval', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      inputSource: 'host-declared-intent',
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: 'Help',
      scenario: 'What now?',
      sourceRefs: ['lib/service/task/PrimeKnowledgeMaterial.ts'],
      taskAction: 'fix',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        items: unknown[];
        primeKnowledgeMaterial: {
          acceptedGuards: unknown[];
          acceptedKnowledge: unknown[];
          status: string;
        };
        result: { reason: { code: string; message: string }; status: string };
      };
      success: boolean;
    };

    expect(search).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      reason: {
        code: 'not-relevant-to-project-knowledge',
        message: expect.stringContaining('Prime skipped'),
      },
      status: 'skipped',
    });
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      acceptedGuards: [],
      acceptedKnowledge: [],
      status: 'empty',
    });
    expect(arrayValue(cleanPrime.items)).toEqual([]);
    expect(JSON.stringify(cleanPrime)).not.toContain('"trustLayer":"trusted-to-use"');
  });

  test('skips raw delegation standalone prime frames before retrieval', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);

    const primeOutput = await primeHandler(ctx, {
      agentHost: 'codex',
      capability: 'dispatch envelope',
      inputSource: 'host-declared-intent',
      projectRoot: '/tmp/alembic-plugin-public-tools',
      requirementGoal: '<codex_delegation><input>continue task</input></codex_delegation>',
      scenario: '<codex_delegation><input>continue task</input></codex_delegation>',
      taskAction: 'implement',
    });
    const cleanPrime = asRecord(primeOutput);
    const result = publicToolLegacyTestView(primeOutput) as {
      data: {
        items: unknown[];
        primeKnowledgeMaterial: {
          acceptedGuards: unknown[];
          acceptedKnowledge: unknown[];
          status: string;
        };
        result: { reason: { code: string; message: string }; status: string };
      };
      success: boolean;
    };

    expect(search).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      reason: {
        code: 'mechanical-envelope-only',
        message: expect.stringContaining('Prime skipped'),
      },
      status: 'skipped',
    });
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      acceptedGuards: [],
      acceptedKnowledge: [],
      status: 'empty',
    });
    expect(arrayValue(cleanPrime.items)).toEqual([]);
    expect(JSON.stringify(cleanPrime)).not.toContain('"trustLayer":"trusted-to-use"');
  });

  test('degrades prime when resident search lacks Stage 1A retrieval metadata', async () => {
    const oldResidentResult = deliveredSearchResult();
    oldResidentResult.searchMeta.retrievalConsumer = {
      decisionRegister: {
        acceptedDecisionRefs: [],
        auditExcludedCount: 0,
        available: false,
        defaultLifecycle: 'active-effective-only',
        excludedStatuses: [],
        route: '/api/v1/decision-register/searchable',
      },
      feedback: {
        observeOnly: false,
        supportedSignals: [],
        version: 1,
      },
      producerContract: {
        available: false,
        missingFields: ['decisionRegister', 'feedback', 'retrievalQuality'],
        reasonCode: 'resident-search-stage1a-contract-missing',
        requiredFields: ['decisionRegister', 'feedback', 'retrievalQuality'],
        stage: 'AFAPI-FULL-STAGE1A',
      },
      relationEvidence: {
        count: 0,
        evidence: [],
        omitted: [],
      },
      retrievalQuality: {
        decisionRefCount: 0,
        feedbackSignalCount: 0,
        relationEvidenceCount: 0,
        sourceRefCoverage: 0,
        version: 1,
      },
      source: 'resident-search-meta',
      version: 1,
    };
    if (oldResidentResult.searchMeta.residentSearch) {
      oldResidentResult.searchMeta.residentSearch.retrievalConsumer =
        oldResidentResult.searchMeta.retrievalConsumer;
    }
    const search = vi.fn(async () => oldResidentResult);
    const ctx = makeContext(search);
    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        capability: 'Codex MCP public tools',
        integrationBoundary: 'MCP tool handler',
        inputSource: 'host-declared-intent',
        projectRoot: '/tmp/alembic-plugin-public-tools',
        requirementGoal: 'Implement public prime active tool',
        taskAction: 'implement',
      })
    ) as {
      data: {
        primeKnowledgeMaterial: {
          retrievalConsumer: { producerContract: { missingFields: string[] } };
        };
        primePackage: {
          compactPackage: {
            primeInjectionPackage: {
              availability: string;
              missingProducerFields: string[];
              pluginSynthesized: boolean;
            };
          };
          trustPosture: { noTrustedClaimRequired: boolean };
        };
        result: { reason: { code: string; kind: string; message: string }; status: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.result).toMatchObject({
      reason: {
        code: 'optional-service-unavailable',
        kind: 'degraded',
      },
      status: 'degraded',
    });
    expect(result.data.result.reason.message).toContain('Stage 1A retrieval metadata');
    expect(
      result.data.primeKnowledgeMaterial.retrievalConsumer.producerContract.missingFields
    ).toEqual(['decisionRegister', 'feedback', 'retrievalQuality']);
    expect(result.data.primePackage).toMatchObject({
      compactPackage: {
        primeInjectionPackage: {
          availability: 'producer-contract-missing',
          missingProducerFields: ['decisionRegister', 'feedback', 'retrievalQuality'],
          pluginSynthesized: false,
        },
      },
      trustPosture: { noTrustedClaimRequired: true },
    });
  });

  test('returns degraded prime when retrieval finds no Recipe or Guard knowledge', async () => {
    const ctx = makeContext(async () => null);
    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        capability: 'Codex MCP public tools',
        integrationBoundary: 'MCP tool handler',
        inputSource: 'host-declared-intent',
        projectRoot: '/tmp/alembic-plugin-public-tools',
        requirementGoal: 'Review public prime active tool before applying concrete code changes',
        sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage3.md'],
        taskAction: 'code-review',
      })
    ) as {
      data: {
        primeKnowledgeMaterial: { status: string };
        result: { reason: { code: string }; status: string };
      };
    };

    expect(result.data.result).toMatchObject({
      reason: { code: 'knowledge-empty' },
      status: 'degraded',
    });
    expect(result.data.primeKnowledgeMaterial.status).toBe('empty');
  });

  test('starts and finishes work with workRef, finishRef, detailRefs, and scoped guard recommendation', async () => {
    const ctx = makeContext();
    const start = publicToolLegacyTestView(
      await workStartHandler(ctx, {
        agentHost: 'codex',
        hostDeclaredIntent: {
          action: 'implement',
          confidence: 0.93,
          language: 'typescript',
          query: 'Implement Stage 4 active work tool',
        },
        inputSource: 'host-declared-intent',
        title: 'Implement Stage 4 active work tool',
        workScope: {
          files: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
          goal: 'Implement active work lifecycle',
        },
      })
    ) as {
      data: {
        result: {
          legacyCompatibility: { usesLegacyTaskHandler: boolean };
          refs: { detailRefs: unknown[]; workRef: { id: string } };
          status: string;
        };
        workRef: string;
      };
      success: boolean;
    };

    expect(start.success).toBe(true);
    expect(start.data.result.status).toBe('ready');
    expect(start.data.result.refs.workRef.id).toBe(start.data.workRef);
    expect(start.data.result.refs.detailRefs).not.toHaveLength(0);
    expect(start.data.result.legacyCompatibility.usesLegacyTaskHandler).toBe(false);

    const finish = publicToolLegacyTestView(
      await workFinishHandler(ctx, {
        changedFiles: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts'],
        inputSource: 'host-declared-intent',
        summary: 'Implemented Stage 4 active work tool.',
        workRef: start.data.workRef,
      })
    ) as {
      data: {
        finishRef: string;
        guardRecommendation: { action: string; input?: { files: string[] }; tool: string };
        result: {
          refs: { finishRef: { id: string }; workRef: { id: string } };
          status: string;
        };
      };
      success: boolean;
    };

    expect(finish.success).toBe(true);
    expect(finish.data.result.status).toBe('ready');
    expect(finish.data.result.refs.workRef.id).toBe(start.data.workRef);
    expect(finish.data.result.refs.finishRef.id).toBe(finish.data.finishRef);
    expect(finish.data.guardRecommendation).toMatchObject({
      action: 'run',
      tool: 'alembic_code_guard',
    });
    expect(finish.data.guardRecommendation.input?.files).toEqual(
      expect.arrayContaining(['lib/runtime/mcp/handlers/agent-public-tools.ts'])
    );
  });

  test('blocks code guard without explicit files or inline code', async () => {
    const ctx = makeContext();
    const result = publicToolLegacyTestView(
      await codeGuardHandler(ctx, {
        hostDeclaredIntent: {
          action: 'review',
          query: 'Run guard after work finish',
        },
        inputSource: 'host-declared-intent',
      })
    ) as {
      data: { result: { reason: { code: string }; status: string } };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.result).toMatchObject({
      reason: { code: 'missing-guard-scope' },
      status: 'blocked',
    });
  });

  test('blocks code guard when workRef scope is missing from the active session', async () => {
    const ctx = makeContext();
    const result = publicToolLegacyTestView(
      await codeGuardHandler(ctx, {
        inputSource: 'host-declared-intent',
        workRef: 'work-public-missing',
      })
    ) as {
      data: { result: { reason: { code: string }; status: string } };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.result).toMatchObject({
      reason: { code: 'missing-work-ref' },
      status: 'blocked',
    });
  });

  test('skips code guard when a workRef has no scoped source files', async () => {
    const ctx = makeContext();
    const start = publicToolLegacyTestView(
      await workStartHandler(ctx, {
        inputSource: 'host-declared-intent',
        title: 'Plan docs-only follow-up',
      })
    ) as {
      data: { workRef: string };
      success: boolean;
    };
    const result = publicToolLegacyTestView(
      await codeGuardHandler(ctx, {
        inputSource: 'host-declared-intent',
        workRef: start.data.workRef,
      })
    ) as {
      data: {
        explicitScope: { files: string[]; kind: string; workRef: string };
        result: { reason: { code: string; kind: string }; status: string };
      };
      success: boolean;
    };

    expect(start.success).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data.explicitScope).toEqual({
      files: [],
      kind: 'workRef',
      workRef: start.data.workRef,
    });
    expect(result.data.result).toMatchObject({
      reason: { code: 'no-code-scope', kind: 'skip' },
      status: 'skipped',
    });
  });

  test('runs code guard only for explicit inline code scope', async () => {
    const checkCode = vi.fn(() => []);
    const ctx = makeContext(undefined, {
      guardCheckEngine: {
        auditFile: vi.fn(),
        auditFiles: vi.fn(),
        checkCode,
        injectExternalRules: vi.fn(),
        isEpInjected: () => true,
      },
    });

    const result = publicToolLegacyTestView(
      await codeGuardHandler(ctx, {
        code: 'export const value = 1;',
        filePath: 'lib/example.ts',
        inputSource: 'host-declared-intent',
        language: 'typescript',
      })
    ) as {
      data: {
        explicitScope: { filePath: string | null; kind: string };
        guardResultRef: string;
        result: { refs: { guardResultRef: { id: string } }; status: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(checkCode).toHaveBeenCalledWith('export const value = 1;', 'typescript');
    expect(result.data.explicitScope).toEqual({ filePath: 'lib/example.ts', kind: 'code' });
    expect(result.data.result.refs.guardResultRef.id).toBe(result.data.guardResultRef);
  });

  test('runs code guard from scoped workRef files without falling back to whole diff', async () => {
    const auditFile = vi.fn(() => ({
      language: 'typescript',
      uncertainResults: [],
      violations: [],
    }));
    const ctx = makeContext(undefined, {
      guardCheckEngine: {
        auditFile,
        auditFiles: vi.fn(),
        checkCode: vi.fn(),
        injectExternalRules: vi.fn(),
        isEpInjected: () => true,
      },
    });
    ctx.container.singletons = { _projectRoot: process.cwd() };
    const start = publicToolLegacyTestView(
      await workStartHandler(ctx, {
        inputSource: 'host-declared-intent',
        title: 'Implement scoped guard contract',
        workScope: { files: ['lib/runtime/mcp/handlers/agent-public-tools.ts'] },
      })
    ) as {
      data: { workRef: string };
      success: boolean;
    };

    const result = publicToolLegacyTestView(
      await codeGuardHandler(ctx, {
        inputSource: 'host-declared-intent',
        workRef: start.data.workRef,
      })
    ) as {
      data: {
        explicitScope: { files: string[]; kind: string; workRef: string };
        guardResultRef: string;
        result: { refs: { guardResultRef: { id: string } }; status: string };
      };
      success: boolean;
    };

    expect(start.success).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data.explicitScope).toEqual({
      files: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
      kind: 'workRef',
      workRef: start.data.workRef,
    });
    expect(auditFile).toHaveBeenCalledWith(
      expect.stringContaining('lib/runtime/mcp/handlers/agent-public-tools.ts'),
      expect.any(String),
      { isTest: false }
    );
    expect(result.data.result.refs.guardResultRef.id).toBe(result.data.guardResultRef);
  });

  test('does not import or call the legacy task handler', () => {
    const source = readFileSync(
      new URL('../../lib/runtime/mcp/handlers/agent-public-tools.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('taskHandler');
    expect(source).not.toContain("from './task");
    expect(source).not.toContain('alembic_task');
    expect(source).not.toContain('routeGuardTool');
    expect(source).not.toContain('operation=prime');
  });
});

function durableDecisionCapability() {
  return {
    available: true,
    lifecycle: ['create', 'update', 'revoke', 'delete', 'read', 'list'],
    owner: 'alembic',
    route: 'decision-register',
  };
}

interface DecisionRecordResult {
  data: {
    count?: number;
    decisionRef?: string | null;
    decisions: Array<Record<string, unknown>>;
    result: {
      refs: {
        decisionRef?: { id: string; toolName: string };
        detailRefs: unknown[];
      };
      status: string;
    };
  };
  success: boolean;
}
