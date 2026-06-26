import { describe, expect, it, vi } from 'vitest';
import { releaseEmptyHostAgentSessionLease } from '../../lib/recipe-generation/host-agent-workflows/project-context-analysis.js';

describe('releaseEmptyHostAgentSessionLease', () => {
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
