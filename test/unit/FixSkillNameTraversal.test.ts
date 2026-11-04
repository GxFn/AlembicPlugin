import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, test } from 'vitest';
import { projectSkill } from '#host-runtime/mcp/handlers/skill.js';
import {
  buildPluginProjectSkillDeliveryReceipt,
  exportProjectSkillReceiptToRuntime,
  getProjectSkillRoot,
} from '#service/skills/ProjectSkillDelivery.js';
import {
  createProjectSkillService,
  type ProjectSkillServiceResult,
} from '#service/skills/ProjectSkillService.js';

/**
 * 回归：Project Skill 名称必须在所有操作上统一校验并限制在各自根目录内。
 * 历史缺陷：delete({ name: '..' }) 在 dataRoot == projectRoot 时递归删除整个
 * <dataRoot>/Alembic/（recipes / candidates / skills），且返回 success:true。
 */

const TRAVERSAL_NAMES = [
  '..',
  '.',
  '../x',
  'a/../..',
  '../skills',
  '/etc',
  'foo/bar',
  'Foo-Bar',
  'ab',
  'x'.repeat(65),
  'bad-',
];

// W3e-1：这些名称是单个安全路径段，只读 load 允许（不存在时为 SKILL_NOT_FOUND），
// 但所有写操作仍按严格 kebab-case 规则返回 INVALID_NAME。
const READABLE_LEGACY_NAMES = new Set(['Foo-Bar', 'ab', 'x'.repeat(65), 'bad-']);

const roots: string[] = [];

