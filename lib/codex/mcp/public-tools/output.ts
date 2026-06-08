import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpResponse,
  registerMcpOutputProjector,
} from '../output-contract.js';
import {
  AGENT_PUBLIC_TOOL_ACTION_BY_NAME,
  AGENT_PUBLIC_TOOL_NAMES,
  AgentActionKindSchema,
  AgentDetailRefSchema,
  AgentHostSchema,
  AgentInputSourceSchema,
  AgentIntentKindSchema,
  type AgentPublicToolName,
  AgentPublicToolNameSchema,
  AgentPublicToolReasonSchema,
  AgentPublicToolRefsSchema,
  type AgentPublicToolResultEnvelope,
  AgentPublicToolResultEnvelopeSchema,
  AgentResultStatusSchema,
  PrimePublicPackageSchema,
} from './contract.js';

const UnknownRecordSchema = z.record(z.string(), z.unknown());

const IntentClassificationSchema = z
  .object({
    actionKind: z.string().min(1).max(120),
    confidenceBand: z.enum(['high', 'medium', 'low', 'degraded']),
    objectKind: z.string().min(1).max(120),
    scopeKind: z.string().min(1).max(120),
  })
  .strict();

const IntentPersistenceSchema = z
  .object({
    consumable: z.boolean(),
    created: z.boolean(),
    kind: z.enum(['ephemeral', 'session-local']),
  })
  .strict();

const IntentRetrievalPlanSchema = z
  .object({
    route: z.literal('structure-first'),
    vectorUseKind: z.enum(['none', 'semantic-expand', 'hybrid-rerank']),
  })
  .strict();

const IntentToolPlanSchema = z
  .object({
    guardNeed: z.enum(['none', 'recommend-if-code-changed', 'explicit-scope-required']),
    primeNeed: z.enum(['none', 'optional', 'recommended', 'required']),
    workNeed: z.enum(['none', 'maybe-start', 'start-required']),
  })
  .strict();

export const AgentPublicToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  actionKind: AgentActionKindSchema,
  agentHost: AgentHostSchema,
  inputSource: AgentInputSourceSchema,
  intentKind: AgentIntentKindSchema.optional(),
  reason: AgentPublicToolReasonSchema.optional(),
  refs: AgentPublicToolRefsSchema,
  status: AgentResultStatusSchema,
  toolName: AgentPublicToolNameSchema,
}).superRefine((output, ctx) => {
  const expectedAction = AGENT_PUBLIC_TOOL_ACTION_BY_NAME[output.toolName];
  if (output.actionKind !== expectedAction) {
    ctx.addIssue({
      code: 'custom',
      path: ['actionKind'],
      message: `actionKind must match ${expectedAction} for ${output.toolName}`,
    });
  }

  const reasonKindByStatus: Partial<Record<typeof output.status, string>> = {
    blocked: 'blocked',
    degraded: 'degraded',
    failed: 'failure',
    skipped: 'skip',
  };
  const expectedReasonKind = reasonKindByStatus[output.status];
  if (expectedReasonKind && output.reason?.kind !== expectedReasonKind) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `${output.status} outputs require a ${expectedReasonKind} reason`,
    });
  }
});

export const AgentIntentOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  detailRefs: z.array(AgentDetailRefSchema).max(40),
  intentClassification: IntentClassificationSchema,
  intentPersistence: IntentPersistenceSchema,
  intentRef: z.string().min(1).max(240).optional(),
  localRecord: UnknownRecordSchema.optional(),
  retrievalPlan: IntentRetrievalPlanSchema,
  recognizedIntent: UnknownRecordSchema,
  toolPlan: IntentToolPlanSchema,
  toolName: z.literal('alembic_intent'),
});

export const AgentPrimeOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  detailRefs: z.array(AgentDetailRefSchema).max(40),
  primePackage: PrimePublicPackageSchema,
  toolName: z.literal('alembic_prime'),
});

