import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpResponse,
  registerMcpOutputProjector,
} from '../output-contract.js';

export const CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES = [
  'alembic_codex_status',
  'alembic_codex_diagnostics',
  'alembic_codex_init',
  'alembic_codex_dashboard',
  'alembic_codex_bootstrap',
  'alembic_codex_rescan',
  'alembic_codex_job',
  'alembic_codex_stop',
  'alembic_codex_cleanup',
] as const;

export type CodexLocalCleanOutputToolName = (typeof CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES)[number];

export const CodexLocalCleanOutputToolNameSchema = z.enum(CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES);

export const CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES = [
  'error',
  'meta',
  'ok',
  'status',
  'summary',
  'toolName',
] as const;

export const CODEX_LOCAL_RUNTIME_DIAGNOSTIC_TOOL_NAMES = [
  'alembic_codex_status',
  'alembic_codex_diagnostics',
  'alembic_codex_job',
  'alembic_codex_cleanup',
] as const satisfies readonly CodexLocalCleanOutputToolName[];

export const CODEX_LOCAL_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS = new Set([
  'data',
  'errorCode',
  'message',
  'result',
  'success',
]);

export const CODEX_LOCAL_IMPLICIT_RUNTIME_OUTPUT_KEYS = new Set([
  'diagnostics',
  'enhancementRoute',
  'hostProjectAlignment',
  'projectRuntime',
  'residentService',
  'serviceBoundary',
]);

const CODEX_LOCAL_SENSITIVE_OUTPUT_KEYS = new Set([
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

export const CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES = {
  alembic_codex_bootstrap: [
    'job',
    'jobId',
    'jobRoute',
    'nextActions',
    'needsUserInput',
    'reasonCode',
  ],
  alembic_codex_cleanup: ['cleaned', 'dryRun', 'projectRuntime', 'targets'],
  alembic_codex_dashboard: ['dashboardUrl', 'needsUserInput', 'nextActions', 'reasonCode'],
  alembic_codex_diagnostics: [
    'autoInit',
    'businessSummary',
    'businessOk',
    'checks',
    'cleanup',
    'codex',
    'commands',
    'daemon',
    'enhancementRoute',
    'gitDiffCheckpoint',
    'hostProjectAlignment',
    'issues',
    'moduleBoundary',
    'nextActions',
    'node',
    'offlineFallback',
    'package',
    'plugin',
    'primaryAction',
    'projectRootResolution',
    'projectRuntime',
    'projectScopeIdentity',
    'residentService',
    'residentServiceBoundary',
    'runtimeIdentity',
    'summary',
  ],
  alembic_codex_init: [
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
  alembic_codex_job: ['job', 'jobs', 'jobRoute', 'projectRuntime', 'residentService'],
  alembic_codex_rescan: ['job', 'jobId', 'jobRoute', 'nextActions', 'needsUserInput', 'reasonCode'],
  alembic_codex_status: [
    'autoInit',
    'channel',
    'daemon',
    'hostProjectAlignment',
    'initialized',
    'knowledge',
    'nextActions',
    'onboarding',
    'package',
    'projectRoot',
    'projectRootResolution',
    'projectRuntime',
    'statusDiagnostics',
    'workspace',
  ],
  alembic_codex_stop: ['daemonReady', 'daemonStatus', 'pidAlive', 'stopped'],
} as const satisfies Record<CodexLocalCleanOutputToolName, readonly string[]>;

export type CodexLocalToolCleanOutput = z.infer<typeof CleanMcpResponseBaseSchema> & {
  toolName: CodexLocalCleanOutputToolName;
} & Record<string, unknown>;

type CodexLocalToolOutputSchema = z.ZodType<CodexLocalToolCleanOutput>;

export const CodexLocalToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  toolName: CodexLocalCleanOutputToolNameSchema,
}).strict();

export const CODEX_LOCAL_TOOL_OUTPUT_SCHEMAS = Object.fromEntries(
  CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES.map((toolName) => [
    toolName,
    createCodexLocalToolOutputSchema(
      toolName,
      CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]
    ),
  ])
) as unknown as Record<CodexLocalCleanOutputToolName, CodexLocalToolOutputSchema>;

