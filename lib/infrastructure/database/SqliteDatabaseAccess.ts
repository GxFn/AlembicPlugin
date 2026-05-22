import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Plugin repo-boundary 的 raw SQLite 访问集中点。
 *
 * Codex-facing service / route 可以读取自己的运行态状态，但不应在业务层直接
 * `prepare()` / `getDb()`；所有必须保留的 SQLite fallback、只读状态探测和批量
 * JSON 更新都经由本文件收口，便于后续继续迁移到 repository 或 Drizzle API。
 */
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close?: () => void;
}

interface DbWrapper {
  getDb?: () => SqliteDb;
}

export interface CodexSourceRefReadState {
  activeCount: number;
  databasePath: string;
  reason: string | null;
  renamedCount: number;
  staleCount: number;
  staleRecipeCount: number;
  status: 'missing' | 'ready' | 'stale' | 'unavailable';
  tableExists: boolean;
  totalCount: number;
}

export interface CodexSnapshotReadState {
  databasePath: string;
  latest: {
    affectedDimsCount: number;
    candidateCount: number;
    changedFilesCount: number;
    createdAt: string;
    dimensionCount: number;
    fileCount: number;
    id: string;
    isIncremental: boolean;
    primaryLang: string | null;
    sessionId: string | null;
  } | null;
  reason: string | null;
  status: 'missing' | 'ready' | 'unavailable';
  tableExists: boolean;
  totalCount: number;
}

export interface RecipeSnapshotRow {
  id: string;
  title: string;
  trigger: string;
  dimensionId: string | null;
  category: string;
  knowledgeType: string | null;
  doClause: string | null;
  sourceFile: string | null;
  lifecycle: string;
  content: string | null;
  sourceRefsJson: string | null;
}

export interface HitRecorderFlushEntry {
  recipeId: string;
  statsField: string;
  count: number;
}

export function resolveSqliteDb(db: unknown): SqliteDb | null {
  if (!db) {
    return null;
  }
  const wrapper = db as DbWrapper;
  if (typeof wrapper.getDb === 'function') {
    return wrapper.getDb();
  }
  return db as SqliteDb;
}

export function getLatestSchemaMigrationVersion(db: unknown): string | null {
  try {
    const rawDb = resolveSqliteDb(db);
    const row = rawDb
      ?.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
      .get() as { version?: string } | undefined;
    return row?.version || null;
  } catch {
    return null;
  }
}

export function readCodexSourceRefState(databasePath: string): CodexSourceRefReadState {
  if (!existsSync(databasePath)) {
    return {
      activeCount: 0,
      databasePath,
      reason: 'database does not exist',
      renamedCount: 0,
      staleCount: 0,
      staleRecipeCount: 0,
      status: 'missing',
      tableExists: false,
      totalCount: 0,
    };
  }
  return withReadonlyDatabase<CodexSourceRefReadState>(databasePath, (db) => {
    if (!sqliteTableExists(db, 'recipe_source_refs')) {
      return {
        activeCount: 0,
        databasePath,
        reason: 'recipe_source_refs table does not exist',
        renamedCount: 0,
        staleCount: 0,
        staleRecipeCount: 0,
        status: 'missing',
        tableExists: false,
        totalCount: 0,
      };
    }
    const row = db
      .prepare(
        `SELECT
          count(*) AS totalCount,
          sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount,
          sum(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS staleCount,
          sum(CASE WHEN status = 'renamed' THEN 1 ELSE 0 END) AS renamedCount,
          count(DISTINCT CASE WHEN status = 'stale' THEN recipe_id ELSE NULL END) AS staleRecipeCount
        FROM recipe_source_refs`
      )
      .get() as Record<string, unknown>;
    const staleCount = numeric(row.staleCount);
    return {
      activeCount: numeric(row.activeCount),
      databasePath,
      reason: staleCount > 0 ? 'recipe source references contain stale files' : null,
      renamedCount: numeric(row.renamedCount),
      staleCount,
      staleRecipeCount: numeric(row.staleRecipeCount),
      status: staleCount > 0 ? 'stale' : 'ready',
      tableExists: true,
      totalCount: numeric(row.totalCount),
    };
  });
}

