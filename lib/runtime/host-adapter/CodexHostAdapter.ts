import { join } from 'node:path';
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
 * 作为 codex 实现；物理迁入 / 去 Codex 前缀留 DH-3③；host-aware 选择（codex / claude-code）
 * 见 resolveHostAdapter.ts（DH-3①）。本类不引入常驻进程（守纯 MCP 非强进程不变量）。
 */
export class CodexHostAdapter implements HostAdapter {
  readonly hostId = CODEX_PLUGIN_HOST;
  readonly setupProfile = CODEX_SETUP_PROFILE;
  // codex shell 的 manifest 要求 marketplace interface 资产，空资产非健康。
  readonly allowsEmptyPluginAssets = false;

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

  pluginMcpManifestPath(pluginRoot: string): string {
    return join(pluginRoot, '.mcp.json');
  }

  pluginManifestPath(pluginRoot: string): string {
    return join(pluginRoot, '.codex-plugin', 'plugin.json');
  }

  normalizePluginMcpArg(arg: string): string {
    return arg;
  }
}

// 进程内复用一个 codex 实例。host-aware 选择见 resolveHostAdapter.ts（L3 唯一 host-name 分支）。
export const CODEX_HOST_ADAPTER: HostAdapter = new CodexHostAdapter();
