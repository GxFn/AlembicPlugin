import type {
  GitDiffScanner,
  GitDiffScanResult,
} from '#recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import type { UnifiedEvolutionReport } from '#recipe-generation/evolution/HostAgentFileChangeHandler.js';

type GitDiffScannerLike = Pick<GitDiffScanner, 'scanOnce'>;

export type PluginOpportunisticEvolutionVerdict = 'defer-to-alembic-service' | 'no-op' | 'routed';

export interface PluginOpportunisticEvolutionToolOutcome {
  reason?: string | null;
  success: boolean;
  taskId?: string | null;
  tool: string;
}

export interface PluginOpportunisticEvolutionServiceGate {
  reason: string;
  residentProjectScopeAvailable: boolean;
  // UM#3：改名自旧的服务门「主服务可否接管 ProjectScope」位。语义固化为「resident 检索增强是否就绪」——
  // resident（常驻）ProjectScope 只做检索增强，没有活的 evolution、不是 commit-driven 维护的对端；
  // 该位仅用于 surface 的「无 HEAD 变化时把 Plugin fallback 去抖为 no-op」(resident 检索增强去抖)，
  // 不代表 resident 会接管维护。commit-driven 维护始终由本链路（GitDiffCheckpoint→HostAgentFileChangeHandler）执行。
  residentSearchEnhancementReady: boolean;
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
    mergeBase: string | null;
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
  checkpoint?: {
    advanced: boolean;
    checkpointCommit: string | null;
    mergeBaseCommit?: string | null;
    recorded: boolean;
    reason: string;
    routeStatus?: string;
    scope: {
      folderId: string;
      projectRoot: string;
      scopeId: string;
    };
    unresolvedRange?: {
      fromCommit: string | null;
      mergeBaseCommit: string | null;
      toCommit: string;
    } | null;
  };
  producerBoundary: {
    producerKind: 'plugin-opportunistic';
    separatedFrom: 'daemon-file-change';
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
    generationChangeLog: UnifiedEvolutionReport['generationChangeLog'];
    moduleMiningRoutes: UnifiedEvolutionReport['moduleMiningRoutes'];
    needsReview: number;
    pendingProposals: UnifiedEvolutionReport['pendingProposals'];
    planBoundary: UnifiedEvolutionReport['planBoundary'];
    skipped: number;
    suggestReview: boolean;
  };
}

export interface BuildPluginOpportunisticEvolutionSurfaceInput {
  checkpoint?: PluginOpportunisticEvolutionSurface['checkpoint'];
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
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
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

  // UM#3：resident 检索增强去抖（非维护对端）。仅当 resident 检索增强就绪且本次无 HEAD range 变化时，
  // 把 Plugin fallback surface 去抖为 no-op（resident 已能服务该 scope 的检索，无新提交需维护）。
  // 一旦 HEAD 变化（有新 commit），即走 commit-driven 维护链路，不被该去抖拦截。
  if (input.serviceGate.residentSearchEnhancementReady && !scan?.headChanged) {
    return {
      ...base,
      ...(scan ? { gitDiffEvidence: projectGitDiffEvidence(scan) } : {}),
      evidenceGate: {
        verdict: 'defer-to-alembic-service',
        reasons: [
          'Resident retrieval-enhancement is ready for this project scope and no HEAD range changed; Plugin commit-driven maintenance has nothing new to route, so this fallback surface is a no-op.',
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

  return {
    ...base,
    evidenceGate: {
      verdict: 'no-op',
      reasons: [
        ...reasons,
        'Git diff evidence was not routed to unified evolution; Plugin fallback stays no-op.',
      ],
    },
    gitDiffEvidence: projectGitDiffEvidence(scan),
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
    mergeBase: scan.mergeBase,
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
    generationChangeLog: report.generationChangeLog,
    moduleMiningRoutes: report.moduleMiningRoutes,
    needsReview: report.needsReview,
    pendingProposals: report.pendingProposals,
    planBoundary: report.planBoundary,
    skipped: report.skipped,
    suggestReview: report.suggestReview,
  };
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
