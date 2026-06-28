import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpError,
  createCleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';

// MTC-4: alembic_health merged into alembic_status, whose single output projector
// is homed in codex-local/output (cross-server runtime-diagnostic tool).
export const CORE_CLEAN_OUTPUT_TOOL_NAMES = [
  'alembic_knowledge',
  'alembic_structure',
  'alembic_call_context',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_evolve',
  'alembic_consolidate',
  'alembic_dimension_complete',
  'alembic_knowledge_lifecycle',
] as const;

export type CoreCleanOutputToolName = (typeof CORE_CLEAN_OUTPUT_TOOL_NAMES)[number];

export const CoreCleanOutputToolNameSchema = z.enum(CORE_CLEAN_OUTPUT_TOOL_NAMES);

export const CORE_FORBIDDEN_BUSINESS_OUTPUT_KEYS = new Set([
  'codexProjectScopeExecution',
  'diagnostics',
  'enhancementRoute',
  'hostProjectAlignment',
  'legacyBoundary',
  'legacyCompatibility',
  'maxChars',
  'metadata',
  'outputBudget',
  'projectRuntime',
  'residentSearch',
  'residentService',
  'residentVector',
  'retrievalConsumer',
  'runtimePolicy',
  'searchMeta',
  'serviceBoundary',
  'sourcePolicy',
  'telemetry',
  'truncated',
  'usedChars',
]);

export const CORE_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS = new Set([
  'data',
  'errorCode',
  'message',
  'result',
  'success',
]);

const CORE_SENSITIVE_BUSINESS_OUTPUT_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authheader',
  'authorization',
  'bearertoken',
  'cookie',
  'internaltelemetry',
  'password',
  'privatedaemonurl',
  'providerprivatetrace',
  'refreshtoken',
  'secret',
  'secrettoken',
  'setcookie',
]);

const RESERVED_TOP_LEVEL_FIELD_RENAMES: Record<string, string> = {
  data: 'businessData',
  error: 'businessError',
  errorCode: 'businessErrorCode',
  message: 'businessMessage',
  meta: 'businessMeta',
  ok: 'businessOk',
  result: 'businessResult',
  status: 'businessStatus',
  success: 'businessSuccess',
  summary: 'businessSummary',
  toolName: 'businessToolName',
};

const ALLOWED_CLEAN_META_KEYS = new Set([
  'coverageLedgerSeed',
  'fullBriefingRef',
  'fullMapRef',
  'responseTimeMs',
  'source',
]);

export const CORE_BASE_OUTPUT_FIELD_NAMES = [
  'error',
  'meta',
  'ok',
  'status',
  'summary',
  'toolName',
] as const;

