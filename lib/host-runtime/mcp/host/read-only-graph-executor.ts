import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createReadOnlySearchRepositories } from '../../../repository/search/ReadOnlySearchServices.js';
import { graph } from '../handlers/structure.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

/**
 * 公共 Graph 只需要 ProjectContext 源码事实和 checkpoint 新鲜度读取。
 *
 * 通用 EmbeddedMcpServer 会初始化迁移、可写仓储、向量同步与审计，并在关闭时
 * checkpoint live WAL；这里把 Graph 限定到请求级临时快照，只暴露 checkpoint
 * repository。SQLite/WAL/SHM 的任何私有读状态都只能发生在临时目录。
 */
export async function executeReadOnlyGraph(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Graph.');
  }
  const identity = projectRuntime.identity;
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!isWithin(databasePath, dataRoot)) {
    throw new Error(
      `Read-only Graph database identity mismatch: database=${databasePath}, dataRoot=${dataRoot}.`
    );
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Read-only Graph database does not exist: ${databasePath}.`);
  }

  const snapshot = createReadOnlySearchSnapshot({ dataRoot, databasePath });
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  try {
    db.pragma('query_only = ON');
    const { checkpointRepository } = createReadOnlySearchRepositories(db);
    const container: McpServiceContainer = {
      get(name: string): unknown {
        if (name === 'gitDiffCheckpointRepository') {
          return checkpointRepository;
        }
        throw new Error(`Read-only Graph container does not expose ${name}.`);
      },
      singletons: {
        _projectRoot: projectRoot,
        _workspaceResolver: { dataRoot },
      },
    };
    process.stderr.write(
      `[MCP/Graph] request-scoped snapshot route is physically read-only: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = { container, projectRuntime };
    return await graph(ctx, args);
  } finally {
    db.close();
    snapshot.dispose();
  }
}

function isWithin(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith('/');
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Graph project identity is missing ${field}.`);
  }
  return value;
}
