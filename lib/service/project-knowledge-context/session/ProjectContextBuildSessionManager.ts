import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SESSION_TTL_MS = 60_000;
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.dart',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.m',
  '.mm',
  '.mjs',
  '.mts',
  '.py',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
]);
const MANIFEST_NAMES = new Set([
  'Cargo.toml',
  'Package.swift',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'pom.xml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts',
  'yarn.lock',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.wakeflow-active',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'vendor',
]);

export interface ProjectContextBuildScope {
  filePath?: string;
  kind: string;
  line?: number;
  repoId?: string;
  sourceFolder?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface ProjectContextFactChunk {
  id: string;
  value: unknown;
}

export interface ProjectContextBuildLease<T> {
  factSessionRef: string;
  fingerprint: string;
  release(): void;
  value: T;
}

export type ProjectContextProgressiveOutcome = 'progress' | 'success';

export interface ProjectContextProgressiveSnapshot<T> {
  outcome: ProjectContextProgressiveOutcome;
  value: T;
  version: number;
}

export interface ProjectContextProgressiveLease<T> {
  factSessionRef: string;
  fingerprint: string;
  next(afterVersion: number, signal?: AbortSignal): Promise<ProjectContextProgressiveSnapshot<T>>;
  release(): void;
  snapshot: ProjectContextProgressiveSnapshot<T>;
}

export interface ProjectContextContinuationPage<T> {
  accumulatedCounts: { items: number };
  factSessionRef: string;
  hasMore: boolean;
  items: T[];
  nextCursor: string | null;
  page: number;
  resultRef: string;
  context?: unknown;
}

interface BuildRecord<T = unknown> {
  activeConsumers: Set<symbol>;
  buildDirectory: string;
  controller: AbortController;
  expiresAt: number;
  factSessionRef: string;
  fingerprint: string;
  key: string;
  projectRoot: string;
  progressEvents: ProjectContextProgressiveSnapshot<T>[];
  progressVersion: number;
  progressWaiters: Set<() => void>;
  promise: Promise<T>;
  scope: ProjectContextBuildScope;
  terminal: BuildTerminalOutcome<T>;
  value?: T;
}

type BuildTerminalOutcome<T> =
  | { kind: 'pending' }
  | { kind: 'success'; value: T; version: number }
  | { error: unknown; kind: 'error' | 'cancelled' };

interface ContinuationRecordBase {
  cursor: string;
  expiresAt: number;
  factSessionRef: string;
  fingerprint: string;
  filePath: string;
  page: number;
  pageSize: number;
  projectRoot: string;
  resultDirectory: string;
  resultRef: string;
  scope: ProjectContextBuildScope;
  start: number;
}

interface StaticContinuationRecord extends ContinuationRecordBase {
  kind: 'static';
}

interface LiveContinuationRecord extends ContinuationRecordBase {
  contextFor(value: unknown): unknown;
  deliveredKeys: Set<string>;
  itemKey(item: unknown): string;
  itemsFor(value: unknown, outcome: ProjectContextProgressiveOutcome): readonly unknown[];
  kind: 'live';
  lastContext?: unknown;
  lease: ProjectContextProgressiveLease<unknown>;
  snapshot: ProjectContextProgressiveSnapshot<unknown>;
}

type ContinuationRecord = StaticContinuationRecord | LiveContinuationRecord;

interface StoredContinuation {
  context?: unknown;
  items: readonly unknown[];
}

interface TerminalCursorFailure {
  error: unknown;
  expiresAt: number;
  projectRoot: string;
}

export class ProjectContextContinuationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProjectContextContinuationError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Process-local coordinator for real-time ProjectContext facts. Its cache is
 * memory-only; the filesystem is used only for owner-confined, short-lived fact
 * chunks and continuation payloads under the OS temp directory.
 */
export class ProjectContextBuildSessionManager {
  readonly #continuations = new Map<string, ContinuationRecord>();
  readonly #expiredCursors = new Map<string, number>();
  readonly #fileHashCache = new Map<string, { hash: string; signature: string }>();
  readonly #sessions = new Map<string, BuildRecord>();
  readonly #terminalCursorFailures = new Map<string, TerminalCursorFailure>();
  readonly #ttlMs: number;
  readonly #tempRoot: string;

