import { describe, expect, it } from 'vitest';
import {
  buildPluginOpportunisticEvolutionSurface,
  extractTaskCloseOutcome,
  shouldAttachPluginOpportunisticEvolution,
} from '../../lib/runtime/evolution/PluginOpportunisticEvolution.js';
import type { GitDiffScanResult } from '../../lib/service/evolution/git-diff-checkpoint/GitDiffScanner.js';

const fallbackGate = {
  mainServiceCanHandleProjectScope: false,
  reason: 'resident unavailable',
  residentProjectScopeAvailable: false,
};

function makeScan(overrides: Partial<GitDiffScanResult> = {}): GitDiffScanResult {
  return {
    changed: true,
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
    scanned: true,
    scannedAt: '2026-05-31T10:00:00.000Z',
    signature: 'sig',
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

    expect(scanned).toBe(false);
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
    ).toBe(true);
    expect(
      shouldAttachPluginOpportunisticEvolution({
        toolName: 'alembic_guard',
        args: {},
      })
    ).toBe(false);
    expect(
      extractTaskCloseOutcome({
        success: true,
        data: { closed: { id: 'task-1', reason: 'done' } },
      })
    ).toMatchObject({ taskId: 'task-1', reason: 'done' });
    expect(extractTaskCloseOutcome({ success: false })).toBeNull();
  });
});
