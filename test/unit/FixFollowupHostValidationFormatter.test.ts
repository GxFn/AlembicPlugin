/**
 * W3a-1 回归：Zod 入参校验失败的消息只有一个格式化来源（errorHandler 导出）。
 * wrapHandler、只读执行器（readOnlyValidationErrorResult）与 alembic_job 预校验三处必须产出
 * 同一线路消息 `输入校验失败: <path>: <message>[; ...]`——alembic_job op=bootstrap 包裹的就是
 * alembic_bootstrap 的同一 schema，同一坏入参不能因入口不同而得到不同措辞。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { buildProjectRuntimeContext } from '#host-runtime/context/ProjectRuntimeContext.js';
import { formatZodValidationMessage, wrapHandler } from '#host-runtime/mcp/errorHandler.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '#host-runtime/mcp/HostMcpServer.js';
import { EmbeddedToolExecutor } from '#host-runtime/mcp/host/embedded-executor.js';
import { GenerateInput } from '#shared/schemas/mcp-tools.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 兼容三种失败信封：legacy failureResult、clean error、CallToolResult.structuredContent。 */
function readErrorMessage(value: unknown): string {
  const record = asRecord(value);
  const structured = asRecord(record.structuredContent);
  const source = Object.keys(structured).length > 0 ? structured : record;
  const error = asRecord(source.error);
  if (typeof error.message === 'string') {
    return error.message;
  }
  return typeof source.message === 'string' ? source.message : '';
}

function readErrorCode(value: unknown): string {
  const record = asRecord(value);
  const structured = asRecord(record.structuredContent);
  const source = Object.keys(structured).length > 0 ? structured : record;
  const error = asRecord(source.error);
  if (typeof error.code === 'string') {
    return error.code;
  }
  return typeof source.errorCode === 'string' ? source.errorCode : '';
}

function zodErrorOf(schema: z.ZodType, input: unknown): z.ZodError {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    throw new Error('expected the schema to reject the input');
  }
  return parsed.error;
}

describe('single Zod validation-message formatter', () => {
  afterEach(async () => {
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('formats every issue as <path>: <message> joined with "; " behind the shared prefix', () => {
    const schema = z.object({ a: z.object({ b: z.string() }), c: z.number() });
    const error = zodErrorOf(schema, { a: { b: 1 }, c: 'x' });
    const expected = `输入校验失败: ${error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')}`;
    expect(formatZodValidationMessage(error)).toBe(expected);
    expect(formatZodValidationMessage(error)).toMatch(/^输入校验失败: a\.b: .+; c: .+$/);
  });

  test('wrapHandler emits exactly the shared formatter message', async () => {
    const schema = z.object({ name: z.string() });
    const handler = wrapHandler('alembic_fix_followup_probe', async () => ({ ok: true }), schema);
    const result = await handler({}, { name: 42 });
    expect(readErrorCode(result)).toBe('VALIDATION_ERROR');
    expect(readErrorMessage(result)).toBe(
      formatZodValidationMessage(zodErrorOf(schema, { name: 42 }))
    );
  });

  test('read-only executor validation emits exactly the shared formatter message', async () => {
    const projectRoot = makeProjectRoot('readonly');
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'fix-followup-formatter',
      hostProjectRoot: projectRoot,
    });
    const result = await executor.execute(
      'alembic_search',
      { mode: 'not-a-mode' },
      { projectRoot, projectRuntime: buildProjectRuntimeContext({ projectRoot }) }
    );
    expect(readErrorCode(result)).toBe('VALIDATION_ERROR');
    const message = readErrorMessage(result);
    expect(message).toMatch(/^输入校验失败: /);
    expect(message).toContain('mode: ');
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
  });

  // 需要真实 alembic_init（加载 ../AlembicCore 的 better-sqlite3）：仅 Node 24 可跑通。
  test('alembic_job op=bootstrap reports the same validation message as alembic_bootstrap', async () => {
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-fmt-home-'));
    createdRoots.push(process.env.ALEMBIC_HOME);
    const projectRoot = makeProjectRoot('job');
    const server = new HostMcpServer({ projectRoot });
    const init = await server.handleToolCall('alembic_init', {});
    expect(init).toMatchObject({ success: true });

    const direct = await server.handleToolCall('alembic_bootstrap', {});
    const job = await server.handleToolCall('alembic_job', { op: 'bootstrap' });

    expect(readErrorCode(direct)).toBe('VALIDATION_ERROR');
    expect(readErrorCode(job)).toBe('VALIDATION_ERROR');
    const expected = formatZodValidationMessage(zodErrorOf(GenerateInput, {}));
    expect(readErrorMessage(direct)).toBe(expected);
    expect(readErrorMessage(job)).toBe(expected);
    // job 入口身份仍可从 data.jobRoute 判断，不再靠消息前缀。
    expect(asRecord(asRecord(asRecord(job).data).jobRoute)).toMatchObject({
      workflowTool: 'alembic_bootstrap',
    });
  }, 60_000);
});

function makeProjectRoot(name: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `alembic-fix-fmt-${name}-`)));
  createdRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), `{"name":"alembic-fix-fmt-${name}"}\n`);
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const value = 1;\n');
  return root;
}
