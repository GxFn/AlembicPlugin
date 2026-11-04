/**
 * EventLoopWatchdog 调试器安全回归(子进程隔离):
 *   看门狗在停摆达到 exitMs 后会 SIGKILL 整个进程;开发者在断点处暂停(inspector 暂停
 *   主线程)超过 exitMs 时,这会把正在调试的 MCP server 杀掉。inspector 激活时必须只报告、
 *   不终结,并在 fd 2 写明抑制原因。
 *   - 启动参数带 --inspect=0(随机端口)的子进程同步钉死超过 exitMs 仍存活;
 *   - 运行中才打开 inspector(inspector.open,等价 SIGUSR1)的子进程同样不被终结;
 *   - 无 inspector 时仍被终结,由 FixWatchdogTermination.test.ts 覆盖。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasInspectFlag } from '../../lib/host-runtime/mcp/EventLoopWatchdog.js';

const WATCHDOG_URL = pathToFileURL(
  path.resolve(__dirname, '../../lib/host-runtime/mcp/EventLoopWatchdog.ts')
).href;

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

/** 子进程:启动看门狗(可选先在运行中打开 inspector),然后同步钉死主线程 blockMs。 */
function runBlockedChild(options: {
  nodeArgs: string[];
  openInspectorAtRuntime: boolean;
}): Promise<ChildOutcome> {
  const script = `
import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG_URL)};
const handle = startEventLoopWatchdog({
  reportMs: 150,
  exitMs: 400,
  checkIntervalMs: 25,
  heartbeatIntervalMs: 10,
});
if (!handle) { throw new Error('watchdog disabled'); }
${
  options.openInspectorAtRuntime
    ? "process.getBuiltinModule('node:inspector').open(0, '127.0.0.1', false);"
    : ''
}
// 等若干次心跳,让主线程把 inspector 状态发布给 worker。
await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write('blocking\\n');
const until = Date.now() + 1500;
while (Date.now() < until) {}
process.stdout.write('survived\\n');
handle.stop();
${options.openInspectorAtRuntime ? "process.getBuiltinModule('node:inspector').close();" : ''}
`;
  const env = { ...process.env };
  delete env.ALEMBIC_MCP_WATCHDOG;
  delete env.ALEMBIC_MCP_WATCHDOG_REPORT_MS;
  delete env.ALEMBIC_MCP_WATCHDOG_EXIT_MS;
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...options.nodeArgs, '--no-warnings', '--input-type=module', '-e', script],
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
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });
}

describe('EventLoopWatchdog 调试器安全(子进程)', () => {
  it('以 --inspect=0 启动时,钉死超过 exitMs 仍存活,并在 fd 2 写明抑制原因', async () => {
    const outcome = await runBlockedChild({
      nodeArgs: ['--inspect=0'],
      openInspectorAtRuntime: false,
    });
    expect(outcome.stdout).toContain('blocking');
    expect(outcome.stdout).toContain('survived');
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain('[MCP watchdog] event loop stalled');
    expect(outcome.stderr).toContain('inspector attached; not killing');
    expect(outcome.stderr).not.toContain('sending SIGKILL');
  }, 10_000);

  it('运行中才打开 inspector(等价 SIGUSR1)时,同样不终结', async () => {
    const outcome = await runBlockedChild({ nodeArgs: [], openInspectorAtRuntime: true });
    expect(outcome.stdout).toContain('survived');
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain('inspector attached; not killing');
    expect(outcome.stderr).not.toContain('sending SIGKILL');
  }, 10_000);
});

describe('hasInspectFlag(启动参数 / NODE_OPTIONS 识别)', () => {
  it('识别 --inspect / --inspect-brk / --inspect-wait(含 =host:port 形式)', () => {
    expect(hasInspectFlag(['--inspect'], undefined)).toBe(true);
    expect(hasInspectFlag(['--inspect=0'], undefined)).toBe(true);
    expect(hasInspectFlag(['--inspect-brk=127.0.0.1:9229'], undefined)).toBe(true);
    expect(hasInspectFlag(['--inspect-wait'], undefined)).toBe(true);
    expect(hasInspectFlag([], '--max-old-space-size=4096 --inspect-brk')).toBe(true);
    expect(hasInspectFlag([], '--inspect=0')).toBe(true);
  });

  it('不把 --inspect-port 等不打开调试器的参数误判为激活', () => {
    expect(hasInspectFlag([], undefined)).toBe(false);
    expect(hasInspectFlag(['--no-warnings', '--inspect-port=9230'], '')).toBe(false);
    expect(hasInspectFlag([], '--inspect-publish-uid=stderr --enable-source-maps')).toBe(false);
  });
});
