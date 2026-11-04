/**
 * W3c 输出契约后续修复回归：
 * - W3c-1 alembic_code_guard 在未初始化项目（无知识数据库）上根本没有运行 Guard，
 *   必须投影为 status=skipped + 显式 skip 原因，不得给出可被误读为"已检查且通过"的
 *   degraded 结果或任何 guard 结论/覆盖；prime / search / recipe_map 仍是 degraded。
 * - W3c-2 ProducerFailureMessageSchema 解析无副作用（不写 stderr），截断诊断只在
 *   投影构建失败输出时写一次。
 * - W3c-3 alembic_rescan 的 rescan.archive.folder 不暴露绝对 trash 路径，投影为
 *   dataRoot 相对路径，归档计数保留。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presentHostAgentKnowledgeRescanResponse } from '@alembic/core/host-agent-workflows';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildProjectRuntimeContext,
  type ProjectRuntimeContext,
} from '#host-runtime/context/ProjectRuntimeContext.js';
import { createKnowledgeUnavailableResult } from '#host-runtime/mcp/host/knowledge-unavailable-result.js';
import { failureResult, isErrorResult } from '#host-runtime/mcp/host/results.js';
import {
  getMcpOutputProjector,
  ProducerFailureMessageSchema,
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

function makeProjectRuntime(): ProjectRuntimeContext {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-followup-contract-'));
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

/** 模拟 EmbeddedToolExecutor.attachExecutionContext：附加 projectRuntime 与传输 _meta。 */
function withExecutionContext(value: Record<string, unknown>, runtime: ProjectRuntimeContext) {
  return {
    ...value,
    _meta: { alembicPublication: runtime.publication },
    data: { ...asRecord(value.data), projectRuntime: runtime },
  };
}

function serialize(toolName: string, value: unknown) {
  const result = serializeMcpToolResult(toolName, value, { isErrorResult });
  return { result, structured: asRecord(result.structuredContent) };
}

describe('W3c-1 code_guard on an uninitialized project reports that Guard did not run', () => {
  test('legacy no-database result projects to skipped with an explicit skip reason', () => {
    const runtime = makeProjectRuntime();
    const producer = withExecutionContext(
      createKnowledgeUnavailableResult('alembic_code_guard', runtime),
      runtime
    );
    const { result, structured } = serialize('alembic_code_guard', producer);
    expectPublishedSchemaValid('alembic_code_guard', structured);
    expect(result.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.error).toBeUndefined();
    expect(structured.status).toBe('skipped');
    // 专用 skip 原因码：no-code-scope 在 Guard 技能里表示"请提供 files/code"，复用它会把
    // 智能体引向重发文件而不是调用 alembic_init。
    expect(structured.reason).toMatchObject({ kind: 'skip', code: 'project-not-initialized' });
    // summary 明确 Guard 未运行并给出 alembic_init 指引。
    expect(String(structured.summary)).toMatch(/Guard did not run/);
    expect(String(structured.summary)).toContain('alembic_init');
    expect(String(asRecord(structured.reason).message)).toMatch(/Guard did not run/);
    // 不得出现任何可读作"已通过"的 guard 结论 / 覆盖 / 结果引用。
    for (const field of ['guard', 'guardResultRef', 'primeAlignment', 'explicitScope', 'data']) {
      expect(structured, field).not.toHaveProperty(field);
    }
    const diagnostics = structured.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.map((item) => item.code)).toEqual(['knowledge-database-unavailable']);
  });

  test.each([
    'alembic_prime',
    'alembic_search',
    'alembic_recipe_map',
  ])('%s keeps the honest degraded empty-knowledge output', (name) => {
    const runtime = makeProjectRuntime();
    const producer = withExecutionContext(createKnowledgeUnavailableResult(name, runtime), runtime);
    const { result, structured } = serialize(name, producer);
    expectPublishedSchemaValid(name, structured);
    expect(result.isError).not.toBe(true);
    expect(structured.status).toBe('degraded');
  });
});

// 与 embedded-executor 包装 ZodError 的真实形态一致：前缀 + 多行 issue JSON。
const LONG_MESSAGE = `Plugin-owned tool execution failed: ${'x'.repeat(6000)}`;
const TRUNCATION_MARKER = 'truncated producer failure message';

function captureStderr(): { lines: () => string[] } {
  const writes: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines: () => writes.filter((line) => line.includes(TRUNCATION_MARKER)) };
}

