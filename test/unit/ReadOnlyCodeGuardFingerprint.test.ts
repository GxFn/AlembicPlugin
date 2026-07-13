import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { primeHandler } from '../../lib/host-runtime/mcp/handlers/agent-public-tools.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { executeReadOnlyCodeGuard } from '../../lib/host-runtime/mcp/host/read-only-code-guard-executor.js';

const roots: string[] = [];

describe('public Code Guard read-only storage fingerprint', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('keeps passing, violating, and prime-aligned calls physically read-only', async () => {
    const fixture = createGuardFixture();
    try {
      const baseline = snapshotLiveState(fixture);

      const passing = await runGuard(fixture, 'src/passing.ts');
      expect(passing.guard).toMatchObject({
        coverage: { completeness: 'complete', checked: 1, requested: 1 },
        resultSummary: { fileCount: 1, violationCount: 0 },
        verdict: 'passed',
      });
      expect(passing.guard.applicableRecipeRules).toEqual(
        expect.arrayContaining([expect.objectContaining({ recipeId: 'public-no-eval' })])
      );
      expect(snapshotLiveState(fixture)).toEqual(baseline);

      const violating = await runGuard(fixture, 'src/violating.ts');
      expect(violating.guard).toMatchObject({
        coverage: { completeness: 'complete', checked: 1, requested: 1 },
        verdict: 'failed',
      });
      expect(violating.guard.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'public-no-eval' })])
      );
      expect(snapshotLiveState(fixture)).toEqual(baseline);

      const primeRef = await createMatchingPrimeRef(fixture);
      const primeAligned = await runGuard(fixture, 'src/violating.ts', primeRef);
      expect(primeAligned.primeAlignment).toMatchObject({
        coverageComplete: true,
        feedbackGuardIds: ['public-no-eval'],
        feedbackRecorded: false,
        primeRef,
        status: 'observed',
        violatedGuardIds: ['public-no-eval'],
      });
      expect(snapshotLiveState(fixture)).toEqual(baseline);

      const outsidePath = path.join(fixture.dataRoot, 'outside.ts');
      fs.writeFileSync(outsidePath, 'export const outside = true;\n');
      const confined = await runGuard(fixture, outsidePath);
      expect(confined).toMatchObject({
        status: 'blocked',
        guard: {
          coverage: { completeness: 'partial', outOfRoot: 1, requested: 1 },
          verdict: 'blocked',
        },
      });
      expect(snapshotLiveState(fixture)).toEqual(baseline);
    } finally {
      fixture.writer.close();
    }
  });

  test('reports unavailable knowledge without creating storage', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-guard-empty-project-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-guard-empty-data-'));
    roots.push(projectRoot, dataRoot);
    const databasePath = path.join(dataRoot, '.asd', 'alembic.db');
    const result = (await executeReadOnlyCodeGuard(
      { code: 'export const value = 1;', language: 'typescript', projectRoot },
      {
        projectRoot,
        projectRuntime: {
          identity: {
            dataRoot,
            databasePath,
            projectId: 'empty-guard-project',
            projectRoot,
            projectScopeId: 'scope-empty-guard-project',
          },
        } as McpContext['projectRuntime'],
      }
    )) as { data: { project: { databaseExists: boolean }; status: string }; success: boolean };

    expect(result).toMatchObject({
      success: true,
      data: {
        project: { databaseExists: false },
        status: 'unavailable',
      },
    });
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});

interface GuardFixture {
  dataRoot: string;
  databasePath: string;
  family: string[];
  projectRoot: string;
  runtime: McpContext['projectRuntime'];
  writer: Database.Database;
}

interface PublicGuardOutput {
  guard: {
    applicableRecipeRules?: Array<{ recipeId: string }>;
    coverage?: Record<string, unknown>;
    resultSummary?: Record<string, unknown>;
    verdict?: string;
    violations?: Array<{ ruleId: string }>;
  };
  primeAlignment?: Record<string, unknown>;
  status?: string;
}

function createGuardFixture(): GuardFixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-guard-project-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-guard-data-'));
  roots.push(projectRoot, dataRoot);
  const sourceRoot = path.join(projectRoot, 'src');
  const asd = path.join(dataRoot, '.asd');
  const indexDir = path.join(asd, 'context', 'index');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'passing.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(sourceRoot, 'violating.ts'), 'eval("unsafe");\n');
  fs.writeFileSync(
    path.join(asd, 'config.json'),
    JSON.stringify({ vector: { localEmbedding: { enabled: false } } })
  );
  const vectorIndexPath = path.join(indexDir, 'vector_index.asvec');
  fs.writeFileSync(vectorIndexPath, 'guard-vector-fingerprint');

  const databasePath = path.join(asd, 'alembic.db');
  const writer = createGuardDatabase(databasePath);
  seedGuardKnowledge(writer);
  const runtime = {
    identity: {
      dataRoot,
      databasePath,
      projectId: 'guard-fingerprint-project',
      projectRoot,
      projectScopeId: 'scope-guard-fingerprint-project',
    },
  } as McpContext['projectRuntime'];
  return {
    dataRoot,
    databasePath,
    family: [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      vectorIndexPath,
      path.join(asd, 'config.json'),
    ],
    projectRoot,
    runtime,
    writer,
  };
}

