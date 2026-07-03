/**
 * Plugin 本地 project-index 编排入口。
 *
 * 保留 Codex host-agent 与 Alembic in-process 宿主分裂，只在插件本地把
 * full/incremental 模式选择显式化。
 */

import type { GenerateInput, RescanInput } from '#shared/schemas/mcp-tools.js';
import { runHostAgentGenerateFullWorkflow } from './cold-start.js';
import { runHostAgentGenerateIncrementalWorkflow } from './knowledge-rescan.js';

export { getActiveSession } from './cold-start.js';

export type HostAgentGenerateMode = 'full' | 'incremental';

export interface HostAgentGenerateOptions {
  mode: HostAgentGenerateMode;
}

type FullContext = Parameters<typeof runHostAgentGenerateFullWorkflow>[0];
type IncrementalContext = Parameters<typeof runHostAgentGenerateIncrementalWorkflow>[0];

export function runGenerateWorkflow(
  ctx: FullContext,
  args: GenerateInput | undefined,
  options: { mode: 'full' }
): ReturnType<typeof runHostAgentGenerateFullWorkflow>;
export function runGenerateWorkflow(
  ctx: IncrementalContext,
  args: RescanInput,
  options: { mode: 'incremental' }
): ReturnType<typeof runHostAgentGenerateIncrementalWorkflow>;
export function runGenerateWorkflow(
  ctx: FullContext | IncrementalContext,
  args: GenerateInput | RescanInput | undefined,
  options: HostAgentGenerateOptions
) {
  if (options.mode === 'full') {
    return runHostAgentGenerateFullWorkflow(ctx as FullContext, args as GenerateInput);
  }
  return runHostAgentGenerateIncrementalWorkflow(ctx as IncrementalContext, args as RescanInput);
}

export function runHostAgentColdStartWorkflow(ctx: FullContext, args?: GenerateInput) {
  return runGenerateWorkflow(ctx, args, { mode: 'full' });
}

export function runHostAgentKnowledgeRescanWorkflow(ctx: IncrementalContext, args: RescanInput) {
  return runGenerateWorkflow(ctx, args, { mode: 'incremental' });
}
