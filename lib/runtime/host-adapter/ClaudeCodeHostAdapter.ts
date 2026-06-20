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
  CLAUDE_CODE_PLUGIN_HOST,
  CODEX_SETUP_PROFILE,
  ensureCodexRuntimeEnvironment,
  type HostRuntimeContext,
  resolveEffectiveCodexTier,
  resolveHostRuntimeContext,
} from '../runtime/RuntimeContext.js';
import type { HostAdapter, HostInitMarkerInput } from './HostAdapter.js';

/**
 * ClaudeCodeHostAdapter（DH-3① / RC-2/3）—— HostAdapter 的 claude-code 实现。
 *
 * 现态（DH-0 ② 8 簇矩阵）：cc 与 codex 的「工作区身份簇」绝大部分共享 host-agnostic 实现
 * （文件 I/O / 持久化），且 identity 已由物理 shell 形态派生（DH-1：cc shell→claude-code）。
 * 故本 adapter 的身份簇方法委托同一组 shape/env-aware 函数——在 cc shell 上即产出 cc 行为；
 * 真正的 cc 专属差异在 ①：hostId=claude-code + 项目根信任 CLAUDE_PROJECT_DIR（cc 工作区不再
 * fail-closed，见 ProjectRootResolver）+ 由 resolveHostAdapter 按 shell 形态选中本实现。
 *
 * 留待 DH-3b / DH-4（已 flag）：cluster 5（静态 tool list）/6（无 host introspection→自生成）/8
 * （无 turn-meta）的 cc 优雅降级细化；cc 专属 setupProfile（现复用 codex-plugin，因 init-marker
 * profile 字段类型与 SetupService profile 锁定，属 per-host 产物）；物理迁入函数体 + de-Codex
 * 改名。本类不引入常驻进程（守纯 MCP 非强进程不变量）。
 */
export class ClaudeCodeHostAdapter implements HostAdapter {
  readonly hostId = CLAUDE_CODE_PLUGIN_HOST;
  // cc 专属 setupProfile 属 per-host 产物（DH-4）；① 暂复用 codex-plugin（init-marker 的
  // profile 字段类型锁定 typeof CODEX_SETUP_PROFILE，独立 cc profile 需同步 SetupService）。
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

// 进程内复用一个 cc 实例。host-aware 选择见 resolveHostAdapter.ts（L3 唯一 host-name 分支）。
export const CLAUDE_CODE_HOST_ADAPTER: HostAdapter = new ClaudeCodeHostAdapter();
