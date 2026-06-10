import {
  CORE_FAILURE_PROBLEM_CLASSES,
  CORE_FAILURE_REF_POLICIES,
  CORE_FAILURE_RETRY_POLICIES,
  CORE_FAILURE_STATUSES,
  CORE_FAILURE_TAXONOMY_VERSION,
  CORE_FIELD_CLASSES,
  CORE_FIELD_FAILURE_KINDS,
  type CoreFailureAgentBranch,
  type CoreFailureProblemClass,
  type CoreFailureRefPolicy,
  type CoreFailureRetryPolicy,
  type CoreFailureStatus,
  type CoreFieldClass,
  type CoreFieldFailureKind,
  getCoreFailureTaxonomyEntry,
  isCoreFieldFailureKind,
} from '@alembic/core/shared';
import { z } from 'zod';

export const CleanMcpFailureTaxonomySchema = z
  .object({
    agentBranch: z.string().min(1).max(80),
    artifactRefs: z.array(z.string().min(1)).optional(),
    canonicalHttpStatus: z.number().int().min(100).max(599),
    dashboardState: z.enum(CORE_FIELD_FAILURE_KINDS),
    detailExposureClass: z.enum(CORE_FIELD_CLASSES),
    detailRefs: z.array(z.string().min(1)).optional(),
    exposureClass: z.enum(CORE_FIELD_CLASSES),
    failureId: z.string().regex(/^core\.failure\.[a-z][a-z0-9-]*$/),
    failureStatus: z.enum(CORE_FAILURE_STATUSES),
    mcpErrorCode: z.string().regex(/^core\.failure\.[a-z][a-z0-9-]*$/),
    mcpStatus: z.enum(CORE_FIELD_FAILURE_KINDS),
    privateDataSafe: z.literal(true),
    problemClass: z.enum(CORE_FAILURE_PROBLEM_CLASSES),
    reasonCode: z.enum(CORE_FIELD_FAILURE_KINDS),
    refPolicy: z.enum(CORE_FAILURE_REF_POLICIES),
    retryPolicy: z.enum(CORE_FAILURE_RETRY_POLICIES),
    retryable: z.boolean(),
    taxonomyVersion: z.literal(CORE_FAILURE_TAXONOMY_VERSION),
  })
  .strict();

export type CleanMcpFailureTaxonomy = z.infer<typeof CleanMcpFailureTaxonomySchema>;

export interface CreateCleanMcpFailureTaxonomyInput {
  code?: string;
  details?: unknown;
  failureKind?: CoreFieldFailureKind;
  source?: unknown;
  status?: string;
}

const LEGACY_ERROR_CODE_FAILURE_KINDS: Record<string, CoreFieldFailureKind> = {
  CANCELLED: 'cancelled',
  CLEAN_OUTPUT_PROJECTOR_MISSING: 'capability-mismatch',
  CODEX_DASHBOARD_HANDOFF_UNAVAILABLE: 'unavailable',
  CODEX_DASHBOARD_UNAVAILABLE: 'unavailable',
  CODEX_MCP_ERROR: 'internal-error',
  CODEX_TOOL_RETIRED: 'capability-mismatch',
  CONFLICT: 'conflict',
  CONSTITUTION_VIOLATION: 'permission-denied',
  GUARD_SCOPE_REQUIRED: 'invalid-input',
  HOST_FAILURE: 'host-failure',
  INTERNAL_ERROR: 'internal-error',
  INVALID_INPUT: 'invalid-input',
  MISSING_GUARD_SCOPE: 'invalid-input',
  NOT_FOUND: 'not-found',
  PERMISSION_DENIED: 'permission-denied',
  PROVIDER_ERROR: 'provider-error',
  RESIDENT_SEARCH_UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
  TOOL_ERROR: 'internal-error',
  TOOL_FAILED: 'internal-error',
  VALIDATION_ERROR: 'invalid-input',
};

const CLEAN_MCP_ERROR_SENSITIVE_KEYS = new Set([
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
  'stack',
]);