export const CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES = {
  alembic_bootstrap: [
    'bootstrapState',
    'currentDimensionGuidance',
    'currentDimensionNextActions',
    'fileCount',
    'files',
    'gates',
    'guardAudit',
    'hostAgentContract',
    'dimensions',
    'cleanupPolicy',
    'executionPlan',
    'generationStage',
    'initialToolBriefing',
    'moduleScope',
    'planGate',
    'planState',
    'progress',
    'projectContextCreationGuide',
    'projectRoot',
    'recipeCreationNextActions',
    'repairState',
    'session',
    'targets',
    'testMode',
    'toolCapabilities',
    'businessMessage',
  ],
  alembic_call_context: [
    'callees',
    'callers',
    'direction',
    'impact',
    'maxDepth',
    'methodName',
    'note',
  ],
  alembic_consolidate: ['errors', 'kept', 'merged', 'processed', 'rejected'],
  alembic_dimension_complete: [
    'accumulatedHints',
    'businessStatus',
    'candidateCount',
    'completenessCritic',
    'completed',
    'completedDimensions',
    'dimensionId',
    'evidenceHints',
    'ideAgentAnalysisProgress',
    'isBootstrapComplete',
    'nextActions',
    'progress',
    'projectSkillDelivery',
    'qualityFeedback',
    'recipesBound',
    'remainingDimensions',
    'skillCreated',
    'subpackageCoverageWarning',
    'updated',
  ],
  alembic_evolve: [
    'deprecated',
    'errors',
    'freshness',
    'processed',
    'proposed',
    'quotaChange',
    'refreshed',
    'retrievalMayBeStale',
    'skipped',
  ],
  alembic_knowledge: [
    'businessMessage',
    'category',
    'complexity',
    'constraints',
    'content',
    'count',
    'createdAt',
    'createdBy',
    'description',
    'feedback',
    'headers',
    'id',
    'items',
    'kind',
    'knowledgeType',
    'language',
    'lifecycle',
    'quality',
    'reasoning',
    'recipeId',
    'relations',
    'scope',
    'stats',
    'tags',
    'title',
    'total',
    'trigger',
    'updatedAt',
    'usageType',
  ],
  alembic_knowledge_lifecycle: [
    'action',
    'businessMessage',
    'entry',
    'id',
    'lifecycle',
    'newStatus',
    'operation',
    'title',
    'updated',
  ],
  alembic_plan: [
    'agentDecisionChecklist',
    'candidateDimensions',
    'nextActions',
    'operation',
    'planDiagnostics',
    'planSelection',
    'projectInfoTree',
    'projectRoot',
    'warnings',
  ],
  alembic_project_skill: [
    'businessError',
    'businessMessage',
    'businessStatus',
    'content',
    'deliveryReceipt',
    'description',
    'exportResult',
    'knowledgeScope',
    'name',
    'operation',
    'receipt',
    'receiptId',
    'runtimeExport',
    'skillName',
    'skills',
    'source',
    'title',
    'warnings',
  ],
  alembic_rescan: [
    'allRecipes',
    // U2d：覆盖账本咨询（三停止 + 高价值空白 + 价值排序缺口 + 建议）；advisory 不阻断。
    'coverageAdvisory',
    'dimensions',
    'cleanupPolicy',
    'evidencePlan',
    'evolution',
    'executionDimensions',
    'executionPlan',
    'generationStage',
    'generationChangeLog',
    // U2e：退役 git-diff 增量生成杂质——gitDiffEvidence / moduleMiningRoutes 不再透出 rescan 业务输出
    //（生成已于 750ef70 退役、moduleMiningRoutes 恒空）；维护 pendingProposals/generationChangeLog 保留。
    'moduleScope',
    'pendingProposals',
    'planGate',
    'planState',
    'produceDimensions',
    'proposals',
    'projectContextCreationGuide',
    'projectRoot',
    'recipeCreationNextActions',
    'requestedDimensions',
    'reasons',
    'testMode',
    'unifiedEvolution',
  ],
  alembic_structure: [
    'businessSummary',
    'dependencies',
    'fileCount',
    'files',
    'framework',
    'graphEdges',
    'inferredRole',
    'language',
    'languageStats',
    'name',
    'packageDir',
    'packageName',
    'packagePath',
    'packageSwift',
    'packageTargets',
    'path',
    'sources',
    'sourcesPath',
    'targetDir',
    'targetName',
    'targets',
    'totalAvailable',
    'type',
  ],
  alembic_submit_knowledge: [
    'blockedItems',
    'blockedSummary',
    'businessStatus',
    'commonErrors',
    'count',
    'degraded',
    'degradedReasons',
    'evidenceGate',
    'finality',
    'freshness',
    'ideAgentAnalysisLinkage',
    'ids',
    'nextAction',
    'nextActionBlocked',
    'pendingSemanticReview',
    'problem',
    'proposalSummary',
    'proposals',
    'rejectedItems',
    'rejectedSummary',
    'relationshipGrounding',
    'requiredFields',
    'retrievalMayBeStale',
    'total',
  ],
} as const satisfies Record<CoreCleanOutputToolName, readonly string[]>;

export type CoreToolCleanOutput = z.infer<typeof CleanMcpResponseBaseSchema> & {
  toolName: CoreCleanOutputToolName;
} & Record<string, unknown>;

type CoreToolOutputSchema = z.ZodType<CoreToolCleanOutput>;

export const CoreToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  toolName: CoreCleanOutputToolNameSchema,
}).strict();

export const CORE_TOOL_OUTPUT_SCHEMAS = Object.fromEntries(
  CORE_CLEAN_OUTPUT_TOOL_NAMES.map((toolName) => [
    toolName,
    createCoreToolOutputSchema(toolName, CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]),
  ])
) as unknown as Record<CoreCleanOutputToolName, CoreToolOutputSchema>;

