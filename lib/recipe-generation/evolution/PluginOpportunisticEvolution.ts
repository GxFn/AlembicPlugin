import type { UnifiedEvolutionReport } from '#recipe-generation/evolution/FileChangeHandler.js';
import type {
  GitDiffScanner,
  GitDiffScanResult,
} from '#recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';

type GitDiffScannerLike = Pick<GitDiffScanner, 'scanOnce'>;

export type PluginOpportunisticEvolutionVerdict =
  | 'defer-to-alembic-service'
  | 'no-op'
  | 'routed'
  | 'strong-proposal'
  | 'weak-hint';

export interface PluginOpportunisticEvolutionToolOutcome {
  reason?: string | null;
  success: boolean;
  taskId?: string | null;
  tool: string;
}

export interface PluginOpportunisticEvolutionServiceGate {
  mainServiceCanHandleProjectScope: boolean;
  reason: string;
  residentProjectScopeAvailable: boolean;
}

export interface PluginOpportunisticEvolutionGuardDecision {
  action: 'run' | 'skip';
  reasonCode: string;
  taskScopedFiles: string[];
}

export interface PluginOpportunisticEvolutionSurface {
  autoSubmit: false;
  evidenceGate: {
    reasons: string[];
    verdict: PluginOpportunisticEvolutionVerdict;
  };
  gitDiffEvidence?: {
    dirtyPathCount: number;
    eventCount: number;
    events: Array<{
      eventSource?: string;
      oldPath?: string;
      path: string;
      type: string;
    }>;
    fallbackReason?: string;
    head: string | null;
    headChanged: boolean;
    headRangeStatus: string;
    previousHead: string | null;
    range?: {
      from: string;
      to: string;
    };
    scanned: boolean;
    scannedAt: string;
    signature: string | null;
    truncated: boolean;
  };
  hint?: {
    message: string;
    sourceRefs: string[];
  };
  producerBoundary: {
    producerKind: 'plugin-opportunistic';
    separatedFrom: 'daemon-file-change';
  };
  proposal?: {
    confidence: number;
    kind: 'knowledge-evolution-proposal';
    message: string;
    producerKind: 'plugin-opportunistic';
    sourceRefs: string[];
    toolOutcome: PluginOpportunisticEvolutionToolOutcome;
  };
  serviceGate: PluginOpportunisticEvolutionServiceGate;
  trigger: {
    tool: string | null;
    reason: string;
  };
  unifiedEvolution?: {
    classificationCounts: UnifiedEvolutionReport['classificationCounts'];
    deprecated: number;
    fixed: number;
    freshness?: UnifiedEvolutionReport['freshness'];
    needsReview: number;
    planBoundary: UnifiedEvolutionReport['planBoundary'];
    recommendations: UnifiedEvolutionReport['recommendations'];
    skipped: number;
    suggestReview: boolean;
  };
}

export interface BuildPluginOpportunisticEvolutionSurfaceInput {
  guardDecision?: PluginOpportunisticEvolutionGuardDecision;
  projectRoot: string;
  scanner?: GitDiffScannerLike;
  scan?: GitDiffScanResult;
  serviceGate: PluginOpportunisticEvolutionServiceGate;
  toolOutcome?: PluginOpportunisticEvolutionToolOutcome;
  unifiedEvolution?: UnifiedEvolutionReport | null;
}

