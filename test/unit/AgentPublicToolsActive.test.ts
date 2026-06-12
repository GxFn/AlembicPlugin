import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  codeGuardHandler,
  decisionRecordHandler,
  intentHandler,
  primeHandler,
  workFinishHandler,
  workStartHandler,
} from '../../lib/runtime/mcp/handlers/agent-public-tools.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { createIdleIntent } from '../../lib/runtime/mcp/handlers/types.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';
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
      intent: createIdleIntent(),
    },
  };
}

function publicToolLegacyTestView(output: unknown) {
  const clean = asRecord(output);
  expect(clean).not.toHaveProperty('success');
  expect(clean).not.toHaveProperty('data');
  expect(clean).not.toHaveProperty('errorCode');
  expect(clean).not.toHaveProperty('message');
  expect(clean).not.toHaveProperty('result');
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

function deliveredSearchResult(): PrimeSearchResult {
  return {
    guardRules: [
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
    ],
    relatedKnowledge: [
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
    ],
    searchMeta: {
      filteredCount: 2,
      language: 'typescript',
      module: 'codex/mcp',
      queries: ['Implement public prime active tool'],
      resultCount: 2,
      scenario: 'generate',
      retrievalConsumer: {
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
        relationEvidence: {
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
        },
        retrievalQuality: {
          decisionRefCount: 1,
          feedbackSignalCount: 3,
          relationEvidenceCount: 1,
          sourceRefCoverage: 1,
          version: 1,
        },
        source: 'resident-search-meta',
        version: 1,
      },
      residentSearch: {
        attempted: true,
        available: true,
        retrievalConsumer: {
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
          relationEvidence: {
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
          },
          retrievalQuality: {
            decisionRefCount: 1,
            feedbackSignalCount: 3,
            relationEvidenceCount: 1,
            sourceRefCoverage: 1,
            version: 1,
          },
          source: 'resident-search-meta',
          version: 1,
        },
        route: 'alembic-resident-service',
        semanticUsed: true,
        vectorUsed: true,
        residentVector: { available: true },
      },
    },
  };
}

describe('agent-facing active public tools', () => {
  test('registers all agent public tools with active schemas', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'alembic_intent',
        'alembic_prime',
        'alembic_work_start',
        'alembic_work_finish',
        'alembic_code_guard',
        'alembic_decision_record',
      ])
    );

    expect(
      TOOL_SCHEMAS.alembic_intent.safeParse({ userQuery: 'Implement public tools' }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        intentRef: 'intent-1',
        projectRoot: '/tmp/project',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_work_start.safeParse({
        title: 'Implement active work public tool',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_work_finish.safeParse({
        changedFiles: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
        workRef: 'work-public-1',
      }).success
    ).toBe(true);
    expect(TOOL_SCHEMAS.alembic_code_guard.safeParse({}).success).toBe(true);
    expect(TOOL_SCHEMAS.alembic_code_guard.safeParse({ workRef: 'work-public-1' }).success).toBe(
      true
    );
    expect(
      TOOL_SCHEMAS.alembic_decision_record.safeParse({
        action: 'list',
        includeDeleted: true,
        limit: 10,
        status: 'all',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_decision_record.safeParse({
        action: 'read',
        decisionRef: 'decision-public-1',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_decision_record.safeParse({
        title: 'Decision register route required',
      }).success
    ).toBe(true);
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

  test('captures a host-declared intent with intentRef, detailRefs, and vectorPlan', async () => {
    const ctx = makeContext();
    const result = publicToolLegacyTestView(
      await intentHandler(ctx, {
        agentHost: 'codex',
        hostDeclaredIntent: {
          action: 'implement',
          confidence: 0.91,
          language: 'typescript',
          query: 'Implement public prime active tool',
          sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage0.md'],
        },
        inputSource: 'host-declared-intent',
        language: 'typescript',
        sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage0.md'],
      })
    ) as {
      data: {
        detailRefs: Array<{ kind: string; uri?: string }>;
        diagnostics: {
          enumRequirementMapping: Array<{ field: string }>;
          normalized: { confidenceBand: string; persistenceKind: string; vectorUseKind: string };
          toolNeeds: { guardNeed: string; primeNeed: string; workNeed: string };
        };
        intentRef: string;
        persistence: { consumable: boolean; kind: string; localRecordCreated: boolean };
        recipeRetrievalHint: { profiles: string[]; route: string; vectorUseKind: string };
        recognizedIntent: { query: string; status: string };
        result: { legacyCompatibility: { usesLegacyTaskHandler: boolean }; status: string };
        sourcePolicy: {
          localIntentRecord: { consumable: boolean; created: boolean; persistenceKind: string };
        };
        vectorPlan: { route: string; queries: string[] };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.result.status).toBe('ready');
    expect(result.data.intentRef).toMatch(/^intent-/);
    expect(result.data.recognizedIntent).toMatchObject({
      query: 'Implement public prime active tool',
      status: 'recognized',
    });
    expect(result.data.detailRefs.map((ref) => ref.kind)).toEqual(
      expect.arrayContaining(['contract', 'file', 'schema', 'source-ref'])
    );
    expect(result.data.vectorPlan).toMatchObject({
      route: 'structure-first-recipe-retrieval',
      vectorUseKind: 'hybrid-rerank',
    });
    expect(result.data.persistence).toMatchObject({
      consumable: true,
      kind: 'session-local',
      localRecordCreated: true,
    });
    expect(result.data.sourcePolicy.localIntentRecord).toMatchObject({
      consumable: true,
      created: true,
      persistenceKind: 'session-local',
    });
    expect(result.data.recipeRetrievalHint).toMatchObject({
      route: 'structure-first',
      vectorUseKind: 'hybrid-rerank',
    });
    expect(result.data.recipeRetrievalHint.profiles).toEqual(
      expect.arrayContaining(['structured-recipe', 'implementation-pattern'])
    );
    expect(result.data.diagnostics.normalized).toMatchObject({
      confidenceBand: 'high',
      persistenceKind: 'session-local',
      vectorUseKind: 'hybrid-rerank',
    });
    expect(result.data.diagnostics.toolNeeds).toMatchObject({
      guardNeed: 'explicit-scope-required',
      primeNeed: 'recommended',
      workNeed: 'start-required',
    });
    expect(result.data.diagnostics.enumRequirementMapping.map((entry) => entry.field)).toEqual([
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
    ]);
    expect(result.data.result.legacyCompatibility.usesLegacyTaskHandler).toBe(false);
  });

  test('keeps degraded semantic intent consumable while making non-semantic intent ephemeral', async () => {
    const ctx = makeContext();
    const degradedSemantic = publicToolLegacyTestView(
      await intentHandler(ctx, {
        agentHost: 'codex',
        hostDeclaredIntent: {
          action: 'review',
          confidence: 0.35,
          query: 'Review structured local vector contract convergence',
        },
        inputSource: 'host-declared-intent',
      })
    ) as {
      data: {
        intentRef: string;
        localRecord: { intentRef: string; status: string };
        persistence: { consumable: boolean; localRecordCreated: boolean };
        result: { reason: { code: string }; status: string };
      };
      success: boolean;
    };

    expect(degradedSemantic.success).toBe(true);
    expect(degradedSemantic.data.result).toMatchObject({
      reason: { code: 'low-confidence-intent' },
      status: 'degraded',
    });
    expect(degradedSemantic.data.intentRef).toMatch(/^intent-/);
    expect(degradedSemantic.data.localRecord).toMatchObject({
      intentRef: degradedSemantic.data.intentRef,
      status: 'degraded',
    });
    expect(degradedSemantic.data.persistence).toMatchObject({
      consumable: true,
      localRecordCreated: true,
    });

    const statusOnly = publicToolLegacyTestView(
      await intentHandler(ctx, {
        inputSource: 'user-message',
        intentKind: 'status-only',
        userQuery: 'Show current AFAPI status',
      })
    ) as {
      data: {
        intentRef?: string;
        localRecord?: unknown;
        persistence: { consumable: boolean; kind: string; localRecordCreated: boolean };
        result: {
          reason: { code: string };
          refs: { intentRef?: unknown };
          status: string;
        };
        sourcePolicy: {
          localIntentRecord: { consumable: boolean; created: boolean; persistenceKind: string };
        };
        vectorPlan: { vectorUseKind: string };
      };
    };

    expect(statusOnly.data.result).toMatchObject({
      reason: { code: 'status-only-turn' },
      status: 'skipped',
    });
    expect(statusOnly.data.result.refs.intentRef).toBeUndefined();
    expect(statusOnly.data.intentRef).toBeUndefined();
    expect(statusOnly.data.localRecord).toBeUndefined();
    expect(statusOnly.data.persistence).toMatchObject({
      consumable: false,
      kind: 'ephemeral',
      localRecordCreated: false,
    });
    expect(statusOnly.data.sourcePolicy.localIntentRecord).toMatchObject({
      consumable: false,
      created: false,
      persistenceKind: 'ephemeral',
    });
    expect(statusOnly.data.vectorPlan.vectorUseKind).toBe('none');

    const noSemantic = publicToolLegacyTestView(
      await intentHandler(ctx, {
        inputSource: 'user-message',
      })
    ) as {
      data: {
        intentRef?: string;
        localRecord?: unknown;
        persistence: { consumable: boolean; localRecordCreated: boolean };
        result: { reason: { code: string }; refs: { intentRef?: unknown }; status: string };
      };
    };

    expect(noSemantic.data.result).toMatchObject({
      reason: { code: 'no-semantic-intent' },
      status: 'skipped',
    });
    expect(noSemantic.data.result.refs.intentRef).toBeUndefined();
    expect(noSemantic.data.intentRef).toBeUndefined();
    expect(noSemantic.data.localRecord).toBeUndefined();
    expect(noSemantic.data.persistence).toMatchObject({
      consumable: false,
      localRecordCreated: false,
    });
  });

  test('primes from an intentRef using PrimeSearchPipeline and Trust Receipt material', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);
    const intent = publicToolLegacyTestView(
      await intentHandler(ctx, {
        agentHost: 'codex',
        hostDeclaredIntent: {
          action: 'implement',
          confidence: 0.9,
          language: 'typescript',
          query: 'Implement public prime active tool',
        },
        inputSource: 'host-declared-intent',
      })
    ) as { data: { intentRef: string } };

    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        inputSource: 'host-declared-intent',
        intentRef: intent.data.intentRef,
        projectRoot: '/tmp/alembic-plugin-public-tools',
      })
    ) as {
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
        result: {
          refs: { intentRef: { id: string }; primeRef: { id: string }; detailRefs: unknown[] };
          status: string;
        };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data.result.status).toBe('ready');
    expect(result.data.result.refs.intentRef.id).toBe(intent.data.intentRef);
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
          availability: 'not-produced',
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
    const intent = publicToolLegacyTestView(
      await intentHandler(ctx, {
        agentHost: 'codex',
        hostDeclaredIntent: {
          action: 'implement',
          confidence: 0.9,
          language: 'typescript',
          query: 'Implement public prime active tool',
        },
        inputSource: 'host-declared-intent',
      })
    ) as { data: { intentRef: string } };

    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        agentHost: 'codex',
        inputSource: 'host-declared-intent',
        intentRef: intent.data.intentRef,
        projectRoot: '/tmp/alembic-plugin-public-tools',
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

  test('skips raw automation intent and blocks automation prime without sourceRefs', async () => {
    const ctx = makeContext(async () => deliveredSearchResult());
    const intent = publicToolLegacyTestView(
      await intentHandler(ctx, {
        inputSource: 'automation-envelope',
        userQuery: '<codex_delegation><input>继续当前窗口任务</input></codex_delegation>',
      })
    ) as {
      data: {
        intentRef?: string;
        localRecord?: unknown;
        persistence: { consumable: boolean; kind: string; localRecordCreated: boolean };
        result: { reason: { code: string }; refs: { intentRef?: unknown }; status: string };
        sourcePolicy: {
          localIntentRecord: { consumable: boolean; created: boolean; persistenceKind: string };
        };
        vectorPlan: { vectorUseKind: string };
      };
    };

    expect(intent.data.result).toMatchObject({
      reason: { code: 'mechanical-envelope-only' },
      status: 'skipped',
    });
    expect(intent.data.result.refs.intentRef).toBeUndefined();
    expect(intent.data.intentRef).toBeUndefined();
    expect(intent.data.localRecord).toBeUndefined();
    expect(intent.data.persistence).toMatchObject({
      consumable: false,
      kind: 'ephemeral',
      localRecordCreated: false,
    });
    expect(intent.data.sourcePolicy.localIntentRecord).toMatchObject({
      consumable: false,
      created: false,
      persistenceKind: 'ephemeral',
    });
    expect(intent.data.vectorPlan.vectorUseKind).toBe('none');

    const blockedPrime = publicToolLegacyTestView(
      await primeHandler(ctx, {
        hostDeclaredIntent: {
          action: 'implement',
          query: 'Implement public prime active tool',
        },
        inputSource: 'automation-envelope',
        projectRoot: '/tmp/alembic-plugin-public-tools',
      })
    ) as {
      data: {
        primePackage: {
          primeRef: string;
          sourcePolicy: {
            automationEnvelope: {
              blockedWithoutSourceRefs: boolean;
              requiredSourceRefsForPrime: boolean;
              sourceRefsCount: number;
            };
            rawAutomationEnvelopeUsedAsQuery: boolean;
          };
          trustPosture: { noTrustedClaimRequired: boolean };
        };
        result: {
          reason: { code: string };
          refs: { primeRef: { id: string } };
          status: string;
        };
      };
      success: boolean;
    };

    expect(blockedPrime.success).toBe(false);
    expect(blockedPrime.data.result).toMatchObject({
      reason: { code: 'missing-referenced-docs' },
      status: 'blocked',
    });
    expect(blockedPrime.data.primePackage).toMatchObject({
      primeRef: blockedPrime.data.result.refs.primeRef.id,
      sourcePolicy: {
        automationEnvelope: {
          blockedWithoutSourceRefs: true,
          requiredSourceRefsForPrime: true,
          sourceRefsCount: 0,
        },
        rawAutomationEnvelopeUsedAsQuery: false,
      },
      trustPosture: { noTrustedClaimRequired: true },
    });
  });

  test('returns degraded prime when retrieval finds no Recipe or Guard knowledge', async () => {
    const ctx = makeContext(async () => null);
    const result = publicToolLegacyTestView(
      await primeHandler(ctx, {
        hostDeclaredIntent: {
          action: 'review',
          query: 'Review public prime active tool',
        },
        inputSource: 'host-declared-intent',
        projectRoot: '/tmp/alembic-plugin-public-tools',
        sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage3.md'],
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

  test('records a decision through the resident Decision Register route', async () => {
    const decisionRegister = vi.fn(async (request: Record<string, unknown>) => ({
      ok: true,
      status: { owner: 'alembic', route: 'local-alembic-daemon' },
      telemetry: { feature: 'decision-register' },
      value: {
        action: request.action,
        capability: durableDecisionCapability(),
        decision: {
          decisionId: 'decision-public-1',
          status: 'active',
          title: 'Use durable Decision Register',
        },
      },
    }));
    const ctx = makeContext(undefined, {
      residentDecisionRegisterClient: { decisionRegister },
    });

    const result = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        description: 'Plugin should consume Alembic durable decision route.',
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts:1'],
        inputSource: 'host-declared-intent',
        intentRef: 'intent-public-1',
        title: 'Use durable Decision Register',
        workRef: 'work-public-1',
      })
    ) as {
      data: {
        decisionRef: string;
        durablePersistence: { available: boolean; capability: { route: string } };
        result: {
          refs: {
            decisionRef: { id: string };
            detailRefs: unknown[];
            intentRef: unknown;
            workRef: unknown;
          };
          status: string;
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.result.status).toBe('ready');
    expect(result.data.decisionRef).toBe('decision-public-1');
    expect(result.data.result.refs.decisionRef.id).toBe('decision-public-1');
    expect(result.data.result.refs.detailRefs).not.toHaveLength(0);
    expect(result.data.durablePersistence).toMatchObject({
      available: true,
      capability: { route: 'decision-register' },
    });
    expect(decisionRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        body: expect.objectContaining({
          createdBy: 'codex-host-agent',
          decision: 'Plugin should consume Alembic durable decision route.',
          description: 'Plugin should consume Alembic durable decision route.',
          detailRefs: expect.arrayContaining([
            'lib/runtime/mcp/handlers/agent-public-tools.ts',
            'lib/shared/schemas/mcp-tools.ts',
            'test/unit/AgentPublicToolsActive.test.ts:1',
          ]),
          intentRef: 'intent-public-1',
          sourceRefs: ['test/unit/AgentPublicToolsActive.test.ts:1'],
          title: 'Use durable Decision Register',
          workRef: 'work-public-1',
        }),
        sessionId: 'session-public-tools',
      })
    );
  });

  test('maps decision update, revoke, delete, read, and list to resident route actions', async () => {
    const decisionRegister = vi.fn(async (request: Record<string, unknown>) => ({
      ok: true,
      status: { owner: 'alembic', route: 'local-alembic-daemon' },
      value:
        request.action === 'list'
          ? {
              action: 'list',
              capability: durableDecisionCapability(),
              count: 1,
              decision: null,
              decisions: [{ decisionId: 'decision-public-1', status: 'active' }],
            }
          : {
              action: request.action,
              capability: durableDecisionCapability(),
              decision: { decisionId: request.decisionId, status: 'active' },
            },
    }));
    const ctx = makeContext(undefined, {
      residentDecisionRegisterClient: { decisionRegister },
    });

    const updated = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        action: 'update',
        decisionRef: 'decision-public-1',
        description: 'Updated decision body.',
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts:decision-update'],
      })
    ) as DecisionRecordResult;
    const revoked = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        action: 'revoke',
        decisionRef: 'decision-public-1',
        rationale: 'Superseded.',
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts:decision-revoke'],
      })
    ) as DecisionRecordResult;
    const deleted = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        action: 'delete',
        decisionRef: 'decision-public-1',
        rationale: 'Cleanup.',
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts:decision-delete'],
      })
    ) as DecisionRecordResult;
    const read = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        action: 'read',
        decisionRef: 'decision-public-1',
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts:decision-read'],
      })
    ) as DecisionRecordResult;
    const listed = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        action: 'list',
        evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts:decision-list'],
        includeDeleted: true,
        limit: 5,
        status: 'all',
      })
    ) as DecisionRecordResult;

    for (const result of [updated, revoked, deleted, read]) {
      expect(result.success).toBe(true);
      expect(result.data.decisionRef).toBe('decision-public-1');
      expect(result.data.result).toMatchObject({
        refs: {
          decisionRef: { id: 'decision-public-1', toolName: 'alembic_decision_record' },
        },
        status: 'ready',
      });
      expect(result.data.result.refs.detailRefs).not.toHaveLength(0);
    }
    expect(listed.success).toBe(true);
    expect(listed.data.result.status).toBe('ready');
    expect(listed.data.count).toBe(1);
    expect(listed.data.decisions).toHaveLength(1);
    expect(listed.data.decisions[0]).toMatchObject({ decisionId: 'decision-public-1' });
    expect(listed.data.result.refs.decisionRef).toBeUndefined();
    expect(listed.data.result.refs.detailRefs).not.toHaveLength(0);
    expect(decisionRegister).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'update',
        body: expect.objectContaining({
          decision: 'Updated decision body.',
          description: 'Updated decision body.',
          updatedBy: 'codex-host-agent',
        }),
        decisionId: 'decision-public-1',
      })
    );
    expect(decisionRegister).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'revoke',
        body: expect.objectContaining({ reason: 'Superseded.' }),
        decisionId: 'decision-public-1',
      })
    );
    expect(decisionRegister).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: 'delete',
        body: expect.objectContaining({ reason: 'Cleanup.' }),
        decisionId: 'decision-public-1',
      })
    );
    expect(decisionRegister).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ action: 'read', decisionId: 'decision-public-1' })
    );
    expect(decisionRegister).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        action: 'list',
        includeDeleted: true,
        limit: 5,
        status: 'all',
      })
    );
  });

  test('returns a durable route blocker when Decision Register is unavailable', async () => {
    const ctx = makeContext(undefined, {
      residentDecisionRegisterClient: {
        decisionRegister: vi.fn(async () => ({
          ok: false,
          reason: 'route-unavailable',
          retryable: true,
          status: { owner: 'alembic-plugin', route: 'unavailable' },
          message: 'Decision Register requires a local Alembic resident daemon.',
          telemetry: { feature: 'decision-register' },
        })),
      },
    });
    const result = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        description: 'Stage 4 needs a durable Decision Register producer route.',
        inputSource: 'host-declared-intent',
        title: 'Decision Register producer route required',
      })
    ) as {
      data: {
        durablePersistence: { available: boolean; requiredRoute: string };
        result: { reason: { code: string }; refs: { decisionRef?: unknown }; status: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.result).toMatchObject({
      reason: { code: 'decision-register-unavailable' },
      status: 'blocked',
    });
    expect(result.data.result.refs.decisionRef).toBeUndefined();
    expect(result.data.durablePersistence).toMatchObject({
      available: false,
      requiredRoute: 'Alembic durable Decision Register route',
    });
  });

  test('returns a capability mismatch blocker when resident route lacks the Decision Register contract', async () => {
    const ctx = makeContext(undefined, {
      residentDecisionRegisterClient: {
        decisionRegister: vi.fn(async () => ({
          ok: false,
          reason: 'capability-unavailable',
          retryable: false,
          status: { owner: 'alembic', route: 'local-alembic-daemon' },
          message: 'Decision Register capability is missing or does not expose action=create.',
          telemetry: {
            capability: { available: true, owner: 'alembic', route: 'other-route' },
            feature: 'decision-register',
          },
        })),
      },
    });
    const result = publicToolLegacyTestView(
      await decisionRecordHandler(ctx, {
        description: 'Stage 4 needs a durable Decision Register producer route.',
        inputSource: 'host-declared-intent',
        title: 'Decision Register producer route required',
      })
    ) as {
      data: {
        durablePersistence: { available: boolean; reason: string };
        result: { reason: { code: string }; status: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.result).toMatchObject({
      reason: { code: 'decision-register-capability-mismatch' },
      status: 'blocked',
    });
    expect(result.data.durablePersistence).toMatchObject({
      available: false,
      reason: 'capability-unavailable',
    });
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
