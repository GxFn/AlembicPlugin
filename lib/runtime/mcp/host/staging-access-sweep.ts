import type { McpServiceContainer } from '../handlers/types.js';

const DEFAULT_MIN_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export const STAGING_ACCESS_SWEEP_TOOL_NAMES = new Set([
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
  'alembic_status',
  'alembic_rescan',
]);

interface StagingManagerLike {
  checkAndPromote(): Promise<{
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
    const result = await stagingManager.checkAndPromote();
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