  constructor(options: { tempParent?: string; ttlMs?: number } = {}) {
    this.#ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_SESSION_TTL_MS);
    this.#tempRoot = mkdtempSync(
      path.join(options.tempParent ?? os.tmpdir(), 'alembic-project-context-')
    );
    chmodSync(this.#tempRoot, 0o700);
  }

  async acquire<T>(input: {
    build(signal: AbortSignal, publish: (value: T) => void): Promise<T>;
    chunks?(value: T): readonly ProjectContextFactChunk[];
    projectRoot: string;
    scope: ProjectContextBuildScope;
    signal?: AbortSignal;
  }): Promise<ProjectContextBuildLease<T>> {
    this.#cleanupExpired();
    input.signal?.throwIfAborted();
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    const fingerprint = fingerprintProjectFacts(
      projectRoot,
      input.scope,
      this.#fileHashCache,
      input.signal
    );
    const key = digest(`${projectRoot}\0${stableJson(input.scope)}\0${fingerprint}`);
    let record = this.#sessions.get(key) as BuildRecord<T> | undefined;
    if (!record) {
      record = this.#createBuildRecord(
        key,
        fingerprint,
        projectRoot,
        input.scope,
        input.build,
        input.chunks
      );
      this.#sessions.set(key, record as BuildRecord);
    }

