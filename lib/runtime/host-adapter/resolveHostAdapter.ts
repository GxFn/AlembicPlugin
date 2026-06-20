import { CLAUDE_CODE_PLUGIN_HOST, resolveHostRuntimeContext } from '../runtime/RuntimeContext.js';
import { CLAUDE_CODE_HOST_ADAPTER } from './ClaudeCodeHostAdapter.js';
import { CODEX_HOST_ADAPTER } from './CodexHostAdapter.js';
import type { HostAdapter } from './HostAdapter.js';

/**
 * resolveHostAdapter（DH-3① / RC-2/3）—— L3 host-aware 选择工厂。**这是 5 层架构里唯一允许
 * host-name 分支的地方**：按物理 shell 形态选 codex / claude-code adapter。形态经
 * resolveHostRuntimeContext().expectedPluginHost 体现（该值由 detectPluginHostShape 从 shell
 * 派生，DH-1；不依赖 env，故在 ensureRuntimeEnvironment 之前调用也正确）。
 *
 * codex shell 恒选 CodexHostAdapter（行为逐行不变）；cc shell 选 ClaudeCodeHostAdapter（cc 自认
 * claude-code、cc 工作区可信）。上层（bin / HostMcpServer / 后续 L2）只经此工厂取 adapter，
 * 不再自带 host 分支。
 */
export function resolveHostAdapter(env: NodeJS.ProcessEnv = process.env): HostAdapter {
  const expectedHost = resolveHostRuntimeContext(env).expectedPluginHost;
  return expectedHost === CLAUDE_CODE_PLUGIN_HOST ? CLAUDE_CODE_HOST_ADAPTER : CODEX_HOST_ADAPTER;
}

/**
 * hostAdapterForShape（DH-3b / RC-3）—— 当调用方已持有物理 shell 形态（如诊断里的
 * registry.plugin.hostShape）时按形态直接选 adapter。与 resolveHostAdapter 同属 L3 唯一
 * host-name 分支：让上层经此取 adapter 能力、不再在 L2/诊断层自带 hostShape 分支。
 */
export function hostAdapterForShape(hostShape: 'codex' | 'claude-code'): HostAdapter {
  return hostShape === 'claude-code' ? CLAUDE_CODE_HOST_ADAPTER : CODEX_HOST_ADAPTER;
}
