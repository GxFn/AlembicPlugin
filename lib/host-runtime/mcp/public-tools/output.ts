import type { CoreFieldFailureKind } from '@alembic/core/shared';
import { z } from 'zod';
import {
  CollectionCoverageSchema,
  ConclusionDispositionSchema,
} from '#service/project-knowledge-context/contracts/ToolOutputPrimitives.js';
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
  type AgentPublicToolName,
  AgentPublicToolNameSchema,
  AgentPublicToolReasonSchema,
  AgentPublicToolRefsSchema,
  type AgentPublicToolResultEnvelope,
  AgentResultStatusSchema,
  createPrimePublicPackage,
  PrimePublicPackageSchema,
} from './contract.js';

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

// G2 应用规则摘要（2026-07-06）：guard 内层 data.appliedRules 此前在本投影层被
// 静默丢弃（projectGuardPublicResult 只折叠 resultSummary 计数），宿主无法回答
// "0 violations 是没有适用规则还是检查通过"。公开面透传 total/bySource/sample。
const GuardAppliedRulesSchema = z
  .object({
    total: z.number().int().min(0).max(100000),
    complete: z.literal(false).optional(),
    enumerationScope: z.literal('engine-getRules').optional(),
    bySource: z.record(z.string().max(240), z.number().int().min(0).max(100000)),
    sample: z
      .array(
        z
          .object({
            id: z.string().max(240),
            name: z.string().max(1200),
            severity: z.string().max(80),
            source: z.string().max(240),
          })
          .strict()
      )
      .max(10),
  })
  .strict();

const GuardRuleAccountingSchema = z
  .object({
    accountingMode: z.literal('separate-execution-modes'),
    countsAreAdditive: z.literal(false),
    enumeratedEngineRules: z.number().int().min(0).max(100000),
    additionalEngineChecks: z.literal('not-enumerated'),
    hostEvaluationRequired: z.number().int().min(0).max(100000),
  })
  .strict();

const GuardFixGuidanceSchema = z
  .object({
    inlineRecipe: z.number().int().min(0).max(100000),
    fixSuggestionOnly: z.number().int().min(0).max(100000),
    unavailable: z.number().int().min(0).max(100000),
  })
  .strict();

// G-B（2026-07-06）：适用 Recipe 规矩清单——refs 精确文件匹配的确定性交付，
// 宿主 agent 据 doClause/dontClause 判断（Recipe 是自然语言规则，判断者=宿主 LLM）。
const GuardApplicableRecipeRuleSchema = z
  .object({
    recipeId: z.string().min(1).max(240),
    title: z.string().min(1).max(1200),
    trigger: z.string().max(240).optional(),
    kind: z.string().max(80).optional(),
    doClause: z.string().max(2000).optional(),
    dontClause: z.string().max(2000).optional(),
    sourceRef: z.string().min(1).max(1200),
  })
  .strict();

