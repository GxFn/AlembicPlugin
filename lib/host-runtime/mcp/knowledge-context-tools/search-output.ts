/**
 * GMAP-8b: register the clean MCP output projector for alembic_search.
 *
 * alembic_search emits its own AlembicSearchOutput rather than the shared
 * KnowledgeContextToolOutput envelope. The search handler already returns a
 * CallToolResult, so this projector advertises the AlembicSearchOutput schema in
 * tools/list and provides a typed fallback projection.
 */
import { z } from 'zod';
import { AlembicSearchOutputSchema } from '#service/project-knowledge-context/index.js';
import { isStrictPublicationErrorCode } from '../../context/StrictPublicationError.js';
import { HOST_NEUTRAL_INTERNAL_ERROR_CODE, normalizeHostMcpErrorCode } from '../error-taxonomy.js';
import {
  CleanMcpErrorSchema,
  type CleanMcpResponse,
  createCleanMcpError,
  registerMcpOutputProjector,
} from '../output-contract.js';
import { ProjectRuntimeContextV3Schema } from '../project-runtime-output-schema.js';

export const SEARCH_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_search'] as const;

const AlembicSearchCleanOutputSchema = AlembicSearchOutputSchema.extend({
  error: CleanMcpErrorSchema.optional(),
}) as unknown as z.ZodType<CleanMcpResponse>;

const SearchProducerFailureSchema = z
  .object({
    success: z.literal(false),
    data: z
      .object({
        projectRuntime: ProjectRuntimeContextV3Schema,
        retryable: z.boolean().optional(),
      })
      .strict(),
    errorCode: z.string().min(1).max(120),
    message: z.string().min(1).max(4000),
    tool: z.literal('alembic_search'),
  })
  .strict();

function projectAlembicSearchCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicSearchCleanOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  const producerFailure = SearchProducerFailureSchema.safeParse(input);
  if (producerFailure.success) {
    const errorCode = normalizeHostMcpErrorCode(producerFailure.data.errorCode);
    if (isPreservedSearchProducerFailureCode(errorCode)) {
      return buildAlembicSearchProducerFailure(producerFailure.data, errorCode);
    }
  }
  return buildAlembicSearchProjectionFailure();
}

function buildAlembicSearchProducerFailure(
  input: z.infer<typeof SearchProducerFailureSchema>,
  errorCode: string
): CleanMcpResponse {
  const summary = input.message.slice(0, 2000);
  const retryable = input.data.retryable ?? errorCode === 'TOOL_TIMEOUT';
  return AlembicSearchCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation: 'search',
    summary,
    items: [],
    detailRefs: [],
    sources: [],
    diagnostics: [
      {
        code: errorCode,
        message: summary.slice(0, 800),
        retryable,
        severity: 'error',
      },
    ],
    nextActions: [],
    error: createCleanMcpError({
      code: errorCode,
      message: summary,
      status: 'failed',
    }),
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicSearchOutput',
      producer: 'alembic-search-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

function isPreservedSearchProducerFailureCode(errorCode: string): boolean {
  return (
    errorCode === HOST_NEUTRAL_INTERNAL_ERROR_CODE ||
    errorCode === 'TOOL_TIMEOUT' ||
    isStrictPublicationErrorCode(errorCode)
  );
}

function buildAlembicSearchProjectionFailure(): CleanMcpResponse {
  return AlembicSearchCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation: 'search',
    summary: 'alembic_search output did not match the public AlembicSearchOutput contract.',
    items: [],
    detailRefs: [],
    sources: [],
    diagnostics: [
      {
        code: 'alembic-search-output-contract-mismatch',
        message: 'alembic_search handler returned a payload outside AlembicSearchOutput.',
        retryable: false,
        severity: 'error',
      },
    ],
    nextActions: [],
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicSearchOutput',
      producer: 'alembic-search-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

registerMcpOutputProjector({
  outputSchema: AlembicSearchCleanOutputSchema,
  outputSchemaName: 'alembic_search_clean_output',
  project: (input) => projectAlembicSearchCleanOutput(input),
  projectorName: 'alembic-search-clean-output-projector',
  toolName: 'alembic_search',
});
