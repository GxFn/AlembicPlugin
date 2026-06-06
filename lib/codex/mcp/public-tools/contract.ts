import { z } from 'zod';

export const AGENT_PUBLIC_TOOL_CONTRACT_VERSION = 1 as const;

export const AGENT_PUBLIC_TOOL_NAMES = [
  'alembic_intent',
  'alembic_prime',
  'alembic_work_start',
  'alembic_work_finish',
  'alembic_code_guard',
  'alembic_decision_record',
] as const;

export const AGENT_HOSTS = ['codex', 'claude-code', 'generic-host-agent'] as const;

export const AGENT_INPUT_SOURCES = [
  'host-declared-intent',
  'host-turn-metadata',
  'user-message',
  'automation-envelope',
  'source-ref',
  'tool-result',
  'legacy-compatibility',
] as const;

export const AGENT_INTENT_KINDS = [
  'implementation-task',
  'fix-task',
  'refactor-task',
  'review-task',
  'read-only-analysis',
  'status-only',
  'decision',
  'design-or-planning',
  'mechanical-envelope',
  'unknown',
] as const;

export const AGENT_ACTION_KINDS = [
  'intent',
  'prime',
  'work-start',
  'work-finish',
  'code-guard',
  'decision-record',
] as const;

export const AGENT_RESULT_STATUSES = ['ready', 'skipped', 'degraded', 'blocked', 'failed'] as const;

export const AGENT_INTENT_DESIGN_FIELD_MAPPINGS = [
  {
    field: 'agentHost',
    disposition: 'public-field',
    evidence: ['AgentPublicToolBaseInput.agentHost', 'AgentPublicToolResultEnvelope.agentHost'],
  },
  {
    field: 'hostSurface',
    disposition: 'internal-derived-field',
    evidence: ['HostTurnMetaInput.surface', 'alembic_intent.diagnostics.normalized.hostSurface'],
  },
  {
    field: 'inputSource',
    disposition: 'public-field',
    evidence: ['AgentPublicToolBaseInput.inputSource', 'AgentPublicToolResultEnvelope.inputSource'],
  },
  {
    field: 'intentKind',
    disposition: 'public-field',
    evidence: ['AgentPublicToolBaseInput.intentKind', 'AgentPublicToolResultEnvelope.intentKind'],
  },
  {
    field: 'actionKind',
    disposition: 'internal-derived-field',
    evidence: ['HostDeclaredIntentInput.action', 'RecognizedIntentDraft.action'],
  },
  {
    field: 'objectKind',
    disposition: 'internal-derived-field',
    evidence: ['RecognizedIntentDraft.target', 'activeFile', 'sourceRefs'],
  },
  {
    field: 'scopeKind',
    disposition: 'internal-derived-field',
    evidence: ['projectRoot', 'activeFile', 'sourceRefs'],
  },
  {
    field: 'persistenceKind',
    disposition: 'public-result-field',
    evidence: ['alembic_intent.persistence.kind'],
  },
  {
    field: 'primeNeed',
    disposition: 'public-result-field',
    evidence: ['alembic_intent.diagnostics.toolNeeds.primeNeed'],
  },
  {
    field: 'workNeed',
    disposition: 'public-result-field',
    evidence: ['alembic_intent.diagnostics.toolNeeds.workNeed'],
  },
  {
    field: 'guardNeed',
    disposition: 'public-result-field',
    evidence: ['alembic_intent.diagnostics.toolNeeds.guardNeed'],
  },
  {
    field: 'vectorUseKind',
    disposition: 'public-result-field',
    evidence: ['alembic_intent.vectorPlan.vectorUseKind'],
  },
  {
    field: 'confidenceBand',
    disposition: 'public-result-field',
    evidence: ['alembic_intent.diagnostics.normalized.confidenceBand'],
  },
] as const;