describe('W3c-2 producer failure message truncation logs once, outside the schema', () => {
  test('parsing a long message with the schema has no stderr side effect', () => {
    const stderr = captureStderr();
    for (let index = 0; index < 3; index += 1) {
      const parsed = ProducerFailureMessageSchema.safeParse(LONG_MESSAGE);
      expect(parsed.success).toBe(true);
    }
    expect(stderr.lines()).toEqual([]);
  });

  test.each([
    'alembic_prime',
    'alembic_work',
    'alembic_code_guard',
    'alembic_search',
    'alembic_graph',
    'alembic_recipe_map',
  ])('%s projection logs exactly one truncation diagnostic', (name) => {
    const producer = failureResult(name, LONG_MESSAGE, {
      code: 'INTERNAL_ERROR',
      data: { projectRuntime: makeProjectRuntime() },
    });
    const stderr = captureStderr();
    const { result, structured } = serialize(name, producer);
    vi.restoreAllMocks();
    expect(result.isError).toBe(true);
    expect(asRecord(structured.error).code).toBe('INTERNAL_ERROR');
    expect(String(asRecord(structured.error).message).length).toBeLessThanOrEqual(4000);
    const lines = stderr.lines();
    expect(lines, name).toHaveLength(1);
    expect(lines[0]).toContain(name);
    expect(lines[0]).toContain(String(LONG_MESSAGE.length));
  });

  test('a short message projects without any truncation diagnostic', () => {
    const producer = failureResult('alembic_search', 'short failure', {
      code: 'INTERNAL_ERROR',
      data: {},
    });
    const stderr = captureStderr();
    serialize('alembic_search', producer);
    vi.restoreAllMocks();
    expect(stderr.lines()).toEqual([]);
  });
});

function rescanResponse(trash: unknown, deletedFiles = 3) {
  return presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot: { count: 2 } as never,
    cleanResult: { clearedTables: ['a'], deletedFiles, trash } as never,
    auditSummary: {
      totalAudited: 0,
      healthy: 0,
      watch: 0,
      decay: 0,
      severe: 0,
      dead: 0,
      proposalsCreated: 0,
      immediateDeprecated: 0,
    } as never,
    briefing: {},
    evidencePlan: { decayCount: 0, coveredDimensions: 0, gapSummary: '' } as never,
    dimensions: [] as never,
    reason: 'unit',
    responseTimeMs: 1,
  });
}

describe('W3c-3 rescan.archive.folder is projected dataRoot-relative', () => {
  test.each([
    [
      'posix ghost-mode path',
      '/Users/someone/.asd/workspaces/ws-1/.asd/.trash/2026-10-01T00-00-00-000Z',
      '/Users/someone',
    ],
    [
      'windows path',
      'C:\\Users\\someone\\proj\\.asd\\.trash\\2026-10-01T00-00-00-000Z',
      'C:\\Users',
    ],
  ])('%s → .asd/.trash/<ts> with counts kept', (_label, folder, privatePrefix) => {
    const response = rescanResponse({ folder, movedItems: 4, dbSnapshotRows: 7 });
    const { structured } = serialize('alembic_rescan', response);
    expectPublishedSchemaValid('alembic_rescan', structured);
    expect(asRecord(structured.rescan).archive).toEqual({
      folder: '.asd/.trash/2026-10-01T00-00-00-000Z',
      movedItems: 4,
      dbSnapshotRows: 7,
    });
    expect(asRecord(structured.rescan).archiveMissing).toBe(false);
    expect(JSON.stringify(structured)).not.toContain(privatePrefix);
  });

  test('an absolute folder outside .asd/.trash drops the path but keeps the archive counts', () => {
    const response = rescanResponse({
      folder: '/var/private/elsewhere/2026',
      movedItems: 2,
      dbSnapshotRows: 1,
    });
    const { structured } = serialize('alembic_rescan', response);
    expectPublishedSchemaValid('alembic_rescan', structured);
    expect(asRecord(structured.rescan).archive).toEqual({ movedItems: 2, dbSnapshotRows: 1 });
    expect(JSON.stringify(structured)).not.toContain('/var/private');
  });

  test('no archive stays null with archiveMissing preserved', () => {
    const { structured } = serialize('alembic_rescan', rescanResponse(undefined, 5));
    expect(asRecord(structured.rescan).archive).toBeNull();
    expect(asRecord(structured.rescan).archiveMissing).toBe(true);
  });
});
