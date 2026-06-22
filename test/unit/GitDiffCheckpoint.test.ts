import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createInactiveGitDiffCheckpointStatus,
  GitDiffCheckpointService,
  GitDiffScanner,
  type GitDiffScanResult,
  type PluginGitDiffRouteReportSummary,
  recordPluginGitDiffCheckpointRouteOutcome,
  shouldIgnoreProjectPath,
  toProjectRelativePath,
} from '../../lib/recipe-generation/evolution/git-diff-checkpoint/index.js';

const tempDirs: string[] = [];

describe('Git diff checkpoint', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('does not ignore source directories that share generated-folder names', () => {
    expect(shouldIgnoreProjectPath('cache/build-state.json')).toBe(true);
    expect(shouldIgnoreProjectPath('dist/index.js')).toBe(true);
    expect(shouldIgnoreProjectPath('node_modules/pkg/index.js')).toBe(true);
    expect(shouldIgnoreProjectPath('.asd/state.json')).toBe(true);

    expect(shouldIgnoreProjectPath('src/cache/index.ts')).toBe(false);
    expect(shouldIgnoreProjectPath('lib/logs/parser.ts')).toBe(false);
    expect(shouldIgnoreProjectPath('packages/app/src/vendor/client.ts')).toBe(false);
  });

  test('normalizes absolute paths relative to the project root', () => {
    const projectRoot = join('/tmp', 'alembic-project');
    expect(toProjectRelativePath(join(projectRoot, 'src', 'index.ts'), projectRoot)).toBe(
      'src/index.ts'
    );
    expect(toProjectRelativePath('src/index.ts', projectRoot)).toBe('src/index.ts');
  });

  test('keeps disabled checkpoint status visible for diagnostics', () => {
    const status = createInactiveGitDiffCheckpointStatus(
      '/tmp/project',
      'disabled for test',
      false
    );

    expect(status).toMatchObject({
      enabled: false,
      healthy: false,
      mode: 'git-diff-checkpoint',
      projectRoot: '/tmp/project',
      reason: 'disabled for test',
      surface: 'codex-plugin',
    });
  });

  test('durable service initializes from active confirmed Plan and advances only routed ranges', () => {
    const checkpointRepository = createInMemoryCheckpointRepository();
    const planRepository = {
      getActiveConfirmed: vi.fn(() => ({ lastUpdatedFromCommit: 'plan-head' })),
    };
    const service = new GitDiffCheckpointService({
      checkpointRepository: checkpointRepository as never,
      planRepository: planRepository as never,
    });
    const scope = { folderId: 'root', projectRoot: '/repo', scopeId: 'single-folder' };

    const ensured = service.ensureCheckpoint({ ...scope, now: 1_000 });
    expect(ensured.source).toBe('active-confirmed-plan');
    expect(ensured.checkpoint.checkpointCommit).toBe('plan-head');

    const skipped = service.recordRouteOutcome({
      ...scope,
      routeStatus: 'skipped',
      scannedAt: 2_000,
      targetCommit: 'head-b',
    });
    expect(skipped).toMatchObject({
      advanced: false,
      unresolvedRange: { fromCommit: 'plan-head', toCommit: 'head-b' },
    });
    expect(skipped.checkpoint.checkpointCommit).toBe('plan-head');

    const routed = service.recordRouteOutcome({
      ...scope,
      routeStatus: 'routed',
      scannedAt: 3_000,
      targetCommit: 'head-b',
    });
    expect(routed).toMatchObject({
      advanced: true,
      unresolvedRange: null,
    });
    expect(routed.checkpoint.checkpointCommit).toBe('head-b');
  });

  test('durable service preserves unresolved non-ancestor and failed ranges', () => {
    const checkpointRepository = createInMemoryCheckpointRepository();
    const service = new GitDiffCheckpointService({
      checkpointRepository: checkpointRepository as never,
      planRepository: {
        getActiveConfirmed: vi.fn(() => ({ lastUpdatedFromCommit: 'plan-head' })),
      } as never,
    });
    const scope = { folderId: 'root', projectRoot: '/repo', scopeId: 'single-folder' };

    const nonAncestor = service.recordRouteOutcome({
      ...scope,
      mergeBaseCommit: 'merge-base',
      routeStatus: 'non-ancestor',
      scannedAt: 2_000,
      targetCommit: 'head-c',
    });
    const failed = service.recordRouteOutcome({
      ...scope,
      routeStatus: 'failed',
      scannedAt: 3_000,
      targetCommit: 'head-d',
    });

    expect(nonAncestor).toMatchObject({
      advanced: false,
      unresolvedRange: {
        fromCommit: 'plan-head',
        mergeBaseCommit: 'merge-base',
        toCommit: 'head-c',
      },
    });
    expect(failed).toMatchObject({
      advanced: false,
      unresolvedRange: { fromCommit: 'plan-head', toCommit: 'head-d' },
    });
    expect(failed.checkpoint.checkpointCommit).toBe('plan-head');
  });

  test('plugin route outcome advances only after successful catch-up routing', () => {
    const checkpointRepository = createInMemoryCheckpointRepository();
    const service = new GitDiffCheckpointService({
      checkpointRepository: checkpointRepository as never,
      planRepository: {
        getActiveConfirmed: vi.fn(() => ({ lastUpdatedFromCommit: 'plan-head' })),
      } as never,
    });
    const scope = { folderId: 'root', projectRoot: '/repo', scopeId: 'single-folder' };
    const runtime = {
      checkpointCommit: 'plan-head',
      initializationSource: 'active-confirmed-plan' as const,
      scope,
      service,
    };
    const scan = makeCatchUpScan();

    const skipped = recordPluginGitDiffCheckpointRouteOutcome({
      report: null,
      routeAttempted: false,
      routeError: null,
      runtime,
      scan,
    });
    expect(skipped).toMatchObject({
      advanced: false,
      checkpointCommit: 'plan-head',
      mergeBaseCommit: 'merge-base',
      routeStatus: 'skipped',
      unresolvedRange: {
        fromCommit: 'plan-head',
        mergeBaseCommit: 'merge-base',
        toCommit: 'head-c',
      },
    });

    const routedReport: PluginGitDiffRouteReportSummary = {
      deprecated: 0,
      fixed: 0,
      needsReview: 1,
      pendingProposals: [{ status: 'submitted' }],
      skipped: 0,
    };
    const routed = recordPluginGitDiffCheckpointRouteOutcome({
      report: routedReport,
      routeAttempted: true,
      routeError: null,
      runtime,
      scan,
    });

    expect(routed).toMatchObject({
      advanced: true,
      checkpointCommit: 'head-c',
      mergeBaseCommit: 'merge-base',
      routeStatus: 'catch-up-routed',
    });
    expect(routed.unresolvedRange).toBeUndefined();
  });

  test('scanner uses deterministic HEAD range diff with rename and copy detection', async () => {
    const execGit = createExecGitStub({
      currentHead: 'b',
      headDiff: 'R100\tsrc/old.ts\tsrc/new.ts\nC100\tsrc/base.ts\tsrc/copy.ts\n',
      mergeBase: 'a',
    });
    const scanner = new GitDiffScanner({ execGit, projectRoot: '/repo' });

    const result = await scanner.scanOnce(1_000, { previousHead: 'a' });

    expect(execGit).toHaveBeenCalledWith(
      ['diff', '--name-status', '-M90%', '-C90%', 'a..b'],
      '/repo'
    );
    expect(result).toMatchObject({
      dirtyPathCount: 2,
      headChanged: true,
      headRangeStatus: 'ancestor',
      mergeBase: 'a',
      truncated: false,
    });
    expect(result.events).toEqual([
      {
        eventSource: 'git-head',
        oldPath: 'src/old.ts',
        path: 'src/new.ts',
        type: 'renamed',
      },
      {
        eventSource: 'git-head',
        oldPath: 'src/base.ts',
        path: 'src/copy.ts',
        type: 'created',
      },
    ]);
  });

  test('scanner routes catch-up HEAD range when merge-base is not the previous checkpoint', async () => {
    const scanner = new GitDiffScanner({
      execGit: createExecGitStub({
        currentHead: 'b',
        headDiff: 'A\tsrc/committed.ts\n',
        mergeBase: 'base',
      }),
      projectRoot: '/repo',
    });

    const result = await scanner.scanOnce(1_000, { previousHead: 'a' });

    expect(result).toMatchObject({
      dirtyPathCount: 1,
      headChanged: true,
      headRangeStatus: 'non-ancestor',
      mergeBase: 'base',
      range: { from: 'base', to: 'b' },
    });
    expect(result.events).toEqual([
      {
        eventSource: 'git-head',
        path: 'src/committed.ts',
        type: 'created',
      },
    ]);
  });

  test('scanner applies scale guard before dispatching oversized diff batches', async () => {
    const scanner = new GitDiffScanner({
      execGit: createExecGitStub({
        currentHead: 'b',
        headDiff: 'A\tsrc/a.ts\nA\tsrc/b.ts\n',
        mergeBase: 'a',
      }),
      maxEvents: 1,
      projectRoot: '/repo',
    });

    const result = await scanner.scanOnce(1_000, { previousHead: 'a' });

    expect(result).toMatchObject({
      dirtyPathCount: 2,
      fallbackReason: 'scale-guard:2>1',
      maxEvents: 1,
      truncated: true,
    });
    expect(result.events).toEqual([
      {
        eventSource: 'git-head',
        path: 'src/a.ts',
        type: 'created',
      },
    ]);
  });

  test('scanner exposes git unavailable status for non-worktrees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alembic-git-diff-nongit-'));
    tempDirs.push(dir);
    const scanner = new GitDiffScanner({ projectRoot: dir });

    const result = await scanner.scanOnce(1_000);

    expect(result).toMatchObject({
      dirtyPathCount: 0,
      events: [],
      scanned: false,
      signature: null,
    });
    expect(scanner.getStatus()).toMatchObject({
      backend: 'git',
      healthy: false,
      lastError: 'project is not a git worktree',
    });
  });
});