    const consumer = Symbol('project-context-consumer');
    record.activeConsumers.add(consumer);
    try {
      const value = await waitForConsumer(record.promise, input.signal, () => {
        this.#releaseConsumer(record, consumer);
      });
      let released = false;
      return {
        factSessionRef: record.factSessionRef,
        fingerprint,
        value,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.#releaseConsumer(record, consumer);
        },
      };
    } catch (error) {
      this.#releaseConsumer(record, consumer);
      if (
        input.signal?.aborted &&
        record.activeConsumers.size === 0 &&
        record.terminal.kind === 'pending'
      ) {
        // The final cancelled consumer is the cleanup acknowledgement boundary:
        // do not let the host report TOOL_TIMEOUT until the shared worker has
        // observed the abort and settled (the outer deadline still bounds this).
        await record.promise.catch(() => undefined);
      }
      throw error;
    }
  }

  async acquireProgressive<T>(input: {
    build(signal: AbortSignal, publish: (value: T) => void): Promise<T>;
    chunks?(value: T): readonly ProjectContextFactChunk[];
    projectRoot: string;
    scope: ProjectContextBuildScope;
    signal?: AbortSignal;
  }): Promise<ProjectContextProgressiveLease<T>> {
    this.#cleanupExpired();
    input.signal?.throwIfAborted();
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    const fingerprint = fingerprintProjectFacts(
      projectRoot,
      input.scope,
      this.#fileHashCache,
      input.signal
    );
    const key = digest(`${projectRoot}\0${stableJson(input.scope)}\0${fingerprint}`);
    let record = this.#sessions.get(key) as BuildRecord<T> | undefined;
    if (!record) {
      record = this.#createBuildRecord(
        key,
        fingerprint,
        projectRoot,
        input.scope,
        input.build,
        input.chunks
      );
      this.#sessions.set(key, record as BuildRecord);
    }
    const activeRecord = record;

    const consumer = Symbol('project-context-progressive-consumer');
    activeRecord.activeConsumers.add(consumer);
    try {
      const snapshot = await this.#waitForProgress(activeRecord, 0, input.signal);
      let released = false;
      return {
        factSessionRef: activeRecord.factSessionRef,
        fingerprint,
        snapshot,
        next: (afterVersion, signal) => this.#waitForProgress(activeRecord, afterVersion, signal),
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.#releaseConsumer(activeRecord, consumer);
        },
      };
    } catch (error) {
      this.#releaseConsumer(activeRecord, consumer);
      throw error;
    }
  }

  async publishContinuation<T>(input: {
    context?: unknown;
    factSessionRef: string;
    items: readonly T[];
    pageSize: number;
    projectRoot: string;
  }): Promise<ProjectContextContinuationPage<T>> {
    this.#cleanupExpired();
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    const factSession = [...this.#sessions.values()].find(
      (record) => record.factSessionRef === input.factSessionRef
    );
    if (!factSession || factSession.projectRoot !== projectRoot) {
      throw new ProjectContextContinuationError(
        'PROJECT_CONTEXT_FACT_SESSION_INVALID',
        'The continuation cannot be attached to an unknown or cross-project fact session.',
        false
      );
    }
    const pageSize = Math.max(1, Math.trunc(input.pageSize));
    const resultRef = opaqueRef('result');
    const firstItems = input.items.slice(0, pageSize);
    if (firstItems.length >= input.items.length) {
      this.#cleanupBuildFiles(input.factSessionRef);
      return {
        accumulatedCounts: { items: firstItems.length },
        factSessionRef: input.factSessionRef,
        hasMore: false,
        items: [...firstItems],
        nextCursor: null,
        page: 1,
        resultRef,
        ...(input.context === undefined ? {} : { context: input.context }),
      };
    }

    const resultDirectory = path.join(this.#tempRoot, digest(resultRef));
    mkdirOwnerOnly(resultDirectory);
    const filePath = path.join(resultDirectory, 'continuation.json');
    writeFileSync(
      filePath,
      JSON.stringify({ items: input.items, context: input.context } satisfies StoredContinuation),
      {
        encoding: 'utf8',
        mode: 0o600,
      }
    );
    const cursor = opaqueRef('cursor');
    this.#continuations.set(cursor, {
      cursor,
      expiresAt: Date.now() + this.#ttlMs,
      factSessionRef: input.factSessionRef,
      fingerprint: factSession.fingerprint,
      kind: 'static',
      filePath,
      page: 2,
      pageSize,
      projectRoot,
      resultDirectory,
      resultRef,
      scope: factSession.scope,
      start: pageSize,
    });
    return {
      accumulatedCounts: { items: firstItems.length },
      factSessionRef: input.factSessionRef,
      hasMore: true,
      items: [...firstItems],
      nextCursor: cursor,
      page: 1,
      resultRef,
      ...(input.context === undefined ? {} : { context: input.context }),
    };
  }

  async publishLiveContinuation<T, U>(input: {
    context(value: T): unknown;
    itemKey(item: U): string;
    items(value: T, outcome: ProjectContextProgressiveOutcome): readonly U[];
    lease: ProjectContextProgressiveLease<T>;
    pageSize: number;
    projectRoot: string;
  }): Promise<ProjectContextContinuationPage<U>> {
    this.#cleanupExpired();
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    const factSession = [...this.#sessions.values()].find(
      (record) => record.factSessionRef === input.lease.factSessionRef
    );
    if (!factSession || factSession.projectRoot !== projectRoot) {
      input.lease.release();
      throw new ProjectContextContinuationError(
        'PROJECT_CONTEXT_FACT_SESSION_INVALID',
        'The live continuation cannot be attached to an unknown or cross-project fact session.',
        false
      );
    }

    const resultRef = opaqueRef('result');
    const resultDirectory = path.join(this.#tempRoot, digest(resultRef));
    mkdirOwnerOnly(resultDirectory);
    const filePath = path.join(resultDirectory, 'live-continuation.json');
    writeFileSync(filePath, JSON.stringify({ factSessionRef: input.lease.factSessionRef }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const cursor = opaqueRef('cursor');
    const record: LiveContinuationRecord = {
      contextFor: input.context as (value: unknown) => unknown,
      cursor,
      deliveredKeys: new Set(),
      expiresAt: Date.now() + this.#ttlMs,
      factSessionRef: input.lease.factSessionRef,
      filePath,
      fingerprint: factSession.fingerprint,
      itemKey: input.itemKey as (item: unknown) => string,
      itemsFor: input.items as (
        value: unknown,
        outcome: ProjectContextProgressiveOutcome
      ) => readonly unknown[],
      kind: 'live',
      lease: input.lease as ProjectContextProgressiveLease<unknown>,
      page: 1,
      pageSize: Math.max(1, Math.trunc(input.pageSize)),
      projectRoot,
      resultDirectory,
      resultRef,
      scope: factSession.scope,
      snapshot: input.lease.snapshot as ProjectContextProgressiveSnapshot<unknown>,
      start: 0,
    };
    this.#continuations.set(cursor, record);
    try {
      return await this.#readLiveContinuation<U>(record, true);
    } catch (error) {
      this.#cleanupResult(record);
      throw error;
    }
  }

  async readContinuation<T>(input: {
    cursor: string;
    projectRoot: string;
  }): Promise<ProjectContextContinuationPage<T>> {
    this.#cleanupExpired();
    const terminalFailure = this.#terminalCursorFailures.get(input.cursor);
    if (terminalFailure) {
      if (canonicalProjectRoot(input.projectRoot) !== terminalFailure.projectRoot) {
        throw new ProjectContextContinuationError(
          'PROJECT_CONTEXT_CURSOR_CONFINED',
          'The continuation cursor belongs to a different canonical project root.',
          false
        );
      }
      throw terminalFailure.error;
    }
    const record = this.#continuations.get(input.cursor);
    if (!record) {
      throw this.#missingCursorError(input.cursor);
    }
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    if (projectRoot !== record.projectRoot) {
      throw new ProjectContextContinuationError(
        'PROJECT_CONTEXT_CURSOR_CONFINED',
        'The continuation cursor belongs to a different canonical project root.',
        false
      );
    }
    const currentFingerprint = fingerprintProjectFacts(
      record.projectRoot,
      record.scope,
      this.#fileHashCache
    );
    if (currentFingerprint !== record.fingerprint) {
      this.#cleanupResult(record);
      this.#invalidateFactSession(record.factSessionRef);
      throw new ProjectContextContinuationError(
        'PROJECT_CONTEXT_FACTS_CHANGED',
        'Project source or manifest facts changed after the previous page. Retry the bounded request.',
        true
      );
    }
    if (record.kind === 'live') {
      try {
        return await this.#readLiveContinuation<T>(record, false);
      } catch (error) {
        this.#cleanupResult(record);
        throw error;
      }
    }
    const stored = JSON.parse(readFileSync(record.filePath, 'utf8')) as StoredContinuation;
    const items = stored.items.slice(record.start, record.start + record.pageSize) as T[];
    const nextStart = record.start + items.length;
    const hasMore = nextStart < stored.items.length;
    this.#continuations.delete(record.cursor);
    this.#expiredCursors.set(record.cursor, Date.now() + this.#ttlMs);
    let nextCursor: string | null = null;
    if (hasMore) {
      nextCursor = opaqueRef('cursor');
      this.#continuations.set(nextCursor, {
        ...record,
        cursor: nextCursor,
        expiresAt: Date.now() + this.#ttlMs,
        page: record.page + 1,
        start: nextStart,
      });
    } else {
      this.#cleanupResult(record);
    }
    return {
      accumulatedCounts: { items: nextStart },
      factSessionRef: record.factSessionRef,
      hasMore,
      items,
      nextCursor,
      page: record.page,
      resultRef: record.resultRef,
      ...(stored.context === undefined ? {} : { context: stored.context }),
    };
  }

  async cancelContinuation<T>(input: {
    cursor: string;
    projectRoot: string;
  }): Promise<{ context?: T; factSessionRef: string; resultRef: string }> {
    this.#cleanupExpired();
    const terminalFailure = this.#terminalCursorFailures.get(input.cursor);
    if (terminalFailure) {
      if (canonicalProjectRoot(input.projectRoot) !== terminalFailure.projectRoot) {
        throw new ProjectContextContinuationError(
          'PROJECT_CONTEXT_CURSOR_CONFINED',
          'The continuation cursor belongs to a different canonical project root.',
          false
        );
      }
      throw terminalFailure.error;
    }
    const record = this.#continuations.get(input.cursor);
    if (!record) {
      throw this.#missingCursorError(input.cursor);
    }
    if (canonicalProjectRoot(input.projectRoot) !== record.projectRoot) {
      throw new ProjectContextContinuationError(
        'PROJECT_CONTEXT_CURSOR_CONFINED',
        'The continuation cursor belongs to a different canonical project root.',
        false
      );
    }
    const context =
      record.kind === 'live'
        ? (record.lastContext ?? record.contextFor(record.snapshot.value))
        : (JSON.parse(readFileSync(record.filePath, 'utf8')) as StoredContinuation).context;
    this.#cleanupResult(record);
    return {
      factSessionRef: record.factSessionRef,
      resultRef: record.resultRef,
      ...(context === undefined ? {} : { context: context as T }),
    };
  }

  debugSnapshot(): { activeContinuations: number; activeSessions: number; tempRoot: string } {
    this.#cleanupExpired();
    return {
      activeContinuations: this.#continuations.size,
      activeSessions: this.#sessions.size,
      tempRoot: this.#tempRoot,
    };
  }

  async dispose(): Promise<void> {
    for (const record of this.#sessions.values()) {
      record.controller.abort(new DOMException('Build session manager disposed.', 'AbortError'));
    }
    this.#sessions.clear();
    this.#terminalCursorFailures.clear();
    this.#continuations.clear();
    this.#expiredCursors.clear();
    this.#fileHashCache.clear();
    rmSync(this.#tempRoot, { force: true, recursive: true });
  }

  #createBuildRecord<T>(
    key: string,
    fingerprint: string,
    projectRoot: string,
    scope: ProjectContextBuildScope,
    build: (signal: AbortSignal, publish: (value: T) => void) => Promise<T>,
    chunks?: (value: T) => readonly ProjectContextFactChunk[]
  ): BuildRecord<T> {
    const factSessionRef = opaqueRef('facts');
    const buildDirectory = path.join(this.#tempRoot, digest(factSessionRef));
    mkdirOwnerOnly(buildDirectory);
    const controller = new AbortController();
    const record: BuildRecord<T> = {
      activeConsumers: new Set(),
      buildDirectory,
      controller,
      expiresAt: Date.now() + this.#ttlMs,
      factSessionRef,
      fingerprint,
      key,
      projectRoot,
      progressVersion: 0,
      progressEvents: [],
      progressWaiters: new Set(),
      promise: Promise.resolve(undefined as T),
      scope: { ...scope },
      terminal: { kind: 'pending' },
    };
    const publishEvent = (value: T, outcome: ProjectContextProgressiveOutcome) => {
      controller.signal.throwIfAborted();
      this.#writeFactChunks(record, chunks?.(value) ?? []);
      record.progressVersion += 1;
      record.progressEvents.push({ outcome, value, version: record.progressVersion });
      for (const waiter of record.progressWaiters) {
        waiter();
      }
      record.progressWaiters.clear();
    };
    const publish = (value: T) => publishEvent(value, 'progress');
    record.promise = Promise.resolve()
      .then(() => build(controller.signal, publish))
      .then((value) => {
        controller.signal.throwIfAborted();
        record.value = value;
        publishEvent(value, 'success');
        record.terminal = { kind: 'success', value, version: record.progressVersion };
        record.expiresAt = Date.now() + this.#ttlMs;
        return value;
      })
      .catch((error: unknown) => {
        record.terminal = {
          error,
          kind: controller.signal.aborted ? 'cancelled' : 'error',
        };
        this.#failLiveContinuations(factSessionRef, error);
        for (const waiter of record.progressWaiters) {
          waiter();
        }
        record.progressWaiters.clear();
        this.#sessions.delete(key);
        rmSync(buildDirectory, { force: true, recursive: true });
        throw error;
      });
    // Progressive callers can legitimately return a first page without awaiting
    // the terminal build. Keep the original rejecting promise for consumers while
    // attaching an internal observer so later cancellation cannot surface as an
    // unhandled process rejection.
    void record.promise.catch(() => undefined);
    return record;
  }

  async #waitForProgress<T>(
    record: BuildRecord<T>,
    afterVersion: number,
    signal?: AbortSignal
  ): Promise<ProjectContextProgressiveSnapshot<T>> {
    signal?.throwIfAborted();
    while (true) {
      if (record.terminal.kind === 'error' || record.terminal.kind === 'cancelled') {
        throw record.terminal.error;
      }
      const nextEvent = record.progressEvents.find((event) => event.version > afterVersion);
      if (nextEvent) {
        return nextEvent;
      }
      if (record.terminal.kind === 'success') {
        const terminalEvent = record.progressEvents.at(-1);
        if (!terminalEvent) {
          throw new Error('ProjectContext build succeeded without publishing a terminal value.');
        }
        return terminalEvent;
      }
      await waitForNotification(record.progressWaiters, signal);
    }
  }

  #writeFactChunks<T>(record: BuildRecord<T>, chunks: readonly ProjectContextFactChunk[]): void {
    for (const chunk of [...chunks].sort((left, right) => left.id.localeCompare(right.id))) {
      const fileName = `repo-${digest(chunk.id).slice(0, 24)}.json`;
      writeFileSync(path.join(record.buildDirectory, fileName), JSON.stringify(chunk.value), {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }

  async #readLiveContinuation<T>(
    record: LiveContinuationRecord,
    initial: boolean
  ): Promise<ProjectContextContinuationPage<T>> {
    this.#continuations.delete(record.cursor);
    if (!initial) {
      this.#expiredCursors.set(record.cursor, Date.now() + this.#ttlMs);
    }
    while (true) {
      const candidates = record.itemsFor(record.snapshot.value, record.snapshot.outcome);
      const available = candidates.filter(
        (item) => !record.deliveredKeys.has(record.itemKey(item))
      );
      if (available.length > 0 || record.snapshot.outcome === 'success') {
        const items = available.slice(0, record.pageSize);
        for (const item of items) {
          record.deliveredKeys.add(record.itemKey(item));
        }
        record.lastContext = record.contextFor(record.snapshot.value);
        const remaining = available.length - items.length;
        const hasMore = remaining > 0 || record.snapshot.outcome !== 'success';
        let nextCursor: string | null = null;
        if (hasMore) {
          nextCursor = opaqueRef('cursor');
          record.cursor = nextCursor;
          record.expiresAt = Date.now() + this.#ttlMs;
          record.page += 1;
          this.#continuations.set(nextCursor, record);
        } else {
          this.#cleanupResult(record);
        }
        return {
          accumulatedCounts: { items: record.deliveredKeys.size },
          factSessionRef: record.factSessionRef,
          hasMore,
          items: items as T[],
          nextCursor,
          page: hasMore ? record.page - 1 : record.page,
          resultRef: record.resultRef,
          ...(record.lastContext === undefined ? {} : { context: record.lastContext }),
        };
      }
      record.snapshot = await record.lease.next(record.snapshot.version);
    }
  }

  #releaseConsumer(record: BuildRecord, consumer: symbol): void {
    if (!record.activeConsumers.delete(consumer)) {
      return;
    }
    if (record.activeConsumers.size === 0) {
      if (record.terminal.kind === 'pending') {
        record.controller.abort(
          new DOMException('Every fact-session consumer cancelled.', 'AbortError')
        );
      } else {
        this.#cleanupBuildFiles(record.factSessionRef);
      }
    }
  }

  #cleanupBuildFiles(factSessionRef: string): void {
    for (const record of this.#sessions.values()) {
      if (record.factSessionRef === factSessionRef) {
        rmSync(record.buildDirectory, { force: true, recursive: true });
      }
    }
  }

  #invalidateFactSession(factSessionRef: string): void {
    for (const [key, record] of this.#sessions) {
      if (record.factSessionRef !== factSessionRef) {
        continue;
      }
      if (record.terminal.kind === 'pending') {
        record.controller.abort(
          new DOMException('ProjectContext source facts changed.', 'AbortError')
        );
      }
      this.#sessions.delete(key);
      rmSync(record.buildDirectory, { force: true, recursive: true });
    }
  }

  #cleanupResult(record: ContinuationRecord): void {
    for (const [cursor, candidate] of this.#continuations) {
      if (candidate.resultRef === record.resultRef) {
        this.#continuations.delete(cursor);
        this.#expiredCursors.set(cursor, Date.now() + this.#ttlMs);
      }
    }
    rmSync(record.resultDirectory, { force: true, recursive: true });
    if (record.kind === 'live') {
      record.lease.release();
    }
    this.#cleanupBuildFiles(record.factSessionRef);
  }

  #failLiveContinuations(factSessionRef: string, error: unknown): void {
    for (const [cursor, record] of this.#continuations) {
      if (record.kind !== 'live' || record.factSessionRef !== factSessionRef) {
        continue;
      }
      this.#continuations.delete(cursor);
      this.#terminalCursorFailures.set(cursor, {
        error,
        expiresAt: Date.now() + this.#ttlMs,
        projectRoot: record.projectRoot,
      });
      rmSync(record.resultDirectory, { force: true, recursive: true });
      record.lease.release();
    }
    this.#cleanupBuildFiles(factSessionRef);
  }

  #cleanupExpired(): void {
    const now = Date.now();
    for (const [cursor, expiry] of this.#expiredCursors) {
      if (expiry <= now) {
        this.#expiredCursors.delete(cursor);
      }
    }
    for (const [cursor, failure] of this.#terminalCursorFailures) {
      if (failure.expiresAt <= now) {
        this.#terminalCursorFailures.delete(cursor);
        this.#expiredCursors.set(cursor, now + this.#ttlMs);
      }
    }
    for (const record of [...this.#continuations.values()]) {
      if (record.expiresAt <= now) {
        this.#cleanupResult(record);
      }
    }
    for (const [key, record] of this.#sessions) {
      if (
        record.terminal.kind !== 'pending' &&
        record.activeConsumers.size === 0 &&
        record.expiresAt <= now
      ) {
        this.#sessions.delete(key);
        rmSync(record.buildDirectory, { force: true, recursive: true });
      }
    }
  }

  #missingCursorError(cursor: string): ProjectContextContinuationError {
    return this.#expiredCursors.has(cursor)
      ? new ProjectContextContinuationError(
          'PROJECT_CONTEXT_CURSOR_EXPIRED',
          'The continuation expired. Retry the same bounded ProjectContext request once.',
          true
        )
      : new ProjectContextContinuationError(
          'PROJECT_CONTEXT_CURSOR_INVALID',
          'The continuation cursor is unknown to this process.',
          false
        );
  }
}

