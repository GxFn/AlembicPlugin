/**
 * AlembicGraphOutput — alembic_graph 自有的、Recipe-free 的 ProjectContext 图谱输出契约。
 *
 * GMAP-1: alembic_graph 不再以 KnowledgeContextToolOutput 统一信封作为公共输出。
 * 该工具直接把 ProjectContext.execute 的有界事实投影为本契约,绝不携带任何 Recipe
 * 内容(recipe id / summary / mount / score / relation-chain)、检索分数、prime 语义
 * 结果或知识目录类别。公共输入为 queryKind(9 个 ProjectContext 类 + 4 个由 refs/
 * relations 派生的遍历视图)。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const ALEMBIC_GRAPH_OUTPUT_CONTRACT_VERSION = 1 as const;

/** 9 个直接映射 ProjectContext 请求类的 queryKind。 */
export const ALEMBIC_GRAPH_PROJECT_CONTEXT_QUERY_KINDS = [
  'space',
  'repo',
  'map',
  'module',
  'module-layers',
  'file-flow',
  'file-symbols',
  'source-slice',
  'anchor-range',
] as const;

/** 4 个由 ProjectContext refs/relations 派生的遍历视图。 */
export const ALEMBIC_GRAPH_DERIVED_QUERY_KINDS = [
  'path',
  'impact',
  'neighborhood',
  'stats',
] as const;

export const ALEMBIC_GRAPH_QUERY_KINDS = [
  ...ALEMBIC_GRAPH_PROJECT_CONTEXT_QUERY_KINDS,
  ...ALEMBIC_GRAPH_DERIVED_QUERY_KINDS,
] as const;

export const AlembicGraphQueryKindSchema = z.enum(ALEMBIC_GRAPH_QUERY_KINDS);
export type AlembicGraphQueryKind = z.infer<typeof AlembicGraphQueryKindSchema>;

export const AlembicGraphStatusSchema = z.enum(['ready', 'partial', 'degraded', 'failed']);
export type AlembicGraphStatus = z.infer<typeof AlembicGraphStatusSchema>;

export const AlembicGraphNodeTypeSchema = z.enum([
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
]);

export const AlembicGraphRelationTypeSchema = z.enum([
  'partOf',
  'dependsOn',
  'imports',
  'exports',
  'definesSymbol',
  'referencesSymbol',
  'calls',
  'calledBy',
  'ownsFile',
  'entrypointFor',
]);

export const AlembicGraphSourceRangeSchema = z
  .object({
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    startColumn: z.number().int().nonnegative().optional(),
    endColumn: z.number().int().nonnegative().optional(),
  })
  .strict();

export const GraphNodeSummarySchema = z
  .object({
    id: z.string().min(1).max(240),
    nodeType: AlembicGraphNodeTypeSchema,
    label: z.string().min(1).max(400),
    path: z.string().min(1).max(2000).optional(),
    refId: z.string().min(1).max(240).optional(),
    // Bounded query-driven ranking diagnostics (never Recipe scores).
    queryMatchScore: z.number().optional(),
    queryMatchedTerms: z.array(z.string().min(1).max(120)).max(40).optional(),
    rankingSignals: z.array(z.string().min(1).max(120)).max(20).optional(),
  })
  .strict();
export type GraphNodeSummary = z.infer<typeof GraphNodeSummarySchema>;