// V-1（2026-07-06 多场景终测）：此前公开面只折叠计数——宿主拿到"2 个违规"却不知
// 在哪行、违反了什么、怎么修（明细被投影层丢弃，同族第五例）。守门工具的修复
// 闭环必须交付明细：行号/规则/消息/片段/修复建议 + Recipe 修复指南（review 路径
// _loadRuleRecipes 内联的 doClause/dontClause）。cap 50 防爆，字符串按 schema 上限钳制。
const GuardPublicViolationSchema = z
  .object({
    filePath: z.string().max(1200).optional(),
    line: z.number().int().min(0).max(1000000).optional(),
    ruleId: z.string().max(240),
    severity: z.string().max(80),
    message: z.string().max(1200),
    snippet: z.string().max(240).optional(),
    fixSuggestion: z.string().max(1200).optional(),
    recipe: z
      .object({
        title: z.string().max(1200),
        doClause: z.string().max(2000).optional(),
        dontClause: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const GuardCoverageSchema = CollectionCoverageSchema.extend({
  checked: z.number().int().min(0).max(100000),
  missing: z.number().int().min(0).max(100000),
  unreadable: z.number().int().min(0).max(100000),
  outOfRoot: z.number().int().min(0).max(100000),
  unsupported: z.number().int().min(0).max(100000),
}).strict();

const GuardFileErrorSchema = z
  .object({
    filePath: z.string().min(1).max(1200),
    requestedPath: z.string().max(1200).optional(),
    disposition: z.enum(['missing', 'unreadable', 'out-of-root', 'unsupported']),
    message: z.string().max(1200).optional(),
  })
  .strict();

const GuardUncertainSchema = z.object({ count: z.number().int().min(0).max(100000) }).strict();

const GuardPublicResultSchema = z
  .object({
    appliedRules: GuardAppliedRulesSchema.optional(),
    applicableRecipeRules: z.array(GuardApplicableRecipeRuleSchema).max(20).optional(),
    ruleAccounting: GuardRuleAccountingSchema.optional(),
    fixGuidance: GuardFixGuidanceSchema.optional(),
    coverage: GuardCoverageSchema.optional(),
    crossFileViolations: z.array(GuardPublicViolationSchema).max(50).optional(),
    fileErrors: z.array(GuardFileErrorSchema).max(1000).optional(),
    guardErrorCode: OptionalPublicStringSchema,
    maxRoundsReached: z.boolean().optional(),
    ok: z.boolean(),
    reviewRound: z.number().int().min(1).max(100000).optional(),
    resultSummary: GuardResultSummarySchema,
    summary: OptionalPublicStringSchema,
    uncertain: GuardUncertainSchema.optional(),
    verdict: ConclusionDispositionSchema.optional(),
    violations: z.array(GuardPublicViolationSchema).max(50).optional(),
    violationsTruncated: z.boolean().optional(),
  })
  .strict();

// prime→guard step1 observe-only 观测面（2026-07-06 真机炸链修复）：handler 注入
// primeAlignment 但本严格输出 schema 未声明 → 凡带 primeRef 的 guard 调用在
// 输出 parse 处 unrecognized_keys 整体失败（与 initializationSource 同型事故）。
// 两形态：observed（命中本会话 prime 交付记录）/ prime-ref-unknown（跨会话诚实降级）。
const GuardPrimeAlignmentSchema = z
  .object({
    primeRef: z.string().min(1).max(240),
    status: z.enum(['observed', 'prime-ref-unknown']),
    note: OptionalPublicStringSchema,
    deliveredKnowledgeCount: z.number().int().min(0).max(1000).optional(),
    deliveredGuardCount: z.number().int().min(0).max(1000).optional(),
    overlappedKnowledgeCount: z.number().int().min(0).max(1000).optional(),
    overlappedGuardIds: PublicStringArraySchema.optional(),
    appliedGuardIds: PublicStringArraySchema.optional(),
    violatedGuardIds: PublicStringArraySchema.optional(),
    feedbackGuardIds: PublicStringArraySchema.optional(),
    feedbackRecorded: z.boolean().optional(),
    coverageComplete: z.boolean().optional(),
    overlappedKnowledge: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            title: z.string().min(1).max(1200),
            matchedFiles: z.array(z.string().min(1).max(1200)).max(80),
          })
          .strict()
      )
      .max(5)
      .optional(),
  })
  .strict();

const AgentCodeGuardDataSchema = z.object({}).strict();

export const PrimeDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    retryable: z.boolean().default(false),
  })
  .strict();

const AgentPublicToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  actionKind: AgentActionKindSchema,
  agentHost: AgentHostSchema,
  inputSource: AgentInputSourceSchema,
  reason: AgentPublicToolReasonSchema.optional(),
  refs: AgentPublicToolRefsSchema,
  status: AgentResultStatusSchema,
  toolName: AgentPublicToolNameSchema,
  // 诊断通道提升为三工具通用面（2026-07-06 投影防崩配套）：output-projection-rejected
  // 等边界降级诊断必须能出现在任何公开工具的信封上，而不是 prime 独有。
  diagnostics: z.array(PrimeDiagnosticSchema).max(200).optional(),
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

