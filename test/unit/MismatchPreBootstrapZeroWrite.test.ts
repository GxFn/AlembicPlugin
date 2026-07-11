import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getSavedProjectRootPath,
  writeSavedProjectRoot,
} from '../../lib/host-runtime/context/ProjectRootResolver.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { EmbeddedToolExecutor } from '../../lib/host-runtime/mcp/host/embedded-executor.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_ALEMBIC_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;
const ORIGINAL_PWD = process.env.PWD;
const tempRoots: string[] = [];

describe('agent-public mismatch pre-Bootstrap zero-write gate', () => {
  afterEach(async () => {
    await resetPluginOwnedMcpServerForTests();
    resetServiceContainer();
    vi.restoreAllMocks();
    restoreEnv('ALEMBIC_HOME', ORIGINAL_ALEMBIC_HOME);
    restoreEnv('ALEMBIC_PROJECT_DIR', ORIGINAL_ALEMBIC_PROJECT_DIR);
    restoreEnv('INIT_CWD', ORIGINAL_INIT_CWD);
    restoreEnv('PWD', ORIGINAL_PWD);
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('blocks business-invalid Prime before Bootstrap without creating source-root storage', async () => {
    const fixture = createCrossHomeFixture('mr-host-sp-home');
    const before = snapshotTree(fixture.hostRoot);
    const server = new HostMcpServer({ projectRoot: fixture.hostRoot });

    const result = (await server.handleToolCall('alembic_prime', {
      capability: 'ProjectScope isolation',
      inputSource: 'automation-envelope',
      requirementGoal: 'Use only the selected ProjectScope knowledge.',
      taskAction: 'implement',
    })) as {
      ok: boolean;
      reason: { code: string };
      refs: { detailRefs: unknown[] };
      status: string;
    };

    expect(snapshotTree(fixture.hostRoot)).toEqual(before);
    expect(fs.existsSync(path.join(fixture.hostRoot, '.asd'))).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      reason: { code: 'project-isolation-unconfirmed' },
      refs: { detailRefs: [] },
      status: 'blocked',
    });
  });

  test.each([
    'mr-host-sp-home',
    'sp-host-mr-home',
  ])('rejects valid Prime/Work/Guard in %s before the embedded executor is entered', async (direction) => {
    const fixture = createCrossHomeFixture(direction);
    const before = snapshotTree(fixture.hostRoot);
    const executeSpy = vi.spyOn(EmbeddedToolExecutor.prototype, 'execute');
    const server = new HostMcpServer({ projectRoot: fixture.hostRoot });
    const results: Array<{ result: unknown; toolName: string }> = [];
    const calls: Array<[string, Record<string, unknown>]> = [
      [
        'alembic_prime',
        {
          capability: 'ProjectScope isolation',
          inputSource: 'user-message',
          requirementGoal: 'Use only knowledge bound to this host source root.',
          taskAction: 'implement',
        },
      ],
      ['alembic_work', { inputSource: 'user-message', phase: 'start', title: 'Scoped work' }],
      [
        'alembic_code_guard',
        {
          code: 'export const scoped = true;',
          inputSource: 'user-message',
          language: 'typescript',
        },
      ],
    ];

    for (const [toolName, args] of calls) {
      results.push({ result: await server.handleToolCall(toolName, args), toolName });
    }

    expect(executeSpy).not.toHaveBeenCalled();
    expect(snapshotTree(fixture.hostRoot)).toEqual(before);
    expect(fs.existsSync(path.join(fixture.hostRoot, '.asd'))).toBe(false);
    for (const { result: rawResult, toolName } of results) {
      const result = rawResult as {
        ok: boolean;
        reason: { code: string };
        refs: { detailRefs: unknown[] };
        status: string;
        toolName: string;
      };
      expect(result).toMatchObject({
        ok: false,
        reason: { code: 'project-isolation-unconfirmed' },
        refs: { detailRefs: [] },
        status: 'blocked',
        toolName,
      });
    }
  });

  test.each([
    'mr-host-sp-home',
    'sp-host-mr-home',
  ])('keeps the pre-existing foreign locator byte-stable for explicit-root status and blocked tools in %s', async (direction) => {
    const fixture = createCrossHomeFixture(direction);
    writeSavedProjectRoot(fixture.foreignRoot);
    const locatorPath = getSavedProjectRootPath();
    const homeBefore = snapshotTree(fixture.homeRoot);
    const locatorBefore = fs.readFileSync(locatorPath);
    const hostBefore = snapshotTree(fixture.hostRoot);
    const foreignBefore = snapshotTree(fixture.foreignRoot);
    const server = new HostMcpServer();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['alembic_status', {}],
      [
        'alembic_prime',
        {
          capability: 'ProjectScope isolation',
          inputSource: 'user-message',
          requirementGoal: 'Use only knowledge bound to this host source root.',
          taskAction: 'implement',
        },
      ],
      ['alembic_work', { inputSource: 'user-message', phase: 'start', title: 'Scoped work' }],
      [
        'alembic_code_guard',
        {
          code: 'export const scoped = true;',
          inputSource: 'user-message',
          language: 'typescript',
        },
      ],
    ];

    for (const [toolName, args] of calls) {
      const result = (await server.handleToolCall(toolName, {
        ...args,
        projectRoot: fixture.hostRoot,
      })) as { reason?: { code?: string }; status?: string };
      if (toolName !== 'alembic_status') {
        expect(result).toMatchObject({
          reason: { code: 'project-isolation-unconfirmed' },
          status: 'blocked',
        });
      }
      expect(fs.readFileSync(locatorPath)).toEqual(locatorBefore);
      expect(snapshotTree(fixture.homeRoot)).toEqual(homeBefore);
      expect(snapshotTree(fixture.hostRoot)).toEqual(hostBefore);
      expect(snapshotTree(fixture.foreignRoot)).toEqual(foreignBefore);
    }
  });
});

