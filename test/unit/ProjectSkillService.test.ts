import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALEMBIC_MANAGED_GUIDANCE_BEGIN,
  ALEMBIC_MANAGED_GUIDANCE_END,
  pathGuard,
} from '@alembic/core/io';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSkill, loadSkill } from '#host-runtime/mcp/handlers/skill.js';
import {
  getProjectSkillRoot,
  PROJECT_SKILL_MARKER_FILE,
} from '#service/skills/ProjectSkillDelivery.js';
import { createProjectSkillService } from '#service/skills/ProjectSkillService.js';

const ORIGINAL_PLUGIN_HOST = process.env.ALEMBIC_PLUGIN_HOST;

describe('ProjectSkillService', () => {
  afterEach(() => {
    if (ORIGINAL_PLUGIN_HOST === undefined) {
      delete process.env.ALEMBIC_PLUGIN_HOST;
    } else {
      process.env.ALEMBIC_PLUGIN_HOST = ORIGINAL_PLUGIN_HOST;
    }
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
    expect(fs.existsSync(path.join(getProjectSkillRoot(root), 'alembic-recipes', 'SKILL.md'))).toBe(
      false
    );
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
    const runtimePath = path.join(getProjectSkillRoot(root), 'alembic-recipes', 'SKILL.md');
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

  test('writes an idempotent Codex host guidance block without touching user content', () => {
    const root = makeRoot();
    process.env.ALEMBIC_PLUGIN_HOST = 'codex';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# User Rules\n\nKeep this section.\n');
    writeCandidate(root);
    const service = createProjectSkillService(createContext(root));

    const first = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });
    const afterFirst = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const second = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });
    const afterSecond = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.data?.hostGuidance).toMatchObject({
      enabled: true,
      hostFileName: 'AGENTS.md',
      operation: 'upsert',
    });
    expect(afterFirst).toContain('# User Rules\n\nKeep this section.\n');
    expect(afterFirst).toContain(ALEMBIC_MANAGED_GUIDANCE_BEGIN);
    expect(afterFirst).toContain(ALEMBIC_MANAGED_GUIDANCE_END);
    expect(afterFirst).toContain("grounded in THIS project's own code");
    expect(afterFirst).toContain('alembic_search "error handling"');
    expect(afterSecond).toBe(afterFirst);
    expect(countOccurrences(afterSecond, ALEMBIC_MANAGED_GUIDANCE_BEGIN)).toBe(1);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(pathGuard.isProjectWriteSafe(path.join(root, 'AGENTS.md'))).toBe(true);
    expect(pathGuard.isProjectWriteSafe(path.join(root, 'CLAUDE.md'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('removes only the managed host guidance block when the knowledge base disappears', () => {
    const root = makeRoot();
    const hostFile = path.join(root, 'AGENTS.md');
    fs.writeFileSync(
      hostFile,
      [
        '# User Rules',
        '',
        'Keep this section.',
        ALEMBIC_MANAGED_GUIDANCE_BEGIN,
        '- stale Alembic pointer',
        ALEMBIC_MANAGED_GUIDANCE_END,
        'Keep the footer.',
        '',
      ].join('\n')
    );
    const service = createProjectSkillService(createContext(root));

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });
    const content = fs.readFileSync(hostFile, 'utf8');

    expect(result.success).toBe(true);
    expect(result.data?.hostGuidance).toMatchObject({
      blockFound: true,
      changed: true,
      hostFileName: 'AGENTS.md',
      operation: 'remove',
      reason: 'no-knowledge-base',
      wrote: true,
    });
    expect(content).toContain('# User Rules');
    expect(content).toContain('Keep the footer.');
    expect(content).not.toContain(ALEMBIC_MANAGED_GUIDANCE_BEGIN);
    expect(content).not.toContain('stale Alembic pointer');
    expect(fs.existsSync(hostFile)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('selects the Claude Code host file and leaves the Codex host file untouched', () => {
    const root = makeRoot();
    process.env.ALEMBIC_PLUGIN_HOST = 'claude-code';
    writeCandidate(root);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing Codex Instructions\n');
    const service = createProjectSkillService(createContext(root));

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });

    expect(result.success).toBe(true);
    expect(result.data?.hostGuidance).toMatchObject({
      hostFileName: 'CLAUDE.md',
      operation: 'upsert',
    });
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(
      ALEMBIC_MANAGED_GUIDANCE_BEGIN
    );
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(
      '# Existing Codex Instructions\n'
    );
    expect(pathGuard.isProjectWriteSafe(path.join(root, 'CLAUDE.md'))).toBe(true);
    expect(pathGuard.isProjectWriteSafe(path.join(root, 'AGENTS.md'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('skips project-root host guidance for ghost data roots', () => {
    const projectRoot = makeRoot();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-skill-data-root-'));
    pathGuard.addAllowPath(dataRoot);
    writeCandidate(dataRoot);
    const service = createProjectSkillService(createContext(projectRoot, undefined, dataRoot));

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: false });

    expect(result.success).toBe(true);
    expect(result.data?.hasKnowledgeBase).toBe(true);
    expect(result.data?.hostGuidance).toMatchObject({
      hostFileName: 'AGENTS.md',
      operation: 'skip',
      reason: 'non-standard-or-ghost-data-root',
    });
    expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
    expect(
      fs.existsSync(path.join(dataRoot, 'Alembic', 'skills', 'alembic-recipes', 'SKILL.md'))
    ).toBe(true);
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  test('removes stale host guidance when workspace config disables it', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.asd'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.asd', 'config.json'),
      JSON.stringify({ projectSkills: { hostGuidance: { enabled: false } } }, null, 2)
    );
    writeCandidate(root);
    const hostFile = path.join(root, 'AGENTS.md');
    fs.writeFileSync(
      hostFile,
      `${ALEMBIC_MANAGED_GUIDANCE_BEGIN}\n- old pointer\n${ALEMBIC_MANAGED_GUIDANCE_END}\nUser footer.\n`
    );
    const service = createProjectSkillService(createContext(root));

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });
    const content = fs.readFileSync(hostFile, 'utf8');

    expect(result.success).toBe(true);
    expect(result.data?.hostGuidance).toMatchObject({
      configSource: 'workspace-config',
      enabled: false,
      operation: 'remove',
      reason: 'host-guidance-disabled',
    });
    expect(content).toBe('\nUser footer.\n');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('surfaces malformed managed host guidance markers without refreshing skills', () => {
    const root = makeRoot();
    writeCandidate(root);
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      `${ALEMBIC_MANAGED_GUIDANCE_BEGIN}\nmissing end`
    );
    const service = createProjectSkillService(createContext(root));

    const result = service.refreshKnowledgeSkills({ authorizeProjectSkillExport: true });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('HOST_GUIDANCE_SYNC_FAILED');
    expect(result.message).toBe('Failed to sync Alembic managed host guidance block.');
    expect(result.data?.hostGuidance).toMatchObject({
      hostFileName: 'AGENTS.md',
      operation: 'skip',
      reason: 'sync-failed',
    });
    expect(fs.existsSync(path.join(root, 'Alembic', 'skills', 'alembic-recipes', 'SKILL.md'))).toBe(
      false
    );
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
    const targetDir = path.join(getProjectSkillRoot(root), 'alembic-guard');
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
        path.join(getProjectSkillRoot(root), 'alembic-guard', PROJECT_SKILL_MARKER_FILE)
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

function writeCandidate(root: string): void {
  fs.mkdirSync(path.join(root, 'Alembic', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alembic', 'candidates', 'candidate.md'), '# Candidate\n');
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function createContext(root: string, hooks?: unknown, dataRoot = root) {
  return {
    container: {
      singletons: { _projectRoot: root, _workspaceResolver: { dataRoot } },
      get: () => hooks,
    },
  };
}
