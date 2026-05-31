import type {
  GitDiffScanner,
  GitDiffScanResult,
} from '#service/evolution/git-diff-checkpoint/GitDiffScanner.js';

type GitDiffScannerLike = Pick<GitDiffScanner, 'scanOnce'>;

export type PluginOpportunisticEvolutionVerdict =
  | 'defer-to-alembic-service'
  | 'no-op'
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
    head: string | null;
    scanned: boolean;
    scannedAt: string;
    signature: string | null;
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
}

export interface BuildPluginOpportunisticEvolutionSurfaceInput {
  projectRoot: string;
  scanner?: GitDiffScannerLike;
  scan?: GitDiffScanResult;
  serviceGate: PluginOpportunisticEvolutionServiceGate;
  toolOutcome?: PluginOpportunisticEvolutionToolOutcome;
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
  };

  if (input.serviceGate.mainServiceCanHandleProjectScope) {
    return {
      ...base,
      evidenceGate: {
        verdict: 'defer-to-alembic-service',
        reasons: [
          'Alembic resident service can handle the current project scope; Plugin fallback is a no-op.',
        ],
      },
    };
  }

  const scan = input.scan ?? (await input.scanner?.scanOnce());
  if (!scan || !scan.scanned || scan.events.length === 0) {
    return {
      ...base,
      evidenceGate: {
        verdict: 'no-op',
        reasons: [
          scan?.scanned === false
            ? 'Git diff evidence is unavailable; Plugin fallback will not infer knowledge changes.'
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
  return input.toolName === 'alembic_task' && input.args.operation === 'close';
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
    head: scan.head,
    scanned: scan.scanned,
    scannedAt: scan.scannedAt,
    signature: scan.signature,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
