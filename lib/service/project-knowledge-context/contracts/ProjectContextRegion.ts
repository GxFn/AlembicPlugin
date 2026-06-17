/**
 * ProjectContextRegion — the shared internal ProjectContext region projection
 * consumed by BOTH alembic_graph (Recipe-free structure) and alembic_recipe_map
 * (Recipe mounting onto the same nodes/refs).
 *
 * GMAP-3: recipe_map must not build a second private project tree. This region is
 * a focus-scoped projection of ProjectContext envelopes (via the shared graph
 * build), never a call into the public alembic_graph MCP tool. RegionNode mirrors
 * the structural core of the recipe_map MapNodeSummary (minus Recipe fields), so a
 * ref/node round-trips between graph (refId) and recipe_map (focus) for free —
 * ProjectContextRef.id is already a stable id.
 */
import { z } from 'zod';
import { GraphDiagnosticSchema, ProjectContextRefSummarySchema } from './AlembicGraphOutput.js';

export const REGION_CONTEXT_CONTRACT_VERSION = 1 as const;

/** Focus kinds a caller can request (graph queryKind / recipe_map focus). */
export const RegionFocusKindSchema = z.enum([
  'space',
  'repo',
  'map',
  'module',
  'file',
  'symbol',
  'anchor',
]);
export type RegionFocusKind = z.infer<typeof RegionFocusKindSchema>;

/** Structural classification of a region node (ProjectContext taxonomy, shared
 * with recipe_map MapNodeSummary.kind). */
export const RegionNodeKindSchema = z.enum([
  'space',
  'repo',
  'map',
  'module-layer',
  'module',
  'directory',
  'file',
  'symbol',
  'source-slice',
  'anchor-range',
]);
export type RegionNodeKind = z.infer<typeof RegionNodeKindSchema>;

export const RegionRelationTypeSchema = z.enum([
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

export const RegionNodeSchema = z
  .object({
    nodeId: z.string().min(1).max(240),
    kind: RegionNodeKindSchema,
    label: z.string().min(1).max(400),
    path: z.string().min(1).max(2000).optional(),
    projectContextRef: z.string().min(1).max(240).optional(),
    parentNodeId: z.string().min(1).max(240).optional(),
    childCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RegionNode = z.infer<typeof RegionNodeSchema>;

export const RegionRelationSchema = z
  .object({
    fromId: z.string().min(1).max(240),
    toId: z.string().min(1).max(240),
    relationType: RegionRelationTypeSchema,
    fromKind: RegionNodeKindSchema.optional(),
    toKind: RegionNodeKindSchema.optional(),
    refId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type RegionRelation = z.infer<typeof RegionRelationSchema>;

// Region diagnostics share the Recipe-free graph diagnostic shape.
export const RegionDiagnosticSchema = GraphDiagnosticSchema;
export type RegionDiagnostic = z.infer<typeof RegionDiagnosticSchema>;

export const RegionFocusSchema = z
  .object({
    kind: RegionFocusKindSchema,
    refId: z.string().min(1).max(240).optional(),
    filePath: z.string().min(1).max(2000).optional(),
    line: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
export type RegionFocus = z.infer<typeof RegionFocusSchema>;

/** Focus-shaped request for the shared region (recipe_map's natural input);
 * distinct from alembic_graph's queryKind input. */
export const ProjectContextRegionRequestSchema = z
  .object({
    focus: RegionFocusSchema,
    projectRoot: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type ProjectContextRegionRequest = z.infer<typeof ProjectContextRegionRequestSchema>;

export const RegionProjectSchema = z
  .object({
    projectRoot: z.string().min(1).max(2000),
    projectId: z.string().min(1).max(240).optional(),
    displayName: z.string().min(1).max(240).optional(),
  })
  .strict();

export const ProjectContextRegionSchema = z
  .object({
    project: RegionProjectSchema,
    focus: RegionFocusSchema,
    rootNode: RegionNodeSchema,
    breadcrumb: z.array(RegionNodeSchema).max(40),
    nodes: z.array(RegionNodeSchema).max(500),
    relations: z.array(RegionRelationSchema).max(500),
    refs: z.array(ProjectContextRefSummarySchema).max(200),
    diagnostics: z.array(RegionDiagnosticSchema).max(200),
    truncated: z.boolean(),
    meta: z
      .object({
        contractVersion: z.literal(REGION_CONTEXT_CONTRACT_VERSION),
        outputSchema: z.literal('ProjectContextRegion').default('ProjectContextRegion'),
        producer: z.string().min(1).max(160).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectContextRegion = z.infer<typeof ProjectContextRegionSchema>;