export function projectCoreToolOutput(
  input: unknown,
  toolName: CoreCleanOutputToolName
): CoreToolCleanOutput {
  const schema = CORE_TOOL_OUTPUT_SCHEMAS[toolName];
  const alreadyClean = schema.safeParse(input);
  if (alreadyClean.success) {
    return alreadyClean.data;
  }

  const legacy = isRecord(input) ? input : {};
  const ok = typeof legacy.success === 'boolean' ? legacy.success : legacy.errorCode == null;
  const business = sanitizeBusinessFields(extractLegacyBusinessValue(legacy), toolName);
  const cleanMeta = pickCleanMeta(legacy.meta, toolName);
  const errorDetails = pickLegacyErrorDetails(legacy);
  const summary = buildCoreToolSummary(toolName, {
    business,
    errorDetails,
    message: typeof legacy.message === 'string' ? legacy.message : '',
    ok,
  });
  const errorCode = extractLegacyErrorCode(legacy, errorDetails);
  const status = deriveCoreToolStatus({ business, errorCode, ok });
  const response = createCleanMcpResponse(
    {
      ...business,
      ok,
      status,
      summary,
      toolName,
      ...(!ok
        ? {
            error: createCleanMcpError({
              code: errorCode || 'TOOL_FAILED',
              ...(errorDetails === null ? {} : { details: errorDetails }),
              message: summary,
              source: errorDetails ?? legacy,
              status,
            }),
          }
        : {}),
      ...(cleanMeta ? { meta: cleanMeta } : {}),
    },
    toolName
  );
  return schema.parse(response);
}

export function findForbiddenCoreOutputField(
  value: unknown,
  path: string[] = []
): { path: string[] } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenCoreOutputField(item, [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (path.length === 0 && CORE_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key)) {
      return { path: [key] };
    }
    if (path[0] !== 'meta' && isSensitiveCoreOutputKey(key)) {
      return { path: [...path, key] };
    }
    if (path[0] !== 'meta' && CORE_FORBIDDEN_BUSINESS_OUTPUT_KEYS.has(key)) {
      return { path: [...path, key] };
    }
    if (path.length === 0 && key === 'meta') {
      continue;
    }
    const found = findForbiddenCoreOutputField(child, [...path, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function createCoreToolOutputSchema(
  toolName: CoreCleanOutputToolName,
  businessFields: readonly string[]
): CoreToolOutputSchema {
  const shape: Record<string, z.ZodType> = { toolName: z.literal(toolName) };
  for (const fieldName of businessFields) {
    shape[fieldName] = z.unknown().optional();
  }
  return CleanMcpResponseBaseSchema.extend(shape)
    .strict()
    .superRefine((output, ctx) => {
      const forbidden = findForbiddenCoreOutputField(output);
      if (forbidden) {
        ctx.addIssue({
          code: 'custom',
          path: forbidden.path,
          message: `Core MCP clean output must not expose ${forbidden.path.join('.')}`,
        });
      }
    }) as unknown as CoreToolOutputSchema;
}

function extractLegacyBusinessValue(value: Record<string, unknown>): unknown {
  if ('data' in value) {
    return value.data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CORE_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key) || key === 'meta') {
      continue;
    }
    out[key] = child;
  }
  return out;
}

function sanitizeBusinessFields(
  value: unknown,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> {
  const sanitized = sanitizeBusinessValue(value);
  let business: Record<string, unknown>;
  if (isRecord(sanitized)) {
    business = renameReservedTopLevelFields(sanitized);
  } else if (sanitized === undefined || sanitized === null) {
    business = {};
  } else {
    business = { value: sanitized };
  }
  return pickAllowedBusinessFields(business, toolName);
}

function sanitizeBusinessValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeBusinessValue);
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CORE_FORBIDDEN_BUSINESS_OUTPUT_KEYS.has(key) || isSensitiveCoreOutputKey(key)) {
      continue;
    }
    const sanitized = sanitizeBusinessValue(child);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

function renameReservedTopLevelFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextKey = RESERVED_TOP_LEVEL_FIELD_RENAMES[key] ?? key;
    out[nextKey] = child;
  }
  return out;
}

function pickAllowedBusinessFields(
  value: Record<string, unknown>,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> {
  const allowed = new Set<string>(CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key)) {
      out[key] = child;
    }
  }
  return out;
}

