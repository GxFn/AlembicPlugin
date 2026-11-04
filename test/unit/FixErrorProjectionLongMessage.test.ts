/**
 * Lane G 复审回归：
 * - producer 失败消息超过 4000 字符（如只读执行器把 ZodError 的整段 issue JSON 包进
 *   'Plugin-owned tool execution failed: <json>'）时，六个投影器仍须保留原始错误码，
 *   消息被截断而不是让整个 failureResult 解析失败、退化为 PROJECTION_REJECTED /
 *   通用 contract-mismatch；
 * - ProjectContext 续页错误码映射到语义正确的 Core failureKind（事实变化=conflict，
 *   游标过期=not-found），可重试性由 producer 显式 retryable 决定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '#host-runtime/context/ProjectRuntimeContext.js';
import { failureResult, isErrorResult } from '#host-runtime/mcp/host/results.js';
import {
  createCleanMcpError,
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

const PROJECTOR_TOOLS = [
  'alembic_prime',
  'alembic_work',
  'alembic_code_guard',
  'alembic_search',
  'alembic_graph',
  'alembic_recipe_map',
] as const;

const ajv = new AjvJsonSchemaValidator();
const tempRoots: string[] = [];

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

function makeProjectRuntime() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-error-long-message-'));
  tempRoots.push(projectRoot);
  return buildProjectRuntimeContext({ projectRoot });
}

function expectPublishedSchemaValid(toolName: string, structured: unknown): void {
  expect(getMcpOutputProjector(toolName), toolName).not.toBeNull();
  const published = withMcpOutputSchema({ name: toolName }) as { outputSchema?: unknown };
  const validate = ajv.getValidator(
    published.outputSchema as Parameters<typeof ajv.getValidator>[0]
  );
  const result = validate(structured);
  expect(result.valid, `${toolName} ajv: ${result.errorMessage ?? ''}`).toBe(true);
}

// 与 embedded-executor 包装 ZodError 的真实形态一致：前缀 + 多行 issue JSON。
const LONG_MESSAGE = `Plugin-owned tool execution failed: ${JSON.stringify(
  Array.from({ length: 80 }, (_, index) => ({
    code: 'invalid_type',
    expected: 'string',
    message: `Invalid input: expected string, received number (field ${index})`,
    path: [`field${index}`],
  })),
  null,
  2
)}`;

describe('oversized producer failure messages keep their error code', () => {
  test('fixture exceeds the former 4000-character bound', () => {
    expect(LONG_MESSAGE.length).toBeGreaterThan(5000);
  });

  for (const withRuntime of [true, false]) {
    test.each(
      PROJECTOR_TOOLS
    )(`%s preserves INTERNAL_ERROR with a long message (projectRuntime=${withRuntime})`, (name) => {
      const producer = failureResult(name, LONG_MESSAGE, {
        code: 'INTERNAL_ERROR',
        data: withRuntime ? { projectRuntime: makeProjectRuntime() } : {},
      });
      const result = serializeMcpToolResult(name, producer, { isErrorResult });
      const structured = asRecord(result.structuredContent);
      expect(result.isError, name).toBe(true);
      expectPublishedSchemaValid(name, structured);
      const error = asRecord(structured.error);
      expect(error.code, name).toBe('INTERNAL_ERROR');
      expect(typeof error.message, name).toBe('string');
      // 截断而非丢弃：保留消息开头，且长度有界。
      expect(String(error.message).startsWith('Plugin-owned tool execution failed:'), name).toBe(
        true
      );
      expect(String(error.message).length, name).toBeLessThanOrEqual(4000);
      const text = JSON.stringify(structured);
      expect(text, name).not.toContain('PROJECTION_REJECTED');
      expect(text, name).not.toContain('output-contract-mismatch');
    });
  }
});

describe('ProjectContext continuation codes map to semantically accurate failure kinds', () => {
  test.each([
    ['PROJECT_CONTEXT_FACTS_CHANGED', 'conflict'],
    ['PROJECT_CONTEXT_CURSOR_EXPIRED', 'not-found'],
  ])('%s → %s, retryable only through the producer flag', (code, kind) => {
    const fromProducer = createCleanMcpError({ code, message: 'probe', retryable: true });
    expect(fromProducer.reasonCode).toBe(kind);
    expect(fromProducer.failureId).toBe(`core.failure.${kind}`);
    expect(fromProducer.retryable).toBe(true);
    expect(fromProducer.agentBranch).toBe('failure');
  });

  test.each([
    'alembic_search',
    'alembic_graph',
    'alembic_recipe_map',
  ])('%s FACTS_CHANGED failure body does not claim a partial result', (name) => {
    const producer = failureResult(name, 'Project facts changed. Retry the bounded request.', {
      code: 'PROJECT_CONTEXT_FACTS_CHANGED',
      data: { projectRuntime: makeProjectRuntime(), retryable: true },
    });
    const structured = asRecord(
      serializeMcpToolResult(name, producer, { isErrorResult }).structuredContent
    );
    expectPublishedSchemaValid(name, structured);
    const error = asRecord(structured.error);
    expect(error.code).toBe('PROJECT_CONTEXT_FACTS_CHANGED');
    expect(error.reasonCode).toBe('conflict');
    expect(error.failureStatus).not.toBe('partial');
    expect(error.retryable).toBe(true);
  });
});
