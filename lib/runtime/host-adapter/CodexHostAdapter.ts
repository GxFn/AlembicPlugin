import {
  type CodexInitMarker,
  type CodexProjectRootResolution,
  type CodexSavedProjectRoot,
  isTrustedCodexProjectRoot,
  type ResolveCodexProjectRootOptions,
  readCodexInitMarker,
  readCodexSavedProjectRoot,
  resolveCodexProjectRoot,
  writeCodexInitMarker,
  writeCodexSavedProjectRoot,
} from '../ProjectRootResolver.js';
import {
  CODEX_PLUGIN_HOST,
  CODEX_SETUP_PROFILE,
  ensureCodexRuntimeEnvironment,
  type HostRuntimeContext,
  resolveEffectiveCodexTier,
  resolveHostRuntimeContext,
} from '../runtime/RuntimeContext.js';
import type { HostAdapter, HostInitMarkerInput } from './HostAdapter.js';

/**
 * CodexHostAdapter（DH-2 / RC-2）—— HostAdapter 的 codex 实现。每个方法【逐行委托】现有
 * host-specific 函数，行为与改动前完全一致（先对齐现状、不改行为）。被委托的函数暂留原处
 * 作为 codex 实现；DH-3 再物理迁入 / 去 Codex 前缀，并新建 ClaudeCodeHostAdapter + 按
 * hostShape 选择。本类不引入常驻进程（守 daemon-removal 纯 MCP 非强进程不变量）。
 */
class CodexHostAdapter implements HostAdapter {
  readonly hostId = CODEX_PLUGIN_HOST;
  readonly setupProfile = CODEX_SETUP_PROFILE;

  ensureRuntimeEnvironment(env?: NodeJS.ProcessEnv): void {
    ensureCodexRuntimeEnvironment(env);
  }

  resolveRuntimeContext(env?: NodeJS.ProcessEnv): HostRuntimeContext {
    return resolveHostRuntimeContext(env);
  }

  resolveEffectiveTier(tierName: string, adminEnabled: boolean): string {
    return resolveEffectiveCodexTier(tierName, adminEnabled);
  }

  resolveProjectRoot(options?: ResolveCodexProjectRootOptions): CodexProjectRootResolution {
    return resolveCodexProjectRoot(options);
  }

  isTrustedProjectRoot(resolution: CodexProjectRootResolution): boolean {
    return isTrustedCodexProjectRoot(resolution);
  }

  readSavedProjectRoot(env?: NodeJS.ProcessEnv): CodexSavedProjectRoot | null {
    return readCodexSavedProjectRoot(env);
  }

  writeSavedProjectRoot(projectRoot: string, env?: NodeJS.ProcessEnv): CodexSavedProjectRoot {
    return writeCodexSavedProjectRoot(projectRoot, env);
  }

  readInitMarker(projectRoot: string): CodexInitMarker | null {
    return readCodexInitMarker(projectRoot);
  }

  writeInitMarker(projectRoot: string, input: HostInitMarkerInput): CodexInitMarker {
    return writeCodexInitMarker(projectRoot, input);
  }
}

// DH-2 仅 codex 单实现；进程内复用一个实例。DH-3 在此按物理 shell 形态（codex /
// claude-code）选择对应 adapter（host-aware 选择属 DH-3，不在本阶段）。
const CODEX_HOST_ADAPTER: HostAdapter = new CodexHostAdapter();

/**
 * 解析当前进程应使用的 HostAdapter。DH-2 恒返回 CodexHostAdapter（单宿主）；DH-3 起按
 * 物理 shell 形态返回 codex / claude-code 实现。
 */
export function resolveHostAdapter(): HostAdapter {
  return CODEX_HOST_ADAPTER;
}

export { CodexHostAdapter };
