import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildPluginProjectSkillDeliveryReceipt,
  exportProjectSkillReceiptToRuntime,
  getProjectSkillRoot,
  PROJECT_SKILL_MARKER_FILE,
} from '#codex/ProjectSkillDelivery.js';

describe('ProjectSkillDelivery', () => {
  afterEach(() => {
    pathGuard._reset();
  });

  test('blocks runtime export until project-scoped authorization is granted', () => {
    const projectRoot = makeProjectRoot();
    const sourcePath = writeSourceSkill(projectRoot, 'project-api');
    const ctx = createContext(projectRoot);
    const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
      skillName: 'project-api',
      description: 'Project API skill',
      sourcePath,
    });

    const result = exportProjectSkillReceiptToRuntime(ctx, { receipt });

    expect(result.runtimeExportStatus).toBe('blocked');
    expect(result.authorizationStatus).toBe('pending');
    expect(result.conflictStatus).toBe('blocked');
    expect(
      fs.existsSync(path.join(getProjectSkillRoot(projectRoot), 'project-api', 'SKILL.md'))
    ).toBe(false);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('exports to the Codex project skill root with symlink-first delivery and marker metadata', () => {
    const projectRoot = makeProjectRoot();
    const sourcePath = writeSourceSkill(projectRoot, 'project-api');
    const ctx = createContext(projectRoot);
    const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
      skillName: 'project-api',
      description: 'Project API skill',
      sourcePath,
    });

    const exported = exportProjectSkillReceiptToRuntime(ctx, {
      receipt,
      authorize: true,
      grantedBy: 'unit-test',
    });

    const targetDir = path.join(getProjectSkillRoot(projectRoot), 'project-api');
    const targetSkillPath = path.join(targetDir, 'SKILL.md');
    const markerPath = path.join(targetDir, PROJECT_SKILL_MARKER_FILE);
    expect(exported.runtimeExportStatus).toBe('exported');
    expect(exported.authorizationStatus).toBe('granted');
    expect(exported.conflictStatus).toBe('target-missing');
    expect(fs.lstatSync(targetSkillPath).isSymbolicLink()).toBe(true);
    expect(path.resolve(fs.readlinkSync(targetSkillPath))).toBe(path.resolve(sourcePath));
    expect(fs.readFileSync(targetSkillPath, 'utf8')).toContain('# Project API');
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({
      managedBy: 'alembic',
      projectRoot,
      route: 'plugin',
      skillName: 'project-api',
      sourcePath,
    });

    const refreshed = exportProjectSkillReceiptToRuntime(ctx, {
      receipt: exported.receipt,
      authorize: true,
      grantedBy: 'unit-test',
    });
    expect(refreshed.runtimeExportStatus).toBe('exported');
    expect(refreshed.conflictStatus).toBe('compatible-existing');

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('blocks unmanaged existing Codex runtime skill targets', () => {
    const projectRoot = makeProjectRoot();
    const sourcePath = writeSourceSkill(projectRoot, 'project-api');
    const targetDir = path.join(getProjectSkillRoot(projectRoot), 'project-api');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), '# Unmanaged\n', 'utf8');

    const ctx = createContext(projectRoot);
    const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
      skillName: 'project-api',
      description: 'Project API skill',
      sourcePath,
    });
    const result = exportProjectSkillReceiptToRuntime(ctx, {
      receipt,
      authorize: true,
      grantedBy: 'unit-test',
    });

    expect(result.runtimeExportStatus).toBe('blocked');
    expect(result.conflictStatus).toBe('different-existing');
    expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Unmanaged\n');

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

function makeProjectRoot(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-skill-'));
  pathGuard.configure({ projectRoot });
  return projectRoot;
}

function createContext(projectRoot: string) {
  return {
    container: {
      singletons: { _projectRoot: projectRoot },
    },
  };
}

function writeSourceSkill(projectRoot: string, skillName: string): string {
  const skillDir = path.join(projectRoot, 'Alembic', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const sourcePath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(
    sourcePath,
    [
      '---',
      `name: ${skillName}`,
      'description: Project API skill',
      '---',
      '',
      '# Project API',
      '',
    ].join('\n'),
    'utf8'
  );
  return sourcePath;
}
