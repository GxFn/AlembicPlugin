import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import { getOrCreateSessionManager } from '@alembic/core/host-agent-workflows';
import {
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHostAgentKnowledgeRescanWorkflow } from '../../lib/recipe-generation/host-agent-workflows/knowledge-rescan.js';
import {
  createProjectContextHostAgentSession,
  releaseEmptyHostAgentSessionLease,
  releaseEmptyHostAgentSessionLeaseForProject,
} from '../../lib/recipe-generation/host-agent-workflows/project-context-analysis.js';

const tempRoots: string[] = [];
const silentLogger = { info() {}, warn() {} };

describe('releaseEmptyHostAgentSessionLease', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases an old empty same-project session before creating a new briefing session', () => {
    const clearSession = vi.fn();
    const session = emptySession({ startedAt: 1_000 });

    const result = releaseEmptyHostAgentSessionLease({
      projectRoot: '/project',
      sessionManager: {
        clearSession,
        getSession: () => session,
      },
      now: 1_000 + 10 * 60 * 1000,
    });

    expect(result).toEqual({ released: true, sessionId: 'bs-empty' });
    expect(clearSession).toHaveBeenCalledWith('bs-empty');
  });

  it('keeps a freshly-created empty session as a real in-progress lease', () => {
    const clearSession = vi.fn();
    const session = emptySession({ startedAt: 1_000 });

    const result = releaseEmptyHostAgentSessionLease({
      projectRoot: '/project',
      sessionManager: {
        clearSession,
        getSession: () => session,
      },
      now: 1_000 + 30 * 1000,
    });

    expect(result.released).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('keeps a stale-looking session once it has real submissions or reports', () => {
    const clearSession = vi.fn();
    const session = emptySession({
      startedAt: 1_000,
      submissionTracker: {
        toJSON: () => ({
          dimensionSubmissions: {
            architecture: [{ recipeId: 'r1' }],
          },
          fileEvidenceMap: {},
          negativeSignals: [],
          rejections: {},
          usedTriggers: [],
        }),
      },
    });

    const result = releaseEmptyHostAgentSessionLease({
      projectRoot: '/project',
      sessionManager: {
        clearSession,
        getSession: () => session,
      },
      now: 1_000 + 10 * 60 * 1000,
    });

    expect(result.released).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('releases a stale empty file-backed session before the rescan gate creates a new session', () => {
    const fixture = createFileBackedSessionFixture({ stale: true });
    const manager = getOrCreateSessionManager(fixture.container);

    expect(() =>
      manager.createSession({ projectRoot: fixture.projectRoot, dimensions: [dimension()] })
    ).toThrow(expect.objectContaining({ errorCode: 'BOOTSTRAP_IN_PROGRESS' }));

    const release = releaseEmptyHostAgentSessionLeaseForProject({
      container: fixture.container,
      projectRoot: fixture.projectRoot,
      source: 'alembic_rescan',
    });

    expect(release).toEqual({ released: true, sessionId: 'bs-file-empty' });
    const session = createProjectContextHostAgentSession({
      container: fixture.container,
      dimensions: [dimension()],
      fileCount: 1,
      moduleCount: 1,
      primaryLang: 'swift',
      projectRoot: fixture.projectRoot,
    });
    expect(session.id).not.toBe('bs-file-empty');
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual([session.id]);
  });

  it('lets moduleMining rescan pass through a stale empty file-backed session gate', async () => {
    const fixture = createFileBackedSessionFixture({ stale: true });
    writeProjectFile(fixture.projectRoot, 'src/App.ts', 'export const app = true;\n');
    const manager = getOrCreateSessionManager(fixture.container);
    expect(() =>
      manager.createSession({ projectRoot: fixture.projectRoot, dimensions: [dimension()] })
    ).toThrow(expect.objectContaining({ errorCode: 'BOOTSTRAP_IN_PROGRESS' }));

    const runtime = await openAlembicDatabase(
      { path: join(fixture.projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.projectRoot) }
    );
    try {
      const repositories = createAlembicRepositories(runtime.connection);
      const response = (await runHostAgentKnowledgeRescanWorkflow(
        createRescanContext(fixture, runtime, repositories),
        {
          generationStage: 'moduleMining',
          planSelection: moduleMiningPlanSelection(),
          reason: 'file-backed stale empty session regression',
          testMode: true,
        }
      )) as { data?: Record<string, unknown>; errorCode?: string; success?: boolean };

      expect(response.success).toBe(true);
      expect(response.errorCode).not.toBe('BOOTSTRAP_IN_PROGRESS');
      expect(readStoredSessionIds(fixture.dataRoot)).not.toContain('bs-file-empty');
      expect(readStoredSessionIds(fixture.dataRoot)).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it('keeps a stale file-backed session with submitted evidence as a blocking in-progress lease', () => {
    const fixture = createFileBackedSessionFixture({
      stale: true,
      submissionTracker: {
        dimensionSubmissions: {
          architecture: [{ recipeId: 'r1' }],
        },
        fileEvidenceMap: {},
        negativeSignals: [],
        rejections: {},
        usedTriggers: [],
      },
    });

    const release = releaseEmptyHostAgentSessionLeaseForProject({
      container: fixture.container,
      projectRoot: fixture.projectRoot,
      source: 'alembic_rescan',
    });

    expect(release.released).toBe(false);
    expect(() =>
      createProjectContextHostAgentSession({
        container: fixture.container,
        dimensions: [dimension()],
        fileCount: 1,
        moduleCount: 1,
        primaryLang: 'swift',
        projectRoot: fixture.projectRoot,
      })
    ).toThrow(expect.objectContaining({ errorCode: 'BOOTSTRAP_IN_PROGRESS' }));
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual(['bs-file-empty']);
  });
});

function emptySession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bs-empty',
    projectRoot: '/project',
    startedAt: 1_000,
    completedDimensions: {},
    getProgress: () => ({ completed: 0, total: 14 }),
    sessionStore: {
      toJSON: () => ({
        dimensionReports: {},
        crossReferences: [],
        tierReflections: [],
        submittedCandidates: {},
      }),
    },
    submissionTracker: {
      toJSON: () => ({
        dimensionSubmissions: {},
        fileEvidenceMap: {},
        negativeSignals: [],
        rejections: {},
        usedTriggers: [],
      }),
    },
    ...overrides,
  };
}

function createFileBackedSessionFixture(input: {
  stale: boolean;
  submissionTracker?: Record<string, unknown>;
}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'alembic-plugin-session-lease-'));
  tempRoots.push(dataRoot);
  const projectRoot = join(dataRoot, 'BiliDili');
  const storeDir = join(dataRoot, '.asd', 'bootstrap-sessions');
  mkdirSync(storeDir, { recursive: true });
  const startedAt = Date.now() - (input.stale ? 60 * 60 * 1000 : 30 * 1000);
  writeFileSync(
    join(storeDir, 'active-sessions.json'),
    JSON.stringify(
      {
        version: 1,
        savedAt: startedAt,
        sessions: [
          {
            id: 'bs-file-empty',
            projectRoot,
            dimensions: [dimension()],
            projectContext: {},
            startedAt,
            expiresAt: Date.now() + 60 * 60 * 1000,
            completedDimensions: {},
            crossDimensionHints: {},
            snapshotCache: null,
            sessionStore: {
              dimensionReports: {},
              crossReferences: [],
              tierReflections: [],
              submittedCandidates: {},
              projectContext: {},
            },
            submissionTracker: input.submissionTracker ?? {
              dimensionSubmissions: {},
              fileEvidenceMap: {},
              negativeSignals: [],
              rejections: {},
              usedTriggers: [],
            },
            savedAt: startedAt,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
  const registry: Record<string, unknown> = {};
  const container = {
    get: (name: string) => registry[name],
    register: (name: string, factory: () => unknown) => {
      registry[name] = factory();
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: { dataRoot },
    },
  };
  return { container, dataRoot, projectRoot };
}

function readStoredSessionIds(dataRoot: string): string[] {
  const store = JSON.parse(
    readFileSync(join(dataRoot, '.asd', 'bootstrap-sessions', 'active-sessions.json'), 'utf8')
  ) as { sessions: Array<{ id: string }> };
  return store.sessions.map((session) => session.id);
}

function dimension() {
  return { id: 'architecture', label: 'Architecture' };
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function moduleMiningPlanSelection() {
  return {
    generationStage: 'moduleMining' as const,
    dimensions: ['architecture'],
    scale: {
      totalRecipeBudget: 1,
      maxFiles: 8,
      contentMaxLines: 20,
      depthLevels: ['module'],
    },
    moduleBindings: [
      {
        modulePath: 'src',
        dimensions: ['architecture'],
        targetRecipes: 1,
      },
    ],
  };
}

function createRescanContext(
  fixture: ReturnType<typeof createFileBackedSessionFixture>,
  runtime: AlembicDatabaseRuntime,
  repositories: AlembicRepositoryBundle
) {
  const services: Record<string, unknown> = {
    database: runtime.connection,
    evolutionGateway: {
      submit: async () => ({ id: 'proposal-session-lease-regression' }),
    },
    gitDiffCheckpointRepository: repositories.gitDiffCheckpointRepository,
    knowledgeRepository: repositories.knowledgeRepository,
    lifecycleEventRepository: repositories.lifecycleEventRepository,
    planRepository: repositories.planRepository,
    proposalRepository: repositories.proposalRepository,
    recipeSourceRefRepository: repositories.recipeSourceRefRepository,
  };
  const registry: Record<string, unknown> = {};
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: (name: string) => {
        if (name in registry) {
          return registry[name];
        }
        if (name in services) {
          return services[name];
        }
        throw new Error(`missing service ${name}`);
      },
      register: (name: string, factory: () => unknown) => {
        registry[name] = factory();
      },
      singletons: {
        _projectRoot: fixture.projectRoot,
        _workspaceResolver: { dataRoot: fixture.dataRoot },
      },
    },
    logger: silentLogger,
  };
}
