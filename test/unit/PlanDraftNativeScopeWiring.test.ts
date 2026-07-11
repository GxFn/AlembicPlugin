import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectProjectSourceFileFacts } from '@alembic/core/service/planFacts';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { routePlanTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';

interface PlanToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

const tempRoots: string[] = [];
let previousAlembicHome: string | undefined;

describe('plan draft native ProjectScope wiring', () => {
  beforeEach(() => {
    previousAlembicHome = process.env.ALEMBIC_HOME;
  });

  afterEach(() => {
    if (previousAlembicHome === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = previousAlembicHome;
    }
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('workspace-root draft collects the native Alembic member space and excludes noise', async () => {
    const projectRoot = createNativeAlembicWorkspaceFixture();
    const draft = await draftPlan(projectRoot, { maxBudget: 64 });

    expect(draft).toMatchObject({ success: true });
    const tree = asRecord(asRecord(draft.data).projectInfoTree);
    expect(tree.primaryLanguage).toBe('typescript');
    expect(topLevelModulePaths(tree)).toEqual(
      expect.arrayContaining([
        'Alembic',
        'AlembicAgent',
        'AlembicCore',
        'AlembicDashboard',
        'AlembicPlugin',
      ])
    );

    const serialized = JSON.stringify(tree);
    expect(serialized).not.toContain('Test');
    expect(serialized).not.toContain('wakeflow-ledger');
    expect(serialized).not.toContain('legacy');
    expect(serialized).not.toContain('.swift');
  });

  test('focusModules narrows native scope source folders without changing the schema', async () => {
    const projectRoot = createNativeAlembicWorkspaceFixture();
    const draft = await draftPlan(projectRoot, { focusModules: ['AlembicCore'], maxBudget: 64 });

    expect(draft).toMatchObject({ success: true });
    const tree = asRecord(asRecord(draft.data).projectInfoTree);
    expect(topLevelModulePaths(tree)).toEqual(['AlembicCore']);
    expect(JSON.stringify(tree)).toContain('AlembicCore/src/index.ts');
    expect(JSON.stringify(tree)).not.toContain('AlembicPlugin/lib/index.ts');
  });

  test('source facts scan only requested folders and budget them fairly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-source-facts-scope-'));
    tempRoots.push(root);
    for (let index = 0; index < 8; index += 1) {
      writeFile(root, `Large/src/file-${index}.ts`, `export const large${index} = true;\n`);
    }
    writeFile(root, 'Small/src/index.ts', 'export const small = true;\n');
    writeFile(root, 'Noise/src/index.ts', 'export const noise = true;\n');

    const facts = await collectProjectSourceFileFacts(root, {
      maxFiles: 2,
      sourceFolders: ['Large', 'Small'],
    });

    expect(facts.map((file) => file.filePath)).toEqual(
      expect.arrayContaining(['Small/src/index.ts'])
    );
    expect(facts.every((file) => /^Large\/|^Small\//.test(file.filePath))).toBe(true);
    expect(facts.some((file) => file.filePath.startsWith('Noise/'))).toBe(false);
  });

  test('oversized Ghost draft confines deterministic full-tree transport to the native dataRoot', async () => {
    const fixture = createOversizedGhostScopeFixture();
    const sourceBefore = snapshotTree(fixture.controlRoot);

    const firstDraft = await draftPlan(fixture.controlRoot, { maxBudget: 1 }, 'moduleMining');
    const firstTree = asRecord(asRecord(firstDraft.data).projectInfoTree);
    const firstRef = asRecord(asRecord(firstTree.meta).fullTreeRef);
    const firstPath = String(firstRef.path);
    const firstHash = hashFile(firstPath);

    expect(firstDraft).toMatchObject({ success: true });
    expect(firstPath.startsWith(`${fixture.dataRoot}${path.sep}`)).toBe(true);
    expect(fs.existsSync(path.join(fixture.controlRoot, '.asd'))).toBe(false);
    expect(snapshotTree(fixture.controlRoot)).toEqual(sourceBefore);

    const repeatedDraft = await draftPlan(fixture.controlRoot, { maxBudget: 1 }, 'moduleMining');
    const repeatedTree = asRecord(asRecord(repeatedDraft.data).projectInfoTree);
    const repeatedRef = asRecord(asRecord(repeatedTree.meta).fullTreeRef);
    expect(repeatedRef.path).toBe(firstPath);
    expect(hashFile(firstPath)).toBe(firstHash);
    expect(snapshotTree(fixture.controlRoot)).toEqual(sourceBefore);

    const untruncatedDraft = await draftPlan(
      fixture.controlRoot,
      { maxBudget: 512 },
      'moduleMining'
    );
    const untruncatedTree = asRecord(asRecord(untruncatedDraft.data).projectInfoTree);
    expect(asRecord(untruncatedTree.meta).fullTreeRef).toBeNull();
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(snapshotTree(fixture.controlRoot)).toEqual(sourceBefore);
  });
});

async function draftPlan(
  projectRoot: string,
  hints: Record<string, unknown>,
  generationStage?: 'coldStart' | 'deepMining' | 'moduleMining'
): Promise<PlanToolResponse> {
  return (await routePlanTool(createContext(projectRoot), {
    hints,
    operation: 'draft',
    projectRoot,
    ...(generationStage ? { generationStage } : {}),
  })) as PlanToolResponse;
}

function createNativeAlembicWorkspaceFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-native-scope-'));
  tempRoots.push(root);
  process.env.ALEMBIC_HOME = root;

  writeAlembicMember(root, 'Alembic', 'src/index.ts');
  writeAlembicMember(root, 'AlembicCore', 'src/index.ts');
  writeAlembicMember(root, 'AlembicPlugin', 'lib/index.ts');
  writeAlembicMember(root, 'AlembicDashboard', 'src/dashboard.tsx');
  writeAlembicMember(root, 'AlembicAgent', 'src/agent.ts');
  writeFile(root, 'Test/src/not-in-scope.ts', 'export const testOnly = true;\n');
  writeFile(root, 'wakeflow-ledger/AlembicWorkspace/index.md', '# ledger\n');
  writeFile(root, 'legacy/SwiftOnly/App.swift', 'struct LegacyApp {}\n');
  writeNativeProjectScope(root);
  return root;
}

function writeAlembicMember(root: string, memberName: string, entryPath: string) {
  writeFile(
    root,
    `${memberName}/package.json`,
    JSON.stringify({ name: `@fixture/${memberName.toLowerCase()}`, main: entryPath }, null, 2)
  );
  writeFile(root, `${memberName}/${entryPath}`, `export const ${memberName} = true;\n`);
}

function writeNativeProjectScope(root: string) {
  const memberNames = [
    'Alembic',
    'AlembicCore',
    'AlembicPlugin',
    'AlembicDashboard',
    'AlembicAgent',
  ];
  const projectScope = createProjectDescriptor({
    controlRoot: root,
    dataRoot: path.join(root, '.asd', 'workspaces', 'alembic-space'),
    displayName: 'AlembicWorkspace',
    folders: memberNames.map((memberName, index) => ({
      displayName: memberName,
      id: `folder-${memberName.toLowerCase()}`,
      path: path.join(root, memberName),
      repositoryId: memberName,
      role: index === 0 ? ('primary-source' as const) : ('source' as const),
    })),
    projectId: 'alembic-workspace',
    projectScopeId: 'scope-alembic-workspace',
  });
  const registryDir = path.join(root, '.asd');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)
  );
}

