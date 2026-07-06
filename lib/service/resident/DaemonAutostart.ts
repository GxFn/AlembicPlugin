/**
 * DaemonAutostart — resident daemon 的 ensure-on-use 自启（X2 方案 A 第一块）。
 *
 * 背景（2026-07-06 五 MCP 升级设计）：
 *   插件 MCP 的 resident 增强（语义检索/向量/进化 sweep）依赖 Alembic 主体的
 *   daemon 常驻进程。daemon 入口 dist/bin/daemon-server.js 属于主体仓构建产物，
 *   runtime 包（@gxfn/alembic-runtime = 插件仓 dist + @alembic/core）不携带它，
 *   因此存在三种形态：
 *     形态 1「主体在场」— daemon 曾运行过并在 daemon.json 自注册了 entrypoint/execPath
 *       （主体 bin/daemon-server.ts 写入），本模块可按同款入口+同款 Node 重新拉起；
 *     形态 2「仅插件」— 无主体安装、无历史 daemon.json 入口 → 显式 unavailable，
 *       resident 增强诚实降级（不是错误）；
 *     形态 3「主体在但 daemon 死」— health 探测失败 → 自动重拉（崩溃自愈）。
 *
 * 边界：
 *   - 只负责"拉起"，不负责杀死/替换在跑的 daemon（那是用户/主体 CLI 的职责）；
 *   - env ALEMBIC_DAEMON_AUTOSTART=0 显式关闭（自动化/CI 场景）；
 *   - 冷却窗（默认 60s）防止每次工具调用都重复 spawn 失败路径；
 *   - 全分支留痕日志：触发条件/选择路径/结果状态，供事后核验。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  type DaemonEntrypointRegistry,
  type DaemonState,
  readDaemonEntrypointRegistry,
  readDaemonState,
  resolveDaemonPaths,
} from '@alembic/core/daemon';

export type DaemonAutostartStatus =
  | 'already-running'
  | 'started'
  | 'unavailable'
  | 'cooldown'
  | 'spawn-timeout'
  | 'spawn-failed'
  | 'disabled';

export interface DaemonAutostartResult {
  status: DaemonAutostartStatus;
  /** 人读原因（unavailable/spawn-failed 等分支必填） */
  reason?: string;
  /** 实际使用（或解析失败时为 null）的 daemon 入口脚本绝对路径 */
  entrypoint?: string | null;
  /** 拉起后（或已在跑的）daemon pid；不可得时为 null */
  pid?: number | null;
  /** started/spawn-timeout 分支等待就绪消耗的毫秒数 */
  waitedMs?: number;
}

interface AutostartLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface EnsureResidentDaemonOptions {
  projectRoot: string;
  logger?: AutostartLogger;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：读取 daemon.json 状态 */
  readState?: (projectRoot: string) => DaemonState | null;
  /** 测试注入：读取入口注册表（daemon-entrypoint.json，优雅退出后仍在的"最后已知入口"） */
  readEntrypointRegistry?: (projectRoot: string) => DaemonEntrypointRegistry | null;
  /** 测试注入：health 探测（默认 fetch state.url 的无认证 health 端点） */
  probeHealth?: (state: DaemonState) => Promise<boolean>;
  /** 测试注入：spawn 实现 */
  spawnImpl?: typeof spawn;
  /** 测试注入：文件存在性 */
  existsImpl?: (path: string) => boolean;
  /** 测试注入：当前时钟（冷却窗判定） */
  nowImpl?: () => number;
  /** 测试注入：睡眠 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 拉起后等待就绪的总预算（默认 8000ms） */
  waitBudgetMs?: number;
}

/** health 端点刻意无认证（KB: @health-endpoint-no-auth），探测不带 token。 */
const HEALTH_PATH = '/api/v1/daemon/health';
const HEALTH_TIMEOUT_MS = 1500;
// 真机实测（2026-07-06）：daemon 完整就绪（含 dashboard mount + UiStartupTasks）约 8.1s，
// 8s 预算贴线——留 50% 余量取 12s。
const DEFAULT_WAIT_BUDGET_MS = 12_000;
const WAIT_STEP_MS = 400;
const COOLDOWN_MS = 60_000;

