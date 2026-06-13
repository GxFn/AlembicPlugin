import { getCoreFailureTaxonomyEntry } from '@alembic/core/shared';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpErrorResponse,
  createCleanMcpResponse,
  createMcpStructuredToolResult,
  registerMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../../lib/runtime/mcp/output-contract.js';

describe('MCP clean output contract foundation', () => {
  test('creates structured tool results with summary-only visible text', () => {
    const response = createCleanMcpResponse(
      {
        ok: true,
        status: 'ready',
        summary: 'Health result is ready.',
        health: { status: 'ok' },
      },
      'alembic_health'
    );

    const result = createMcpStructuredToolResult(response);

    expect(result.structuredContent).toMatchObject({
      ok: true,
      status: 'ready',
      summary: 'Health result is ready.',
      health: { status: 'ok' },
      meta: {
        contractVersion: 1,
        toolName: 'alembic_health',
      },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Health result is ready.' }]);
    expect(result.isError).toBeUndefined();
  });

  test('creates clean structured error results', () => {
    const response = createCleanMcpErrorResponse({
      code: 'VALIDATION_ERROR',
      details: {
        apiKey: 'must-not-leak',
        field: 'query',
        providerPrivateTrace: 'must-not-leak',
      },
      message: 'Invalid input.',
      responseTimeMs: 12,
      toolName: 'alembic_search',
    });

    const result = createMcpStructuredToolResult(response);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Invalid input.' }]);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        failureId: 'core.failure.invalid-input',
        mcpErrorCode: 'core.failure.invalid-input',
        mcpStatus: 'invalid-input',
        message: 'Invalid input.',
        privateDataSafe: true,
        problemClass: 'request-problem',
        reasonCode: 'invalid-input',
        retryable: false,
        taxonomyVersion: 1,
        details: {
          field: 'query',
        },
      },
      meta: {
        contractVersion: 1,
        responseTimeMs: 12,
        toolName: 'alembic_search',
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('apiKey');
    expect(JSON.stringify(result.structuredContent)).not.toContain('providerPrivateTrace');
  });

  test('preserves provider problem taxonomy fields in clean error objects', () => {
    const providerProblem = {
      ...getCoreFailureTaxonomyEntry('provider-error'),
      code: 'PROVIDER_UPSTREAM_FAILED',
      detailRefs: ['provider-log:42'],
      message: 'Provider failed.',
      providerPrivateTrace: 'must-not-leak',
    };
    const response = createCleanMcpErrorResponse({
      code: 'PROVIDER_UPSTREAM_FAILED',
      details: providerProblem,
      message: 'Provider failed.',
      toolName: 'alembic_search',
    });

    expect(response.error).toMatchObject({
      agentBranch: 'provider-error',
      detailRefs: ['provider-log:42'],
      failureId: 'core.failure.provider-error',
      failureStatus: 'failed',
      mcpErrorCode: 'core.failure.provider-error',
      mcpStatus: 'provider-error',
      problemClass: 'provider-problem',
      reasonCode: 'provider-error',
      refPolicy: 'detailRef',
      retryPolicy: 'retryable-after-backoff',
      retryable: true,
    });
    expect(JSON.stringify(response.error)).not.toContain('providerPrivateTrace');
  });

  test('projects registered tool outputs into structuredContent', () => {
    const outputSchema = CleanMcpResponseBaseSchema.extend({
      result: z.object({
        count: z.number().int().min(0),
      }),
    }).passthrough();
    const unregister = registerMcpOutputProjector({
      outputSchema,
      outputSchemaName: 'TestHealthOutput',
      projectorName: 'test-health-projector',
      toolName: 'alembic_health',
      project(input) {
        const record = input as { total?: unknown };
        return createCleanMcpResponse(
          {
            ok: true,
            status: 'ready',
            summary: 'Projected health count.',
            result: {
              count: typeof record.total === 'number' ? record.total : 0,
            },
          },
          'alembic_health'
        );
      },
    });
    try {
      const result = serializeMcpToolResult(
        'alembic_health',
        { total: 3 },
        {
          isErrorResult: () => false,
        }
      );

      expect(result.content).toEqual([{ type: 'text', text: 'Projected health count.' }]);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        result: { count: 3 },
        meta: {
          outputSchema: 'TestHealthOutput',
          projector: 'test-health-projector',
          toolName: 'alembic_health',
        },
      });

      const tool = withMcpOutputSchema({ name: 'alembic_health' });
      expect(tool.outputSchema).toMatchObject({
        type: 'object',
      });
    } finally {
      unregister();
    }
  });

  test('fails closed with clean structuredContent when a tool has no output projector', () => {
    const legacy = { success: true, data: { total: 1 } };

    const serialized = serializeMcpToolResult('alembic_unregistered_tool', legacy, {
      isErrorResult: () => false,
    });

    expect(serialized.isError).toBe(true);
    expect(serialized.content).toEqual([
      {
        type: 'text',
        text: 'No clean MCP output projector is registered for alembic_unregistered_tool.',
      },
    ]);
    expect(serialized.structuredContent).toMatchObject({
      ok: false,
      status: 'blocked',
      error: { code: 'CLEAN_OUTPUT_PROJECTOR_MISSING' },
      meta: {
        contractVersion: 1,
        toolName: 'alembic_unregistered_tool',
      },
    });
  });

  test('classifies legacy evidence-gate errors as caller-repairable input quality', () => {
    const serialized = serializeMcpToolResult(
      'alembic_submit_knowledge',
      {
        success: false,
        errorCode: 'SOURCE_REF_LINE_MISSING',
        message: 'Source ref must include a line or line range.',
        data: {
          evidenceGate: {
            status: 'rebuild-required',
          },
        },
      },
      {
        isErrorResult: () => true,
      }
    );

    expect(serialized.isError).toBe(true);
    expect(serialized.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'SOURCE_REF_LINE_MISSING',
        failureId: 'core.failure.invalid-input',
        mcpStatus: 'invalid-input',
        problemClass: 'request-problem',
        reasonCode: 'invalid-input',
      },
      toolName: 'alembic_submit_knowledge',
    });
  });

  test('classifies durable bootstrap lease conflicts as public state conflicts', () => {
    const response = createCleanMcpErrorResponse({
      code: 'BOOTSTRAP_IN_PROGRESS',
      details: {
        activeSessionId: 'bs-active',
        mcpErrorCode: 'core.failure.conflict',
        problemClass: 'state-conflict',
        reason: 'bootstrap_in_progress',
        retryable: true,
        state: 'bootstrap_in_progress',
      },
      message: 'Bootstrap already in progress for this project.',
      toolName: 'alembic_bootstrap',
    });

    expect(response.error).toMatchObject({
      code: 'BOOTSTRAP_IN_PROGRESS',
      details: {
        activeSessionId: 'bs-active',
        mcpErrorCode: 'core.failure.conflict',
        state: 'bootstrap_in_progress',
      },
      failureId: 'core.failure.conflict',
      mcpErrorCode: 'core.failure.conflict',
      mcpStatus: 'conflict',
      problemClass: 'state-conflict',
      reasonCode: 'conflict',
      retryable: true,
    });
  });
});

// MT/CC3 F1 回归：错误信封必须满足按工具声明的输出 schema（顶层 toolName 为
// z.literal 必填）。CC3 现场证据：缺顶层 toolName 时 SDK 客户端以 -32602 拒收。
describe('clean error responses satisfy the declared core-tools output schema (F1)', () => {
  it('carries the top-level toolName required by the per-tool literal schema', async () => {
    const { createCleanMcpErrorResponse } = await import('#codex/mcp/output-contract.js');
    const { CORE_TOOL_OUTPUT_SCHEMAS } = await import('#codex/mcp/core-tools/output.js');
    const response = createCleanMcpErrorResponse({
      code: 'VALIDATION_ERROR',
      message: '输入校验失败: dimensionId is required',
      responseTimeMs: 1,
      toolName: 'alembic_dimension_complete',
    });
    expect(response.toolName).toBe('alembic_dimension_complete');
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_dimension_complete.safeParse(response);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });
});
