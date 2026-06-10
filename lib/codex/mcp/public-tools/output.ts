import type { CoreFieldFailureKind } from '@alembic/core/shared';
import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpError,
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
  AgentResultStatusSchema,
  PrimePublicPackageSchema,
} from './contract.js';

const PublicStringSchema = z.string().min(1).max(1200);
const OptionalPublicStringSchema = z.string().max(1200).optional();
const PublicStringArraySchema = z.array(PublicStringSchema).max(80);

const RecognizedIntentPublicSchema = z
  .object({
    action: OptionalPublicStringSchema,
    confidence: z.number().min(0).max(1).optional(),
    degraded: z.boolean().optional(),
    degradedReasons: z.array(z.string().max(240)).max(40).optional(),
    evidenceSpanCount: z.number().int().min(0).max(1000).optional(),
    language: OptionalPublicStringSchema,
    query: z.string().max(2000),
    source: z.enum(['deterministic', 'host-declared', 'mixed']).optional(),
    sourceRefs: PublicStringArraySchema.optional(),
    status: z.enum(['recognized', 'needs-confirmation', 'degraded']).optional(),
    target: OptionalPublicStringSchema,
  })
  .strict();

const IntentLocalRecordSchema = z
  .object({
    createdAt: PublicStringSchema,
    intentRef: PublicStringSchema,
    status: AgentResultStatusSchema,
  })
  .strict();

const WorkStartLocalRecordSchema = z
  .object({
    createdAt: PublicStringSchema,
    scopeFiles: PublicStringArraySchema,
    title: PublicStringSchema,
    workRef: PublicStringSchema,
  })
  .strict();

const WorkFinishLocalRecordSchema = z
  .object({
    finishedAt: PublicStringSchema,
    outcome: z.enum(['completed', 'blocked', 'abandoned']),
    workRef: PublicStringSchema,
  })
  .strict();

const GuardRecommendationSchema = z
  .object({
    action: z.enum(['run', 'skip']),
    input: z
      .object({
        files: PublicStringArraySchema,
      })
      .strict()
      .optional(),
    reason: OptionalPublicStringSchema,
    reasonCode: PublicStringSchema,
    sourceEvidenceRefs: PublicStringArraySchema.optional(),
    sourceGraphRef: PublicStringSchema.optional(),
    taskScopedFiles: PublicStringArraySchema,
    tool: z.literal('alembic_code_guard'),
    validationPlan: z
      .object({
        acceptanceBoundary: OptionalPublicStringSchema,
        advisoryOnly: z.literal(true),
        buckets: z
          .object({
            manualReview: z
              .object({
                commands: PublicStringArraySchema,
                count: z.number().int().min(0).max(1000),
                diagnosticCodes: PublicStringArraySchema,
                files: PublicStringArraySchema,
              })
              .strict(),
            mustRun: z
              .object({
                commands: PublicStringArraySchema,
                count: z.number().int().min(0).max(1000),
                diagnosticCodes: PublicStringArraySchema,
                files: PublicStringArraySchema,
              })
              .strict(),
            recommended: z
              .object({
                commands: PublicStringArraySchema,
                count: z.number().int().min(0).max(1000),
                diagnosticCodes: PublicStringArraySchema,
                files: PublicStringArraySchema,
              })
              .strict(),
            unknown: z
              .object({
                commands: PublicStringArraySchema,
                count: z.number().int().min(0).max(1000),
                diagnosticCodes: PublicStringArraySchema,
                files: PublicStringArraySchema,
              })
              .strict(),
          })
          .strict(),
        sourceGraphRef: PublicStringSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ExplicitGuardScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      filePath: z.string().max(1200).nullable(),
      kind: z.literal('code'),
    })
    .strict(),
  z
    .object({
      files: PublicStringArraySchema,
      kind: z.literal('files'),
    })
    .strict(),
  z
    .object({
      files: PublicStringArraySchema,
      kind: z.literal('workRef'),
      workRef: PublicStringSchema,
    })
    .strict(),
]);

