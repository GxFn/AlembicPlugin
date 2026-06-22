import { describe, expect, it } from 'vitest';
import type { GitDiffScanResult } from '../../lib/recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import {
  buildPluginOpportunisticEvolutionSurface,
  extractPluginToolOutcome,
  extractTaskCloseOutcome,
  shouldAttachPluginOpportunisticEvolution,
} from '../../lib/recipe-generation/evolution/PluginOpportunisticEvolution.js';

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

  it('surfaces a strong proposal from scoped git diff plus successful tool outcome', async () => {
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

    expect(surface.evidenceGate.verdict).toBe('strong-proposal');
    expect(surface.proposal).toMatchObject({
      producerKind: 'plugin-opportunistic',
      sourceRefs: ['src/service.ts'],
      toolOutcome: { taskId: 'task-1' },
    });
    expect(surface.autoSubmit).toBe(false);
    expect(surface.producerBoundary.separatedFrom).toBe('daemon-file-change');
  });

  it('downgrades to weak hint when tool outcome evidence is missing', async () => {
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scan: makeScan(),
      serviceGate: fallbackGate,
    });

    expect(surface.evidenceGate.verdict).toBe('weak-hint');
    expect(surface.hint?.sourceRefs).toEqual(['src/service.ts']);
    expect(surface.proposal).toBeUndefined();
  });

  it('returns no-op when fallback has no git diff evidence', async () => {
    const surface = await buildPluginOpportunisticEvolutionSurface({
      projectRoot: '/repo',
      scan: makeScan({ events: [], dirtyPathCount: 0, signature: null }),
      serviceGate: fallbackGate,
      toolOutcome: { success: true, tool: 'alembic_task' },
    });

    expect(surface.evidenceGate.verdict).toBe('no-op');
    expect(surface.proposal).toBeUndefined();
    expect(surface.hint).toBeUndefined();
  });

  it('only attaches to successful task close results', () => {
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
      extractTaskCloseOutcome({
        success: true,
        data: { closed: { id: 'task-1', reason: 'done' } },
      })
    ).toMatchObject({ taskId: 'task-1', reason: 'done' });
    expect(
      extractPluginToolOutcome('alembic_code_guard', { success: true, message: 'ok' })
    ).toEqual({
      reason: 'ok',
      success: true,
      tool: 'alembic_code_guard',
    });
    expect(extractTaskCloseOutcome({ success: false })).toBeNull();
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
          modified: 1,
          newModuleRecommendations: 0,
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
        recommendations: [],
        skipped: 0,
        suggestReview: true,
      },
    });

    expect(surface.evidenceGate.verdict).toBe('routed');
    expect(surface.unifiedEvolution).toMatchObject({
      classificationCounts: { modified: 1, proposed: 1 },
      generationChangeLog: [expect.objectContaining({ action: 'source-modified-review-needed' })],
      needsReview: 1,
      pendingProposals: [expect.objectContaining({ action: 'update', recipeId: 'recipe-1' })],
      planBoundary: {
        generationStateWrites: 0,
        planIntentWrites: 0,
        projectedFromExistingDbSources: true,
      },
    });
    expect(surface.proposal).toBeUndefined();
  });
});
