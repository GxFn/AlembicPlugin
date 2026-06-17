/**
 * GMAP-1: register the clean MCP output projector for alembic_graph.
 *
 * alembic_graph emits its own Recipe-free AlembicGraphOutput rather than the
 * shared KnowledgeContextToolOutput envelope. The graph handler already returns a
 * CallToolResult, so this projector mainly advertises the AlembicGraphOutput
 * schema in tools/list and provides a typed fallback projection.
 */
import type { z } from 'zod';
import { AlembicGraphOutputSchema } from '#service/project-knowledge-context/index.js';
import {
  type CleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';

// alembic_graph is a clean-output tool with its own AlembicGraphOutput schema,
// separate from the KnowledgeContextToolOutput envelope.
export const GRAPH_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_graph'] as const;

const AlembicGraphCleanOutputSchema =
  AlembicGraphOutputSchema as unknown as z.ZodType<CleanMcpResponse>;

function projectAlembicGraphCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicGraphOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  return buildAlembicGraphProjectionFailure();
}

function buildAlembicGraphProjectionFailure(): CleanMcpResponse {
  return AlembicGraphOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_graph',
    toolName: 'alembic_graph',
    queryKind: 'map',
    summary: 'alembic_graph output did not match the public AlembicGraphOutput contract.',
    project: { projectRoot: '.' },
    nodes: [],
    relations: [],
    refs: [],
    diagnostics: [
      {
        code: 'alembic-graph-output-contract-mismatch',
        message: 'alembic_graph handler returned a payload outside AlembicGraphOutput.',
        retryable: false,
        severity: 'error',
      },
    ],
    nextActions: [],
    limits: { truncated: false, itemLimit: 0, refLimit: 0, relationLimit: 0 },
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicGraphOutput',
      producer: 'alembic-graph-clean-output-projector',
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
