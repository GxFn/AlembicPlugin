import { describe, expect, it } from 'vitest';
import type { GitDiffScanResult } from '../../lib/recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import {
  buildPluginOpportunisticEvolutionSurface,
  extractPluginToolOutcome,
  shouldAttachPluginOpportunisticEvolution,
} from '../../lib/recipe-generation/evolution/PluginOpportunisticEvolution.js';
import { attachPluginOpportunisticEvolutionSurface } from '../../lib/runtime/mcp/host/opportunistic-evolution-presenter.js';

const fallbackGate = {
  mainServiceCanHandleProjectScope: false,
  reason: 'resident unavailable',
  residentProjectScopeAvailable: false,
};

function makeScan(overrides: Partial<GitDiffScanResult> = {}): GitDiffScanResult {
  return {
    dirtyPathCount: 1,
    events: [
      {
        eventSource: 'git-worktree',
        path: 'src/service.ts',
        type: 'modified',
      },
    ],
    head: 'abc123',
    headChanged: false,
    headRangeStatus: 'none',
    maxEvents: 200,
    previousHead: null,
    scanned: true,
    scannedAt: '2026-05-31T10:00:00.000Z',
    signature: 'sig',
    truncated: false,
    ...overrides,
  };
}

describe('Plugin opportunistic evolution surface', () => {
  it('defers when Alembic resident ProjectScope can handle the project', async () => {
    let scanned = false;
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scanner: {
        async scanOnce() {
          scanned = true;
          return makeScan();
        },
      },
      serviceGate: {
        mainServiceCanHandleProjectScope: true,
        reason: 'resident ready',
        residentProjectScopeAvailable: true,
      },
      toolOutcome: { success: true, tool: 'alembic_task' },
    });

    expect(scanned).toBe(true);
    expect(surface.evidenceGate.verdict).toBe('defer-to-alembic-service');
    expect(surface.producerBoundary.producerKind).toBe('plugin-opportunistic');
  });

  it('returns no-op when git diff evidence was not routed to unified evolution', async () => {
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scan: makeScan(),
      serviceGate: fallbackGate,
      toolOutcome: {
        success: true,
        taskId: 'task-1',
        tool: 'alembic_task',
        reason: 'implemented API change',
      },
    });

    expect(surface.evidenceGate.verdict).toBe('no-op');
    expect(surface.gitDiffEvidence?.events).toEqual([
      expect.objectContaining({ path: 'src/service.ts' }),
    ]);
    expect('proposal' in surface).toBe(false);
    expect('hint' in surface).toBe(false);
    expect(surface.autoSubmit).toBe(false);
    expect(surface.producerBoundary.separatedFrom).toBe('daemon-file-change');
  });

  it('keeps fallback no-op when tool outcome evidence is missing', async () => {
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scan: makeScan(),
      serviceGate: fallbackGate,
    });

    expect(surface.evidenceGate.verdict).toBe('no-op');
    expect('proposal' in surface).toBe(false);
    expect('hint' in surface).toBe(false);
  });

  it('returns no-op when fallback has no git diff evidence', async () => {
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scan: makeScan({ events: [], dirtyPathCount: 0, signature: null }),
      serviceGate: fallbackGate,
      toolOutcome: { success: true, tool: 'alembic_task' },
    });

    expect(surface.evidenceGate.verdict).toBe('no-op');
    expect('proposal' in surface).toBe(false);
    expect('hint' in surface).toBe(false);
  });

  it('attaches only to current commit-driven trigger tools', () => {
    expect(
      shouldAttachPluginOpportunisticEvolution({
        toolName: 'alembic_task',
        args: { operation: 'close' },
      })
    ).toBe(false);
    expect(
      shouldAttachPluginOpportunisticEvolution({
        toolName: 'alembic_code_guard',
        args: {},
      })
    ).toBe(true);
    expect(
      shouldAttachPluginOpportunisticEvolution({
        toolName: 'alembic_search',
        args: {},
      })
    ).toBe(false);
    expect(
      extractPluginToolOutcome('alembic_code_guard', { success: true, message: 'ok' })
    ).toEqual({
      reason: 'ok',
      success: true,
      tool: 'alembic_code_guard',
    });
  });

  it('returns routed surface when unified evolution handled git diff events', async () => {
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scan: makeScan(),
      serviceGate: fallbackGate,
      toolOutcome: {
        success: true,
        tool: 'alembic_code_guard',
        reason: 'guard completed',
      },
      unifiedEvolution: {
        classificationCounts: {
          coveredCreated: 0,
          created: 0,
          deleted: 0,
          deprecationProposals: 0,
          moduleMiningRoutes: 0,
          modified: 1,
          proposed: 1,
          renamed: 0,
          repaired: 0,
          skipped: 0,
        },
        deprecated: 0,
        details: [],
        fixed: 0,
        generationChangeLog: [
          {
            action: 'source-modified-review-needed',
            createdAt: 1,
            filePath: 'src/service.ts',
            reason: 'changed service tokens',
            recipeId: 'recipe-1',
          },
        ],
        moduleMiningRoutes: [],
        needsReview: 1,
        pendingProposals: [
          {
            action: 'update',
            confidence: 0.72,
            description: 'changed service tokens',
            filePath: 'src/service.ts',
            recipeId: 'recipe-1',
            source: 'file-change',
            status: 'submitted',
          },
        ],
        planBoundary: {
          generationStateWrites: 0,
          planIntentWrites: 0,
          projectedFromExistingDbSources: true,
        },
        skipped: 0,
        suggestReview: true,
      },
    });

    expect(surface.evidenceGate.verdict).toBe('routed');
    expect(surface.unifiedEvolution).toMatchObject({
      classificationCounts: { modified: 1, proposed: 1 },
      generationChangeLog: [expect.objectContaining({ action: 'source-modified-review-needed' })],
      moduleMiningRoutes: [],
      needsReview: 1,
      pendingProposals: [expect.objectContaining({ action: 'update', recipeId: 'recipe-1' })],
      planBoundary: {
        generationStateWrites: 0,
        planIntentWrites: 0,
        projectedFromExistingDbSources: true,
      },
    });
    expect('proposal' in surface).toBe(false);
  });

  it('keeps alembic_rescan-owned unified evolution instead of overwriting it with a second scan', async () => {
    const rescanOwnedResult = {
      success: true,
      data: {
        gitDiffEvidence: { eventCount: 3, headChanged: true },
        unifiedEvolution: {
          evidenceGate: { verdict: 'routed' },
          gitDiffEvidence: { eventCount: 3, headChanged: true },
        },
      },
    };

    const result = await attachPluginOpportunisticEvolutionSurface({
      args: {},
      executionContext: { residentProjectScopeAvailable: false } as never,
      projectRoot: '/repo/that/does/not/need/git',
      result: rescanOwnedResult,
      toolName: 'alembic_rescan',
    });

    expect(result).toBe(rescanOwnedResult);
    expect((result as typeof rescanOwnedResult).data.unifiedEvolution).toMatchObject({
      evidenceGate: { verdict: 'routed' },
      gitDiffEvidence: { eventCount: 3, headChanged: true },
    });
  });
});
