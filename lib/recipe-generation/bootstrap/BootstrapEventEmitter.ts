/**
 * BootstrapEventEmitter.js — 统一的 Bootstrap 进度事件推送
 *
 * 两端（内部 Agent / 宿主 Agent）使用相同的事件名和数据格式，
 * 同时兼容 EventBus 和 BootstrapTaskManager。
 *
 * @module shared/BootstrapEventEmitter
 */

import type { DimensionCompletePayload, ProgressPayload } from './bootstrap-event-types.js';

export class BootstrapEventEmitter {
  /** EventBus 实例 */
  #eventBus: Record<string, (...args: unknown[]) => void> | null;

  /** BootstrapTaskManager 实例 */
  #taskManager: Record<string, (...args: unknown[]) => void> | null;

  /** @param container DI Container */
  constructor(container: { get?: (name: string) => unknown }) {
    this.#eventBus = null;
    this.#taskManager = null;

    try {
      this.#eventBus = (container.get?.('eventBus') ?? null) as Record<
        string,
        (...args: unknown[]) => void
      > | null;
    } catch {
      /* eventBus not registered */
    }

    try {
      this.#taskManager = (container.get?.('bootstrapTaskManager') ?? null) as Record<
        string,
        (...args: unknown[]) => void
      > | null;
    } catch {
      /* taskManager not registered */
    }
  }

  /**
   * 推送维度完成事件
   *
   * @param dimId 维度 ID
   * @param data 事件数据
   * @param [data.type] 'skill' | 'candidate' | 'dual'
   * @param [data.extracted] 提取的候选数量
   * @param [data.source] 'host' | 'host-agent'
   * @param [data.skillCreated] 是否生成了 Skill
   * @param [data.recipesBound] 关联的 recipe 数量
   */
  emitDimensionComplete(dimId: string, data: DimensionCompletePayload) {
    // TaskManager 标记。与主仓库 BootstrapEventEmitter 同一容错口径(共享资产对齐,
    // 2026-07-02)：非正常终态(error/timeout/blocked/degraded 等)必须标 failed——
    // 此前插件副本无差别 markTaskCompleted，宿主路径的失败维度会被误标为完成。
    // 注：主仓库版另有 emitProcessEvents(daemon job process 草稿推送)，为 daemon
    // 专属能力，插件宿主无 DaemonJobRunner 消费方，属有意的宿主差异，不同步。
    try {
      if (isNonNormalDimensionPayload(data)) {
        this.#taskManager?.markTaskFailed?.(dimId, extractDimensionFailureReason(data), data);
      } else {
        this.#taskManager?.markTaskCompleted?.(dimId, data);
      }
    } catch {
      /* non-blocking */
    }

    // EventBus 推送
    try {
      this.#eventBus?.emit?.('bootstrap:task-completed', {
        dimensionId: dimId,
        ...data,
      });
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送全部维度完成事件
   *
   * @param sessionId 会话 ID
   * @param totalDimensions 总维度数
   * @param [source] 来源标识
   */
  emitAllComplete(sessionId: string, totalDimensions: number, source = 'unknown') {
    try {
      this.#eventBus?.emit?.('bootstrap:all-completed', {
        sessionId,
        totalDimensions,
        source,
      });
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送维度开始填充事件
   *
   * @param dimId 维度 ID
   */
  emitDimensionStart(dimId: string) {
    try {
      this.#taskManager?.markTaskFilling?.(dimId);
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送维度失败事件
   *
   * @param dimId 维度 ID
   * @param error 错误对象
   */
  emitDimensionFailed(dimId: string, error: Error | string) {
    try {
      this.#taskManager?.markTaskFailed?.(dimId, error);
    } catch {
      /* non-blocking */
    }

    try {
      this.#eventBus?.emit?.('bootstrap:task-failed', {
        dimensionId: dimId,
        error: typeof error === 'string' ? error : error?.message,
      });
    } catch {
      /* non-blocking */
    }
  }

  /**
   * 推送进度事件
   *
   * @param event 事件名
   * @param data 事件数据
   */
  emitProgress(event: string, data: ProgressPayload = {}) {
    try {
      this.#eventBus?.emit?.(event, data);
    } catch {
      /* non-blocking */
    }

    try {
      this.#taskManager?.emitProgress?.(event, data);
    } catch {
      /* non-blocking */
    }
  }
}

// 与主仓库 BootstrapEventEmitter 同一判定(逐字对齐)：非正常终态不得标记为完成。
function isNonNormalDimensionPayload(data: DimensionCompletePayload): boolean {
  if (data.type === 'error') {
    return true;
  }
  const status = 'status' in data && typeof data.status === 'string' ? data.status : '';
  return [
    'timeout',
    'blocked',
    'aborted',
    'error',
    'degraded_no_findings',
    'record_repair_incomplete',
    'l4_compaction_failed_budget_exhausted',
  ].includes(status);
}

function extractDimensionFailureReason(data: DimensionCompletePayload): string {
  if ('reason' in data && typeof data.reason === 'string' && data.reason.trim()) {
    return data.reason.trim();
  }
  const status = 'status' in data ? data.status : undefined;
  if (typeof status === 'string' && status.trim()) {
    return status.trim();
  }
  return data.type === 'error' ? 'dimension-error' : 'non-normal-dimension-status';
}

export default BootstrapEventEmitter;