function pickCleanMeta(
  value: unknown,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'coverageLedgerSeed' && toolName !== 'alembic_rescan') {
      continue;
    }
    if (ALLOWED_CLEAN_META_KEYS.has(key)) {
      const cleanChild = key === 'coverageLedgerSeed' ? sanitizeCoverageLedgerSeed(child) : child;
      if (cleanChild !== undefined) {
        out[key] = cleanChild;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeCoverageLedgerSeed(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = boundedString(value.status, 80);
  if (!status) {
    return undefined;
  }
  const out: Record<string, unknown> = { status };
  const reason = boundedString(value.reason, 240);
  if (reason) {
    out.reason = reason;
  }
  for (const key of ['writtenCells', 'coveredPathCount', 'moduleCount']) {
    const numericValue = nonnegativeInteger(value[key]);
    if (numericValue !== undefined) {
      out[key] = numericValue;
    }
  }
  const dimensionIds = cleanStringArray(value.dimensionIds, 160);
  if (dimensionIds !== undefined) {
    out.dimensionIds = dimensionIds;
  }
  return out;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function cleanStringArray(value: unknown, itemMaxLength: number): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const cleaned = value
    .map((item) => boundedString(item, itemMaxLength))
    .filter((item): item is string => item !== undefined);
  return cleaned.length > 0 ? cleaned : [];
}

function extractLegacyErrorCode(
  legacy: Record<string, unknown>,
  errorDetails: Record<string, unknown> | null
): string | null {
  if (typeof legacy.errorCode === 'string' && legacy.errorCode.length > 0) {
    return legacy.errorCode;
  }
  for (const key of ['code', 'mcpErrorCode', 'reasonCode']) {
    const value = errorDetails?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function pickLegacyErrorDetails(legacy: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(legacy.error)) {
    return legacy.error;
  }
  if (isRecord(legacy.data) && isRecord(legacy.data.error)) {
    return legacy.data.error;
  }
  return null;
}

function deriveCoreToolStatus(input: {
  business: Record<string, unknown>;
  errorCode: string | null;
  ok: boolean;
}): string {
  if (!input.ok) {
    return 'blocked';
  }
  if (input.business.degraded === true) {
    return 'degraded';
  }
  if (typeof input.business.businessStatus === 'string') {
    const normalized = input.business.businessStatus.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (normalized === 'degraded' || normalized === 'blocked' || normalized === 'failed') {
      return normalized;
    }
  }
  if (input.errorCode) {
    return 'blocked';
  }
  return 'ready';
}

function buildCoreToolSummary(
  toolName: CoreCleanOutputToolName,
  input: {
    business: Record<string, unknown>;
    errorDetails: Record<string, unknown> | null;
    message: string;
    ok: boolean;
  }
): string {
  if (input.message.trim()) {
    return input.message.trim();
  }
  if (!input.ok && typeof input.errorDetails?.message === 'string') {
    return input.errorDetails.message;
  }
  if (!input.ok) {
    return `${toolName} blocked.`;
  }
  switch (toolName) {
    case 'alembic_knowledge':
      return 'Knowledge request completed.';
    case 'alembic_structure':
      return 'Structure request completed.';
    case 'alembic_call_context':
      return 'Call context request completed.';
    case 'alembic_plan':
      return 'Plan request completed.';
    case 'alembic_submit_knowledge':
      return `Knowledge submission processed ${numberField(input.business.count)} item(s).`;
    case 'alembic_project_skill':
      return 'Project skill request completed.';
    case 'alembic_bootstrap':
      return 'Bootstrap briefing completed.';
    case 'alembic_rescan':
      return 'Rescan briefing completed.';
    case 'alembic_evolve':
      return 'Evolution decisions processed.';
    case 'alembic_consolidate':
      return 'Consolidation decisions processed.';
    case 'alembic_dimension_complete':
      return 'Dimension completion processed.';
    case 'alembic_knowledge_lifecycle':
      return 'Knowledge lifecycle request completed.';
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSensitiveCoreOutputKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return CORE_SENSITIVE_BUSINESS_OUTPUT_KEYS.has(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

for (const toolName of CORE_CLEAN_OUTPUT_TOOL_NAMES) {
  registerMcpOutputProjector({
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS[toolName],
    outputSchemaName: `${toolName}_clean_output`,
    project: (input) => projectCoreToolOutput(input, toolName),
    projectorName: 'core-tools-clean-output-projector',
    toolName,
  });
}
