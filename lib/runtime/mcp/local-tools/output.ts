import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpError,
  createCleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';

export const LOCAL_CLEAN_OUTPUT_TOOL_NAMES = [
  'alembic_status',
  'alembic_init',
  'alembic_job',
  'alembic_runtime',
] as const;

export type LocalCleanOutputToolName = (typeof LOCAL_CLEAN_OUTPUT_TOOL_NAMES)[number];

export const LocalCleanOutputToolNameSchema = z.enum(LOCAL_CLEAN_OUTPUT_TOOL_NAMES);

export const LOCAL_BASE_OUTPUT_FIELD_NAMES = [
  'error',
  'meta',
  'ok',
  'status',
  'summary',
  'toolName',
] as const;

export const LOCAL_RUNTIME_DIAGNOSTIC_TOOL_NAMES = [
  'alembic_status',
  'alembic_job',
  'alembic_runtime',
] as const satisfies readonly LocalCleanOutputToolName[];

export const LOCAL_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS = new Set([
  'data',
  'errorCode',
  'message',
  'result',
  'success',
]);

export const LOCAL_IMPLICIT_RUNTIME_OUTPUT_KEYS = new Set([
  'diagnostics',
  'enhancementRoute',
  'hostProjectAlignment',
  'projectRuntime',
  'residentService',
  'serviceBoundary',
]);

// MTC-4: the old alembic_mcp_status forbade diagnostics/runtime keys to stay a
// light status. The merged alembic_status is a runtime-diagnostic tool that
// legitimately carries those fields under aspect=runtime, so that per-tool
// forbidden-key special-case is removed.

const LOCAL_SENSITIVE_OUTPUT_KEYS = new Set([
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

const ALLOWED_CLEAN_META_KEYS = new Set(['responseTimeMs', 'source']);

export const LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES = {
  // MTC-7: union of the merged bootstrap/rescan enqueue fields + the job-read
  // (codex_job) fields, projected for the single alembic_job route.
  alembic_job: [
    'job',
    'jobId',
    'jobRoute',
    'jobs',
    'needsUserInput',
    'nextActions',
    'projectRuntime',
    'reasonCode',
    'residentService',
  ],
  // MTC-7: union of the merged alembic_codex_stop (daemon flags) +
  // alembic_codex_cleanup (cleanup targets/projectRuntime) business fields.
  alembic_runtime: [
    'cleaned',
    'daemonReady',
    'daemonStatus',
    'dryRun',
    'pidAlive',
    'projectRuntime',
    'stopped',
    'targets',
  ],
  // MTC-4: union of the merged alembic_health (resident) + alembic_mcp_status +
  // alembic_codex_diagnostics business fields, projected for both shells.
  alembic_status: [
    'actionHints',
    'ai',
    'autoInit',
    'businessOk',
    'businessStatus',
    'businessSummary',
    'checks',
    'cleanup',
    'codex',
    'commands',
    'daemon',
    'enhancementRoute',
    'gitDiffCheckpoint',
    'hostProjectAlignment',
    'initialized',
    'issues',
    'knowledge',
    'knowledgeBase',
    'moduleBoundary',
    'nextActions',
    'node',
    'offlineFallback',
    'onboarding',
    'package',
    'plugin',
    'primaryAction',
    'project',
    'projectRoot',
    'projectRootResolution',
    'projectRuntime',
    'projectScopeIdentity',
    'residentService',
    'residentServiceBoundary',
    'runtimeIdentity',
    'services',
    'session',
    'summary',
    'uptime',
    'version',
    'workspace',
  ],
  alembic_init: [
    'alreadyInitialized',
    'initialized',
    'marker',
    'mode',
    'nextActions',
    'profile',
    'requestedTool',
    'results',
    'route',
    'statusSnapshot',
  ],
} as const satisfies Record<LocalCleanOutputToolName, readonly string[]>;

export type LocalToolCleanOutput = z.infer<typeof CleanMcpResponseBaseSchema> & {
  toolName: LocalCleanOutputToolName;
} & Record<string, unknown>;

type LocalToolOutputSchema = z.ZodType<LocalToolCleanOutput>;
type LocalToolSummaryInput = {
  business: Record<string, unknown>;
  errorDetails: Record<string, unknown> | null;
  message: string;
  ok: boolean;
};

const LOCAL_TOOL_SUMMARY_BUILDERS: Partial<
  Record<LocalCleanOutputToolName, (input: LocalToolSummaryInput) => string>
> = {
  alembic_status: (input) =>
    typeof input.business.businessSummary === 'string'
      ? input.business.businessSummary
      : 'Alembic status checked.',
  alembic_init: () => 'Alembic Codex workspace initialized.',
  alembic_job: (input) =>
    Array.isArray(input.business.jobs)
      ? `Alembic Codex job list returned ${input.business.jobs.length} item(s).`
      : 'Alembic Codex job checked.',
  // MTC-7: alembic_runtime covers both stop and cleanup; discriminate by the
  // business fields each action produces (cleanup carries dryRun/cleaned/targets).
  alembic_runtime: (input) => {
    if (input.business.dryRun === true) {
      return 'Alembic Codex cleanup preview completed.';
    }
    if ('cleaned' in input.business || 'targets' in input.business) {
      return 'Alembic Codex runtime cleanup completed.';
    }
    return 'Alembic Codex daemon stop requested.';
  },
};

export const LocalToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  toolName: LocalCleanOutputToolNameSchema,
}).strict();

