import type { DaemonStatus } from '../../../daemon/DaemonSupervisor.js';
import {
  buildCodexRecommendedAction,
  type CodexEnhancementRequirement,
  type CodexEnhancementRouteChoice,
  type CodexHostProjectAlignment,
  summarizeCodexDaemonStatus,
} from '../../index.js';
import { inspectCodexKnowledge } from '../../KnowledgeState.js';
import { failureResult } from './results.js';

// Dashboard / job handoff 前先校验 Codex host project 与 Alembic runtime 项目关系。
//
// MT1 P3-3 修复：mismatch 仍然阻断共享运行时动作（在全局选择指向其他项目时
// 启动/接管守护进程或 Dashboard 是真实的劫持风险），但阻断响应必须给出
// 插件内可执行的恢复路径 —— 本地宿主工作流（alembic_bootstrap / alembic_rescan）
// 只操作宿主项目自己的数据根，不读写共享运行时选择，是冷启动的法定入口。
// 仅靠 "Switch from Alembic or Dashboard" 对 plugin-only 用户是环形死路。
export function buildCodexHostProjectHandoffBlock(input: {
  daemon: DaemonStatus;
  enhancementRoute: CodexEnhancementRouteChoice;
  hostProjectAlignment: CodexHostProjectAlignment;
  projectRoot: string;
  requirement: CodexEnhancementRequirement;
  tool: string;
}): Record<string, unknown> | null {
  const state = input.hostProjectAlignment.connectionState;
  const blocksDashboard = input.requirement === 'dashboard' && state !== 'connected';
  const blocksWrongProjectStart = state === 'mismatch';
  if (!blocksDashboard && !blocksWrongProjectStart) {
    return null;
  }
  const errorCode =
    state === 'mismatch' ? 'CODEX_HOST_PROJECT_MISMATCH' : 'CODEX_HOST_PROJECT_DISCONNECTED';
  const message =
    state === 'mismatch'
      ? 'Codex host project differs from the Alembic selected or active project. Switch the Alembic project from Alembic or Dashboard if you use them — or work on this project directly from Codex with the local host-agent workflow (alembic_bootstrap / alembic_rescan), which runs in-plugin and does not start or retarget the shared Alembic runtime.'
      : 'Codex host project is not connected to an active Alembic runtime project. Start or reconnect it from Alembic or Dashboard before opening Dashboard from Codex. Local knowledge workflows (alembic_bootstrap / alembic_rescan) still work from Codex without the daemon.';

  // 只在阻断分支上探测知识状态（热路径返回 null 不读文件系统）。
  const knowledge = inspectCodexKnowledge(input.projectRoot);
  const localWorkflowAction = knowledge.usable
    ? buildCodexRecommendedAction({
        label: 'Refresh this project locally (no daemon)',
        reason:
          'alembic_rescan preserves reviewed Recipes and refreshes knowledge for the Codex host project only; it does not touch the shared Alembic runtime selection.',
        startsDaemon: false,
        tool: 'alembic_rescan',
      })
    : buildCodexRecommendedAction({
        label: 'Bootstrap this project locally (no daemon)',
        reason:
          'alembic_bootstrap builds project knowledge for the Codex host project only; it does not touch the shared Alembic runtime selection.',
        startsDaemon: false,
        tool: 'alembic_bootstrap',
      });

  return failureResult(input.tool, message, {
    daemon: summarizeCodexDaemonStatus(input.daemon),
    enhancementRoute: input.enhancementRoute,
    errorCode,
    hostProjectAlignment: input.hostProjectAlignment,
    needsUserInput: true,
    nextActions: [
      localWorkflowAction,
      buildCodexRecommendedAction({
        label: 'Check workspace status',
        reason: 'Inspect host, selected, and active runtime project alignment.',
        startsDaemon: false,
        tool: 'alembic_codex_status',
      }),
      buildCodexRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Show plugin runtime diagnostics and host project handoff mismatch details.',
        startsDaemon: false,
        tool: 'alembic_codex_diagnostics',
      }),
    ],
  });
}
