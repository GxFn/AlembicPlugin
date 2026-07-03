import {
  createCurrentGitHeadBaselineProvider,
  type GitDiffCheckpointRouteStatus,
  type GitDiffCheckpointScope,
  GitDiffCheckpointService,
  type RecordGitDiffCheckpointRouteResult,
} from '@alembic/core/evolution';
import type { GitDiffScanResult } from './GitDiffScanner.js';

type GitDiffCheckpointRepositories = ConstructorParameters<typeof GitDiffCheckpointService>[0];

export interface PluginGitDiffCheckpointContainer {
  get(name: string): unknown;
}

export interface PluginGitDiffCheckpointRuntime {
  checkpointCommit: string | null;
  initializationSource: 'existing-checkpoint' | 'current-head' | 'empty';
  scope: GitDiffCheckpointScope;
  service: GitDiffCheckpointService;
}

export interface PluginGitDiffCheckpointSurface {
  advanced: boolean;
  checkpointCommit: string | null;
  initializationSource?: PluginGitDiffCheckpointRuntime['initializationSource'];
  mergeBaseCommit?: string | null;
  recorded: boolean;
  reason: string;
  routeStatus?: GitDiffCheckpointRouteStatus;
  scope: GitDiffCheckpointScope;
  unresolvedRange?: RecordGitDiffCheckpointRouteResult['unresolvedRange'];
}

export interface PluginGitDiffRouteReportSummary {
  deprecated: number;
  fixed: number;
  needsReview: number;
  skipped: number;
  generationChangeLog?: readonly unknown[];
  moduleMiningRoutes?: readonly { status?: string }[];
  pendingProposals?: readonly { status?: string }[];
}

export function createPluginGitDiffCheckpointRuntime(
  container: PluginGitDiffCheckpointContainer,
  input: {
    currentFolderId?: string | null;
    projectRoot: string;
    projectScopeId?: string | null;
  }
): PluginGitDiffCheckpointRuntime | null {
  const checkpointRepository = safeContainerGet(container, 'gitDiffCheckpointRepository');
  if (!hasFunctions(checkpointRepository, ['get', 'upsert'])) {
    return null;
  }

  const service = new GitDiffCheckpointService({
    checkpointRepository:
      checkpointRepository as unknown as GitDiffCheckpointRepositories['checkpointRepository'],
    baselineProvider: createCurrentGitHeadBaselineProvider(),
  });
  const scope = buildPluginGitDiffCheckpointScope(input);
  const ensured = service.ensureCheckpoint(scope);
  return {
    checkpointCommit: ensured.checkpoint.checkpointCommit,
    initializationSource: ensured.source,
    scope,
    service,
  };
}

export function buildPluginGitDiffCheckpointScope(input: {
  currentFolderId?: string | null;
  projectRoot: string;
  projectScopeId?: string | null;
}): GitDiffCheckpointScope {
  return {
    folderId: normalizeCheckpointScopeId(input.currentFolderId) ?? 'root',
    projectRoot: input.projectRoot,
    scopeId: normalizeCheckpointScopeId(input.projectScopeId) ?? 'single-folder',
  };
}

export function recordPluginGitDiffCheckpointRouteOutcome(input: {
  report: PluginGitDiffRouteReportSummary | null;
  routeAttempted: boolean;
  routeError: string | null;
  runtime: PluginGitDiffCheckpointRuntime;
  scan: GitDiffScanResult;
}): PluginGitDiffCheckpointSurface {
  const routeStatus = resolveRouteStatus(input);
  if (!routeStatus || !input.scan.head) {
    return {
      advanced: false,
      checkpointCommit: input.runtime.checkpointCommit,
      initializationSource: input.runtime.initializationSource,
      recorded: false,
      reason: input.scan.head
        ? 'Git diff scan did not produce a route outcome.'
        : 'Git diff scan did not resolve a target HEAD commit.',
      scope: input.runtime.scope,
    };
  }
  if (
    routeStatus === 'skipped' &&
    input.scan.events.length === 0 &&
    input.runtime.checkpointCommit === input.scan.head
  ) {
    return {
      advanced: false,
      checkpointCommit: input.runtime.checkpointCommit,
      initializationSource: input.runtime.initializationSource,
      mergeBaseCommit: input.scan.mergeBase,
      recorded: false,
      reason:
        'Git diff scan is already at the current checkpoint HEAD with no dispatchable file events; preserving the previous durable route outcome.',
      routeStatus,
      scope: input.runtime.scope,
    };
  }

  const result = input.runtime.service.recordRouteOutcome({
    ...input.runtime.scope,
    routeReason: buildRouteReason(routeStatus, input),
    routeStatus,
    scannedAt: Date.parse(input.scan.scannedAt),
    mergeBaseCommit: input.scan.mergeBase,
    targetCommit: input.scan.head,
  });
  return {
    advanced: result.advanced,
    checkpointCommit: result.checkpoint.checkpointCommit,
    initializationSource: input.runtime.initializationSource,
    mergeBaseCommit: result.checkpoint.mergeBaseCommit,
    recorded: true,
    reason: result.reason,
    routeStatus,
    scope: input.runtime.scope,
    ...(result.unresolvedRange ? { unresolvedRange: result.unresolvedRange } : {}),
  };
}

