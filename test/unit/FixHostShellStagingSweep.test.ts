import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DecayDetector,
  LifecycleStateMachine,
  ProposalExecutor,
  StagingManager,
} from '@alembic/core/evolution';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { EmbeddedToolExecutor } from '../../lib/host-runtime/mcp/host/embedded-executor.js';
import {
  resetStagingAccessSweepStateForTests,
  STAGING_ACCESS_SWEEP_TOOL_NAMES,
} from '../../lib/host-runtime/mcp/host/staging-access-sweep.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

// 恢复的 tick-on-access staging sweep：只在写类 embedded 工具（submit / dimension_complete /
// rescan）、已初始化项目、请求项目的插件自有容器内、工具 handler 之前运行。这里 spy Core 四个
// driver 的原型方法，观察真实容器里的真实单例是否被驱动，而不是 mock sweep 模块本身。

const ENV_KEYS = [
  'ALEMBIC_HOME',
  'ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS',
  'ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS',
  'ALEMBIC_VECTOR_RECONCILE_MIN_INTERVAL_MS',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const createdRoots: string[] = [];

function spyDrivers() {
  return {
    promote: vi
      .spyOn(StagingManager.prototype, 'checkAndPromote')
      .mockResolvedValue({ promoted: [], rolledBack: [], waiting: [] } as never),
    timeouts: vi
      .spyOn(LifecycleStateMachine.prototype, 'checkTimeouts')
      .mockResolvedValue({ checked: 0, timedOut: [] } as never),
    execute: vi
      .spyOn(ProposalExecutor.prototype, 'checkAndExecute')
      .mockResolvedValue({ executed: [], expired: [], rejected: [], skipped: [] } as never),
    decay: vi.spyOn(DecayDetector.prototype, 'scanAll').mockResolvedValue([] as never),
  };
}

describe('FixHostShell: restored bounded staging-access sweep', () => {
  beforeEach(() => {
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-sweep-home-'));
    createdRoots.push(process.env.ALEMBIC_HOME);
    // 关闭节流，保证每个用例都真实跑到 driver；向量对账走独立长节流，避免触网。
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    process.env.ALEMBIC_VECTOR_RECONCILE_MIN_INTERVAL_MS = String(24 * 60 * 60 * 1000);
    resetStagingAccessSweepStateForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetStagingAccessSweepStateForTests();
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('sweep tool set is exactly the write-class container tools', () => {
    expect([...STAGING_ACCESS_SWEEP_TOOL_NAMES].sort()).toEqual([
      'alembic_dimension_complete',
      'alembic_rescan',
      'alembic_submit_knowledge',
    ]);
  });

  test('alembic_submit_knowledge on an initialized project drives all sweep drivers inside the request container', async () => {
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const drivers = spyDrivers();

    const result = (await server.handleToolCall('alembic_submit_knowledge', {})) as {
      success?: boolean;
    };

    // sweep 不改变工具响应：空参数仍由 wrapHandler 返回原有结构化失败。
    expect(result).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('promotedCount');
    expect(drivers.promote).toHaveBeenCalledTimes(1);
    expect(drivers.promote).toHaveBeenCalledWith(50);
    expect(drivers.timeouts).toHaveBeenCalledWith(50);
    expect(drivers.execute).toHaveBeenCalledWith(50);
    expect(drivers.decay).toHaveBeenCalledWith(50);
  }, 60_000);

  test('read-only and local tools never run the sweep', async () => {
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const drivers = spyDrivers();

    await server.handleToolCall('alembic_status', {});
    await server.handleToolCall('alembic_search', { query: 'value' });
    await server.handleToolCall('alembic_prime', {});

    expect(drivers.promote).not.toHaveBeenCalled();
    expect(drivers.timeouts).not.toHaveBeenCalled();
    expect(drivers.execute).not.toHaveBeenCalled();
    expect(drivers.decay).not.toHaveBeenCalled();
  }, 60_000);

  test('uninitialized project skips the sweep and refuses before opening the container', async () => {
    const projectRoot = makeProjectRoot();
    const drivers = spyDrivers();
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'sweep-test',
      hostProjectRoot: projectRoot,
    });
    const projectRuntime = buildProjectRuntimeContext({ projectRoot });
    expect(projectRuntime.location.databaseExists).toBe(false);

    const result = await executor.execute(
      'alembic_submit_knowledge',
      {},
      { projectRoot, projectRuntime }
    );
    await executor.dispose();

    // A4：未初始化项目上的写类工具在容器打开（Bootstrap）之前被拒绝，sweep 自然不会运行。
    expect(result).toMatchObject({ success: false, errorCode: 'PROJECT_NOT_INITIALIZED' });
    expect(drivers.promote).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
  }, 60_000);

  test('a failing sweep is logged and never fails the tool', async () => {
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const baseline = await server.handleToolCall('alembic_submit_knowledge', {});
    resetStagingAccessSweepStateForTests();
    const drivers = spyDrivers();
    drivers.promote.mockRejectedValue(new Error('sweep boom'));

    const result = await server.handleToolCall('alembic_submit_knowledge', {});

    expect(drivers.promote).toHaveBeenCalledTimes(1);
    expect(drivers.decay).not.toHaveBeenCalled();
    expect(stripVolatile(result)).toEqual(stripVolatile(baseline));
  }, 60_000);

  test('a hanging sweep is bounded by the envelope timeout', async () => {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '200';
    const projectRoot = makeProjectRoot();
    const server = await makeInitializedServer(projectRoot);
    const drivers = spyDrivers();
    let release: (() => void) | null = null;
    drivers.promote.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ promoted: [], rolledBack: [], waiting: [] } as never);
        }) as never
    );

    const startedAt = Date.now();
    const result = await server.handleToolCall('alembic_submit_knowledge', {});
    const elapsed = Date.now() - startedAt;
    (release as (() => void) | null)?.();

    expect(result).toBeTruthy();
    expect(drivers.promote).toHaveBeenCalledTimes(1);
    // 宽松上界：并发跑测时只需证明工具没有被挂死的 sweep 阻塞。
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-sweep-project-'));
  createdRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"alembic-sweep-project"}\n');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const value = 1;\n');
  return root;
}

// 与 alembic_init 同一路径初始化（SetupService + init marker），不手写 .asd 桩。
async function makeInitializedServer(projectRoot: string): Promise<HostMcpServer> {
  const server = new HostMcpServer({ projectRoot });
  const init = await server.handleToolCall('alembic_init', {});
  expect(init).toMatchObject({ success: true });
  return server;
}

const VOLATILE_KEYS = new Set([
  'projectRuntime',
  '_meta',
  'durationMs',
  'responseTimeMs',
  'timestamp',
]);

function stripVolatile(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, nested) => (VOLATILE_KEYS.has(key) ? undefined : nested))
  );
}
