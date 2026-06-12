import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSkill, loadSkill } from '#codex/mcp/handlers/skill.js';
import {
  getCodexProjectSkillRoot,
  PROJECT_SKILL_MARKER_FILE,
} from '#codex/ProjectSkillDelivery.js';
import { createProjectSkillService } from '#service/skills/ProjectSkillService.js';

describe('ProjectSkillService', () => {
  afterEach(() => {
    pathGuard._reset();
  });

  test('does not generate knowledge-dependent project skills for an empty dataRoot', () => {
    const root = makeRoot();
    const service = createProjectSkillService(createContext(root));

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });

    expect(result.success).toBe(true);
    expect(result.data?.hasKnowledgeBase).toBe(false);
    expect(fs.existsSync(path.join(root, 'Alembic', 'skills', 'alembic-recipes', 'SKILL.md'))).toBe(
      false
    );
    expect(
      fs.existsSync(path.join(getCodexProjectSkillRoot(root), 'alembic-recipes', 'SKILL.md'))
    ).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('counts candidate markdown as knowledge and exports same-name project skills', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'Alembic', 'candidates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Alembic', 'candidates', 'candidate.md'), '# Candidate\n');
    const ctx = createContext(root);
    const service = createProjectSkillService(ctx);

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });

    const sourcePath = path.join(root, 'Alembic', 'skills', 'alembic-recipes', 'SKILL.md');
    const runtimePath = path.join(getCodexProjectSkillRoot(root), 'alembic-recipes', 'SKILL.md');
    expect(result.success).toBe(true);
    expect(result.data?.hasKnowledgeBase).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.lstatSync(runtimePath).isSymbolicLink()).toBe(true);
    expect(path.resolve(fs.readlinkSync(runtimePath))).toBe(path.resolve(sourcePath));
    expect(fs.readFileSync(runtimePath, 'utf8')).toContain(
      'This project has a local Alembic knowledge base'
    );

    const loaded = service.load({ name: 'alembic-recipes' });
    expect(loaded.data?.source).toBe('codex-runtime');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('counts recipe markdown and database knowledge_entries as knowledge', () => {
    const recipeRoot = makeRoot();
    fs.mkdirSync(path.join(recipeRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(recipeRoot, 'Alembic', 'recipes', 'recipe.md'), '# Recipe\n');
    expect(
      createProjectSkillService(createContext(recipeRoot)).collectKnowledgeScope()
    ).toMatchObject({
      hasKnowledgeBase: true,
      markdownFiles: [path.join(recipeRoot, 'Alembic', 'recipes', 'recipe.md')],
    });
    fs.rmSync(recipeRoot, { recursive: true, force: true });

    const dbRoot = makeRoot();
    fs.mkdirSync(path.join(dbRoot, '.asd'), { recursive: true });
    const db = new Database(path.join(dbRoot, '.asd', 'alembic.db'));
    db.prepare('CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY)').run();
    db.prepare('INSERT INTO knowledge_entries (id) VALUES (?)').run('entry-1');
    db.close();
    expect(createProjectSkillService(createContext(dbRoot)).collectKnowledgeScope()).toMatchObject({
      databaseEntries: 1,
      hasKnowledgeBase: true,
    });
    fs.rmSync(dbRoot, { recursive: true, force: true });
  });

  test('blocks unmanaged runtime target instead of overwriting it', () => {
    const root = makeRoot();
    const ctx = createContext(root);
    const service = createProjectSkillService(ctx);
    const targetDir = path.join(getCodexProjectSkillRoot(root), 'alembic-guard');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), '# User Skill\n');

    const result = service.upsert({
      authorizeProjectSkillExport: true,
      content: '# Guard Override\n',
      description: 'Project Guard override',
      name: 'alembic-guard',
      overwrite: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROJECT_SKILL_EXPORT_BLOCKED');
    expect(result.data?.runtimeExport).toMatchObject({
      conflictStatus: 'different-existing',
      status: 'blocked',
    });
    expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# User Skill\n');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('legacy create/load route uses service without built-in conflict or hooks', () => {
    const root = makeRoot();
    const hooks = { has: vi.fn(() => true), run: vi.fn(async () => undefined) };
    const ctx = createContext(root, hooks);

    const created = JSON.parse(
      createSkill(ctx, {
        content: '# Recipes Override\n',
        description: 'Project recipes override',
        name: 'alembic-recipes',
        overwrite: true,
      })
    );
    expect(created.success).toBe(true);
    expect(created.data.path).toBe(
      path.join(root, 'Alembic', 'skills', 'alembic-recipes', 'SKILL.md')
    );

    const loaded = JSON.parse(loadSkill(ctx, { skillName: 'alembic-recipes' }));
    expect(loaded.success).toBe(true);
    expect(loaded.data.source).toBe('project-source');
    expect(hooks.run).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('delete removes only managed runtime projection and keeps built-in fallback available', () => {
    const root = makeRoot();
    const service = createProjectSkillService(createContext(root));
    const created = service.upsert({
      authorizeProjectSkillExport: true,
      content: '# Guard Override\n',
      description: 'Project Guard override',
      name: 'alembic-guard',
      overwrite: true,
    });
    expect(created.success).toBe(true);
    expect(
      fs.existsSync(
        path.join(getCodexProjectSkillRoot(root), 'alembic-guard', PROJECT_SKILL_MARKER_FILE)
      )
    ).toBe(true);

    const deleted = service.delete({ name: 'alembic-guard' });
    expect(deleted.success).toBe(true);
    expect(deleted.data).toMatchObject({ builtInProtected: true, runtimeDeleted: true });
    expect(service.load({ name: 'alembic-guard' }).data?.source).toBe('builtin');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-skill-service-'));
  pathGuard.configure({ projectRoot: root });
  return root;
}

function createContext(root: string, hooks?: unknown) {
  return {
    container: {
      singletons: { _projectRoot: root, _dataRoot: root },
      get: () => hooks,
    },
  };
}
