import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpaceContext } from '@alembic/core/project-context';
import { afterEach, describe, expect, test } from 'vitest';
import { buildHostAgentProjectContextAnalysis } from '../../lib/recipe-pipeline/generate/project-context-analysis.js';

// F6：采集在 Core 的共用采集器里，这里不再 mock 请求，直接对真实夹具验证范围的传递结果。
const tempRoots: string[] = [];
const ALEMBIC_MEMBER_FOLDERS = [
  'Alembic',
  'AlembicCore',
  'AlembicPlugin',
  'AlembicDashboard',
  'AlembicAgent',
] as const;

describe('Host Agent ProjectContext scoped production parity', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  test('threads native sourceFolders through production analysis outputs', async () => {
    const projectRoot = await createScopedWorkspaceFixture();

    const analysis = await buildHostAgentProjectContextAnalysis({
      maxFileDetails: 0,
      maxFiles: 20,
      maxModuleDetails: 0,
      maxModuleSeeds: 8,
      projectRoot,
      source: 'codex-host-bootstrap',
      sourceFolders: ALEMBIC_MEMBER_FOLDERS,
    });

    expect(analysis.primaryLang).toBe('typescript');
    expect(analysis.sourceFileFacts.map((file) => file.filePath)).toEqual(
      expect.arrayContaining(['AlembicCore/src/index.ts', 'AlembicPlugin/lib/index.ts'])
    );
    expect(JSON.stringify(analysis.presenterInput)).not.toContain('BiliDili');
    // 范围文件夹原样到了 space（字符串被归一成文件夹对象），第一个文件夹是 repo 的主仓库，
    // 其余文件夹各一个整体种子。
    const space = analysis.presenterInput.space as SpaceContext;
    expect(space.sourceFolders.map((folder) => folder.path)).toEqual([...ALEMBIC_MEMBER_FOLDERS]);
    expect(analysis.presenterInput.repo?.repo.root).toBe('Alembic');
    expect(analysis.moduleSeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleName: 'lib',
          modulePath: 'Alembic/lib',
          ownedFiles: ['Alembic/lib/index.ts'],
        }),
        expect.objectContaining({
          kind: 'project-scope-folder',
          moduleName: 'AlembicCore',
          modulePath: 'AlembicCore',
          ownedFiles: expect.arrayContaining(['AlembicCore/src/index.ts']),
        }),
        expect.objectContaining({
          kind: 'project-scope-folder',
          moduleName: 'AlembicPlugin',
          modulePath: 'AlembicPlugin',
          ownedFiles: expect.arrayContaining(['AlembicPlugin/lib/index.ts']),
        }),
      ])
    );
    expect(analysis.moduleCount).toBeGreaterThanOrEqual(5);
    expect(analysis.presenterInput.map?.modules.map((module) => module.name).sort()).toEqual([
      'AlembicAgent',
      'AlembicCore',
      'AlembicDashboard',
      'AlembicPlugin',
      'lib',
    ]);
  });
});

async function createScopedWorkspaceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alembic-host-scope-parity-'));
  tempRoots.push(root);
  await writeFixtureFile(root, 'Alembic/package.json', '{"name":"alembic"}\n');
  await writeFixtureFile(root, 'Alembic/lib/index.ts', 'export const alembic = true;\n');
  await writeFixtureFile(root, 'AlembicCore/package.json', '{"name":"alembic-core"}\n');
  await writeFixtureFile(root, 'AlembicCore/src/index.ts', 'export const core = true;\n');
  await writeFixtureFile(root, 'AlembicPlugin/package.json', '{"name":"alembic-plugin"}\n');
  await writeFixtureFile(root, 'AlembicPlugin/lib/index.ts', 'export const plugin = true;\n');
  await writeFixtureFile(root, 'AlembicDashboard/package.json', '{"name":"dashboard"}\n');
  await writeFixtureFile(
    root,
    'AlembicDashboard/src/index.tsx',
    'export const dashboard = true;\n'
  );
  await writeFixtureFile(root, 'AlembicAgent/package.json', '{"name":"agent"}\n');
  await writeFixtureFile(root, 'AlembicAgent/src/index.ts', 'export const agent = true;\n');
  await writeFixtureFile(root, 'Test/tmp/BiliDili/App.swift', 'struct BiliDiliApp {}\n');
  return root;
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