export function createCleanMcpFailureTaxonomy(
  input: CreateCleanMcpFailureTaxonomyInput
): CleanMcpFailureTaxonomy {
  const providerProblem =
    extractProviderProblemTaxonomy(input.source) ?? extractProviderProblemTaxonomy(input.details);
  const kind =
    input.failureKind ??
    readProviderProblemFailureKind(providerProblem) ??
    readCoreFailureKind(input.code) ??
    readCoreFailureKind(input.status) ??
    mapLegacyErrorCodeToFailureKind(input.code) ??
    mapLegacyErrorCodeToFailureKind(providerProblem?.code) ??
    'internal-error';
  const taxonomy = getCoreFailureTaxonomyEntry(kind);
  const detailRefs = readStringArray(providerProblem?.detailRefs);
  const artifactRefs = readStringArray(providerProblem?.artifactRefs);

  return CleanMcpFailureTaxonomySchema.parse({
    agentBranch: taxonomy.agentBranch satisfies CoreFailureAgentBranch,
    ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
    canonicalHttpStatus: taxonomy.httpStatus,
    dashboardState: taxonomy.dashboardState,
    detailExposureClass: taxonomy.detailExposureClass satisfies CoreFieldClass,
    ...(detailRefs.length > 0 ? { detailRefs } : {}),
    exposureClass: taxonomy.exposureClass satisfies CoreFieldClass,
    failureId: taxonomy.stableId,
    failureStatus: taxonomy.status satisfies CoreFailureStatus,
    mcpErrorCode: taxonomy.mcpErrorCode,
    mcpStatus: taxonomy.mcpStatus,
    privateDataSafe: taxonomy.privateDataSafe,
    problemClass: taxonomy.problemClass satisfies CoreFailureProblemClass,
    reasonCode: taxonomy.kind,
    refPolicy: taxonomy.refPolicy satisfies CoreFailureRefPolicy,
    retryPolicy: taxonomy.retryPolicy satisfies CoreFailureRetryPolicy,
    retryable:
      typeof providerProblem?.retryable === 'boolean'
        ? providerProblem.retryable
        : taxonomy.retryable,
    taxonomyVersion: CORE_FAILURE_TAXONOMY_VERSION,
  });
}

export function sanitizeCleanMcpErrorDetails(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeCleanMcpErrorDetails).filter((item) => item !== undefined);
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveErrorDetailKey(key)) {
      continue;
    }
    const sanitized = sanitizeCleanMcpErrorDetails(child);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

function extractProviderProblemTaxonomy(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (hasFailureTaxonomyShape(value)) {
    return value;
  }
  if (isRecord(value.error) && hasFailureTaxonomyShape(value.error)) {
    return value.error;
  }
  if (isRecord(value.details) && hasFailureTaxonomyShape(value.details)) {
    return value.details;
  }
  return null;
}

function hasFailureTaxonomyShape(value: Record<string, unknown>): boolean {
  return (
    readCoreFailureKind(value.kind) !== null ||
    readCoreFailureKind(value.reasonCode) !== null ||
    readCoreFailureKind(value.mcpStatus) !== null ||
    readCoreFailureKind(value.dashboardState) !== null ||
    readCoreFailureKind(value.failureId) !== null ||
    readCoreFailureKind(value.mcpErrorCode) !== null
  );
}

function readProviderProblemFailureKind(
  value: Record<string, unknown> | null | undefined
): CoreFieldFailureKind | null {
  if (!value) {
    return null;
  }
  return (
    readCoreFailureKind(value.reasonCode) ??
    readCoreFailureKind(value.kind) ??
    readCoreFailureKind(value.mcpStatus) ??
    readCoreFailureKind(value.dashboardState) ??
    readCoreFailureKind(value.failureId) ??
    readCoreFailureKind(value.mcpErrorCode)
  );
}

function mapLegacyErrorCodeToFailureKind(value: unknown): CoreFieldFailureKind | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .toUpperCase();
  return LEGACY_ERROR_CODE_FAILURE_KINDS[normalized] ?? null;
}

function readCoreFailureKind(value: unknown): CoreFieldFailureKind | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith('core.failure.')
    ? trimmed.slice('core.failure.'.length)
    : trimmed;
  return isCoreFieldFailureKind(withoutPrefix) ? withoutPrefix : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function isSensitiveErrorDetailKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return CLEAN_MCP_ERROR_SENSITIVE_KEYS.has(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
