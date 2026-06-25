import { afterEach, describe, expect, test } from 'vitest';
import {
  maybeRunStagingAccessSweep,
  resetStagingAccessSweepStateForTests,
  resolveStagingAccessSweepCap,
  STAGING_ACCESS_SWEEP_TOOL_NAMES,
} from '../../lib/runtime/mcp/host/staging-access-sweep.js';

const ORIGINAL_MIN_INTERVAL = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS;
const ORIGINAL_TIMEOUT = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS;
const ORIGINAL_CAP = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP;

// runSweep 现在同一 tick 内先 get('stagingManager') 调 checkAndPromote、再
// get('lifecycleStateMachine') 调 checkTimeouts。统一容器桩避免各测试漏配 lifecycle 键
// 导致 checkTimeouts 抛错 → 整 sweep 误入 skipped 兜底。
function makeSweepContainer(opts: {
  checked?: number;
  onCheckTimeouts?: (cap?: number) => void;
  onPromote?: (cap?: number) => void;
  promoted?: Array<{ id?: string; title?: string }>;
  throwOnCheckTimeouts?: Error;
  timedOut?: Array<{ age?: number; fromState?: string; recipeId?: string; toState?: string }>;
}) {
  return async () => ({
    get(name: string) {
      if (name === 'lifecycleStateMachine') {
        return {
          async checkTimeouts(cap?: number) {
            opts.onCheckTimeouts?.(cap);
            if (opts.throwOnCheckTimeouts) {
              throw opts.throwOnCheckTimeouts;
            }
            return { checked: opts.checked ?? 0, timedOut: opts.timedOut ?? [] };
          },
        };
      }
      if (name === 'stagingManager') {
        return {
          async checkAndPromote(cap?: number) {
            opts.onPromote?.(cap);
            return { promoted: opts.promoted ?? [], rolledBack: [], waiting: [] };
          },
        };
      }
      throw new Error(`unexpected container key: ${name}`);
    },
  });
}

