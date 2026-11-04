import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Logger from '@alembic/core/logging';
import type { ProjectContextBuildSessionManager } from '../../../service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { GraphInput } from '../../../shared/schemas/mcp-tools.js';
import type { ProjectRuntimeContext } from '../../context/ProjectRuntimeContext.js';
import { observePublicKnowledgePublication } from '../../context/StrictPublicKnowledgeResolver.js';
import { graph } from '../handlers/structure.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';

/** 未初始化项目的 Graph 运行数据根（CodeGraph 会话、源码索引库）所在的系统临时目录分区。 */
const UNINITIALIZED_GRAPH_RUNTIME_DIR = 'alembic-graph-runtime';

/**
 * 首选运行根校验失败时使用的进程级私有根（mkdtemp 随机名、0700）。
 * 进程内复用，保证同一项目的渐进式构建 / 续页在后续调用里仍能找到同一会话数据。
 */
let processPrivateGraphRuntimeBase: string | null = null;

/** Public Graph reads only request-scoped ProjectContext source facts. */
export async function executeReadOnlyGraph(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext,
  projectContextExecution?: {
    buildSessions: ProjectContextBuildSessionManager;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Graph.');
  }
  const identity = projectRuntime.identity;
  const publication = observePublicKnowledgePublication(identity);
  projectRuntime.publication = publication.provenance;
  GraphInput.parse(args);
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const identityDataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  // 结构问答不要求知识库（README）：未初始化项目照常查询，但其 dataRoot 可能就是仓库本身，
  // CodeGraph 会话目录与源码索引库都派生自 dataRoot，不能写进用户仓库。
  const graphRuntime = projectRuntime.location.databaseExists
    ? projectRuntime
    : withUninitializedGraphDataRoot(projectRuntime, projectRoot);
  const dataRoot = resolve(requireIdentityPath(graphRuntime.identity.dataRoot, 'dataRoot'));
  const container: McpServiceContainer = {
    get(name: string): unknown {
      throw new Error(`Read-only Graph container does not expose ${name}.`);
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: { dataRoot },
    },
  };
  if (dataRoot !== identityDataRoot) {
    Logger.getInstance().info(
      `[MCP/Graph] project not initialized; graph runtime data routed to the per-project temp root (never the repository): projectRoot=${projectRoot} graphDataRoot=${dataRoot}`
    );
  }
  // 只替换 Graph 内部执行用的 dataRoot；对外 projectRuntime（响应里的项目身份）保持不变。
  const ctx: McpContext = { container, projectRuntime: graphRuntime, projectContextExecution };
  return graph(ctx, args);
}

/**
 * 未初始化项目的首选 Graph 运行数据根：os.tmpdir() 下按 OS 用户分区、按项目真实路径哈希的稳定目录。
 * 必须稳定且不随调用删除——渐进式构建与续页 cursor 可能在后续调用里继续使用同一会话数据。
 * 这里只计算路径；是否可用由 prepareUninitializedGraphDataRoot 校验（共享 /tmp 上路径可被他人预测）。
 */
export function uninitializedGraphDataRoot(projectRoot: string): string {
  return join(uninitializedGraphRuntimeBase(), projectRootDigest(projectRoot));
}

/** 共享 /tmp（Linux、CI、Codex CLI）上按 uid 分区，避免多个 OS 用户争用同一个父目录。 */
function uninitializedGraphRuntimeBase(): string {
  const uid = currentUid();
  // Windows 无 uid；其 os.tmpdir() 本身位于用户私有的 %LOCALAPPDATA%\Temp。
  const name =
    uid === null ? UNINITIALIZED_GRAPH_RUNTIME_DIR : `${UNINITIALIZED_GRAPH_RUNTIME_DIR}-${uid}`;
  return join(tmpdir(), name);
}

function projectRootDigest(projectRoot: string): string {
  let physicalRoot = resolve(projectRoot);
  try {
    physicalRoot = realpathSync(physicalRoot);
  } catch (err: unknown) {
    // 项目目录不可解析时退回逻辑路径哈希；Graph 自身随后会对缺失的源码目录报错。
    Logger.getInstance().warn(
      `[MCP/Graph] realpath failed for graph runtime root; hashing the logical path instead: ${physicalRoot}`,
      { error: errorMessage(err) }
    );
  }
  return createHash('sha256').update(physicalRoot).digest('hex').slice(0, 16);
}

