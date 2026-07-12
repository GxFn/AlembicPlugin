import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAlembicRepositories } from '@alembic/core/repositories';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { attachCodeGuardAuxiliaryFailure } from '../../lib/host-runtime/mcp/host/code-guard-auxiliary-failure.js';
import { attachPluginOpportunisticEvolutionSurface } from '../../lib/host-runtime/mcp/host/opportunistic-evolution-presenter.js';
import { AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS } from '../../lib/host-runtime/mcp/public-tools/output.js';
import {
  getServiceContainer,
  resetServiceContainer,
} from '../../lib/injection/ServiceContainer.js';

const tempRoots: string[] = [];
const openDatabases: Database.Database[] = [];

describe('Guard request-scoped data-root isolation', () => {
  afterEach(() => {
    resetServiceContainer();
    for (const db of openDatabases.splice(0)) {
      if (db.open) {
        db.close();
      }
    }
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('keeps sequential Guard checkpoint writes in each requested data root', async () => {
    const first = createRequestFixture('first');
    const second = createRequestFixture('second');
    bindLegacyGlobalContainer(second.db);

    await executeGuardMaintenance(first);
    await executeGuardMaintenance(second);

    expect(readCheckpointRows(first.db)).toEqual([
      expect.objectContaining({
        checkpoint_commit: first.head,
        project_root: first.projectRoot,
      }),
    ]);
    expect(readCheckpointRows(second.db)).toEqual([
      expect.objectContaining({
        checkpoint_commit: second.head,
        project_root: second.projectRoot,
      }),
    ]);
  });

  test('keeps concurrent Guard checkpoint writes free of foreign roots and commits', async () => {
    const first = createRequestFixture('parallel-first');
    const second = createRequestFixture('parallel-second');
    bindLegacyGlobalContainer(second.db);

    await Promise.all([executeGuardMaintenance(first), executeGuardMaintenance(second)]);

    expect(readCheckpointRows(first.db)).toEqual([
      expect.objectContaining({
        checkpoint_commit: first.head,
        project_root: first.projectRoot,
      }),
    ]);
    expect(readCheckpointRows(second.db)).toEqual([
      expect.objectContaining({
        checkpoint_commit: second.head,
        project_root: second.projectRoot,
      }),
    ]);
    expect(JSON.stringify(readCheckpointRows(first.db))).not.toContain(second.projectRoot);
    expect(JSON.stringify(readCheckpointRows(first.db))).not.toContain(second.head);
    expect(JSON.stringify(readCheckpointRows(second.db))).not.toContain(first.projectRoot);
    expect(JSON.stringify(readCheckpointRows(second.db))).not.toContain(first.head);
  });

  test('keeps the Guard verdict but degrades the public envelope when request maintenance fails', async () => {
    const healthyGlobal = createRequestFixture('healthy-global');
    const malformed = createRequestFixture('malformed-request');
    malformed.db.close();
    fs.writeFileSync(malformed.databasePath, 'not a sqlite database');
    bindLegacyGlobalContainer(healthyGlobal.db);

    const output = (await executeGuardMaintenance(malformed)) as Record<string, unknown>;

    expect(output.status).toBe('degraded');
    expect(output.ok).toBe(true);
    expect(output.guard).toMatchObject({ verdict: 'passed' });
    expect(output.reason).toMatchObject({ kind: 'degraded' });
    expect(output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'guard-maintenance-failed',
          severity: 'error',
        }),
      ])
    );
    const parsedOutput = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.safeParse(output);
    expect(
      parsedOutput.success,
      parsedOutput.success ? undefined : JSON.stringify(parsedOutput.error.issues)
    ).toBe(true);
    expect(readCheckpointRows(healthyGlobal.db)).toEqual([]);
  });

  test('does not downgrade an existing blocked Guard result when auxiliary diagnostics are added', () => {
    const output = attachCodeGuardAuxiliaryFailure({
      diagnosticCode: 'guard-maintenance-failed',
      message: 'fixture maintenance failure',
      result: {
        reason: { kind: 'blocked', code: 'missing-guard-scope' },
        status: 'blocked',
      },
    }) as Record<string, unknown>;

    expect(output).toMatchObject({
      reason: { kind: 'blocked', code: 'missing-guard-scope' },
      status: 'blocked',
    });
    expect(output.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'guard-maintenance-failed' })])
    );
  });
});

interface RequestFixture {
  databasePath: string;
  db: Database.Database;
  head: string;
  projectRoot: string;
}

function createRequestFixture(label: string): RequestFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `alembic-guard-isolation-${label}-`));
  tempRoots.push(root);
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  const databasePath = path.join(dataRoot, '.asd', 'alembic.db');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), `${label}\n`);
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'alembic@example.test']);
  git(projectRoot, ['config', 'user.name', 'Alembic Test']);
  git(projectRoot, ['add', 'README.md']);
  git(projectRoot, ['commit', '-m', `initialize ${label}`]);
  const head = git(projectRoot, ['rev-parse', 'HEAD']);
  const db = new Database(databasePath);
  openDatabases.push(db);
  createCheckpointSchema(db);
  return { databasePath, db, head, projectRoot };
}

function createCheckpointSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE git_diff_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_root TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      checkpoint_commit TEXT,
      initial_from_plan_commit TEXT,
      merge_base_commit TEXT,
      target_commit TEXT,
      last_route_status TEXT NOT NULL DEFAULT 'initialized',
      last_route_reason TEXT,
      last_scanned_at INTEGER,
      advanced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX git_diff_checkpoints_scope_unique
      ON git_diff_checkpoints(project_root, scope_id, folder_id);
  `);
}

function bindLegacyGlobalContainer(db: Database.Database): void {
  resetServiceContainer();
  const repositories = createRepositories(db);
  const container = getServiceContainer();
  container.register('gitDiffCheckpointRepository', () => repositories.gitDiffCheckpointRepository);
  container.register('recipeSourceRefRepository', () => repositories.recipeSourceRefRepository);
  container.register('knowledgeRepository', () => repositories.knowledgeRepository);
}

function createRepositories(db: Database.Database) {
  const orm = drizzle(db);
  return createAlembicRepositories({
    getDb: () => db,
    getDrizzle: () => orm,
  } as never);
}

async function executeGuardMaintenance(fixture: RequestFixture): Promise<unknown> {
  return attachPluginOpportunisticEvolutionSurface({
    args: { projectRoot: fixture.projectRoot },
    executionContext: {
      projectRoot: fixture.projectRoot,
      projectRuntime: {
        identity: {
          databasePath: fixture.databasePath,
          dataRoot: path.dirname(path.dirname(fixture.databasePath)),
          projectRoot: fixture.projectRoot,
        },
      },
      projectScopeIdentity: null,
      residentProjectScopeAvailable: true,
    } as never,
    projectRoot: fixture.projectRoot,
    result: {
      actionKind: 'code-guard',
      agentHost: 'codex',
      guard: {
        ok: true,
        resultSummary: { payloadType: 'object' },
        verdict: 'passed',
      },
      inputSource: 'automation-envelope',
      ok: true,
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Code Guard passed.',
      toolName: 'alembic_code_guard',
    },
    toolName: 'alembic_code_guard',
  });
}

function readCheckpointRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT project_root, scope_id, folder_id, checkpoint_commit
       FROM git_diff_checkpoints
       ORDER BY project_root, scope_id, folder_id`
    )
    .all() as Array<Record<string, unknown>>;
}

function git(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
