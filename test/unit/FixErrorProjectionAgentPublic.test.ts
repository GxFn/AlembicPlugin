/**
 * Lane G / G1 回归：错误与不可用结果必须穿过输出投影，并满足各工具已发布的
 * outputSchema（MCP TS SDK Client.callTool 在 isError=true 时同样校验
 * structuredContent，不合 schema 会抛 -32602 遮蔽真实错误）。
 *
 * 覆盖：
 * - PROJECT_ROOT_REQUIRED clean error 经 prime/work/code_guard 投影后保留 code/message/requiredActions；
 * - wrapHandler 的 VALIDATION_ERROR / 抛出异常对 agent-public 工具产出合规失败输出，
 *   core/local/knowledge 工具保持既有合规输出；
 * - TOOL_TIMEOUT / CANCELLED 保持 timeout / cancelled 分类与可重试性；
 * - 投影合成失败使用运行时 host，而非硬编码 codex；
 * - 遗留未映射错误码不再回落 internal-error。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotFoundError } from '@alembic/core/shared';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { buildProjectRuntimeContext } from '#host-runtime/context/ProjectRuntimeContext.js';
import { ALEMBIC_PLUGIN_HOST_ENV } from '#host-runtime/context/RuntimeContext.js';
import { wrapHandler } from '#host-runtime/mcp/errorHandler.js';
import { failureResult, isErrorResult } from '#host-runtime/mcp/host/results.js';
import {
  createCleanMcpError,
  createCleanMcpErrorResponse,
  getMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '#host-runtime/mcp/output-contract.js';
import '#host-runtime/mcp/public-tools/output.js';
import '#host-runtime/mcp/core-tools/output.js';
import '#host-runtime/mcp/local-tools/output.js';
import '#host-runtime/mcp/knowledge-context-tools/search-output.js';
import '#host-runtime/mcp/knowledge-context-tools/graph-output.js';
import '#host-runtime/mcp/knowledge-context-tools/recipe-map-output.js';
import { CORE_CLEAN_OUTPUT_TOOL_NAMES } from '#host-runtime/mcp/core-tools/output.js';
import { LOCAL_CLEAN_OUTPUT_TOOL_NAMES } from '#host-runtime/mcp/local-tools/output.js';

const AGENT_PUBLIC_TOOLS = ['alembic_prime', 'alembic_work', 'alembic_code_guard'] as const;
const ajv = new AjvJsonSchemaValidator();
const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 以已发布 outputSchema（zod 与 SDK 同款 ajv JSON Schema）双重校验 structuredContent。 */
// knowledge 工具的 zod meta 是 strict，而 projectMcpToolOutput 统一追加 meta.projector/
// toolName（既有行为，线上 JSON Schema 已去掉 additionalProperties:false）；对它们只校验
// 客户端实际执行的 ajv 契约。
const AJV_ONLY_TOOLS = new Set(['alembic_search', 'alembic_graph', 'alembic_recipe_map']);

function expectPublishedSchemaValid(toolName: string, structured: unknown) {
  const projector = getMcpOutputProjector(toolName);
  expect(projector, toolName).not.toBeNull();
  if (!AJV_ONLY_TOOLS.has(toolName)) {
    const zodResult = projector?.outputSchema.safeParse(structured);
    expect(
      zodResult?.success,
      `${toolName} zod: ${JSON.stringify(zodResult?.error?.issues ?? [])}`
    ).toBe(true);
  }
  const published = withMcpOutputSchema({ name: toolName }) as { outputSchema?: unknown };
  const validate = ajv.getValidator(
    published.outputSchema as Parameters<typeof ajv.getValidator>[0]
  );
  const ajvResult = validate(structured);
  expect(ajvResult.valid, `${toolName} ajv: ${ajvResult.errorMessage ?? ''}`).toBe(true);
}

function makeProjectRuntime() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-error-projection-'));
  tempRoots.push(projectRoot);
  return buildProjectRuntimeContext({ projectRoot });
}

