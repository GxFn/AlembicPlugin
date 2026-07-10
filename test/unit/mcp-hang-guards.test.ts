/**
 * MCP 挂死防线单测(2026-07-10 事故配套):
 *   - raceToolCallDeadline:async 挂死 → ToolCallDeadlineError;正常完成/失败原样透传;
 *   - EventLoopWatchdog:主线程被同步计算钉死时,worker 旁路检测到停摆并在主循环
 *     恢复后投递 stall 报告(exit 路径破坏性,不在单测覆盖,由 exitMs=0 禁用)。
 */
import { describe, expect, it } from 'vitest';
import { startEventLoopWatchdog } from '../../lib/host-runtime/mcp/EventLoopWatchdog.js';
import {
  raceToolCallDeadline,
  ToolCallDeadlineError,
} from '../../lib/host-runtime/mcp/tool-call-deadline.js';

describe('raceToolCallDeadline(async 挂死兜底)', () => {
  it('永不 resolve 的工作在 deadline 处抛 ToolCallDeadlineError', async () => {
    const never = new Promise<void>(() => {});
    await expect(raceToolCallDeadline(never, 50)).rejects.toBeInstanceOf(ToolCallDeadlineError);
  });

  it('按时完成的工作原样返回,失败原样透传(不被包装成超时)', async () => {
    await expect(raceToolCallDeadline(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
    await expect(raceToolCallDeadline(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow(
      'boom'
    );
  });
});

describe('EventLoopWatchdog(同步钉死旁路检测)', () => {
  it('主线程同步阻塞超过 reportMs → 恢复后收到 stall 报告;正常心跳不误报', async () => {
    const reports: number[] = [];
    const handle = startEventLoopWatchdog({
      checkIntervalMs: 25,
      exitMs: 0, // 测试禁用退出路径。
      heartbeatIntervalMs: 10, // 心跳须显著快于 reportMs,否则空转被误判停摆。
      onStallReport: (stalledMs) => {
        reports.push(stalledMs);
      },
      reportMs: 120,
    });
    expect(handle).not.toBeNull();
    try {
      // 等 worker 就绪并空转两轮:正常心跳下不得误报。
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(reports).toHaveLength(0);

      // 同步钉死主线程 ~350ms(> reportMs):事件循环停摆,worker 从旁路观测到。
      const blockUntil = Date.now() + 350;
      while (Date.now() < blockUntil) {
        // busy-wait:模拟正则回溯类同步计算。
      }
      // 主循环恢复后,worker 投递的 stall 消息才会被处理。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reports.length).toBeGreaterThanOrEqual(1);
      expect(reports[0]).toBeGreaterThanOrEqual(120);
    } finally {
      handle?.stop();
    }
  });

  it('ALEMBIC_MCP_WATCHDOG=off 时整体关闭(返回 null)', () => {
    const prev = process.env.ALEMBIC_MCP_WATCHDOG;
    process.env.ALEMBIC_MCP_WATCHDOG = 'off';
    try {
      expect(startEventLoopWatchdog()).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.ALEMBIC_MCP_WATCHDOG;
      } else {
        process.env.ALEMBIC_MCP_WATCHDOG = prev;
      }
    }
  });
});
