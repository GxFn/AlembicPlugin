import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { buildGitDiffCheckpointScope } from '@alembic/core/evolution';
import type { PluginGitDiffCheckpointContainer } from '#recipe-pipeline/sustain/git-diff-checkpoint/DurableGitDiffCheckpointRouting.js';
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
  sourceRevisionManifest: SourceRevisionManifest | null;
  status: 'current' | 'stale' | 'unavailable' | 'unknown';
}

export interface SourceRevisionManifest {
  alignment: 'current' | 'stale' | 'unknown';
  completeness: 'complete' | 'incomplete';
  identityAlignment: 'current' | 'mismatch' | 'unknown';
  projectId: string | null;
  projectScopeId: string | null;
  rows: Array<{
    checkpointCommit: string | null;
    currentCommit: string | null;
    dirty: boolean | null;
    folderId: string;
    repositoryId: string | null;
    scannedAt: string | null;
    status: 'current' | 'dirty' | 'missing-checkpoint' | 'stale' | 'unknown';
  }>;
}

interface SourceRevisionFolder {
  folderId: string;
  path: string;
  repositoryId: string | null;
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
  projectScopeFolderCount?: number;
  projectScopeFolders?: SourceRevisionFolder[];
  projectId?: string | null;
  projectScopeId?: string | null;
  scanRoot?: string | null;
} {
  const runtime = resolveProjectScopeRuntime(projectRoot);
  if (!runtime) {
    return { projectRoot };
  }
  const summary = runtime.summary;
  // summary.currentFolderId 由"projectRoot 是否匹配某个 folder 路径"决定——控制器
  // workspace 根不是任何 folder，匹配恒空；tick（HostMcpServer executionContext）用的
  // 是 scope 注册的 currentFolderId 指针。此处同源回退到 descriptor 指针，否则 scope
  // 落到不存在的 checkpoint 行（真机 2026-07-06：posture 恒 unavailable，读不到 folder 行）。
  const folderId = summary.currentFolderId ?? runtime.descriptor.currentFolderId ?? null;
  const folderPath =
    summary.currentFolderPath ??
    summary.folders.find((folder) => folder.folderId === folderId)?.path ??
    null;
  const canonicalProjectRoot = summary.controlRoot;
  const within =
    typeof folderPath === 'string' &&
    isAbsolute(folderPath) &&
    !relative(canonicalProjectRoot, folderPath).startsWith('..');
  return {
    currentFolderId: folderId,
    projectRoot: canonicalProjectRoot,
    projectScopeFolderCount: summary.folders.length,
    projectScopeFolders: summary.folders.map((folder) => ({
      folderId: folder.folderId,
      path: folder.path,
      repositoryId: folder.repositoryId,
    })),
    projectId: runtime.descriptor.projectId ?? null,
    projectScopeId: summary.projectScopeId ?? null,
    scanRoot: within ? folderPath : null,
  };
}

