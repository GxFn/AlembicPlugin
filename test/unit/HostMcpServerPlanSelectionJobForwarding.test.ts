import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presentHostAgentKnowledgeRescanResponse } from '@alembic/core/host-agent-workflows';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

const bootstrapForHostAgentMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, args: unknown) => ({
    success: true,
    data: { forwardedArgs: args, workflow: 'bootstrap' },
  }))
);

const getActiveSessionMock = vi.hoisted(() => vi.fn(() => null));

const rescanForHostAgentMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, args: unknown) => ({
    success: true,
    data: { forwardedArgs: args, workflow: 'rescan' },
  }))
);

vi.mock('../../lib/host-runtime/mcp/handlers/host-agent/generate.js', () => ({
  generateForHostAgent: bootstrapForHostAgentMock,
  getActiveSession: getActiveSessionMock,
}));

vi.mock('../../lib/host-runtime/mcp/handlers/host-agent/rescan.js', () => ({
  rescanForHostAgent: rescanForHostAgentMock,
}));

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];

// workflow 被 mock，但 ctx 契约不能被 mock 掩盖：alembic_job 必须把请求级 projectRuntime
// 与请求项目的插件自有容器交给 workflow（与直接调用 alembic_bootstrap / alembic_rescan 相同）。
interface ForwardedWorkflowCtx {
  container?: { singletons?: Record<string, unknown> };
  projectRuntime?: { identity?: { dataRoot?: string; projectRoot?: string } } | null;
}

function expectRequestScopedCtx(ctx: unknown, projectRoot: string): void {
  const workflowCtx = ctx as ForwardedWorkflowCtx;
  expect(workflowCtx.projectRuntime?.identity?.dataRoot).toEqual(expect.any(String));
  expect(fs.realpathSync(workflowCtx.projectRuntime?.identity?.projectRoot ?? '')).toBe(
    fs.realpathSync(projectRoot)
  );
  const containerRoot = workflowCtx.container?.singletons?._projectRoot;
  expect(typeof containerRoot).toBe('string');
  expect(fs.realpathSync(String(containerRoot))).toBe(fs.realpathSync(projectRoot));
}

