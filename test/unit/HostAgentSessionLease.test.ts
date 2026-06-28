import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import { getOrCreateSessionManager } from '@alembic/core/host-agent-workflows';
import { KnowledgeEntry } from '@alembic/core/knowledge';
import {
  type AlembicRepositoryBundle,
  type CoverageLedgerRecord,
  createAlembicRepositories,
  type DeepMiningRoundRecord,
  type UpsertCoverageLedgerInput,
  type UpsertDeepMiningRoundInput,
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

  it('releases a no-work deepMining session so immediate moduleMining is not blocked', async () => {
    const fixture = createFileBackedSessionFixture({ initialSession: false, stale: false });
    writeProjectFile(fixture.projectRoot, 'src/App.ts', 'export const app = true;\n');
    const coverageLedger = createStatefulCoverageLedgerRepository({
      cells: [
        coverageCell({
          grade: 'covered',
          moduleId: 'src',
          dimensionId: 'architecture',
          coveredCount: 5,
          totalCandidateCount: 5,
          valueScore: 0,
        }),
      ],
      ignoreCellUpserts: true,
    });

    const runtime = await openAlembicDatabase(
      { path: join(fixture.projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.projectRoot) }
    );
    try {
      const repositories = createAlembicRepositories(runtime.connection);
      const ctx = createRescanContext(fixture, runtime, repositories, {
        coverageLedgerRepository: coverageLedger.repository,
      });

      const deepMining = (await runHostAgentKnowledgeRescanWorkflow(ctx, {
        generationStage: 'deepMining',
        planSelection: deepMiningPlanSelection(),
        reason: 'converged no-work session release regression',
        testMode: true,
      })) as {
        errorCode?: string;
        meta?: { noActionableHostAgentWork?: { releasedEmptySession?: boolean } };
        success?: boolean;
      };

      expect(deepMining.success).toBe(true);
      expect(deepMining.errorCode).not.toBe('BOOTSTRAP_IN_PROGRESS');
      expect(deepMining.meta?.noActionableHostAgentWork?.releasedEmptySession).toBe(true);
      expect(readStoredSessionIds(fixture.dataRoot)).toEqual([]);
      expect(coverageLedger.roundUpserts).toHaveLength(0);

      const moduleMining = (await runHostAgentKnowledgeRescanWorkflow(ctx, {
        generationStage: 'moduleMining',
        planSelection: moduleMiningPlanSelection(),
        reason: 'moduleMining after no-work deepMining',
        testMode: true,
      })) as {
        errorCode?: string;
        meta?: { noActionableHostAgentWork?: { releasedEmptySession?: boolean } };
        success?: boolean;
      };

      expect(moduleMining.success).toBe(true);
      expect(moduleMining.errorCode).not.toBe('BOOTSTRAP_IN_PROGRESS');
      expect(moduleMining.meta?.noActionableHostAgentWork?.releasedEmptySession).toBe(true);
      expect(readStoredSessionIds(fixture.dataRoot)).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('closes an open host-agent rescan round when releasing a no-work deepMining session', async () => {
    const fixture = createFileBackedSessionFixture({ initialSession: false, stale: false });
    writeProjectFile(fixture.projectRoot, 'src/App.ts', 'export const app = true;\n');
    const coverageLedger = createStatefulCoverageLedgerRepository({
      cells: [
        coverageCell({
          grade: 'covered',
          moduleId: 'target:App:src',
          dimensionId: 'architecture',
          coveredCount: 5,
          totalCandidateCount: 5,
          valueScore: 0,
        }),
      ],
      ignoreCellUpserts: true,
      rounds: [
        {
          projectRoot: fixture.projectRoot,
          roundIndex: 4,
          rescanId: 'terminal-rescan-round',
          startedAt: 100,
          completedAt: null,
          newRecipesThisRound: 0,
          triggerActor: 'host-agent-rescan',
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    });

    const runtime = await openAlembicDatabase(
      { path: join(fixture.projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.projectRoot) }
    );
    try {
      const repositories = createAlembicRepositories(runtime.connection);
      const response = (await runHostAgentKnowledgeRescanWorkflow(
        createRescanContext(fixture, runtime, repositories, {
          coverageLedgerRepository: coverageLedger.repository,
        }),
        {
          generationStage: 'deepMining',
          planSelection: deepMiningPlanSelection(),
          reason: 'terminal no-work round close regression',
          testMode: true,
        }
      )) as {
        meta?: {
          noActionableHostAgentWork?: {
            closedOpenRound?: boolean;
            releasedEmptySession?: boolean;
          };
        };
        success?: boolean;
      };

      expect(response.success).toBe(true);
      expect(response.meta?.noActionableHostAgentWork?.releasedEmptySession).toBe(true);
      expect(response.meta?.noActionableHostAgentWork?.closedOpenRound).toBe(true);
      expect(readStoredSessionIds(fixture.dataRoot)).toEqual([]);
      expect(coverageLedger.roundUpserts).toHaveLength(1);
      expect(coverageLedger.roundUpserts[0]).toEqual(
        expect.objectContaining({
          roundIndex: 4,
          rescanId: 'terminal-rescan-round',
          newRecipesThisRound: 0,
        })
      );
      expect(typeof coverageLedger.roundUpserts[0]?.completedAt).toBe('number');
    } finally {
      runtime.close();
    }
  });

  it('opens a rescanId round when deepMining has produce dimensions even if coverage advisory converges', async () => {
    const fixture = createFileBackedSessionFixture({ initialSession: false, stale: false });
    writeProjectFile(fixture.projectRoot, 'src/App.ts', 'export const app = true;\n');
    const coverageLedger = createStatefulCoverageLedgerRepository({
      cells: [
        coverageCell({
          grade: 'covered',
          moduleId: 'src',
          dimensionId: 'architecture',
          coveredCount: 5,
          totalCandidateCount: 5,
          valueScore: 0,
        }),
      ],
      ignoreCellUpserts: true,
    });

    const runtime = await openAlembicDatabase(
      { path: join(fixture.projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.projectRoot) }
    );
    try {
      const repositories = createAlembicRepositories(runtime.connection);
      const ctx = createRescanContext(fixture, runtime, repositories, {
        coverageLedgerRepository: coverageLedger.repository,
      });

      const response = (await runHostAgentKnowledgeRescanWorkflow(ctx, {
        generationStage: 'deepMining',
        planSelection: deepMiningPlanSelection({ targetRecipes: 6 }),
        reason: 'deepMining produce dimensions must keep RF-3 round open',
        rescanId: 'deep-round-produce-rescan-1',
        testMode: true,
      })) as {
        meta?: {
          coverageAdvisory?: { shouldStop?: boolean; stopReason?: string };
          noActionableHostAgentWork?: unknown;
        };
        success?: boolean;
      };

      expect(response.success).toBe(true);
      expect(response.meta?.coverageAdvisory).toEqual(
        expect.objectContaining({ shouldStop: true, stopReason: 'converged' })
      );
      expect(response.meta?.noActionableHostAgentWork).toBeUndefined();
      expect(coverageLedger.roundUpserts).toHaveLength(1);
      expect(coverageLedger.roundUpserts[0]).toEqual(
        expect.objectContaining({
          roundIndex: 1,
          rescanId: 'deep-round-produce-rescan-1',
          triggerActor: 'host-agent-rescan',
        })
      );
      expect(readStoredSessionIds(fixture.dataRoot)).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it('opens deepMining rounds with rescanId and keeps same-rescan fake upserts idempotent', async () => {
    const fixture = createFileBackedSessionFixture({ initialSession: false, stale: false });
    writeProjectFile(fixture.projectRoot, 'src/App.ts', 'export const app = true;\n');
    const coverageLedger = createStatefulCoverageLedgerRepository({
      cells: [
        coverageCell({
          grade: 'empty',
          moduleId: 'src',
          dimensionId: 'architecture',
          coveredCount: 0,
          totalCandidateCount: 1,
          valueScore: 90,
        }),
      ],
      ignoreCellUpserts: true,
    });

    const runtime = await openAlembicDatabase(
      { path: join(fixture.projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.projectRoot) }
    );
    try {
      const repositories = createAlembicRepositories(runtime.connection);
      const ctx = createRescanContext(fixture, runtime, repositories, {
        coverageLedgerRepository: coverageLedger.repository,
      });
      const args = {
        generationStage: 'deepMining' as const,
        planSelection: deepMiningPlanSelection(),
        reason: 'deepMining rescanId round idempotency regression',
        rescanId: 'deep-round-rescan-1',
        testMode: true,
      };

      const first = (await runHostAgentKnowledgeRescanWorkflow(ctx, args)) as { success?: boolean };
      expect(first.success).toBe(true);
      expect(coverageLedger.roundUpserts).toHaveLength(1);
      expect(coverageLedger.roundUpserts[0]).toEqual(
        expect.objectContaining({
          roundIndex: 1,
          rescanId: 'deep-round-rescan-1',
          triggerActor: 'host-agent-rescan',
        })
      );
      const repeated = coverageLedger.repository.upsertRound({
        projectRoot: fixture.projectRoot,
        roundIndex: 2,
        rescanId: 'deep-round-rescan-1',
        startedAt: 999,
        triggerActor: 'host-agent-rescan',
      });

      expect(repeated.roundIndex).toBe(1);
      expect(coverageLedger.roundUpserts).toHaveLength(2);
      const matchingRounds = coverageLedger.rounds.filter(
        (round) => round.rescanId === 'deep-round-rescan-1'
      );
      expect(matchingRounds).toHaveLength(1);
      expect(matchingRounds[0]?.roundIndex).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it('seeds coverage ledger from existing recipe source refs before deepMining planning', async () => {
    const fixture = createFileBackedSessionFixture({ initialSession: false, stale: false });
    writeProjectFile(fixture.projectRoot, 'src/App.ts', 'export const app = true;\n');
    const coverageLedger = createStatefulCoverageLedgerRepository();

    const runtime = await openAlembicDatabase(
      { path: join(fixture.projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.projectRoot) }
    );
    try {
      const repositories = createAlembicRepositories(runtime.connection);
      await insertRecipeWithSourceRef(repositories, {
        dimensionId: 'architecture',
        id: 'recipe-from-real-source-ref',
        sourcePath: 'src/App.ts',
      });
      const response = (await runHostAgentKnowledgeRescanWorkflow(
        createRescanContext(fixture, runtime, repositories, {
          coverageLedgerRepository: coverageLedger.repository,
        }),
        {
          generationStage: 'deepMining',
          planSelection: deepMiningPlanSelection(),
          reason: 'coverage ledger seed regression',
          testMode: true,
        }
      )) as {
        data?: {
          coverageLedgerSeed?: { status?: string; writtenCells?: number };
          meta?: { coverageLedgerSeed?: { status?: string; writtenCells?: number } };
        };
        meta?: { coverageLedgerSeed?: { status?: string; writtenCells?: number } };
        success?: boolean;
      };

      expect(response.success).toBe(true);
      expect(response.meta?.coverageLedgerSeed?.status).toBe('written');
      expect(response.meta?.coverageLedgerSeed?.writtenCells ?? 0).toBeGreaterThan(0);
      expect(response.data?.coverageLedgerSeed?.status).toBe('written');
      expect(response.data?.coverageLedgerSeed?.writtenCells ?? 0).toBeGreaterThan(0);
      expect(response.data?.meta?.coverageLedgerSeed?.status).toBe('written');
      expect(response.data?.meta?.coverageLedgerSeed?.writtenCells ?? 0).toBeGreaterThan(0);
      expect(coverageLedger.cellUpserts.length).toBeGreaterThan(0);
      expect(
        coverageLedger.cells.some(
          (cell) => cell.dimensionId === 'architecture' && cell.coveredSourceRefs.length > 0
        )
      ).toBe(true);
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
  initialSession?: boolean;
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
        sessions:
          input.initialSession === false
            ? []
            : [
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

function deepMiningPlanSelection(input: { targetRecipes?: number } = {}) {
  return {
    generationStage: 'deepMining' as const,
    dimensions: ['architecture'],
    scale: {
      totalRecipeBudget: 1,
      maxFiles: 8,
      contentMaxLines: 20,
      depthLevels: ['project', 'module'],
    },
    moduleBindings: [
      {
        modulePath: 'src',
        dimensions: ['architecture'],
        targetRecipes: input.targetRecipes ?? 1,
      },
    ],
  };
}

function createRescanContext(
  fixture: ReturnType<typeof createFileBackedSessionFixture>,
  runtime: AlembicDatabaseRuntime,
  repositories: AlembicRepositoryBundle,
  extraServices: Record<string, unknown> = {}
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
    ...extraServices,
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

function createStatefulCoverageLedgerRepository(
  input: {
    cells?: CoverageLedgerRecord[];
    ignoreCellUpserts?: boolean;
    rounds?: DeepMiningRoundRecord[];
  } = {}
) {
  const cells = [...(input.cells ?? [])];
  const ignoreCellUpserts = input.ignoreCellUpserts === true;
  const rounds = [...(input.rounds ?? [])];
  const cellUpserts: UpsertCoverageLedgerInput[] = [];
  const roundUpserts: UpsertDeepMiningRoundInput[] = [];
  const repository = {
    listByProjectRoot(projectRoot: string): CoverageLedgerRecord[] {
      return cells.filter(
        (cell) => cell.projectRoot === projectRoot || cell.projectRoot === '/proj'
      );
    },
    listRoundsByProjectRoot(projectRoot: string): DeepMiningRoundRecord[] {
      return rounds
        .filter((round) => round.projectRoot === projectRoot || round.projectRoot === '/proj')
        .sort((a, b) => a.roundIndex - b.roundIndex);
    },
    upsertCell(cellInput: UpsertCoverageLedgerInput): CoverageLedgerRecord {
      cellUpserts.push(cellInput);
      if (ignoreCellUpserts) {
        return (
          cells.find(
            (cell) =>
              cell.moduleId === cellInput.moduleId && cell.dimensionId === cellInput.dimensionId
          ) ??
          coverageCell({
            dimensionId: cellInput.dimensionId,
            grade: cellInput.grade ?? 'empty',
            moduleId: cellInput.moduleId,
          })
        );
      }
      const existingIndex = cells.findIndex(
        (cell) =>
          cell.projectRoot === cellInput.projectRoot &&
          cell.moduleId === cellInput.moduleId &&
          cell.dimensionId === cellInput.dimensionId
      );
      const existing = existingIndex >= 0 ? cells[existingIndex] : null;
      const saved = coverageCell({
        ...existing,
        projectRoot: cellInput.projectRoot,
        moduleId: cellInput.moduleId,
        dimensionId: cellInput.dimensionId,
        coveredCount: cellInput.coveredCount ?? 0,
        totalCandidateCount: cellInput.totalCandidateCount ?? 0,
        grade: cellInput.grade ?? 'empty',
        exhausted: cellInput.exhausted ?? false,
        exhaustedReason: cellInput.exhaustedReason ?? null,
        exhaustedSource: cellInput.exhaustedSource ?? null,
        coveredSourceRefs: cellInput.coveredSourceRefs ?? [],
        uncoveredHints: cellInput.uncoveredHints ?? [],
        valueScore: cellInput.valueScore ?? null,
        lastRound: cellInput.lastRound ?? null,
        deferred: cellInput.deferred ?? false,
      });
      if (existingIndex >= 0) {
        cells[existingIndex] = saved;
      } else {
        cells.push(saved);
      }
      return saved;
    },
    upsertRound(input: UpsertDeepMiningRoundInput): DeepMiningRoundRecord {
      roundUpserts.push(input);
      const hasRescanId = input.rescanId !== undefined && input.rescanId !== null;
      const existingIndex = rounds.findIndex(
        (round) =>
          round.projectRoot === input.projectRoot &&
          (hasRescanId ? round.rescanId === input.rescanId : round.roundIndex === input.roundIndex)
      );
      const existing = existingIndex >= 0 ? rounds[existingIndex] : null;
      const saved: DeepMiningRoundRecord = {
        projectRoot: input.projectRoot,
        roundIndex: existing?.roundIndex ?? input.roundIndex,
        rescanId: input.rescanId ?? existing?.rescanId ?? null,
        startedAt: input.startedAt ?? existing?.startedAt ?? null,
        completedAt: input.completedAt ?? existing?.completedAt ?? null,
        newRecipesThisRound: input.newRecipesThisRound ?? existing?.newRecipesThisRound ?? 0,
        triggerActor: input.triggerActor ?? existing?.triggerActor ?? null,
        createdAt: existing?.createdAt ?? 0,
        updatedAt: 0,
      };
      if (existingIndex >= 0) {
        rounds[existingIndex] = saved;
      } else {
        rounds.push(saved);
      }
      return saved;
    },
  };
  return { repository, cells, cellUpserts, rounds, roundUpserts };
}

function coverageCell(
  input: Partial<CoverageLedgerRecord> &
    Pick<CoverageLedgerRecord, 'dimensionId' | 'grade' | 'moduleId'>
): CoverageLedgerRecord {
  return {
    projectRoot: '/proj',
    coveredCount: 0,
    totalCandidateCount: 0,
    exhausted: false,
    exhaustedReason: null,
    exhaustedSource: null,
    coveredSourceRefs: [],
    uncoveredHints: [],
    valueScore: 0,
    lastRound: null,
    deferred: false,
    createdAt: 0,
    updatedAt: 0,
    ...input,
  };
}

async function insertRecipeWithSourceRef(
  repositories: AlembicRepositoryBundle,
  input: { dimensionId: string; id: string; sourcePath: string }
): Promise<void> {
  const now = Date.now();
  await repositories.knowledgeRepository.create(
    new KnowledgeEntry({
      id: input.id,
      title: 'Recipe from real source ref',
      lifecycle: 'active',
      language: 'typescript',
      dimensionId: input.dimensionId,
      category: 'general',
      kind: 'pattern',
      knowledgeType: 'code-pattern',
      trigger: `trigger-${input.id}`,
      doClause: 'Use the source-backed pattern.',
      content: { markdown: 'Source-backed recipe body.' },
      reasoning: { sources: [input.sourcePath] },
      sourceFile: input.sourcePath,
      createdAt: now,
      updatedAt: now,
    })
  );
  repositories.recipeSourceRefRepository.upsert({
    recipeId: input.id,
    sourcePath: input.sourcePath,
    status: 'active',
    verifiedAt: now,
    contentFp: `fp-${input.id}`,
  });
}