function createOversizedGhostScopeFixture(): {
  controlRoot: string;
  dataRoot: string;
} {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ghost-transport-'));
  tempRoots.push(fixtureRoot);
  const controlRoot = path.join(fixtureRoot, 'control');
  const homeRoot = path.join(fixtureRoot, 'home');
  const dataRoot = path.join(homeRoot, '.asd', 'workspaces', 'ghost-plan');
  process.env.ALEMBIC_HOME = homeRoot;
  const folders = ['App', 'Core', 'Plugin', 'Agent', 'Dashboard'];
  for (const [folderIndex, folder] of folders.entries()) {
    writeFile(
      controlRoot,
      `${folder}/package.json`,
      JSON.stringify({ name: `@fixture/${folder.toLowerCase()}`, main: 'src/index.ts' }, null, 2)
    );
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
      writeFile(
        controlRoot,
        `${folder}/src/feature-${fileIndex}.ts`,
        `export const feature${folderIndex}_${fileIndex} = ${JSON.stringify(`${folder}-${fileIndex}`)};\n`
      );
    }
  }
  const projectScope = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: 'Ghost Plan Scope',
    folders: folders.map((folder, index) => ({
      displayName: folder,
      id: `folder-${folder.toLowerCase()}`,
      path: path.join(controlRoot, folder),
      repositoryId: folder,
      role: index === 0 ? ('primary-source' as const) : ('source' as const),
    })),
    projectId: 'ghost-plan-project',
    projectScopeId: 'ghost-plan-scope',
  });
  writeFile(
    homeRoot,
    `.asd/${PROJECT_SCOPE_REGISTRY_FILENAME}`,
    JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)
  );
  return { controlRoot, dataRoot };
}

function writeFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function topLevelModulePaths(tree: Record<string, unknown>): string[] {
  return [
    ...new Set(
      asArray(tree.children)
        .map((child) => String(asRecord(child).path ?? '').split('/')[0])
        .filter(Boolean)
    ),
  ].sort();
}

function createContext(projectRoot: string): McpContext {
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: () => undefined,
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
