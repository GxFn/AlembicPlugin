import type { CoreFieldFailureKind } from '@alembic/core/shared';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { z } from 'zod';
import {
  CleanMcpFailureTaxonomySchema,
  createCleanMcpFailureTaxonomy,
  normalizeHostMcpErrorCode,
  sanitizeCleanMcpErrorDetails,
} from './error-taxonomy.js';
import { ProjectRuntimeContextV3Schema } from './project-runtime-output-schema.js';
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

const CleanMcpTransientTransportRefSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    path: z.string().min(1),
  })
  .strict();

const CleanMcpCoverageLedgerSeedSchema = z
  .object({
    status: z.string().min(1).max(80),
    reason: z.string().min(1).max(240).optional(),
    writtenCells: z.number().int().nonnegative().optional(),
    coveredPathCount: z.number().int().nonnegative().optional(),
    moduleCount: z.number().int().nonnegative().optional(),
    dimensionIds: z.array(z.string().min(1).max(160)).optional(),
  })
  .strict();

export const CleanMcpMetaSchema = z
  .object({
    contractVersion: z.literal(CLEAN_MCP_OUTPUT_CONTRACT_VERSION),
    coverageLedgerSeed: CleanMcpCoverageLedgerSeedSchema.optional(),
    // Graph's public contract makes these verification boundaries explicit.
    // Keep the exact literals here so projector-produced failures remain valid
    // clean MCP responses without widening transport metadata arbitrarily.
    callClaimsRequireSourceVerification: z.literal(true).optional(),
    fullBriefingRef: CleanMcpTransientTransportRefSchema.nullable().optional(),
    fullMapRef: CleanMcpTransientTransportRefSchema.nullable().optional(),
    generatedAt: z.string().datetime({ offset: true }).optional(),
    outputSchema: z.string().min(1).max(160).optional(),
    producer: z.string().min(1).max(160).optional(),
    projector: z.string().min(1).max(160).optional(),
    responseTimeMs: z.number().nonnegative().optional(),
    source: z.string().min(1).max(160).optional(),
    sourceOfTruth: z.literal(false).optional(),
    toolName: z.string().min(1).max(160).optional(),
    traceRef: z.string().min(1).max(240).optional(),
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
export type CleanMcpError = z.infer<typeof CleanMcpErrorSchema>;

// createCleanMcpErrorResponse 的封闭形态（ok=false + error + 可选顶层 toolName）。
// 各工具投影器据此识别"已分类的通用错误"并保留原始 code/message/details，
// strict 防止把任意业务载荷当成错误吞掉。
const CleanMcpErrorResponseSchema = CleanMcpResponseBaseSchema.extend({
  error: CleanMcpErrorSchema,
  ok: z.literal(false),
  toolName: z.string().min(1).max(160).optional(),
}).strict();

export type CleanMcpErrorResponse = z.infer<typeof CleanMcpErrorResponseSchema>;

/**
 * 读取一个通用 clean 错误响应（如 PROJECT_ROOT_REQUIRED、wrapHandler 的
 * VALIDATION_ERROR）。toolName 存在且与目标工具不一致时拒绝，避免跨工具误投影。
 */
export function readCleanMcpErrorResponse(
  value: unknown,
  toolName: string
): CleanMcpErrorResponse | null {
  const parsed = CleanMcpErrorResponseSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.toolName !== undefined && parsed.data.toolName !== toolName) {
    return null;
  }
  return parsed.data;
}

// failureResult 携带的可执行指引（如 PROJECT_NOT_INITIALIZED 的 requiredActions /
// nextActions）。有界、封闭，随 error.details 原样交付给宿主。
export const ProducerRequiredActionsSchema = z.array(z.string().min(1).max(600)).max(20);
export const ProducerNextActionsSchema = z
  .array(
    z.union([
      z.string().min(1).max(600),
      z
        .object({
          tool: z.string().min(1).max(120),
          reason: z.string().min(1).max(600),
          required: z.boolean().optional(),
        })
        .strict(),
    ])
  )
  .max(20);

export const PRODUCER_FAILURE_MESSAGE_MAX_CHARS = 4000;

/** 解析后的 producer 失败消息：text 已有界，truncated/originalLength 供投影处写诊断。 */
export interface ProducerFailureMessage {
  originalLength: number;
  text: string;
  truncated: boolean;
}

// producer 失败消息：任意非空长度都接受，超长时截断到有界长度。
// 只读执行器会把 ZodError 的整段 issue JSON 包进消息，数千字符很常见；若用 max()
// 拒绝，整个 failureResult 解析失败，原始错误码会被 PROJECTION_REJECTED /
// contract-mismatch 吞掉。transform 必须无副作用：同一消息可能被多个 schema
// 解析，截断诊断只在构建投影失败输出时由 logProducerFailureMessageTruncation 写一次。
export const ProducerFailureMessageSchema = z
  .string()
  .min(1)
  .transform(
    (message): ProducerFailureMessage => ({
      originalLength: message.length,
      text: message.slice(0, PRODUCER_FAILURE_MESSAGE_MAX_CHARS),
      truncated: message.length > PRODUCER_FAILURE_MESSAGE_MAX_CHARS,
    })
  );

/** 投影构建处调用：消息被截断时写一条 stderr 诊断（不写 stdout，stdout 是 MCP 协议通道）。 */
export function logProducerFailureMessageTruncation(
  toolName: string,
  errorCode: string,
  message: ProducerFailureMessage
): void {
  if (!message.truncated) {
    return;
  }
  process.stderr.write(
    `[MCP/output-contract] ${toolName} truncated producer failure message from ${message.originalLength} to ${message.text.length} chars; error code ${errorCode} preserved\n`
  );
}

// host/results.ts failureResult 的封闭形态（EmbeddedToolExecutor / HostMcpServer catch
// 路径产出）。projectRuntime 可缺省：执行上下文建立前的失败同样必须保留原始错误码。
// 额外字段不被接受，避免把任意业务载荷伪装成合法失败。
const McpProducerFailureResultSchema = z
  .object({
    success: z.literal(false),
    data: z
      .object({
        nextActions: ProducerNextActionsSchema.optional(),
        projectRuntime: ProjectRuntimeContextV3Schema.optional(),
        requiredActions: ProducerRequiredActionsSchema.optional(),
        retryable: z.boolean().optional(),
      })
      .strict(),
    errorCode: z.string().min(1).max(120),
    message: ProducerFailureMessageSchema,
    tool: z.string().min(1).max(160),
  })
  .strict();

/** 已分类的 producer 失败：保留原始错误码、消息、可重试性与可执行指引。 */
export interface McpClassifiedFailure {
  error: CleanMcpError;
  /** producer 指引（error.details.nextActions），由各工具按自身 nextActions 契约过滤。 */
  nextActions?: unknown;
  /** 请求项目根；执行上下文未建立（如 PROJECT_ROOT_REQUIRED）时为 null。 */
  projectRoot: string | null;
  summary: string;
}

/**
 * 读取 failureResult 形态的 producer 失败（任意错误码）。分类由原始错误码决定，
 * producer 显式 retryable 优先于分类默认（续页 CURSOR_EXPIRED / FACTS_CHANGED 等）。
 */
export function readMcpProducerFailure(
  value: unknown,
  toolName: string
): McpClassifiedFailure | null {
  const parsed = McpProducerFailureResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.tool !== toolName) {
    return null;
  }
  const { data } = parsed.data;
  const message = parsed.data.message;
  logProducerFailureMessageTruncation(toolName, parsed.data.errorCode, message);
  const hasActions = data.requiredActions !== undefined || data.nextActions !== undefined;
  const error = createCleanMcpError({
    code: parsed.data.errorCode,
    ...(hasActions
      ? {
          details: {
            ...(data.requiredActions ? { requiredActions: data.requiredActions } : {}),
            ...(data.nextActions ? { nextActions: data.nextActions } : {}),
          },
        }
      : {}),
    message: message.text,
    ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
    status: 'failed',
  });
  return {
    error,
    nextActions: data.nextActions,
    projectRoot: data.projectRuntime?.identity.projectRoot ?? null,
    summary: message.text,
  };
}

