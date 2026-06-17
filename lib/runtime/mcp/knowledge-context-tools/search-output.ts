/**
 * GMAP-8b: register the clean MCP output projector for alembic_search.
 *
 * alembic_search emits its own AlembicSearchOutput rather than the shared
 * KnowledgeContextToolOutput envelope. The search handler already returns a
 * CallToolResult, so this projector advertises the AlembicSearchOutput schema in
 * tools/list and provides a typed fallback projection.
 */
import type { z } from 'zod';
import { AlembicSearchOutputSchema } from '#service/project-knowledge-context/index.js';
import {
  type CleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';

export const SEARCH_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_search'] as const;

const AlembicSearchCleanOutputSchema =
  AlembicSearchOutputSchema as unknown as z.ZodType<CleanMcpResponse>;

function projectAlembicSearchCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicSearchOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  return buildAlembicSearchProjectionFailure();
}

function buildAlembicSearchProjectionFailure(): CleanMcpResponse {
  return AlembicSearchOutputSchema.parse({
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
