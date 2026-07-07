import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CODEX_PLUGIN_ROOT_ENV,
  resolveHostRuntimeContext,
} from '../../lib/host-runtime/context/RuntimeContext.js';
import {
  buildPluginProjectSkillDeliveryReceipt,
  exportProjectSkillReceiptToRuntime,
  getProjectSkillRoot,
  PROJECT_SKILL_MARKER_FILE,
} from '#service/skills/ProjectSkillDelivery.js';

const ORIGINAL_PLUGIN_ROOT_ENV = process.env[CODEX_PLUGIN_ROOT_ENV];

describe('ProjectSkillDelivery', () => {
  afterEach(() => {
    if (ORIGINAL_PLUGIN_ROOT_ENV === undefined) {
      delete process.env[CODEX_PLUGIN_ROOT_ENV];
    } else {
      process.env[CODEX_PLUGIN_ROOT_ENV] = ORIGINAL_PLUGIN_ROOT_ENV;
    }
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
    expect(pathGuard.isProjectWriteSafe(targetSkillPath)).toBe(true);
    expect(
      pathGuard.isProjectWriteSafe(
        path.join(projectRoot, '.claude', 'skills', 'project-api', 'SKILL.md')
      )
    ).toBe(false);
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

  test('exports to the Claude Code project skill root through HostAdapter', () => {
    useClaudeCodeHost();
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

    const targetDir = path.join(projectRoot, '.claude', 'skills', 'project-api');
    const targetSkillPath = path.join(targetDir, 'SKILL.md');
    expect(getProjectSkillRoot(projectRoot)).toBe(path.join(projectRoot, '.claude', 'skills'));
    expect(exported.runtimeExportStatus).toBe('exported');
    expect(exported.receipt.authorization.codexSkillRoot).toBe(
      path.join(projectRoot, '.claude', 'skills')
    );
    expect(exported.receipt.runtimeExport.codexSkillRoot).toBe(
      path.join(projectRoot, '.claude', 'skills')
    );
    expect(exported.targetPath).toBe(targetDir);
    expect(path.resolve(fs.readlinkSync(targetSkillPath))).toBe(path.resolve(sourcePath));
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'skills', 'project-api'))).toBe(false);
    expect(pathGuard.isProjectWriteSafe(targetSkillPath)).toBe(true);
    expect(
      pathGuard.isProjectWriteSafe(path.join(projectRoot, '.agents', 'skills', 'project-api'))
    ).toBe(false);

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

function useClaudeCodeHost(): void {
  const codexShellRoot = resolveHostRuntimeContext().pluginRoot;
  process.env[CODEX_PLUGIN_ROOT_ENV] = path.join(codexShellRoot, '..', 'alembic-claude-code');
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