function createInMemoryCheckpointRepository() {
  type Scope = { folderId: string; projectRoot: string; scopeId: string };
  type Record = Scope & {
    advancedAt: number | null;
    checkpointCommit: string | null;
    createdAt: number;
    initialFromPlanCommit: string | null;
    lastRouteReason: string | null;
    lastRouteStatus: string;
    lastScannedAt: number | null;
    mergeBaseCommit: string | null;
    targetCommit: string | null;
    updatedAt: number;
  };
  const rows = new Map<string, Record>();
  const key = (scope: Scope) => `${scope.projectRoot}\0${scope.scopeId}\0${scope.folderId}`;

  return {
    get(scope: Scope): Record | null {
      return rows.get(key(scope)) ?? null;
    },
    upsert(input: Scope & Partial<Record>): Record {
      const existing = rows.get(key(input));
      const now = input.updatedAt ?? Date.now();
      const row: Record = {
        advancedAt: input.advancedAt ?? null,
        checkpointCommit: input.checkpointCommit ?? null,
        createdAt: input.createdAt ?? existing?.createdAt ?? now,
        folderId: input.folderId,
        initialFromPlanCommit: input.initialFromPlanCommit ?? null,
        lastRouteReason: input.lastRouteReason ?? null,
        lastRouteStatus: input.lastRouteStatus ?? 'initialized',
        lastScannedAt: input.lastScannedAt ?? null,
        mergeBaseCommit: input.mergeBaseCommit ?? null,
        projectRoot: input.projectRoot,
        scopeId: input.scopeId,
        targetCommit: input.targetCommit ?? null,
        updatedAt: now,
      };
      rows.set(key(row), row);
      return row;
    },
  };
}

