/**
 * EventLoopWatchdog 休眠安全回归(子进程隔离):
 *   macOS 上 process.hrtime.bigint()(libuv uv_hrtime = mach_continuous_time)在系统休眠
 *   期间照常前进;整个进程被冻结(系统休眠 / SIGSTOP / VM 暂停)后唤醒时,worker 的检查
 *   若先于主线程心跳执行,会把冻结时长误判为主线程停摆并 SIGKILL 健康进程。
 *   这里用 SIGSTOP/SIGCONT 冻结整个子进程(时钟行为与系统休眠一致),冻结时长远超
 *   exitMs,断言健康子进程从不被看门狗终结。
 * 子进程主线程周期性做短 CPU 突发(远小于 reportMs,属健康负载),让唤醒后心跳排在其后——
 * 对应生产中唤醒后心跳排在 I/O 回调之后的真实时序,使误杀竞态稳定复现。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WATCHDOG_URL = pathToFileURL(
  path.resolve(__dirname, '../../lib/host-runtime/mcp/EventLoopWatchdog.ts')
).href;

const SUSPEND_MS = 1_400;
const RESUME_SETTLE_MS = 300;
const ITERATIONS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EventLoopWatchdog 休眠安全(子进程)', () => {
  it.skipIf(process.platform === 'win32')(
    '整个进程被冻结远超 exitMs 后唤醒,健康进程不被 SIGKILL',
    async () => {
      const script = `
import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG_URL)};
const handle = startEventLoopWatchdog({
  reportMs: 300,
  exitMs: 600,
  checkIntervalMs: 25,
  heartbeatIntervalMs: 10,
});
if (!handle) { throw new Error('watchdog disabled'); }
// 短 CPU 突发:按进程 CPU 时间计量(冻结期间 CPU 时间不前进),每次约 30ms ≪ reportMs。
setInterval(() => {
  const start = process.cpuUsage();
  for (;;) {
    const used = process.cpuUsage(start);
    if (used.user + used.system >= 30_000) { break; }
  }
}, 5);
await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write('ready\\n');
`;
      const env = { ...process.env };
      delete env.ALEMBIC_MCP_WATCHDOG;
      delete env.ALEMBIC_MCP_WATCHDOG_REPORT_MS;
      delete env.ALEMBIC_MCP_WATCHDOG_EXIT_MS;
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--input-type=module', '-e', script],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('close', (code, signal) => {
            resolve({ code, signal });
          });
        }
      );
      const exitedEarly = { value: false };
      void closed.then(() => {
        exitedEarly.value = true;
      });

      const readyDeadline = Date.now() + 5_000;
      while (!stdout.includes('ready') && Date.now() < readyDeadline && !exitedEarly.value) {
        await sleep(20);
      }
      expect(stdout).toContain('ready');

      for (let i = 0; i < ITERATIONS && !exitedEarly.value; i += 1) {
        process.kill(child.pid as number, 'SIGSTOP');
        await sleep(SUSPEND_MS);
        process.kill(child.pid as number, 'SIGCONT');
        await sleep(RESUME_SETTLE_MS);
      }

      const killedByWatchdog = exitedEarly.value;
      if (!exitedEarly.value) {
        child.kill('SIGTERM');
      }
      const outcome = await closed;
      // 子进程只能由测试自己的 SIGTERM 结束;被看门狗 SIGKILL 即为误杀。
      expect(stderr).not.toContain('sending SIGKILL');
      // 挂起检测路径必须留痕(fd 2 诊断),证明是被识别为整进程冻结而非侥幸赢了竞态。
      expect(stderr).toContain('[MCP watchdog] process was suspended');
      expect(killedByWatchdog).toBe(false);
      expect(outcome.signal).toBe('SIGTERM');
    },
    15_000
  );
});