describe('agent-public tools project clean error responses', () => {
  test.each(
    AGENT_PUBLIC_TOOLS
  )('%s keeps PROJECT_ROOT_REQUIRED code, message and actions', (name) => {
    const requiredActions = ['Pass the current workspace directory as projectRoot.'];
    const producer = createCleanMcpErrorResponse({
      code: 'PROJECT_ROOT_REQUIRED',
      details: {
        projectRootResolution: { path: null, source: null, trust: 'rejected' },
        requiredActions,
      },
      message: 'Alembic cannot determine the target project directory.',
      status: 'project-root-required',
      toolName: name,
    });

    const result = serializeMcpToolResult(name, producer, { isErrorResult });
    const structured = asRecord(result.structuredContent);

    expect(result.isError).toBe(true);
    expectPublishedSchemaValid(name, structured);
    const error = asRecord(structured.error);
    expect(error.code).toBe('PROJECT_ROOT_REQUIRED');
    expect(error.message).toBe('Alembic cannot determine the target project directory.');
    expect(error.reasonCode).not.toBe('internal-error');
    expect(asRecord(error.details).requiredActions).toEqual(requiredActions);
    expect(structured.summary).toBe('Alembic cannot determine the target project directory.');
    expect(JSON.stringify(structured)).not.toContain('AGENT_PUBLIC_OUTPUT_PROJECTION_REJECTED');
  });

  test.each(
    AGENT_PUBLIC_TOOLS
  )('%s projects a legacy failureResult with actionable data', (name) => {
    const producer = failureResult(name, 'Project is not initialized for Alembic.', {
      code: 'PROJECT_NOT_INITIALIZED',
      data: {
        projectRuntime: makeProjectRuntime(),
        requiredActions: ['Run alembic_status to initialize the project.'],
        nextActions: [{ tool: 'alembic_status', reason: 'Initialize first.', required: true }],
      },
    });

    const result = serializeMcpToolResult(name, producer, { isErrorResult });
    const structured = asRecord(result.structuredContent);

    expectPublishedSchemaValid(name, structured);
    const error = asRecord(structured.error);
    expect(error.code).toBe('PROJECT_NOT_INITIALIZED');
    expect(error.message).toBe('Project is not initialized for Alembic.');
    expect(error.reasonCode).not.toBe('internal-error');
    expect(asRecord(error.details).requiredActions).toEqual([
      'Run alembic_status to initialize the project.',
    ]);
    expect(asRecord(error.details).nextActions).toEqual([
      { tool: 'alembic_status', reason: 'Initialize first.', required: true },
    ]);
  });
});

describe('wrapHandler errors satisfy the published outputSchema', () => {
  test('alembic_work VALIDATION_ERROR becomes a schema-valid agent-public failure', async () => {
    const wrapped = wrapHandler('alembic_work', async () => ({ unreachable: true }));
    const raw = await wrapped({}, { phase: 42 } as unknown as Record<string, unknown>);

    for (const candidate of [raw, serializeMcpToolResult('alembic_work', raw, { isErrorResult })]) {
      const structured = asRecord(asRecord(candidate).structuredContent);
      expect(asRecord(candidate).isError).toBe(true);
      expectPublishedSchemaValid('alembic_work', structured);
      expect(asRecord(structured.error).code).toBe('VALIDATION_ERROR');
      expect(String(asRecord(structured.error).message)).toContain('phase');
      expect(asRecord(structured.error).reasonCode).toBe('invalid-input');
    }
  });

  test.each(AGENT_PUBLIC_TOOLS)('%s thrown business errors keep their code', async (name) => {
    const wrapped = wrapHandler(
      name,
      async () => {
        throw new NotFoundError('Work record', 'work-123');
      },
      // 跳过各工具真实输入校验，直达 handler 抛错路径。
      z.object({}).passthrough()
    );
    const raw = await wrapped({}, {});
    const result = serializeMcpToolResult(name, raw, { isErrorResult });
    const structured = asRecord(result.structuredContent);

    expectPublishedSchemaValid(name, structured);
    expect(asRecord(structured.error).code).toBe('NOT_FOUND');
    expect(asRecord(structured.error).reasonCode).toBe('not-found');
  });

  test('core, local and knowledge tools keep schema-valid wrapHandler errors', async () => {
    const names = [
      ...CORE_CLEAN_OUTPUT_TOOL_NAMES,
      ...LOCAL_CLEAN_OUTPUT_TOOL_NAMES,
      'alembic_search',
      'alembic_graph',
      'alembic_recipe_map',
    ];
    for (const name of names) {
      const wrapped = wrapHandler(name, async () => {
        throw new Error(`boom ${name}`);
      });
      const raw = await wrapped({}, {});
      const result = serializeMcpToolResult(name, raw, { isErrorResult });
      expect(result.isError, name).toBe(true);
      expectPublishedSchemaValid(name, result.structuredContent);
    }
  });
});

describe('knowledge tools keep clean error codes', () => {
  test.each([
    'alembic_search',
    'alembic_graph',
    'alembic_recipe_map',
  ])('%s preserves PROJECT_ROOT_REQUIRED instead of a contract mismatch', (name) => {
    const producer = createCleanMcpErrorResponse({
      code: 'PROJECT_ROOT_REQUIRED',
      details: { requiredActions: ['Pass projectRoot.'] },
      message: 'Alembic cannot determine the target project directory.',
      status: 'project-root-required',
      toolName: name,
    });
    const structured = asRecord(
      serializeMcpToolResult(name, producer, { isErrorResult }).structuredContent
    );
    expectPublishedSchemaValid(name, structured);
    expect(asRecord(structured.error).code).toBe('PROJECT_ROOT_REQUIRED');
    expect(asRecord(asRecord(structured.error).details).requiredActions).toEqual([
      'Pass projectRoot.',
    ]);
    expect(JSON.stringify(structured)).not.toContain('output-contract-mismatch');
  });
});

