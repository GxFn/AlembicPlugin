import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/runtime/mcp/HostMcpServer.js';

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

vi.mock('../../lib/runtime/mcp/handlers/host-agent/bootstrap.js', () => ({
  bootstrapForHostAgent: bootstrapForHostAgentMock,
  getActiveSession: getActiveSessionMock,
}));

vi.mock('../../lib/runtime/mcp/handlers/host-agent/rescan.js', () => ({
  rescanForHostAgent: rescanForHostAgentMock,
}));

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

describe('HostMcpServer alembic_job planSelection forwarding', () => {
  afterEach(async () => {
    bootstrapForHostAgentMock.mockClear();
    rescanForHostAgentMock.mockClear();
    getActiveSessionMock.mockClear();
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    restoreEnv();
  });

  test('forwards bootstrap planSelection and gate-affecting args to the workflow', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const planSelection = coldStartSelection();
    const server = new HostMcpServer({ projectRoot });

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
    expect(JSON.stringify(result.data?.job?.result)).toContain('bootstrap');
  });

  test('forwards rescan planSelection and module-scope args to the workflow', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const planSelection = moduleMiningSelection();
    const server = new HostMcpServer({ projectRoot });

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
    expect(JSON.stringify(result.data?.job?.result)).toContain('rescan');
  });
});

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-job-home-'));
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
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"alembic-job-project"}\n');
  fs.mkdirSync(path.join(root, 'Sources', 'App'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Sources', 'App', 'index.ts'), 'export const value = 1;\n');
  return root;
}

function makeInitializedWorkspace(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
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
