/**
 * EventLoopWatchdog 终结路径回归(子进程隔离):
 *   - worker 内 process.exit() 只结束 worker 自身,主线程被同步钉死时进程照样活着——
 *     看门狗必须真正终结整个进程(SIGKILL),否则"最后防线"形同虚设;
 *   - 停摆/退出诊断必须在主线程仍被钉死时就同步写到 fd 2(不能经主线程中转);
 *   - exitMs=0 时只报告、绝不终结。
 * 破坏性路径只在子进程里跑:Node ≥ 22.18 原生剥离 TS 类型,子进程直接 import 源文件。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WATCHDOG_URL = pathToFileURL(
  path.resolve(__dirname, '../../lib/host-runtime/mcp/EventLoopWatchdog.ts')
).href;

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  elapsedMs: number;
  /** 父进程收到首条停摆诊断时,子进程 stdout 是否已出现 survived(即主线程是否已恢复)。 */
  diagnosticBeforeResume: boolean | null;
}

/** 子进程:启动看门狗、等它就绪,然后同步钉死主线程 blockMs;存活则打印 survived。 */
function runBlockedChild(exitMs: number, blockMs: number): Promise<ChildOutcome> {
  const script = `
import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG_URL)};
const handle = startEventLoopWatchdog({
  reportMs: 150,
  exitMs: ${exitMs},
  checkIntervalMs: 25,
  heartbeatIntervalMs: 10,
});
if (!handle) { throw new Error('watchdog disabled'); }
await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write('blocking\\n');
const until = Date.now() + ${blockMs};
while (Date.now() < until) {}
process.stdout.write('survived\\n');
handle.stop();
`;
  const env = { ...process.env };
  delete env.ALEMBIC_MCP_WATCHDOG;
  delete env.ALEMBIC_MCP_WATCHDOG_REPORT_MS;
  delete env.ALEMBIC_MCP_WATCHDOG_EXIT_MS;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let diagnosticBeforeResume: boolean | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (diagnosticBeforeResume === null && stderr.includes('[MCP watchdog] event loop stalled')) {
        diagnosticBeforeResume = !stdout.includes('survived');
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        diagnosticBeforeResume,
        elapsedMs: Date.now() - started,
        signal,
        stderr,
        stdout,
      });
    });
  });
}

describe('EventLoopWatchdog 终结路径(子进程)', () => {
  it('停摆达到 exitMs 时终结被钉死的整个进程,并先同步写出 fd 2 诊断', async () => {
    const outcome = await runBlockedChild(400, 3_000);
    expect(outcome.stdout).toContain('blocking');
    // 主线程钉死 3s;看门狗在 ~400ms 处终结,子进程绝不能活到阻塞结束。
    expect(outcome.stdout).not.toContain('survived');
    expect(outcome.signal).toBe('SIGKILL');
    expect(outcome.elapsedMs).toBeLessThan(2_800);
    expect(outcome.stderr).toContain('[MCP watchdog] event loop stalled');
    expect(outcome.stderr).toContain('SIGKILL');
    expect(outcome.diagnosticBeforeResume).toBe(true);
  }, 10_000);

  it('exitMs=0 时只报告、绝不终结', async () => {
    const outcome = await runBlockedChild(0, 1_200);
    expect(outcome.stdout).toContain('survived');
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
    // 报告诊断在钉死期间同步写出,不依赖主循环恢复(经主线程中转会晚于 survived 到达)。
    expect(outcome.stderr).toContain('[MCP watchdog] event loop stalled');
    expect(outcome.diagnosticBeforeResume).toBe(true);
  }, 10_000);
});
