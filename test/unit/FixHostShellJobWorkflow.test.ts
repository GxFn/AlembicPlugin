import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PluginJobStore } from '../../lib/host-runtime/jobs/PluginJobStore.js';
import {
  getToolCatalog,
  HostMcpServer,
  isHeavyToolCall,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

// A1：alembic_job op=bootstrap|rescan 必须走与 alembic_bootstrap / alembic_rescan 相同的
// 真实 workflow（请求级 projectRuntime + 插件自有容器 + 同一 Zod schema），不 mock workflow。

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];

interface JobToolResult {
  data?: {
    job?: { error?: { message?: string }; result?: unknown; status?: string };
    reasonCode?: string;
  };
  errorCode?: string;
  message?: string;
  success?: boolean;
}

describe('alembic_job runs the real request-scoped bootstrap/rescan workflow', () => {
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

  test('op=bootstrap without planSelection returns a structured validation failure', async () => {
    const { projectRoot, server } = await initializedProject();

    const result = (await server.handleToolCall('alembic_job', {
      op: 'bootstrap',
    })) as JobToolResult;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(result.message).toContain('planSelection');
    expect(JSON.stringify(result)).not.toContain('Request-scoped project runtime dataRoot');
    // 校验失败在 workflow 之前拦截，不应留下 running/completed 的僵尸 job。
    const jobs = new PluginJobStore(projectRoot).list();
    expect(jobs.filter((job) => job.status === 'running' || job.status === 'completed')).toEqual(
      []
    );
  }, 60_000);

  test('op=bootstrap reaches the plan gate with the request projectRuntime and fails the job', async () => {
    const { projectRoot, server } = await initializedProject();

    const result = (await server.handleToolCall('alembic_job', {
      op: 'bootstrap',
      testMode: true,
      planSelection: {
        generationStage: 'coldStart',
        dimensions: ['architecture'],
        scale: { totalRecipeBudget: 1 },
        // 维度未在 dimensions 中声明：Zod 放行，Plan gate 阻断。
        moduleBindings: [{ modulePath: 'src', dimensions: ['unknown-dimension'] }],
      },
    })) as JobToolResult;

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Request-scoped project runtime dataRoot');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PLAN_REQUIRED');
    expect(result.data?.job?.status).toBe('failed');
    expect(serialized).toContain('unknown-dimension');

    const stored = new PluginJobStore(projectRoot).list({ kind: 'bootstrap' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('failed');
    // workflow 必须运行在请求项目上，而不是进程 cwd（全局容器）对应的仓库。
    const storedResult = stored[0]?.result as { projectRoot?: string } | undefined;
    expect(fs.realpathSync(storedResult?.projectRoot ?? '')).toBe(fs.realpathSync(projectRoot));
  }, 60_000);

  test('op=rescan without planSelection returns a structured validation failure', async () => {
    const { server } = await initializedProject();

    const result = (await server.handleToolCall('alembic_job', {
      op: 'rescan',
      reason: 'fix-host-shell',
    })) as JobToolResult;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(result.message).toContain('planSelection');
    expect(JSON.stringify(result)).not.toContain('Request-scoped project runtime dataRoot');
  }, 60_000);

  test('op=rescan reaches the plan gate with the request projectRuntime and fails the job', async () => {
    const { server } = await initializedProject();

    const result = (await server.handleToolCall('alembic_job', {
      op: 'rescan',
      generationStage: 'deepMining',
      testMode: true,
      planSelection: {
        generationStage: 'deepMining',
        dimensions: ['architecture'],
        scale: { totalRecipeBudget: 1 },
        moduleBindings: [{ modulePath: 'src', dimensions: ['unknown-dimension'] }],
      },
    })) as JobToolResult;

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Request-scoped project runtime dataRoot');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PLAN_REQUIRED');
    expect(result.data?.job?.status).toBe('failed');
  }, 60_000);

  test('alembic_job bootstrap/rescan ops use the heavy deadline while status stays light', () => {
    expect(isHeavyToolCall('alembic_job', { op: 'bootstrap' })).toBe(true);
    expect(isHeavyToolCall('alembic_job', { op: 'rescan' })).toBe(true);
    expect(isHeavyToolCall('alembic_job', { op: 'status' })).toBe(false);
    expect(isHeavyToolCall('alembic_job', {})).toBe(false);
    expect(isHeavyToolCall('alembic_bootstrap', {})).toBe(true);
    expect(isHeavyToolCall('alembic_search', { op: 'bootstrap' })).toBe(false);
  });

  test('advertised alembic_job inputSchema accepts every bootstrap/rescan field', () => {
    const tool = getToolCatalog().find((entry) => entry.name === 'alembic_job');
    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining([
        'projectRoot',
        'op',
        'jobId',
        'kind',
        'status',
        'limit',
        'planSelection',
        'generationStage',
        'testMode',
        'rebuild',
        'rescanId',
        'scaleOverride',
        'dimensions',
        'reason',
        'force',
        'moduleScope',
      ])
    );
  });
});

async function initializedProject(): Promise<{ projectRoot: string; server: HostMcpServer }> {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-job-home-'));
  createdRoots.push(process.env.ALEMBIC_HOME);
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-job-project-'))
  );
  createdRoots.push(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"alembic-fix-job"}\n');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n');

  const server = new HostMcpServer({ projectRoot });
  // 与 alembic_init 同一路径初始化（SetupService + init marker），不手写 .asd 桩。
  const init = (await server.handleToolCall('alembic_init', {})) as { success?: boolean };
  // toMatchObject 失败时会打印完整 init 结果，便于定位（例如 SQLite 原生模块 ABI 不匹配）。
  expect(init).toMatchObject({ success: true });
  return { projectRoot, server };
}
