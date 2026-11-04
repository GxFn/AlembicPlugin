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
 * 回归：receipt 导出路径的 source 端也必须限制在 source skill root 内。
 * 历史缺陷：skillName 合法但 receipt.asset.path 指向项目内任意文件（如 .env）时，
 * runtime 导出会创建 <hostSkillRoot>/<name>/SKILL.md -> .env 的软链接，
 * 随后 load({ name }) 直接把该文件内容返回给调用方。
 */

const SECRET = 'SECRET=topsecret';
const roots: string[] = [];

afterEach(() => {
  pathGuard._reset();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Project Skill receipt source confinement', () => {
  test('service export refuses a receipt whose asset.path points at a project file', () => {
    const root = makeProjectRoot();
    const ctx = createContext(root);
    const service = createProjectSkillService(ctx);

    const result = service.export({
      receipt: forgeReceipt(ctx, root, 'leak-env', path.join(root, '.env')),
      authorizeProjectSkillExport: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROJECT_SKILL_EXPORT_BLOCKED');
    expect(result.data?.runtimeExportStatus).toBe('blocked');
    expectNoRuntimeExport(root, 'leak-env');
    const loaded = service.load({ name: 'leak-env' });
    expect(JSON.stringify(loaded)).not.toContain(SECRET);
  });

  test('alembic_project_skill export + load cannot leak a project file', () => {
    const root = makeProjectRoot();
    const ctx = createContext(root);

    const exported = projectSkill(ctx, {
      operation: 'export',
      receipt: forgeReceipt(ctx, root, 'leak-env', path.join(root, '.env')),
      authorizeProjectSkillExport: true,
    }) as ProjectSkillServiceResult;
    const loaded = projectSkill(ctx, {
      operation: 'load',
      skillName: 'leak-env',
    }) as ProjectSkillServiceResult;

    expect(exported.success).toBe(false);
    expectNoRuntimeExport(root, 'leak-env');
    expect(JSON.stringify(loaded)).not.toContain(SECRET);
  });

  test.each([
    ['project file', (root: string) => path.join(root, '.env')],
    ['relative project file', () => '.env'],
    ['dot-dot escape', (root: string) => path.join(root, 'Alembic', 'skills', '..', '..', '.env')],
    [
      'another skill source',
      (root: string) => path.join(root, 'Alembic', 'skills', 'project-api', 'SKILL.md'),
    ],
    ['source root itself', (root: string) => path.join(root, 'Alembic', 'skills')],
    [
      'non SKILL.md file in own source dir',
      (root: string) => path.join(root, 'Alembic', 'skills', 'leak-env', 'skill.meta.json'),
    ],
  ])('runtime export blocks asset.path = %s before writing anything', (_label, assetPath) => {
    const root = makeProjectRoot();
    const ctx = createContext(root);
    writeSkill(root, 'leak-env');
    fs.writeFileSync(path.join(root, 'Alembic', 'skills', 'leak-env', 'skill.meta.json'), '{}\n');

    const result = exportProjectSkillReceiptToRuntime(ctx, {
      receipt: forgeReceipt(ctx, root, 'leak-env', assetPath(root)),
      authorize: true,
    });

    expect(result.runtimeExportStatus).toBe('blocked');
    expect(result.conflictStatus).toBe('blocked');
    expect(result.targetPath).toBeNull();
    expectNoRuntimeExport(root, 'leak-env');
  });

  test('runtime export blocks a canonical SKILL.md that is a symlink out of the source root', () => {
    const root = makeProjectRoot();
    const ctx = createContext(root);
    const skillDir = path.join(root, 'Alembic', 'skills', 'leak-env');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.symlinkSync(path.join(root, '.env'), path.join(skillDir, 'SKILL.md'), 'file');

    const result = exportProjectSkillReceiptToRuntime(ctx, {
      receipt: forgeReceipt(ctx, root, 'leak-env', path.join(skillDir, 'SKILL.md')),
      authorize: true,
    });

    expect(result.runtimeExportStatus).toBe('blocked');
    expectNoRuntimeExport(root, 'leak-env');
  });

  test('canonical source (file or directory form) still exports and loads', () => {
    const root = makeProjectRoot();
    const ctx = createContext(root);
    const sourcePath = writeSkill(root, 'team-api');

    for (const assetPath of [sourcePath, path.dirname(sourcePath)]) {
      const result = exportProjectSkillReceiptToRuntime(ctx, {
        receipt: forgeReceipt(ctx, root, 'team-api', assetPath),
        authorize: true,
      });
      expect(result.runtimeExportStatus).toBe('exported');
    }
    const targetSkillPath = path.join(getProjectSkillRoot(root), 'team-api', 'SKILL.md');
    expect(path.resolve(fs.readlinkSync(targetSkillPath))).toBe(path.resolve(sourcePath));
    const loaded = createProjectSkillService(ctx).load({ name: 'team-api' });
    expect(loaded.success).toBe(true);
    expect(JSON.stringify(loaded)).toContain('# Team Api');
  });
});

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-skill-source-'));
  roots.push(root);
  pathGuard.configure({ projectRoot: root });
  fs.writeFileSync(path.join(root, '.env'), `${SECRET}\n`);
  writeSkill(root, 'project-api');
  return root;
}

function writeSkill(root: string, name: string): string {
  const skillDir = path.join(root, 'Alembic', 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  const title = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${title}\n`);
  return skillPath;
}

/** 用合法 skillName 构造 receipt，再把 asset.path 换成调用方任意指定的路径（模拟 MCP 入参伪造）。 */
function forgeReceipt(
  ctx: ReturnType<typeof createContext>,
  root: string,
  skillName: string,
  assetPath: string
) {
  const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
    skillName,
    description: skillName,
    sourcePath: path.join(root, 'Alembic', 'skills', skillName, 'SKILL.md'),
  });
  return {
    ...receipt,
    asset: { ...receipt.asset, path: assetPath, contentHash: null },
    managedMarker: receipt.managedMarker
      ? { ...receipt.managedMarker, sourcePath: assetPath, generationHash: null }
      : receipt.managedMarker,
  };
}

function expectNoRuntimeExport(root: string, name: string): void {
  expect(fs.existsSync(path.join(getProjectSkillRoot(root), name))).toBe(false);
}

function createContext(root: string) {
  return {
    container: {
      singletons: { _projectRoot: root, _workspaceResolver: { dataRoot: root } },
      get: () => undefined,
    },
  };
}
