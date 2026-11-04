/**
 * 事件循环看门狗(2026-07-10 事故根修配套)。
 *
 * 事故形态:Core fileFlow 的正则在病态输入上灾难性回溯,MCP 主线程被同步计算钉死
 * 1h+——事件循环停摆时,进程内的一切 async 超时/日志都不再执行,宿主只能无限等待。
 * 唯一可靠的旁路是 worker 线程:与主线程共享进程但独立执行,主循环停摆不影响它。
 *
 * 机制:主线程 setInterval(默认 1s, unref)把单调时钟读数写进 SharedArrayBuffer 心跳;
 * worker 每 checkIntervalMs(默认 2s)用同一单调时钟计算停摆时长:
 *   - 停摆 ≥ reportMs(默认 30s):用 fs.writeSync(2, …) 同步写 fd 2 告警。worker 的
 *     process.stderr 是经主线程中转的流,主循环钉死时写不出去;直写 fd 2 绕过主线程,
 *     stdio MCP 宿主在钉死期间就能看到。同时给主线程投递 stall 消息(主循环恢复后补日志)。
 *   - 停摆 ≥ exitMs(默认 180s,0=禁用;仅在已达 reportMs 后检查):先同步写 fd 2 说明
 *     原因,再 process.kill(process.pid, 'SIGKILL') 终结整个进程。worker 内 process.exit()
 *     只结束 worker 线程本身(已实测:主线程钉死时进程照常存活),所以不能用;SIGTERM 等
 *     可捕获信号若被注册了 JS 处理器,也会因主循环钉死而永不执行。SIGKILL 由内核直接
 *     终结,Node 22/24 已实测可杀死被钉死的进程。结果:进程以信号 SIGKILL 结束
 *     (child_process 的 exit 事件 code=null、signal='SIGKILL';shell 中退出码 137),
 *     宿主 MCP 客户端按断管重启,把"无限挂死"降级为"一次可观察的快速失败"。
 *
 * 时钟:两线程都用 process.hrtime.bigint()(libuv uv_hrtime,进程级单调时钟,两线程读数
 * 可直接相减)。它不受 NTP/手动改时影响(Date.now() 是墙钟,对时会跳变,不能用于停摆判定)。
 * 但它**会**计入冻结时间:macOS 上 uv_hrtime 读 mach_continuous_time(已实测 Node 22.22 /
 * 24.19 与 CLOCK_MONOTONIC_RAW 一致,比不含休眠的 CLOCK_UPTIME_RAW 超前整段累计休眠时长),
 * Linux 的 CLOCK_MONOTONIC 也计入 SIGSTOP 冻结。所以不能依赖时钟本身做休眠安全。
 *
 * 休眠安全(挂起检测):系统休眠 / SIGSTOP / VM 暂停冻结的是整个进程,worker 也一起停。
 * 主线程钉死不会拖慢 worker,因此 worker 自身两次检查的间隔远超 checkIntervalMs
 * (> max(4×checkIntervalMs, 1000ms),生产即 8s ≪ reportMs 30s)时,判定为整进程刚被
 * 冻结后恢复:记 resumedAt=now、本次跳过报告/终结,此后停摆按 now - max(心跳, resumedAt)
 * 计——唤醒后主线程重新获得完整的 reportMs/exitMs 窗口,合盖睡一夜唤醒不会被误杀。
 * 代价(保守方向):冻结前已在进行的真实停摆,唤醒后需重新累计满 exitMs 才终结;极端 CPU
 * 争用让 worker 自身延迟超过阈值时同理只会推迟终结,绝不会误杀。挂起检测会写一行 fd 2 诊断。
 * 回归测试见 test/unit/FixWatchdogSuspendSafety.test.ts(SIGSTOP/SIGCONT 冻结子进程)。
 *
 * 调试器安全(inspector 抑制终结):开发者停在断点时 inspector 暂停的正是主线程,心跳同样
 * 停止,看门狗无法区分"断点暂停"与"同步钉死"。所以 inspector 激活时只报告、绝不终结:
 * 主线程判定 inspector 状态并经第二块 SharedArrayBuffer(Int32 标志位)发布给 worker——
 *   - 启动时:execArgv / NODE_OPTIONS 含 --inspect / --inspect-brk / --inspect-wait
 *     (含 =host:port 形式),或 inspector.url() !== undefined;
 *   - 运行中:每次心跳重读 inspector.url()(SIGUSR1 / inspector.open() 后打开的调试器也能
 *     被识别;断点暂停发生在调试器连上之后,此时标志早已发布)。状态切换在 stderr 留痕。
 * 达到 exitMs 且标志为 1 时,worker 在 fd 2 写一行 "inspector attached; not killing" 诊断
 * (每轮停摆一次),停摆报告照常输出。标志只在心跳里更新:停摆期间关闭 inspector 不会
 * 重新启用终结(保守方向,不误杀)。node:inspector 不可用(无 inspector 构建)时只按启动
 * 参数判定并留痕。回归测试见 test/unit/FixWatchdogInspector.test.ts。
 *
 * 阈值经 env 覆盖:ALEMBIC_MCP_WATCHDOG=off 整体关闭;ALEMBIC_MCP_WATCHDOG_REPORT_MS /
 * ALEMBIC_MCP_WATCHDOG_EXIT_MS 调档(测试用小值;EXIT_MS=0 只报告不终结)。
 * 终结路径的回归测试见 test/unit/FixWatchdogTermination.test.ts(子进程隔离)。
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
const fs = process.getBuiltinModule('node:fs');
const { heartbeat, inspectorFlag, reportMs, exitMs, checkIntervalMs, pid } = workerData;
const beat = new BigInt64Array(heartbeat);
// 主线程发布的 inspector 激活标志(1=激活):激活时只报告不终结,见文件头"调试器安全"。
const inspector = new Int32Array(inspectorFlag);
// 单槽对象承载可变状态(避免 doctrine lint 把字符串里的 let 当模块级可变绑定):
// reported=本轮停摆是否已报告;suppressed=本轮是否已写过 inspector 抑制诊断;
// lastCheck=上次检查时刻;resumedAt=最近一次整进程冻结恢复时刻。
const startedAt = process.hrtime.bigint();
const state = { reported: false, suppressed: false, lastCheck: startedAt, resumedAt: 0n };
// worker 自身检查间隔超过该值即视为整进程被冻结过(休眠/SIGSTOP/VM 暂停),见文件头说明。
const suspendGapMs = Math.max(checkIntervalMs * 4, 1000);
const pause = new Int32Array(new SharedArrayBuffer(4));
// 同步直写 fd 2:不经主线程中转,主循环钉死时仍能立刻送达宿主。stderr 若是非阻塞
// 管道且写满会抛 EAGAIN,有界重试(最多 ~100ms)后放弃——诊断尽力而为,绝不能挡住终结。
function writeDiagnostic(text) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.writeSync(2, text);
      return;
    } catch (err) {
      if (!err || err.code !== 'EAGAIN') {
        return;
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}
setInterval(() => {
  // 与主线程同一进程级单调时钟(hrtime,纳秒);它计入休眠/冻结时长,见文件头说明。
  const now = process.hrtime.bigint();
  const sinceLastCheck = Number((now - state.lastCheck) / 1000000n);
  state.lastCheck = now;
  if (sinceLastCheck > suspendGapMs) {
    // 主线程钉死拖不慢 worker;worker 自己迟到这么久,只能是整进程被冻结(休眠等)。
    // 唤醒后心跳可能还排在主线程其它回调之后,此刻算出的"停摆"是冻结时长而非主线程阻塞:
    // 重置基线、本次跳过报告/终结,给主线程一个完整的新窗口。
    state.resumedAt = now;
    state.reported = false;
    state.suppressed = false;
    writeDiagnostic(
      '[MCP watchdog] process was suspended for ~' + sinceLastCheck + 'ms (system sleep / SIGSTOP / VM pause, pid=' + pid + ') — resetting stall baseline, no report or kill for this gap\\n'
    );
    return;
  }
  // Atomics.load:跨线程读 64 位共享值必须原子——普通读在规范上允许撕裂/延迟可见,
  // 撕裂出的垃圾时间戳会算出巨大 stalled → 假报警甚至误杀。看门狗自身绝不能是误杀源。
  const beatAt = Atomics.load(beat, 0);
  // 停摆从"最近心跳"与"最近冻结恢复"中较晚者起算:冻结时长绝不计入停摆。
  const last = beatAt > state.resumedAt ? beatAt : state.resumedAt;
  const stalled = Number((now - last) / 1000000n);
  if (stalled < reportMs) {
    state.reported = false;
    state.suppressed = false;
    return;
  }
  if (!state.reported) {
    state.reported = true;
    writeDiagnostic(
      '[MCP watchdog] event loop stalled for ' + stalled + 'ms (pid=' + pid + ') — main thread is blocked by synchronous work\\n'
    );
    try { parentPort.postMessage({ type: 'stall-report', stalledMs: stalled }); } catch {}
  }
  if (exitMs > 0 && stalled >= exitMs) {
    if (Atomics.load(inspector, 0) === 1) {
      // 调试器暂停与同步钉死不可区分:inspector 激活时绝不终结,只留一次诊断说明原因。
      if (!state.suppressed) {
        state.suppressed = true;
        writeDiagnostic(
          '[MCP watchdog] event loop stalled for ' + stalled + 'ms (>=' + exitMs + 'ms, pid=' + pid + ') — inspector attached; not killing (main thread may be paused at a debugger breakpoint)\\n'
        );
      }
      return;
    }
    writeDiagnostic(
      '[MCP watchdog] event loop stalled for ' + stalled + 'ms (>=' + exitMs + 'ms, pid=' + pid + ') — sending SIGKILL to the whole process so the host can respawn instead of hanging forever\\n'
    );
    // process.exit() 在 worker 内只结束 worker;SIGKILL 才能终结被钉死的整个进程。
    process.kill(pid, 'SIGKILL');
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
  // 心跳用单调时钟 hrtime(与 worker 同源),不用 Date.now():休眠/对时不得被判为停摆。
  Atomics.store(beat, 0, process.hrtime.bigint());

  // inspector 激活标志:必须在 worker 启动前同步发布,--inspect-brk 等启动即暂停的场景
  // 不能有"先杀后知"的窗口。启动参数判定一次;inspector.url() 在每次心跳重读。
  const inspectorFlag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const inspectorState = new Int32Array(inspectorFlag);
  const startupInspectFlag = hasInspectFlag(process.execArgv, process.env.NODE_OPTIONS);
  const readInspectorUrl = loadInspectorUrlReader();
  const publishInspectorState = (): void => {
    const urlActive = readInspectorUrl() !== undefined;
    const active = startupInspectFlag || urlActive ? 1 : 0;
    const previous = Atomics.exchange(inspectorState, 0, active);
    if (previous !== active) {
      const reason = startupInspectFlag
        ? 'inspect flag in execArgv/NODE_OPTIONS'
        : 'inspector.url()';
      process.stderr.write(
        active === 1
          ? `[MCP watchdog] inspector active (${reason}); stalls beyond exitMs will be reported but not killed\n`
          : '[MCP watchdog] inspector closed; stall termination re-enabled\n'
      );
    }
  };
  publishInspectorState();

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      checkIntervalMs: options.checkIntervalMs ?? WORKER_CHECK_INTERVAL_MS,
      exitMs,
      heartbeat,
      inspectorFlag,
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
  // worker 自身故障只降级为"无看门狗",绝不影响主服务;降级须在 stderr 留痕(stdout 是 MCP 协议通道)。
  worker.on('error', (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[MCP watchdog] worker failed, event loop watchdog disabled: ${reason}\n`);
  });

  const timer = setInterval(() => {
    Atomics.store(beat, 0, process.hrtime.bigint());
    // 运行中打开的调试器(SIGUSR1 / inspector.open())在下一次心跳即被发布给 worker。
    publishInspectorState();
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      void worker.terminate();
    },
  };
}

// 会打开调试器的启动参数;--inspect-port / --inspect-publish-uid 只配置不打开,不算。
const INSPECT_FLAG_PATTERN = /^--inspect(?:-brk|-wait)?(?:=.*)?$/;

/** 启动参数或 NODE_OPTIONS 是否请求打开 inspector(--inspect / --inspect-brk / --inspect-wait)。 */
export function hasInspectFlag(
  execArgv: readonly string[],
  nodeOptions: string | undefined
): boolean {
  const optionTokens = (nodeOptions ?? '').split(/\s+/).filter((token) => token.length > 0);
  return [...execArgv, ...optionTokens].some((arg) => INSPECT_FLAG_PATTERN.test(arg));
}

/**
 * 取 inspector.url() 读取器。node:inspector 在无 inspector 的 Node 构建上会抛错:
 * 降级为恒返回 undefined(只靠启动参数判定),并在 stderr 留痕;绝不让看门狗因此启动失败。
 */
function loadInspectorUrlReader(): () => string | undefined {
  try {
    const inspector = process.getBuiltinModule('node:inspector');
    return () => inspector.url();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[MCP watchdog] node:inspector unavailable (${reason}); debugger detection falls back to startup flags\n`
    );
    return () => undefined;
  }
}

function readPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readNonNegativeInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
