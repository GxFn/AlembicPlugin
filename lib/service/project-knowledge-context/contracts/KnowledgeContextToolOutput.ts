import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  KnowledgeContextDetailRefSchema,
  KnowledgeContextPublicStringArraySchema,
  KnowledgeContextRefIdSchema,
  KnowledgeContextSourceSchema,
} from './KnowledgeContextRefs.js';
import {
  KNOWLEDGE_CONTEXT_CONTRACT_VERSION,
  KnowledgeContextStatusSchema,
  KnowledgeContextToolNameSchema,
} from './KnowledgeContextStatus.js';

const KnowledgeContextObjectSchema = z.record(z.string(), z.unknown());

export const KnowledgeContextRequestSchema = z
  .object({
    id: KnowledgeContextRefIdSchema.optional(),
    query: z.string().min(1).max(4000).optional(),
    agentHost: z.string().min(1).max(120).optional(),
    inputSource: z.string().min(1).max(120).optional(),
    intentKind: z.string().min(1).max(120).optional(),
    detailLevel: z.enum(['summary', 'standard', 'detailed']).optional(),
    budget: KnowledgeContextObjectSchema.optional(),
    freshnessPolicy: KnowledgeContextObjectSchema.optional(),
  })
  .strict();

export const KnowledgeContextProjectSummarySchema = z
  .object({
    projectRoot: z.string().min(1).max(2000).optional(),
    projectId: KnowledgeContextRefIdSchema.optional(),
    name: z.string().min(1).max(240).optional(),
    language: z.string().min(1).max(80).optional(),
    sourceGraphRef: KnowledgeContextRefIdSchema.optional(),
    matrixRef: KnowledgeContextRefIdSchema.optional(),
    freshness: KnowledgeContextObjectSchema.optional(),
  })
  .strict();

export const KnowledgeContextInteractionSchema = z
  .object({
    intentRef: KnowledgeContextRefIdSchema.optional(),
    primeRef: KnowledgeContextRefIdSchema.optional(),
    workRef: KnowledgeContextRefIdSchema.optional(),
    sourceEvidenceRefs: KnowledgeContextPublicStringArraySchema.optional(),
    recognizedIntent: KnowledgeContextObjectSchema.optional(),
  })
  .strict();

export const KnowledgeContextDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(800),
    domain: z
      .enum([
        'project',
        'knowledge',
        'recipeRelation',
        'vector',
        'sourceGraph',
        'document',
        'runtime',
      ])
      .optional(),
    retryable: z.boolean().default(false),
    detailRefId: KnowledgeContextRefIdSchema.optional(),
  })
  .strict();

export const KnowledgeContextNextActionSchema = z
  .object({
    tool: KnowledgeContextToolNameSchema,
    operation: z.string().min(1).max(120).optional(),
    reason: z.string().min(1).max(600),
    refId: KnowledgeContextRefIdSchema.optional(),
    detailRefId: KnowledgeContextRefIdSchema.optional(),
    required: z.boolean().default(false),
  })
  .strict();

export const KnowledgeContextToolOutputSchema = z
  .object({
    ok: z.boolean(),
    status: KnowledgeContextStatusSchema,
    tool: KnowledgeContextToolNameSchema,
    operation: z.string().min(1).max(120),
    summary: z.string().min(1).max(2000),
    request: KnowledgeContextRequestSchema.optional(),
    project: KnowledgeContextProjectSummarySchema.optional(),
    interaction: KnowledgeContextInteractionSchema.optional(),
    result: KnowledgeContextObjectSchema.optional(),
    inventory: KnowledgeContextObjectSchema.optional(),
    relations: z.array(KnowledgeContextObjectSchema).max(500).optional(),
    items: z.array(KnowledgeContextObjectSchema).max(500).optional(),
    detailRefs: z.array(KnowledgeContextDetailRefSchema).max(200).default([]),
    sources: z.array(KnowledgeContextSourceSchema).max(200).default([]),
    diagnostics: z.array(KnowledgeContextDiagnosticSchema).max(200).default([]),
    nextActions: z.array(KnowledgeContextNextActionSchema).max(20).default([]),
    meta: z
      .object({
        contractVersion: z.literal(KNOWLEDGE_CONTEXT_CONTRACT_VERSION),
        generatedAt: z.string().datetime({ offset: true }).optional(),
        outputSchema: z.literal('KnowledgeContextToolOutput').default('KnowledgeContextToolOutput'),
        producer: z.string().min(1).max(160).optional(),
        traceRef: KnowledgeContextRefIdSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const KnowledgeContextMcpResultSchema = z
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
    structuredContent: KnowledgeContextToolOutputSchema,
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
        message: 'Successful knowledge context outputs must not set isError.',
        path: ['isError'],
      });
    }
  });

export type KnowledgeContextRequest = z.infer<typeof KnowledgeContextRequestSchema>;
export type KnowledgeContextDiagnostic = z.infer<typeof KnowledgeContextDiagnosticSchema>;
export type KnowledgeContextNextAction = z.infer<typeof KnowledgeContextNextActionSchema>;
export type KnowledgeContextToolOutput = z.infer<typeof KnowledgeContextToolOutputSchema>;
export type KnowledgeContextMcpResult = z.infer<typeof KnowledgeContextMcpResultSchema>;

export function createKnowledgeContextMcpResult(
  output: KnowledgeContextToolOutput
): CallToolResult {
  const structuredContent = KnowledgeContextToolOutputSchema.parse(output);
  return KnowledgeContextMcpResultSchema.parse({
    content: [{ type: 'text', text: structuredContent.summary }],
    structuredContent,
    isError: structuredContent.ok ? undefined : true,
  });
}