export function projectCodexLocalToolOutput(
  input: unknown,
  toolName: CodexLocalCleanOutputToolName
): CodexLocalToolCleanOutput {
  const schema = CODEX_LOCAL_TOOL_OUTPUT_SCHEMAS[toolName];
  const alreadyClean = schema.safeParse(input);
  if (alreadyClean.success) {
    return alreadyClean.data;
  }

  const legacy = isRecord(input) ? input : {};
  const businessSource = extractLegacyBusinessValue(legacy);
  const business = sanitizeBusinessFields(businessSource, toolName);
  const ok = typeof legacy.success === 'boolean' ? legacy.success : legacy.errorCode == null;
  const cleanMeta = pickCleanMeta(legacy.meta);
  const reasonCode = extractReasonCode(legacy, businessSource);
  const summary = buildCodexLocalToolSummary(toolName, {
    business,
    message: typeof legacy.message === 'string' ? legacy.message : '',
    ok,
  });
  const response = createCleanMcpResponse(
    {
      ...business,
      ok,
      status: deriveCodexLocalToolStatus({ business, ok, reasonCode, toolName }),
      summary,
      toolName,
      ...(!ok
        ? {
            error: {
              code: reasonCode || 'CODEX_MCP_ERROR',
              message: summary,
            },
          }
        : {}),
      ...(cleanMeta ? { meta: cleanMeta } : {}),
    },
    toolName
  );
  return schema.parse(response);
}

export function findForbiddenCodexLocalOutputField(
  value: unknown,
  toolName?: CodexLocalCleanOutputToolName,
  path: string[] = []
): { path: string[] } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenCodexLocalOutputField(item, toolName, [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (path.length === 0 && CODEX_LOCAL_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key)) {
      return { path: [key] };
    }
    if (path[0] !== 'meta' && isSensitiveCodexLocalOutputKey(key)) {
      return { path: [...path, key] };
    }
    if (path[0] !== 'meta' && shouldForbidRuntimeField(key, toolName)) {
      return { path: [...path, key] };
    }
    if (path.length === 0 && key === 'meta') {
      continue;
    }
    const found = findForbiddenCodexLocalOutputField(child, toolName, [...path, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function createCodexLocalToolOutputSchema(
  toolName: CodexLocalCleanOutputToolName,
  businessFields: readonly string[]
): CodexLocalToolOutputSchema {
  const shape: Record<string, z.ZodType> = { toolName: z.literal(toolName) };
  for (const fieldName of businessFields) {
    shape[fieldName] = z.unknown().optional();
  }
  return CleanMcpResponseBaseSchema.extend(shape)
    .strict()
    .superRefine((output, ctx) => {
      const forbidden = findForbiddenCodexLocalOutputField(output, toolName);
      if (forbidden) {
        ctx.addIssue({
          code: 'custom',
          path: forbidden.path,
          message: `Codex local MCP clean output must not expose ${forbidden.path.join('.')}`,
        });
      }
    }) as unknown as CodexLocalToolOutputSchema;
}

function extractLegacyBusinessValue(value: Record<string, unknown>): unknown {
  if ('data' in value) {
    return value.data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CODEX_LOCAL_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key) || key === 'meta') {
      continue;
    }
    out[key] = child;
  }
  return out;
}

function sanitizeBusinessFields(
  value: unknown,
  toolName: CodexLocalCleanOutputToolName
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

function normalizeBusinessValue(value: unknown, toolName: CodexLocalCleanOutputToolName): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = { ...value };
  if (toolName === 'alembic_codex_status' && 'diagnostics' in out) {
    out.statusDiagnostics = out.diagnostics;
    delete out.diagnostics;
  }
  if (toolName === 'alembic_codex_init' && 'status' in out) {
    out.statusSnapshot = out.status;
    delete out.status;
  }
  if (toolName === 'alembic_codex_stop' && isRecord(out.daemon)) {
    out.daemonReady = out.daemon.ready === true;
    out.daemonStatus = typeof out.daemon.status === 'string' ? out.daemon.status : null;
    out.pidAlive = out.daemon.pidAlive === true;
    out.stopped = out.daemon.ready !== true && out.daemon.pidAlive !== true;
    delete out.daemon;
  }
  if (
    (toolName === 'alembic_codex_bootstrap' || toolName === 'alembic_codex_rescan') &&
    out.errorCode
  ) {
    out.reasonCode = out.errorCode;
  }
  if (toolName === 'alembic_codex_dashboard' && out.errorCode) {
    out.reasonCode = out.errorCode;
  }
  return out;
}

function sanitizeBusinessValue(value: unknown, toolName: CodexLocalCleanOutputToolName): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeBusinessValue(item, toolName));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (shouldStripRuntimeField(key, toolName) || isSensitiveCodexLocalOutputKey(key)) {
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
  toolName: CodexLocalCleanOutputToolName
): Record<string, unknown> {
  const allowed = new Set<string>(CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key)) {
      out[key] = child;
    }
  }
  return out;
}

