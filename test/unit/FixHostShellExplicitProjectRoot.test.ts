import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

// A2：显式 projectRoot 被拒绝时必须返回 PROJECT_ROOT_REQUIRED，绝不回落到环境候选
// （PWD / cwd）；CallTool 的 catch 路径不得因顶层根不可解析而抛出 JSON-RPC 错误。

const createdRoots: string[] = [];
const ENV_KEYS = ['CODEX_WORKSPACE_DIR', 'ALEMBIC_MCP_TOOL_DEADLINE_MS'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const clients: Client[] = [];

type InternalServer = {
  handleToolCallInCurrentProject: (...args: unknown[]) => Promise<unknown>;
};

interface CleanError {
  error?: {
    code?: string;
    details?: {
      projectRootResolution?: { reason?: string; rejected?: boolean; source?: string };
      requiredActions?: string[];
    };
    message?: string;
  };
  ok?: boolean;
  status?: string;
}

function tempProject(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `alembic-fix-host-shell-${name}-`));
  createdRoots.push(root);
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name }));
  return projectRoot;
}

async function connect(server: HostMcpServer): Promise<Client> {
  server.sdkServer = new SdkMcpServer(
    { name: 'alembic-test', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  server.registerHandlers();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.sdkServer.connect(serverTransport);
  const client = new Client({ name: 'fix-host-shell-test', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

describe('explicit projectRoot rejection and CallTool catch path', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clients.splice(0)) {
      await client.close().catch(() => undefined);
    }
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('a nonexistent explicit projectRoot returns PROJECT_ROOT_REQUIRED instead of the env project', async () => {
    const projectRoot = tempProject('top');
    const server = new HostMcpServer({ projectRoot });
    const missing = path.join(path.dirname(projectRoot), 'definitely-not-a-real-project');

    const result = (await server.handleToolCall('alembic_status', {
      projectRoot: missing,
    })) as CleanError;

    expect(result.ok).toBe(false);
    expect(result.status).toBe('project-root-required');
    expect(result.error?.code).toBe('PROJECT_ROOT_REQUIRED');
    expect(result.error?.message).toContain('does not exist');
    expect(result.error?.details?.projectRootResolution).toMatchObject({
      rejected: true,
      source: 'explicit-option',
    });
    expect(result.error?.details?.requiredActions?.length).toBeGreaterThan(0);
    // 绝不能回答进程 cwd（本仓库）或顶层项目的状态：只有 clean error，没有成功信封与 projectRuntime。
    expect((result as { success?: unknown }).success).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('projectRuntime');
  }, 60_000);

  test('a rejected explicit root is not cached: it resolves once the directory exists', async () => {
    const projectRoot = tempProject('top');
    const server = new HostMcpServer({ projectRoot });
    const later = path.join(path.dirname(projectRoot), 'created-later');

    const rejected = (await server.handleToolCall('alembic_status', {
      projectRoot: later,
    })) as CleanError;
    expect(rejected.error?.code).toBe('PROJECT_ROOT_REQUIRED');

    fs.mkdirSync(later, { recursive: true });
    fs.writeFileSync(path.join(later, 'package.json'), JSON.stringify({ name: 'later' }));
    const accepted = (await server.handleToolCall('alembic_status', {
      projectRoot: later,
    })) as { success?: boolean; data?: { project?: { projectRoot?: string } } };
    expect(accepted.success).toBe(true);
    expect(accepted.data?.project?.projectRoot).toBe(later);
  }, 60_000);

  test.each([
    ['a regular file', (root: string) => path.join(root, 'package.json'), 'not a directory'],
    ['the user home directory', () => os.homedir(), 'home directory'],
  ])(
    'an explicit projectRoot that is %s is rejected',
    async (_label, pick, reason) => {
      const projectRoot = tempProject('top');
      const server = new HostMcpServer({ projectRoot });

      const result = (await server.handleToolCall('alembic_status', {
        projectRoot: pick(projectRoot),
      })) as CleanError;

      expect(result.error?.code).toBe('PROJECT_ROOT_REQUIRED');
      expect(result.error?.message).toContain(reason);
    },
    60_000
  );

  test('an omitted projectRoot keeps using the top-level project', async () => {
    const projectRoot = tempProject('top');
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', {})) as {
      success?: boolean;
      data?: { project?: { projectRoot?: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data?.project?.projectRoot).toBe(projectRoot);
  }, 60_000);

  test('an internal error with an unresolvable top-level root returns a structured failure', async () => {
    // 顶层根被拒绝（第一个环境候选是用户 home），旧 catch 路径会在重建 projectRuntime 时抛出。
    process.env.CODEX_WORKSPACE_DIR = os.homedir();
    const server = new HostMcpServer();
    expect(server.projectRoot).toBe('');
    const client = await connect(server);
    vi.spyOn(server, 'handleToolCall').mockRejectedValue(new Error('boom'));

    const result = await client.callTool({ name: 'alembic_status', arguments: {} });

    expect(result.isError).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('INTERNAL_ERROR');
    expect(serialized).toContain('boom');
    expect(serialized).not.toContain('projectRuntime');
  }, 60_000);

  test('an internal error attaches the request project runtime when only the request root resolves', async () => {
    // 顶层根不可解析：能拿到 _meta.alembicPublication 只可能来自请求项目的 projectRuntime。
    process.env.CODEX_WORKSPACE_DIR = os.homedir();
    const server = new HostMcpServer();
    const requestRoot = tempProject('request');
    const client = await connect(server);
    vi.spyOn(
      HostMcpServer.prototype as unknown as InternalServer,
      'handleToolCallInCurrentProject'
    ).mockRejectedValue(new Error('boom-in-request-project'));
    const warn = vi.spyOn(Logger.getInstance(), 'warn');

    const result = await client.callTool({
      name: 'alembic_status',
      arguments: { projectRoot: requestRoot },
    });

    expect(result.isError).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('INTERNAL_ERROR');
    expect(serialized).toContain('boom-in-request-project');
    expect(result._meta).toHaveProperty('alembicPublication');
    const messages = warn.mock.calls.map(([message]) => message);
    expect(messages).toContain('[MCP] alembic_status error');
    expect(messages.some((message) => String(message).includes('projectRuntime omitted'))).toBe(
      false
    );
  }, 60_000);

  test('an internal error for a rejected explicit root does not attach the top-level project', async () => {
    const topRoot = tempProject('top');
    const server = new HostMcpServer({ projectRoot: topRoot });
    const client = await connect(server);
    vi.spyOn(server, 'handleToolCall').mockRejectedValue(new Error('boom-rejected-root'));
    const warn = vi.spyOn(Logger.getInstance(), 'warn');

    const result = await client.callTool({
      name: 'alembic_status',
      arguments: { projectRoot: path.join(path.dirname(topRoot), 'missing-project') },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(result._meta?.alembicPublication).toBeUndefined();
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes('failure has no resolvable request project')
      )
    ).toBe(true);
  }, 60_000);

  // W3a-2：显式根被拒绝时，诊断里只能出现显式候选本身，不能泄露服务器环境（CODEX_WORKSPACE_DIR / PWD / cwd）。
  test.each([
    ['nonexistent', (root: string) => path.join(path.dirname(root), 'no-such-project')],
    ['a regular file', (root: string) => path.join(root, 'package.json')],
    ['the user home directory', () => os.homedir()],
  ])(
    'a rejected explicit projectRoot (%s) reports only the explicit candidate',
    async (_label, pick) => {
      const envProject = tempProject('env-secret');
      process.env.CODEX_WORKSPACE_DIR = envProject;
      const server = new HostMcpServer();
      expect(server.projectRoot).not.toBe('');
      const explicit = pick(envProject);

      const result = (await server.handleToolCall('alembic_status', {
        projectRoot: explicit,
      })) as CleanError;

      expect(result.error?.code).toBe('PROJECT_ROOT_REQUIRED');
      const resolution = result.error?.details?.projectRootResolution as
        | { candidates?: Array<{ path?: string; source?: string }>; reason?: string }
        | undefined;
      expect(resolution?.candidates).toEqual([
        { path: path.resolve(explicit), source: 'explicit-option', trust: 'trusted' },
      ]);
      expect(resolution?.reason).toBeTruthy();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('CODEX_WORKSPACE_DIR');
      expect(serialized).not.toContain('"process.cwd"');
      expect(serialized).not.toContain('"PWD"');
      if (!path.resolve(explicit).startsWith(envProject)) {
        expect(serialized).not.toContain(envProject);
      }
    },
    60_000
  );

  test('the omitted-root gate keeps its full environment candidate list', async () => {
    process.env.CODEX_WORKSPACE_DIR = os.homedir();
    const server = new HostMcpServer();

    const result = (await server.handleToolCall('alembic_status', {})) as CleanError;

    expect(result.error?.code).toBe('PROJECT_ROOT_REQUIRED');
    const resolution = result.error?.details?.projectRootResolution as
      | { candidates?: Array<{ source?: string }> }
      | undefined;
    const sources = (resolution?.candidates ?? []).map((candidate) => candidate.source);
    expect(sources[0]).toBe('CODEX_WORKSPACE_DIR');
    // 后续环境候选（PWD / process.cwd，同路径会去重）仍然保留在顶层门禁诊断里。
    expect(sources.length).toBeGreaterThan(1);
    expect(sources.some((source) => source === 'PWD' || source === 'process.cwd')).toBe(true);
  }, 60_000);

  test('a deadline with an unresolvable top-level root still returns TOOL_TIMEOUT and logs it', async () => {
    process.env.CODEX_WORKSPACE_DIR = os.homedir();
    process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS = '50';
    const server = new HostMcpServer();
    const client = await connect(server);
    vi.spyOn(server, 'handleToolCall').mockImplementation(() => new Promise<unknown>(() => {}));
    const warn = vi.spyOn(Logger.getInstance(), 'warn');

    const result = await client.callTool({ name: 'alembic_status', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('TOOL_TIMEOUT');
    expect(warn.mock.calls.some(([message]) => message === '[MCP] alembic_status timeout')).toBe(
      true
    );
  }, 60_000);
});