export const AGENT_SKIP_REASON_CODES = [
  'no-semantic-intent',
  'status-only-turn',
  'mechanical-envelope-only',
  'no-work-scope',
  'no-code-scope',
  'not-relevant-to-project-knowledge',
] as const;

export const AGENT_DEGRADED_REASON_CODES = [
  'low-confidence-intent',
  'resident-unavailable',
  'project-scope-unavailable',
  'knowledge-empty',
  'detail-budget-limited',
  'optional-service-unavailable',
] as const;

export const AGENT_BLOCKED_REASON_CODES = [
  'project-root-untrusted',
  'missing-required-intent',
  'missing-referenced-docs',
  'missing-prime-scope',
  'missing-work-ref',
  'missing-guard-scope',
  'decision-scope-unconfirmed',
  'decision-register-capability-mismatch',
  'decision-register-unavailable',
  'shared-contract-required',
] as const;

export const AGENT_FAILURE_REASON_CODES = [
  'schema-validation-failed',
  'handler-error',
  'result-envelope-invalid',
] as const;

export const AgentPublicToolNameSchema = z.enum(AGENT_PUBLIC_TOOL_NAMES);
export const AgentHostSchema = z.enum(AGENT_HOSTS);
export const AgentInputSourceSchema = z.enum(AGENT_INPUT_SOURCES);
export const AgentIntentKindSchema = z.enum(AGENT_INTENT_KINDS);
export const AgentActionKindSchema = z.enum(AGENT_ACTION_KINDS);
export const AgentResultStatusSchema = z.enum(AGENT_RESULT_STATUSES);
export const AgentSkipReasonCodeSchema = z.enum(AGENT_SKIP_REASON_CODES);
export const AgentDegradedReasonCodeSchema = z.enum(AGENT_DEGRADED_REASON_CODES);
export const AgentBlockedReasonCodeSchema = z.enum(AGENT_BLOCKED_REASON_CODES);
export const AgentFailureReasonCodeSchema = z.enum(AGENT_FAILURE_REASON_CODES);

export type AgentPublicToolName = z.infer<typeof AgentPublicToolNameSchema>;
export type AgentHost = z.infer<typeof AgentHostSchema>;
export type AgentInputSource = z.infer<typeof AgentInputSourceSchema>;
export type AgentIntentKind = z.infer<typeof AgentIntentKindSchema>;
export type AgentActionKind = z.infer<typeof AgentActionKindSchema>;
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

export const AGENT_PUBLIC_TOOL_ACTION_BY_NAME = {
  alembic_intent: 'intent',
  alembic_prime: 'prime',
  alembic_work_start: 'work-start',
  alembic_work_finish: 'work-finish',
  alembic_code_guard: 'code-guard',
  alembic_decision_record: 'decision-record',
} as const satisfies Record<AgentPublicToolName, AgentActionKind>;

export const AgentPublicToolRefSchema = z.object({
  refType: z.enum(['intent', 'prime', 'work', 'finish', 'guard-result', 'decision', 'detail']),
  id: z.string().min(1).max(240),
  label: z.string().min(1).max(160).optional(),
  source: AgentInputSourceSchema.optional(),
  toolName: AgentPublicToolNameSchema.optional(),
});

export const AgentDetailRefSchema = z.object({
  id: z.string().min(1).max(240),
  kind: z.enum([
    'catalog',
    'contract',
    'file',
    'runtime-json',
    'log',
    'report',
    'schema',
    'source-ref',
    'test-output',
  ]),
  summary: z.string().min(1).max(500),
  uri: z.string().min(1).max(1200).optional(),
  requiredForCompletion: z.boolean().default(false),
});

export const AgentPublicToolOutputBudgetSchema = z
  .object({
    mode: z.enum(['compact', 'standard', 'detailed']).default('compact'),
    maxChars: z.number().int().min(1).max(20000),
    usedChars: z.number().int().min(0).max(20000),
    truncated: z.boolean(),
  })
  .refine((budget) => budget.usedChars <= budget.maxChars, {
    message: 'usedChars must be less than or equal to maxChars',
  });