describe('HostMcpServer alembic_job planSelection forwarding', () => {
  afterEach(async () => {
    bootstrapForHostAgentMock.mockClear();
    rescanForHostAgentMock.mockClear();
    getActiveSessionMock.mockClear();
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    restoreEnv();
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('forwards bootstrap planSelection and gate-affecting args to the workflow', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const planSelection = coldStartSelection();

    const result = (await server.handleToolCall('alembic_job', {
      op: 'bootstrap',
      planSelection,
      testMode: true,
      dimensions: ['architecture'],
      scaleOverride: { maxFiles: 5, contentMaxLines: 7, totalRecipeBudget: 1 },
      rebuild: true,
      rescanId: 'job-bootstrap-planSelection',
    })) as { data?: { job?: { result?: unknown; status?: string } }; success: boolean };

    expect(result.success).toBe(true);
    expect(result.data?.job?.status).toBe('completed');
    expect(bootstrapForHostAgentMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        planSelection,
        testMode: true,
        dimensions: ['architecture'],
        scaleOverride: { maxFiles: 5, contentMaxLines: 7, totalRecipeBudget: 1 },
        rebuild: true,
        rescanId: 'job-bootstrap-planSelection',
      })
    );
    expectRequestScopedCtx(bootstrapForHostAgentMock.mock.calls[0]?.[0], projectRoot);
    expect(JSON.stringify(result.data?.job?.result)).toContain('bootstrap');
  }, 60_000);

  test('forwards rescan planSelection and module-scope args to the workflow', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const planSelection = moduleMiningSelection();

    const result = (await server.handleToolCall('alembic_job', {
      op: 'rescan',
      generationStage: 'moduleMining',
      planSelection,
      testMode: true,
      dimensions: ['architecture'],
      moduleScope: ['Sources/App'],
      scaleOverride: { maxFiles: 11, contentMaxLines: 13, totalRecipeBudget: 1 },
      reason: 'job-rescan-planSelection-forwarding',
      rescanId: 'job-rescan-planSelection',
    })) as { data?: { job?: { result?: unknown; status?: string } }; success: boolean };

    expect(result.success).toBe(true);
    expect(result.data?.job?.status).toBe('completed');
    expect(rescanForHostAgentMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        generationStage: 'moduleMining',
        planSelection,
        testMode: true,
        dimensions: ['architecture'],
        moduleScope: ['Sources/App'],
        scaleOverride: { maxFiles: 11, contentMaxLines: 13, totalRecipeBudget: 1 },
        reason: 'job-rescan-planSelection-forwarding',
        rescanId: 'job-rescan-planSelection',
      })
    );
    expectRequestScopedCtx(rescanForHostAgentMock.mock.calls[0]?.[0], projectRoot);
    expect(JSON.stringify(result.data?.job?.result)).toContain('rescan');
  }, 60_000);

  // job.result 与直调 alembic_rescan 走同一 clean-output 投影：绝对 trash 路径相对化为
  // dataRoot 相对路径，白名单外的 workflow 内部字段不落入 job 记录。
  test('projects the rescan job result through the alembic_rescan clean-output contract', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const absoluteTrash = path.join(
      fs.realpathSync(os.tmpdir()),
      'alembic-job-private-home',
      '.asd',
      '.trash',
      '2026-10-02T00-00-00-000Z'
    );
    rescanForHostAgentMock.mockImplementationOnce(async () =>
      presentHostAgentKnowledgeRescanResponse({
        recipeSnapshot: { count: 1 } as never,
        cleanResult: {
          clearedTables: ['knowledge_entries'],
          deletedFiles: 2,
          trash: { folder: absoluteTrash, movedItems: 2, dbSnapshotRows: 5 },
        } as never,
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
        reason: 'job-rescan-projection',
        responseTimeMs: 1,
      })
    );

    const result = (await server.handleToolCall('alembic_job', {
      op: 'rescan',
      generationStage: 'moduleMining',
      planSelection: moduleMiningSelection(),
      testMode: true,
    })) as { data?: { job?: { result?: unknown; status?: string } }; success: boolean };

    expect(result.success).toBe(true);
    expect(result.data?.job?.status).toBe('completed');
    const jobResult = result.data?.job?.result as Record<string, unknown>;
    expect(jobResult).toMatchObject({ ok: true, toolName: 'alembic_rescan' });
    expect((jobResult.rescan as Record<string, unknown>).archive).toEqual({
      folder: '.asd/.trash/2026-10-02T00-00-00-000Z',
      movedItems: 2,
      dbSnapshotRows: 5,
    });
    expect(JSON.stringify(result.data?.job)).not.toContain('alembic-job-private-home');
  }, 60_000);
});

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-job-home-'));
  createdRoots.push(process.env.ALEMBIC_HOME);
}

function restoreEnv(): void {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
}

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-job-project-'));
  createdRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"alembic-job-project"}\n');
  fs.mkdirSync(path.join(root, 'Sources', 'App'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Sources', 'App', 'index.ts'), 'export const value = 1;\n');
  return root;
}

// 与 alembic_init 同一路径初始化，避免手写 .asd 桩让插件自有容器初始化走不到真实状态。
async function makeInitializedServer(projectRoot: string): Promise<HostMcpServer> {
  const server = new HostMcpServer({ projectRoot });
  const init = await server.handleToolCall('alembic_init', {});
  expect(init).toMatchObject({ success: true });
  return server;
}

function coldStartSelection() {
  return {
    generationStage: 'coldStart',
    dimensions: ['architecture'],
    scale: {
      totalRecipeBudget: 3,
      maxFiles: 17,
      contentMaxLines: 41,
      depthLevels: ['project'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources/App',
        dimensions: ['architecture'],
        targetRecipes: 2,
        priority: 1,
      },
    ],
  };
}

function moduleMiningSelection() {
  return {
    generationStage: 'moduleMining',
    dimensions: ['architecture', 'swift-objc-idiom'],
    scale: {
      totalRecipeBudget: 4,
      maxFiles: 23,
      contentMaxLines: 47,
      depthLevels: ['module'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources/App',
        dimensions: ['architecture', 'swift-objc-idiom'],
        targetRecipes: 2,
        priority: 1,
      },
    ],
  };
}
