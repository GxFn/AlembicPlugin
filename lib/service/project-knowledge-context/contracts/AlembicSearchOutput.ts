/**
 * AlembicSearchOutput — alembic_search's own public output contract.
 *
 * GMAP-8b: alembic_search no longer projects through the KnowledgeContext middle
 * layer (defaultProjectKnowledgeContextLayer.resolveMcpResult) or the shared
 * KnowledgeContextToolOutput envelope. The search handler builds its bounded
 * Recipe-search / detail payload (from the resident search path + the retrieval
 * providers, never another MCP handler) and projects it directly into this
 * search-owned envelope.
 *
 * operation=search returns Recipe summaries/ids by query + filters; operation=get
 * returns one Agent-facing Recipe detail by id/ref (the single-Recipe detail tool);
 * operation=expand returns a bounded expansion of a known ref. result/inventory/
 * items stay loose passthroughs so resident-search evidence (residentSearch,
 * residentVector, searchMeta, vector) and the search-quality summary survive intact.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const ALEMBIC_SEARCH_OUTPUT_CONTRACT_VERSION = 1 as const;

export const ALEMBIC_SEARCH_OPERATIONS = ['search', 'get', 'expand'] as const;
export const ALEMBIC_SEARCH_STATUSES = [
  'ready',
  'partial',
  'degraded',
  'blocked',
  'failed',
] as const;

export const AlembicSearchOperationSchema = z.enum(ALEMBIC_SEARCH_OPERATIONS);
export const AlembicSearchStatusSchema = z.enum(ALEMBIC_SEARCH_STATUSES);

// Loose passthrough object — search result/inventory/item/ref shapes are wide and
// already sanitized by the handler; the envelope keeps them as bounded records.
const SearchObjectSchema = z.record(z.string(), z.unknown());

export const SearchDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    domain: z.enum(['knowledge', 'vector', 'document', 'runtime']).optional(),
    retryable: z.boolean().default(false),
    detailRefId: z.string().min(1).max(240).optional(),
  })
  .strict();

export const SearchNextActionSchema = z
  .object({
    // String tool name (not a fixed enum) so search can point at any of the four
    // agent tools (alembic_search/get, alembic_graph, alembic_recipe_map, alembic_prime).
    tool: z.string().min(1).max(120),
    operation: z.string().min(1).max(120).optional(),
    reason: z.string().min(1).max(600),
    refId: z.string().min(1).max(240).optional(),
    detailRefId: z.string().min(1).max(240).optional(),
    required: z.boolean().default(false),
  })
  .strict();

export const AlembicSearchOutputSchema = z
  .object({
    ok: z.boolean(),
    status: AlembicSearchStatusSchema,
    tool: z.literal('alembic_search'),
    toolName: z.literal('alembic_search'),
    operation: AlembicSearchOperationSchema,
    summary: z.string().min(1).max(2000),
    result: SearchObjectSchema.optional(),
    inventory: SearchObjectSchema.optional(),
    items: z.array(SearchObjectSchema).max(500).default([]),
    detailRefs: z.array(SearchObjectSchema).max(200).default([]),
    sources: z.array(SearchObjectSchema).max(200).default([]),
    diagnostics: z.array(SearchDiagnosticSchema).max(200).default([]),
    nextActions: z.array(SearchNextActionSchema).max(20).default([]),
    meta: z
      .object({
        contractVersion: z.literal(ALEMBIC_SEARCH_OUTPUT_CONTRACT_VERSION),
        generatedAt: z.string().datetime({ offset: true }).optional(),
        outputSchema: z.literal('AlembicSearchOutput').default('AlembicSearchOutput'),
        producer: z.string().min(1).max(160).optional(),
        traceRef: z.string().min(1).max(240).optional(),
      })
      .strict(),
  })
  .strict();

export const AlembicSearchMcpResultSchema = z
  .object({
    content: z
      .array(z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }).strict())
      .length(1),
    structuredContent: AlembicSearchOutputSchema,
    isError: z.boolean().optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.content[0]?.text !== result.structuredContent.summary) {
      ctx.addIssue({
        code: 'custom',
        message: 'MCP visible content must contain only the structured summary text.',
        path: ['content', 0, 'text'],
      });
    }
    if (result.structuredContent.ok && result.isError) {
      ctx.addIssue({
        code: 'custom',
        message: 'Successful alembic_search outputs must not set isError.',
        path: ['isError'],
      });
    }
  });

export type AlembicSearchOperation = z.infer<typeof AlembicSearchOperationSchema>;
export type AlembicSearchStatus = z.infer<typeof AlembicSearchStatusSchema>;
export type SearchDiagnostic = z.infer<typeof SearchDiagnosticSchema>;
export type SearchNextAction = z.infer<typeof SearchNextActionSchema>;
export type AlembicSearchOutput = z.infer<typeof AlembicSearchOutputSchema>;

export function createAlembicSearchMcpResult(output: AlembicSearchOutput): CallToolResult {
  const structuredContent = AlembicSearchOutputSchema.parse(output);
  return AlembicSearchMcpResultSchema.parse({
    content: [{ type: 'text', text: structuredContent.summary }],
    structuredContent,
    isError: structuredContent.ok ? undefined : true,
  }) as unknown as CallToolResult;
}
