/**
 * R2b 回归：五个只读工具（prime / search / graph / recipe_map / code_guard）自己用 Zod 解析入参，
 * 不经过 wrapHandler。参数错误必须与 embedded 工具一致地归类为 VALIDATION_ERROR
 * （invalid-input、不可重试，消息格式同 wrapHandler），而不是 INTERNAL_ERROR；
 * 序列化后的线路结果仍满足各工具已发布的 outputSchema。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { buildProjectRuntimeContext } from '#host-runtime/context/ProjectRuntimeContext.js';
import { EmbeddedToolExecutor } from '#host-runtime/mcp/host/embedded-executor.js';
import { isErrorResult } from '#host-runtime/mcp/host/results.js';
import {
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

const ajv = new AjvJsonSchemaValidator();
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

// 每个只读工具一个必然被其 Zod schema 拒绝的入参，以及被拒绝字段的路径。
const INVALID_CASES: Array<[string, Record<string, unknown>, string]> = [
  ['alembic_prime', { limit: 0 }, 'limit'],
  ['alembic_search', { mode: 'not-a-mode' }, 'mode'],
  ['alembic_graph', { queryKind: 'not-a-kind' }, 'queryKind'],
  ['alembic_recipe_map', { focus: { kind: 'not-a-kind' } }, 'focus.kind'],
  ['alembic_code_guard', { code: '' }, 'code'],
];

describe('read-only executors classify Zod input errors as VALIDATION_ERROR', () => {
  test.each(INVALID_CASES)(
    '%s rejects invalid args with a schema-valid VALIDATION_ERROR',
    async (name, args, issuePath) => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'alembic-fix-residual-validation-')
      );
      tempRoots.push(projectRoot);
      const projectRuntime = buildProjectRuntimeContext({ projectRoot });
      const warn = vi.spyOn(Logger.getInstance(), 'warn');
      const executor = new EmbeddedToolExecutor({
        getSessionId: () => 'fix-residual-read-only-validation',
        hostProjectRoot: projectRoot,
      });
      try {
        const raw = await executor.execute(name, args, { projectRoot, projectRuntime });
        const result = serializeMcpToolResult(name, raw, { isErrorResult });
        const structured = asRecord(result.structuredContent);
        expect(result.isError, name).toBe(true);
        expectPublishedSchemaValid(name, structured);
        const error = asRecord(structured.error);
        expect(error.code, `${name} ${JSON.stringify(structured).slice(0, 600)}`).toBe(
          'VALIDATION_ERROR'
        );
        expect(error.reasonCode, name).toBe('invalid-input');
        expect(error.retryable, name).toBe(false);
        // 与 wrapHandler 相同的消息格式：输入校验失败: <path>: <issue>[; ...]
        expect(String(error.message), name).toMatch(/^输入校验失败: /);
        expect(String(error.message), name).toContain(`${issuePath}: `);
        expect(JSON.stringify(structured), name).not.toContain('INTERNAL_ERROR');
        // 诊断写入 Logger（stderr），不进入 stdout 协议通道。
        expect(
          warn.mock.calls.some(([message]) =>
            String(message).includes(`[MCP:${name}] VALIDATION_ERROR`)
          ),
          name
        ).toBe(true);
      } finally {
        await executor.dispose();
      }
      // 参数错误发生在任何知识库访问之前，不得创建数据库。
      expect(fs.existsSync(projectRuntime.identity.databasePath)).toBe(false);
    },
    60_000
  );
});