export function buildRetrievalCheckpointPosture(
  container: PluginGitDiffCheckpointContainer,
  input: {
    currentFolderId?: string | null;
    projectRoot: string;
    /** 多仓 scope 在 P3 revision vector 落地前不能由任意单行 checkpoint 证明 current。 */
    projectScopeFolderCount?: number;
    projectScopeFolders?: SourceRevisionFolder[];
    projectId?: string | null;
    projectScopeId?: string | null;
    /** folder 仓路径：HEAD 比较空间与 checkpoint 行同仓；缺省回退 projectRoot。 */
    scanRoot?: string | null;
  }
): RetrievalCheckpointPosture {
  const checkpointRepository = safeContainerGet(container, 'gitDiffCheckpointRepository');
  if (!hasGet(checkpointRepository)) {
    return emptyPosture('unavailable', 'gitDiffCheckpointRepository is unavailable.');
  }

  const scope = buildGitDiffCheckpointScope(input);
  const sourceRevisionManifest = buildSourceRevisionManifest(
    checkpointRepository as CheckpointRepository,
    input
  );
  let row: Record<string, unknown> | null;
  try {
    const currentFolderPath =
      input.projectScopeFolders?.find((folder) => folder.folderId === scope.folderId)?.path ??
      input.scanRoot ??
      null;
    row = readCheckpointWithLegacyFallback(
      checkpointRepository as CheckpointRepository,
      scope,
      currentFolderPath
    );
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
    if (sourceRevisionManifest) {
      const diagnostics = sourceRevisionManifest.rows
        .filter((item) => item.status !== 'current')
        .map(
          (manifestRow): RetrievalCheckpointDiagnostic => ({
            code: 'source-revision-row-misaligned',
            domain: 'runtime',
            message: `Source revision row ${manifestRow.repositoryId ?? manifestRow.folderId} is ${manifestRow.status}; retrieval cannot be current until every repository row is clean and checkpoint-aligned.`,
            retryable: true,
            severity: 'warning',
          })
        );
      return {
        available: false,
        checkpoint: null,
        diagnostics,
        nextActions: [
          {
            tool: 'alembic_rescan',
            reason: 'Run alembic_rescan to record every missing source revision checkpoint row.',
            required: true,
          },
        ],
        reason: 'The current source revision row is missing from the project manifest.',
        retrievalMayBeStale: true,
        sourceRevisionManifest,
        status: sourceRevisionManifest.alignment === 'unknown' ? 'unknown' : 'stale',
      };
    }
    return emptyPosture('unavailable', 'No durable git diff checkpoint exists for this scope.');
  }

  const checkpointCommit = readString(row.checkpointCommit);
  const lastRouteStatus = readString(row.lastRouteStatus);
  const mergeBaseCommit = readString(row.mergeBaseCommit);
  const targetCommit = readString(row.targetCommit);
  const head = readCurrentGitHead(input.scanRoot ?? input.projectRoot);
  const diagnostics: RetrievalCheckpointDiagnostic[] = [];
  let retrievalMayBeStale = false;
  const scalarMultiRepoCheckpoint =
    (input.projectScopeFolderCount ?? 0) > 1 && (input.projectScopeFolders?.length ?? 0) === 0;

  if (sourceRevisionManifest && sourceRevisionManifest.alignment !== 'current') {
    retrievalMayBeStale = true;
    for (const row of sourceRevisionManifest.rows.filter((item) => item.status !== 'current')) {
      diagnostics.push({
        code: 'source-revision-row-misaligned',
        domain: 'runtime',
        message: `Source revision row ${row.repositoryId ?? row.folderId} is ${row.status}; retrieval cannot be current until every repository row is clean and checkpoint-aligned.`,
        retryable: true,
        severity: 'warning',
      });
    }
  }

  if (scalarMultiRepoCheckpoint) {
    retrievalMayBeStale = true;
    diagnostics.push({
      code: 'retrieval-checkpoint-scalar-project-scope',
      domain: 'runtime',
      message: `A scalar checkpoint cannot prove freshness for a ProjectScope with ${input.projectScopeFolderCount} repositories; retrieval freshness remains unknown until a complete revision vector is recorded.`,
      retryable: true,
      severity: 'warning',
    });
  }

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
    reason: scalarMultiRepoCheckpoint
      ? 'Multi-repo retrieval freshness is unknown because only a scalar checkpoint is available.'
      : retrievalMayBeStale
        ? 'Durable git diff checkpoint indicates retrieval may be stale.'
        : 'Durable git diff checkpoint is current for this scope.',
    retrievalMayBeStale,
    sourceRevisionManifest,
    status: scalarMultiRepoCheckpoint
      ? 'unknown'
      : sourceRevisionManifest?.alignment === 'unknown'
        ? 'unknown'
        : retrievalMayBeStale
          ? 'stale'
          : 'current',
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
    sourceRevisionManifest: null,
    status,
  };
}

