/**
 * 每调用软超时(2026-07-10 事故配套):async 类挂死(无超时的 await/外部 IO)兜底——
 * 宿主拿到结构化 TOOL_TIMEOUT 而非无限等待。边界:救不了同步钉死(事件循环停摆时
 * 计时器不触发),那一类由 EventLoopWatchdog(worker 线程旁路)负责;两者合起来才
 * 覆盖全部挂死形态。底层 promise 无法取消,超时后其最终结果被丢弃。
 */

/** 软超时专用错误:外层据此把响应码定为 TOOL_TIMEOUT(区别于 CODEX_MCP_ERROR)。 */
export class ToolCallDeadlineError extends Error {}

export function raceToolCallDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ToolCallDeadlineError(
          `tool call exceeded ${deadlineMs}ms deadline (async hang guard); underlying work is abandoned`
        )
      );
    }, deadlineMs);
    // 计时器不得拖住进程退出。
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