/** 冷却表：projectRoot → 上次 spawn 尝试时刻。模块级，随 MCP 进程生命周期存续。 */
const lastAttemptByRoot = new Map<string, number>();

/** 测试助手：清空冷却表（生产代码不得调用）。 */
export function __clearDaemonAutostartCooldownForTests(): void {
  lastAttemptByRoot.clear();
}

async function defaultProbeHealth(state: DaemonState): Promise<boolean> {
  if (!state.url) {
    return false;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${state.url}${HEALTH_PATH}`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function defaultReadState(projectRoot: string): DaemonState | null {
  const paths = resolveDaemonPaths(projectRoot);
  return readDaemonState(paths.statePath);
}

function defaultReadEntrypointRegistry(projectRoot: string): DaemonEntrypointRegistry | null {
  const paths = resolveDaemonPaths(projectRoot);
  return readDaemonEntrypointRegistry(paths.runtimeDir);
}

/**
 * 解析 daemon 入口：env 显式指定 > daemon.json 自注册（在跑/崩溃残留）>
 * 入口注册表 daemon-entrypoint.json（优雅退出后 daemon.json 被清理时的 fallback）。
 * 三者都不可用 → null（形态 2「仅插件」或从未跑过 daemon 的形态 1 首次）。
 */
function resolveEntrypoint(
  env: NodeJS.ProcessEnv,
  state: DaemonState | null,
  registry: DaemonEntrypointRegistry | null,
  existsImpl: (path: string) => boolean
): { entrypoint: string | null; execPath: string; source: string } {
  const envEntry = env.ALEMBIC_DAEMON_ENTRYPOINT;
  if (envEntry && existsImpl(envEntry)) {
    return {
      entrypoint: envEntry,
      execPath: resolveExecPath(env, state, registry, existsImpl),
      source: 'env',
    };
  }
  const stateEntry = state?.entrypoint;
  if (stateEntry && existsImpl(stateEntry)) {
    return {
      entrypoint: stateEntry,
      execPath: resolveExecPath(env, state, registry, existsImpl),
      source: 'daemon-state',
    };
  }
  const registryEntry = registry?.entrypoint;
  if (registryEntry && existsImpl(registryEntry)) {
    return {
      entrypoint: registryEntry,
      execPath: resolveExecPath(env, state, registry, existsImpl),
      source: 'entrypoint-registry',
    };
  }
  return { entrypoint: null, execPath: process.execPath, source: 'none' };
}

function resolveExecPath(
  env: NodeJS.ProcessEnv,
  state: DaemonState | null,
  registry: DaemonEntrypointRegistry | null,
  existsImpl: (path: string) => boolean
): string {
  const envExec = env.ALEMBIC_DAEMON_EXEC_PATH;
  if (envExec && existsImpl(envExec)) {
    return envExec;
  }
  // nvm/多版本场景 PATH 不可靠：优先复用上次 daemon 自注册的 Node 绝对路径。
  const stateExec = state?.execPath;
  if (stateExec && existsImpl(stateExec)) {
    return stateExec;
  }
  const registryExec = registry?.execPath;
  if (registryExec && existsImpl(registryExec)) {
    return registryExec;
  }
  return process.execPath;
}

/**
 * 确保 resident daemon 在跑：健康即返回；死了且有已知入口则 detached 拉起并等就绪。
 * 绝不抛出——所有失败路径都收敛为结构化结果 + 日志（resident 增强是可降级能力）。
 */
export async function ensureResidentDaemonRunning(
  options: EnsureResidentDaemonOptions
): Promise<DaemonAutostartResult> {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const readState = options.readState ?? defaultReadState;
  const readRegistry = options.readEntrypointRegistry ?? defaultReadEntrypointRegistry;
  const probeHealth = options.probeHealth ?? defaultProbeHealth;
  const spawnImpl = options.spawnImpl ?? spawn;
  const existsImpl = options.existsImpl ?? existsSync;
  const now = options.nowImpl ?? Date.now;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const waitBudgetMs = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS;

  if (env.ALEMBIC_DAEMON_AUTOSTART === '0') {
    return { status: 'disabled', reason: 'ALEMBIC_DAEMON_AUTOSTART=0' };
  }

  const state = readState(options.projectRoot);
  if (state && (await probeHealth(state))) {
    return { status: 'already-running', pid: state.pid ?? null, entrypoint: state.entrypoint ?? null };
  }

  const registry = readRegistry(options.projectRoot);
  const resolved = resolveEntrypoint(env, state, registry, existsImpl);
  if (!resolved.entrypoint) {
    // 形态 2「仅插件」/首次：没有可用入口——诚实降级，不视为错误。
    logger?.info('[DaemonAutostart] resident daemon unavailable: no known entrypoint', {
      projectRoot: options.projectRoot,
      hasStaleState: Boolean(state),
      hasEntrypointRegistry: Boolean(registry),
      reason: 'no-daemon-entrypoint',
    });
    return {
      status: 'unavailable',
      reason:
        'No daemon entrypoint is known (set ALEMBIC_DAEMON_ENTRYPOINT, or run the Alembic main-package daemon once so it self-registers its entrypoint).',
      entrypoint: null,
    };
  }

  const lastAttempt = lastAttemptByRoot.get(options.projectRoot);
  if (lastAttempt !== undefined && now() - lastAttempt < COOLDOWN_MS) {
    return {
      status: 'cooldown',
      reason: `last spawn attempt ${now() - lastAttempt}ms ago (< ${COOLDOWN_MS}ms)`,
      entrypoint: resolved.entrypoint,
    };
  }
  lastAttemptByRoot.set(options.projectRoot, now());

  logger?.info('[DaemonAutostart] spawning resident daemon', {
    entrypoint: resolved.entrypoint,
    entrypointSource: resolved.source,
    execPath: resolved.execPath,
    projectRoot: options.projectRoot,
    staleStatePid: state?.pid ?? null,
  });

  try {
    const child = spawnImpl(resolved.execPath, [resolved.entrypoint], {
      cwd: options.projectRoot,
      detached: true,
      env: { ...env, ALEMBIC_PROJECT_DIR: options.projectRoot },
      stdio: 'ignore',
    });
    child.unref();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn('[DaemonAutostart] spawn failed', {
      entrypoint: resolved.entrypoint,
      error: message,
      projectRoot: options.projectRoot,
    });
    return { status: 'spawn-failed', reason: message, entrypoint: resolved.entrypoint };
  }

  // 等待新 daemon 写回 daemon.json 并通过 health：以 startedAt 变化或 health 通过为就绪判据。
  const startWait = now();
  const previousStartedAt = state?.startedAt ?? null;
  while (now() - startWait < waitBudgetMs) {
    await sleep(WAIT_STEP_MS);
    const fresh = readState(options.projectRoot);
    if (!fresh) {
      continue;
    }
    const isNewInstance = previousStartedAt === null || fresh.startedAt !== previousStartedAt;
    if (isNewInstance && (await probeHealth(fresh))) {
      const waitedMs = now() - startWait;
      logger?.info('[DaemonAutostart] resident daemon started', {
        pid: fresh.pid,
        projectRoot: options.projectRoot,
        url: fresh.url,
        waitedMs,
      });
      return {
        status: 'started',
        pid: fresh.pid ?? null,
        entrypoint: resolved.entrypoint,
        waitedMs,
      };
    }
  }

  const waitedMs = now() - startWait;
  logger?.warn('[DaemonAutostart] daemon did not become healthy within budget', {
    projectRoot: options.projectRoot,
    waitBudgetMs,
    waitedMs,
  });
  return { status: 'spawn-timeout', reason: `not healthy after ${waitedMs}ms`, entrypoint: resolved.entrypoint, waitedMs };
}
