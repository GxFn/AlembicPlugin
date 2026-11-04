/**
 * GMAP-8b: register the clean MCP output projector for alembic_search.
 *
 * alembic_search emits its own AlembicSearchOutput rather than the shared
 * KnowledgeContextToolOutput envelope. The search handler already returns a
 * CallToolResult, so this projector advertises the AlembicSearchOutput schema in
 * tools/list and provides a typed fallback projection.
 */
import type { z } from 'zod';
import {
  AlembicSearchOutputSchema,
  SearchNextActionSchema,
} from '#service/project-knowledge-context/index.js';
import {
  type KnowledgeUnavailableProjection,
  readKnowledgeUnavailableResult,
} from '../host/knowledge-unavailable-result.js';
import {
  CleanMcpErrorSchema,
  type CleanMcpResponse,
  createCleanMcpError,
  type McpClassifiedFailure,
  readMcpCleanErrorFailure,
  readMcpProducerFailure,
  registerMcpOutputProjector,
} from '../output-contract.js';

export const SEARCH_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_search'] as const;

const AlembicSearchCleanOutputSchema = AlembicSearchOutputSchema.extend({
  error: CleanMcpErrorSchema.optional(),
}) as unknown as z.ZodType<CleanMcpResponse>;

function projectAlembicSearchCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicSearchCleanOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  // 只读 producer 的知识不可用结果（无数据库 / strict route 缺失）投影为原生 unavailable，
  // 而不是契约不匹配失败。
  const unavailable = readKnowledgeUnavailableResult(input, 'alembic_search');
  if (unavailable) {
    return buildAlembicSearchUnavailableOutput(unavailable);
  }
  // 通用 clean 错误（PROJECT_ROOT_REQUIRED / wrapHandler 错误）与 failureResult 形态的
  // producer 失败（任意错误码，含续页 CURSOR_EXPIRED / FACTS_CHANGED）都已分类：保留
  // 原始 error（code/message/retryable/details），不能退化成泛化的 output-contract-mismatch。
  const failure =
    readMcpCleanErrorFailure(input, 'alembic_search') ??
    readMcpProducerFailure(input, 'alembic_search');
  if (failure) {
    process.stderr.write(
      `[MCP/alembic_search] projected producer error ${failure.error.code} (retryable=${failure.error.retryable}) into AlembicSearchOutput\n`
    );
    return buildAlembicSearchProducerFailure(failure);
  }
  return buildAlembicSearchProjectionFailure();
}

function buildAlembicSearchProducerFailure(failure: McpClassifiedFailure): CleanMcpResponse {
  const errorCode = failure.error.code;
  const summary = failure.summary.slice(0, 2000);
  const retryable = failure.error.retryable;
  return AlembicSearchCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation: 'search',
    summary,
    items: [],
    detailRefs: [],
    sources: [],
    diagnostics: [
      {
        code: errorCode,
        message: summary.slice(0, 800),
        retryable,
        severity: 'error',
      },
    ],
    nextActions: projectSearchNextActions(failure.nextActions),
    error: failure.error,
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicSearchOutput',
      producer: 'alembic-search-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

/**
 * 知识不可用的原生 search 输出。
 * - legacy（无数据库，项目未初始化）：不是工具失败——ok=true、isError 不置位，status 取
 *   search 状态词表中的 'degraded'（工具可用但知识层缺席），并给出 alembic_init 指引；
 *   投影绝不触发初始化。
 * - strict route 缺失：已初始化项目的发布故障，保持 ok=false/isError（既有 strict 传输契约），
 *   status 取 'blocked'（发布修复之前无法提供知识），error.code 保留原因码。
 */
function buildAlembicSearchUnavailableOutput(
  unavailable: KnowledgeUnavailableProjection
): CleanMcpResponse {
  const summary = unavailable.summary.slice(0, 2000);
  process.stderr.write(
    `[MCP/alembic_search] knowledge unavailable (${unavailable.reasonCode}); returning native ${unavailable.strictRouteUnavailable ? 'blocked' : 'degraded'} output without initializing\n`
  );
  return AlembicSearchCleanOutputSchema.parse({
    ok: !unavailable.strictRouteUnavailable,
    status: unavailable.strictRouteUnavailable ? 'blocked' : 'degraded',
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation: 'search',
    summary,
    items: [],
    detailRefs: [],
    sources: [],
    diagnostics: [
      {
        code: unavailable.reasonCode,
        domain: 'knowledge',
        message: summary.slice(0, 800),
        retryable: false,
        severity: 'info',
      },
    ],
    nextActions: projectSearchNextActions(unavailable.nextActions),
    ...(unavailable.strictRouteUnavailable
      ? {
          error: createCleanMcpError({
            code: unavailable.reasonCode,
            failureKind: 'unavailable',
            message: summary,
            retryable: false,
            status: 'blocked',
          }),
        }
      : {}),
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicSearchOutput',
      producer: 'alembic-search-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

/** producer 指引中满足 SearchNextAction 契约的条目（字符串指引已在 error.details 中保留）。 */
function projectSearchNextActions(value: unknown): z.infer<typeof SearchNextActionSchema>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 20).flatMap((entry) => {
    const parsed = SearchNextActionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function buildAlembicSearchProjectionFailure(): CleanMcpResponse {
  return AlembicSearchCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_search',
    toolName: 'alembic_search',
    operation: 'search',
    summary: 'alembic_search output did not match the public AlembicSearchOutput contract.',
    items: [],
    detailRefs: [],
    sources: [],
    diagnostics: [
      {
        code: 'alembic-search-output-contract-mismatch',
        message: 'alembic_search handler returned a payload outside AlembicSearchOutput.',
        retryable: false,
        severity: 'error',
      },
    ],
    nextActions: [],
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicSearchOutput',
      producer: 'alembic-search-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

registerMcpOutputProjector({
  outputSchema: AlembicSearchCleanOutputSchema,
  outputSchemaName: 'alembic_search_clean_output',
  project: (input) => projectAlembicSearchCleanOutput(input),
  projectorName: 'alembic-search-clean-output-projector',
  toolName: 'alembic_search',
});