const GuardResultSummarySchema = z
  .object({
    errorCount: z.number().int().min(0).max(10000).optional(),
    fileCount: z.number().int().min(0).max(1000).optional(),
    language: OptionalPublicStringSchema,
    payloadType: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null', 'undefined']),
    violationCount: z.number().int().min(0).max(10000).optional(),
    warningCount: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

const GuardPublicResultSchema = z
  .object({
    guardErrorCode: OptionalPublicStringSchema,
    ok: z.boolean(),
    resultSummary: GuardResultSummarySchema,
    summary: OptionalPublicStringSchema,
  })
  .strict();

const DecisionSummarySchema = z
  .object({
    action: OptionalPublicStringSchema,
    decisionId: OptionalPublicStringSchema,
    id: OptionalPublicStringSchema,
    status: OptionalPublicStringSchema,
    title: OptionalPublicStringSchema,
  })
  .strict();

const DecisionCapabilitySummarySchema = z
  .object({
    available: z.boolean().optional(),
    lifecycle: z.array(PublicStringSchema).max(20).optional(),
    owner: OptionalPublicStringSchema,
    route: OptionalPublicStringSchema,
  })
  .strict();

const DurableDecisionPersistenceSchema = z
  .object({
    action: z.enum(['create', 'delete', 'list', 'read', 'revoke', 'update']),
    available: z.boolean(),
    capability: DecisionCapabilitySummarySchema.nullable().optional(),
    reason: OptionalPublicStringSchema,
    requiredRoute: OptionalPublicStringSchema,
  })
  .strict();

const RequestedDecisionSchema = z
  .object({
    action: z.enum(['create', 'delete', 'list', 'read', 'revoke', 'update']),
    decisionRef: z.string().max(240).nullable(),
    description: z.string().max(2000).nullable(),
    evidenceRefs: PublicStringArraySchema,
    rationale: z.string().max(2000).nullable(),
    tags: z.array(PublicStringSchema).max(40),
    title: z.string().max(240).nullable(),
  })
  .strict();

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
    decisionNeed: z.enum(['none', 'record-if-confirmed', 'required-before-work']),
    guardNeed: z.enum(['none', 'recommend-if-code-changed', 'explicit-scope-required']),
    knowledgeNeed: z.enum(['none', 'optional', 'recommended', 'required']),
    primeNeed: z.enum(['none', 'optional', 'recommended', 'required']),
    sourceGraphNeed: z.enum(['none', 'optional', 'recommended', 'required']),
    sourceGraphPlan: z
      .object({
        action: z.enum(['skip', 'status-first', 'query-before-work', 'validation-plan-after-work']),
        reasonCode: PublicStringSchema,
        tools: z.array(PublicStringSchema).max(8),
      })
      .strict(),
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
  localRecord: IntentLocalRecordSchema.optional(),
  retrievalPlan: IntentRetrievalPlanSchema,
  recognizedIntent: RecognizedIntentPublicSchema,
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
  localRecord: WorkStartLocalRecordSchema.optional(),
  toolName: z.literal('alembic_work_start'),
  workRef: z.string().min(1).max(240).optional(),
});

export const AgentWorkFinishOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  changedFiles: z.array(z.string()).max(80).optional(),
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  evidenceRefs: z.array(z.string()).max(80).optional(),
  finishRef: z.string().min(1).max(240).optional(),
  guardRecommendation: GuardRecommendationSchema.optional(),
  localRecord: WorkFinishLocalRecordSchema.optional(),
  outcome: z.enum(['completed', 'blocked', 'abandoned']).optional(),
  sourceEvidenceRefs: z.array(z.string()).max(80).optional(),
  sourceGraphRef: z.string().min(1).max(240).optional(),
  toolName: z.literal('alembic_work_finish'),
  workRef: z.string().min(1).max(240).optional(),
});

export const AgentCodeGuardOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  explicitScope: ExplicitGuardScopeSchema.optional(),
  guard: GuardPublicResultSchema.optional(),
  guardResultRef: z.string().min(1).max(240).optional(),
  toolName: z.literal('alembic_code_guard'),
  unsupportedScopeFields: z.array(z.string()).max(20).optional(),
});

export const AgentDecisionRecordOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  count: z.number().nullable().optional(),
  decision: DecisionSummarySchema.nullable().optional(),
  decisionRef: z.string().min(1).max(240).nullable().optional(),
  decisions: z.array(DecisionSummarySchema).max(100).optional(),
  durablePersistence: DurableDecisionPersistenceSchema.optional(),
  requestedDecision: RequestedDecisionSchema.optional(),
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
  const publicPayload = normalizeAgentPublicToolPayload(result.toolName, payload);
  const response = createCleanMcpResponse(
    {
      ...publicPayload,
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
            error: createAgentPublicToolCleanError(result),
          }
        : {}),
    },
    result.toolName
  );
  return AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[result.toolName].parse(response);
}

