import type {
  CodexInitMarker,
  CodexProjectRootResolution,
  CodexSavedProjectRoot,
  ResolveCodexProjectRootOptions,
} from '../ProjectRootResolver.js';
import type { HostRuntimeContext } from '../runtime/RuntimeContext.js';

/**
 * HostInitMarkerInput —— init-marker 写入的业务入参。系统字段（dataRoot / ghost /
 * initializedAt / pluginVersion / profile / projectRoot / schemaVersion）由实现按宿主
 * 工作区解析后填充，调用方只提供 initializedBy / route / results / requestedTool。
 */
export type HostInitMarkerInput = Omit<
  CodexInitMarker,
  | 'dataRoot'
  | 'ghost'
  | 'initializedAt'
  | 'pluginVersion'
  | 'profile'
  | 'projectRoot'
  | 'schemaVersion'
>;

/**
 * L3 HostAdapter（DH-2 / RC-2）—— host-agnostic 契约，集中宿主特定的「工作区身份」操作：
 * 运行时 env/身份派生、项目根解析与信任、saved-root / init-marker 持久化、setup profile
 * 标识。这是 5 层架构里 L3 层的接口：host-name 分支只允许落在本层的各 host 实现内
 * （依赖单向 L4→L3→L2→L1→L0），上层经契约消费、不再直依赖具体 Codex* 实现。
 *
 * DH-2 边界（本阶段只建接口 + codex 实现，先对齐现状、不改行为）。以下属 DH-3/DH-4：
 *  - 新建 claude-code adapter（补 transport / init-profile / 项目根发现 / env / tier /
 *    diagnostics / JobStore / execution 8 簇）+ host-aware 选择（按 hostShape 二选一）；
 *  - L2（HostMcpServer / McpServer）全面改调 L3 + ~52 处误命名 de-Codex 归 L1/L2；
 *  - 诊断 / status / host-project-alignment 等簇的剩余 call site 改调（与 de-Codex 改名同
 *    批，避免双重 churn 与回归风险）。
 *
 * 注：本接口刻意只覆盖「真 host-specific」的工作区身份簇。MCP server 生命周期
 * （start/shutdown/handleToolCall）、tool execution context、workspace init 编排在现实
 * 代码里是 host-agnostic（codex / claude-code 同走 stdio + 同一 MCP SDK），按 DH-0 测绘
 * 属「误命名 host-agnostic」，不纳入 L3——它们消费本契约的产物（HostRuntimeContext /
 * projectRoot），而非本契约本身。
 */
export interface HostAdapter {
  /** 本 adapter 服务的宿主标识（codex / claude-code）。 */
  readonly hostId: string;
  /** init-marker 等元数据写入的 setup profile 标识。 */
  readonly setupProfile: string;

  // —— 运行时 env / 身份 ——
  /** 设置插件运行时 env 默认（runtime mode、host 标识按物理 shell 形态派生、MCP 模式/tier）。 */
  ensureRuntimeEnvironment(env?: NodeJS.ProcessEnv): void;
  /** 由 env + 物理 shell 形态解析 HostRuntimeContext（pluginHost / expectedPluginHost 等）。 */
  resolveRuntimeContext(env?: NodeJS.ProcessEnv): HostRuntimeContext;
  /** 解析有效 MCP tier（admin 未启用时回退默认 tier）。 */
  resolveEffectiveTier(tierName: string, adminEnabled: boolean): string;

  // —— 项目根解析 / 信任 ——
  /** 从宿主 env 源（ALEMBIC_PROJECT_DIR / 工作区 env / cwd 回退）解析并校验项目根。 */
  resolveProjectRoot(options?: ResolveCodexProjectRootOptions): CodexProjectRootResolution;
  /** 项目根是否可信（存在 + trusted + 未拒绝），用于门控工具执行。 */
  isTrustedProjectRoot(resolution: CodexProjectRootResolution): boolean;

  // —— saved-root / init-marker 持久化 ——
  /** 读取 saved project root 标记（诊断 / 恢复用，非有效身份来源）。 */
  readSavedProjectRoot(env?: NodeJS.ProcessEnv): CodexSavedProjectRoot | null;
  /** 持久化 saved project root 标记。 */
  writeSavedProjectRoot(projectRoot: string, env?: NodeJS.ProcessEnv): CodexSavedProjectRoot;
  /** 读取 per-project init marker（status 报告初始化状态）。 */
  readInitMarker(projectRoot: string): CodexInitMarker | null;
  /** 工作区初始化成功后写入 init marker（系统字段由实现填充）。 */
  writeInitMarker(projectRoot: string, input: HostInitMarkerInput): CodexInitMarker;
}
