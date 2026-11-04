/**
 * Lane G / G2 回归：19 个公开工具的失败与知识不可用结果都必须穿过输出投影，
 * structuredContent 满足各工具已发布的 outputSchema（SDK Client 同款 ajv），并保留
 * 原始错误码 / 不可用原因。
 *
 * 覆盖的失败类：
 * - PROJECT_ROOT_REQUIRED clean error（全部工具；真实 HostMcpServer → SDK Client 线路）；
 * - PROJECT_NOT_INITIALIZED failureResult（10 个 embedded 写工具）；
 * - 知识不可用：legacy（无数据库）与 strict（publication 无 active route），4 个知识读工具；
 * - INTERNAL_ERROR / TOOL_TIMEOUT / CANCELLED failureResult（全部工具）；
 * - ProjectContext 续页错误（search/graph/recipe_map）保留可重试性与请求项目根；
 * - wrapHandler 的 VALIDATION_ERROR（embedded 工具）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  buildProjectRuntimeContext,
  type ProjectRuntimeContext,
} from '#host-runtime/context/ProjectRuntimeContext.js';
import { wrapHandler } from '#host-runtime/mcp/errorHandler.js';
import { HostMcpServer } from '#host-runtime/mcp/HostMcpServer.js';
import { EmbeddedToolExecutor } from '#host-runtime/mcp/host/embedded-executor.js';
import { createKnowledgeUnavailableResult } from '#host-runtime/mcp/host/knowledge-unavailable-result.js';
import { failureResult, isErrorResult } from '#host-runtime/mcp/host/results.js';
import { getToolCatalog } from '#host-runtime/mcp/host/tool-catalog.js';
import {
  getMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '#host-runtime/mcp/output-contract.js';
import { TOOLS } from '#host-runtime/mcp/tools.js';
import '#host-runtime/mcp/public-tools/output.js';
import '#host-runtime/mcp/core-tools/output.js';
import '#host-runtime/mcp/local-tools/output.js';
import '#host-runtime/mcp/knowledge-context-tools/search-output.js';
import '#host-runtime/mcp/knowledge-context-tools/graph-output.js';
import '#host-runtime/mcp/knowledge-context-tools/recipe-map-output.js';

const ALL_TOOLS = getToolCatalog().map((tool) => tool.name);
const EMBEDDED_WRITE_TOOLS = [
  'alembic_work',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_evolve',
  'alembic_consolidate',
  'alembic_dimension_complete',
  'alembic_knowledge_lifecycle',
] as const;
const KNOWLEDGE_READ_TOOLS = [
  'alembic_prime',
  'alembic_search',
  'alembic_recipe_map',
  'alembic_code_guard',
] as const;
const PROJECT_CONTEXT_TOOLS = ['alembic_search', 'alembic_graph', 'alembic_recipe_map'] as const;

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

function makeTempProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-error-cross-tool-'));
  tempRoots.push(projectRoot);
  return projectRoot;
}

function makeProjectRuntime(): ProjectRuntimeContext {
  return buildProjectRuntimeContext({ projectRoot: makeTempProject() });
}

/** 与客户端 tools/list 收到的 outputSchema 一致的 ajv 校验（SDK Client.callTool 同款）。 */
function expectPublishedSchemaValid(toolName: string, structured: unknown): void {
  expect(getMcpOutputProjector(toolName), toolName).not.toBeNull();
  const published = withMcpOutputSchema({ name: toolName }) as { outputSchema?: unknown };
  const validate = ajv.getValidator(
    published.outputSchema as Parameters<typeof ajv.getValidator>[0]
  );
  const result = validate(structured);
  expect(result.valid, `${toolName} ajv: ${result.errorMessage ?? ''}`).toBe(true);
}

function serialize(toolName: string, value: unknown) {
  const result = serializeMcpToolResult(toolName, value, { isErrorResult });
  return { result, structured: asRecord(result.structuredContent) };
}

/** 模拟 EmbeddedToolExecutor.attachExecutionContext：附加 projectRuntime 与传输 _meta。 */
function withExecutionContext(value: Record<string, unknown>, runtime: ProjectRuntimeContext) {
  return {
    ...value,
    _meta: { alembicPublication: runtime.publication },
    data: { ...asRecord(value.data), projectRuntime: runtime },
  };
}

