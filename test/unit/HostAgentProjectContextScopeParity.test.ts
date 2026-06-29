import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ProjectContextEnvelope,
  ProjectContextRef,
  ProjectContextRequestKind,
  ProjectContextResult,
} from '@alembic/core/project-context';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildHostAgentProjectContextAnalysis } from '../../lib/recipe-generation/host-agent-workflows/project-context-analysis.js';

const projectContextExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('@alembic/core/project-context-capabilities', () => ({
  ProjectContextCapabilities: {
    execute: projectContextExecuteMock,
  },
}));

const tempRoots: string[] = [];
const ALEMBIC_MEMBER_FOLDERS = [
  'Alembic',
  'AlembicCore',
  'AlembicPlugin',
  'AlembicDashboard',
  'AlembicAgent',
] as const;

describe('Host Agent ProjectContext scoped production parity', () => {
  beforeEach(() => {
    projectContextExecuteMock.mockImplementation(async (request: unknown) =>
      createProjectContextEnvelope(request)
    );
  });

  afterEach(async () => {
    projectContextExecuteMock.mockReset();
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
    expect(analysis.moduleSeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleName: 'AlembicCore',
          modulePath: 'AlembicCore',
          ownedFiles: expect.arrayContaining(['AlembicCore/src/index.ts']),
        }),
        expect.objectContaining({
          moduleName: 'AlembicPlugin',
          modulePath: 'AlembicPlugin',
          ownedFiles: expect.arrayContaining(['AlembicPlugin/lib/index.ts']),
        }),
      ])
    );
    expect(analysis.moduleCount).toBeGreaterThanOrEqual(5);

    const requests = projectContextExecuteMock.mock.calls.map(([request]) =>
      summarizeProjectContextRequest(request)
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'space',
          sourceFolders: [...ALEMBIC_MEMBER_FOLDERS],
        }),
        expect.objectContaining({
          kind: 'repo',
          repoRoot: 'Alembic',
        }),
        expect.objectContaining({
          kind: 'map',
          moduleSeeds: expect.arrayContaining([
            expect.objectContaining({ modulePath: 'Alembic' }),
            expect.objectContaining({ modulePath: 'AlembicCore' }),
            expect.objectContaining({ modulePath: 'AlembicPlugin' }),
            expect.objectContaining({ modulePath: 'AlembicDashboard' }),
            expect.objectContaining({ modulePath: 'AlembicAgent' }),
          ]),
        }),
      ])
    );
    expect(requests.filter((request) => request.kind === 'repo')).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoRoot: 'Alembic' })])
    );
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

function createProjectContextEnvelope(
  request: unknown
): ProjectContextEnvelope<ProjectContextResult> {
  const requestRecord = readRecord(request);
  const kind = readString(requestRecord.kind) as ProjectContextRequestKind;
  const payload = readRecord(requestRecord.payload);
  const project = readRecord(requestRecord.project);
  const scope = readRecord(requestRecord.scope);
  const projectRoot = readString(project.projectRoot) ?? readString(scope.projectRoot) ?? '';
  return {
    contractVersion: 1,
    data: createProjectContextData(kind, payload, projectRoot),
    errors: [],
    project: {
      displayName: readString(project.displayName) ?? 'Scoped Workspace',
      projectRoot,
    },
    queryLevel: kind,
    refs: [],
  };
}

function createProjectContextData(
  kind: ProjectContextRequestKind,
  payload: Record<string, unknown>,
  projectRoot: string
): ProjectContextResult {
  if (kind === 'space') {
    const sourceFolders = readStringArray(payload.sourceFolders);
    return {
      activeRepo: undefined,
      boundaries: [],
      nextRefs: [],
      projectTree: undefined,
      repos: sourceFolders.map((folder) => createRepoSummary(projectRoot, folder)),
      sourceFolders: sourceFolders.map((folder) => ({
        displayName: folder,
        id: `folder-${folder}`,
        path: folder,
        repositoryId: folder,
        role: 'source',
      })),
      space: { name: 'Scoped Workspace', repoCount: sourceFolders.length },
      structuralHotspots: [],
    } as unknown as ProjectContextResult;
  }
  if (kind === 'repo') {
    const repoRoot = readString(payload.repoRoot);
    const scoped = ALEMBIC_MEMBER_FOLDERS.some((folder) => folder === repoRoot);
    return {
      buildSystems: [],
      commands: [],
      configFiles: [],
      entrypoints: [],
      languages: scoped
        ? [{ fileCount: 2, language: 'typescript' }]
        : [{ fileCount: 10, language: 'swift' }],
      localPackages: [],
      nextRefs: [],
      packageSystems: [],
      repo: createRepoSummary(projectRoot, repoRoot ?? '.'),
      sourceRoots: scoped
        ? [{ path: 'src', role: 'source', ref: createRef(projectRoot, 'src', repoRoot) }]
        : [],
      targets: [],
      topAreas: [],
    } as unknown as ProjectContextResult;
  }
  if (kind === 'map') {
    const moduleSeeds = readRecordArray(payload.moduleSeeds);
    return {
      cycles: [],
      dependencySummary: { edgeCount: 0, notes: [] },
      externalDependencyHotspots: [],
      hotspots: [],
      layers: [],
      majorFlows: [],
      modules: moduleSeeds.map((seed) => {
        const modulePath = readString(seed.modulePath) ?? readString(seed.moduleName) ?? 'module';
        const moduleName = readString(seed.moduleName) ?? modulePath;
        return {
          id: `module:${modulePath}`,
          name: moduleName,
          ownedFileCount: readStringArray(seed.ownedFiles).length,
          ref: createRef(projectRoot, modulePath, modulePath.split('/')[0]),
        };
      }),
      nextRefs: [],
      repo: createRepoSummary(projectRoot, '.'),
    } as unknown as ProjectContextResult;
  }
  throw new Error(`Unexpected ProjectContext kind in scoped parity test: ${kind}`);
}

function summarizeProjectContextRequest(request: unknown): {
  kind?: string;
  moduleSeeds?: Record<string, unknown>[];
  repoRoot?: string;
  sourceFolders?: string[];
} {
  const requestRecord = readRecord(request);
  const payload = readRecord(requestRecord.payload);
  return {
    kind: readString(requestRecord.kind),
    moduleSeeds: readRecordArray(payload.moduleSeeds),
    repoRoot: readString(payload.repoRoot),
    sourceFolders: readStringArray(payload.sourceFolders),
  };
}

function createRepoSummary(projectRoot: string, sourceFolder: string): Record<string, unknown> {
  return {
    name: sourceFolder === '.' ? 'workspace-root' : sourceFolder,
    ref: createRef(projectRoot, sourceFolder, sourceFolder === '.' ? undefined : sourceFolder),
    root: sourceFolder,
  };
}

function createRef(
  projectRoot: string,
  filePath: string,
  sourceFolder: string | undefined
): ProjectContextRef {
  return {
    id: `ref:${filePath}`,
    kind: 'path',
    label: filePath,
    scope: {
      filePath,
      projectRoot,
      ...(sourceFolder ? { sourceFolder } : {}),
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(readRecord).filter((entry) => Object.keys(entry).length)
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
