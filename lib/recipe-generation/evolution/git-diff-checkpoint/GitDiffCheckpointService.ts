import type { FileChangeEvent, FileChangeEventSource } from '@alembic/core/types';
import type { FileChangeDispatcher } from '../../../service/FileChangeDispatcher.js';
import type {
  GitDiffCheckpointError,
  GitDiffCheckpointStatus,
  GitDiffLastDispatchStatus,
} from './GitDiffCheckpointStatus.js';
import { createInactiveGitDiffCheckpointStatus } from './GitDiffCheckpointStatus.js';
import { GitDiffScanner, type GitDiffScanResult } from './GitDiffScanner.js';

interface CheckpointLogger {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

export interface GitDiffCheckpointServiceOptions {
  dispatcher: FileChangeDispatcher;
  logger?: CheckpointLogger;
  projectRoot: string;
  scanner?: Pick<GitDiffScanner, 'getStatus' | 'scanOnce'>;
}

export interface GitDiffCheckpointResult {
  changed: boolean;
  dirtyPathCount: number;
  dispatchedEventCount: number;
  fallbackReason?: string;
  head: string | null;
  headChanged: boolean;
  ok: boolean;
  scanned: boolean;
  signature: string | null;
}

export class GitDiffCheckpointService {
  readonly #dispatcher: FileChangeDispatcher;
  readonly #logger: CheckpointLogger;
  readonly #projectRoot: string;
  readonly #scanner: Pick<GitDiffScanner, 'getStatus' | 'scanOnce'>;

  #acceptedHead: string | null = null;
  #acceptedSignature: string | null = null;
  #errors: GitDiffCheckpointError[] = [];
  #lastCheckpointAt: string | null = null;
  #lastDispatch: GitDiffLastDispatchStatus = {
    at: null,
    batchCount: 0,
    eventCount: 0,
    source: null,
  };

  constructor(options: GitDiffCheckpointServiceOptions) {
    this.#dispatcher = options.dispatcher;
    this.#logger = options.logger ?? {};
    this.#projectRoot = options.projectRoot;
    this.#scanner = options.scanner ?? new GitDiffScanner({ projectRoot: options.projectRoot });
  }

  async checkpoint(now = Date.now()): Promise<GitDiffCheckpointResult> {
    const scan = await this.#scanner.scanOnce(now, { previousHead: this.#acceptedHead });
    this.#lastCheckpointAt = scan.scannedAt;

    if (!scan.scanned) {
      this.#recordError('GIT_UNAVAILABLE', 'Git diff scan is unavailable', scan.scannedAt);
      return checkpointResult(scan, false, 0, false);
    }

    const changed = this.#hasAcceptedStateChanged(scan);
    if (!changed || scan.events.length === 0) {
      this.#accept(scan);
      return checkpointResult(scan, true, 0, false);
    }

    try {
      await this.#dispatcher.dispatch(scan.events);
      this.#accept(scan);
      this.#lastDispatch = {
        at: scan.scannedAt,
        batchCount: this.#lastDispatch.batchCount + 1,
        eventCount: scan.events.length,
        source: dominantEventSource(scan.events),
      };
      this.#logger.info?.('[git-diff-checkpoint] dispatched git diff events', {
        eventCount: scan.events.length,
        head: scan.head,
      });
      return checkpointResult(scan, true, scan.events.length, true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#recordError('DISPATCH_FAILED', message, scan.scannedAt);
      this.#logger.warn?.('[git-diff-checkpoint] dispatch failed', { error: message });
      return checkpointResult(scan, false, 0, true);
    }
  }

  getStatus(): GitDiffCheckpointStatus {
    const scanner = this.#scanner.getStatus();
    return {
      ...createInactiveGitDiffCheckpointStatus(this.#projectRoot, null),
      enabled: true,
      errors: [...this.#errors],
      healthy: scanner.healthy && this.#errors.length === 0,
      lastCheckpointAt: this.#lastCheckpointAt,
      lastDispatch: { ...this.#lastDispatch },
      scanner,
    };
  }

  #accept(scan: GitDiffScanResult): void {
    this.#acceptedHead = scan.head;
    this.#acceptedSignature = scan.signature;
  }

  #hasAcceptedStateChanged(scan: GitDiffScanResult): boolean {
    if (scan.events.length === 0) {
      return false;
    }
    return scan.signature !== this.#acceptedSignature || scan.head !== this.#acceptedHead;
  }

  #recordError(code: GitDiffCheckpointError['code'], message: string, at: string): void {
    this.#errors.push({ at, code, message });
  }
}

function checkpointResult(
  scan: GitDiffScanResult,
  ok: boolean,
  dispatchedEventCount: number,
  changed: boolean
): GitDiffCheckpointResult {
  return {
    changed,
    dirtyPathCount: scan.dirtyPathCount,
    dispatchedEventCount,
    ...(scan.fallbackReason ? { fallbackReason: scan.fallbackReason } : {}),
    head: scan.head,
    headChanged: scan.headChanged,
    ok,
    scanned: scan.scanned,
    signature: scan.signature,
  };
}

function dominantEventSource(events: readonly FileChangeEvent[]): FileChangeEventSource | null {
  const counts = new Map<FileChangeEventSource, number>();
  for (const event of events) {
    if (!event.eventSource) {
      continue;
    }
    counts.set(event.eventSource, (counts.get(event.eventSource) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  );
}
