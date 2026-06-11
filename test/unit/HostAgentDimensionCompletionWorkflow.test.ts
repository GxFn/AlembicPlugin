import { describe, expect, it, vi } from 'vitest';
import {
  type HostAgentDimensionCompletionContext,
  type HostAgentWorkflowSession,
  runHostAgentDimensionCompletionWorkflow,
} from '#codex/mcp/host-agent-workflows/dimension-completion.js';

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
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toMatchObject({
      extracted: 3,
      progress: '1/2',
      recipesBound: 3,
      source: 'host-agent',
    });
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
});

function createContext(overrides: Partial<HostAgentDimensionCompletionContext['container']> = {}) {
  return {
    container: {
      singletons: { _projectRoot: '/tmp/alembic-test-project' },
      get: () => null,
      ...overrides,
    },
  } as HostAgentDimensionCompletionContext;
}

function createSession({
  submissions = [
    { recipeId: 'recipe-a', sources: ['src/a.ts:10-20'], title: 'A' },
    { recipeId: 'recipe-b', sources: ['packages/core/b.ts:5-15'], title: 'B' },
    { recipeId: 'recipe-c', sources: ['lib/c.ts:1-12'], title: 'C' },
  ],
}: {
  submissions?: Array<{ recipeId: string; sources: string[]; title?: string }>;
} = {}): HostAgentWorkflowSession {
  let completed = false;
  const session = {
    id: 'session-1',
    projectRoot: '/tmp/alembic-test-project',
    expiresAt: Date.now(),
    dimensions: [
      { id: 'architecture', label: 'Architecture', skillWorthy: false },
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
      localPackageModules: [{ packageName: 'packages/internal-lib', name: 'internal-lib' }],
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