/**
 * 准备未初始化项目的 Graph 运行根，并保证它对当前用户私有：
 * 首选根的父目录与项目目录都必须是当前用户拥有的真实目录（非符号链接）、无 group/other 权限且可写。
 * 任一校验失败（他人预置目录、植入符号链接、权限过宽、不可写）都不复用该路径，
 * 改用进程级 mkdtemp 私有根，Graph 继续可用且绝不经由不可信路径写入数据。
 */
function prepareUninitializedGraphDataRoot(projectRoot: string): string {
  const digest = projectRootDigest(projectRoot);
  const base = uninitializedGraphRuntimeBase();
  const preferred = join(base, digest);
  const baseIssue = ensurePrivateDirectory(base);
  // 父目录未通过校验时不再触碰其下的项目目录（可能是他人控制的位置）。
  const leafIssue = baseIssue ? null : ensurePrivateDirectory(preferred);
  const issue = baseIssue
    ? `${base}: ${baseIssue}`
    : leafIssue
      ? `${preferred}: ${leafIssue}`
      : null;
  if (!issue) {
    return preferred;
  }
  const fallbackBase = processPrivateGraphRuntimeRoot();
  const fallback = join(fallbackBase, digest);
  const fallbackIssue = ensurePrivateDirectory(fallback);
  if (fallbackIssue) {
    // 私有回退根也不可用：拒绝执行（fail closed），由 Graph 调用方归类为 INTERNAL_ERROR。
    throw new Error(
      `Cannot prepare a private graph runtime root for ${projectRoot}: ${issue}; fallback ${fallback}: ${fallbackIssue}`
    );
  }
  Logger.getInstance().warn(
    `[MCP/Graph] preferred graph runtime root rejected; using the process-private temp root instead: ${issue}`,
    { projectRoot, fallback }
  );
  return fallback;
}

/** 进程级私有根：缓存仍有效（同一 tmpdir 下、仍私有）时复用，否则重新 mkdtemp。 */
function processPrivateGraphRuntimeRoot(): string {
  const tmpBase = tmpdir();
  const cached = processPrivateGraphRuntimeBase;
  if (cached?.startsWith(`${tmpBase}${sep}`) && inspectPrivateDirectory(cached) === null) {
    return cached;
  }
  // mkdtemp 以随机名原子创建 0700 目录，他人无法预测或抢先占用。
  const created = mkdtempSync(join(tmpBase, `${UNINITIALIZED_GRAPH_RUNTIME_DIR}-private-`));
  processPrivateGraphRuntimeBase = created;
  Logger.getInstance().info(`[MCP/Graph] created process-private graph runtime root: ${created}`);
  return created;
}

/** 创建（若不存在）并校验目录私有性；返回拒绝原因，通过时返回 null。 */
function ensurePrivateDirectory(dir: string): string | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err: unknown) {
    if (!isErrnoCode(err, 'EEXIST')) {
      return `mkdir failed: ${errorMessage(err)}`;
    }
  }
  return inspectPrivateDirectory(dir);
}

/** 只读校验：真实目录、属当前用户、无 group/other 权限、当前用户可写可进入。 */
function inspectPrivateDirectory(dir: string): string | null {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      return 'is a symbolic link';
    }
    if (!stat.isDirectory()) {
      return 'is not a directory';
    }
    const uid = currentUid();
    if (uid !== null) {
      if (stat.uid !== uid) {
        return `owned by uid ${stat.uid}, not the current uid ${uid}`;
      }
      if ((stat.mode & 0o077) !== 0) {
        return `mode ${(stat.mode & 0o777).toString(8)} grants group/other access`;
      }
    }
    accessSync(dir, constants.W_OK | constants.X_OK);
    return null;
  } catch (err: unknown) {
    return `not usable: ${errorMessage(err)}`;
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withUninitializedGraphDataRoot(
  projectRuntime: ProjectRuntimeContext,
  projectRoot: string
): ProjectRuntimeContext {
  const dataRoot = prepareUninitializedGraphDataRoot(projectRoot);
  return {
    ...projectRuntime,
    identity: { ...projectRuntime.identity, dataRoot },
  };
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Graph project identity is missing ${field}.`);
  }
  return value;
}
