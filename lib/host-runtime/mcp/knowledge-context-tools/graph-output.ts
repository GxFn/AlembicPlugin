/**
 * GMAP-1: register the clean MCP output projector for alembic_graph.
 *
 * alembic_graph emits its own Recipe-free AlembicGraphOutput rather than the
 * shared KnowledgeContextToolOutput envelope. The graph handler already returns a
 * CallToolResult, so this projector mainly advertises the AlembicGraphOutput
 * schema in tools/list and provides a typed fallback projection.
 */
import { z } from 'zod';
import { AlembicGraphOutputSchema } from '#service/project-knowledge-context/index.js';
import { isStrictPublicationErrorCode } from '../../context/StrictPublicationError.js';
import { HOST_NEUTRAL_INTERNAL_ERROR_CODE, normalizeHostMcpErrorCode } from '../error-taxonomy.js';
import {
  CleanMcpErrorSchema,
  type CleanMcpResponse,
  createCleanMcpError,
  registerMcpOutputProjector,
} from '../output-contract.js';
import { ProjectRuntimeContextV3Schema } from '../project-runtime-output-schema.js';

// alembic_graph is a clean-output tool with its own AlembicGraphOutput schema,
// separate from the KnowledgeContextToolOutput envelope.
export const GRAPH_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_graph'] as const;

const AlembicGraphCleanOutputSchema = AlembicGraphOutputSchema.extend({
  error: CleanMcpErrorSchema.optional(),
}) as unknown as z.ZodType<CleanMcpResponse>;

const GraphProducerFailureSchema = z
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
    tool: z.literal('alembic_graph'),
  })
  .strict();

function projectAlembicGraphCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicGraphCleanOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  const producerFailure = GraphProducerFailureSchema.safeParse(input);
  if (producerFailure.success) {
    const errorCode = normalizeHostMcpErrorCode(producerFailure.data.errorCode);
    if (isPreservedGraphProducerFailureCode(errorCode)) {
      return buildAlembicGraphProjectionFailure({
        code: errorCode,
        message: producerFailure.data.message,
        retryable: producerFailure.data.data.retryable ?? errorCode === 'TOOL_TIMEOUT',
      });
    }
  }
  return buildAlembicGraphProjectionFailure();
}

function isPreservedGraphProducerFailureCode(errorCode: string): boolean {
  return (
    errorCode === HOST_NEUTRAL_INTERNAL_ERROR_CODE ||
    errorCode === 'TOOL_TIMEOUT' ||
    isStrictPublicationErrorCode(errorCode)
  );
}

function buildAlembicGraphProjectionFailure(
  failure?: Readonly<{ code: string; message: string; retryable: boolean }>
): CleanMcpResponse {
  const summary = failure
    ? failure.message.slice(0, 2000)
    : 'alembic_graph output did not match the public AlembicGraphOutput contract.';
  const diagnosticCode = failure?.code ?? 'alembic-graph-output-contract-mismatch';
  return AlembicGraphCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_graph',
    toolName: 'alembic_graph',
    queryKind: 'map',
    summary,
    project: { projectRoot: '.' },
    repoCoverage: {
      scope: 'canonical-repositories',
      requested: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      omitted: 0,
      completeness: 'unknown',
      discoveredRepoIds: [],
      succeededRepoIds: [],
      failedRepoIds: [],
      omittedRepoIds: [],
      timeoutCount: diagnosticCode === 'TOOL_TIMEOUT' ? 1 : 0,
    },
    nodes: [],
    relations: [],
    refs: [],
    diagnostics: [
      {
        code: diagnosticCode,
        message: failure
          ? summary.slice(0, 800)
          : 'alembic_graph handler returned a payload outside AlembicGraphOutput.',
        retryable: failure?.retryable ?? false,
        severity: 'error',
      },
    ],
    nextActions: [],
    limits: { truncated: false, itemLimit: 0, refLimit: 0, relationLimit: 0 },
    ...(failure
      ? {
          error: createCleanMcpError({
            code: diagnosticCode,
            message: summary,
            status: 'failed',
          }),
        }
      : {}),
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicGraphOutput',
      producer: 'alembic-graph-clean-output-projector',
      sourceOfTruth: false,
      callClaimsRequireSourceVerification: true,
    },
  }) as unknown as CleanMcpResponse;
}

registerMcpOutputProjector({
  outputSchema: AlembicGraphCleanOutputSchema,
  outputSchemaName: 'alembic_graph_clean_output',
  project: (input) => projectAlembicGraphCleanOutput(input),
  projectorName: 'alembic-graph-clean-output-projector',
  toolName: 'alembic_graph',
});