afterEach(() => {
  pathGuard._reset();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Project Skill name confinement', () => {
  test('delete("..") refuses and keeps the whole Alembic knowledge directory', () => {
    const root = makeKnowledgeRoot();
    const service = createProjectSkillService(createContext(root));

    const result = service.delete({ name: '..' });

    expect(fs.existsSync(path.join(root, 'Alembic'))).toBe(true);
    expectKnowledgeIntact(root);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_NAME');
  });

  test('alembic_project_skill operation=delete with skillName ".." is refused', () => {
    const root = makeKnowledgeRoot();

    const result = projectSkill(createContext(root), {
      operation: 'delete',
      skillName: '..',
    }) as ProjectSkillServiceResult;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_NAME');
    expectKnowledgeIntact(root);
  });

  test.each(TRAVERSAL_NAMES)('every name-taking operation rejects %j', (name) => {
    const root = makeKnowledgeRoot();
    const service = createProjectSkillService(createContext(root));

    const results = {
      load: service.load({ name }),
      export: service.export({ name, authorizeProjectSkillExport: true }),
      upsert: service.upsert({ name, content: '# X\n', description: 'x' }),
      delete: service.delete({ name }),
      deleteBySkillName: service.delete({ skillName: name }),
    };

    for (const [operation, result] of Object.entries(results)) {
      const expectedCode =
        operation === 'load' && READABLE_LEGACY_NAMES.has(name)
          ? 'SKILL_NOT_FOUND'
          : 'INVALID_NAME';
      expect({ operation, success: result.success }).toEqual({ operation, success: false });
      expect({ operation, code: result.errorCode }).toEqual({ operation, code: expectedCode });
    }
    expectKnowledgeIntact(root);
    expect(fs.existsSync(path.join(path.dirname(getProjectSkillRoot(root)), 'x'))).toBe(false);
  });

  test('empty name stays MISSING_PARAM for every operation and touches nothing', () => {
    const root = makeKnowledgeRoot();
    const service = createProjectSkillService(createContext(root));

    expect(service.load({ name: '' }).errorCode).toBe('MISSING_PARAM');
    expect(service.upsert({ name: '', content: 'x', description: 'x' }).errorCode).toBe(
      'MISSING_PARAM'
    );
    expect(service.delete({ name: '' }).errorCode).toBe('MISSING_PARAM');
    expect(service.export({ name: '' }).errorCode).toBe('PROJECT_SKILL_RECEIPT_NOT_FOUND');
    expectKnowledgeIntact(root);
  });

  test('load cannot read SKILL.md outside the skill roots', () => {
    const root = makeKnowledgeRoot();
    fs.mkdirSync(path.join(root, 'Alembic', 'secret'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Alembic', 'secret', 'SKILL.md'), 'TOP-SECRET\n');
    const service = createProjectSkillService(createContext(root));

    const result = service.load({ name: '../secret' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_NAME');
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET');
  });

  test('export refuses a receipt whose skillName escapes the runtime root', () => {
    const root = makeKnowledgeRoot();
    const ctx = createContext(root);
    const service = createProjectSkillService(ctx);
    const sourcePath = path.join(root, 'Alembic', 'skills', 'project-api', 'SKILL.md');
    const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
      skillName: 'project-api',
      description: 'Project API skill',
      sourcePath,
    });

    for (const skillName of ['../escape', '..', '/tmp/escape', 'Upper']) {
      const result = service.export({
        receipt: { ...receipt, skillName },
        authorizeProjectSkillExport: true,
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_NAME');
    }
    expect(fs.existsSync(path.join(path.dirname(getProjectSkillRoot(root)), 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'Alembic', 'delivery-receipt.json'))).toBe(false);
    expectKnowledgeIntact(root);
  });

  test('runtime export blocks traversal skill names before writing anything', () => {
    const root = makeKnowledgeRoot();
    const ctx = createContext(root);
    const sourcePath = path.join(root, 'Alembic', 'skills', 'project-api', 'SKILL.md');
    const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
      skillName: 'project-api',
      description: 'Project API skill',
      sourcePath,
    });

    const result = exportProjectSkillReceiptToRuntime(ctx, {
      receipt: { ...receipt, skillName: '../escape' },
      authorize: true,
    });

    expect(result.runtimeExportStatus).toBe('blocked');
    expect(result.conflictStatus).toBe('blocked');
    expect(result.targetPath).toBeNull();
    expect(fs.existsSync(path.join(path.dirname(getProjectSkillRoot(root)), 'escape'))).toBe(false);
  });

  test('receipt builder refuses traversal skill names', () => {
    const root = makeKnowledgeRoot();
    expect(() =>
      buildPluginProjectSkillDeliveryReceipt(createContext(root), {
        skillName: '../escape',
        sourcePath: path.join(root, 'Alembic', 'skills', 'project-api', 'SKILL.md'),
      })
    ).toThrow(/Invalid Project Skill name/);
  });

  test('valid names keep the upsert/load/export/delete round trip', () => {
    const root = makeKnowledgeRoot();
    const service = createProjectSkillService(createContext(root));

    const created = service.upsert({
      name: 'team-api',
      content: '# Team API\n',
      description: 'Team API skill',
    });
    expect(created.success).toBe(true);
    expect(service.load({ name: 'team-api' }).data?.source).toBe('project-source');
    const exported = service.export({ name: 'team-api', authorizeProjectSkillExport: true });
    expect(exported.success).toBe(true);
    expect(
      fs.lstatSync(path.join(getProjectSkillRoot(root), 'team-api', 'SKILL.md')).isSymbolicLink()
    ).toBe(true);
    const deleted = service.delete({ name: 'team-api' });
    expect(deleted.success).toBe(true);
    expect(deleted.data).toMatchObject({ sourceDeleted: true, runtimeDeleted: true });
    expect(fs.existsSync(path.join(root, 'Alembic', 'skills', 'team-api'))).toBe(false);
    expectKnowledgeIntact(root);
  });
});

function makeKnowledgeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-skill-name-'));
  roots.push(root);
  pathGuard.configure({ projectRoot: root });
  fs.mkdirSync(path.join(root, 'Alembic', 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alembic', 'recipes', 'recipe.md'), '# Recipe\n');
  fs.mkdirSync(path.join(root, 'Alembic', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alembic', 'candidates', 'candidate.md'), '# Candidate\n');
  const skillDir = path.join(root, 'Alembic', 'skills', 'project-api');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: project-api\ndescription: Project API skill\n---\n\n# Project API\n'
  );
  return root;
}

function expectKnowledgeIntact(root: string): void {
  expect(fs.existsSync(path.join(root, 'Alembic', 'recipes', 'recipe.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'Alembic', 'candidates', 'candidate.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'Alembic', 'skills', 'project-api', 'SKILL.md'))).toBe(true);
}

function createContext(root: string, dataRoot = root) {
  return {
    container: {
      singletons: { _projectRoot: root, _workspaceResolver: { dataRoot } },
      get: () => undefined,
    },
  };
}
