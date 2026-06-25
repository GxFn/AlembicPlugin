import { afterEach, describe, expect, test } from 'vitest';
import {
  maybeRunStagingAccessSweep,
  resetStagingAccessSweepStateForTests,
  STAGING_ACCESS_SWEEP_TOOL_NAMES,
} from '../../lib/runtime/mcp/host/staging-access-sweep.js';

const ORIGINAL_MIN_INTERVAL = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS;
const ORIGINAL_TIMEOUT = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS;

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
});