export const AgentPublicToolResultSummarySchema = z.object({
  compact: z.string().min(1).max(2000),
  title: z.string().min(1).max(140).optional(),
  outputBudget: AgentPublicToolOutputBudgetSchema,
});

export const AgentPublicToolReasonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('skip'),
    code: AgentSkipReasonCodeSchema,
    message: z.string().min(1).max(600),
    retryable: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('degraded'),
    code: AgentDegradedReasonCodeSchema,
    message: z.string().min(1).max(600),
    retryable: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('blocked'),
    code: AgentBlockedReasonCodeSchema,
    message: z.string().min(1).max(600),
    retryable: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('failure'),
    code: AgentFailureReasonCodeSchema,
    message: z.string().min(1).max(600),
    retryable: z.boolean().default(false),
  }),
]);

export const AgentPublicToolRefsSchema = z.object({
  intentRef: AgentPublicToolRefSchema.optional(),
  primeRef: AgentPublicToolRefSchema.optional(),
  workRef: AgentPublicToolRefSchema.optional(),
  finishRef: AgentPublicToolRefSchema.optional(),
  guardResultRef: AgentPublicToolRefSchema.optional(),
  decisionRef: AgentPublicToolRefSchema.optional(),
  detailRefs: z.array(AgentDetailRefSchema).max(40).default([]),
});

export const AgentPublicToolLegacyCompatibilitySchema = z.object({
  usesLegacyTaskHandler: z.literal(false),
  compatibilityRole: z.enum(['none', 'consumer-only']).default('none'),
});

export const AgentPublicToolResultEnvelopeSchema = z
  .object({
    contractVersion: z.literal(AGENT_PUBLIC_TOOL_CONTRACT_VERSION),
    toolName: AgentPublicToolNameSchema,
    actionKind: AgentActionKindSchema,
    status: AgentResultStatusSchema,
    agentHost: AgentHostSchema,
    inputSource: AgentInputSourceSchema,
    intentKind: AgentIntentKindSchema.optional(),
    summary: AgentPublicToolResultSummarySchema,
    refs: AgentPublicToolRefsSchema,
    reason: AgentPublicToolReasonSchema.optional(),
    legacyCompatibility: AgentPublicToolLegacyCompatibilitySchema.default({
      usesLegacyTaskHandler: false,
      compatibilityRole: 'none',
    }),
  })
  .superRefine((envelope, ctx) => {
    const expectedAction = AGENT_PUBLIC_TOOL_ACTION_BY_NAME[envelope.toolName];
    if (envelope.actionKind !== expectedAction) {
      ctx.addIssue({
        code: 'custom',
        path: ['actionKind'],
        message: `actionKind must match ${expectedAction} for ${envelope.toolName}`,
      });
    }

    const reasonKindByStatus: Partial<Record<AgentResultStatus, string>> = {
      skipped: 'skip',
      degraded: 'degraded',
      blocked: 'blocked',
      failed: 'failure',
    };
    const expectedReasonKind = reasonKindByStatus[envelope.status];
    if (expectedReasonKind && envelope.reason?.kind !== expectedReasonKind) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `${envelope.status} results require a ${expectedReasonKind} reason`,
      });
    }
  });

export type AgentPublicToolRef = z.infer<typeof AgentPublicToolRefSchema>;
export type AgentDetailRef = z.infer<typeof AgentDetailRefSchema>;
export type AgentPublicToolResultEnvelope = z.infer<typeof AgentPublicToolResultEnvelopeSchema>;

export const PRIME_PUBLIC_TRUST_LAYERS = [
  'trusted-to-obey',
  'trusted-to-use',
  'context-only',
  'requires-verification',
  'not-available-or-degraded',
] as const;

