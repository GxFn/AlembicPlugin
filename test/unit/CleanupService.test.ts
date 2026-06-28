import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CleanupService } from '../../lib/service/cleanup/CleanupService.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('CleanupService', () => {
  test('fullReset clears current project-index and deep-mining data tables', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    const executedSql: string[] = [];
    const db = {
      exec(sql: string) {
        executedSql.push(sql);
      },
      prepare() {
        return {
          run() {},
          all() {
            return [];
          },
          get() {
            return undefined;
          },
        };
      },
      close() {},
    };

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir, db });
    await service.fullReset();

    expect(executedSql).toContain('DELETE FROM coverage_ledger');
    expect(executedSql).toContain('DELETE FROM deep_mining_rounds');
    expect(executedSql).toContain('DELETE FROM project_context_file_snapshots');
    expect(executedSql).toContain('DELETE FROM git_diff_checkpoints');
    expect(executedSql).toContain('DELETE FROM source_graph_edges');
    expect(executedSql).toContain('DELETE FROM source_graph_generations');
  });

  test('fullReset fails closed on non-missing-table database clear errors', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    const warnings: string[] = [];
    const db = {
      exec(sql: string) {
        if (sql === 'DELETE FROM knowledge_entries') {
          throw new Error('database disk image is malformed');
        }
      },
      prepare() {
        return {
          run() {},
          all() {
            return [];
          },
          get() {
            return undefined;
          },
        };
      },
      close() {},
    };
    const logger = {
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
    };

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir, db, logger });

    await expect(service.fullReset()).rejects.toThrow(
      'fullReset aborted: destructive rebuild could not clear critical database tables'
    );
    expect(warnings.join('\n')).toContain(
      'Failed to clear knowledge_entries: database disk image is malformed'
    );
  });

  test('rescanClean preserves incremental evidence tables', async () => {
    const executedSql: string[] = [];
    const db = {
      exec(sql: string) {
        executedSql.push(sql);
      },
      prepare() {
        return {
          run() {},
          all() {
            return [];
          },
        };
      },
      close() {},
    };

    const service = new CleanupService({ projectRoot: '/project', db });
    await service.rescanClean();

    expect(executedSql).not.toContain('DELETE FROM bootstrap_snapshots');
    expect(executedSql).not.toContain('DELETE FROM bootstrap_dim_files');
    expect(executedSql).not.toContain('DELETE FROM recipe_source_refs');
  });

  test('rescanClean removes the runtime bootstrap report from dataRoot', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    fs.mkdirSync(path.join(tmpDir, '.asd'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'Alembic', '.asd'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.asd', 'bootstrap-report.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'Alembic', '.asd', 'bootstrap-report.json'), '{}');

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir });
    const result = await service.rescanClean();

    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, '.asd', 'bootstrap-report.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'Alembic', '.asd', 'bootstrap-report.json'))).toBe(true);
  });

  test('rescanClean preserves Project Skill source files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    const skillPath = path.join(tmpDir, 'Alembic', 'skills', 'project-architecture', 'SKILL.md');
    const candidatePath = path.join(tmpDir, 'Alembic', 'candidates', 'candidate.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(skillPath, '# Project Architecture\n');
    fs.writeFileSync(candidatePath, '# Candidate\n');

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir });
    await service.rescanClean();

    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(candidatePath)).toBe(false);
  });

  test('forceRescanClean preserves Project Skill source files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    const skillPath = path.join(tmpDir, 'Alembic', 'skills', 'project-architecture', 'SKILL.md');
    const candidatePath = path.join(tmpDir, 'Alembic', 'candidates', 'candidate.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(skillPath, '# Project Architecture\n');
    fs.writeFileSync(candidatePath, '# Candidate\n');

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir });
    await service.forceRescanClean();

    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(candidatePath)).toBe(false);
  });
});