function createCrossHomeFixture(direction: string): {
  foreignRoot: string;
  hostRoot: string;
  homeRoot: string;
} {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `alembic-mismatch-${direction}-`));
  tempRoots.push(fixtureRoot);
  const homeRoot = path.join(fixtureRoot, 'foreign-home');
  const controlRoot = path.join(fixtureRoot, 'foreign-control');
  const hostRoot = path.join(fixtureRoot, 'host-source');
  const foreignRoot = path.join(fixtureRoot, 'foreign-source');
  const dataRoot = path.join(homeRoot, '.asd', 'workspaces', 'foreign-project');
  fs.mkdirSync(controlRoot, { recursive: true });
  writeSource(hostRoot, 'host-source');
  writeSource(foreignRoot, 'foreign-source');
  fs.mkdirSync(dataRoot, { recursive: true });

  const descriptor = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: `Foreign ProjectScope ${direction}`,
    folders: [
      {
        displayName: 'Foreign Source',
        id: 'folder-foreign',
        path: foreignRoot,
        repositoryId: 'foreign-source',
        role: 'primary-source',
      },
    ],
    projectId: `project-${direction}`,
    projectScopeId: `scope-${direction}`,
  });
  const registryDir = path.join(homeRoot, '.asd');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    `${JSON.stringify(createProjectScopeRegistryDocument([descriptor]), null, 2)}\n`
  );
  process.env.ALEMBIC_HOME = homeRoot;
  process.env.ALEMBIC_PROJECT_DIR = hostRoot;
  process.env.INIT_CWD = hostRoot;
  process.env.PWD = hostRoot;
  return { foreignRoot, hostRoot, homeRoot };
}

function writeSource(root: string, name: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name, type: 'module' }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), `export const ${name} = true;\n`);
}

function snapshotTree(root: string): Array<{ content: string; path: string }> {
  return walk(root)
    .filter((entry) => fs.statSync(entry).isFile())
    .map((entry) => ({
      content: fs.readFileSync(entry).toString('base64'),
      path: path.relative(root, entry).split(path.sep).join('/'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
