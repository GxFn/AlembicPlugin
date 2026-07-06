import type { DaemonState } from '@alembic/core/daemon';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __clearDaemonAutostartCooldownForTests,
  ensureResidentDaemonRunning,
} from '../../lib/service/resident/DaemonAutostart.js';

function makeState(partial: Partial<DaemonState> = {}): DaemonState {
  return {
    schemaVersion: 1,
    projectRoot: '/ws',
    dataRoot: '/data',
    projectId: 'p1',
    pid: 111,
    host: '127.0.0.1',
    port: 50040,
    url: 'http://127.0.0.1:50040',
    dashboardUrl: 'http://127.0.0.1:50040',
    token: 'tok',
    version: '0.2.0',
    mode: 'daemon',
    startedAt: '2026-07-06T00:00:00.000Z',
    lastReadyAt: '2026-07-06T00:00:00.000Z',
    databasePath: '/data/alembic.db',
    schemaMigrationVersion: null,
    entrypoint: '/main/dist/bin/daemon-server.js',
    execPath: '/nvm/node22/bin/node',
    ...partial,
  };
}

/** 可控时钟 + 立即返回的 sleep：让等待循环在测试里同步推进。 */
function makeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ensureResidentDaemonRunning', () => {
  beforeEach(() => {
    __clearDaemonAutostartCooldownForTests();
  });

  test('healthy daemon short-circuits to already-running without spawning', async () => {
    const spawnImpl = vi.fn();
    const result = await ensureResidentDaemonRunning({
      projectRoot: '/ws',
      readState: () => makeState(),
      probeHealth: async () => true,
      spawnImpl: spawnImpl as never,
    });
    expect(result.status).toBe('already-running');
    expect(result.pid).toBe(111);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('plugin-only shape (no state, no env) degrades to unavailable', async () => {
    const result = await ensureResidentDaemonRunning({
      projectRoot: '/ws',
      env: {} as NodeJS.ProcessEnv,
      readState: () => null,
      probeHealth: async () => false,
      spawnImpl: vi.fn() as never,
      existsImpl: () => false,
    });
    expect(result.status).toBe('unavailable');
    expect(result.entrypoint).toBeNull();
    expect(result.reason).toContain('No daemon entrypoint');
  });

  test('dead daemon with self-registered entrypoint respawns and waits until healthy', async () => {
    const clock = makeClock();
    const stale = makeState({ startedAt: '2026-07-06T00:00:00.000Z' });
    const freshAfterSpawn = makeState({ pid: 222, startedAt: '2026-07-06T01:00:00.000Z' });
    let spawned = false;
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => {
      spawned = true;
      return child;
    });
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await ensureResidentDaemonRunning({
      projectRoot: '/ws',
      env: {} as NodeJS.ProcessEnv,
      readState: () => (spawned ? freshAfterSpawn : stale),
      // 首探(旧实例)不健康；spawn 后的新实例健康。
      probeHealth: async (state) => spawned && state.startedAt === freshAfterSpawn.startedAt,
      spawnImpl: spawnImpl as never,
      existsImpl: (path) => path === stale.entrypoint || path === stale.execPath,
      nowImpl: clock.now,
      sleepImpl: async (ms) => {
        clock.advance(ms);
      },
      logger,
    });

    expect(result.status).toBe('started');
    expect(result.pid).toBe(222);
    expect(result.entrypoint).toBe('/main/dist/bin/daemon-server.js');
    // 复用自注册的 Node 绝对路径 + detached 后台形态。
    expect(spawnImpl).toHaveBeenCalledWith(
      '/nvm/node22/bin/node',
      ['/main/dist/bin/daemon-server.js'],
      expect.objectContaining({
        cwd: '/ws',
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({ ALEMBIC_PROJECT_DIR: '/ws' }),
      })
    );
    expect(child.unref).toHaveBeenCalled();
  });

  test('second attempt within cooldown window returns cooldown without spawning again', async () => {
    const clock = makeClock();
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    const base = {
      projectRoot: '/ws',
      env: {} as NodeJS.ProcessEnv,
      readState: () => makeState(),
      probeHealth: async () => false,
      spawnImpl: spawnImpl as never,
      existsImpl: () => true,
      nowImpl: clock.now,
      sleepImpl: async (ms: number) => {
        clock.advance(ms);
      },
      waitBudgetMs: 800,
    };

    const first = await ensureResidentDaemonRunning(base);
    expect(first.status).toBe('spawn-timeout');
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    clock.advance(1_000); // 仍在 60s 冷却窗内
    const second = await ensureResidentDaemonRunning(base);
    expect(second.status).toBe('cooldown');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test('ALEMBIC_DAEMON_AUTOSTART=0 disables autostart entirely', async () => {
    const result = await ensureResidentDaemonRunning({
      projectRoot: '/ws',
      env: { ALEMBIC_DAEMON_AUTOSTART: '0' } as NodeJS.ProcessEnv,
      readState: () => null,
      spawnImpl: vi.fn() as never,
    });
    expect(result.status).toBe('disabled');
  });

  test('spawn throwing is captured as spawn-failed with warn log', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await ensureResidentDaemonRunning({
      projectRoot: '/ws',
      env: {} as NodeJS.ProcessEnv,
      readState: () => makeState(),
      probeHealth: async () => false,
      spawnImpl: (() => {
        throw new Error('EPERM');
      }) as never,
      existsImpl: () => true,
      logger,
    });
    expect(result.status).toBe('spawn-failed');
    expect(result.reason).toBe('EPERM');
    expect(logger.warn).toHaveBeenCalledWith('[DaemonAutostart] spawn failed', expect.anything());
  });

  test('env ALEMBIC_DAEMON_ENTRYPOINT takes precedence over daemon-state entrypoint', async () => {
    const clock = makeClock();
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    await ensureResidentDaemonRunning({
      projectRoot: '/ws',
      env: { ALEMBIC_DAEMON_ENTRYPOINT: '/custom/daemon.js' } as NodeJS.ProcessEnv,
      readState: () => makeState(),
      probeHealth: async () => false,
      spawnImpl: spawnImpl as never,
      existsImpl: () => true,
      nowImpl: clock.now,
      sleepImpl: async (ms) => {
        clock.advance(ms);
      },
      waitBudgetMs: 400,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      expect.any(String),
      ['/custom/daemon.js'],
      expect.anything()
    );
  });
});