describe('StagingAccessSweep', () => {
  afterEach(() => {
    resetStagingAccessSweepStateForTests();
    if (ORIGINAL_MIN_INTERVAL === undefined) {
      delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS;
    } else {
      process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = ORIGINAL_MIN_INTERVAL;
    }
    if (ORIGINAL_TIMEOUT === undefined) {
      delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS;
    } else {
      process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    }
    if (ORIGINAL_CAP === undefined) {
      delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP;
    } else {
      process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP = ORIGINAL_CAP;
    }
  });

  test('enables the required MCP access tools', () => {
    expect([...STAGING_ACCESS_SWEEP_TOOL_NAMES].sort()).toEqual([
      'alembic_dimension_complete',
      'alembic_rescan',
      'alembic_status',
      'alembic_submit_knowledge',
    ]);
  });

  test('runs only for enabled access tools and throttles repeated project ticks', async () => {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '1000';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '0';
    let calls = 0;
    const getContainer = async () => ({
      get(name: string) {
        if (name === 'lifecycleStateMachine') {
          return {
            async checkTimeouts() {
              return { checked: 0, timedOut: [] };
            },
          };
        }
        expect(name).toBe('stagingManager');
        return {
          async checkAndPromote() {
            calls += 1;
            return {
              promoted: [{ id: `recipe-${calls}`, title: 'Recipe' }],
              rolledBack: [],
              waiting: [],
            };
          },
        };
      },
    });

    const first = await maybeRunStagingAccessSweep({
      getContainer,
      now: 10_000,
      projectRoot: '/tmp/project-a',
      toolName: 'alembic_status',
    });
    const second = await maybeRunStagingAccessSweep({
      getContainer,
      now: 10_500,
      projectRoot: '/tmp/project-a',
      toolName: 'alembic_status',
    });
    const third = await maybeRunStagingAccessSweep({
      getContainer,
      now: 11_001,
      projectRoot: '/tmp/project-a',
      toolName: 'alembic_dimension_complete',
    });
    const disabled = await maybeRunStagingAccessSweep({
      getContainer,
      now: 12_500,
      projectRoot: '/tmp/project-a',
      toolName: 'alembic_graph',
    });

    expect(first).toMatchObject({
      promotedCount: 1,
      promotedIds: ['recipe-1'],
      skipped: false,
    });
    expect(second).toMatchObject({ reason: 'throttled', skipped: true });
    expect(third).toMatchObject({
      promotedCount: 1,
      promotedIds: ['recipe-2'],
      skipped: false,
    });
    expect(disabled).toMatchObject({ reason: 'tool-not-enabled', skipped: true });
    expect(calls).toBe(2);
  });

  test('threads the default cap (50) into checkAndPromote when env is unset', async () => {
    // 关闭 throttle/timeout，确保 sweep 真实执行到 checkAndPromote。
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '0';
    delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP;
    // -1 哨兵：若 sweep 被跳过、未调 checkAndPromote，则停留 -1 使断言失败。
    let observedCap: number | undefined = -1;
    const getContainer = makeSweepContainer({
      onPromote: (cap) => {
        observedCap = cap;
      },
    });

    const result = await maybeRunStagingAccessSweep({
      getContainer,
      now: 10_000,
      projectRoot: '/tmp/project-cap-default',
      toolName: 'alembic_status',
    });

    expect(result.skipped).toBe(false);
    expect(observedCap).toBe(50);
  });

  test('threads an env-overridden cap into checkAndPromote', async () => {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP = '3';
    let observedCap: number | undefined = -1;
    const getContainer = makeSweepContainer({
      onPromote: (cap) => {
        observedCap = cap;
      },
    });

    const result = await maybeRunStagingAccessSweep({
      getContainer,
      now: 20_000,
      projectRoot: '/tmp/project-cap-env',
      toolName: 'alembic_status',
    });

    expect(result.skipped).toBe(false);
    expect(observedCap).toBe(3);
  });

  test('resolveStagingAccessSweepCap defaults to 50 and guards invalid env values', () => {
    delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP;
    expect(resolveStagingAccessSweepCap()).toBe(50);

    // foot-gun 守卫：0(晋级 0 条＝静默禁用)、负值(SQLite LIMIT 负数＝无界)、空与非数字均回退 50。
    for (const bad of ['0', '-1', 'abc', '', '   ']) {
      process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP = bad;
      expect(resolveStagingAccessSweepCap()).toBe(50);
    }

    // 合法正数：非整数向下取整为合法 LIMIT。
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP = '3';
    expect(resolveStagingAccessSweepCap()).toBe(3);
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP = '25.9';
    expect(resolveStagingAccessSweepCap()).toBe(25);
  });

  test('drives lifecycle.checkTimeouts with the shared cap after checkAndPromote', async () => {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP = '7';
    const order: string[] = [];
    let promoteCap: number | undefined = -1;
    let timeoutsCap: number | undefined = -1;
    const getContainer = makeSweepContainer({
      checked: 5,
      onCheckTimeouts: (cap) => {
        order.push('checkTimeouts');
        timeoutsCap = cap;
      },
      onPromote: (cap) => {
        order.push('checkAndPromote');
        promoteCap = cap;
      },
      promoted: [{ id: 'p1', title: 'P' }],
      timedOut: [
        { age: 1, fromState: 'evolving', recipeId: 'r1', toState: 'active' },
        { age: 2, fromState: 'pending', recipeId: 'r2', toState: 'deprecated' },
      ],
    });

    const result = await maybeRunStagingAccessSweep({
      getContainer,
      now: 30_000,
      projectRoot: '/tmp/project-checktimeouts',
      toolName: 'alembic_status',
    });

    expect(result.skipped).toBe(false);
    // 同一共享 cap(env=7) 同时驱动 promote 与 checkTimeouts。
    expect(promoteCap).toBe(7);
    expect(timeoutsCap).toBe(7);
    // checkTimeouts 在 checkAndPromote 之后（同一 tick / 同一信封）。
    expect(order).toEqual(['checkAndPromote', 'checkTimeouts']);
    // additive 可观测计数（不改既有字段语义）。
    expect(result.timedOutCount).toBe(2);
    expect(result.checkedTimeouts).toBe(5);
  });

  test('falls back to skipped when checkTimeouts throws, leaving the sweep envelope intact', async () => {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '0';
    delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP;
    const getContainer = makeSweepContainer({
      throwOnCheckTimeouts: new Error('checkTimeouts boom'),
    });

    const result = await maybeRunStagingAccessSweep({
      getContainer,
      now: 40_000,
      projectRoot: '/tmp/project-checktimeouts-throw',
      toolName: 'alembic_status',
    });

    // checkTimeouts 抛错 → 整 sweep 走既有 try/catch skipped 兜底（inFlight/throttle/2s 信封不变）。
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('checkTimeouts boom');
  });
});
