import { z } from 'zod';

export const AGENT_PUBLIC_TOOL_CONTRACT_VERSION = 1 as const;

export const AGENT_PUBLIC_TOOL_NAMES = [
  'alembic_prime',
  'alembic_work',
  'alembic_code_guard',
] as const;

// RC-5: 收敛为真实双宿主（codex + claude-code），删除从未实现的 generic-host-agent。
export const AGENT_HOSTS = ['codex', 'claude-code'] as const;

export const AGENT_INPUT_SOURCES = [
  'host-declared-intent',
  'host-turn-metadata',
  'user-message',
  'automation-envelope',
  'source-ref',
  'tool-result',
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

// MTC-7: the former split work lifecycle collapsed into one 'work' action; the merged
// alembic_work tool discriminates start vs finish by its phase input.
export const AGENT_ACTION_KINDS = ['prime', 'work', 'code-guard'] as const;

export const AGENT_RESULT_STATUSES = ['ready', 'skipped', 'degraded', 'blocked', 'failed'] as const;

export const AGENT_SKIP_REASON_CODES = [
  'status-only-turn',
  'mechanical-envelope-only',
  'no-work-scope',
  'no-code-scope',
] as const;

export const AGENT_DEGRADED_REASON_CODES = [
  'low-confidence-intent',
  'project-scope-unavailable',
  'knowledge-empty',
  'detail-budget-limited',
  'optional-service-unavailable',
  'guard-coverage-incomplete',
] as const;

export const AGENT_BLOCKED_REASON_CODES = [
  'project-root-untrusted',
  'project-isolation-unconfirmed',
  'missing-work-ref',
  'missing-guard-scope',
  'decision-scope-unconfirmed',
  'decision-register-capability-mismatch',
  'decision-register-unavailable',
  'shared-contract-required',
  'guard-scope-invalid',
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
  alembic_prime: 'prime',
  alembic_work: 'work',
  alembic_code_guard: 'code-guard',
} as const satisfies Record<AgentPublicToolName, AgentActionKind>;

export const AgentPublicToolRefSchema = z.object({
  refType: z.enum([
    'intent',
    'prime',
    'project-context',
    'work',
    'finish',
    'guard-result',
    'decision',
    'detail',
  ]),
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

export const AgentPublicToolResultSummarySchema = z.string().min(1).max(2000);

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

export const AgentPublicToolResultEnvelopeSchema = z
  .object({
    toolName: AgentPublicToolNameSchema,
    actionKind: AgentActionKindSchema,
    status: AgentResultStatusSchema,
    agentHost: AgentHostSchema,
    inputSource: AgentInputSourceSchema,
    summary: AgentPublicToolResultSummarySchema,
    refs: AgentPublicToolRefsSchema,
    reason: AgentPublicToolReasonSchema.optional(),
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

// Codex host 只依赖这个稳定投影读取 prime 结果；完整知识和证据仍通过
// detailRefs / primeKnowledgeMaterial 保留，避免把长知识包塞进可见 message。
export const PrimePublicPackageSchema = z
  .object({
    contractVersion: z.literal(AGENT_PUBLIC_TOOL_CONTRACT_VERSION),
    kind: z.literal('PrimePublicPackage'),
    primeRef: z.string().min(1).max(240),
    status: AgentResultStatusSchema,
    reason: AgentPublicToolReasonSchema.optional(),
    refs: AgentPublicToolRefsSchema,
    summary: AgentPublicToolResultSummarySchema,
    projectContextGuidance: z.object({
      boundary: z.string().min(1).max(600),
      recommendedQueries: z
        .array(
          z.object({
            changedFiles: z.array(z.string().min(1).max(1200)).max(40).optional(),
            focus: z.string().min(1).max(240).optional(),
            query: z.string().min(1).max(240).optional(),
            tool: z.string().min(1).max(120),
          })
        )
        .max(8),
      recommendedTools: z.array(z.string().min(1).max(120)).max(8),
      projectContextRefs: z.array(z.string().min(1).max(240)).max(40),
      sourceEvidenceRefs: z.array(z.string().min(1).max(240)).max(40),
      status: z.enum(['not-requested', 'recommended', 'ready-evidence', 'degraded']),
    }),
    compactPackage: z.object({
      candidateRecipeIds: z.array(z.string().min(1).max(240)).max(100).default([]),
      acceptedGuards: z.array(z.record(z.string(), z.unknown())).max(20),
      acceptedKnowledge: z.array(z.record(z.string(), z.unknown())).max(20),
      counts: z.object({
        acceptedGuards: z.number().int().min(0).max(500),
        acceptedKnowledge: z.number().int().min(0).max(500),
        detailRefs: z.number().int().min(0).max(200),
        omittedFromCompact: z.number().int().min(0).max(1000),
      }),
      detailRefsMode: z.literal('ref-based'),
      evidenceDelivery: z.literal('detailRefs-and-primeKnowledgeMaterial'),
    }),
  })
  .strict();

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
  never
>;

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
    'alembic_prime',
    {
      acceptedRefs: ['detailRefs'],
      requiredFields: [],
    },
    ['primeRef', 'detailRefs'],
    {
      activeMcpSurface: true,
      handlerDependency: 'McpServer.agent-public-tools',
      implementationStatus: 'active-tool',
    }
  ),
  // MTC-7: merged the former split work lifecycle. phase=start creates a
  // workRef; phase=finish closes it (workRef required for finish, enforced by the
  // handler). acceptedRefs/producesRefs are the union across both phases.
  definition(
    'alembic_work',
    {
      acceptedRefs: ['primeRef', 'workRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource', 'phase'],
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
      acceptedRefs: ['workRef', 'detailRefs'],
      requiredFields: ['agentHost', 'inputSource'],
    },
    ['guardResultRef', 'detailRefs'],
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
  return AgentPublicToolResultEnvelopeSchema.parse(input);
}
