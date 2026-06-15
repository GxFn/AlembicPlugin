import { z } from 'zod';
import {
  KnowledgeContextFreshnessPolicySchema,
  KnowledgeContextSourceDomainSchema,
  KnowledgeContextToolNameSchema,
} from './KnowledgeContextStatus.js';

export const KnowledgeContextRefIdSchema = z.string().min(1).max(240);
export const KnowledgeContextPublicStringSchema = z.string().min(1).max(1200);
export const KnowledgeContextOptionalStringSchema = z.string().max(1200).optional();
export const KnowledgeContextPublicStringArraySchema = z
  .array(KnowledgeContextPublicStringSchema)
  .max(80);

export const KnowledgeContextBudgetSchema = z
  .object({
    tokenBudget: z.number().int().min(256).max(100000).optional(),
    itemLimit: z.number().int().min(1).max(500).default(20),
    detailLimit: z.number().int().min(0).max(200).default(20),
    relationHopLimit: z.number().int().min(1).max(10).default(2),
    contentCharLimit: z.number().int().min(120).max(20000).default(1200),
    matrixNodeLimit: z.number().int().min(1).max(5000).default(500),
    nextActionLimit: z.number().int().min(0).max(20).default(5),
  })
  .strict();

export const KnowledgeContextFreshnessSchema = z
  .object({
    policy: KnowledgeContextFreshnessPolicySchema.default('preferFresh'),
    maxAgeMs: z.number().int().min(0).optional(),
    snapshotRef: KnowledgeContextRefIdSchema.optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const KnowledgeContextScopeSchema = z
  .object({
    projectRoot: z.string().min(1).max(2000).optional(),
    workspaceRoot: z.string().min(1).max(2000).optional(),
    activeFile: z.string().min(1).max(2000).optional(),
    language: z.string().min(1).max(80).optional(),
    files: z.array(z.string().min(1).max(2000)).max(200).optional(),
    directories: z.array(z.string().min(1).max(2000)).max(80).optional(),
    packages: z.array(z.string().min(1).max(240)).max(80).optional(),
  })
  .strict();

export const KnowledgeContextDetailRefSchema = z
  .object({
    id: KnowledgeContextRefIdSchema,
    domain: KnowledgeContextSourceDomainSchema,
    tool: KnowledgeContextToolNameSchema.optional(),
    operation: z.string().min(1).max(120).optional(),
    title: KnowledgeContextOptionalStringSchema,
    summary: z.string().min(1).max(600),
    uri: z.string().min(1).max(1200).optional(),
    ref: KnowledgeContextRefIdSchema.optional(),
    freshness: KnowledgeContextFreshnessSchema.optional(),
    budget: KnowledgeContextBudgetSchema.partial().strict().optional(),
    requiredForCompletion: z.boolean().default(false),
  })
  .strict();

export const KnowledgeContextSourceSchema = z
  .object({
    domain: KnowledgeContextSourceDomainSchema,
    id: KnowledgeContextRefIdSchema,
    title: KnowledgeContextOptionalStringSchema,
    detailRefId: KnowledgeContextRefIdSchema.optional(),
    freshness: KnowledgeContextFreshnessSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    summary: z.string().min(1).max(600).optional(),
  })
  .strict();

export const KnowledgeContextHostDeclaredIntentSchema = z
  .object({
    action: z.string().min(1).max(120).optional(),
    target: z.string().min(1).max(240).optional(),
    confidence: z.number().min(0).max(1).optional(),
    query: z.string().min(1).max(2000).optional(),
    sourceRefs: KnowledgeContextPublicStringArraySchema.optional(),
  })
  .strict();

export const KnowledgeContextHostTurnMetaSchema = z
  .object({
    surface: z.string().min(1).max(120).optional(),
    turnId: KnowledgeContextRefIdSchema.optional(),
    threadRef: KnowledgeContextRefIdSchema.optional(),
    redaction: z.enum(['none', 'redacted', 'summary-only']).default('summary-only'),
  })
  .strict();

export const KnowledgeContextIncludeSchema = z
  .object({
    project: z.boolean().default(true),
    knowledge: z.boolean().default(true),
    recipeRelations: z.boolean().default(true),
    vector: z.boolean().default(true),
    documents: z.boolean().default(true),
    runtime: z.boolean().default(false),
  })
  .strict();

export const KnowledgeContextFiltersSchema = z
  .object({
    domains: z.array(KnowledgeContextSourceDomainSchema).max(8).optional(),
    kinds: z.array(z.string().min(1).max(120)).max(40).optional(),
    languages: z.array(z.string().min(1).max(80)).max(40).optional(),
    tags: z.array(z.string().min(1).max(120)).max(80).optional(),
    changedOnly: z.boolean().optional(),
  })
  .strict();

export type KnowledgeContextBudget = z.infer<typeof KnowledgeContextBudgetSchema>;
export type KnowledgeContextFreshness = z.infer<typeof KnowledgeContextFreshnessSchema>;
export type KnowledgeContextScope = z.infer<typeof KnowledgeContextScopeSchema>;
export type KnowledgeContextDetailRef = z.infer<typeof KnowledgeContextDetailRefSchema>;
export type KnowledgeContextSource = z.infer<typeof KnowledgeContextSourceSchema>;