// MTC-7: merged the former split work lifecycle output. Fields are the
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
  data: AgentCodeGuardDataSchema.optional(),
  detailRefs: z.array(AgentDetailRefSchema).max(40).optional(),
  explicitScope: ExplicitGuardScopeSchema.optional(),
  guard: GuardPublicResultSchema.optional(),
  guardResultRef: z.string().min(1).max(240).optional(),
  primeAlignment: GuardPrimeAlignmentSchema.optional(),
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
  // 投影边界防崩（2026-07-06 架构化，五连 schema 事故根治）：strict schema 仍是
  // 公开契约门，但 parse 失败不再让整个工具输出崩掉（primeAlignment/actionHint
  // 两次真机整体拒绝的教训）。Prime 的 schema 要求 primePackage，因此降级也必须
  // 保持 Prime 契约形状；有效 package 原样保留，坏 package 只保留 refs/候选标识。
  const parsed = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[result.toolName].safeParse(response);
  if (parsed.success) {
    if (result.toolName === 'alembic_prime') {
      return scrubPrimeOutputRelationSurface(parsed.data) as AgentPublicToolOutput;
    }
    return parsed.data;
  }
  const issueSummary = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
    .join('; ')
    .slice(0, 600);
  process.stderr.write(
    `[MCP/PublicTools] ${result.toolName} output projection rejected; degraded to base envelope: ${issueSummary}\n`
  );
  const projectionDiagnostic = {
    code: 'output-projection-rejected',
    severity: 'error' as const,
    message: `Business payload was withheld because it violated the public output schema (${issueSummary}). The tool ran; fix the projection.`,
    retryable: false,
  };
  const fallback = createCleanMcpResponse(
    {
      ...createAgentPublicProjectionFallback(result, publicPayload, projectionDiagnostic),
      actionKind: result.actionKind,
      agentHost: result.agentHost,
      inputSource: result.inputSource,
      ok,
      refs: result.refs,
      status: result.status,
      summary: result.summary,
      toolName: result.toolName,
      ...(result.reason ? { reason: result.reason } : {}),
    },
    result.toolName
  );
  const reparsed = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS[result.toolName].safeParse(fallback);
  if (reparsed.success) {
    return reparsed.data;
  }
  // base envelope 也不过 schema = 契约本身坏了，保留旧的硬失败语义暴露问题。
  throw parsed.error;
}

function createAgentPublicProjectionFallback(
  result: AgentPublicToolResultEnvelope,
  publicPayload: Record<string, unknown>,
  diagnostic: z.infer<typeof PrimeDiagnosticSchema>
): Record<string, unknown> {
  if (result.toolName !== 'alembic_prime') {
    return { diagnostics: [diagnostic] };
  }

  const packageResult = PrimePublicPackageSchema.safeParse(publicPayload.primePackage);
  return {
    detailRefs: mergePrimeFallbackDetailRefs(result.refs.detailRefs, publicPayload.detailRefs),
    diagnostics: [diagnostic],
    nextActions: [],
    primePackage: packageResult.success
      ? packageResult.data
      : createPrimeProjectionFallbackPackage(result, publicPayload.primePackage),
  };
}

function mergePrimeFallbackDetailRefs(
  resultRefs: z.infer<typeof AgentDetailRefSchema>[],
  payloadRefs: unknown
): z.infer<typeof AgentDetailRefSchema>[] {
  const merged = new Map<string, z.infer<typeof AgentDetailRefSchema>>();
  for (const candidate of [...resultRefs, ...(Array.isArray(payloadRefs) ? payloadRefs : [])]) {
    const parsed = AgentDetailRefSchema.safeParse(candidate);
    if (parsed.success && !merged.has(parsed.data.id)) {
      merged.set(parsed.data.id, parsed.data);
    }
    if (merged.size >= 200) {
      break;
    }
  }
  return [...merged.values()];
}