describe('agent-public producer failures keep the error taxonomy', () => {
  test.each(AGENT_PUBLIC_TOOLS)('%s TOOL_TIMEOUT stays a retryable timeout', (name) => {
    const producer = failureResult(name, 'Tool call exceeded its deadline.', {
      code: 'TOOL_TIMEOUT',
      data: { projectRuntime: makeProjectRuntime(), retryable: true },
    });
    const structured = asRecord(
      serializeMcpToolResult(name, producer, { isErrorResult }).structuredContent
    );
    expectPublishedSchemaValid(name, structured);
    const error = asRecord(structured.error);
    expect(error.code).toBe('TOOL_TIMEOUT');
    expect(error.reasonCode).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.retryPolicy).toBe('retryable');
    expect(asRecord(structured.reason).retryable).toBe(true);
  });

  test.each(AGENT_PUBLIC_TOOLS)('%s CANCELLED stays a cancellation', (name) => {
    const producer = failureResult(name, 'Tool call was cancelled.', {
      code: 'CANCELLED',
      data: { projectRuntime: makeProjectRuntime(), retryable: false },
    });
    const structured = asRecord(
      serializeMcpToolResult(name, producer, { isErrorResult }).structuredContent
    );
    expectPublishedSchemaValid(name, structured);
    const error = asRecord(structured.error);
    expect(error.code).toBe('CANCELLED');
    expect(error.reasonCode).toBe('cancelled');
    expect(error.retryable).toBe(false);
  });

  test.each(AGENT_PUBLIC_TOOLS)('%s synthesized failures report the runtime host', (name) => {
    vi.stubEnv(ALEMBIC_PLUGIN_HOST_ENV, 'claude-code');
    const producer = failureResult(name, 'Producer crashed.', {
      code: 'INTERNAL_ERROR',
      data: { projectRuntime: makeProjectRuntime() },
    });
    const structured = asRecord(
      serializeMcpToolResult(name, producer, { isErrorResult }).structuredContent
    );
    expectPublishedSchemaValid(name, structured);
    expect(structured.agentHost).toBe('claude-code');

    const rejected = asRecord(
      serializeMcpToolResult(name, { unexpected: true }, { isErrorResult }).structuredContent
    );
    expect(asRecord(rejected.error).code).toBe('AGENT_PUBLIC_OUTPUT_PROJECTION_REJECTED');
    expect(rejected.agentHost).toBe('claude-code');
  });
});

describe('error taxonomy maps plugin-owned codes off internal-error', () => {
  const expected: Array<[string, string]> = [
    ['PROJECT_ROOT_REQUIRED', 'invalid-input'],
    ['PROJECT_NOT_INITIALIZED', 'not-found'],
    ['PROJECT_CONTEXT_CURSOR_EXPIRED', 'not-found'],
    ['PROJECT_CONTEXT_FACTS_CHANGED', 'conflict'],
    ['PROJECT_CONTEXT_CURSOR_INVALID', 'invalid-input'],
    ['PROJECT_CONTEXT_CURSOR_CONFINED', 'permission-denied'],
    ['PROJECT_CONTEXT_FACT_SESSION_INVALID', 'invalid-input'],
    ['CODEX_RUNTIME_ACTION_REQUIRED', 'invalid-input'],
    ['PLAN_REQUIRED', 'needs-confirmation'],
    ['PLAN_GENERATION_IN_PROGRESS', 'conflict'],
    ['PLAN_CONFIRM_PAYLOAD_REQUIRED', 'invalid-input'],
    ['PLAN_CONFIRM_PAYLOAD_INVALID', 'invalid-input'],
    ['PLAN_PROJECT_CONTEXT_EMPTY', 'not-found'],
    ['PLAN_GET_REMOVED', 'capability-mismatch'],
    ['PLAN_CERTIFIED_MODULE_AXIS_BLOCKED', 'conflict'],
  ];
  test.each(expected)('%s → %s', (code, kind) => {
    const error = createCleanMcpError({ code, message: `probe ${code}` });
    expect(error.reasonCode).toBe(kind);
    expect(error.failureId).toBe(`core.failure.${kind}`);
  });

  test.each([
    'PROJECT_CONTEXT_FACTS_CHANGED',
    'PROJECT_CONTEXT_CURSOR_EXPIRED',
  ])('%s keeps the producer retryability', (code) => {
    // 可重试性来自 producer 显式 retryable（embedded-executor 总会传入），而非分类默认值。
    expect(createCleanMcpError({ code, message: 'probe', retryable: true }).retryable).toBe(true);
  });
});
