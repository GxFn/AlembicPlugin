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
    const getContainer = async () => ({
      get() {
        return {
          async checkAndPromote(cap?: number) {
            observedCap = cap;
            return { promoted: [], rolledBack: [], waiting: [] };
          },
        };
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
    const getContainer = async () => ({
      get() {
        return {
          async checkAndPromote(cap?: number) {
            observedCap = cap;
            return { promoted: [], rolledBack: [], waiting: [] };
          },
        };
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
});