function createPrimeProjectionFallbackPackage(
  result: AgentPublicToolResultEnvelope,
  rawPackage: unknown
) {
  const packageRecord = asRecord(rawPackage);
  const compactRecord = asRecord(packageRecord.compactPackage);
  const guidanceRecord = asRecord(packageRecord.projectContextGuidance);
  const candidateRecipeIds = boundedStringArray(compactRecord.candidateRecipeIds, 100, 240);
  const sourceEvidenceRefs = boundedStringArray(guidanceRecord.sourceEvidenceRefs, 40, 240);
  return createPrimePublicPackage({
    compactPackage: {
      acceptedGuards: [],
      acceptedKnowledge: [],
      candidateRecipeIds,
      counts: {
        acceptedGuards: 0,
        acceptedKnowledge: 0,
        detailRefs: result.refs.detailRefs.length,
        omittedFromCompact: 0,
      },
      detailRefsMode: 'ref-based',
      evidenceDelivery: 'detailRefs-and-primeKnowledgeMaterial',
    },
    kind: 'PrimePublicPackage',
    primeRef:
      result.refs.primeRef?.id ?? stringFrom(packageRecord.primeRef, 240) ?? 'prime-fallback',
    projectContextGuidance: {
      boundary: 'Prime business projection was rejected; use preserved refs for diagnosis.',
      projectContextRefs: boundedStringArray(guidanceRecord.projectContextRefs, 40, 240),
      recommendedQueries: [],
      recommendedTools: boundedStringArray(guidanceRecord.recommendedTools, 8, 120),
      sourceEvidenceRefs,
      status: 'degraded',
    },
    ...(result.reason ? { reason: result.reason } : {}),
    refs: result.refs,
    status: result.status,
    summary: result.summary,
  });
}

function boundedStringArray(value: unknown, limit: number, itemLimit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((item) => {
      const normalized = typeof item === 'string' ? item.trim().slice(0, itemLimit) : '';
      return normalized ? [normalized] : [];
    })
    .slice(0, limit);
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
  'guard-coverage-incomplete': 'unavailable',
  'guard-scope-invalid': 'permission-denied',
  'handler-error': 'internal-error',
  'knowledge-empty': 'unavailable',
  'low-confidence-intent': 'degraded',
  'optional-service-unavailable': 'unavailable',
  'project-root-untrusted': 'permission-denied',
  'project-isolation-unconfirmed': 'conflict',
  'project-scope-unavailable': 'unavailable',
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
  return {
    ...projectGuardRuleDetails(guardResult),
    ...projectGuardViolationDetails(guardResult),
    ...projectGuardStatusDetails(record, guardResult),
    ok: record.ok !== false,
    resultSummary: projectGuardResultSummary(record, guardResult),
  };
}

