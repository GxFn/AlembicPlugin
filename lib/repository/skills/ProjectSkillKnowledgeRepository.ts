import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function countProjectSkillKnowledgeEntries(dataRoot: string): number {
  return countKnowledgeEntries(dataRoot);
}

export function countProjectDatabaseRecipes(dataRoot: string): number {
  // 当前统一模型里 knowledge_entries 是 DB 持久化 Recipe 表；磁盘 .md 导出数由
  // KnowledgeState 单独扫描 materializedRecipeCount，避免两个来源再次混淆。
  return countKnowledgeEntries(dataRoot);
}

/** lifecycle 分布（S2，2026-07-06 五 MCP 升级）：staging/active/deprecated 计数。 */
export interface RecipeLifecycleCounts {
  staging: number;
  active: number;
  deprecated: number;
  /** 上述三态之外的其余 lifecycle 值合计（前向兼容未来状态） */
  other: number;
}

/**
 * 统计 knowledge_entries 的 lifecycle 分布。DB/表不存在或查询失败返回 null
 * （status 投影容缺展示），与 count 系函数同样的只读防御式访问。
 */
export function countProjectRecipeLifecycles(dataRoot: string): RecipeLifecycleCounts | null {
  const candidates = [path.join(dataRoot, '.asd', 'alembic.db'), path.join(dataRoot, 'alembic.db')];
  for (const dbPath of candidates) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    try {
      const db = new Database(dbPath, { fileMustExist: true, readonly: true });
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_entries'"
          )
          .get();
        if (!table) {
          continue;
        }
        const rows = db
          .prepare('SELECT lifecycle, COUNT(*) AS count FROM knowledge_entries GROUP BY lifecycle')
          .all() as Array<{ lifecycle?: string | null; count?: number }>;
        const counts: RecipeLifecycleCounts = { staging: 0, active: 0, deprecated: 0, other: 0 };
        for (const row of rows) {
          const value = Number(row.count ?? 0);
          if (row.lifecycle === 'staging') {
            counts.staging += value;
          } else if (row.lifecycle === 'active') {
            counts.active += value;
          } else if (row.lifecycle === 'deprecated') {
            counts.deprecated += value;
          } else {
            counts.other += value;
          }
        }
        return counts;
      } finally {
        db.close();
      }
    } catch {}
  }
  return null;
}

/** S1 双新鲜度（2026-07-06）：durable git-diff checkpoint 的只读摘要。 */
export interface GitDiffCheckpointSummary {
  checkpointCommit: string | null;
  targetCommit: string | null;
  lastRouteStatus: string;
  lastScannedAt: number | null;
  /** truncated/failed 路由态 → 建议 rescan 收口；complete → none */
  recommendation: 'none' | 'rescan-suggested';
}

export interface GitDiffCheckpointScopeReader {
  get(scope: {
    folderId: string;
    projectRoot: string;
    scopeId: string;
  }): Record<string, unknown> | null;
}

/** Read-only scoped checkpoint reader for status/provenance projections. */
export function createReadOnlyGitDiffCheckpointReader(
  databasePath: string
): GitDiffCheckpointScopeReader {
  return {
    get(scope) {
      try {
        const db = new Database(databasePath, { fileMustExist: true, readonly: true });
        try {
          return (
            (db
              .prepare(
                `SELECT checkpoint_commit AS checkpointCommit,
                        folder_id AS folderId,
                        last_route_status AS lastRouteStatus,
                        last_scanned_at AS lastScannedAt,
                        merge_base_commit AS mergeBaseCommit,
                        project_root AS projectRoot,
                        scope_id AS scopeId,
                        target_commit AS targetCommit,
                        updated_at AS updatedAt
                 FROM git_diff_checkpoints
                 WHERE project_root = ? AND scope_id = ? AND folder_id = ?
                 LIMIT 1`
              )
              .get(scope.projectRoot, scope.scopeId, scope.folderId) as
              | Record<string, unknown>
              | undefined) ?? null
          );
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    },
  };
}

/**
 * 读取最近一次 git-diff checkpoint（按 last_scanned_at 最新行）。表/DB 缺失
 * 返回 null 容缺——status 只作参考投影，不承担 guard 的路由职责。
 */
export function readGitDiffCheckpointSummary(dataRoot: string): GitDiffCheckpointSummary | null {
  const candidates = [path.join(dataRoot, '.asd', 'alembic.db'), path.join(dataRoot, 'alembic.db')];
  for (const dbPath of candidates) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    try {
      const db = new Database(dbPath, { fileMustExist: true, readonly: true });
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'git_diff_checkpoints'"
          )
          .get();
        if (!table) {
          continue;
        }
        const row = db
          .prepare(
            'SELECT checkpoint_commit, target_commit, last_route_status, last_scanned_at FROM git_diff_checkpoints ORDER BY last_scanned_at DESC LIMIT 1'
          )
          .get() as
          | {
              checkpoint_commit?: string | null;
              target_commit?: string | null;
              last_route_status?: string | null;
              last_scanned_at?: number | null;
            }
          | undefined;
        if (!row) {
          return null;
        }
        const lastRouteStatus = row.last_route_status ?? 'unknown';
        return {
          checkpointCommit: row.checkpoint_commit ?? null,
          targetCommit: row.target_commit ?? null,
          lastRouteStatus,
          lastScannedAt: row.last_scanned_at ?? null,
          recommendation: lastRouteStatus === 'complete' ? 'none' : 'rescan-suggested',
        };
      } finally {
        db.close();
      }
    } catch {}
  }
  return null;
}

function countKnowledgeEntries(dataRoot: string): number {
  const candidates = [path.join(dataRoot, '.asd', 'alembic.db'), path.join(dataRoot, 'alembic.db')];
  for (const dbPath of candidates) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    try {
      const db = new Database(dbPath, { fileMustExist: true, readonly: true });
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_entries'"
          )
          .get();
        if (!table) {
          continue;
        }
        const row = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get() as {
          count?: number;
        };
        return Number(row.count ?? 0);
      } finally {
        db.close();
      }
    } catch {}
  }
  return 0;
}
