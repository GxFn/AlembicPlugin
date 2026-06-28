/**
 * Plugin 本地 project-index 编排入口。
 *
 * 保留 Codex host-agent 与 Alembic in-process 宿主分裂，只在插件本地把
 * full/incremental 模式选择显式化。
 */

import type { BootstrapInput, RescanInput } from '#shared/schemas/mcp-tools.js';
import { runHostAgentProjectIndexFullWorkflow } from './cold-start.js';
import { runHostAgentProjectIndexIncrementalWorkflow } from './knowledge-rescan.js';

export { getActiveSession } from './cold-start.js';

export type HostAgentProjectIndexMode = 'full' | 'incremental';

export interface HostAgentProjectIndexOptions {
  mode: HostAgentProjectIndexMode;
}

type FullContext = Parameters<typeof runHostAgentProjectIndexFullWorkflow>[0];
type IncrementalContext = Parameters<typeof runHostAgentProjectIndexIncrementalWorkflow>[0];

export function runProjectIndexWorkflow(
  ctx: FullContext,
  args: BootstrapInput | undefined,
  options: { mode: 'full' }
): ReturnType<typeof runHostAgentProjectIndexFullWorkflow>;
export function runProjectIndexWorkflow(
  ctx: IncrementalContext,
  args: RescanInput,
  options: { mode: 'incremental' }
): ReturnType<typeof runHostAgentProjectIndexIncrementalWorkflow>;
export function runProjectIndexWorkflow(
  ctx: FullContext | IncrementalContext,
  args: BootstrapInput | RescanInput | undefined,
  options: HostAgentProjectIndexOptions
) {
  if (options.mode === 'full') {
    return runHostAgentProjectIndexFullWorkflow(ctx as FullContext, args as BootstrapInput);
  }
  return runHostAgentProjectIndexIncrementalWorkflow(
    ctx as IncrementalContext,
    args as RescanInput
  );
}

export function runHostAgentColdStartWorkflow(ctx: FullContext, args?: BootstrapInput) {
  return runProjectIndexWorkflow(ctx, args, { mode: 'full' });
}

export function runHostAgentKnowledgeRescanWorkflow(ctx: IncrementalContext, args: RescanInput) {
  return runProjectIndexWorkflow(ctx, args, { mode: 'incremental' });
}
