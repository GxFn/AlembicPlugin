import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  getSavedProjectRootPath,
  readSavedProjectRoot,
} from '../../lib/host-runtime/context/ProjectRootResolver.js';
import {
  type ProjectRootScopeOverride,
  persistAuthorizedProjectRootScope,
  resolveProjectRootScope,
} from '../../lib/host-runtime/mcp/host/project-root-scope.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const tempRoots: string[] = [];

describe('project-root scope locator persistence', () => {
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

  test('persists only a successful identity-consistent explicit init', () => {
    const homeRoot = makeDir('alembic-scope-home-');
    const projectRoot = makeDir('alembic-scope-project-');
    const otherRoot = makeDir('alembic-scope-other-');
    process.env.ALEMBIC_HOME = homeRoot;
    const decision = resolveProjectRootScope('alembic_init', { projectRoot });
    expect(decision.kind).toBe('scoped-project');
    const scope = (decision as { override: ProjectRootScopeOverride }).override;

    persistAuthorizedProjectRootScope('alembic_status', scope, successfulInit(projectRoot));
    persistAuthorizedProjectRootScope('alembic_init', scope, { success: false });
    persistAuthorizedProjectRootScope('alembic_init', scope, successfulInit(otherRoot));
    expect(fs.existsSync(getSavedProjectRootPath())).toBe(false);

    persistAuthorizedProjectRootScope('alembic_init', scope, successfulInit(projectRoot));
    expect(readSavedProjectRoot()).toMatchObject({ projectRoot });
  });
});

function successfulInit(projectRoot: string): Record<string, unknown> {
  return {
    success: true,
    data: {
      status: {
        initialized: true,
        project: { root: projectRoot },
      },
    },
  };
}

function makeDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