// Codex host 只依赖这个稳定投影读取 prime 结果；完整知识和证据仍通过
// detailRefs / primeKnowledgeMaterial 保留，避免把长知识包塞进可见 message。
export const PrimePublicPackageSchema = z.object({
  contractVersion: z.literal(AGENT_PUBLIC_TOOL_CONTRACT_VERSION),
  kind: z.literal('PrimePublicPackage'),
  primeRef: z.string().min(1).max(240),
  status: AgentResultStatusSchema,
  reason: AgentPublicToolReasonSchema.optional(),
  refs: AgentPublicToolRefsSchema,
  summary: AgentPublicToolResultSummarySchema,
  trustPosture: z.object({
    status: z.enum(['delivered', 'empty', 'degraded', 'blocked', 'skipped']),
    noTrustedClaimRequired: z.boolean(),
    antiEmptyReceiptRequired: z.boolean(),
    receiptChecklist: z
      .array(
        z.object({
          itemCount: z.number().int().min(0).max(500),
          label: z.string().min(1).max(160),
          layer: z.enum(PRIME_PUBLIC_TRUST_LAYERS),
          requiredInVisibleReceipt: z.boolean(),
          visibleReceiptDirective: z.string().min(1).max(600),
        })
      )
      .length(PRIME_PUBLIC_TRUST_LAYERS.length),
  }),
  trustReceipt: z.object({
    hostResponse: z.record(z.string(), z.unknown()).nullable(),
    receiptId: z.string().min(1).max(240).nullable(),
    status: z.enum(['delivered', 'empty', 'degraded', 'blocked', 'skipped']),
  }),
  retrievalConsumer: z.record(z.string(), z.unknown()).nullable(),
  structureFirst: z.object({
    keywordQueries: z.array(z.string().min(1).max(1200)).max(12),
    language: z.string().max(80).nullable(),
    module: z.string().max(240).nullable(),
    queries: z.array(z.string().min(1).max(1200)).max(12),
    retrievalOrder: z.array(z.string().min(1).max(1200)).max(12),
    route: z.literal('structure-first-recipe-retrieval'),
    scenario: z.string().min(1).max(120),
    vectorUseKind: z.enum(['none', 'semantic-expand', 'hybrid-rerank']),
  }),
  compactPackage: z.object({
    acceptedGuards: z
      .array(
        z.object({
          evidenceRefCount: z.number().int().min(0).max(500),
          id: z.string().min(1).max(240),
          score: z.number(),
          title: z.string().min(1).max(240),
          trigger: z.string().min(0).max(240),
        })
      )
      .max(8),
    acceptedKnowledge: z
      .array(
        z.object({
          evidenceRefCount: z.number().int().min(0).max(500),
          id: z.string().min(1).max(240),
          kind: z.string().min(1).max(80),
          score: z.number(),
          title: z.string().min(1).max(240),
          trigger: z.string().min(0).max(240),
        })
      )
      .max(8),
    counts: z.object({
      acceptedGuards: z.number().int().min(0).max(500),
      acceptedKnowledge: z.number().int().min(0).max(500),
      detailRefs: z.number().int().min(0).max(40),
      omittedFromCompact: z.number().int().min(0).max(1000),
    }),
    detailRefsMode: z.literal('ref-based'),
    evidenceDelivery: z.literal('detailRefs-and-primeKnowledgeMaterial'),
    primeInjectionPackage: z.object({
      availability: z.enum([
        'resident-provided',
        'producer-contract-missing',
        'resident-unavailable',
        'not-produced',
        'not-run',
      ]),
      missingProducerFields: z.array(z.string().min(1).max(160)).max(40),
      omittedCount: z.number().int().min(0).max(1000).nullable(),
      pluginSynthesized: z.literal(false),
      producer: z.literal('alembic-resident-service'),
      producerBoundary: z.string().min(1).max(600),
      producerOnlyFields: z
        .array(
          z.enum([
            'decisionRegister',
            'feedback',
            'intent',
            'omitted',
            'relations',
            'retrievalQuality',
            'search',
            'selectedKnowledge',
            'trace',
            'vector',
          ])
        )
        .max(12),
      selectedCount: z.number().int().min(0).max(1000).nullable(),
      status: z.string().min(1).max(120).nullable(),
    }),
  }),
  sourcePolicy: z.object({
    automationEnvelope: z
      .object({
        blockedWithoutSourceRefs: z.boolean(),
        requiredSourceRefsForPrime: z.literal(true),
        sourceRefsCount: z.number().int().min(0).max(50),
      })
      .nullable(),
    detailRefs: z.object({
      count: z.number().int().min(0).max(40),
      mode: z.literal('bounded-source-ref-details'),
    }),
    inputSource: AgentInputSourceSchema,
    rawAutomationEnvelopeUsedAsQuery: z.literal(false),
    rawThreadIdsPersisted: z.literal(false),
    sourceRefsCount: z.number().int().min(0).max(50),
  }),
  runtimePolicy: z.object({
    available: z.boolean(),
    identity: z
      .object({
        currentFolderId: z.string().nullable(),
        dataRootSource: z.string().nullable(),
        projectId: z.string().nullable(),
        projectRoot: z.string().nullable(),
        projectScopeId: z.string().nullable(),
      })
      .nullable(),
    projectRuntimeContractVersion: z.number().int().min(1).nullable(),
    readinessState: z.string().nullable(),
    reason: z.string().min(1).max(240).optional(),
    sourcePolicy: z.object({
      effectiveIdentitySource: z.literal('codex-current-project').nullable(),
      projectScopeSource: z.enum(['resident-read-only', 'single-folder-baseline']).nullable(),
      runtimeControlSource: z.literal('read-only-diagnostics').nullable(),
      selectedOrActiveCanOverrideEffectiveIdentity: z.literal(false),
    }),
  }),
  diagnostics: z.object({
    outputBudget: AgentPublicToolOutputBudgetSchema,
    producerBoundary: z.object({
      missingProducerFields: z.array(z.string().min(1).max(160)).max(40),
      pluginSynthesizedPrimeInjectionPackage: z.literal(false),
      primeInjectionPackageProducedBy: z.literal('Alembic resident service'),
    }),
    retrieval: z.object({
      filteredCount: z.number().int().min(0).max(100000).nullable(),
      queries: z.array(z.string().min(1).max(1200)).max(12),
      residentAttempted: z.boolean(),
      residentAvailable: z.boolean().nullable(),
      residentReason: z.string().max(500).nullable(),
      resultCount: z.number().int().min(0).max(100000).nullable(),
      searchAttempted: z.boolean(),
      searchDegraded: z.boolean(),
    }),
  }),
});

