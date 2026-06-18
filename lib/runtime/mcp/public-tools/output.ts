import type { CoreFieldFailureKind } from '@alembic/core/shared';
import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpError,
  createCleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';
import {
  AGENT_PUBLIC_TOOL_ACTION_BY_NAME,
  AGENT_PUBLIC_TOOL_NAMES,
  AgentActionKindSchema,
  AgentDetailRefSchema,
  AgentHostSchema,
  AgentInputSourceSchema,
  type AgentPublicToolName,
  AgentPublicToolNameSchema,
  AgentPublicToolReasonSchema,
  AgentPublicToolRefsSchema,
  type AgentPublicToolResultEnvelope,
  AgentResultStatusSchema,
  PrimePublicPackageSchema,
} from '../../../runtime/mcp/public-tools/contract.js';

const PublicStringSchema = z.string().min(1).max(1200);
const OptionalPublicStringSchema = z.string().max(1200).optional();
const PublicStringArraySchema = z.array(PublicStringSchema).max(80);

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

export const AgentPublicToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  actionKind: AgentActionKindSchema,
  agentHost: AgentHostSchema,
  inputSource: AgentInputSourceSchema,
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

// GMAP-8: alembic_prime is a standalone agent tool with its own output (like the
// other agent-public tools) — no longer projected through KnowledgeContextToolOutput
// or the middle layer. The valuable payload is the prime-native primePackage plus
// bounded detailRefs/diagnostics/nextActions; matrix/graph/relation/interaction
// fields are gone.
const PrimeDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    retryable: z.boolean().default(false),
  })
  .strict();

const PrimeNextActionSchema = z
  .object({
    tool: z.string().min(1).max(120),
    reason: z.string().min(1).max(600),
    required: z.boolean().default(false),
  })
  .strict();

export const AgentPrimeOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  actionKind: z.literal('prime'),
  detailRefs: z.array(AgentDetailRefSchema).max(200).default([]),
  diagnostics: z.array(PrimeDiagnosticSchema).max(200).default([]),
  nextActions: z.array(PrimeNextActionSchema).max(20).default([]),
  primePackage: PrimePublicPackageSchema,
  toolName: z.literal('alembic_prime'),
}).superRefine((output, ctx) => {
  const expectedReasonKind =
    output.status === 'blocked'
      ? 'blocked'
      : output.status === 'degraded'
        ? 'degraded'
        : output.status === 'failed'
          ? 'failure'
          : output.status === 'skipped'
            ? 'skip'
            : null;
  if (expectedReasonKind && output.reason?.kind !== expectedReasonKind) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `${output.status} prime outputs require a ${expectedReasonKind} reason`,
    });
  }
});

// MTC-7: merged alembic_work_start + alembic_work_finish output. Fields are the
// union across phases (start sets workRef/localRecord; finish adds changedFiles/
// finishRef/guardRecommendation/outcome/etc.); localRecord is the per-phase union.
export const AgentWorkOutputSchema = AgentPublicToolOutputBaseSchema.safeExtend({
  changedFiles: z.array(z.string()).max(80).optional(),
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  evidenceRefs: z.array(z.string()).max(80).optional(),
  finishRef: z.string().min(1).max(240).optional(),
  guardRecommendation: GuardRecommendationSchema.optional(),
  localRecord: z.union([WorkStartLocalRecordSchema, WorkFinishLocalRecordSchema]).optional(),
  outcome: z.enum(['completed', 'blocked', 'abandoned']).optional(),
  sourceEvidenceRefs: z.array(z.string()).max(80).optional(),
  toolName: z.literal('alembic_work'),
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

export const AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS = {
  alembic_code_guard: AgentCodeGuardOutputSchema,
  alembic_prime: AgentPrimeOutputSchema,
  alembic_work: AgentWorkOutputSchema,
} as const;

export type AgentPublicToolOutput = z.infer<typeof AgentPublicToolOutputBaseSchema>;

export function createAgentPublicToolOutput(
  result: AgentPublicToolResultEnvelope,
  payload: Record<string, unknown> = {},
  options: { ok?: boolean } = {}
): AgentPublicToolOutput {
  const ok = options.ok ?? (result.status !== 'blocked' && result.status !== 'failed');
  const publicPayload = normalizeAgentPublicToolPayload(result.toolName, payload);
  let response = createCleanMcpResponse(
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
      ...(result.reason ? { reason: result.reason } : {}),
      ...(!ok && result.reason
        ? {
            error: createAgentPublicToolCleanError(result),
          }
        : {}),
    },
    result.toolName
  );
  if (result.toolName === 'alembic_prime') {
    response = scrubPrimeOutputRelationSurface(response) as typeof response;
  }
  const parsed = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[result.toolName].parse(response);
  if (result.toolName === 'alembic_prime') {
    return scrubPrimeOutputRelationSurface(parsed) as AgentPublicToolOutput;
  }
  return parsed;
}

function scrubPrimeOutputRelationSurface(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => scrubPrimeOutputRelationSurface(item))
      .filter((item) => item !== 'recipeRelation');
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      return value.replace(/\brecipeRelation\b/g, 'knowledge');
    }
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'recipeRelation' ||
      key === 'recipeRelationCount' ||
      key === 'relationChainCount' ||
      key === 'relationHopLimit'
    ) {
      continue;
    }
    output[key] = scrubPrimeOutputRelationSurface(fieldValue);
  }
  return output;
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
  if (toolName === 'alembic_code_guard' && 'guard' in normalized) {
    normalized.guard = projectGuardPublicResult(normalized.guard);
  }
  return normalized;
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

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), 10000)
    : null;
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