function projectGuardRuleDetails(
  guardResult: Record<string, unknown>
): Partial<z.infer<typeof GuardPublicResultSchema>> {
  const appliedRules = projectGuardAppliedRules(guardResult.appliedRules);
  const ruleAccounting = GuardRuleAccountingSchema.safeParse(guardResult.ruleAccounting);
  const fixGuidance = GuardFixGuidanceSchema.safeParse(guardResult.fixGuidance);
  const applicableRecipeRules = projectGuardApplicableRecipeRules(
    guardResult.applicableRecipeRules
  );
  const coverage = projectGuardCoverage(guardResult.coverage);
  return {
    ...(appliedRules ? { appliedRules } : {}),
    ...(ruleAccounting.success ? { ruleAccounting: ruleAccounting.data } : {}),
    ...(fixGuidance.success ? { fixGuidance: fixGuidance.data } : {}),
    ...(applicableRecipeRules.length > 0 ? { applicableRecipeRules } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

function projectGuardViolationDetails(
  guardResult: Record<string, unknown>
): Partial<z.infer<typeof GuardPublicResultSchema>> {
  const projectedViolations = projectGuardViolations(guardResult);
  const crossFileViolations = projectGuardViolations({
    violations: guardResult.crossFileViolations,
  });
  const fileErrors = projectGuardFileErrors(guardResult.fileErrors);
  return {
    ...(crossFileViolations.violations.length > 0
      ? { crossFileViolations: crossFileViolations.violations }
      : {}),
    ...(fileErrors.length > 0 ? { fileErrors } : {}),
    ...(projectedViolations.violations.length > 0
      ? { violations: projectedViolations.violations }
      : {}),
    ...(projectedViolations.truncated ? { violationsTruncated: true } : {}),
  };
}

function projectGuardStatusDetails(
  record: Record<string, unknown>,
  guardResult: Record<string, unknown>
): Partial<z.infer<typeof GuardPublicResultSchema>> {
  const guardErrorCode = stringFrom(record.guardErrorCode);
  const reviewRound = numberFrom(guardResult.reviewRound);
  const summary = stringFrom(record.summary);
  const uncertainCount = numberFrom(asRecord(guardResult.uncertainSummary).total);
  const verdict = ConclusionDispositionSchema.safeParse(guardResult.verdict);
  return {
    ...(guardErrorCode ? { guardErrorCode } : {}),
    ...(typeof guardResult.maxRoundsReached === 'boolean'
      ? { maxRoundsReached: guardResult.maxRoundsReached }
      : {}),
    ...(reviewRound !== null ? { reviewRound } : {}),
    ...(summary ? { summary } : {}),
    ...(uncertainCount !== null ? { uncertain: { count: uncertainCount } } : {}),
    ...(verdict.success ? { verdict: verdict.data } : {}),
  };
}

function projectGuardResultSummary(
  record: Record<string, unknown>,
  guardResult: Record<string, unknown>
): z.infer<typeof GuardResultSummarySchema> {
  const summary = asRecord(guardResult.summary);
  const files = Array.isArray(guardResult.files) ? guardResult.files : [];
  const violations = Array.isArray(guardResult.violations) ? guardResult.violations : [];
  const errorCount = numberFrom(summary.errors);
  const totalViolationCount = numberFrom(summary.total);
  const warningCount = numberFrom(summary.warnings);
  const language = stringFrom(guardResult.language, 1200);
  return {
    ...(errorCount !== null ? { errorCount } : {}),
    ...(files.length ? { fileCount: Math.min(files.length, 1000) } : {}),
    ...(language ? { language } : {}),
    payloadType: describePayloadType(record.guardResult),
    ...(totalViolationCount !== null
      ? { violationCount: totalViolationCount }
      : violations.length
        ? { violationCount: Math.min(violations.length, 10000) }
        : {}),
    ...(warningCount !== null ? { warningCount } : {}),
  };
}

function projectGuardCoverage(value: unknown): z.infer<typeof GuardCoverageSchema> | null {
  const parsed = GuardCoverageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function projectGuardFileErrors(value: unknown): Array<z.infer<typeof GuardFileErrorSchema>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const projected: Array<z.infer<typeof GuardFileErrorSchema>> = [];
  for (const entry of value.slice(0, 1000)) {
    const parsed = GuardFileErrorSchema.safeParse(entry);
    if (parsed.success) {
      projected.push(parsed.data);
    }
  }
  return projected;
}

/** G2：从内层 guardResult.appliedRules 提取公开摘要；形态不符时返回 null（不破坏 guard 输出）。 */
function projectGuardAppliedRules(value: unknown): z.infer<typeof GuardAppliedRulesSchema> | null {
  const record = asRecord(value);
  const total = numberFrom(record.total);
  if (total === null) {
    return null;
  }
  const bySourceRaw = asRecord(record.bySource);
  const bySource: Record<string, number> = {};
  for (const [source, count] of Object.entries(bySourceRaw)) {
    const parsed = numberFrom(count);
    if (parsed !== null) {
      bySource[source.slice(0, 240)] = parsed;
    }
  }
  const sample = (Array.isArray(record.sample) ? record.sample : [])
    .slice(0, 10)
    .map((entry) => {
      const rule = asRecord(entry);
      return {
        id: String(rule.id ?? '').slice(0, 240),
        name: String(rule.name ?? '').slice(0, 1200),
        severity: String(rule.severity ?? 'warning').slice(0, 80),
        source: String(rule.source ?? 'unknown').slice(0, 240),
      };
    })
    .filter((rule) => rule.id.length > 0);
  return {
    total,
    ...(record.complete === false ? { complete: false as const } : {}),
    ...(record.enumerationScope === 'engine-getRules'
      ? { enumerationScope: 'engine-getRules' as const }
      : {}),
    bySource,
    sample,
  };
}

const GUARD_PUBLIC_VIOLATION_LIMIT = 50;

/**
 * V-1：内层违规明细的公开投影。check 路径明细在 guardResult.violations；review
 * 路径在 guardResult.files[].violations（含 _loadRuleRecipes 内联的 recipe 修复
 * 指南）。扁平化统一，字符串按公开 schema 上限钳制，cap 50 超限置 truncated。
 */
function projectGuardViolations(guardResult: Record<string, unknown>): {
  violations: Array<z.infer<typeof GuardPublicViolationSchema>>;
  truncated: boolean;
} {
  const raw: Array<{ violation: Record<string, unknown>; filePath?: string }> = [];
  for (const entry of Array.isArray(guardResult.violations) ? guardResult.violations : []) {
    raw.push({ violation: asRecord(entry) });
  }
  for (const file of Array.isArray(guardResult.files) ? guardResult.files : []) {
    const fileRecord = asRecord(file);
    const filePath = stringFrom(fileRecord.filePath, 1200);
    for (const entry of Array.isArray(fileRecord.violations) ? fileRecord.violations : []) {
      raw.push({ violation: asRecord(entry), ...(filePath ? { filePath } : {}) });
    }
  }
  const truncated = raw.length > GUARD_PUBLIC_VIOLATION_LIMIT;
  const violations = raw
    .slice(0, GUARD_PUBLIC_VIOLATION_LIMIT)
    .flatMap(({ violation, filePath }) => {
      const ruleId = stringFrom(violation.ruleId, 240);
      const message = stringFrom(violation.message, 1200);
      if (!ruleId || !message) {
        return [];
      }
      const line = numberFrom(violation.line);
      const recipeRecord = asRecord(violation.recipe);
      const recipeTitle = stringFrom(recipeRecord.title, 1200);
      return [
        {
          ...(filePath ? { filePath } : {}),
          ...(line !== null && line >= 0 ? { line } : {}),
          ruleId,
          severity: stringFrom(violation.severity, 80) ?? 'warning',
          message,
          ...(stringFrom(violation.snippet, 240)
            ? { snippet: stringFrom(violation.snippet, 240) }
            : {}),
          ...(stringFrom(violation.fixSuggestion, 1200)
            ? { fixSuggestion: stringFrom(violation.fixSuggestion, 1200) }
            : {}),
          ...(recipeTitle
            ? {
                recipe: {
                  title: recipeTitle,
                  ...(stringFrom(recipeRecord.doClause, 2000)
                    ? { doClause: stringFrom(recipeRecord.doClause, 2000) }
                    : {}),
                  ...(stringFrom(recipeRecord.dontClause, 2000)
                    ? { dontClause: stringFrom(recipeRecord.dontClause, 2000) }
                    : {}),
                },
              }
            : {}),
        },
      ];
    });
  return { violations, truncated };
}

/** G-B：内层 guardResult.applicableRecipeRules 的公开投影；形态不符逐条丢弃。 */
function projectGuardApplicableRecipeRules(
  value: unknown
): Array<z.infer<typeof GuardApplicableRecipeRuleSchema>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 20).flatMap((entry) => {
    const row = asRecord(entry);
    const recipeId = stringFrom(row.recipeId, 240);
    const title = stringFrom(row.title, 1200);
    const sourceRef = stringFrom(row.sourceRef, 1200);
    if (!recipeId || !title || !sourceRef) {
      return [];
    }
    return [
      {
        recipeId,
        title,
        ...(stringFrom(row.trigger, 240) ? { trigger: stringFrom(row.trigger, 240) } : {}),
        ...(stringFrom(row.kind, 80) ? { kind: stringFrom(row.kind, 80) } : {}),
        ...(stringFrom(row.doClause, 2000) ? { doClause: stringFrom(row.doClause, 2000) } : {}),
        ...(stringFrom(row.dontClause, 2000)
          ? { dontClause: stringFrom(row.dontClause, 2000) }
          : {}),
        sourceRef,
      },
    ];
  });
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