export async function buildPluginOpportunisticEvolutionSurface(
  input: BuildPluginOpportunisticEvolutionSurfaceInput
): Promise<PluginOpportunisticEvolutionSurface> {
  const base = {
    autoSubmit: false as const,
    producerBoundary: {
      producerKind: 'plugin-opportunistic' as const,
      separatedFrom: 'daemon-file-change' as const,
    },
    serviceGate: input.serviceGate,
    trigger: {
      tool: input.toolOutcome?.tool ?? null,
      reason: 'commit-driven-unified-evolution',
    },
  };

  const scan = filterScanToTaskScopedFiles(
    input.scan ?? (await input.scanner?.scanOnce()),
    input.guardDecision?.taskScopedFiles
  );

  if (input.serviceGate.mainServiceCanHandleProjectScope && !scan?.headChanged) {
    return {
      ...base,
      ...(scan ? { gitDiffEvidence: projectGitDiffEvidence(scan) } : {}),
      evidenceGate: {
        verdict: 'defer-to-alembic-service',
        reasons: [
          'Alembic resident service can handle the current project scope and no HEAD range changed; Plugin fallback is a no-op.',
        ],
      },
    };
  }

  if (input.guardDecision && input.guardDecision.action !== 'run') {
    return {
      ...base,
      evidenceGate: {
        verdict: 'no-op',
        reasons: [
          `Task close skipped task-scoped Guard (${input.guardDecision.reasonCode}); Plugin opportunistic evolution will not infer knowledge changes from unrelated dirty diff.`,
        ],
      },
    };
  }

  if (!scan || !scan.scanned || scan.events.length === 0) {
    return {
      ...base,
      evidenceGate: {
        verdict: 'no-op',
        reasons: [
          scan?.scanned === false
            ? 'Git diff evidence is unavailable; Plugin fallback will not infer knowledge changes.'
            : scan?.fallbackReason
              ? `Git diff evidence produced no dispatchable events (${scan.fallbackReason}).`
              : 'No git diff evidence was found; Plugin fallback has nothing to surface.',
        ],
      },
      ...(scan ? { gitDiffEvidence: projectGitDiffEvidence(scan) } : {}),
    };
  }

  const sourceRefs = uniqueStrings(scan.events.map((event) => event.path));
  const hasProjectScope = input.projectRoot.trim().length > 0;
  const hasFileEvidence = sourceRefs.length > 0;
  const hasToolOutcome = input.toolOutcome?.success === true;
  const reasons = [
    input.serviceGate.reason,
    `git diff surfaced ${sourceRefs.length} changed path(s)`,
    hasToolOutcome
      ? `tool outcome available from ${input.toolOutcome?.tool}`
      : 'tool outcome evidence is missing or unsuccessful',
  ];

  if (scan.fallbackReason) {
    reasons.push(`fallback reason: ${scan.fallbackReason}`);
  }

  if (input.unifiedEvolution) {
    return {
      ...base,
      evidenceGate: { verdict: 'routed', reasons },
      gitDiffEvidence: projectGitDiffEvidence(scan),
      unifiedEvolution: summarizeUnifiedEvolution(input.unifiedEvolution),
    };
  }

  if (hasProjectScope && hasFileEvidence && hasToolOutcome && input.toolOutcome) {
    return {
      ...base,
      evidenceGate: { verdict: 'strong-proposal', reasons },
      gitDiffEvidence: projectGitDiffEvidence(scan),
      proposal: {
        confidence: confidenceForDiff(scan),
        kind: 'knowledge-evolution-proposal',
        message:
          'Plugin fallback found scoped git diff evidence after a successful host-agent tool outcome. Review the changed files and explicitly submit/evolve knowledge if warranted.',
        producerKind: 'plugin-opportunistic',
        sourceRefs,
        toolOutcome: input.toolOutcome,
      },
    };
  }

  return {
    ...base,
    evidenceGate: { verdict: 'weak-hint', reasons },
    gitDiffEvidence: projectGitDiffEvidence(scan),
    hint: {
      message:
        'Plugin fallback found git diff evidence but not enough scoped tool outcome evidence for a strong proposal.',
      sourceRefs,
    },
  };
}

export function shouldAttachPluginOpportunisticEvolution(input: {
  args: Record<string, unknown>;
  toolName: string;
}): boolean {
  void input.args;
  return COMMIT_DRIVEN_TRIGGER_TOOLS.has(input.toolName);
}

const COMMIT_DRIVEN_TRIGGER_TOOLS = new Set([
  'alembic_bootstrap',
  'alembic_code_guard',
  'alembic_consolidate',
  'alembic_dimension_complete',
  'alembic_evolve',
  'alembic_knowledge_lifecycle',
  'alembic_plan',
  'alembic_rescan',
  'alembic_submit_knowledge',
  'alembic_work',
]);

