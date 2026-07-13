/**
 * 每调用软超时(2026-07-10 事故配套):async 类挂死(无超时的 await/外部 IO)兜底——
 * 宿主拿到结构化 TOOL_TIMEOUT 而非无限等待。边界:救不了同步钉死(事件循环停摆时
 * 计时器不触发),那一类由 EventLoopWatchdog(worker 线程旁路)负责;两者合起来才
 * 覆盖全部挂死形态。Factory 形式会把同一个 AbortSignal 传给真实工作并在返回
 * TOOL_TIMEOUT 前等待有界的清理确认；Promise 形式仅保留旧调用方兼容。
 */

/** 软超时专用错误:外层据此把响应码定为 TOOL_TIMEOUT(区别于 CODEX_MCP_ERROR)。 */
export class ToolCallDeadlineError extends Error {}

export async function raceToolCallDeadline<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  deadlineMs: number,
  options: { cleanupAckMs?: number } = {}
): Promise<T> {
  const controller = new AbortController();
  const promise = typeof work === 'function' ? work(controller.signal) : work;
  const settled = promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ error, status: 'rejected' as const })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ status: 'deadline' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'deadline' }), deadlineMs);
    timer.unref();
  });
  const outcome = await Promise.race([settled, deadline]);
  if (timer) {
    clearTimeout(timer);
  }
  if (outcome.status === 'fulfilled') {
    return outcome.value;
  }
  if (outcome.status === 'rejected') {
    throw outcome.error;
  }

  const cancellable = typeof work === 'function';
  const timeoutError = new ToolCallDeadlineError(
    cancellable
      ? `tool call exceeded ${deadlineMs}ms deadline (async hang guard); worker aborted and cleanup was bounded`
      : `tool call exceeded ${deadlineMs}ms deadline (async hang guard); underlying work is abandoned`
  );
  controller.abort(timeoutError);
  if (cancellable) {
    const cleanupAckMs = Math.max(0, options.cleanupAckMs ?? 1_000);
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        const cleanupTimer = setTimeout(resolve, cleanupAckMs);
        cleanupTimer.unref();
      }),
    ]);
  }
  throw timeoutError;
}
