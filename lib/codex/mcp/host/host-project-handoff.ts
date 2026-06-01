import type { DaemonStatus } from '../../../daemon/DaemonSupervisor.js';
import {
  buildCodexRecommendedAction,
  type CodexEnhancementRequirement,
  type CodexEnhancementRouteChoice,
  type CodexHostProjectAlignment,
  summarizeCodexDaemonStatus,
} from '../../index.js';
import { failureResult } from './results.js';

// Dashboard / job handoff 前先校验 Codex host project 与 Alembic runtime 项目关系。
export function buildCodexHostProjectHandoffBlock(input: {
  daemon: DaemonStatus;
  enhancementRoute: CodexEnhancementRouteChoice;
  hostProjectAlignment: CodexHostProjectAlignment;
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
      ? 'Codex host project differs from the Alembic selected or active project. Switch the Alembic project from Alembic or Dashboard before retrying from Codex.'
      : 'Codex host project is not connected to an active Alembic runtime project. Start or reconnect it from Alembic or Dashboard before opening Dashboard from Codex.';

  return failureResult(input.tool, message, {
    daemon: summarizeCodexDaemonStatus(input.daemon),
    enhancementRoute: input.enhancementRoute,
    errorCode,
    hostProjectAlignment: input.hostProjectAlignment,
    needsUserInput: true,
    nextActions: [
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