function resolveRouteStatus(input: {
  report: PluginGitDiffRouteReportSummary | null;
  routeAttempted: boolean;
  routeError: string | null;
  scan: GitDiffScanResult;
}): GitDiffCheckpointRouteStatus | null {
  const scan = input.scan;
  const isCatchUpRange =
    scan.headChanged && scan.headRangeStatus === 'non-ancestor' && Boolean(scan.mergeBase);
  if (!scan.scanned) {
    return scan.head ? 'failed' : null;
  }
  if (scan.truncated) {
    return 'truncated';
  }
  if (scan.headChanged && scan.headRangeStatus === 'unavailable') {
    return 'unresolved';
  }
  if (scan.headChanged && scan.headRangeStatus === 'non-ancestor' && !scan.mergeBase) {
    return 'non-ancestor';
  }
  if (scan.events.length === 0 || !input.routeAttempted) {
    return 'skipped';
  }
  if (input.routeError) {
    return 'failed';
  }
  if (input.report && reportOnlySkipped(input.report, scan.events.length)) {
    return 'skipped';
  }
  if (!input.report) {
    return 'failed';
  }
  return isCatchUpRange ? 'catch-up-routed' : 'routed';
}

function buildRouteReason(
  status: GitDiffCheckpointRouteStatus,
  input: {
    report: PluginGitDiffRouteReportSummary | null;
    routeError: string | null;
    scan: GitDiffScanResult;
  }
): string {
  if (status === 'routed') {
    return 'Plugin commit-driven unified evolution routed the git diff range successfully.';
  }
  if (status === 'catch-up-routed') {
    return `Plugin commit-driven unified evolution routed catch-up range ${formatScanRange(input.scan)} successfully.`;
  }
  if (input.routeError) {
    return `Plugin commit-driven unified evolution route failed: ${input.routeError}`;
  }
  if (status === 'skipped') {
    return input.scan.events.length === 0
      ? 'Git diff scan produced no dispatchable file events.'
      : 'Unified evolution report classified the routed events as skipped.';
  }
  if (status === 'truncated') {
    return input.scan.fallbackReason ?? 'Git diff scan was truncated by scale guard.';
  }
  if (status === 'non-ancestor') {
    return (
      input.scan.fallbackReason ??
      'Previous git diff checkpoint is not an ancestor of the target HEAD.'
    );
  }
  if (status === 'unresolved') {
    return input.scan.fallbackReason ?? 'Git diff HEAD range could not be resolved.';
  }
  return 'Git diff route did not complete.';
}

function formatScanRange(scan: GitDiffScanResult): string {
  if (scan.range) {
    return `${scan.range.from}..${scan.range.to}`;
  }
  if (scan.mergeBase && scan.head) {
    return `${scan.mergeBase}..${scan.head}`;
  }
  return 'merge-base..HEAD';
}

function reportOnlySkipped(report: PluginGitDiffRouteReportSummary, eventCount: number): boolean {
  return (
    report.skipped >= eventCount &&
    report.fixed === 0 &&
    report.deprecated === 0 &&
    report.needsReview === 0 &&
    (report.pendingProposals?.length ?? 0) === 0 &&
    (report.moduleMiningRoutes?.length ?? 0) === 0 &&
    (report.generationChangeLog?.length ?? 0) === 0
  );
}

function safeContainerGet(
  container: PluginGitDiffCheckpointContainer,
  serviceName: string
): unknown {
  try {
    return container.get(serviceName);
  } catch {
    return null;
  }
}

function hasFunctions(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

function normalizeCheckpointScopeId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