function makeCatchUpScan(): GitDiffScanResult {
  return {
    dirtyPathCount: 1,
    events: [
      {
        eventSource: 'git-head',
        path: 'src/committed.ts',
        type: 'modified',
      },
    ],
    head: 'head-c',
    headChanged: true,
    headRangeStatus: 'non-ancestor',
    maxEvents: 200,
    mergeBase: 'merge-base',
    previousHead: 'plan-head',
    range: { from: 'merge-base', to: 'head-c' },
    scanned: true,
    scannedAt: '2026-06-22T00:00:00.000Z',
    signature: 'sig',
    truncated: false,
  };
}

function createExecGitStub(input: {
  currentHead: string;
  headDiff: string;
  mergeBase: string;
}): (args: string[], cwd: string) => Promise<string> {
  return vi.fn(async (args: string[]) => {
    const key = args.join(' ');
    if (key === 'rev-parse --is-inside-work-tree') {
      return 'true\n';
    }
    if (key === 'rev-parse HEAD') {
      return `${input.currentHead}\n`;
    }
    if (key === `merge-base a ${input.currentHead}`) {
      return `${input.mergeBase}\n`;
    }
    if (key === `diff --name-status -M90% -C90% ${input.mergeBase}..${input.currentHead}`) {
      return input.headDiff;
    }
    return '';
  }) as (args: string[], cwd: string) => Promise<string>;
}
