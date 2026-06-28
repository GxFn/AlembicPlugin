import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetBootstrapSessionManagersForTesting,
  getOrCreateSessionManager,
} from '@alembic/core/host-agent-workflows';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectKnowledge } from '#codex/KnowledgeState.js';
import {
  type HostAgentDimensionCompletionContext,
  type HostAgentWorkflowSession,
  runHostAgentDimensionCompletionWorkflow,
} from '#recipe-generation/host-agent-workflows/dimension-completion.js';

const tempRoots: string[] = [];

afterEach(() => {
  _resetBootstrapSessionManagersForTesting();
  pathGuard._reset();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('HostAgentDimensionCompletionWorkflow', () => {
  it('returns validation envelopes before touching session state', async () => {
    const getActiveSession = vi.fn();
    const result = await runHostAgentDimensionCompletionWorkflow(
      createContext(),
      { analysisText: 'analysis text long enough' },
      { getActiveSession }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(getActiveSession).not.toHaveBeenCalled();
  });

  it('returns SESSION_NOT_FOUND when no host-agent session is active', async () => {
    const result = await runHostAgentDimensionCompletionWorkflow(
      createContext(),
      { dimensionId: 'architecture', analysisText: 'analysis text long enough' },
      { getActiveSession: () => null }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SESSION_NOT_FOUND');
  });

  it('recovers submissions from tracker and marks an incomplete session dimension complete', async () => {
    const updates: Array<{ recipeId: string; tags: string[] }> = [];
    const checkpoint = vi.fn(async () => undefined);
    const emitted: Array<{ dimId: string; data: Record<string, unknown> }> = [];
    const session = createSession();
    const analysisText = longAnalysisText();
    const context = createContext({
      get: (name: string) => {
        if (name === 'knowledgeService') {
          return {
            get: async (recipeId: string) => ({
              title: recipeId,
              tags: ['existing'],
            }),
            update: async (recipeId: string, patch: { tags?: string[] }) => {
              updates.push({ recipeId, tags: patch.tags || [] });
            },
          };
        }
        return null;
      },
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText,
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: checkpoint,
        createEmitter: () => ({
          emitDimensionComplete: (dimId, data) => emitted.push({ dimId, data }),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.recipesBound).toBe(3);
    expect(data.progress).toBe('1/2');
    expect(data.isBootstrapComplete).toBe(false);
    expect(data.subpackageCoverageWarning).toContain('internal-lib');
    expect(data.completenessCritic).toMatchObject({
      dimensionId: 'architecture',
      status: 'has-grounded-hints',
      shouldBlockCompletion: false,
      targetGate: 'advisory',
      targetPerDimension: 5,
    });
    expect(JSON.stringify(data.completenessCritic)).toContain('internal-lib');
    expect(updates).toEqual([
      {
        recipeId: 'recipe-a',
        tags: [
          'existing',
          'architecture',
          'dimension:architecture',
          'bootstrap',
          'bootstrap:session-1',
        ],
      },
      {
        recipeId: 'recipe-b',
        tags: [
          'existing',
          'architecture',
          'dimension:architecture',
          'bootstrap',
          'bootstrap:session-1',
        ],
      },
      {
        recipeId: 'recipe-c',
        tags: [
          'existing',
          'architecture',
          'dimension:architecture',
          'bootstrap',
          'bootstrap:session-1',
        ],
      },
    ]);
    expect(checkpoint).toHaveBeenCalledWith(
      '/tmp/alembic-test-project',
      'session-1',
      'architecture',
      {
        candidateCount: 3,
        analysisChars: analysisText.length,
        hostAgentAnalysisProgress: {
          checkpointKind: 'ide-agent-analysis-unit-progress',
          completedUnitIds: [],
          rejectedUnitIds: [],
          remainingUnitIds: [],
          skippedUnitIds: [],
          unitProgress: [],
        },
        ideAgentAnalysisProgress: {
          checkpointKind: 'ide-agent-analysis-unit-progress',
          completedUnitIds: [],
          rejectedUnitIds: [],
          remainingUnitIds: [],
          skippedUnitIds: [],
          unitProgress: [],
        },
        referencedFiles: 3,
        recipeIds: ['recipe-a', 'recipe-b', 'recipe-c'],
        skillCreated: false,
      }
    );
    const checkpointPayload = checkpoint.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(checkpointPayload.ideAgentAnalysisProgress).toBe(
      checkpointPayload.hostAgentAnalysisProgress
    );
    const responseData = result.data as Record<string, unknown>;
    expect(responseData.ideAgentAnalysisProgress).toBe(responseData.hostAgentAnalysisProgress);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toMatchObject({
      extracted: 3,
      progress: '1/2',
      recipesBound: 3,
      source: 'host-agent',
    });
  });

  it('writes coverage ledger from canonical module ownedFiles before directory fallback', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const coverageLedgerRepository = {
      listByProjectRoot: vi.fn(() => []),
      upsertCell: vi.fn((input: Record<string, unknown>) => {
        upserts.push(input);
        return {
          projectRoot: input.projectRoot,
          moduleId: input.moduleId,
          dimensionId: input.dimensionId,
          coveredCount: input.coveredCount ?? 0,
          totalCandidateCount: input.totalCandidateCount ?? 0,
          grade: input.grade ?? 'empty',
          exhausted: false,
          exhaustedReason: null,
          exhaustedSource: null,
          coveredSourceRefs: input.coveredSourceRefs ?? [],
          uncoveredHints: input.uncoveredHints ?? [],
          valueScore: input.valueScore ?? null,
          lastRound: input.lastRound ?? null,
          deferred: false,
          createdAt: 0,
          updatedAt: 0,
        };
      }),
      listRoundsByProjectRoot: vi.fn(() => [
        {
          projectRoot: '/tmp/alembic-test-project',
          roundIndex: 2,
          rescanId: 'round-rescan-2',
          startedAt: 100,
          completedAt: null,
          newRecipesThisRound: 0,
          triggerActor: 'host-agent-rescan',
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      upsertRound: vi.fn((input: Record<string, unknown>) => input),
    };
    const moduleService = {
      listCanonicalModules: vi.fn(async () => [
        {
          id: 'auth',
          name: 'Auth',
          path: 'src/auth',
          ownedFiles: ['src/auth/login.ts'],
        },
      ]),
    };
    const session = createSession({
      submissions: [
        { recipeId: 'recipe-a', sources: ['src/auth/login.ts:10-20'] },
        { recipeId: 'recipe-b', sources: ['src/auth/login.ts:30-40'] },
        { recipeId: 'recipe-c', sources: ['src/auth/ignored.ts:1-3'] },
      ],
    });
    const context = createContext({
      get: (name: string) => {
        if (name === 'coverageLedgerRepository') {
          return coverageLedgerRepository;
        }
        if (name === 'moduleService') {
          return moduleService;
        }
        return null;
      },
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        submittedRecipeIds: ['recipe-a', 'recipe-b', 'recipe-c'],
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    expect(moduleService.listCanonicalModules).toHaveBeenCalledOnce();
    const authCell = upserts.find((upsert) => upsert.moduleId === 'auth');
    expect(authCell?.coveredCount).toBeGreaterThan(0);
    expect(JSON.stringify(authCell)).toContain('src/auth/login.ts');
    expect(JSON.stringify(authCell)).not.toContain('src/auth/ignored.ts');
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/tmp/alembic-test-project',
        roundIndex: 2,
        rescanId: 'round-rescan-2',
        newRecipesThisRound: 3,
      })
    );
  });

  it('filters dimension-completion coverage ledger writes to target-scoped modules', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const coverageLedgerRepository = {
      listByProjectRoot: vi.fn(() => []),
      upsertCell: vi.fn((input: Record<string, unknown>) => {
        upserts.push(input);
        return {
          projectRoot: input.projectRoot,
          moduleId: input.moduleId,
          dimensionId: input.dimensionId,
          coveredCount: input.coveredCount ?? 0,
          totalCandidateCount: input.totalCandidateCount ?? 0,
          grade: input.grade ?? 'empty',
          exhausted: false,
          exhaustedReason: null,
          exhaustedSource: null,
          coveredSourceRefs: input.coveredSourceRefs ?? [],
          uncoveredHints: input.uncoveredHints ?? [],
          valueScore: input.valueScore ?? null,
          lastRound: input.lastRound ?? null,
          deferred: false,
          createdAt: 0,
          updatedAt: 0,
        };
      }),
      listRoundsByProjectRoot: vi.fn(() => []),
      upsertRound: vi.fn((input: Record<string, unknown>) => input),
    };
    const moduleService = {
      listCanonicalModules: vi.fn(async () => [
        {
          id: 'target:Auth:src/auth',
          name: 'Auth',
          path: 'src/auth',
          ownedFiles: ['src/auth/login.ts'],
        },
        {
          id: 'Sources',
          name: 'Sources',
          path: 'src',
          ownedFiles: ['src/aggregate.ts'],
        },
        {
          id: 'module:root:Fixture:Fixture',
          name: 'Fixture',
          path: '.',
          ownedFiles: ['root.ts'],
        },
      ]),
    };
    const session = createSession({
      submissions: [
        { recipeId: 'recipe-a', sources: ['src/auth/login.ts:10-20'] },
        { recipeId: 'recipe-b', sources: ['src/auth/login.ts:30-40'] },
        { recipeId: 'recipe-c', sources: ['src/auth/router.ts:1-5'] },
      ],
    });
    const context = createContext({
      get: (name: string) => {
        if (name === 'coverageLedgerRepository') {
          return coverageLedgerRepository;
        }
        if (name === 'moduleService') {
          return moduleService;
        }
        return null;
      },
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        submittedRecipeIds: ['recipe-a', 'recipe-b', 'recipe-c'],
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    expect(upserts.map((upsert) => upsert.moduleId)).toEqual(['target:Auth:src/auth']);
    expect(JSON.stringify(upserts)).not.toContain('Sources');
    expect(JSON.stringify(upserts)).not.toContain('module:root');
  });

  it('enriches generated project skills with submitted Recipe guidance even for long analysis', async () => {
    const generated: string[] = [];
    const session = createSession({ skillWorthy: true });
    const context = createContext({
      get: (name: string) => {
        if (name === 'knowledgeService') {
          return {
            get: async (recipeId: string) => ({
              title: `Recipe ${recipeId}`,
              description: `Description for ${recipeId}`,
              whenClause: `Use ${recipeId} when completing the bootstrap dimension.`,
              doClause: `Apply ${recipeId} with source-backed evidence.`,
              dontClause: `Do not apply ${recipeId} without session-bound Recipes.`,
              coreCode: `const ${recipeId.replaceAll('-', '_')} = true;`,
              tags: ['existing'],
            }),
            update: async () => undefined,
          };
        }
        return null;
      },
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: `${longAnalysisText()}\n\n${longAnalysisText()}`,
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
      },
      {
        getActiveSession: () => session,
        generateSkill: async (_ctx, _dimension, analysisText) => {
          generated.push(analysisText);
          return { success: true };
        },
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toContain('### Recipe recipe-a');
    expect(generated[0]).toContain(
      '**When**: Use recipe-a when completing the bootstrap dimension.'
    );
    expect(generated[0]).toContain('**Do**: Apply recipe-a with source-backed evidence.');
    expect(generated[0]).toContain(
      "**Don't**: Do not apply recipe-a without session-bound Recipes."
    );
    expect(generated[0]).toContain('const recipe_a = true;');
  });

  it('writes a non-empty Project Skill and exposes it through real skillCount', async () => {
    const projectRoot = createInitializedProjectRoot();
    const session = createSession({ skillWorthy: true });
    const context = createContext(
      {
        get: (name: string) => {
          if (name === 'knowledgeService') {
            return {
              get: async (recipeId: string) => ({
                title: `Recipe ${recipeId}`,
                description: `Description for ${recipeId}`,
                whenClause: `Use ${recipeId} after reading verified source evidence.`,
                doClause: `Apply ${recipeId} with session-bound Recipe ids and sourceRefs.`,
                dontClause: `Do not apply ${recipeId} without alembic_dimension_complete evidence.`,
                coreCode: `const ${recipeId.replaceAll('-', '_')} = true;`,
                tags: ['existing'],
              }),
              update: async () => undefined,
            };
          }
          return null;
        },
      },
      projectRoot
    );

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    expect((result.data as { skillCreated?: boolean }).skillCreated).toBe(true);
    const skillPath = path.join(
      projectRoot,
      'Alembic',
      'skills',
      'project-architecture',
      'SKILL.md'
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    expect(skillContent.length).toBeGreaterThan(100);
    expect(skillContent).toContain('### Recipe recipe-a');
    expect(skillContent).toContain('## Referenced Files');
    const knowledgeState = inspectKnowledge(projectRoot);
    expect(knowledgeState.skillCount).toBe(1);
    expect(knowledgeState.hasKnowledge).toBe(true);
  });

  it('does not synthesize Recipe guidance when no submitted Recipes are bound', async () => {
    const generated: string[] = [];
    const session = createSession({ skillWorthy: true, submissions: [] });

    const result = await runHostAgentDimensionCompletionWorkflow(
      createContext(),
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
        submittedRecipeIds: [],
      },
      {
        getActiveSession: () => session,
        generateSkill: async (_ctx, _dimension, analysisText) => {
          generated.push(analysisText);
          return { success: true };
        },
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(false);
    expect(generated).toHaveLength(0);
  });

  it('blocks completion before checkpoint when session-bound recipe ids are insufficient', async () => {
    const checkpoint = vi.fn(async () => undefined);
    const emitted = vi.fn();
    const session = createSession({
      submissions: [{ recipeId: 'recipe-a', sources: ['src/a.ts:10-20'] }],
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      createContext(),
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: checkpoint,
        createEmitter: () => ({
          emitDimensionComplete: emitted,
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('DIMENSION_CANDIDATE_COUNT_INSUFFICIENT');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });

  it('releases terminal noPadding rescan resources when candidate count remains insufficient', async () => {
    const checkpoint = vi.fn(async () => undefined);
    const emitted = vi.fn();
    const clearSession = vi.fn();
    const coverageLedgerRepository = {
      listRoundsByProjectRoot: vi.fn(() => [
        {
          projectRoot: '/tmp/alembic-test-project',
          roundIndex: 2,
          rescanId: 'prior-rescan',
          startedAt: 100,
          completedAt: 200,
          newRecipesThisRound: 3,
          triggerActor: 'host-agent-rescan',
          createdAt: 100,
          updatedAt: 200,
        },
        {
          projectRoot: '/tmp/alembic-test-project',
          roundIndex: 3,
          rescanId: null,
          startedAt: 300,
          completedAt: null,
          newRecipesThisRound: 0,
          triggerActor: 'host-agent-rescan',
          createdAt: 300,
          updatedAt: 300,
        },
      ]),
      upsertRound: vi.fn((input: Record<string, unknown>) => input),
    };
    const session = createSession({
      submissions: [{ recipeId: 'recipe-a', sources: ['src/a.ts:10-20'] }],
    });
    const context = createContext({
      get: (name: string) => {
        if (name === 'bootstrapSessionManager') {
          return { clearSession };
        }
        if (name === 'coverageLedgerRepository') {
          return coverageLedgerRepository;
        }
        return null;
      },
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        exhaustedReason:
          'Reviewed the one-budget host rescan scope and found only one source-grounded candidate.',
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
        noPadding: true,
      },
      {
        getActiveSession: () => session,
        now: () => 12_345,
        saveCheckpoint: checkpoint,
        createEmitter: () => ({
          emitDimensionComplete: emitted,
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('DIMENSION_CANDIDATE_COUNT_INSUFFICIENT');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalledWith('session-1');
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith({
      projectRoot: '/tmp/alembic-test-project',
      roundIndex: 3,
      completedAt: 12_345,
      newRecipesThisRound: 0,
    });
  });

  it('releases terminal noPadding sessions from the project dataRoot when the container manager is stale', async () => {
    const checkpoint = vi.fn(async () => undefined);
    const emitted = vi.fn();
    const staleClearSession = vi.fn();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-terminal-cleanup-'));
    tempRoots.push(projectRoot);
    const scopedContainer = createDataRootSessionContainer(projectRoot);
    const fileBackedManager = getOrCreateSessionManager(scopedContainer);
    const fileBackedSession = fileBackedManager.createSession({
      projectRoot,
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectContext: { projectName: 'terminal-cleanup-real-route' },
    });
    const session = createSession({
      id: fileBackedSession.id,
      projectRoot,
      submissions: [{ recipeId: 'recipe-a', sources: ['src/a.ts:10-20'] }],
    });
    const context = createContext(
      {
        get: (name: string) => {
          if (name === 'bootstrapSessionManager') {
            return { clearSession: staleClearSession };
          }
          return null;
        },
      },
      projectRoot
    );

    const result = await runHostAgentDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        exhaustedReason:
          'Reviewed the terminal host rescan scope and found only one source-grounded candidate.',
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
        noPadding: true,
        submittedRecipeIds: ['recipe-a'],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: checkpoint,
        createEmitter: () => ({
          emitDimensionComplete: emitted,
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('DIMENSION_CANDIDATE_COUNT_INSUFFICIENT');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
    expect(staleClearSession).toHaveBeenCalledWith(fileBackedSession.id);
    expect(fileBackedManager.getSession(fileBackedSession.id, { projectRoot })).toBeNull();
    expect(fileBackedManager.getSession(undefined, { projectRoot })).toBeNull();
  });

  it('does not repeat completeness critic hints for refs already covered by submitted recipes', async () => {
    const session = createSession({
      localPackageModules: [{ packageName: 'packages/internal-lib', name: 'internal-lib' }],
      submissions: [
        { recipeId: 'recipe-a', sources: ['packages/internal-lib'], title: 'A' },
        { recipeId: 'recipe-b', sources: ['packages/internal-lib'], title: 'B' },
        { recipeId: 'recipe-c', sources: ['packages/internal-lib'], title: 'C' },
      ],
    });

    const result = await runHostAgentDimensionCompletionWorkflow(
      createContext(),
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        keyFindings: [
          'The internal package evidence covers the module boundary with direct source refs.',
          'The local package references demonstrate ownership without inventing extra patterns.',
          'The submitted Recipe ids all point to the same grounded package surface.',
        ],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    const critic = (result.data as { completenessCritic?: Record<string, unknown> })
      .completenessCritic;
    expect(critic).toMatchObject({
      shouldBlockCompletion: false,
      targetGate: 'advisory',
    });
    expect(JSON.stringify(critic?.hints ?? [])).not.toContain('internal-lib');
  });

  it('honors noPadding exhausted reason without turning target five into a hard gate', async () => {
    const session = createSession({ localPackageModules: [] });

    const result = await runHostAgentDimensionCompletionWorkflow(
      createContext(),
      {
        dimensionId: 'architecture',
        analysisText: longAnalysisText(),
        exhaustedReason:
          'Reviewed every source file in the current module and found only three grounded architecture patterns.',
        keyFindings: [
          'The source files expose the shared module boundary through architecture evidence.',
          'The package references show how runtime ownership is separated from plugin code.',
          'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
        ],
        noPadding: true,
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({
          emitDimensionComplete: vi.fn(),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    expect((result.data as { progress?: string }).progress).toBe('1/2');
    expect(
      (result.data as { completenessCritic?: Record<string, unknown> }).completenessCritic
    ).toMatchObject({
      status: 'exhausted',
      targetGate: 'advisory',
      shouldBlockCompletion: false,
      exhaustedReason: expect.stringContaining('only three grounded architecture patterns'),
    });
  });
});

function createContext(
  overrides: Partial<HostAgentDimensionCompletionContext['container']> = {},
  projectRoot = '/tmp/alembic-test-project'
) {
  return {
    container: {
      singletons: { _projectRoot: projectRoot, _dataRoot: projectRoot },
      get: () => null,
      ...overrides,
    },
  } as HostAgentDimensionCompletionContext;
}

function createInitializedProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-dimension-complete-skill-'));
  tempRoots.push(root);
  pathGuard.configure({ projectRoot: root });
  fs.mkdirSync(path.join(root, '.asd'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Alembic', 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(root, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.asd', 'alembic.db'), '');
  return root;
}

function createDataRootSessionContainer(projectRoot: string) {
  const registry: Record<string, unknown> = {};
  return {
    get: (name: string) => registry[name],
    register: (name: string, factory: () => unknown) => {
      registry[name] = factory();
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: { dataRoot: projectRoot },
    },
  };
}

function createSession({
  id = 'session-1',
  localPackageModules = [{ packageName: 'packages/internal-lib', name: 'internal-lib' }],
  projectRoot = '/tmp/alembic-test-project',
  skillWorthy = false,
  submissions = [
    { recipeId: 'recipe-a', sources: ['src/a.ts:10-20'], title: 'A' },
    { recipeId: 'recipe-b', sources: ['packages/core/b.ts:5-15'], title: 'B' },
    { recipeId: 'recipe-c', sources: ['lib/c.ts:1-12'], title: 'C' },
  ],
}: {
  id?: string;
  localPackageModules?: Array<{ packageName: string; name: string }>;
  projectRoot?: string;
  skillWorthy?: boolean;
  submissions?: Array<{ recipeId: string; sources: string[]; title?: string }>;
} = {}): HostAgentWorkflowSession {
  let completed = false;
  const session = {
    id,
    projectRoot,
    expiresAt: Date.now(),
    dimensions: [
      { id: 'architecture', label: 'Architecture', skillWorthy },
      { id: 'tooling', label: 'Tooling', skillWorthy: false },
    ],
    submissionTracker: {
      getSubmissions: (dimId: string) =>
        dimId === 'architecture'
          ? submissions.map((submission) => ({
              recipeId: submission.recipeId,
              sources: submission.sources,
              title: submission.title || submission.recipeId,
            }))
          : [],
      getAccumulatedEvidence: () => ({
        completedDimSummaries: [],
        sharedFiles: [],
        negativeSignals: [],
        usedTriggers: [],
      }),
    },
    sessionStore: {
      getDimensionReport: () => undefined,
    },
    getSnapshotCache: () => ({
      localPackageModules,
    }),
    getProgress: () => ({
      completed: completed ? 1 : 0,
      total: 2,
      completedDimIds: completed ? ['architecture'] : [],
      remainingDimIds: completed ? ['tooling'] : ['architecture', 'tooling'],
    }),
    get isComplete() {
      return false;
    },
    markDimensionComplete: () => {
      completed = true;
      return {
        updated: true,
        qualityReport: {
          totalScore: 72,
          pass: true,
          scores: {
            coverageScore: 80,
            evidenceScore: 70,
            diversityScore: 65,
            coherenceScore: 75,
          },
          suggestions: [],
        },
      };
    },
    storeHints: vi.fn(),
    getAccumulatedHints: () => ({}),
  };

  return session as unknown as HostAgentWorkflowSession;
}

function longAnalysisText(): string {
  return [
    '## Architecture evidence',
    '',
    '1. The analysis walks the verified bootstrap path from source discovery into Recipe candidate production.',
    '2. Each candidate is tied to a concrete source reference so the dimension completion step can recover the submitted Recipe identifiers.',
    '3. The completion workflow writes checkpoints only after the session-bound Recipe ids, referenced files, and key findings all agree.',
    '',
    '```ts',
    'export function completeDimensionWithVerifiedRecipes() {',
    '  return "session-bound-evidence";',
    '}',
    '```',
    '',
    'The remaining text intentionally keeps this fixture above the production floor so the success path exercises the positive loop instead of the validation branch.',
  ].join('\n');
}
