import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import {
  buildPluginGitDiffCheckpointScope,
  type PluginGitDiffCheckpointContainer,
} from '#recipe-pipeline/sustain/git-diff-checkpoint/DurableGitDiffCheckpointRouting.js';
import { resolveProjectScopeRuntime } from '#shared/project-scope-runtime.js';

export interface RetrievalCheckpointDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  domain: 'runtime';
  retryable: boolean;
}

export interface RetrievalCheckpointNextAction {
  tool: 'alembic_rescan';
  reason: string;
  required: boolean;
}

export interface RetrievalCheckpointPosture {
  available: boolean;
  checkpoint: {
    checkpointCommit: string | null;
    currentHead: string | null;
    lastRouteStatus: string | null;
    mergeBaseCommit: string | null;
    targetCommit: string | null;
  } | null;
  diagnostics: RetrievalCheckpointDiagnostic[];
  nextActions: RetrievalCheckpointNextAction[];
  reason: string | null;
  retrievalMayBeStale: boolean;
  status: 'current' | 'stale' | 'unavailable' | 'unknown';
}

type CheckpointRepository = {
  get(scope: {
    folderId: string;
    projectRoot: string;
    scopeId: string;
  }): Record<string, unknown> | null;
};

const INCOMPLETE_ROUTE_STATUSES = new Set(['failed', 'truncated', 'non-ancestor', 'unresolved']);

/**
 * posture 空间解析（2026-07-06 空间根修配套）：漂移维护 tick 已按 ProjectScope
 * folder 键控 checkpoint 行；prime/search/recipe_map 的新鲜度读取此前只传
 * projectRoot → scope 恒落 single-folder/root 死行（旧空间模型残留，永远不再被
 * tick 更新），truncated/unresolved 字面把检索永久钉在 degraded。这里与 tick 同源
 * 解析 folder identity，并把 HEAD 比较空间切到 folder 仓（workspace 根是 Wakeflow
 * 协作区仓，不是知识源）。无 ProjectScope 的单仓项目保持原行为。
 */
export function resolveRetrievalCheckpointPostureInput(projectRoot: string): {
  currentFolderId?: string | null;
  projectRoot: string;
  projectScopeId?: string | null;
  scanRoot?: string | null;
} {
  const runtime = resolveProjectScopeRuntime(projectRoot);
  if (!runtime) {
    return { projectRoot };
  }
  const summary = runtime.summary;
  const folderPath = summary.currentFolderPath ?? null;
  const within =
    typeof folderPath === 'string' &&
    isAbsolute(folderPath) &&
    !relative(projectRoot, folderPath).startsWith('..');
  return {
    currentFolderId: summary.currentFolderId ?? null,
    projectRoot,
    projectScopeId: summary.projectScopeId ?? null,
    scanRoot: within ? folderPath : null,
  };
}

