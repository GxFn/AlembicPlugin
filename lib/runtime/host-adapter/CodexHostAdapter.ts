import { join } from 'node:path';
import {
  getInitMarkerPath,
  type InitMarker,
  type ProjectRootResolution,
  type ResolveProjectRootOptions,
  readInitMarker as readInitMarkerImpl,
  readSavedProjectRoot as readSavedProjectRootImpl,
  resolveProjectRootFromEnv,
  type SavedProjectRoot,
  writeInitMarker as writeInitMarkerImpl,
  writeSavedProjectRoot as writeSavedProjectRootImpl,
} from '../ProjectRootResolver.js';
import {
  CODEX_PLUGIN_HOST,
  CODEX_SETUP_PROFILE,
  ensureRuntimeEnvironment as ensureRuntimeEnvironmentImpl,
  type HostRuntimeContext,
  resolveHostRuntimeContext,
} from '../runtime/RuntimeContext.js';
import type { HostAdapter, HostInitMarkerInput } from './HostAdapter.js';

/**
 * CodexHostAdapter（DH-2 / RC-2 / DH-3g）—— HostAdapter 的 codex 实现。工作区身份簇方法
 * 【委托】L1 的 host-agnostic 共享实现（project-root 解析 / init-marker / saved-root I/O /
 * runtime-env）：这些函数 shape-aware、函数体零 host-name 分支，cc/codex 共享同一份——委托是
 * 合法 L3→L1 分层（非待清 facade；DH-3g 据 Design 裁决否决物理迁入、并对该簇 de-Codex 去前缀）。
 * 本 adapter 真正的 codex 专属面仅：hostId / allowsEmptyPluginAssets / setupProfile / 清单路径 /
 * arg 归一。host-aware 选择见 resolveHostAdapter.ts（DH-3①）。本类不引入常驻进程（守纯 MCP 非强进程不变量）。
 */
export class CodexHostAdapter implements HostAdapter {
  readonly hostId = CODEX_PLUGIN_HOST;
  readonly setupProfile = CODEX_SETUP_PROFILE;
  // codex shell 的 manifest 要求 marketplace interface 资产，空资产非健康。
  readonly allowsEmptyPluginAssets = false;

  ensureRuntimeEnvironment(env?: NodeJS.ProcessEnv): void {
    ensureRuntimeEnvironmentImpl(env);
  }

  resolveRuntimeContext(env?: NodeJS.ProcessEnv): HostRuntimeContext {
    return resolveHostRuntimeContext(env);
  }

  resolveProjectRoot(options?: ResolveProjectRootOptions): ProjectRootResolution {
    return resolveProjectRootFromEnv(options);
  }

  readSavedProjectRoot(env?: NodeJS.ProcessEnv): SavedProjectRoot | null {
    return readSavedProjectRootImpl(env);
  }

  writeSavedProjectRoot(projectRoot: string, env?: NodeJS.ProcessEnv): SavedProjectRoot {
    return writeSavedProjectRootImpl(projectRoot, env);
  }

  readInitMarker(projectRoot: string): InitMarker | null {
    return readInitMarkerImpl(projectRoot);
  }

  writeInitMarker(projectRoot: string, input: HostInitMarkerInput): InitMarker {
    return writeInitMarkerImpl(projectRoot, input);
  }

  initMarkerPath(projectRoot: string): string {
    return getInitMarkerPath(projectRoot);
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
