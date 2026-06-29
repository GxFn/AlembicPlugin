import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { collectProjectSourceFileFacts } from '../../lib/recipe-generation/project-source-facts.js';
import { routePlanTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

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
});

async function draftPlan(
  projectRoot: string,
  hints: Record<string, unknown>
): Promise<PlanToolResponse> {
  return (await routePlanTool(createContext(projectRoot), {
    hints,
    operation: 'draft',
    projectRoot,
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
