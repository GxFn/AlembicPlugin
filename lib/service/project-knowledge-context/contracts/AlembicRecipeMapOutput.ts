/**
 * AlembicRecipeMapOutput — alembic_recipe_map's own bounded output contract.
 *
 * GMAP-4/7: recipe_map replaces alembic_project_matrix. It returns a bounded
 * ProjectContext region (the shared GMAP-3 ProjectContextRegion projection, so
 * refs round-trip with alembic_graph) plus deterministic Recipe mounts and
 * rollups. Mounting uses ONLY recipe_source_refs + explicit metadata, never
 * semantic/keyword search. No full Recipe body is returned (use alembic_search
 * for Recipe detail). This is NOT KnowledgeContextToolOutput.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProjectContextRefSummarySchema } from './AlembicGraphOutput.js';
import { RegionNodeKindSchema } from './ProjectContextRegion.js';

export const ALEMBIC_RECIPE_MAP_OUTPUT_CONTRACT_VERSION = 1 as const;

export const RecipeMapFocusKindSchema = z.enum([
  'space',
  'repo',
  'map',
  'module',
  'file',
  'symbol',
  'anchor',
]);
export type RecipeMapFocusKind = z.infer<typeof RecipeMapFocusKindSchema>;

export const AlembicRecipeMapStatusSchema = z.enum(['ready', 'partial', 'degraded', 'failed']);
export type AlembicRecipeMapStatus = z.infer<typeof AlembicRecipeMapStatusSchema>;

export const RecipeMountTypeSchema = z.enum([
  'global-no-code',
  'metadata-scope',
  'source-file',
  'source-line',
  'source-range',
  'source-ref-nearest-node',
  'multi-ref-common-ancestor',
  'cross-repo-common-ancestor',
  'degraded-stale',
  'degraded-unresolved',
]);
export type RecipeMountType = z.infer<typeof RecipeMountTypeSchema>;

/** Region node carrying Recipe rollup counts (RegionNode + Recipe summary). */
export const MapNodeSummarySchema = z
  .object({
    nodeId: z.string().min(1).max(240),
    kind: RegionNodeKindSchema,
    label: z.string().min(1).max(400),
    path: z.string().min(1).max(2000).optional(),
    projectContextRef: z.string().min(1).max(240).optional(),
    parentNodeId: z.string().min(1).max(240).optional(),
    childCount: z.number().int().nonnegative().optional(),
    directRecipeCount: z.number().int().nonnegative(),
    descendantRecipeCount: z.number().int().nonnegative(),
    representativeRecipeIds: z.array(z.string().min(1).max(240)).max(20),
  })
  .strict();
export type MapNodeSummary = z.infer<typeof MapNodeSummarySchema>;

export const RecipeMountSummarySchema = z
  .object({
    recipeId: z.string().min(1).max(240),
    title: z.string().min(1).max(400),
    kind: z.string().min(1).max(120).optional(),
    category: z.string().min(1).max(160).optional(),
    dimensionId: z.string().min(1).max(160).optional(),
    summary: z.string().min(1).max(600).optional(),
    mountNodeId: z.string().min(1).max(240),
    mountLevel: RegionNodeKindSchema,
    mountType: RecipeMountTypeSchema,
    sourceRefs: z.array(z.string().min(1).max(400)).max(80),
    matchedRefs: z.array(z.string().min(1).max(400)).max(80),
    reason: z.string().min(1).max(400),
    detailRef: z.string().min(1).max(240).optional(),
  })
  .strict();
export type RecipeMountSummary = z.infer<typeof RecipeMountSummarySchema>;

/** Descendant rollup of Recipe mounts under a region node (counts only, bounded
 * representatives — never the full descendant Recipe set). */
export const RecipeRollupSummarySchema = z
  .object({
    nodeId: z.string().min(1).max(240),
    nodeKind: RegionNodeKindSchema,
    directRecipeCount: z.number().int().nonnegative(),
    descendantRecipeCount: z.number().int().nonnegative(),
    representativeRecipeIds: z.array(z.string().min(1).max(240)).max(20),
  })
  .strict();
export type RecipeRollupSummary = z.infer<typeof RecipeRollupSummarySchema>;

export const MapDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    recipeId: z.string().min(1).max(240).optional(),
    path: z.string().min(1).max(2000).optional(),
    retryable: z.boolean().default(false),
  })
  .strict();
export type MapDiagnostic = z.infer<typeof MapDiagnosticSchema>;

