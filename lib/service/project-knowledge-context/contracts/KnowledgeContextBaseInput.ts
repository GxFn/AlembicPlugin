import { z } from 'zod';
import {
  KnowledgeContextBudgetSchema,
  KnowledgeContextFiltersSchema,
  KnowledgeContextFreshnessSchema,
  KnowledgeContextHostDeclaredIntentSchema,
  KnowledgeContextHostTurnMetaSchema,
  KnowledgeContextIncludeSchema,
  KnowledgeContextRefIdSchema,
  KnowledgeContextScopeSchema,
} from './KnowledgeContextRefs.js';
import {
  KnowledgeContextAgentHostSchema,
  KnowledgeContextDetailLevelSchema,
  KnowledgeContextInputSourceSchema,
  KnowledgeContextIntentKindSchema,
} from './KnowledgeContextStatus.js';

export const KnowledgeContextProjectNodeTypeSchema = z.enum([
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
]);

export const KnowledgeContextProjectRelationTypeSchema = z.enum([
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

export const KnowledgeContextBaseInputSchema = z
  .object({
    projectRoot: z.string().min(1).max(2000).optional(),
    agentHost: KnowledgeContextAgentHostSchema.optional(),
    inputSource: KnowledgeContextInputSourceSchema.optional(),
    intentKind: KnowledgeContextIntentKindSchema.optional(),
    query: z.string().min(1).max(4000).optional(),
    activeFile: z.string().min(1).max(2000).optional(),
    language: z.string().min(1).max(80).optional(),
    hostDeclaredIntent: KnowledgeContextHostDeclaredIntentSchema.optional(),
    hostTurnMeta: KnowledgeContextHostTurnMetaSchema.optional(),
    sourceRefs: z.array(KnowledgeContextRefIdSchema).max(80).optional(),
    sourceEvidenceRefs: z.array(KnowledgeContextRefIdSchema).max(80).optional(),
    intentRef: KnowledgeContextRefIdSchema.optional(),
    primeRef: KnowledgeContextRefIdSchema.optional(),
    workRef: KnowledgeContextRefIdSchema.optional(),
    scope: KnowledgeContextScopeSchema.optional(),
    include: KnowledgeContextIncludeSchema.optional(),
    filters: KnowledgeContextFiltersSchema.optional(),
    detailLevel: KnowledgeContextDetailLevelSchema.default('summary'),
    budget: KnowledgeContextBudgetSchema.optional(),
    freshnessPolicy: KnowledgeContextFreshnessSchema.optional(),
  })
  .strict();

export const ProjectMatrixOperationSchema = z.enum([
  'overview',
  'node',
  'relations',
  'layers',
  'sources',
  'catalog',
]);

export const ProjectMatrixNodeTypeSchema = z.enum([
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
  'knowledge-category',
  'knowledge-cluster',
  'document',
]);

export const ProjectMatrixInputSchema = KnowledgeContextBaseInputSchema.extend({
  tool: z.literal('alembic_project_matrix').optional(),
  operation: ProjectMatrixOperationSchema.default('overview'),
  nodeId: KnowledgeContextRefIdSchema.optional(),
  nodeType: ProjectMatrixNodeTypeSchema.optional(),
}).strict();

export const PrimeOperationSchema = z.enum(['auto', 'matrix-first', 'search-first']);

export const PrimeModeSchema = z.enum(['summary', 'working-set', 'guard-prep', 'decision-prep']);

export const PrimeRecognizedIntentSchema = z
  .object({
    action: z.string().min(1).max(120).optional(),
    target: z.string().min(1).max(240).optional(),
    confidence: z.number().min(0).max(1).optional(),
    query: z.string().min(1).max(2000),
    sourceRefs: z.array(KnowledgeContextRefIdSchema).max(80).optional(),
  })
  .strict();

export const PrimeInputSchema = KnowledgeContextBaseInputSchema.extend({
  tool: z.literal('alembic_prime').optional(),
  operation: PrimeOperationSchema.default('auto'),
  recognizedIntent: PrimeRecognizedIntentSchema.optional(),
  primeMode: PrimeModeSchema.default('summary'),
}).strict();

export const KnowledgeSearchOperationSchema = z.enum(['search', 'get', 'expand']);

export const KnowledgeSearchModeSchema = z.enum(['auto', 'keyword', 'bm25', 'semantic', 'context']);

export const KnowledgeSearchKindSchema = z.enum([
  'all',
  'rule',
  'pattern',
  'fact',
  'guide',
  'decision',
  'standard',
]);

export const KnowledgeSearchInputSchema = KnowledgeContextBaseInputSchema.extend({
  tool: z.literal('alembic_search').optional(),
  operation: KnowledgeSearchOperationSchema.default('search'),
  mode: KnowledgeSearchModeSchema.default('auto'),
  id: KnowledgeContextRefIdSchema.optional(),
  refId: KnowledgeContextRefIdSchema.optional(),
  detailRefId: KnowledgeContextRefIdSchema.optional(),
  kind: KnowledgeSearchKindSchema.default('all'),
  category: z.string().min(1).max(160).optional(),
  keywords: z.array(z.string().min(1).max(120)).max(40).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  module: z.string().min(1).max(240).optional(),
}).strict();

export const ProjectGraphOperationSchema = z.enum([
  'query',
  'impact',
  'path',
  'stats',
  'neighborhood',
]);

export const ProjectGraphDirectionSchema = z.enum(['out', 'in', 'both']);

export const ProjectGraphInputSchema = KnowledgeContextBaseInputSchema.extend({
  tool: z.literal('alembic_graph').optional(),
  operation: ProjectGraphOperationSchema.default('query'),
  nodeId: KnowledgeContextRefIdSchema.optional(),
  nodeType: KnowledgeContextProjectNodeTypeSchema.optional(),
  fromId: KnowledgeContextRefIdSchema.optional(),
  fromType: KnowledgeContextProjectNodeTypeSchema.optional(),
  toId: KnowledgeContextRefIdSchema.optional(),
  toType: KnowledgeContextProjectNodeTypeSchema.optional(),
  direction: ProjectGraphDirectionSchema.default('both'),
  relationType: KnowledgeContextProjectRelationTypeSchema.optional(),
  maxDepth: z.number().int().min(1).max(10).default(2),
}).strict();

export const KnowledgeContextToolInputSchema = z.discriminatedUnion('tool', [
  ProjectMatrixInputSchema.extend({ tool: z.literal('alembic_project_matrix') }).strict(),
  PrimeInputSchema.extend({ tool: z.literal('alembic_prime') }).strict(),
  KnowledgeSearchInputSchema.extend({ tool: z.literal('alembic_search') }).strict(),
  ProjectGraphInputSchema.extend({ tool: z.literal('alembic_graph') }).strict(),
]);

export type KnowledgeContextProjectNodeType = z.infer<typeof KnowledgeContextProjectNodeTypeSchema>;
export type KnowledgeContextProjectRelationType = z.infer<
  typeof KnowledgeContextProjectRelationTypeSchema
>;
export type KnowledgeContextBaseInput = z.infer<typeof KnowledgeContextBaseInputSchema>;
export type ProjectMatrixInput = z.infer<typeof ProjectMatrixInputSchema>;
export type PrimeInput = z.infer<typeof PrimeInputSchema>;
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInputSchema>;
export type ProjectGraphInput = z.infer<typeof ProjectGraphInputSchema>;
export type KnowledgeContextToolInput = z.infer<typeof KnowledgeContextToolInputSchema>;
