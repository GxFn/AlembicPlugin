/**
 * Small shared output primitives for the four agent tools.
 *
 * GMAP-8c: the KnowledgeContextToolOutput envelope is retired. Rather than rebuild
 * a middle layer, the four tools (alembic_graph / alembic_recipe_map / alembic_search
 * / alembic_prime) each own their public output schema and reuse these tiny leaf
 * primitives for the cross-cutting pieces (status, diagnostic, next-action, ref,
 * limit, source-evidence). These are plain value shapes — no projection logic, no
 * shared envelope, no inter-tool coupling.
 */
import { z } from 'zod';

export const TOOL_OUTPUT_STATUSES = ['ready', 'partial', 'degraded', 'blocked', 'failed'] as const;
export const ToolStatusSchema = z.enum(TOOL_OUTPUT_STATUSES);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/**
 * 跨工具共享的收集完整度叶子。它只描述“要求检查多少、实际完成多少”，
 * 不承载 Guard/Graph/Map 等工具的业务结果，避免重新形成统一大信封。
 */
export const COLLECTION_COMPLETENESS = ['complete', 'partial', 'unknown'] as const;
export const CollectionCoverageSchema = z
  .object({
    scope: z.string().min(1).max(80),
    requested: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    completeness: z.enum(COLLECTION_COMPLETENESS),
  })
  .strict();
export type CollectionCoverage = z.infer<typeof CollectionCoverageSchema>;

export const CONCLUSION_DISPOSITIONS = ['passed', 'failed', 'incomplete', 'blocked'] as const;
export const ConclusionDispositionSchema = z.enum(CONCLUSION_DISPOSITIONS);
export type ConclusionDisposition = z.infer<typeof ConclusionDispositionSchema>;

/**
 * 结论强度只由完整度和真实失败事实决定；展示层不得自行把 partial 投影成 pass。
 */
export function deriveConclusionDisposition(input: {
  blockingFailure?: boolean;
  coverage: CollectionCoverage;
  hasFailure?: boolean;
}): ConclusionDisposition {
  if (input.blockingFailure) {
    return 'blocked';
  }
  if (input.coverage.completeness !== 'complete') {
    return 'incomplete';
  }
  return input.hasFailure ? 'failed' : 'passed';
}

/** A bounded diagnostic emitted by any tool (stale/unresolved/degraded/etc.). */
export const ToolDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    domain: z.enum(['project', 'knowledge', 'recipe', 'vector', 'document', 'runtime']).optional(),
    retryable: z.boolean().default(false),
    detailRefId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type ToolDiagnostic = z.infer<typeof ToolDiagnosticSchema>;

/**
 * An optional follow-up action. tool is a free string (not an enum) so any tool can
 * point at any of the four agent tools; nothing here implies a required call order.
 */
export const ToolNextActionSchema = z
  .object({
    tool: z.string().min(1).max(120),
    operation: z.string().min(1).max(120).optional(),
    reason: z.string().min(1).max(600),
    refId: z.string().min(1).max(240).optional(),
    detailRefId: z.string().min(1).max(240).optional(),
    required: z.boolean().default(false),
  })
  .strict();
export type ToolNextAction = z.infer<typeof ToolNextActionSchema>;

/** A stable, opaque reference id with a small label/kind for round-tripping. */
export const ToolRefSchema = z
  .object({
    id: z.string().min(1).max(240),
    kind: z.string().min(1).max(80).optional(),
    label: z.string().min(1).max(400).optional(),
  })
  .strict();
export type ToolRef = z.infer<typeof ToolRefSchema>;

/** Bounded output limits a tool applied (item/ref budgets + truncation flag). */
export const ToolLimitSchema = z
  .object({
    truncated: z.boolean().default(false),
    itemLimit: z.number().int().nonnegative().optional(),
    refLimit: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ToolLimit = z.infer<typeof ToolLimitSchema>;

/** Source-evidence pointer (file/ref the tool's data came from). */
export const ToolSourceEvidenceSchema = z
  .object({
    id: z.string().min(1).max(240),
    uri: z.string().min(1).max(1200).optional(),
    detailRefId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type ToolSourceEvidence = z.infer<typeof ToolSourceEvidenceSchema>;
