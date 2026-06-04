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