function waitForConsumer<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void
): Promise<T> {
  if (!signal) {
    return work;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason ?? new DOMException('ProjectContext request aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function waitForNotification(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const settle = () => {
      signal?.removeEventListener('abort', abort);
      waiters.delete(settle);
      resolve();
    };
    const abort = () => {
      waiters.delete(settle);
      reject(signal?.reason ?? new DOMException('ProjectContext request aborted.', 'AbortError'));
    };
    waiters.add(settle);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function fingerprintProjectFacts(
  projectRoot: string,
  scope: ProjectContextBuildScope,
  hashCache: Map<string, { hash: string; signature: string }>,
  signal?: AbortSignal
): string {
  const records: string[] = [];
  const explicitPath = resolveExplicitFactPath(projectRoot, scope.filePath);
  const addFact = (absolutePath: string) =>
    appendProjectFactRecord(records, projectRoot, absolutePath, hashCache, signal);
  if (explicitPath) {
    appendNarrowProjectFactRecords(projectRoot, explicitPath, addFact);
    return digest(records.sort().join('\n'));
  }
  appendBroadProjectFactRecords(projectRoot, projectRoot, addFact, signal);
  return digest(records.sort().join('\n'));
}

function resolveExplicitFactPath(projectRoot: string, filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const requestedPath = path.resolve(projectRoot, filePath.replace(/\\/g, '/'));
  if (!isPathWithin(projectRoot, requestedPath)) {
    throw new Error('ProjectContext build scope escapes the canonical project root.');
  }
  const explicitPath = existsSync(requestedPath) ? realpathSync(requestedPath) : requestedPath;
  if (!isPathWithin(projectRoot, explicitPath)) {
    throw new Error('ProjectContext build scope resolves outside the canonical project root.');
  }
  return explicitPath;
}

function appendProjectFactRecord(
  records: string[],
  projectRoot: string,
  absolutePath: string,
  hashCache: Map<string, { hash: string; signature: string }>,
  signal?: AbortSignal
): void {
  signal?.throwIfAborted();
  if (!existsSync(absolutePath)) {
    records.push([path.relative(projectRoot, absolutePath), '0', '0', '0'].join('\0'));
    return;
  }
  const canonicalPath = realpathSync(absolutePath);
  if (!isPathWithin(projectRoot, canonicalPath)) {
    throw new Error('ProjectContext fact resolves outside the canonical project root.');
  }
  const stat = statSync(canonicalPath, { bigint: true });
  const relativePath = path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
  const signature = [stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const cached = hashCache.get(canonicalPath);
  const hash = cached?.signature === signature ? cached.hash : digest(readFileSync(canonicalPath));
  if (cached?.signature !== signature) {
    hashCache.set(canonicalPath, { hash, signature });
  }
  records.push([relativePath, '1', stat.size.toString(), stat.mtimeNs.toString(), hash].join('\0'));
}

function appendNarrowProjectFactRecords(
  projectRoot: string,
  explicitPath: string,
  addFact: (absolutePath: string) => void
): void {
  addFact(explicitPath);
  let directory = path.dirname(explicitPath);
  while (isPathWithin(projectRoot, directory)) {
    for (const manifestName of [...MANIFEST_NAMES].sort()) {
      const manifestPath = path.join(directory, manifestName);
      if (existsSync(manifestPath)) {
        addFact(manifestPath);
      }
    }
    if (directory === projectRoot) {
      return;
    }
    directory = path.dirname(directory);
  }
}

function appendBroadProjectFactRecords(
  projectRoot: string,
  directory: string,
  addFact: (absolutePath: string) => void,
  signal?: AbortSignal
): void {
  signal?.throwIfAborted();
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    signal?.throwIfAborted();
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      appendBroadProjectFactRecords(projectRoot, absolutePath, addFact, signal);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      !MANIFEST_NAMES.has(entry.name) &&
      !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    addFact(absolutePath);
  }
}

function canonicalProjectRoot(projectRoot: string): string {
  return realpathSync(path.resolve(projectRoot));
}

function isPathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
}

function digest(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaqueRef(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

function mkdirOwnerOnly(directory: string): void {
  if (!existsSync(directory)) {
    // The parent itself is already owner-only; recursive avoids a TOCTOU on retries.
    const parent = path.dirname(directory);
    if (!existsSync(parent)) {
      mkdirOwnerOnly(parent);
    }
    mkdirSync(directory, { mode: 0o700 });
  }
  chmodSync(directory, 0o700);
}
