import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PluginJobStore } from '../../lib/host-runtime/jobs/PluginJobStore.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { isErrorResult } from '../../lib/host-runtime/mcp/host/results.js';
import { serializeMcpToolResult } from '../../lib/host-runtime/mcp/output-contract.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { closeProjectIndexRelations } from '../../lib/service/project-knowledge-context/project/ProjectIndexRelations.js';

// A4（用户决策：拒绝并引导 init）：未初始化项目（无知识库 DB；未注册项目 dataRoot == projectRoot）
// - embedded 写类工具与 alembic_job op=bootstrap|rescan 在 Bootstrap / DB / 日志创建之前拒绝；
// - alembic_graph 照常可用，但 CodeGraph / 源码索引运行数据落在 os.tmpdir() 下的稳定目录；
// - alembic_job 读路径不创建 jobs 目录。
// 每次调用前后对比项目目录树，必须完全不变。

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

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];
const servers: HostMcpServer[] = [];

interface ToolResult {
  data?: Record<string, unknown>;
  errorCode?: string;
  message?: string;
  success?: boolean;
}

describe('FixHostShell: uninitialized project stays untouched', () => {
  beforeEach(() => {
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-uninit-home-'));
    createdRoots.push(process.env.ALEMBIC_HOME);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.shutdown();
    }
    closeProjectIndexRelations();
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

  test.each(
    EMBEDDED_WRITE_TOOLS
  )('%s refuses with PROJECT_NOT_INITIALIZED and writes nothing into the repository', async (name) => {
    const projectRoot = makeProjectRoot();
    const server = makeServer(projectRoot);
    const status = (await server.handleToolCall('alembic_status', {})) as ToolResult;
    // 前置条件：未注册、未初始化，dataRoot 就是仓库本身。
    expect(status.data?.initialized).toBe(false);
    expect(readRecord(status.data?.project).dataRoot).toBe(projectRoot);
    const before = listTree(projectRoot);

    const result = (await server.handleToolCall(name, {})) as ToolResult;

    expect(listTree(projectRoot)).toEqual(before);
    expectNotInitializedRefusal(result, name);
    const serialized = serializeMcpToolResult(name, result, { isErrorResult });
    expect(serialized.isError).toBe(true);
    const wireError = readRecord(readRecord(serialized.structuredContent).error);
    expect(wireError.code).toBe('PROJECT_NOT_INITIALIZED');
    // V2 e2e：拒绝的可执行指引必须随线上 structuredContent 交付（error.details），
    // 不能只存在于投影前的 legacy data——core 工具白名单会丢弃 data.nextActions。
    const wireDetails = readRecord(wireError.details);
    expect(wireDetails.requiredActions).toEqual([
      `Call alembic_init for this project, then retry ${name}.`,
    ]);
    const wireNextActions = wireDetails.nextActions as Array<Record<string, unknown>> | undefined;
    expect(wireNextActions?.[0]).toMatchObject({ tool: 'alembic_init', required: true });
  }, 60_000);

  test.each([
    'bootstrap',
    'rescan',
  ])('alembic_job op=%s refuses before creating a job or any project file', async (op) => {
    const projectRoot = makeProjectRoot();
    const server = makeServer(projectRoot);
    const before = listTree(projectRoot);

    const result = (await server.handleToolCall('alembic_job', {
      op,
      planSelection: {
        generationStage: op === 'bootstrap' ? 'coldStart' : 'deepMining',
        dimensions: ['architecture'],
        scale: { totalRecipeBudget: 1 },
      },
    })) as ToolResult;

    expect(listTree(projectRoot)).toEqual(before);
    expectNotInitializedRefusal(result, 'alembic_job');
    expect(new PluginJobStore(projectRoot).list()).toEqual([]);
    const serialized = serializeMcpToolResult('alembic_job', result, { isErrorResult });
    expect(serialized.isError).toBe(true);
    expect(JSON.stringify(serialized)).toContain('PROJECT_NOT_INITIALIZED');
  }, 60_000);

  test('alembic_job op=status reads without creating the jobs directory', async () => {
    const projectRoot = makeProjectRoot();
    const server = makeServer(projectRoot);
    const before = listTree(projectRoot);

    const listed = (await server.handleToolCall('alembic_job', { op: 'status' })) as ToolResult;
    const single = (await server.handleToolCall('alembic_job', {
      op: 'status',
      jobId: 'bootstrap-missing',
    })) as ToolResult;

    expect(listTree(projectRoot)).toEqual(before);
    expect(listed.success).toBe(true);
    expect(listed.data?.jobs).toEqual([]);
    expect(single.success).toBe(false);
    expect(single.errorCode).toBe('NOT_FOUND');
  }, 60_000);

  test('PluginJobStore creates its directory only when a job record is written', () => {
    const projectRoot = makeProjectRoot();
    const before = listTree(projectRoot);
    const store = new PluginJobStore(projectRoot);

    expect(store.list()).toEqual([]);
    expect(store.get('bootstrap-missing')).toBeNull();
    expect(listTree(projectRoot)).toEqual(before);

    const job = store.create({ kind: 'bootstrap' });
    expect(fs.existsSync(path.join(store.jobsDir, `${job.id}.json`))).toBe(true);
    expect(store.list().map((entry) => entry.id)).toEqual([job.id]);
  });

  test.each([
    [{}],
    [{ queryKind: 'file-symbols', filePath: 'src/index.ts' }],
    [{ queryKind: 'file-flow', filePath: 'src/index.ts' }],
  ])('alembic_graph %j works without init and keeps its runtime data outside the repository', async (args) => {
    const projectRoot = makeProjectRoot();
    const graphRuntimeRoot = expectedGraphRuntimeRoot(projectRoot);
    createdRoots.push(graphRuntimeRoot);
    const server = makeServer(projectRoot);
    const before = listTree(projectRoot);

    const result = (await server.handleToolCall('alembic_graph', args)) as Record<string, unknown>;

    expect(listTree(projectRoot)).toEqual(before);
    expect(isErrorResult(result)).toBe(false);
    expect(readRecord(result.structuredContent).ok).toBe(true);
    // 稳定的项目级目录：同一项目再次调用复用同一处，不随调用新建/删除。
    expect(fs.existsSync(graphRuntimeRoot)).toBe(true);
    // CodeGraph 会话根确实改落到临时目录（RED 时它出现在仓库 .asd/codegraph-sessions 下）。
    expect(listTree(graphRuntimeRoot)).toContain('.asd/codegraph-sessions/');
    const again = (await server.handleToolCall('alembic_graph', args)) as Record<string, unknown>;
    expect(isErrorResult(again)).toBe(false);
    expect(listTree(projectRoot)).toEqual(before);
  }, 60_000);

  test('an initialized project still runs write tools and keeps Graph data in its own data root', async () => {
    const projectRoot = makeProjectRoot();
    const graphRuntimeRoot = expectedGraphRuntimeRoot(projectRoot);
    createdRoots.push(graphRuntimeRoot);
    const server = makeServer(projectRoot);
    const init = (await server.handleToolCall('alembic_init', {})) as ToolResult;
    expect(init).toMatchObject({ success: true });

    const submit = (await server.handleToolCall('alembic_submit_knowledge', {})) as ToolResult;
    expect(JSON.stringify(submit)).not.toContain('PROJECT_NOT_INITIALIZED');
    const graph = (await server.handleToolCall('alembic_graph', {
      queryKind: 'file-flow',
      filePath: 'src/index.ts',
    })) as Record<string, unknown>;
    expect(isErrorResult(graph)).toBe(false);
    expect(fs.existsSync(graphRuntimeRoot)).toBe(false);
  }, 60_000);
});

function expectNotInitializedRefusal(result: ToolResult, tool: string): void {
  expect(result.success).toBe(false);
  expect(result.errorCode).toBe('PROJECT_NOT_INITIALIZED');
  expect(readRecord(result).tool).toBe(tool);
  expect(result.message).toContain('alembic_init');
  const nextActions = result.data?.nextActions as Array<Record<string, unknown>> | undefined;
  expect(nextActions?.[0]).toMatchObject({ tool: 'alembic_init', required: true });
  expect(typeof nextActions?.[0]?.reason).toBe('string');
}

function makeServer(projectRoot: string): HostMcpServer {
  const server = new HostMcpServer({ projectRoot });
  servers.push(server);
  return server;
}

function makeProjectRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-shell-uninit-project-'))
  );
  createdRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"host-shell-uninit-fixture"}\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'index.ts'),
    "import { helper } from './helper.js';\nexport const value = helper(1);\n"
  );
  fs.writeFileSync(
    path.join(root, 'src', 'helper.ts'),
    'export function helper(input: number): number { return input + 1; }\n'
  );
  return root;
}

function expectedGraphRuntimeRoot(projectRoot: string): string {
  const digest = createHash('sha256').update(fs.realpathSync(projectRoot)).digest('hex');
  // 运行根按 OS 用户分区（共享 /tmp 上不与其他用户争用同一父目录）。
  const base =
    typeof process.getuid === 'function'
      ? `alembic-graph-runtime-${process.getuid()}`
      : 'alembic-graph-runtime';
  return path.join(os.tmpdir(), base, digest.slice(0, 16));
}

/** 项目目录树（相对路径，含目录），用于前后对比。 */
function listTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      entries.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) {
        walk(absolute);
      }
    }
  };
  walk(root);
  return entries.sort();
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