function createGuardDatabase(databasePath: string): Database.Database {
  const writer = new Database(databasePath);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec(`
    CREATE TABLE knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      language TEXT,
      dimensionId TEXT,
      category TEXT,
      knowledgeType TEXT,
      kind TEXT,
      scope TEXT,
      source TEXT,
      content TEXT,
      lifecycle TEXT,
      tags TEXT,
      trigger TEXT,
      difficulty TEXT,
      quality TEXT,
      stats TEXT,
      headers TEXT,
      moduleName TEXT,
      whenClause TEXT,
      doClause TEXT,
      dontClause TEXT,
      constraints TEXT,
      updatedAt INTEGER,
      createdAt INTEGER
    );
    CREATE TABLE recipe_source_refs (
      recipe_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL,
      new_path TEXT,
      verified_at INTEGER
    );
    CREATE TABLE guard_violations (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      violation_count INTEGER DEFAULT 0,
      summary TEXT,
      violations_json TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      tool TEXT,
      surface TEXT
    );
  `);
  return writer;
}

function seedGuardKnowledge(writer: Database.Database): void {
  writer
    .prepare(
      `INSERT INTO knowledge_entries (
        id, title, description, language, knowledgeType, kind, scope, content,
        lifecycle, tags, trigger, difficulty, quality, stats, headers, moduleName,
        whenClause, doClause, dontClause, constraints, updatedAt, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'public-no-eval',
      'Public Guard no eval',
      'Public Guard must report eval usage without mutating knowledge.',
      'typescript',
      'boundary-constraint',
      'rule',
      'file',
      '{}',
      'active',
      '[]',
      '@public-no-eval',
      'medium',
      '{}',
      JSON.stringify({ guardHits: 7, primeAdoptions: 3 }),
      '[]',
      'Guard',
      'When public TypeScript is checked.',
      'Report eval usage.',
      'Do not persist public Guard feedback.',
      JSON.stringify({
        guards: [
          {
            id: 'public-no-eval',
            message: 'Avoid eval in public code.',
            name: 'Public no eval',
            pattern: '\\beval\\s*\\(',
            severity: 'error',
          },
        ],
      }),
      1_700_000_000,
      1_700_000_000
    );
  const insertRef = writer.prepare(
    'INSERT INTO recipe_source_refs (recipe_id, source_path, status) VALUES (?, ?, ?)'
  );
  insertRef.run('public-no-eval', 'src/passing.ts:1', 'active');
  insertRef.run('public-no-eval', 'src/violating.ts:1', 'active');
  writer
    .prepare(
      `INSERT INTO guard_violations (
        id, file_path, triggered_at, violation_count, summary, violations_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run('baseline-run', 'src/existing.ts', '2026-07-12T00:00:00.000Z', 1, 'baseline', '[]', 1);
}

async function runGuard(
  fixture: GuardFixture,
  file: string,
  primeRef?: string
): Promise<PublicGuardOutput> {
  return (await executeReadOnlyCodeGuard(
    {
      files: [file],
      operation: 'review',
      projectRoot: fixture.projectRoot,
      ...(primeRef ? { primeRef } : {}),
    },
    {
      projectRoot: fixture.projectRoot,
      projectRuntime: fixture.runtime,
    }
  )) as PublicGuardOutput;
}

async function createMatchingPrimeRef(fixture: GuardFixture): Promise<string> {
  const output = (await primeHandler(
    {
      container: {
        get(name: string): unknown {
          if (name === 'primeSearchPipeline') {
            return {
              async search() {
                return {
                  relatedKnowledge: [],
                  guardRules: [
                    {
                      id: 'public-no-eval',
                      title: 'Public Guard no eval',
                      trigger: '@public-no-eval',
                      kind: 'rule',
                      language: 'typescript',
                      score: 1,
                      description: 'Report eval usage without mutation.',
                      sourceRefs: ['src/violating.ts:1'],
                    },
                  ],
                  searchMeta: {
                    queries: ['public no eval'],
                    scenario: '',
                    language: 'typescript',
                    module: null,
                    resultCount: 1,
                    filteredCount: 1,
                    route: 'keyword',
                    requestedMode: 'auto',
                    actualMode: 'keyword',
                    semanticUsed: false,
                    vectorUsed: false,
                  },
                };
              },
            };
          }
          throw new Error(`Prime fingerprint fixture does not expose ${name}.`);
        },
      },
      projectRuntime: fixture.runtime,
    } as McpContext,
    { query: 'public no eval' }
  )) as { primePackage: { primeRef: string } };
  return output.primePackage.primeRef;
}

function snapshotLiveState(fixture: GuardFixture) {
  const knowledge = fixture.writer
    .prepare('SELECT id, stats, updatedAt FROM knowledge_entries ORDER BY id')
    .all();
  const violations = fixture.writer
    .prepare('SELECT id, file_path, violation_count, summary FROM guard_violations ORDER BY id')
    .all();
  return {
    files: fingerprintFamily(fixture.family),
    knowledge,
    violations,
  };
}

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