export const MapNextActionSchema = z
  .object({
    tool: z.enum(['alembic_graph', 'alembic_search', 'alembic_recipe_map', 'alembic_prime']),
    reason: z.string().min(1).max(600),
    focusKind: RecipeMapFocusKindSchema.optional(),
    queryKind: z.string().min(1).max(60).optional(),
    refId: z.string().min(1).max(240).optional(),
    required: z.boolean().default(false),
  })
  .strict();
export type MapNextAction = z.infer<typeof MapNextActionSchema>;

export const MapFocusSchema = z
  .object({
    kind: RecipeMapFocusKindSchema,
    refId: z.string().min(1).max(240).optional(),
    nodeId: z.string().min(1).max(240).optional(),
    filePath: z.string().min(1).max(2000).optional(),
    line: z.number().int().min(1).max(1_000_000).optional(),
    sourceRef: z.string().min(1).max(400).optional(),
    moduleName: z.string().min(1).max(240).optional(),
    repoId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type MapFocus = z.infer<typeof MapFocusSchema>;

export const MapRadiusSchema = z
  .object({
    upLevels: z.number().int().min(0).max(10).optional(),
    downLevels: z.number().int().min(0).max(10).optional(),
    relationHops: z.number().int().min(0).max(10).optional(),
    beforeLines: z.number().int().min(0).max(400).optional(),
    afterLines: z.number().int().min(0).max(400).optional(),
  })
  .strict();
export type MapRadius = z.infer<typeof MapRadiusSchema>;

export const MapRegionSchema = z
  .object({
    rootNode: MapNodeSummarySchema,
    breadcrumb: z.array(MapNodeSummarySchema).max(40),
    nodes: z.array(MapNodeSummarySchema).max(500),
    truncated: z.boolean(),
  })
  .strict();

export const AlembicRecipeMapProjectSchema = z
  .object({
    projectRoot: z.string().min(1).max(2000),
    displayName: z.string().min(1).max(240).optional(),
    projectId: z.string().min(1).max(240).optional(),
  })
  .strict();

export const AlembicRecipeMapLimitsSchema = z
  .object({
    nodeLimit: z.number().int().nonnegative(),
    recipeMountLimit: z.number().int().nonnegative(),
    refLimit: z.number().int().nonnegative(),
    detailLevel: z.enum(['summary', 'standard', 'detailed']),
  })
  .strict();

export const AlembicRecipeMapOutputSchema = z
  .object({
    ok: z.boolean(),
    status: AlembicRecipeMapStatusSchema,
    tool: z.literal('alembic_recipe_map'),
    // Platform-wide clean-output discriminator (every clean MCP tool carries a
    // top-level toolName literal).
    toolName: z.literal('alembic_recipe_map'),
    summary: z.string().min(1).max(2000),
    project: AlembicRecipeMapProjectSchema,
    focus: MapFocusSchema,
    radius: MapRadiusSchema,
    region: MapRegionSchema,
    refs: z.array(ProjectContextRefSummarySchema).max(200),
    recipeMounts: z.array(RecipeMountSummarySchema).max(200),
    recipeRollups: z.array(RecipeRollupSummarySchema).max(200),
    diagnostics: z.array(MapDiagnosticSchema).max(200),
    nextActions: z.array(MapNextActionSchema).max(20),
    limits: AlembicRecipeMapLimitsSchema,
    meta: z
      .object({
        contractVersion: z.literal(ALEMBIC_RECIPE_MAP_OUTPUT_CONTRACT_VERSION),
        outputSchema: z.literal('AlembicRecipeMapOutput').default('AlembicRecipeMapOutput'),
        generatedAt: z.string().datetime({ offset: true }).optional(),
        producer: z.string().min(1).max(160).optional(),
      })
      .strict(),
  })
  .strict();
export type AlembicRecipeMapOutput = z.infer<typeof AlembicRecipeMapOutputSchema>;

export const AlembicRecipeMapMcpResultSchema = z
  .object({
    content: z
      .array(z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }).strict())
      .length(1),
    structuredContent: AlembicRecipeMapOutputSchema,
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
        message: 'Successful recipe_map outputs must not set isError.',
        path: ['isError'],
      });
    }
  });

export function createAlembicRecipeMapMcpResult(output: AlembicRecipeMapOutput): CallToolResult {
  const parsed = AlembicRecipeMapOutputSchema.parse(output);
  return AlembicRecipeMapMcpResultSchema.parse({
    content: [{ type: 'text', text: parsed.summary }],
    structuredContent: parsed,
    ...(parsed.ok ? {} : { isError: true }),
  }) as unknown as CallToolResult;
}
