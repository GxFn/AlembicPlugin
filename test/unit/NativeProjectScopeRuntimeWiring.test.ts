import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathGuard } from '@alembic/core/io';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Bootstrap from '../../lib/bootstrap.js';
import { buildHostAgentProjectContextAnalysis } from '../../lib/recipe-generation/host-agent-workflows/project-context-analysis.js';
import { buildProjectRuntimeContext } from '../../lib/runtime/runtime/ProjectRuntimeContext.js';
import { buildStatus } from '../../lib/runtime/status/StatusService.js';
import {
  ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV,
  resolveProjectScopeRuntime,
} from '../../lib/shared/project-scope-runtime.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_PROJECT_SCOPE_ENV = process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
const tempRoots: string[] = [];

describe('native ProjectScope runtime wiring', () => {
  beforeEach(() => {
    pathGuard._reset();
  });

  afterEach(() => {
    pathGuard._reset();
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
    if (ORIGINAL_PROJECT_SCOPE_ENV === undefined) {
      delete process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
    } else {
      process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV] = ORIGINAL_PROJECT_SCOPE_ENV;
    }
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('loads registry ProjectScope for both control root and member folders when env is absent', () => {
    const fixture = createNativeProjectScopeFixture();

    const controlRuntime = resolveProjectScopeRuntime(fixture.controlRoot);
    const memberRuntime = resolveProjectScopeRuntime(fixture.pluginRoot);

    expect(controlRuntime?.descriptor.projectScopeId).toBe('scope-native-runtime');
    expect(controlRuntime?.summary).toMatchObject({
      controlRoot: fixture.controlRoot,
      currentFolderId: null,
      dataRoot: fixture.dataRoot,
      projectScopeId: 'scope-native-runtime',
    });
    expect(memberRuntime?.summary).toMatchObject({
      currentFolderId: 'folder-plugin',
      currentFolderPath: fixture.pluginRoot,
      dataRoot: fixture.dataRoot,
      projectScopeId: 'scope-native-runtime',
    });
  });

  test('bootstrap initializes the workspace resolver from native ProjectScope without env injection', () => {
    const fixture = createNativeProjectScopeFixture();

    Bootstrap.configurePathGuard(fixture.pluginRoot);
    const bootstrap = new Bootstrap();
    bootstrap.initializeWorkspaceResolver();

    expect(bootstrap.components.workspaceResolver?.dataRoot).toBe(fixture.dataRoot);
    expect(bootstrap.components.workspaceResolver?.projectScope?.projectScopeId).toBe(
      'scope-native-runtime'
    );
  });

  test('runtime identity reports native ProjectScope dataRoot and readiness facts', () => {
    const fixture = createNativeProjectScopeFixture();

    const context = buildProjectRuntimeContext({
      includeOptionalServices: false,
      projectRoot: fixture.pluginRoot,
      requiredServices: ['project-identity', 'project-scope'],
    });

    expect(context.identity).toMatchObject({
      dataRoot: fixture.dataRoot,
      dataRootSource: 'ghost-registry',
      ghost: true,
      mode: 'ghost',
      projectId: 'project-native-runtime',
      projectRoot: fixture.pluginRoot,
      projectScopeId: 'scope-native-runtime',
      runtimeDir: path.join(fixture.dataRoot, '.asd'),
    });
    expect(context.sourcePolicy.projectScopeSource).toBe('native-project-scope-registry');
    expect(context.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          available: true,
          reason: null,
          service: 'project-scope',
          source: 'native-project-scope-registry',
        }),
      ])
    );
  });

  test('status uses native ProjectScope workspace facts instead of project-root storage', async () => {
    const fixture = createNativeProjectScopeFixture();

    const status = await buildStatus(fixture.pluginRoot);

    expect(status.project).toMatchObject({
      dataRootSource: 'ghost-registry',
      projectId: 'project-native-runtime',
    });
    expect(status.workspace).toMatchObject({
      dataRootSource: 'ghost-registry',
      ghost: true,
      mode: 'ghost',
      workspaceExists: true,
    });
  });

  test('host project-index analysis scans only Core-provided sourceFolders', async () => {
    const fixture = createNativeProjectScopeFixture();

    const analysis = await buildHostAgentProjectContextAnalysis({
      maxFileDetails: 0,
      maxFiles: 20,
      maxModuleDetails: 0,
      maxModuleSeeds: 8,
      projectRoot: fixture.controlRoot,
      source: 'codex-host-bootstrap',
      sourceFolders: ['AlembicCore', 'AlembicPlugin'],
    });

    expect(analysis.sourceFileFacts.map((file) => file.filePath)).toEqual(
      expect.arrayContaining(['AlembicCore/src/index.ts', 'AlembicPlugin/lib/index.ts'])
    );
    expect(
      analysis.sourceFileFacts.every((file) =>
        /^AlembicCore\/|^AlembicPlugin\//.test(file.filePath)
      )
    ).toBe(true);
    expect(JSON.stringify(analysis.presenterInput)).not.toContain('Test/src/not-in-scope.ts');
    expect(JSON.stringify(analysis.presenterInput)).not.toContain('legacy/SwiftOnly/App.swift');
  });
});

function createNativeProjectScopeFixture(): {
  controlRoot: string;
  dataRoot: string;
  pluginRoot: string;
} {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-native-runtime-'));
  tempRoots.push(controlRoot);
  process.env.ALEMBIC_HOME = controlRoot;
  delete process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];

  const dataRoot = path.join(controlRoot, '.asd', 'workspaces', 'native-runtime');
  const pluginRoot = path.join(controlRoot, 'AlembicPlugin');
  fs.mkdirSync(dataRoot, { recursive: true });
  writeMember(controlRoot, 'AlembicCore', 'src/index.ts');
  writeMember(controlRoot, 'AlembicPlugin', 'lib/index.ts');
  writeMember(controlRoot, 'AlembicDashboard', 'src/dashboard.tsx');
  writeFile(controlRoot, 'Test/src/not-in-scope.ts', 'export const testOnly = true;\n');
  writeFile(controlRoot, 'legacy/SwiftOnly/App.swift', 'struct LegacyApp {}\n');

  const projectScope = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: 'Native Runtime Workspace',
    folders: [
      {
        displayName: 'AlembicCore',
        id: 'folder-core',
        path: path.join(controlRoot, 'AlembicCore'),
        repositoryId: 'alembic-core',
        role: 'primary-source',
      },
      {
        displayName: 'AlembicPlugin',
        id: 'folder-plugin',
        path: pluginRoot,
        repositoryId: 'alembic-plugin',
        role: 'source',
      },
      {
        displayName: 'AlembicDashboard',
        id: 'folder-dashboard',
        path: path.join(controlRoot, 'AlembicDashboard'),
        repositoryId: 'alembic-dashboard',
        role: 'source',
      },
    ],
    projectId: 'project-native-runtime',
    projectScopeId: 'scope-native-runtime',
  });
  const registryDir = path.join(controlRoot, '.asd');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    `${JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)}\n`
  );
  return { controlRoot, dataRoot, pluginRoot };
}

function writeMember(root: string, memberName: string, entryPath: string): void {
  writeFile(
    root,
    `${memberName}/package.json`,
    `${JSON.stringify({ name: `@fixture/${memberName.toLowerCase()}`, type: 'module' }, null, 2)}\n`
  );
  writeFile(root, `${memberName}/${entryPath}`, `export const ${memberName} = true;\n`);
}

function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