function createAgentPublicToolCleanError(result: AgentPublicToolResultEnvelope) {
  const reason = result.reason;
  if (!reason) {
    return undefined;
  }
  const detailRefIds = result.refs.detailRefs.map((ref) => ref.id);
  const failureKind = mapAgentPublicReasonFailureKind(reason.code);
  return createCleanMcpError({
    code: reason.code,
    details: {
      publicReason: {
        code: reason.code,
        kind: reason.kind,
        retryable: reason.retryable,
      },
      ...(detailRefIds.length > 0 ? { detailRefs: detailRefIds } : {}),
    },
    failureKind,
    message: reason.message,
    source: {
      ...(detailRefIds.length > 0 ? { detailRefs: detailRefIds } : {}),
      reasonCode: failureKind,
      retryable: reason.retryable,
    },
    status: result.status,
  });
}

const AGENT_PUBLIC_REASON_FAILURE_KINDS: Readonly<Record<string, CoreFieldFailureKind>> = {
  'decision-register-capability-mismatch': 'capability-mismatch',
  'decision-register-unavailable': 'unavailable',
  'decision-scope-unconfirmed': 'needs-confirmation',
  'detail-budget-limited': 'partial',
  'handler-error': 'internal-error',
  'knowledge-empty': 'unavailable',
  'low-confidence-intent': 'degraded',
  'optional-service-unavailable': 'unavailable',
  'project-root-untrusted': 'permission-denied',
  'project-scope-unavailable': 'unavailable',
  'resident-unavailable': 'unavailable',
  'result-envelope-invalid': 'schema-drift',
  'schema-validation-failed': 'schema-drift',
  'shared-contract-required': 'capability-mismatch',
};

function mapAgentPublicReasonFailureKind(reasonCode: string): CoreFieldFailureKind {
  return AGENT_PUBLIC_REASON_FAILURE_KINDS[reasonCode] ?? 'invalid-input';
}

function normalizeAgentPublicToolPayload(
  toolName: AgentPublicToolName,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...payload };
  if (toolName === 'alembic_intent' && 'recognizedIntent' in normalized) {
    normalized.recognizedIntent = projectRecognizedIntentPublic(normalized.recognizedIntent);
  }
  if (toolName === 'alembic_code_guard' && 'guard' in normalized) {
    normalized.guard = projectGuardPublicResult(normalized.guard);
  }
  if (toolName === 'alembic_decision_record') {
    if ('decision' in normalized) {
      normalized.decision = projectDecisionSummary(normalized.decision);
    }
    if (Array.isArray(normalized.decisions)) {
      normalized.decisions = normalized.decisions
        .map(projectDecisionSummary)
        .filter((decision) => decision !== null);
    }
    if ('durablePersistence' in normalized) {
      normalized.durablePersistence = projectDurablePersistence(normalized.durablePersistence);
    }
    if ('requestedDecision' in normalized) {
      normalized.requestedDecision = projectRequestedDecision(normalized.requestedDecision);
    }
  }
  return normalized;
}

function projectRecognizedIntentPublic(
  value: unknown
): z.infer<typeof RecognizedIntentPublicSchema> {
  const record = asRecord(value);
  return {
    ...(stringFrom(record.action) ? { action: stringFrom(record.action) } : {}),
    ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? { confidence: Math.max(0, Math.min(1, record.confidence)) }
      : {}),
    ...(typeof record.degraded === 'boolean' ? { degraded: record.degraded } : {}),
    ...(stringArray(record.degradedReasons).length
      ? { degradedReasons: stringArray(record.degradedReasons, 40, 240) }
      : {}),
    ...(Array.isArray(record.evidenceSpans)
      ? { evidenceSpanCount: Math.min(record.evidenceSpans.length, 1000) }
      : {}),
    ...(stringFrom(record.language) ? { language: stringFrom(record.language) } : {}),
    query: stringFrom(record.query, 2000) ?? '',
    ...(isIntentSource(record.source) ? { source: record.source } : {}),
    ...(stringArray(record.sourceRefs).length
      ? { sourceRefs: stringArray(record.sourceRefs, 80, 1200) }
      : {}),
    ...(isIntentStatus(record.status) ? { status: record.status } : {}),
    ...(stringFrom(record.target) ? { target: stringFrom(record.target) } : {}),
  };
}