/** 通用 clean 错误 → 已分类失败（请求项目根未知）。 */
export function readMcpCleanErrorFailure(
  value: unknown,
  toolName: string
): McpClassifiedFailure | null {
  const cleanError = readCleanMcpErrorResponse(value, toolName);
  if (!cleanError) {
    return null;
  }
  const details = cleanError.error.details;
  return {
    error: cleanError.error,
    nextActions:
      details && typeof details === 'object' && !Array.isArray(details)
        ? (details as Record<string, unknown>).nextActions
        : undefined,
    projectRoot: null,
    summary: cleanError.summary,
  };
}

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
  retryable?: boolean;
  source?: unknown;
  status?: string;
}): z.infer<typeof CleanMcpErrorSchema> {
  const details = sanitizeCleanMcpErrorDetails(input.details);
  const code = normalizeHostMcpErrorCode(input.code);
  return CleanMcpErrorSchema.parse({
    code,
    message: input.message,
    ...createCleanMcpFailureTaxonomy({
      code,
      details,
      failureKind: input.failureKind,
      retryable: input.retryable,
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

export function createMcpStructuredToolResult(
  response: CleanMcpResponse,
  transportMeta?: CallToolResult['_meta']
): CallToolResult {
  const parsed = CleanMcpResponseSchema.parse(response);
  return {
    ...(transportMeta ? { _meta: transportMeta } : {}),
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
    return reprojectNonConformingErrorToolResult(toolName, value);
  }
  const { payload, transportMeta } = splitMcpTransportMetadata(value);
  const projected = projectMcpToolOutput(toolName, payload);
  if (projected) {
    return createMcpStructuredToolResult(projected, transportMeta);
  }
  if (isCleanMcpResponse(payload)) {
    return createMcpStructuredToolResult(payload, transportMeta);
  }
  if (options.isErrorResult(payload)) {
    return createMcpStructuredToolResult(
      projectLegacyErrorAsCleanResponse(toolName, payload),
      transportMeta
    );
  }
  return createMcpStructuredToolResult(
    createCleanMcpErrorResponse({
      code: 'CLEAN_OUTPUT_PROJECTOR_MISSING',
      details: { payloadType: describePayloadType(value) },
      message: `No clean MCP output projector is registered for ${toolName}.`,
      status: 'blocked',
      toolName,
    }),
    transportMeta
  );
}

/**
 * 把通用 clean 错误响应包装为 CallToolResult，并保证 structuredContent 满足该工具
 * 已发布的 outputSchema（wrapHandler 等直接产出 CallToolResult 的错误路径使用）。
 */
export function createProjectedMcpErrorToolResult(
  toolName: string,
  response: CleanMcpResponse,
  transportMeta?: CallToolResult['_meta']
): CallToolResult {
  return reprojectNonConformingErrorToolResult(
    toolName,
    createMcpStructuredToolResult(response, transportMeta)
  );
}

/**
 * MCP TS SDK 的 Client.callTool 即使 isError=true 也按工具 outputSchema 校验
 * structuredContent；不合规时客户端抛 -32602，真实错误信息被遮蔽。已是
 * CallToolResult 的错误结果若不满足已注册投影器的 schema，则交给该投影器重投影
 * （投影器负责保留原始错误码或给出显式拒绝诊断）。成功结果与合规错误原样透传。
 */
function reprojectNonConformingErrorToolResult(
  toolName: string,
  result: CallToolResult
): CallToolResult {
  if (result.isError !== true || result.structuredContent === undefined) {
    return result;
  }
  const projector = getMcpOutputProjector(toolName);
  if (!projector || matchesPublishedOutputSchema(projector, result.structuredContent)) {
    return result;
  }
  const reprojected = projectMcpToolOutput(toolName, result.structuredContent);
  if (!reprojected) {
    return result;
  }
  const sourceCode = readErrorDetailString(
    (result.structuredContent as Record<string, unknown>).error,
    'code'
  );
  process.stderr.write(
    `[MCP/OutputContract] ${toolName} error result did not match its outputSchema; re-projected via ${projector.projectorName} (sourceCode=${sourceCode ?? 'none'}, projectedCode=${readErrorDetailString(reprojected.error, 'code') ?? 'none'})\n`
  );
  return createMcpStructuredToolResult(reprojected, result._meta);
}

type PublishedOutputValidator = (value: unknown) => { valid: boolean };
const publishedOutputValidators = new WeakMap<McpOutputProjector, PublishedOutputValidator>();
let publishedOutputSchemaValidator: AjvJsonSchemaValidator | null = null;

/**
 * 以客户端实际收到的 tools/list outputSchema（zodToMcpSchema 产物，与 SDK Client
 * 同款 ajv 校验）判定错误结果是否合规；zod strict 比线上契约更严，不能用它把线上
 * 合规的错误改写掉。JSON Schema 无法编译时回退 zod 判定并记录诊断。
 */
function matchesPublishedOutputSchema(projector: McpOutputProjector, value: unknown): boolean {
  let validator = publishedOutputValidators.get(projector);
  if (!validator) {
    try {
      publishedOutputSchemaValidator ??= new AjvJsonSchemaValidator();
      const compiled = publishedOutputSchemaValidator.getValidator(
        zodToMcpSchema(projector.outputSchema) as Parameters<
          AjvJsonSchemaValidator['getValidator']
        >[0]
      );
      validator = (candidate) => compiled(candidate);
    } catch (err: unknown) {
      process.stderr.write(
        `[MCP/OutputContract] ${projector.toolName} published outputSchema could not be compiled; falling back to zod validation: ${err instanceof Error ? err.message : String(err)}\n`
      );
      validator = (candidate) => ({
        valid: projector.outputSchema.safeParse(candidate).success,
      });
    }
    publishedOutputValidators.set(projector, validator);
  }
  return validator(value).valid;
}

function splitMcpTransportMetadata(value: unknown): {
  payload: unknown;
  transportMeta?: CallToolResult['_meta'];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { payload: value };
  }
  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, '_meta') ||
    !record._meta ||
    typeof record._meta !== 'object' ||
    Array.isArray(record._meta)
  ) {
    return { payload: value };
  }
  const { _meta: transportMeta, ...payload } = record;
  return {
    payload,
    transportMeta: transportMeta as CallToolResult['_meta'],
  };
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