export const LOCAL_TOOL_OUTPUT_SCHEMAS = Object.fromEntries(
  LOCAL_CLEAN_OUTPUT_TOOL_NAMES.map((toolName) => [
    toolName,
    createLocalToolOutputSchema(toolName, LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]),
  ])
) as unknown as Record<LocalCleanOutputToolName, LocalToolOutputSchema>;

export function projectLocalToolOutput(
  input: unknown,
  toolName: LocalCleanOutputToolName
): LocalToolCleanOutput {
  const schema = LOCAL_TOOL_OUTPUT_SCHEMAS[toolName];
  const alreadyClean = schema.safeParse(input);
  if (alreadyClean.success) {
    return alreadyClean.data;
  }

  const legacy = isRecord(input) ? input : {};
  const businessSource = extractLegacyBusinessValue(legacy);
  const business = sanitizeBusinessFields(businessSource, toolName);
  const ok = typeof legacy.success === 'boolean' ? legacy.success : legacy.errorCode == null;
  const cleanMeta = pickCleanMeta(legacy.meta);
  const errorDetails = pickLegacyErrorDetails(legacy, businessSource);
  const reasonCode = extractReasonCode(legacy, businessSource, errorDetails);
  const summary = buildLocalToolSummary(toolName, {
    business,
    errorDetails,
    message: typeof legacy.message === 'string' ? legacy.message : '',
    ok,
  });
  const status = deriveLocalToolStatus({ business, ok, reasonCode, toolName });
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
              code: reasonCode || 'CODEX_MCP_ERROR',
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

export function findForbiddenLocalOutputField(
  value: unknown,
  toolName?: LocalCleanOutputToolName,
  path: string[] = []
): { path: string[] } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenLocalOutputField(item, toolName, [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (path.length === 0 && LOCAL_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key)) {
      return { path: [key] };
    }
    if (path[0] !== 'meta' && isSensitiveLocalOutputKey(key)) {
      return { path: [...path, key] };
    }
    if (path[0] !== 'meta' && shouldForbidRuntimeField(key, toolName)) {
      return { path: [...path, key] };
    }
    if (path.length === 0 && key === 'meta') {
      continue;
    }
    const found = findForbiddenLocalOutputField(child, toolName, [...path, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function createLocalToolOutputSchema(
  toolName: LocalCleanOutputToolName,
  businessFields: readonly string[]
): LocalToolOutputSchema {
  const shape: Record<string, z.ZodType> = { toolName: z.literal(toolName) };
  for (const fieldName of businessFields) {
    shape[fieldName] = z.unknown().optional();
  }
  return CleanMcpResponseBaseSchema.extend(shape)
    .strict()
    .superRefine((output, ctx) => {
      const forbidden = findForbiddenLocalOutputField(output, toolName);
      if (forbidden) {
        ctx.addIssue({
          code: 'custom',
          path: forbidden.path,
          message: `Codex local MCP clean output must not expose ${forbidden.path.join('.')}`,
        });
      }
    }) as unknown as LocalToolOutputSchema;
}

function extractLegacyBusinessValue(value: Record<string, unknown>): unknown {
  if ('data' in value) {
    return value.data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (LOCAL_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key) || key === 'meta') {
      continue;
    }
    out[key] = child;
  }
  return out;
}

function sanitizeBusinessFields(
  value: unknown,
  toolName: LocalCleanOutputToolName
): Record<string, unknown> {
  const sanitized = sanitizeBusinessValue(normalizeBusinessValue(value, toolName), toolName);
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

function normalizeBusinessValue(value: unknown, toolName: LocalCleanOutputToolName): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = { ...value };
  if (toolName === 'alembic_init' && 'status' in out) {
    out.statusSnapshot = out.status;
    delete out.status;
  }
  if (toolName === 'alembic_runtime' && isRecord(out.daemon)) {
    out.daemonReady = out.daemon.ready === true;
    out.daemonStatus = typeof out.daemon.status === 'string' ? out.daemon.status : null;
    out.pidAlive = out.daemon.pidAlive === true;
    out.stopped = out.daemon.ready !== true && out.daemon.pidAlive !== true;
    delete out.daemon;
  }
  if (toolName === 'alembic_job' && out.errorCode) {
    out.reasonCode = out.errorCode;
  }
  return out;
}

function sanitizeBusinessValue(value: unknown, toolName: LocalCleanOutputToolName): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeBusinessValue(item, toolName));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (shouldStripRuntimeField(key, toolName) || isSensitiveLocalOutputKey(key)) {
      continue;
    }
    const sanitized = sanitizeBusinessValue(child, toolName);
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
  toolName: LocalCleanOutputToolName
): Record<string, unknown> {
  const allowed = new Set<string>(LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key)) {
      out[key] = child;
    }
  }
  return out;
}