function shouldStripRuntimeField(key: string, toolName: CodexLocalCleanOutputToolName): boolean {
  return (
    !isRuntimeDiagnosticTool(toolName) &&
    (CODEX_LOCAL_IMPLICIT_RUNTIME_OUTPUT_KEYS.has(key) ||
      key === 'daemon' ||
      key === 'projectScopeIdentity')
  );
}

function shouldForbidRuntimeField(key: string, toolName?: CodexLocalCleanOutputToolName): boolean {
  if (!toolName || isRuntimeDiagnosticTool(toolName)) {
    return false;
  }
  return CODEX_LOCAL_IMPLICIT_RUNTIME_OUTPUT_KEYS.has(key);
}

function isRuntimeDiagnosticTool(toolName: CodexLocalCleanOutputToolName): boolean {
  return (CODEX_LOCAL_RUNTIME_DIAGNOSTIC_TOOL_NAMES as readonly string[]).includes(toolName);
}

function isSensitiveCodexLocalOutputKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return CODEX_LOCAL_SENSITIVE_OUTPUT_KEYS.has(normalized);
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
  businessSource: unknown
): string | null {
  if (isRecord(businessSource) && typeof businessSource.errorCode === 'string') {
    return businessSource.errorCode;
  }
  return typeof legacy.errorCode === 'string' ? legacy.errorCode : null;
}

function deriveCodexLocalToolStatus(input: {
  business: Record<string, unknown>;
  ok: boolean;
  reasonCode: string | null;
  toolName: CodexLocalCleanOutputToolName;
}): string {
  if (!input.ok) {
    return 'blocked';
  }
  if (input.toolName === 'alembic_codex_cleanup' && input.business.dryRun === true) {
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

function buildCodexLocalToolSummary(
  toolName: CodexLocalCleanOutputToolName,
  input: { business: Record<string, unknown>; message: string; ok: boolean }
): string {
  if (input.message.trim()) {
    return input.message.trim();
  }
  if (!input.ok) {
    return `${toolName} blocked.`;
  }
  if (toolName === 'alembic_codex_status') {
    return 'Alembic Codex status checked.';
  }
  if (toolName === 'alembic_codex_diagnostics') {
    return typeof input.business.businessSummary === 'string'
      ? input.business.businessSummary
      : 'Alembic Codex diagnostics completed.';
  }
  if (toolName === 'alembic_codex_init') {
    return 'Alembic Codex workspace initialized.';
  }
  if (toolName === 'alembic_codex_dashboard') {
    return input.business.dashboardUrl
      ? 'Alembic Dashboard handoff ready.'
      : 'Alembic Dashboard handoff checked.';
  }
  if (toolName === 'alembic_codex_bootstrap') {
    return 'Alembic Codex bootstrap job checked.';
  }
  if (toolName === 'alembic_codex_rescan') {
    return 'Alembic Codex rescan job checked.';
  }
  if (toolName === 'alembic_codex_job') {
    return Array.isArray(input.business.jobs)
      ? `Alembic Codex job list returned ${input.business.jobs.length} item(s).`
      : 'Alembic Codex job status checked.';
  }
  if (toolName === 'alembic_codex_stop') {
    return 'Alembic Codex daemon stop requested.';
  }
  return input.business.dryRun === true
    ? 'Alembic Codex cleanup preview completed.'
    : 'Alembic Codex runtime cleanup completed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

for (const toolName of CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES) {
  registerMcpOutputProjector({
    outputSchema: CODEX_LOCAL_TOOL_OUTPUT_SCHEMAS[toolName],
    outputSchemaName: `${toolName}_clean_output`,
    project: (input) => projectCodexLocalToolOutput(input, toolName),
    projectorName: 'codex-local-clean-output-projector',
    toolName,
  });
}