export function readCodexSnapshotState(
  databasePath: string,
  projectRoot: string
): CodexSnapshotReadState {
  if (!existsSync(databasePath)) {
    return {
      databasePath,
      latest: null,
      reason: 'database does not exist',
      status: 'missing',
      tableExists: false,
      totalCount: 0,
    };
  }
  return withReadonlyDatabase<CodexSnapshotReadState>(databasePath, (db) => {
    if (!sqliteTableExists(db, 'bootstrap_snapshots')) {
      return {
        databasePath,
        latest: null,
        reason: 'bootstrap_snapshots table does not exist',
        status: 'missing',
        tableExists: false,
        totalCount: 0,
      };
    }
    const total = db
      .prepare('SELECT count(*) AS totalCount FROM bootstrap_snapshots WHERE project_root = ?')
      .get(projectRoot) as Record<string, unknown>;
    const latest = db
      .prepare(
        `SELECT id, session_id, created_at, file_count, dimension_count, candidate_count,
          primary_lang, is_incremental, changed_files, affected_dims
         FROM bootstrap_snapshots
         WHERE project_root = ? AND status = 'complete'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(projectRoot) as Record<string, unknown> | undefined;
    return {
      databasePath,
      latest: latest
        ? {
            affectedDimsCount: jsonArrayLength(latest.affected_dims),
            candidateCount: numeric(latest.candidate_count),
            changedFilesCount: jsonArrayLength(latest.changed_files),
            createdAt: String(latest.created_at || ''),
            dimensionCount: numeric(latest.dimension_count),
            fileCount: numeric(latest.file_count),
            id: String(latest.id || ''),
            isIncremental: numeric(latest.is_incremental) === 1,
            primaryLang: typeof latest.primary_lang === 'string' ? latest.primary_lang : null,
            sessionId: typeof latest.session_id === 'string' ? latest.session_id : null,
          }
        : null,
      reason: latest ? null : 'no complete bootstrap snapshot exists',
      status: latest ? 'ready' : 'missing',
      tableExists: true,
      totalCount: numeric(total.totalCount),
    };
  });
}

export function listTableColumnNames(db: SqliteDb, tableName: string): string[] {
  const table = assertSqlIdentifier(tableName);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return columns.map((column) => column.name).filter((name): name is string => Boolean(name));
}

export function queryRecipeSnapshotRows(
  db: SqliteDb,
  input: {
    lifecycleFilterSql: string;
    lifecycleParams: readonly unknown[];
    hasDimensionId: boolean;
  }
): RecipeSnapshotRow[] {
  return db
    .prepare(
      `SELECT id, title, trigger, ${input.hasDimensionId ? 'dimensionId' : "'' AS dimensionId"},
              category, knowledgeType, doClause,
              sourceFile, lifecycle, content, json_extract(reasoning, '$.sources') AS sourceRefsJson
       FROM knowledge_entries
       WHERE ${input.lifecycleFilterSql}`
    )
    .all(...input.lifecycleParams) as RecipeSnapshotRow[];
}

export function exportTablesAsJsonLines(
  db: SqliteDb,
  tablesToExport: readonly string[]
): { lines: string[]; totalRows: number } {
  let totalRows = 0;
  const lines: string[] = [];
  for (const tableName of tablesToExport) {
    try {
      const table = assertSqlIdentifier(tableName);
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        lines.push(JSON.stringify({ _table: tableName, ...row }));
        totalRows++;
      }
    } catch {
      // 表可能不存在，跳过；调用方负责记录汇总结果。
    }
  }
  return { lines, totalRows };
}

export function clearTables(
  db: SqliteDb,
  tables: readonly string[]
): {
  clearedTables: string[];
  errors: string[];
} {
  const clearedTables: string[] = [];
  const errors: string[] = [];
  for (const tableName of tables) {
    try {
      const table = assertSqlIdentifier(tableName);
      db.exec(`DELETE FROM ${table}`);
      clearedTables.push(tableName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no such table')) {
        errors.push(`Failed to clear ${tableName}: ${msg}`);
      }
    }
  }
  return { clearedTables, errors };
}

export function deleteKnowledgeEntriesByLifecycle(
  db: SqliteDb,
  lifecycles: readonly string[]
): {
  cleared: boolean;
  error: string | null;
} {
  try {
    const placeholders = lifecycles.map(() => '?').join(', ');
    db.prepare(`DELETE FROM knowledge_entries WHERE lifecycle IN (${placeholders})`).run(
      ...lifecycles
    );
    return { cleared: true, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { cleared: false, error: `Failed to clean old entries: ${msg}` };
  }
}

export function flushHitRecorderStats(
  db: SqliteDb,
  entries: readonly HitRecorderFlushEntry[],
  updatedAt: number
): number {
  const stmt = db.prepare(
    `UPDATE knowledge_entries
     SET stats = json_set(
           COALESCE(stats, '{}'),
           '$.' || ?,
           COALESCE(json_extract(stats, '$.' || ?), 0) + ?
         ),
         updatedAt = ?
     WHERE id = ?`
  );

  let flushed = 0;
  for (const entry of entries) {
    try {
      stmt.run(entry.statsField, entry.statsField, entry.count, updatedAt, entry.recipeId);
      flushed += entry.count;
    } catch {
      // Recipe 可能已被删除，保持原有静默忽略行为。
    }
  }
  return flushed;
}

function withReadonlyDatabase<T>(databasePath: string, reader: (db: SqliteDb) => T): T {
  const db = openReadonlyDatabase(databasePath);
  if (!db) {
    return unavailable(databasePath) as T;
  }
  try {
    return reader(db);
  } catch {
    return unavailable(databasePath, true) as T;
  } finally {
    db.close?.();
  }
}

function openReadonlyDatabase(databasePath: string): SqliteDb | null {
  try {
    return new Database(databasePath, { fileMustExist: true, readonly: true }) as SqliteDb;
  } catch {
    return null;
  }
}

function sqliteTableExists(db: SqliteDb, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function unavailable(databasePath: string, queried = false) {
  return {
    activeCount: 0,
    databasePath,
    latest: null,
    reason: queried
      ? 'database table could not be queried'
      : 'database could not be opened read-only',
    renamedCount: 0,
    staleCount: 0,
    staleRecipeCount: 0,
    status: 'unavailable',
    tableExists: queried,
    totalCount: 0,
  };
}

function assertSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }
  return identifier;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value || 0) || 0;
}

function jsonArrayLength(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
