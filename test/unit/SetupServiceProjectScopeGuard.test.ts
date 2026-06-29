import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { getProjectRegistryDir, ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupService } from '../../lib/cli/SetupService.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const tempRoots: string[] = [];

describe('SetupService ProjectScope pre-delete guard', () => {
  afterEach(() => {
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('uses existing native ProjectScope without creating per-repo ghost registry entries', () => {
    useTempAlembicHome();
    const { controlRoot, dataRoot, pluginRoot, registryPath } = makeProjectScopeFixture();
    const beforeRegistry = fs.readFileSync(registryPath, 'utf8');

    const workspaceService = new SetupService({ projectRoot: controlRoot, quiet: true });
    workspaceService.stepRuntime();
    const memberService = new SetupService({ projectRoot: pluginRoot, quiet: true });
    memberService.stepRuntime();

    expect(workspaceService.ghost).toBe(true);
    expect(memberService.ghost).toBe(true);
    expect(workspaceService.resolver?.projectScope?.projectScopeId).toBe(
      'project-scope-a8083fdb335c'
    );
    expect(memberService.resolver?.projectScope?.projectScopeId).toBe('project-scope-a8083fdb335c');
    expect(workspaceService.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(memberService.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(ProjectRegistry.get(controlRoot)).toBeNull();
    expect(ProjectRegistry.get(pluginRoot)).toBeNull();
    expect(fs.existsSync(path.join(getProjectRegistryDir(), 'projects.json'))).toBe(false);
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(beforeRegistry);

    const config = JSON.parse(
      fs.readFileSync(path.join(dataRoot, '.asd', 'config.json'), 'utf8')
    ) as {
      core?: Record<string, unknown>;
      vector?: { localEmbedding?: Record<string, unknown> };
      watch?: unknown;
    };
    expect(config.core).toEqual({ subRepoDir: 'Alembic/recipes' });
    expect(config.watch).toBeUndefined();
    expect(config.core).not.toHaveProperty('dir');
    expect(config.core).not.toHaveProperty('constitution');
    expect(config.vector?.localEmbedding).toMatchObject({
      enabled: false,
      laneOrder: 'local-first',
    });
  });

  test('fresh multi-repo checkout without native scope refuses before registry writes', () => {
    useTempAlembicHome();
    const controlRoot = makeFreshTwoRepoCheckout();

    expect(() => new SetupService({ projectRoot: controlRoot, quiet: true })).toThrow(
      /No native project scope.*project-scope add <folder>/
    );
    expect(fs.existsSync(path.join(getProjectRegistryDir(), 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(controlRoot, '.asd'))).toBe(false);
    expect(fs.existsSync(path.join(getProjectRegistryDir(), 'workspaces'))).toBe(false);
  });
});

function useTempAlembicHome(): void {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plugin-setup-home-'));
  tempRoots.push(tempHome);
  process.env.ALEMBIC_HOME = tempHome;
}

function makeProjectScopeFixture(): {
  controlRoot: string;
  dataRoot: string;
  pluginRoot: string;
  registryPath: string;
} {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plugin-setup-scope-'));
  tempRoots.push(controlRoot);
  const dataRoot = path.join(getProjectRegistryDir(), 'workspaces', 'native-setup');
  const alembicRoot = path.join(controlRoot, 'Alembic');
  const coreRoot = path.join(controlRoot, 'AlembicCore');
  const pluginRoot = path.join(controlRoot, 'AlembicPlugin');
  const agentRoot = path.join(controlRoot, 'AlembicAgent');
  const dashboardRoot = path.join(controlRoot, 'AlembicDashboard');
  fs.mkdirSync(dataRoot, { recursive: true });
  writeRepoLikeMember(alembicRoot);
  writeRepoLikeMember(coreRoot);
  writeRepoLikeMember(pluginRoot);
  writeRepoLikeMember(agentRoot);
  writeRepoLikeMember(dashboardRoot);

  const projectScope = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: 'Alembic Workspace',
    folders: [
      {
        displayName: 'Alembic',
        id: 'folder-alembic',
        path: alembicRoot,
        repositoryId: 'alembic',
        role: 'primary-source',
      },
      {
        displayName: 'AlembicCore',
        id: 'folder-core',
        path: coreRoot,
        repositoryId: 'alembic-core',
        role: 'source',
      },
      {
        displayName: 'AlembicPlugin',
        id: 'folder-plugin',
        path: pluginRoot,
        repositoryId: 'alembic-plugin',
        role: 'source',
      },
      {
        displayName: 'AlembicAgent',
        id: 'folder-agent',
        path: agentRoot,
        repositoryId: 'alembic-agent',
        role: 'source',
      },
      {
        displayName: 'AlembicDashboard',
        id: 'folder-dashboard',
        path: dashboardRoot,
        repositoryId: 'alembic-dashboard',
        role: 'source',
      },
    ],
    projectId: 'ecf32806',
    projectScopeId: 'project-scope-a8083fdb335c',
  });

  const registryDir = getProjectRegistryDir();
  fs.mkdirSync(registryDir, { recursive: true });
  const registryPath = path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME);
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)}\n`
  );
  return { controlRoot, dataRoot, pluginRoot, registryPath };
}

function makeFreshTwoRepoCheckout(): string {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plugin-setup-fresh-'));
  tempRoots.push(controlRoot);
  writeRepoLikeMember(path.join(controlRoot, 'RepoA'));
  writeRepoLikeMember(path.join(controlRoot, 'RepoB'));
  return controlRoot;
}

function writeRepoLikeMember(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: `fixture-${path.basename(root)}`, type: 'module' }, null, 2)}\n`
  );
}