export const GraphRelationSummarySchema = z
  .object({
    fromId: z.string().min(1).max(240),
    toId: z.string().min(1).max(240),
    relationType: AlembicGraphRelationTypeSchema,
    fromType: AlembicGraphNodeTypeSchema.optional(),
    toType: AlembicGraphNodeTypeSchema.optional(),
    refId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type GraphRelationSummary = z.infer<typeof GraphRelationSummarySchema>;

export const ProjectContextRefSummarySchema = z
  .object({
    id: z.string().min(1).max(240),
    kind: z.string().min(1).max(80),
    label: z.string().min(1).max(400).optional(),
    filePath: z.string().min(1).max(2000).optional(),
    range: AlembicGraphSourceRangeSchema.optional(),
    parentRef: z.string().min(1).max(240).optional(),
  })
  .strict();
export type ProjectContextRefSummary = z.infer<typeof ProjectContextRefSummarySchema>;

export const GraphSourceSliceSummarySchema = z
  .object({
    refId: z.string().min(1).max(240).optional(),
    filePath: z.string().min(1).max(2000),
    range: AlembicGraphSourceRangeSchema,
    text: z.string().max(20000).optional(),
  })
  .strict();
export type GraphSourceSliceSummary = z.infer<typeof GraphSourceSliceSummarySchema>;

export const GraphDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    retryable: z.boolean().default(false),
    refId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type GraphDiagnostic = z.infer<typeof GraphDiagnosticSchema>;

export const GraphNextActionSchema = z
  .object({
    tool: z.literal('alembic_graph'),
    queryKind: AlembicGraphQueryKindSchema.optional(),
    reason: z.string().min(1).max(600),
    required: z.boolean().default(false),
  })
  .strict();
export type GraphNextAction = z.infer<typeof GraphNextActionSchema>;

export const AlembicGraphLimitsSchema = z
  .object({
    truncated: z.boolean(),
    itemLimit: z.number().int().nonnegative(),
    refLimit: z.number().int().nonnegative(),
    relationLimit: z.number().int().nonnegative(),
  })
  .strict();

export const AlembicGraphProjectSchema = z
  .object({
    projectRoot: z.string().min(1).max(2000),
    displayName: z.string().min(1).max(240).optional(),
    projectId: z.string().min(1).max(240).optional(),
  })
  .strict();

export const AlembicGraphOutputSchema = z
  .object({
    ok: z.boolean(),
    status: AlembicGraphStatusSchema,
    tool: z.literal('alembic_graph'),
    // Platform-wide clean-output discriminator (every clean MCP tool carries a
    // top-level toolName literal); distinct from the KnowledgeContextToolOutput
    // envelope graph no longer uses.
    toolName: z.literal('alembic_graph'),
    queryKind: AlembicGraphQueryKindSchema,
    summary: z.string().min(1).max(2000),
    project: AlembicGraphProjectSchema,
    nodes: z.array(GraphNodeSummarySchema).max(500),
    relations: z.array(GraphRelationSummarySchema).max(500),
    refs: z.array(ProjectContextRefSummarySchema).max(200),
    slices: z.array(GraphSourceSliceSummarySchema).max(80).optional(),
    diagnostics: z.array(GraphDiagnosticSchema).max(200),
    nextActions: z.array(GraphNextActionSchema).max(20),
    limits: AlembicGraphLimitsSchema,
    meta: z
      .object({
        contractVersion: z.literal(ALEMBIC_GRAPH_OUTPUT_CONTRACT_VERSION),
        outputSchema: z.literal('AlembicGraphOutput').default('AlembicGraphOutput'),
        generatedAt: z.string().datetime({ offset: true }).optional(),
        producer: z.string().min(1).max(160).optional(),
      })
      .strict(),
  })
  .strict();
export type AlembicGraphOutput = z.infer<typeof AlembicGraphOutputSchema>;

/**
 * MCP CallToolResult wrapper for alembic_graph. Visible text is the summary only;
 * the full ProjectContext graph projection rides in structuredContent.
 */
export const AlembicGraphMcpResultSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            type: z.literal('text'),
            text: z.string().min(1).max(2000),
          })
          .strict()
      )
      .length(1),
    structuredContent: AlembicGraphOutputSchema,
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
        message: 'Successful graph outputs must not set isError.',
        path: ['isError'],
      });
    }
  });

export function createAlembicGraphMcpResult(output: AlembicGraphOutput): CallToolResult {
  const parsed = AlembicGraphOutputSchema.parse(output);
  return AlembicGraphMcpResultSchema.parse({
    content: [{ type: 'text', text: parsed.summary }],
    structuredContent: parsed,
    ...(parsed.ok ? {} : { isError: true }),
  }) as unknown as CallToolResult;
}
