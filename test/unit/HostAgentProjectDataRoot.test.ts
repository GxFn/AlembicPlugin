import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import {
  getGhostWorkspaceDir,
  getProjectRegistryDir,
  ProjectRegistry,
} from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveHostAgentDataRoot } from '#recipe-generation/host-agent-workflows/project-data-root.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const TEMP_ROOTS: string[] = [];

describe('host-agent project data root', () => {
  afterEach(() => {
    for (const root of TEMP_ROOTS.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
  });

  test('derives writes from the bootstrap project root instead of stale container state', () => {
    process.env.ALEMBIC_HOME = createTempRoot('alembic-host-data-');
    const projectRoot = createTempRoot('alembic-host-project-');
    const staleDataRoot = createTempRoot('alembic-stale-data-');
    const entry = ProjectRegistry.register(projectRoot, true);

    const dataRoot = resolveHostAgentDataRoot(
      {
        singletons: {
          _dataRoot: staleDataRoot,
          _projectRoot: staleDataRoot,
        },
      },
      projectRoot
    );

    expect(dataRoot).toBe(getGhostWorkspaceDir(entry.id));
    expect(dataRoot).not.toBe(staleDataRoot);
  });

  test('resolves member project writes through the native project-scope registry', () => {
    process.env.ALEMBIC_HOME = createTempRoot('alembic-host-scope-home-');
    const { dataRoot, projectRoot } = createProjectScopeFixture();
    const staleDataRoot = createTempRoot('alembic-stale-ghost-data-');

    const resolvedDataRoot = resolveHostAgentDataRoot(
      {
        singletons: {
          _dataRoot: staleDataRoot,
          _projectRoot: staleDataRoot,
        },
      },
      projectRoot
    );

    expect(resolvedDataRoot).toBe(dataRoot);
    expect(path.join(resolvedDataRoot, '.asd', 'alembic.db')).toBe(
      path.join(process.env.ALEMBIC_HOME, '.asd', 'workspaces', 'ecf32806', '.asd', 'alembic.db')
    );
    expect(resolvedDataRoot).not.toBe(staleDataRoot);
    expect(resolvedDataRoot).not.toBe(projectRoot);
  });
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

function createProjectScopeFixture(): { dataRoot: string; projectRoot: string } {
  const controlRoot = createTempRoot('alembic-scope-control-');
  const projectRoot = path.join(controlRoot, 'AlembicPlugin');
  fs.mkdirSync(projectRoot, { recursive: true });
  const dataRoot = getGhostWorkspaceDir('ecf32806');
  fs.mkdirSync(dataRoot, { recursive: true });
  const projectScope = createProjectDescriptor({
    controlRoot,
    currentFolderId: 'folder-plugin',
    dataRoot,
    displayName: 'Alembic Workspace',
    folders: [
      {
        displayName: 'AlembicPlugin',
        id: 'folder-plugin',
        path: projectRoot,
        repositoryId: 'alembic-plugin',
        role: 'primary-source',
      },
    ],
    projectId: 'ecf32806',
    projectScopeId: 'scope-ecf32806',
  });
  const registryDir = getProjectRegistryDir();
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)
  );
  return { dataRoot, projectRoot };
}
