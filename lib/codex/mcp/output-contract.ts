import type { CoreFieldFailureKind } from '@alembic/core/shared';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  CleanMcpFailureTaxonomySchema,
  createCleanMcpFailureTaxonomy,
  sanitizeCleanMcpErrorDetails,
} from './error-taxonomy.js';
import { zodToMcpSchema } from './zodToMcpSchema.js';

export const CLEAN_MCP_OUTPUT_CONTRACT_VERSION = 1;

export const CleanMcpStatusSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);

export const CleanMcpErrorSchema = CleanMcpFailureTaxonomySchema.extend({
  code: z.string().min(1).max(120),
  details: z.unknown().optional(),
  message: z.string().min(1),
}).strict();

export const CleanMcpMetaSchema = z
  .object({
    contractVersion: z.literal(CLEAN_MCP_OUTPUT_CONTRACT_VERSION),
    outputSchema: z.string().min(1).max(160).optional(),
    projector: z.string().min(1).max(160).optional(),
    responseTimeMs: z.number().nonnegative().optional(),
    source: z.string().min(1).max(160).optional(),
    toolName: z.string().min(1).max(160).optional(),
  })
  .strict();

export const CleanMcpResponseBaseSchema = z
  .object({
    ok: z.boolean(),
    status: CleanMcpStatusSchema,
    summary: z.string().min(1),
    error: CleanMcpErrorSchema.optional(),
    meta: CleanMcpMetaSchema.optional(),
  })
  .strict();

export const CleanMcpResponseSchema = CleanMcpResponseBaseSchema.passthrough();

export type CleanMcpResponse = z.infer<typeof CleanMcpResponseSchema>;
export type CleanMcpResponseBase = z.infer<typeof CleanMcpResponseBaseSchema>;

export interface McpOutputProjector {
  outputSchema: z.ZodType<CleanMcpResponse>;
  outputSchemaName: string;
  project(input: unknown, context: { toolName: string }): CleanMcpResponse;
  projectorName: string;
  toolName: string;
}

const outputProjectors = new Map<string, McpOutputProjector>();

export function registerMcpOutputProjector(projector: McpOutputProjector): () => void {
  if (outputProjectors.has(projector.toolName)) {
    throw new Error(`MCP output projector already registered for ${projector.toolName}`);
  }
  outputProjectors.set(projector.toolName, projector);
  return () => {
    if (outputProjectors.get(projector.toolName) === projector) {
      outputProjectors.delete(projector.toolName);
    }
  };
}

export function getMcpOutputProjector(toolName: string): McpOutputProjector | null {
  return outputProjectors.get(toolName) ?? null;
}

export function projectMcpToolOutput(toolName: string, value: unknown): CleanMcpResponse | null {
  const projector = getMcpOutputProjector(toolName);
  if (!projector) {
    return null;
  }
  const response = projector.project(value, { toolName });
  const parsed = projector.outputSchema.parse(response);
  return {
    ...parsed,
    meta: {
      contractVersion: CLEAN_MCP_OUTPUT_CONTRACT_VERSION,
      outputSchema: projector.outputSchemaName,
      projector: projector.projectorName,
      toolName,
      ...parsed.meta,
    },
  };
}

export function isCleanMcpResponse(value: unknown): value is CleanMcpResponse {
  return CleanMcpResponseSchema.safeParse(value).success;
}

export function isMcpCallToolResult(value: unknown): value is CallToolResult {
  return (
    !!value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)
  );
}

export function createCleanMcpResponse(
  input: Omit<CleanMcpResponse, 'meta'> & { meta?: Partial<CleanMcpResponse['meta']> },
  toolName?: string
): CleanMcpResponse {
  return CleanMcpResponseSchema.parse({
    ...input,
    meta: {
      contractVersion: CLEAN_MCP_OUTPUT_CONTRACT_VERSION,
      ...(toolName ? { toolName } : {}),
      ...input.meta,
    },
  });
}

export function createCleanMcpError(input: {
  code: string;
  details?: unknown;
  failureKind?: CoreFieldFailureKind;
  message: string;
  source?: unknown;
  status?: string;
}): z.infer<typeof CleanMcpErrorSchema> {
  const details = sanitizeCleanMcpErrorDetails(input.details);
  return CleanMcpErrorSchema.parse({
    code: input.code,
    message: input.message,
    ...createCleanMcpFailureTaxonomy({
      code: input.code,
      details,
      failureKind: input.failureKind,
      source: input.source,
      status: input.status,
    }),
    ...(details === undefined ? {} : { details }),
  });
}

