import type { McpServiceContainer } from '../handlers/types.js';

const DEFAULT_MIN_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 2_000;
// P1 有界化：单次 staging access sweep 的默认晋级上限（cap）。删 daemon 后 sweep 由
// tick-on-access 驱动，一次大冷扫可能含远超该值的到期项；cap 让单次只晋级 ≤cap 条、
// 跨多次工具调用排空，避免单 tick 长时间占用。可经 ALEMBIC_STAGING_ACCESS_SWEEP_CAP 覆盖。
const DEFAULT_STAGING_ACCESS_SWEEP_CAP = 50;

export const STAGING_ACCESS_SWEEP_TOOL_NAMES = new Set([
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
  'alembic_status',
  'alembic_rescan',
]);

interface StagingManagerLike {
  // cap 可选，对齐 Core StagingManager.checkAndPromote(cap?: number) 新签名：
  // 不传=无界（今日字节一致行为），传=单次最多晋级 cap 条（Core 侧最旧优先、跨 tick 排空）。
  checkAndPromote(cap?: number): Promise<{
    promoted?: Array<{ id?: string; title?: string }>;
    rolledBack?: Array<{ id?: string; title?: string }>;
    waiting?: Array<{ id?: string; title?: string }>;
  }>;
}

interface LoggerLike {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

interface SweepState {
  inFlight: Promise<StagingAccessSweepResult> | null;
  lastStartedAt: number;
}

export interface StagingAccessSweepInput {
  getContainer(): Promise<McpServiceContainer>;
  logger?: LoggerLike | null;
  now?: number;
  projectRoot: string;
  toolName: string;
}

export interface StagingAccessSweepResult {
  durationMs?: number;
  promotedCount: number;
  promotedIds: string[];
  reason?: string;
  skipped: boolean;
  timedOut?: boolean;
  toolName: string;
  waitingCount: number;
}

const sweepStateByProjectRoot = new Map<string, SweepState>();

export async function maybeRunStagingAccessSweep(
  input: StagingAccessSweepInput
): Promise<StagingAccessSweepResult> {
  if (!STAGING_ACCESS_SWEEP_TOOL_NAMES.has(input.toolName)) {
    return skipped(input.toolName, 'tool-not-enabled');
  }

  const now = input.now ?? Date.now();
  const minIntervalMs = readDurationMs(
    'ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS',
    DEFAULT_MIN_INTERVAL_MS
  );
  const timeoutMs = readDurationMs('ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const state = resolveSweepState(input.projectRoot);

  if (state.inFlight) {
    return skipped(input.toolName, 'in-flight');
  }
  if (minIntervalMs > 0 && now - state.lastStartedAt < minIntervalMs) {
    return skipped(input.toolName, 'throttled');
  }

  state.lastStartedAt = now;
  const sweep = runSweep(input, now).finally(() => {
    state.inFlight = null;
  });
  state.inFlight = sweep;

  const result = await withTimeout(sweep, timeoutMs, input.toolName);
  if (!result.skipped || result.timedOut) {
    logSweepResult(input.logger, result, input.projectRoot);
  }
  return result;
}

export function resetStagingAccessSweepStateForTests(): void {
  sweepStateByProjectRoot.clear();
}

async function runSweep(
  input: StagingAccessSweepInput,
  startedAt: number
): Promise<StagingAccessSweepResult> {
  try {
    const container = await input.getContainer();
    const stagingManager = container.get('stagingManager') as StagingManagerLike;
    // P1 有界化：以共享 cap 上限调用 checkAndPromote，单次 sweep 只晋级 ≤cap 条。
    // 同一 resolveStagingAccessSweepCap() 将被 P2 checkTimeouts(cap) / P3 checkAndExecute(cap)
    // 复用；本次（P1）只接线 promote，不接线 P2/P3 的驱动。
    const cap = resolveStagingAccessSweepCap();
    const result = await stagingManager.checkAndPromote(cap);
    const promoted = Array.isArray(result.promoted) ? result.promoted : [];
    const waiting = Array.isArray(result.waiting) ? result.waiting : [];
    return {
      durationMs: Date.now() - startedAt,
      promotedCount: promoted.length,
      promotedIds: promoted.map((entry) => entry.id).filter(isString),
      skipped: false,
      toolName: input.toolName,
      waitingCount: waiting.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.warn?.('[StagingAccessSweep] tick-on-access sweep failed', {
      error: message,
      projectRoot: input.projectRoot,
      toolName: input.toolName,
    });
    return {
      durationMs: Date.now() - startedAt,
      promotedCount: 0,
      promotedIds: [],
      reason: message,
      skipped: true,
      toolName: input.toolName,
      waitingCount: 0,
    };
  }
}

function resolveSweepState(projectRoot: string): SweepState {
  const existing = sweepStateByProjectRoot.get(projectRoot);
  if (existing) {
    return existing;
  }
  const state: SweepState = { inFlight: null, lastStartedAt: 0 };
  sweepStateByProjectRoot.set(projectRoot, state);
  return state;
}

async function withTimeout(
  sweep: Promise<StagingAccessSweepResult>,
  timeoutMs: number,
  toolName: string
): Promise<StagingAccessSweepResult> {
  if (timeoutMs <= 0) {
    return sweep;
  }
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      sweep,
      new Promise<StagingAccessSweepResult>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              promotedCount: 0,
              promotedIds: [],
              reason: 'timeout',
              skipped: true,
              timedOut: true,
              toolName,
              waitingCount: 0,
            }),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function readDurationMs(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 解析单次 staging access sweep 的晋级上限（cap）；设计为共享 sweep 上限。
 *
 * 默认 DEFAULT_STAGING_ACCESS_SWEEP_CAP(50)，可经 ALEMBIC_STAGING_ACCESS_SWEEP_CAP
 * 覆盖（与 MIN_INTERVAL/TIMEOUT 同属 sweep env 家族）。守卫：仅接受有限正整数(>=1)，
 * 否则回退默认——避免两个 foot-gun：cap=0(晋级 0 条＝静默禁用 promote)、负值(传到
 * Core 的 SQL LIMIT 后＝无界，反破坏有界语义)；非整数向下取整（LIMIT 需整数）。
 * 导出以便 P2 checkTimeouts / P3 checkAndExecute 接线时复用同一上限与解析逻辑；
 * 本次（P1）只用于 promote，不接线 P2/P3 的驱动。
 */
export function resolveStagingAccessSweepCap(): number {
  const raw = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_CAP;
  if (!raw) {
    return DEFAULT_STAGING_ACCESS_SWEEP_CAP;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_STAGING_ACCESS_SWEEP_CAP;
  }
  return Math.floor(parsed);
}

function logSweepResult(
  logger: LoggerLike | null | undefined,
  result: StagingAccessSweepResult,
  projectRoot: string
): void {
  const meta = {
    durationMs: result.durationMs ?? null,
    projectRoot,
    promotedCount: result.promotedCount,
    promotedIds: result.promotedIds,
    reason: result.reason ?? null,
    timedOut: result.timedOut === true,
    toolName: result.toolName,
    waitingCount: result.waitingCount,
  };
  if (result.timedOut) {
    logger?.warn?.('[StagingAccessSweep] tick-on-access sweep timed out', meta);
    return;
  }
  logger?.info?.('[StagingAccessSweep] tick-on-access sweep completed', meta);
}

function skipped(toolName: string, reason: string): StagingAccessSweepResult {
  return {
    promotedCount: 0,
    promotedIds: [],
    reason,
    skipped: true,
    toolName,
    waitingCount: 0,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