export type PrimePublicPackage = z.infer<typeof PrimePublicPackageSchema>;
export type CreatePrimePublicPackageInput = Omit<
  z.input<typeof PrimePublicPackageSchema>,
  'contractVersion'
>;

export function createPrimePublicPackage(input: CreatePrimePublicPackageInput): PrimePublicPackage {
  return PrimePublicPackageSchema.parse({
    contractVersion: AGENT_PUBLIC_TOOL_CONTRACT_VERSION,
    ...input,
  });
}

export type CreateAgentPublicToolResultEnvelopeInput = Omit<
  z.input<typeof AgentPublicToolResultEnvelopeSchema>,
  'contractVersion' | 'legacyCompatibility'
> & {
  legacyCompatibility?: z.input<typeof AgentPublicToolLegacyCompatibilitySchema>;
};

export interface AgentPublicToolContractDefinition {
  activeMcpSurface: boolean;
  actionKind: AgentActionKind;
  handlerDependency: 'none' | 'McpServer.agent-public-tools';
  implementationStatus: 'active-tool' | 'contract-only';
  inputContract: {
    acceptedRefs: readonly string[];
    requiredFields: readonly string[];
  };
  name: AgentPublicToolName;
  resultContract: {
    producesRefs: readonly string[];
    reasonKinds: readonly string[];
    statuses: readonly AgentResultStatus[];
  };
}

