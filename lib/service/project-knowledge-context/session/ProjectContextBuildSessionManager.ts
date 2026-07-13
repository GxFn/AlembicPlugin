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
  promise: Promise<T>;
  settled: boolean;
  value?: T;
}

interface ContinuationRecord {
  cursor: string;
  expiresAt: number;
  factSessionRef: string;
  filePath: string;
  page: number;
  pageSize: number;
  projectRoot: string;
  resultDirectory: string;
  resultRef: string;
  start: number;
}

interface StoredContinuation {
  context?: unknown;
  items: readonly unknown[];
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
    build(signal: AbortSignal): Promise<T>;
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
      record = this.#createBuildRecord(key, fingerprint, input.build, input.chunks);
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
      if (input.signal?.aborted && record.activeConsumers.size === 0 && !record.settled) {
        // The final cancelled consumer is the cleanup acknowledgement boundary:
        // do not let the host report TOOL_TIMEOUT until the shared worker has
        // observed the abort and settled (the outer deadline still bounds this).
        await record.promise.catch(() => undefined);
      }
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
      filePath,
      page: 2,
      pageSize,
      projectRoot,
      resultDirectory,
      resultRef,
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

  async readContinuation<T>(input: {
    cursor: string;
    projectRoot: string;
  }): Promise<ProjectContextContinuationPage<T>> {
    this.#cleanupExpired();
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
    const stored = JSON.parse(readFileSync(record.filePath, 'utf8')) as StoredContinuation;
    this.#cleanupResult(record);
    return {
      factSessionRef: record.factSessionRef,
      resultRef: record.resultRef,
      ...(stored.context === undefined ? {} : { context: stored.context as T }),
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
    this.#continuations.clear();
    this.#expiredCursors.clear();
    this.#fileHashCache.clear();
    rmSync(this.#tempRoot, { force: true, recursive: true });
  }

  #createBuildRecord<T>(
    key: string,
    fingerprint: string,
    build: (signal: AbortSignal) => Promise<T>,
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
      promise: Promise.resolve(undefined as T),
      settled: false,
    };
    record.promise = Promise.resolve()
      .then(() => build(controller.signal))
      .then((value) => {
        controller.signal.throwIfAborted();
        const factChunks = [...(chunks?.(value) ?? [])].sort((left, right) =>
          left.id.localeCompare(right.id)
        );
        for (const [index, chunk] of factChunks.entries()) {
          const fileName = `${String(index).padStart(4, '0')}-${digest(chunk.id).slice(0, 12)}.json`;
          writeFileSync(path.join(buildDirectory, fileName), JSON.stringify(chunk.value), {
            encoding: 'utf8',
            mode: 0o600,
          });
        }
        record.value = value;
        record.settled = true;
        record.expiresAt = Date.now() + this.#ttlMs;
        return value;
      })
      .catch((error: unknown) => {
        record.settled = true;
        this.#sessions.delete(key);
        rmSync(buildDirectory, { force: true, recursive: true });
        throw error;
      });
    return record;
  }

  #releaseConsumer(record: BuildRecord, consumer: symbol): void {
    if (!record.activeConsumers.delete(consumer)) {
      return;
    }
    if (record.activeConsumers.size === 0) {
      if (!record.settled) {
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

  #cleanupResult(record: ContinuationRecord): void {
    for (const [cursor, candidate] of this.#continuations) {
      if (candidate.resultRef === record.resultRef) {
        this.#continuations.delete(cursor);
        this.#expiredCursors.set(cursor, Date.now() + this.#ttlMs);
      }
    }
    rmSync(record.resultDirectory, { force: true, recursive: true });
    this.#cleanupBuildFiles(record.factSessionRef);
  }

  #cleanupExpired(): void {
    const now = Date.now();
    for (const [cursor, expiry] of this.#expiredCursors) {
      if (expiry <= now) {
        this.#expiredCursors.delete(cursor);
      }
    }
    for (const record of [...this.#continuations.values()]) {
      if (record.expiresAt <= now) {
        this.#cleanupResult(record);
      }
    }
    for (const [key, record] of this.#sessions) {
      if (record.settled && record.activeConsumers.size === 0 && record.expiresAt <= now) {
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

function fingerprintProjectFacts(
  projectRoot: string,
  scope: ProjectContextBuildScope,
  hashCache: Map<string, { hash: string; signature: string }>,
  signal?: AbortSignal
): string {
  const records: string[] = [];
  const requestedExplicitPath = scope.filePath
    ? path.resolve(projectRoot, scope.filePath.replace(/\\/g, '/'))
    : undefined;
  if (requestedExplicitPath && !isPathWithin(projectRoot, requestedExplicitPath)) {
    throw new Error('ProjectContext build scope escapes the canonical project root.');
  }
  const explicitPath =
    requestedExplicitPath && existsSync(requestedExplicitPath)
      ? realpathSync(requestedExplicitPath)
      : requestedExplicitPath;
  if (explicitPath && !isPathWithin(projectRoot, explicitPath)) {
    throw new Error('ProjectContext build scope resolves outside the canonical project root.');
  }
  const visit = (directory: string) => {
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
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (
        !MANIFEST_NAMES.has(entry.name) &&
        !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        absolutePath !== explicitPath
      ) {
        continue;
      }
      const stat = statSync(absolutePath, { bigint: true });
      const relativePath = path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
      const signature = [stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      const cached = hashCache.get(absolutePath);
      const hash =
        cached?.signature === signature ? cached.hash : digest(readFileSync(absolutePath));
      if (cached?.signature !== signature) {
        hashCache.set(absolutePath, { hash, signature });
      }
      records.push(
        [relativePath, '1', stat.size.toString(), stat.mtimeNs.toString(), hash].join('\0')
      );
    }
  };
  visit(projectRoot);
  if (explicitPath && !existsSync(explicitPath)) {
    records.push([path.relative(projectRoot, explicitPath), '0', '0', '0'].join('\0'));
  }
  return digest(records.sort().join('\n'));
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