function strictUnavailableRuntime(): ProjectRuntimeContext {
  const runtime = makeProjectRuntime();
  runtime.publication = {
    mode: 'strict-v1',
    routeState: 'unavailable',
    sessionId: null,
    snapshotId: null,
    vectorGenerationId: null,
    vectorManifestHash: null,
    sourceRevisionVectorHash: null,
    expansionLedgerHeadHash: null,
    finalExpandedScheduleHash: null,
    finalCodeFactGenerationManifestHash: null,
    sourceRevisionMatch: 'not-checked',
  };
  return runtime;
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function openHostTransport(projectRoot: string) {
  const host = new HostMcpServer({ projectRoot });
  host.sdkServer = new SdkMcpServer(
    { name: 'fix-error-projection-host-test', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  host.registerHandlers();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fix-error-projection-client-test', version: '1.0.0' });
  await host.sdkServer.connect(serverTransport);
  await client.connect(clientTransport);
  // listTools 让 SDK Client 缓存每个工具的 outputSchema，callTool 时以 ajv 校验。
  await client.listTools();
  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await host.shutdown();
    },
  };
}

describe('catalog shape', () => {
  test('covers the 19 public tools', () => {
    expect(ALL_TOOLS).toHaveLength(19);
    for (const name of [...EMBEDDED_WRITE_TOOLS, ...KNOWLEDGE_READ_TOOLS]) {
      expect(ALL_TOOLS).toContain(name);
    }
  });
});

describe('PROJECT_ROOT_REQUIRED survives the real HostMcpServer wire for every tool', () => {
  test('SDK client accepts the schema-valid error and keeps code + requiredActions', async () => {
    const transport = await openHostTransport(makeTempProject());
    const missingRoot = path.join(os.tmpdir(), 'alembic-fix-error-cross-tool-missing', 'nope');
    try {
      for (const name of ALL_TOOLS) {
        const result = await transport.client.callTool({
          name,
          arguments: { projectRoot: missingRoot },
        });
        const structured = asRecord(result.structuredContent);
        expect(result.isError, name).toBe(true);
        expectPublishedSchemaValid(name, structured);
        const error = asRecord(structured.error);
        expect(error.code, name).toBe('PROJECT_ROOT_REQUIRED');
        expect(error.retryable, name).toBe(false);
        const requiredActions = asRecord(error.details).requiredActions;
        expect(Array.isArray(requiredActions) && requiredActions.length > 0, name).toBe(true);
      }
    } finally {
      await transport.close();
    }
  }, 60_000);
});

describe('PROJECT_NOT_INITIALIZED failureResult for embedded write tools', () => {
  test.each(EMBEDDED_WRITE_TOOLS)('%s keeps code and classification', (name) => {
    const requiredAction = 'Run alembic_init for this project before writing knowledge.';
    const producer = withExecutionContext(
      failureResult(name, 'Project is not initialized for Alembic.', {
        code: 'PROJECT_NOT_INITIALIZED',
        data: {
          requiredActions: [requiredAction],
          nextActions: [{ tool: 'alembic_init', reason: 'Initialize first.', required: true }],
        },
      }),
      makeProjectRuntime()
    );
    const { result, structured } = serialize(name, producer);
    expect(result.isError, name).toBe(true);
    expectPublishedSchemaValid(name, structured);
    const error = asRecord(structured.error);
    expect(error.code, name).toBe('PROJECT_NOT_INITIALIZED');
    expect(error.reasonCode, name).toBe('not-found');
    // agent-public 的 alembic_work 在 error.details 中完整保留 requiredActions / nextActions；
    // core 工具的业务字段白名单由 core-tools 投影器维护（不在本车道），这里只钉错误码与分类。
    if (name === 'alembic_work') {
      expect(asRecord(error.details).requiredActions, name).toEqual([requiredAction]);
      expect(JSON.stringify(asRecord(error.details).nextActions), name).toContain('alembic_init');
    }
  });
});

describe('INTERNAL_ERROR / TOOL_TIMEOUT / CANCELLED failureResults for every tool', () => {
  const cases: Array<[string, boolean, string]> = [
    ['INTERNAL_ERROR', false, 'internal-error'],
    ['TOOL_TIMEOUT', true, 'timeout'],
    ['CANCELLED', false, 'cancelled'],
  ];
  for (const [code, retryable, reasonCode] of cases) {
    test.each(ALL_TOOLS)(`%s keeps ${code} with an attached projectRuntime`, (name) => {
      const runtime = makeProjectRuntime();
      const producer = withExecutionContext(
        failureResult(name, `Tool failed with ${code}.`, { code, data: { retryable } }),
        runtime
      );
      const { result, structured } = serialize(name, producer);
      expect(result.isError, name).toBe(true);
      expectPublishedSchemaValid(name, structured);
      const error = asRecord(structured.error);
      expect(error.code, name).toBe(code);
      expect(error.retryable, name).toBe(retryable);
      expect(error.reasonCode, name).toBe(reasonCode);
      const project = asRecord(structured.project);
      if (typeof project.projectRoot === 'string') {
        // 已知请求项目根时，合成失败体不得回落为 '.'。
        expect(project.projectRoot, name).toBe(runtime.identity.projectRoot);
      }
    });

    test.each(ALL_TOOLS)(`%s keeps ${code} without a projectRuntime (host catch path)`, (name) => {
      const producer = failureResult(name, `Tool failed with ${code}.`, {
        code,
        data: { retryable },
      });
      const { result, structured } = serialize(name, producer);
      expect(result.isError, name).toBe(true);
      expectPublishedSchemaValid(name, structured);
      expect(asRecord(structured.error).code, name).toBe(code);
      expect(asRecord(structured.error).retryable, name).toBe(retryable);
    });
  }
});

describe('ProjectContext continuation errors stay retryable', () => {
  const cases: Array<[string, boolean]> = [
    ['PROJECT_CONTEXT_CURSOR_EXPIRED', true],
    ['PROJECT_CONTEXT_FACTS_CHANGED', true],
    ['PROJECT_CONTEXT_CURSOR_INVALID', false],
  ];
  for (const [code, retryable] of cases) {
    test.each(PROJECT_CONTEXT_TOOLS)(`%s preserves ${code}`, (name) => {
      const runtime = makeProjectRuntime();
      const producer = withExecutionContext(
        failureResult(name, `Continuation failed: ${code}.`, { code, data: { retryable } }),
        runtime
      );
      const { result, structured } = serialize(name, producer);
      expect(result.isError, name).toBe(true);
      expectPublishedSchemaValid(name, structured);
      const error = asRecord(structured.error);
      expect(error.code, name).toBe(code);
      expect(error.retryable, name).toBe(retryable);
      expect(error.message, name).toBe(`Continuation failed: ${code}.`);
      expect(JSON.stringify(structured), name).not.toContain('output-contract-mismatch');
      const project = asRecord(structured.project);
      if (typeof project.projectRoot === 'string') {
        expect(project.projectRoot, name).toBe(runtime.identity.projectRoot);
      }
    });
  }
});

/** 未初始化项目上各知识读工具的原生状态：code_guard 未运行为 skipped，其余为 degraded。 */
function expectedUnavailableStatus(name: string): 'skipped' | 'degraded' {
  return name === 'alembic_code_guard' ? 'skipped' : 'degraded';
}

describe('knowledge unavailable results are native, schema-valid outputs', () => {
  test.each(KNOWLEDGE_READ_TOOLS)('%s legacy: no database → unavailable, not a failure', (name) => {
    const runtime = makeProjectRuntime();
    const producer = withExecutionContext(createKnowledgeUnavailableResult(name, runtime), runtime);
    const { result, structured } = serialize(name, producer);
    expectPublishedSchemaValid(name, structured);
    // 未初始化项目不是工具失败：isError 不置位，ok=true，状态表达知识不可用。
    expect(result.isError, name).not.toBe(true);
    expect(structured.ok, name).toBe(true);
    // code_guard 没有知识库就没有 Guard 引擎：Guard 未运行 → skipped（不能读作"已检查且干净"）；
    // 其余三个读工具如实返回空知识 → degraded。
    expect(structured.status, name).toBe(expectedUnavailableStatus(name));
    expect(structured.error, name).toBeUndefined();
    const text = JSON.stringify(structured);
    expect(text, name).toContain('knowledge-database-unavailable');
    expect(text, name).toContain('alembic_init');
    expect(text, name).not.toContain('PROJECTION_REJECTED');
    expect(text, name).not.toContain('output-contract-mismatch');
  });

  test.each(KNOWLEDGE_READ_TOOLS)('%s strict: route-null keeps its reason code', (name) => {
    const runtime = strictUnavailableRuntime();
    const producer = withExecutionContext(createKnowledgeUnavailableResult(name, runtime), runtime);
    const { result, structured } = serialize(name, producer);
    expectPublishedSchemaValid(name, structured);
    expect(result.isError, name).toBe(true);
    expect(structured.ok, name).toBe(false);
    expect(asRecord(structured.error).code, name).toBe('strict-publication-route-unavailable');
    const text = JSON.stringify(structured);
    expect(text, name).not.toContain('PROJECTION_REJECTED');
    expect(text, name).not.toContain('output-contract-mismatch');
    expect(text, name).not.toContain('alembic_init');
  });

  test('real HostMcpServer wire: uninitialized project returns unavailable without initializing', async () => {
    const projectRoot = makeTempProject();
    const runtime = buildProjectRuntimeContext({ projectRoot });
    const before = {
      dataRoot: listFilesRecursive(runtime.identity.dataRoot),
      project: listFilesRecursive(projectRoot),
    };
    const transport = await openHostTransport(projectRoot);
    try {
      for (const [name, args] of [
        ['alembic_prime', { query: 'how do we handle errors' }],
        ['alembic_search', { query: 'errors' }],
        ['alembic_recipe_map', {}],
        ['alembic_code_guard', { operation: 'check', code: 'const value = 1;' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await transport.client.callTool({ name, arguments: args });
        const structured = asRecord(result.structuredContent);
        expectPublishedSchemaValid(name, structured);
        expect(result.isError, `${name} ${JSON.stringify(structured).slice(0, 600)}`).not.toBe(
          true
        );
        expect(structured.status, name).toBe(expectedUnavailableStatus(name));
        expect(JSON.stringify(structured), name).toContain('knowledge-database-unavailable');
      }
    } finally {
      await transport.close();
    }
    expect(fs.existsSync(runtime.identity.databasePath)).toBe(false);
    expect(listFilesRecursive(projectRoot)).toEqual(before.project);
    expect(listFilesRecursive(runtime.identity.dataRoot)).toEqual(before.dataRoot);
  }, 60_000);

  test('EmbeddedToolExecutor knowledge reads never create the database', async () => {
    const runtime = makeProjectRuntime();
    const projectRoot = runtime.identity.projectRoot;
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'fix-error-projection-cross-tool',
      hostProjectRoot: projectRoot,
    });
    try {
      for (const name of KNOWLEDGE_READ_TOOLS) {
        const args: Record<string, unknown> =
          name === 'alembic_code_guard'
            ? { operation: 'check', code: 'const a = 1;' }
            : name === 'alembic_recipe_map'
              ? {}
              : { query: 'errors' };
        const raw = await executor.execute(name, args, { projectRoot, projectRuntime: runtime });
        const { result, structured } = serialize(name, raw);
        expectPublishedSchemaValid(name, structured);
        expect(result.isError, name).not.toBe(true);
      }
    } finally {
      await executor.dispose();
    }
    expect(fs.existsSync(runtime.identity.databasePath)).toBe(false);
  }, 60_000);
});

describe('wrapHandler VALIDATION_ERROR for embedded tools', () => {
  test.each(
    TOOLS.map((tool) => tool.name)
  )('%s returns a schema-valid VALIDATION_ERROR', async (name) => {
    const wrapped = wrapHandler(
      name,
      async () => ({ unreachable: true }),
      // 一个必然失败的输入 schema，直达 wrapHandler 的 VALIDATION_ERROR 分支。
      z.object({ mustBePresent: z.string() })
    );
    const raw = await wrapped({}, {});
    const { result, structured } = serialize(name, raw);
    expect(result.isError, name).toBe(true);
    expectPublishedSchemaValid(name, structured);
    expect(asRecord(structured.error).code, name).toBe('VALIDATION_ERROR');
    expect(asRecord(structured.error).reasonCode, name).toBe('invalid-input');
  });
});