function definition(
  name: AgentPublicToolName,
  inputContract: AgentPublicToolContractDefinition['inputContract'],
  producesRefs: readonly string[],
  implementation: Pick<
    AgentPublicToolContractDefinition,
    'activeMcpSurface' | 'handlerDependency' | 'implementationStatus'
  > = {
    activeMcpSurface: false,
    handlerDependency: 'none',
    implementationStatus: 'contract-only',
  }
): AgentPublicToolContractDefinition {
  return {
    activeMcpSurface: implementation.activeMcpSurface,
    actionKind: AGENT_PUBLIC_TOOL_ACTION_BY_NAME[name],
    handlerDependency: implementation.handlerDependency,
    implementationStatus: implementation.implementationStatus,
    inputContract,
    name,
    resultContract: {
      producesRefs,
      reasonKinds: ['skip', 'degraded', 'blocked', 'failure'],
      statuses: AGENT_RESULT_STATUSES,
    },
  };
}

export const AGENT_PUBLIC_TOOL_CONTRACT_CATALOG = [
  definition(
    'alembic_intent',
    {
      acceptedRefs: ['detailRefs'],
      requiredFields: ['agentHost', 'inputSource'],
    },
    ['intentRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
  definition(
    'alembic_prime',
    {
      acceptedRefs: ['intentRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource', 'intentRef'],
    },
    ['primeRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
  definition(
    'alembic_work_start',
    {
      acceptedRefs: ['intentRef', 'primeRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource', 'intentRef'],
    },
    ['workRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
  definition(
    'alembic_work_finish',
    {
      acceptedRefs: ['intentRef', 'primeRef', 'workRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource', 'workRef'],
    },
    ['workRef', 'finishRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
  definition(
    'alembic_code_guard',
    {
      acceptedRefs: ['intentRef', 'workRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource'],
    },
    ['guardResultRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
  definition(
    'alembic_decision_record',
    {
      acceptedRefs: ['intentRef', 'workRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource'],
    },
    ['decisionRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
] as const satisfies readonly AgentPublicToolContractDefinition[];

const AGENT_PUBLIC_TOOL_CONTRACT_BY_NAME = Object.fromEntries(
  AGENT_PUBLIC_TOOL_CONTRACT_CATALOG.map((entry) => [entry.name, entry])
) as Record<AgentPublicToolName, AgentPublicToolContractDefinition>;

export function getAgentPublicToolContractDefinition(
  name: AgentPublicToolName
): AgentPublicToolContractDefinition {
  return AGENT_PUBLIC_TOOL_CONTRACT_BY_NAME[name];
}

export function listAgentPublicToolContractCatalog(): AgentPublicToolContractDefinition[] {
  return AGENT_PUBLIC_TOOL_CONTRACT_CATALOG.map((entry) => ({
    ...entry,
    inputContract: {
      acceptedRefs: [...entry.inputContract.acceptedRefs],
      requiredFields: [...entry.inputContract.requiredFields],
    },
    resultContract: {
      producesRefs: [...entry.resultContract.producesRefs],
      reasonKinds: [...entry.resultContract.reasonKinds],
      statuses: [...entry.resultContract.statuses],
    },
  }));
}

export function createAgentDetailRef(input: z.input<typeof AgentDetailRefSchema>): AgentDetailRef {
  return AgentDetailRefSchema.parse(input);
}

export function createAgentPublicToolResultEnvelope(
  input: CreateAgentPublicToolResultEnvelopeInput
): AgentPublicToolResultEnvelope {
  return AgentPublicToolResultEnvelopeSchema.parse({
    contractVersion: AGENT_PUBLIC_TOOL_CONTRACT_VERSION,
    legacyCompatibility: {
      usesLegacyTaskHandler: false,
      compatibilityRole: 'none',
    },
    ...input,
  });
}