function shouldStripRuntimeField(key: string, toolName: LocalCleanOutputToolName): boolean {
  return (
    !isRuntimeDiagnosticTool(toolName) &&
    (LOCAL_IMPLICIT_RUNTIME_OUTPUT_KEYS.has(key) ||
      key === 'daemon' ||
      key === 'projectScopeIdentity')
  );
}

function shouldForbidRuntimeField(key: string, toolName?: LocalCleanOutputToolName): boolean {
  if (!toolName || isRuntimeDiagnosticTool(toolName)) {
    return false;
  }
  return LOCAL_IMPLICIT_RUNTIME_OUTPUT_KEYS.has(key);
}

function isRuntimeDiagnosticTool(toolName: LocalCleanOutputToolName): boolean {
  return (LOCAL_RUNTIME_DIAGNOSTIC_TOOL_NAMES as readonly string[]).includes(toolName);
}

function isSensitiveLocalOutputKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return LOCAL_SENSITIVE_OUTPUT_KEYS.has(normalized);
}

function pickCleanMeta(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (ALLOWED_CLEAN_META_KEYS.has(key)) {
      out[key] = child;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractReasonCode(
  legacy: Record<string, unknown>,
  businessSource: unknown,
  errorDetails: Record<string, unknown> | null
): string | null {
  if (isRecord(businessSource) && typeof businessSource.errorCode === 'string') {
    return businessSource.errorCode;
  }
  if (typeof legacy.errorCode === 'string') {
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

function pickLegacyErrorDetails(
  legacy: Record<string, unknown>,
  businessSource: unknown
): Record<string, unknown> | null {
  if (isRecord(legacy.error)) {
    return legacy.error;
  }
  if (isRecord(businessSource) && isRecord(businessSource.error)) {
    return businessSource.error;
  }
  return null;
}

function deriveLocalToolStatus(input: {
  business: Record<string, unknown>;
  ok: boolean;
  reasonCode: string | null;
  toolName: LocalCleanOutputToolName;
}): string {
  if (!input.ok) {
    return 'blocked';
  }
  if (input.toolName === 'alembic_runtime' && input.business.dryRun === true) {
    return 'preview';
  }
  if (input.reasonCode) {
    return 'blocked';
  }
  if (input.business.businessOk === false) {
    return 'degraded';
  }
  return 'ready';
}

function buildLocalToolSummary(
  toolName: LocalCleanOutputToolName,
  input: LocalToolSummaryInput
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
  const buildSummary = LOCAL_TOOL_SUMMARY_BUILDERS[toolName];
  if (buildSummary) {
    return buildSummary(input);
  }
  // Generic fallback for any codex-local tool without a dedicated summary builder.
  return `${toolName} completed.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

for (const toolName of LOCAL_CLEAN_OUTPUT_TOOL_NAMES) {
  registerMcpOutputProjector({
    outputSchema: LOCAL_TOOL_OUTPUT_SCHEMAS[toolName],
    outputSchemaName: `${toolName}_clean_output`,
    project: (input) => projectLocalToolOutput(input, toolName),
    projectorName: 'codex-local-clean-output-projector',
    toolName,
  });
}
