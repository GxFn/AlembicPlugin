/**
 * AlembicGraphOutput — alembic_graph 自有的、Recipe-free 的 ProjectContext 图谱输出契约。
 *
 * GMAP-1: alembic_graph 不再以 KnowledgeContextToolOutput 统一信封作为公共输出。
 * 该工具直接把 ProjectContextCapabilities.execute 的有界事实投影为本契约,绝不携带任何 Recipe
 * 内容(recipe id / summary / mount / score / relation-chain)、检索分数、prime 语义
 * 结果或知识目录类别。公共输入为 queryKind(9 个 ProjectContext 类 + 4 个由 refs/
 * relations 派生的遍历视图)。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CollectionCoverageSchema } from './ToolOutputPrimitives.js';

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

export const ProjectContextContinuationSchema = z
  .object({
    resultRef: z.string().min(1).max(240),
    factSessionRef: z.string().min(1).max(240),
    nextCursor: z.string().min(1).max(240).nullable(),
    hasMore: z.boolean(),
    page: z.number().int().min(1),
    accumulatedCounts: z.object({ items: z.number().int().nonnegative() }).strict(),
    typeAccounting: z
      .object({
        mounts: continuationTypeAccountingSchema(),
        nodes: continuationTypeAccountingSchema(),
        refs: continuationTypeAccountingSchema(),
        relations: continuationTypeAccountingSchema(),
        rollups: continuationTypeAccountingSchema(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectContextContinuation = z.infer<typeof ProjectContextContinuationSchema>;

function continuationTypeAccountingSchema() {
  return z
    .object({
      shown: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      cumulative: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.cumulative + value.remaining !== value.total || value.shown > value.total) {
        ctx.addIssue({ code: 'custom', message: 'Continuation type accounting is inconsistent.' });
      }
    });
}

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

export const ProjectContextSuppressedObservationDispositionSchema = z.enum([
  'expected',
  'not-applicable',
  'required',
  'confirmed-defect',
  'unclassified',
]);

export const ProjectContextSuppressedObservationSummarySchema = z
  .object({
    kind: z.literal('ProjectContextSuppressedObservationSummary'),
    version: z.literal(1),
    observedCount: z.number().int().nonnegative(),
    nonBlockingCount: z.number().int().nonnegative(),
    blockingCount: z.number().int().nonnegative(),
    unclassifiedCount: z.number().int().nonnegative(),
    conserved: z.boolean(),
    categories: z
      .array(
        z
          .object({
            code: z.string().min(1).max(120),
            disposition: ProjectContextSuppressedObservationDispositionSchema,
            reason: z.string().min(1).max(240),
            count: z.number().int().positive(),
            samples: z
              .array(
                z
                  .object({
                    requestKind: AlembicGraphQueryKindSchema,
                    errorCode: z.string().min(1).max(80),
                    severity: z.enum(['error', 'warning']),
                    messageHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
                    path: z.string().min(1).max(2000).optional(),
                  })
                  .strict()
              )
              .max(3),
          })
          .strict()
      )
      .max(40),
  })
  .strict()
  .superRefine((summary, ctx) => {
    if (!isProjectContextSuppressedObservationSummaryConserved(summary)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Suppressed ProjectContext observation accounting is not conserved.',
      });
    }
  });
export type ProjectContextSuppressedObservationSummary = z.infer<
  typeof ProjectContextSuppressedObservationSummarySchema
>;

export function isProjectContextSuppressedObservationSummaryConserved(
  summary: Pick<
    ProjectContextSuppressedObservationSummary,
    | 'observedCount'
    | 'nonBlockingCount'
    | 'blockingCount'
    | 'unclassifiedCount'
    | 'conserved'
    | 'categories'
  >
): boolean {
  const categoryTotal = summary.categories.reduce((total, category) => total + category.count, 0);
  const nonBlockingTotal = summary.categories
    .filter((category) => ['expected', 'not-applicable'].includes(category.disposition))
    .reduce((total, category) => total + category.count, 0);
  const blockingTotal = summary.categories
    .filter((category) => !['expected', 'not-applicable'].includes(category.disposition))
    .reduce((total, category) => total + category.count, 0);
  const unclassifiedTotal = summary.categories
    .filter((category) => category.disposition === 'unclassified')
    .reduce((total, category) => total + category.count, 0);
  return (
    summary.conserved &&
    categoryTotal === summary.observedCount &&
    summary.nonBlockingCount + summary.blockingCount === summary.observedCount &&
    nonBlockingTotal === summary.nonBlockingCount &&
    blockingTotal === summary.blockingCount &&
    unclassifiedTotal === summary.unclassifiedCount
  );
}

export const AlembicGraphProjectContextMetaSchema = z
  .object({
    requestKinds: z.array(AlembicGraphQueryKindSchema).max(20),
    refCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    suppressedErrorCount: z.number().int().nonnegative(),
    suppressedObservations: ProjectContextSuppressedObservationSummarySchema,
    partial: z.boolean(),
    factSessionRef: z.string().min(1).max(240).optional(),
    factFingerprint: z.string().length(64).optional(),
    liveProbeReceipt: z
      .object({
        kind: z.literal('ProjectContextLiveProbeReceipt'),
        version: z.literal(1),
        phase: z.enum(['progress', 'terminal']),
        verdict: z.enum(['passed', 'blocked']),
        canonicalScopeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        observedSourceVectorHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        terminalSemanticOutputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        repoIdentityHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        moduleIdentityHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        comparedArtifactId: z.string().min(1).nullable(),
        certifiedSourceVectorHash: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .nullable(),
        comparisonStatus: z.enum(['matched', 'mismatched', 'unavailable']),
        suppressedObservations: ProjectContextSuppressedObservationSummarySchema,
        blockingReasons: z.array(z.string().min(1).max(240)).max(40),
      })
      .strict(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    if (meta.suppressedErrorCount !== meta.suppressedObservations.observedCount) {
      ctx.addIssue({
        code: 'custom',
        message: 'Legacy suppressed error count must equal the typed observation total.',
        path: ['suppressedErrorCount'],
      });
    }
  });

export const AlembicGraphProjectSchema = z
  .object({
    projectRoot: z.string().min(1).max(2000),
    displayName: z.string().min(1).max(240).optional(),
    projectId: z.string().min(1).max(240).optional(),
  })
  .strict();

export const GraphRepoCoverageSchema = CollectionCoverageSchema.extend({
  discoveredRepoIds: z.array(z.string().min(1).max(240)).max(1000),
  succeededRepoIds: z.array(z.string().min(1).max(240)).max(1000),
  failedRepoIds: z.array(z.string().min(1).max(240)).max(1000),
  omittedRepoIds: z.array(z.string().min(1).max(240)).max(1000),
  timeoutCount: z.number().int().nonnegative(),
}).strict();
export type GraphRepoCoverage = z.infer<typeof GraphRepoCoverageSchema>;

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
    repoCoverage: GraphRepoCoverageSchema,
    nodes: z.array(GraphNodeSummarySchema).max(500),
    relations: z.array(GraphRelationSummarySchema).max(500),
    refs: z.array(ProjectContextRefSummarySchema).max(200),
    slices: z.array(GraphSourceSliceSummarySchema).max(80).optional(),
    diagnostics: z.array(GraphDiagnosticSchema).max(200),
    nextActions: z.array(GraphNextActionSchema).max(20),
    continuation: ProjectContextContinuationSchema.optional(),
    limits: AlembicGraphLimitsSchema,
    meta: z
      .object({
        contractVersion: z.literal(ALEMBIC_GRAPH_OUTPUT_CONTRACT_VERSION),
        outputSchema: z.literal('AlembicGraphOutput').default('AlembicGraphOutput'),
        generatedAt: z.string().datetime({ offset: true }).optional(),
        producer: z.string().min(1).max(160).optional(),
        projectContext: AlembicGraphProjectContextMetaSchema.optional(),
        sourceOfTruth: z.literal(false),
        callClaimsRequireSourceVerification: z.literal(true),
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
