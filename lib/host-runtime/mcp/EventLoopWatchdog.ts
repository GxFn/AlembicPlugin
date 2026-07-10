/**
 * 事件循环看门狗(2026-07-10 事故根修配套)。
 *
 * 事故形态:Core fileFlow 的正则在病态输入上灾难性回溯,MCP 主线程被同步计算钉死
 * 1h+——事件循环停摆时,进程内的一切 async 超时/日志都不再执行,宿主只能无限等待。
 * 唯一可靠的旁路是 worker 线程:与主线程共享进程但独立执行,主循环停摆不影响它。
 *
 * 机制:主线程 setInterval(1s, unref)向 SharedArrayBuffer 写心跳;worker 每 2s 检查:
 *   - 停摆 ≥ reportMs(默认 30s):向 stderr 写告警(stdio MCP 的 stderr 由宿主收集,
 *     即使主循环死了宿主也能看到),并给主线程投递 stall 消息(主循环恢复后可入日志);
 *   - 停摆 ≥ exitMs(默认 180s,0=禁用):stderr 写明退出原因后 process.exit(99)——
 *     worker 与主线程同进程,exit 直接终结整个 server;宿主 MCP 客户端按断管重启,
 *     把"无限挂死"降级为"一次可观察的快速失败"。
 * 阈值经 env 覆盖:ALEMBIC_MCP_WATCHDOG=off 整体关闭;ALEMBIC_MCP_WATCHDOG_REPORT_MS /
 * ALEMBIC_MCP_WATCHDOG_EXIT_MS 调档(测试用小值)。
 */
import { Worker } from 'node:worker_threads';

export interface EventLoopWatchdogOptions {
  /** 停摆多久开始报告(ms)。默认 30_000。 */
  reportMs?: number;
  /** 停摆多久强制退出(ms);0 禁用退出。默认 180_000。 */
  exitMs?: number;
  /** worker 检查间隔(ms)。默认 2_000;测试用小值缩短用例时长。 */
  checkIntervalMs?: number;
  /** 主线程心跳间隔(ms)。默认 1_000;必须显著小于 reportMs,否则空转会被误判停摆。 */
  heartbeatIntervalMs?: number;
  /** 主循环恢复后收到 stall 报告的回调(用于补写正式日志)。 */
  onStallReport?: (stalledMs: number) => void;
}

export interface EventLoopWatchdogHandle {
  stop(): void;
}

const HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_CHECK_INTERVAL_MS = 2_000;

// worker 侧逻辑以源码字符串内联(eval worker):看门狗必须零构建依赖、单文件自足——
// 它是最后防线,不能因为 dist 布局/路径解析问题而静默失效。
// 注意:宿主包是 "type":"module",eval worker 继承 ESM 语义,require 不存在;
// process.getBuiltinModule(Node≥22)在 CJS/ESM 下都可用,是 eval 源码的稳妥取法。
const WORKER_SOURCE = `
const { workerData, parentPort } = process.getBuiltinModule('node:worker_threads');
const { heartbeat, reportMs, exitMs, checkIntervalMs, pid } = workerData;
const beat = new BigInt64Array(heartbeat);
// 单槽对象承载 reported 标志(避免 doctrine lint 把字符串里的 let 当模块级可变绑定)。
const state = { reported: false };
setInterval(() => {
  const now = BigInt(Date.now());
  // Atomics.load:跨线程读 64 位共享值必须原子——普通读在规范上允许撕裂/延迟可见,
  // 撕裂出的垃圾时间戳会算出巨大 stalled → 假报警甚至假 exit(99)。看门狗自身绝不能是误杀源。
  const last = Atomics.load(beat, 0);
  const stalled = Number(now - last);
  if (stalled < reportMs) {
    state.reported = false;
    return;
  }
  if (!state.reported) {
    state.reported = true;
    // stderr 是主循环停摆时仍可用的唯一对外通道(stdio MCP 宿主会收集 server stderr)。
    process.stderr.write(
      '[MCP watchdog] event loop stalled for ' + stalled + 'ms (pid=' + pid + ') — main thread is blocked by synchronous work\\n'
    );
    try { parentPort.postMessage({ type: 'stall-report', stalledMs: stalled }); } catch {}
  }
  if (exitMs > 0 && stalled >= exitMs) {
    process.stderr.write(
      '[MCP watchdog] event loop stalled for ' + stalled + 'ms (>=' + exitMs + 'ms) — exiting 99 so the host can respawn instead of hanging forever\\n'
    );
    process.exit(99);
  }
}, checkIntervalMs);
// 注意:worker 内部这个 interval 不能 .unref()——它是 worker 线程唯一的保活句柄,
// unref 会让 worker 在 eval 同步段结束后立即退出,检查回调永不触发。worker 对父进程
// 的 unref 由主线程侧 worker.unref() 负责,与此处正交。
`;

export function startEventLoopWatchdog(
  options: EventLoopWatchdogOptions = {}
): EventLoopWatchdogHandle | null {
  if ((process.env.ALEMBIC_MCP_WATCHDOG ?? '').toLowerCase() === 'off') {
    return null;
  }
  const reportMs =
    readPositiveInt(process.env.ALEMBIC_MCP_WATCHDOG_REPORT_MS) ?? options.reportMs ?? 30_000;
  const exitMs =
    readNonNegativeInt(process.env.ALEMBIC_MCP_WATCHDOG_EXIT_MS) ?? options.exitMs ?? 180_000;

  const heartbeat = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const beat = new BigInt64Array(heartbeat);
  // 与 worker 侧 Atomics.load 配对:心跳写必须 Atomics.store(见 WORKER_SOURCE 内注释)。
  Atomics.store(beat, 0, BigInt(Date.now()));

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      checkIntervalMs: options.checkIntervalMs ?? WORKER_CHECK_INTERVAL_MS,
      exitMs,
      heartbeat,
      pid: process.pid,
      reportMs,
    },
  });
  // 看门狗不得拖住正常退出:worker/interval 全部 unref。
  worker.unref();
  worker.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'stall-report'
    ) {
      const stalledMs = Number((message as { stalledMs?: unknown }).stalledMs) || 0;
      options.onStallReport?.(stalledMs);
    }
  });
  // worker 自身故障只降级为"无看门狗",绝不影响主服务。
  worker.on('error', () => {});

  const timer = setInterval(() => {
    Atomics.store(beat, 0, BigInt(Date.now()));
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      void worker.terminate();
    },
  };
}

function readPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readNonNegativeInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
