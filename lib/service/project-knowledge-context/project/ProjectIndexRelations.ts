/**
 * 图工具读源码索引的入口。
 *
 * ProjectContext 的查询按文件现算，只看得到一个文件自己的出边；"谁调用了它""谁导入了它"要问
 * 整个项目的源码索引。索引放在宿主私有数据目录下的独立库文件里——图工具的公开通道没有主库
 * 句柄，也不该往知识库的主库里写。库文件第一次用到时打开（没有就建），之后在进程内复用；
 * 每次查询前把索引追到当前源码，并发与短期复用由 Core 的入口负责。
 */

import path from 'node:path';
import Logger from '@alembic/core/logging';
import {
  openProjectRelationsStore,
  type ProjectRelationEnvelope,
  type ProjectRelationRequest,
  type ProjectRelationsStore,
} from '@alembic/core/project-context';

/** 一次追索引的结果在这段时间内复用：一次图查询里的几个关系问题不必各查一遍文件变化。 */
const INDEX_REUSE_MS = 30_000;

export interface ProjectIndexRelations {
  /**
   * 先把索引追到当前源码，再回答一个关系查询。
   * 索引建不起来时，回答里是明确的"不可用"，不是空结果。
   */
  query(
    request: Omit<ProjectRelationRequest, 'scope'>,
    context?: { signal?: AbortSignal }
  ): Promise<ProjectRelationEnvelope>;
}

export interface ProjectIndexLocation {
  projectRoot: string;
  /** 宿主私有数据目录；索引库与外部引擎的运行目录都在它下面。 */
  dataRoot: string;
}

/** 已打开的索引库，按库文件路径复用。 */
let _stores: Map<string, ProjectRelationsStore> | null = null;

/** 索引库文件的位置：与主库同在宿主数据目录的 `.asd` 下，是另一个文件。 */
export function projectIndexDatabasePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '.asd', 'source-index.db');
}

export function openProjectIndexRelations(location: ProjectIndexLocation): ProjectIndexRelations {
  const projectRoot = path.resolve(location.projectRoot);
  const dataRoot = path.resolve(location.dataRoot);
  return {
    async query(request, context) {
      context?.signal?.throwIfAborted();
      const { relations } = storeFor(dataRoot);
      // 追索引的那一次由并发的查询共用，不绑在某一个请求的取消信号上。
      const state = await relations.ensureIndex(
        { projectRoot, codeGraph: { dataRoot } },
        { maxAgeMs: INDEX_REUSE_MS }
      );
      context?.signal?.throwIfAborted();
      if (!state.available) {
        const reason = state.reason ?? 'The source index could not be built for this project.';
        Logger.getInstance().warn(
          `[ProjectIndex] source index unavailable: projectRoot=${projectRoot} ` +
            `freshness=${state.freshness} reason=${reason}`
        );
        return {
          contractVersion: 1,
          project: { projectRoot },
          kind: request.kind,
          data: { kind: request.kind, available: false, reason, nextRefs: [] },
          index: state,
          refs: [],
          errors: [
            {
              code: 'query-unavailable',
              message: `Source index is unavailable (${state.freshness}): ${reason}`,
              retryable: true,
              severity: 'warning',
            },
          ],
        };
      }
      return relations.query({ ...request, scope: { projectRoot } }, context);
    },
  };
}

/** 关闭本进程打开的全部索引库（进程收尾与测试用）。 */
export function closeProjectIndexRelations(): void {
  for (const store of _stores?.values() ?? []) {
    store.close();
  }
  _stores = null;
}

function storeFor(dataRoot: string): ProjectRelationsStore {
  _stores ??= new Map();
  const databasePath = projectIndexDatabasePath(dataRoot);
  let store = _stores.get(databasePath);
  if (!store) {
    store = openProjectRelationsStore({ databasePath });
    _stores.set(databasePath, store);
    Logger.getInstance().info(`[ProjectIndex] opened source index store: ${databasePath}`);
  }
  return store;
}
