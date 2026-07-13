import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { executeReadOnlySearch } from '../../lib/host-runtime/mcp/host/read-only-search-executor.js';
import { createReadOnlySearchContainer } from '../../lib/host-runtime/mcp/host/read-only-search-executor.js';
import { createReadOnlySearchSnapshot } from '../../lib/host-runtime/mcp/host/read-only-search-snapshot.js';

const roots: string[] = [];

describe('public Search read-only storage fingerprint', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  test('keeps the live DB/WAL/SHM/vector family byte-identical', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-search-project-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-search-data-'));
    roots.push(projectRoot, dataRoot);
    const asd = path.join(dataRoot, '.asd');
    const indexDir = path.join(asd, 'context', 'index');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      path.join(asd, 'config.json'),
      JSON.stringify({ vector: { localEmbedding: { enabled: false } } })
    );
    const indexPath = path.join(indexDir, 'vector_index.asvec');
    fs.writeFileSync(indexPath, 'invalid-but-fingerprinted-index');
    const databasePath = path.join(asd, 'alembic.db');
    const writer = new Database(databasePath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.exec(`
        CREATE TABLE knowledge_entries (
          id TEXT PRIMARY KEY, title TEXT, description TEXT, language TEXT,
          dimensionId TEXT, category TEXT, knowledgeType TEXT, kind TEXT, scope TEXT,
          content TEXT, lifecycle TEXT, tags TEXT, trigger TEXT, difficulty TEXT,
          quality TEXT, stats TEXT, headers TEXT, moduleName TEXT, whenClause TEXT,
          doClause TEXT, updatedAt TEXT, createdAt TEXT
        );
        INSERT INTO knowledge_entries (
          id, title, description, language, dimensionId, category, knowledgeType,
          kind, scope, content, lifecycle, tags, trigger, difficulty, quality,
          stats, headers, moduleName, whenClause, doClause, updatedAt, createdAt
        ) VALUES (
          'recipe-isolation', 'Feature isolation', 'Layered module dependency rule',
          'swift', 'architecture', 'Architecture', 'code-pattern', 'pattern',
          'project', 'Feature isolation with layered dependencies', 'active', '[]',
          'module isolation', 'medium', '{}', '{}', '{}', 'Feature',
          'When adding a feature', 'Keep dependencies layered',
          '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
        );
      `);
      const family = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, indexPath];
      const before = fingerprintFamily(family);
      const result = (await executeReadOnlySearch(
        {
          operation: 'search',
          query: 'Feature isolation',
          mode: 'keyword',
          projectRoot,
        },
        {
          projectRuntime: {
            identity: {
              dataRoot,
              databasePath,
              projectId: 'fingerprint-project',
              projectRoot,
              projectScopeId: 'scope-fingerprint-project',
            },
          },
        } as never
      )) as { structuredContent: { items: unknown[]; result?: Record<string, unknown> } };

      expect(result.structuredContent.items).toHaveLength(1);
      expect(result.structuredContent.result).toMatchObject({
        actualMode: 'keyword',
        vectorUsed: false,
      });
      expect(fingerprintFamily(family)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  test('constructs a retrieval reader graph without writer or lifecycle services', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-reader-project-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-reader-data-'));
    roots.push(projectRoot, dataRoot);
    const asd = path.join(dataRoot, '.asd');
    fs.mkdirSync(asd, { recursive: true });
    const databasePath = path.join(asd, 'alembic.db');
    const writer = new Database(databasePath);
    try {
      writer.exec(`
        CREATE TABLE knowledge_entries (
          id TEXT PRIMARY KEY, title TEXT, description TEXT, language TEXT,
          dimensionId TEXT, category TEXT, knowledgeType TEXT, kind TEXT, scope TEXT,
          content TEXT, lifecycle TEXT, tags TEXT, trigger TEXT, difficulty TEXT,
          quality TEXT, stats TEXT, headers TEXT, moduleName TEXT, whenClause TEXT,
          doClause TEXT, updatedAt TEXT, createdAt TEXT
        );
        CREATE TABLE recipe_source_refs (
          recipe_id TEXT NOT NULL, source_path TEXT NOT NULL, status TEXT NOT NULL, new_path TEXT
        );
      `);
      const snapshot = createReadOnlySearchSnapshot({ dataRoot, databasePath });
      const snapshotDb = new Database(snapshot.databasePath, {
        fileMustExist: true,
        readonly: true,
      });
      const handle = await createReadOnlySearchContainer(snapshotDb, snapshot, {
        dataRoot,
        projectRoot,
      });
      try {
        expect(handle.container.get('knowledgeRetrievalPort')).toBeDefined();
        for (const forbidden of [
          'indexingPipeline',
          'vectorService',
          'vectorStore',
          'vectorIndexWriter',
          'vectorLifecycleCoordinator',
        ]) {
          expect(() => handle.container.get(forbidden)).toThrow(/does not expose/);
        }
      } finally {
        handle.dispose();
        snapshotDb.close();
        snapshot.dispose();
      }
    } finally {
      writer.close();
    }
  });
});

function fingerprintFamily(paths: string[]): Record<string, string | null> {
  return Object.fromEntries(
    paths.map((filePath) => [
      path.basename(filePath),
      fs.existsSync(filePath)
        ? createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        : null,
    ])
  );
}
