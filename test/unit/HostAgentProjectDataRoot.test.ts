import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGhostWorkspaceDir, ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveHostAgentDataRoot } from '#codex/mcp/host-agent-workflows/project-data-root.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

describe('host-agent project data root', () => {
  afterEach(() => {
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
  });

  test('derives writes from the bootstrap project root instead of stale container state', () => {
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-host-data-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-host-project-'));
    const staleDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-stale-data-'));
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
});