export const AgentWorkStartOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  localRecord: UnknownRecordSchema.optional(),
  toolName: z.literal('alembic_work_start'),
  workRef: z.string().min(1).max(240).optional(),
});

export const AgentWorkFinishOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  changedFiles: z.array(z.string()).max(80).optional(),
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  evidenceRefs: z.array(z.string()).max(80).optional(),
  finishRef: z.string().min(1).max(240).optional(),
  guardRecommendation: UnknownRecordSchema.optional(),
  localRecord: UnknownRecordSchema.optional(),
  outcome: z.enum(['completed', 'blocked', 'abandoned']).optional(),
  toolName: z.literal('alembic_work_finish'),
  workRef: z.string().min(1).max(240).optional(),
});

export const AgentCodeGuardOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  explicitScope: UnknownRecordSchema.optional(),
  guard: z.unknown().optional(),
  guardResultRef: z.string().min(1).max(240).optional(),
  toolName: z.literal('alembic_code_guard'),
  unsupportedScopeFields: z.array(z.string()).max(20).optional(),
});

export const AgentDecisionRecordOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  count: z.number().nullable().optional(),
  decision: z.unknown().optional(),
  decisionRef: z.string().min(1).max(240).nullable().optional(),
  decisions: z.array(z.unknown()).optional(),
  durablePersistence: UnknownRecordSchema.optional(),
  requestedDecision: UnknownRecordSchema.optional(),
  toolName: z.literal('alembic_decision_record'),
});

export const AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS = {
  alembic_code_guard: AgentCodeGuardOutputSchema,
  alembic_decision_record: AgentDecisionRecordOutputSchema,
  alembic_intent: AgentIntentOutputSchema,
  alembic_prime: AgentPrimeOutputSchema,
  alembic_work_finish: AgentWorkFinishOutputSchema,
  alembic_work_start: AgentWorkStartOutputSchema,
} as const;

export type AgentPublicToolOutput = z.infer<typeof AgentPublicToolOutputBaseSchema>;

export function createAgentPublicToolOutput(
  result: AgentPublicToolResultEnvelope,
  payload: Record<string, unknown> = {},
  options: { ok?: boolean } = {}
): AgentPublicToolOutput {
  const ok = options.ok ?? (result.status !== 'blocked' && result.status !== 'failed');
  const response = createCleanMcpResponse(
    {
      ...payload,
      actionKind: result.actionKind,
      agentHost: result.agentHost,
      inputSource: result.inputSource,
      ok,
      refs: result.refs,
      status: result.status,
      summary: result.summary,
      toolName: result.toolName,
      ...(result.intentKind ? { intentKind: result.intentKind } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(!ok && result.reason
        ? {
            error: {
              code: result.reason.code,
              message: result.reason.message,
            },
          }
        : {}),
    },
    result.toolName
  );
  return AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[result.toolName].parse(response);
}

function projectAgentPublicToolOutput(input: unknown, toolName: AgentPublicToolName) {
  const schema = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName];
  const clean = schema.safeParse(input);
  if (clean.success) {
    return clean.data;
  }

  const legacy = input as { data?: Record<string, unknown>; success?: unknown };
  const maybeResult = legacy?.data?.result;
  if (!maybeResult || typeof maybeResult !== 'object') {
    return schema.parse(input);
  }
  const result = AgentPublicToolResultEnvelopeSchema.parse(maybeResult);
  const { result: _result, ...payload } = legacy.data ?? {};
  return createAgentPublicToolOutput(result, payload, {
    ok: legacy.success !== false,
  });
}

for (const toolName of AGENT_PUBLIC_TOOL_NAMES) {
  registerMcpOutputProjector({
    outputSchema: AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName],
    outputSchemaName: `${toolName}_clean_output`,
    project: (input) => projectAgentPublicToolOutput(input, toolName),
    projectorName: 'agent-public-clean-output-projector',
    toolName,
  });
}