export function extractTaskCloseGuardDecision(
  result: unknown
): PluginOpportunisticEvolutionGuardDecision | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const data = isRecord(result.data) ? result.data : {};
  const guardDecision = isRecord(data.guardDecision)
    ? data.guardDecision
    : isRecord(data.nextAction) && isRecord(data.nextAction.guardDecision)
      ? data.nextAction.guardDecision
      : null;
  if (!guardDecision) {
    return undefined;
  }
  const action = guardDecision.action === 'run' ? 'run' : 'skip';
  const reasonCode =
    typeof guardDecision.reasonCode === 'string' && guardDecision.reasonCode.trim()
      ? guardDecision.reasonCode.trim()
      : 'unknown';
  return {
    action,
    reasonCode,
    taskScopedFiles: normalizeSourceRefs(guardDecision.taskScopedFiles),
  };
}

export function extractTaskCloseOutcome(
  result: unknown
): PluginOpportunisticEvolutionToolOutcome | null {
  if (!isRecord(result) || result.success === false) {
    return null;
  }
  const data = isRecord(result.data) ? result.data : {};
  const closed = isRecord(data.closed) ? data.closed : null;
  if (!closed) {
    return null;
  }
  return {
    tool: 'alembic_task',
    success: true,
    taskId: typeof closed.id === 'string' ? closed.id : null,
    reason: typeof closed.reason === 'string' ? closed.reason : null,
  };
}

export function extractPluginToolOutcome(
  toolName: string,
  result: unknown
): PluginOpportunisticEvolutionToolOutcome | null {
  if (!isRecord(result) || result.success === false) {
    return null;
  }
  return {
    tool: toolName,
    success: true,
    reason: typeof result.message === 'string' ? result.message : null,
  };
}

function filterScanToTaskScopedFiles(
  scan: GitDiffScanResult | undefined,
  taskScopedFiles: string[] | undefined
): GitDiffScanResult | undefined {
  if (!scan || !taskScopedFiles || taskScopedFiles.length === 0) {
    return scan;
  }
  const scoped = new Set(normalizeSourceRefs(taskScopedFiles));
  const events = scan.events.filter((event) => scoped.has(normalizeSourceRef(event.path)));
  return {
    ...scan,
    dirtyPathCount: events.length,
    events,
  };
}

function projectGitDiffEvidence(
  scan: GitDiffScanResult
): NonNullable<PluginOpportunisticEvolutionSurface['gitDiffEvidence']> {
  return {
    dirtyPathCount: scan.dirtyPathCount,
    eventCount: scan.events.length,
    events: scan.events.map((event) => ({
      eventSource: event.eventSource,
      oldPath: event.oldPath,
      path: event.path,
      type: event.type,
    })),
    ...(scan.fallbackReason ? { fallbackReason: scan.fallbackReason } : {}),
    head: scan.head,
    headChanged: scan.headChanged,
    headRangeStatus: scan.headRangeStatus,
    previousHead: scan.previousHead,
    ...(scan.range ? { range: scan.range } : {}),
    scanned: scan.scanned,
    scannedAt: scan.scannedAt,
    signature: scan.signature,
    truncated: scan.truncated,
  };
}

function summarizeUnifiedEvolution(
  report: UnifiedEvolutionReport
): NonNullable<PluginOpportunisticEvolutionSurface['unifiedEvolution']> {
  return {
    classificationCounts: report.classificationCounts,
    deprecated: report.deprecated,
    fixed: report.fixed,
    ...(report.freshness ? { freshness: report.freshness } : {}),
    needsReview: report.needsReview,
    planBoundary: report.planBoundary,
    recommendations: report.recommendations,
    skipped: report.skipped,
    suggestReview: report.suggestReview,
  };
}

function confidenceForDiff(scan: GitDiffScanResult): number {
  const hasDeletion = scan.events.some((event) => event.type === 'deleted');
  const hasModification = scan.events.some((event) => event.type === 'modified');
  if (hasDeletion) {
    return 0.78;
  }
  if (hasModification) {
    return 0.72;
  }
  return 0.66;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizeSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeSourceRef)
      .filter(Boolean)
  );
}

function normalizeSourceRef(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