function buildSourceRevisionManifest(
  repository: CheckpointRepository,
  input: {
    currentFolderId?: string | null;
    projectRoot: string;
    projectScopeFolders?: SourceRevisionFolder[];
    projectId?: string | null;
    projectScopeId?: string | null;
    scanRoot?: string | null;
  }
): SourceRevisionManifest | null {
  const folders =
    input.projectScopeFolders && input.projectScopeFolders.length > 0
      ? input.projectScopeFolders
      : [
          {
            folderId: input.currentFolderId ?? 'root',
            path: input.scanRoot ?? input.projectRoot,
            repositoryId: input.projectId ?? input.currentFolderId ?? 'root',
          },
        ];
  const rows = folders.map((folder) => {
    let checkpoint: Record<string, unknown> | null = null;
    try {
      const canonicalScope = buildGitDiffCheckpointScope({
        currentFolderId: folder.folderId,
        projectRoot: input.projectRoot,
        projectScopeId: input.projectScopeId,
      });
      checkpoint = readCheckpointWithLegacyFallback(repository, canonicalScope, folder.path);
    } catch {
      checkpoint = null;
    }
    const current = readCurrentGitState(folder.path);
    const checkpointCommit = readString(checkpoint?.checkpointCommit) ?? null;
    const status = !current.head
      ? ('unknown' as const)
      : current.dirty
        ? ('dirty' as const)
        : !checkpointCommit
          ? ('missing-checkpoint' as const)
          : checkpointCommit === current.head
            ? ('current' as const)
            : ('stale' as const);
    return {
      checkpointCommit,
      currentCommit: current.head,
      dirty: current.dirty,
      folderId: folder.folderId,
      repositoryId: folder.repositoryId,
      scannedAt: readTimestamp(checkpoint?.lastScannedAt ?? checkpoint?.updatedAt),
      status,
    };
  });
  const complete = rows.every(
    (row) => row.currentCommit !== null && row.checkpointCommit !== null && row.dirty !== null
  );
  return {
    alignment: rows.every((row) => row.status === 'current')
      ? 'current'
      : rows.some((row) => row.status === 'unknown')
        ? 'unknown'
        : 'stale',
    completeness: complete ? 'complete' : 'incomplete',
    identityAlignment: 'current',
    projectId: input.projectId ?? null,
    projectScopeId: input.projectScopeId ?? 'single-folder',
    rows,
  };
}

function readCheckpointWithLegacyFallback(
  repository: CheckpointRepository,
  canonicalScope: { folderId: string; projectRoot: string; scopeId: string },
  folderPath: string | null
): Record<string, unknown> | null {
  const canonical = repository.get(canonicalScope);
  if (canonical || !folderPath || folderPath === canonicalScope.projectRoot) {
    return canonical;
  }
  const scopedLegacy = repository.get({ ...canonicalScope, projectRoot: folderPath });
  if (scopedLegacy) {
    return scopedLegacy;
  }
  return repository.get({ folderId: 'root', projectRoot: folderPath, scopeId: 'single-folder' });
}

function readCurrentGitHead(projectRoot: string): { ok: true; head: string } | { ok: false } {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // execFileSync 同步阻塞整个 MCP 事件循环——git 在损坏仓库/巨仓/网络盘上可能长挂;
      // prime 的 ready 路径必经此处,无上限=整服务无限挂死(2026-07-10 事故排查发现的
      // 第二个无界同步点)。5s 对 rev-parse 富余;超时抛错走 catch 降级 ok:false。
      timeout: 5_000,
    }).trim();
    return head ? { ok: true, head } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readCurrentGitState(projectRoot: string): { dirty: boolean | null; head: string | null } {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim().length > 0;
    return { dirty, head: head || null };
  } catch {
    return { dirty: null, head: null };
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

function readTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const text = readString(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function shortCommit(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