export function buildRetrievalCheckpointPosture(
  container: PluginGitDiffCheckpointContainer,
  input: {
    currentFolderId?: string | null;
    projectRoot: string;
    projectScopeId?: string | null;
    /** folder 仓路径：HEAD 比较空间与 checkpoint 行同仓；缺省回退 projectRoot。 */
    scanRoot?: string | null;
  }
): RetrievalCheckpointPosture {
  const checkpointRepository = safeContainerGet(container, 'gitDiffCheckpointRepository');
  if (!hasGet(checkpointRepository)) {
    return emptyPosture('unavailable', 'gitDiffCheckpointRepository is unavailable.');
  }

  const scope = buildPluginGitDiffCheckpointScope(input);
  let row: Record<string, unknown> | null;
  try {
    row = (checkpointRepository as CheckpointRepository).get(scope);
  } catch (error: unknown) {
    return {
      ...emptyPosture(
        'unavailable',
        error instanceof Error
          ? `Git diff checkpoint could not be read: ${error.message}`
          : 'Git diff checkpoint could not be read.'
      ),
      diagnostics: [
        {
          code: 'retrieval-checkpoint-unavailable',
          domain: 'runtime',
          message: 'Git diff checkpoint could not be read; retrieval freshness is unknown.',
          retryable: true,
          severity: 'warning',
        },
      ],
    };
  }
  if (!row) {
    return emptyPosture('unavailable', 'No durable git diff checkpoint exists for this scope.');
  }

  const checkpointCommit = readString(row.checkpointCommit);
  const lastRouteStatus = readString(row.lastRouteStatus);
  const mergeBaseCommit = readString(row.mergeBaseCommit);
  const targetCommit = readString(row.targetCommit);
  const head = readCurrentGitHead(input.scanRoot ?? input.projectRoot);
  const diagnostics: RetrievalCheckpointDiagnostic[] = [];
  let retrievalMayBeStale = false;

  if (!head.ok) {
    retrievalMayBeStale = true;
    diagnostics.push({
      code: 'retrieval-checkpoint-head-unavailable',
      domain: 'runtime',
      message:
        'Git HEAD could not be resolved; retrieval may be stale until alembic_rescan confirms the current range.',
      retryable: true,
      severity: 'warning',
    });
  } else if (!checkpointCommit) {
    retrievalMayBeStale = true;
    diagnostics.push({
      code: 'retrieval-checkpoint-missing-commit',
      domain: 'runtime',
      message:
        'Git diff checkpoint has no committed baseline; retrieval may be stale until alembic_rescan records a route outcome.',
      retryable: true,
      severity: 'warning',
    });
  } else if (checkpointCommit !== head.head) {
    retrievalMayBeStale = true;
    diagnostics.push({
      code: 'retrieval-catch-up-needed',
      domain: 'runtime',
      message: `Git diff checkpoint ${shortCommit(checkpointCommit)} is behind current HEAD ${shortCommit(head.head)}; retrieval may be stale until alembic_rescan routes the range.`,
      retryable: true,
      severity: 'warning',
    });
  }

  // 基线已推进到当前 HEAD 时，行上残留的 INCOMPLETE 字面（如 resetBaseline 前落库的
  // unresolved/truncated）不再代表检索过期——skipped 轮不写库，字面要等下个真实
  // commit 才被覆盖；只有基线落后时该字面才有降级意义。
  const baselineCurrent = head.ok && checkpointCommit === head.head;
  if (lastRouteStatus && INCOMPLETE_ROUTE_STATUSES.has(lastRouteStatus) && !baselineCurrent) {
    retrievalMayBeStale = true;
    diagnostics.push({
      code: 'retrieval-checkpoint-route-incomplete',
      domain: 'runtime',
      message: `Last git diff route status is ${lastRouteStatus}; retrieval may be stale until alembic_rescan completes catch-up.`,
      retryable: true,
      severity: 'warning',
    });
  }

  const nextActions: RetrievalCheckpointNextAction[] = retrievalMayBeStale
    ? [
        {
          tool: 'alembic_rescan',
          reason:
            'Run alembic_rescan to route the durable git diff checkpoint before trusting retrieval freshness.',
          required: true,
        },
      ]
    : [];

  return {
    available: true,
    checkpoint: {
      checkpointCommit: checkpointCommit ?? null,
      currentHead: head.ok ? head.head : null,
      lastRouteStatus: lastRouteStatus ?? null,
      mergeBaseCommit: mergeBaseCommit ?? null,
      targetCommit: targetCommit ?? null,
    },
    diagnostics,
    nextActions,
    reason: retrievalMayBeStale
      ? 'Durable git diff checkpoint indicates retrieval may be stale.'
      : 'Durable git diff checkpoint is current for this scope.',
    retrievalMayBeStale,
    status: retrievalMayBeStale ? 'stale' : 'current',
  };
}

function emptyPosture(
  status: 'unavailable' | 'unknown',
  reason: string | null
): RetrievalCheckpointPosture {
  return {
    available: false,
    checkpoint: null,
    diagnostics: [],
    nextActions: [],
    reason,
    retrievalMayBeStale: false,
    status,
  };
}

function readCurrentGitHead(projectRoot: string): { ok: true; head: string } | { ok: false } {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return head ? { ok: true, head } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function safeContainerGet(container: PluginGitDiffCheckpointContainer, name: string): unknown {
  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function hasGet(value: unknown): value is CheckpointRepository {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).get === 'function'
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function shortCommit(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
