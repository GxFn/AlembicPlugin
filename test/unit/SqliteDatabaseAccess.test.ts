import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import {
  getLatestSchemaMigrationVersion,
  queryRecipeSnapshotRows,
  readCodexSnapshotState,
  readCodexSourceRefState,
  resolveSqliteDb,
} from '../../lib/infrastructure/database/SqliteDatabaseAccess.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function createDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-sqlite-access-'));
  const dbPath = path.join(tmpDir, 'alembic.db');
  const db = new Database(dbPath);
  return { db, dbPath };
}

describe('SqliteDatabaseAccess', () => {
  test('reads schema migration version through wrapper boundary', () => {
    const { db } = createDb();
    db.exec('CREATE TABLE schema_migrations (version TEXT, applied_at TEXT)');
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('001', '2026-01-01');
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('002', '2026-01-02');

    expect(getLatestSchemaMigrationVersion({ getDb: () => db })).toBe('002');
    expect(resolveSqliteDb({ getDb: () => db })).toBe(db);
    db.close();
  });

  test('reads Codex source refs and bootstrap snapshot state', () => {
    const { db, dbPath } = createDb();
    db.exec(`
      CREATE TABLE recipe_source_refs (recipe_id TEXT, status TEXT);
      CREATE TABLE bootstrap_snapshots (
        id TEXT,
        session_id TEXT,
        created_at TEXT,
        file_count INTEGER,
        dimension_count INTEGER,
        candidate_count INTEGER,
        primary_lang TEXT,
        is_incremental INTEGER,
        changed_files TEXT,
        affected_dims TEXT,
        project_root TEXT,
        status TEXT
      );
    `);
    db.prepare('INSERT INTO recipe_source_refs VALUES (?, ?)').run('r1', 'active');
    db.prepare('INSERT INTO recipe_source_refs VALUES (?, ?)').run('r2', 'stale');
    db.prepare(
      `INSERT INTO bootstrap_snapshots VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'snap-1',
      'session-1',
      '2026-05-23T00:00:00Z',
      3,
      2,
      1,
      'ts',
      1,
      JSON.stringify(['a.ts', 'b.ts']),
      JSON.stringify(['d1']),
      '/project',
      'complete'
    );
    db.close();

    expect(readCodexSourceRefState(dbPath)).toMatchObject({
      activeCount: 1,
      staleCount: 1,
      staleRecipeCount: 1,
      status: 'stale',
      tableExists: true,
      totalCount: 2,
    });
    expect(readCodexSnapshotState(dbPath, '/project')).toMatchObject({
      latest: {
        affectedDimsCount: 1,
        candidateCount: 1,
        changedFilesCount: 2,
        fileCount: 3,
        id: 'snap-1',
        isIncremental: true,
      },
      status: 'ready',
      tableExists: true,
      totalCount: 1,
    });
  });

  test('queries recipe snapshot rows without leaking prepare into service layer', () => {
    const { db } = createDb();
    db.exec(`
      CREATE TABLE knowledge_entries (
        id TEXT,
        title TEXT,
        trigger TEXT,
        dimensionId TEXT,
        category TEXT,
        knowledgeType TEXT,
        doClause TEXT,
        sourceFile TEXT,
        lifecycle TEXT,
        content TEXT,
        reasoning TEXT
      );
    `);
    db.prepare(`INSERT INTO knowledge_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'k1',
      'Title',
      'trigger',
      'dim',
      'cat',
      'code-pattern',
      'do',
      'src.ts',
      'active',
      JSON.stringify({ markdown: 'body' }),
      JSON.stringify({ sources: ['src.ts'] })
    );

    const rows = queryRecipeSnapshotRows(db, {
      hasDimensionId: true,
      lifecycleFilterSql: 'lifecycle IN (?)',
      lifecycleParams: ['active'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dimensionId: 'dim',
      id: 'k1',
      sourceRefsJson: JSON.stringify(['src.ts']),
    });
    db.close();
  });
});
