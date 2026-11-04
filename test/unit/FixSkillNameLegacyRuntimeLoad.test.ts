import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, test } from 'vitest';
import { projectSkill } from '#host-runtime/mcp/handlers/skill.js';
import { getProjectSkillRoot } from '#service/skills/ProjectSkillDelivery.js';
import {
  createProjectSkillService,
  type ProjectSkillServiceResult,
} from '#service/skills/ProjectSkillService.js';

/**
 * W3e-1 回归：list 会枚举宿主 runtime skill 根目录下的任意目录名（例如用户手工创建的
 * "ui" / "My_Skill"），只读 load 必须能加载这些名称；写操作（upsert/create/update/delete/
 * export）继续使用严格 kebab-case 规则，并在错误信息里说明这是只读的历史名称。
 */

const LEGACY_NAMES = ['ui', 'My_Skill', 'Foo-Bar', 'bad-'];
const roots: string[] = [];

afterEach(() => {
  pathGuard._reset();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('W3e-1: legacy runtime skill names are loadable but not writable', () => {
  test.each(LEGACY_NAMES)('list enumerates %j and load returns its content', (name) => {
    const root = makeProjectRoot();
    writeRuntimeSkill(root, name, `# ${name} body\n`);
    const service = createProjectSkillService(createContext(root));

    const listed = service.list();
    const names = (listed.data?.skills as Array<{ name: string }>).map((skill) => skill.name);
    expect(names).toContain(name);

    const loaded = service.load({ name });
    expect(loaded.success).toBe(true);
    expect(loaded.data?.source).toBe('codex-runtime');
    expect(loaded.data?.content).toContain(`# ${name} body`);

    const viaTool = projectSkill(createContext(root), {
      operation: 'load',
      skillName: name,
    }) as ProjectSkillServiceResult;
    expect(viaTool.success).toBe(true);
  });

  test.each(LEGACY_NAMES)('delete of legacy name %j stays refused and says why', (name) => {
    const root = makeProjectRoot();
    const skillDir = writeRuntimeSkill(root, name, '# legacy\n');
    const service = createProjectSkillService(createContext(root));

    const result = service.delete({ name });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_NAME');
    expect(result.message).toMatch(/write operation/i);
    expect(result.message).toMatch(/read-only|only be listed and loaded/i);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
  });

  test.each(LEGACY_NAMES)('upsert/export of legacy name %j stay refused', (name) => {
    const root = makeProjectRoot();
    const service = createProjectSkillService(createContext(root));

    const upsert = service.upsert({ name, content: '# X\n', description: 'x' });
    const exported = service.export({ name, authorizeProjectSkillExport: true });

    for (const result of [upsert, exported]) {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_NAME');
    }
    expect(fs.existsSync(path.join(root, 'Alembic', 'skills', name))).toBe(false);
  });

  test.each([
    '..',
    '.',
    '../ui',
    'a/b',
    'a\\b',
    '/etc',
    'nul\u0000byte',
    'x'.repeat(129),
  ])('load still refuses unsafe segment %j with INVALID_NAME', (name) => {
    const root = makeProjectRoot();
    const service = createProjectSkillService(createContext(root));

    const result = service.load({ name });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_NAME');
  });

  test('load of a safe but missing legacy name is SKILL_NOT_FOUND', () => {
    const root = makeProjectRoot();
    const service = createProjectSkillService(createContext(root));

    const result = service.load({ name: 'Not_There' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SKILL_NOT_FOUND');
  });
});

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-skill-legacy-'));
  roots.push(root);
  pathGuard.configure({ projectRoot: root });
  fs.mkdirSync(path.join(root, 'Alembic', 'skills'), { recursive: true });
  return root;
}

function writeRuntimeSkill(root: string, name: string, body: string): string {
  const skillDir = path.join(getProjectSkillRoot(root), name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}`);
  return skillDir;
}

function createContext(root: string, dataRoot = root) {
  return {
    container: {
      singletons: { _projectRoot: root, _workspaceResolver: { dataRoot } },
      get: () => undefined,
    },
  };
}