export function createCleanMcpErrorResponse(input: {
  code: string;
  details?: unknown;
  failureKind?: CoreFieldFailureKind;
  message: string;
  responseTimeMs?: number;
  status?: string;
  toolName: string;
}): CleanMcpResponse {
  return createCleanMcpResponse(
    {
      ok: false,
      status: input.status ?? 'failed',
      summary: input.message,
      // MT/CC3 F1: the declared core-tools output schemas require a TOP-LEVEL
      // toolName (z.literal per tool); meta.toolName alone makes schema-
      // validating MCP clients reject error envelopes with -32602.
      toolName: input.toolName,
      error: createCleanMcpError({
        code: input.code,
        failureKind: input.failureKind,
        message: input.message,
        status: input.status,
        ...(input.details === undefined ? {} : { details: input.details }),
      }),
      meta: {
        ...(input.responseTimeMs === undefined ? {} : { responseTimeMs: input.responseTimeMs }),
      },
    },
    input.toolName
  );
}

export function createMcpStructuredToolResult(response: CleanMcpResponse): CallToolResult {
  const parsed = CleanMcpResponseSchema.parse(response);
  return {
    structuredContent: parsed,
    content: [{ type: 'text', text: parsed.summary }],
    isError: parsed.ok ? undefined : true,
  };
}

export function serializeMcpToolResult(
  toolName: string,
  value: unknown,
  options: {
    isErrorResult(value: unknown): boolean;
  }
): CallToolResult {
  if (isMcpCallToolResult(value)) {
    return value;
  }
  const projected = projectMcpToolOutput(toolName, value);
  if (projected) {
    return createMcpStructuredToolResult(projected);
  }
  if (isCleanMcpResponse(value)) {
    return createMcpStructuredToolResult(value);
  }
  if (options.isErrorResult(value)) {
    return createMcpStructuredToolResult(projectLegacyErrorAsCleanResponse(toolName, value));
  }
  return createMcpStructuredToolResult(
    createCleanMcpErrorResponse({
      code: 'CLEAN_OUTPUT_PROJECTOR_MISSING',
      details: { payloadType: describePayloadType(value) },
      message: `No clean MCP output projector is registered for ${toolName}.`,
      status: 'blocked',
      toolName,
    })
  );
}

export function withMcpOutputSchema<T extends { name: string; outputSchema?: unknown }>(
  tool: T
): T {
  const projector = getMcpOutputProjector(tool.name);
  if (!projector) {
    return tool;
  }
  return {
    ...tool,
    outputSchema: zodToMcpSchema(projector.outputSchema),
  };
}

function projectLegacyErrorAsCleanResponse(toolName: string, value: unknown): CleanMcpResponse {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const data =
    record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {};
  const code =
    (typeof record.errorCode === 'string' && record.errorCode) ||
    readErrorDetailString(record.error, 'code') ||
    readErrorDetailString(record.error, 'mcpErrorCode') ||
    (typeof data.errorCode === 'string' && data.errorCode) ||
    readErrorDetailString(data.error, 'code') ||
    readErrorDetailString(data.error, 'mcpErrorCode') ||
    'TOOL_FAILED';
  const message =
    (typeof record.message === 'string' && record.message) ||
    readErrorDetailString(record.error, 'message') ||
    (typeof data.message === 'string' && data.message) ||
    readErrorDetailString(data.error, 'message') ||
    `MCP tool ${toolName} failed.`;
  const errorDetails = pickLegacyErrorDetails(record, data);
  return createCleanMcpErrorResponse({
    code,
    details: errorDetails ?? { payloadType: describePayloadType(value) },
    message,
    status: normalizeStatus(record.status) ?? 'failed',
    toolName,
  });
}

function normalizeStatus(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value)) {
    return undefined;
  }
  return value;
}

function describePayloadType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function pickLegacyErrorDetails(
  record: Record<string, unknown>,
  data: Record<string, unknown>
): unknown {
  if (record.error && typeof record.error === 'object') {
    return {
      ...(record.error as Record<string, unknown>),
      payloadType: describePayloadType(record),
    };
  }
  if (data.error && typeof data.error === 'object') {
    return {
      ...(data.error as Record<string, unknown>),
      payloadType: describePayloadType(record),
    };
  }
  return null;
}

function readErrorDetailString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}