function projectGuardPublicResult(value: unknown): z.infer<typeof GuardPublicResultSchema> {
  const record = asRecord(value);
  const guardResult = asRecord(record.guardResult);
  const summary = asRecord(guardResult.summary);
  const files = Array.isArray(guardResult.files) ? guardResult.files : [];
  const violations = Array.isArray(guardResult.violations) ? guardResult.violations : [];
  const errorCount = numberFrom(summary.errors);
  const totalViolationCount = numberFrom(summary.total);
  const warningCount = numberFrom(summary.warnings);
  return {
    ...(stringFrom(record.guardErrorCode)
      ? { guardErrorCode: stringFrom(record.guardErrorCode) }
      : {}),
    ok: record.ok !== false,
    resultSummary: {
      ...(errorCount !== null ? { errorCount } : {}),
      ...(files.length ? { fileCount: Math.min(files.length, 1000) } : {}),
      ...(stringFrom(guardResult.language, 1200)
        ? { language: stringFrom(guardResult.language, 1200) }
        : {}),
      payloadType: describePayloadType(record.guardResult),
      ...(totalViolationCount !== null
        ? { violationCount: totalViolationCount }
        : violations.length
          ? { violationCount: Math.min(violations.length, 10000) }
          : {}),
      ...(warningCount !== null ? { warningCount } : {}),
    },
    ...(stringFrom(record.summary) ? { summary: stringFrom(record.summary) } : {}),
  };
}

function projectDecisionSummary(value: unknown): z.infer<typeof DecisionSummarySchema> | null {
  const record = asRecord(value);
  const decision = {
    ...(stringFrom(record.action) ? { action: stringFrom(record.action) } : {}),
    ...(stringFrom(record.decisionId) ? { decisionId: stringFrom(record.decisionId) } : {}),
    ...(stringFrom(record.id) ? { id: stringFrom(record.id) } : {}),
    ...(stringFrom(record.status) ? { status: stringFrom(record.status) } : {}),
    ...(stringFrom(record.title) ? { title: stringFrom(record.title, 240) } : {}),
  };
  return Object.keys(decision).length > 0 ? decision : null;
}

function projectDurablePersistence(
  value: unknown
): z.infer<typeof DurableDecisionPersistenceSchema> {
  const record = asRecord(value);
  return {
    action: isDecisionAction(record.action) ? record.action : 'create',
    available: record.available === true,
    ...('capability' in record ? { capability: projectDecisionCapability(record.capability) } : {}),
    ...(stringFrom(record.reason) ? { reason: stringFrom(record.reason) } : {}),
    ...(stringFrom(record.requiredRoute)
      ? { requiredRoute: stringFrom(record.requiredRoute) }
      : {}),
  };
}

function projectDecisionCapability(
  value: unknown
): z.infer<typeof DecisionCapabilitySummarySchema> | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    ...(typeof record.available === 'boolean' ? { available: record.available } : {}),
    ...(stringArray(record.lifecycle).length
      ? { lifecycle: stringArray(record.lifecycle, 20, 1200) }
      : {}),
    ...(stringFrom(record.owner) ? { owner: stringFrom(record.owner) } : {}),
    ...(stringFrom(record.route) ? { route: stringFrom(record.route) } : {}),
  };
}

function projectRequestedDecision(value: unknown): z.infer<typeof RequestedDecisionSchema> {
  const record = asRecord(value);
  return {
    action: isDecisionAction(record.action) ? record.action : 'create',
    decisionRef: stringFrom(record.decisionRef, 240) ?? null,
    description: stringFrom(record.description, 2000) ?? null,
    evidenceRefs: stringArray(record.evidenceRefs, 80, 1200),
    rationale: stringFrom(record.rationale, 2000) ?? null,
    tags: stringArray(record.tags, 40, 1200),
    title: stringFrom(record.title, 240) ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFrom(value: unknown, max = 1200): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.slice(0, max);
}

function stringArray(value: unknown, maxItems = 80, maxLength = 1200): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), 10000)
    : null;
}

function isIntentSource(value: unknown): value is 'deterministic' | 'host-declared' | 'mixed' {
  return value === 'deterministic' || value === 'host-declared' || value === 'mixed';
}

function isIntentStatus(value: unknown): value is 'recognized' | 'needs-confirmation' | 'degraded' {
  return value === 'recognized' || value === 'needs-confirmation' || value === 'degraded';
}

function isDecisionAction(
  value: unknown
): value is 'create' | 'delete' | 'list' | 'read' | 'revoke' | 'update' {
  return (
    value === 'create' ||
    value === 'delete' ||
    value === 'list' ||
    value === 'read' ||
    value === 'revoke' ||
    value === 'update'
  );
}

function describePayloadType(
  value: unknown
): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined' {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const payloadType = typeof value;
  return payloadType === 'string' ||
    payloadType === 'number' ||
    payloadType === 'boolean' ||
    payloadType === 'undefined'
    ? payloadType
    : 'object';
}

function projectAgentPublicToolOutput(input: unknown, toolName: AgentPublicToolName) {
  const schema = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName];
  return schema.parse(input);
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
