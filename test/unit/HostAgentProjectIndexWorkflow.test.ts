import { afterEach, describe, expect, test, vi } from 'vitest';

const fullWorkflowMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, args: unknown) => ({
    success: true,
    data: { args, mode: 'full' },
  }))
);

const incrementalWorkflowMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, args: unknown) => ({
    success: true,
    data: { args, mode: 'incremental' },
  }))
);

const getActiveSessionMock = vi.hoisted(() => vi.fn(() => null));

vi.mock('../../lib/recipe-generation/host-agent-workflows/cold-start.js', () => ({
  getActiveSession: getActiveSessionMock,
  runHostAgentProjectIndexFullWorkflow: fullWorkflowMock,
}));

vi.mock('../../lib/recipe-generation/host-agent-workflows/knowledge-rescan.js', () => ({
  runHostAgentProjectIndexIncrementalWorkflow: incrementalWorkflowMock,
}));

import {
  getActiveSession,
  runHostAgentColdStartWorkflow,
  runHostAgentKnowledgeRescanWorkflow,
  runProjectIndexWorkflow,
} from '../../lib/recipe-generation/host-agent-workflows/project-index.js';

describe('host-agent project-index workflow entry', () => {
  afterEach(() => {
    fullWorkflowMock.mockClear();
    incrementalWorkflowMock.mockClear();
    getActiveSessionMock.mockClear();
  });

  test('dispatches explicit full mode to the cold-start implementation', async () => {
    const ctx = { marker: 'full-context' } as Parameters<typeof runHostAgentColdStartWorkflow>[0];
    const args = { planSelection: { generationStage: 'coldStart' } } as Parameters<
      typeof runHostAgentColdStartWorkflow
    >[1];

    const result = await runProjectIndexWorkflow(ctx, args, { mode: 'full' });

    expect(result).toMatchObject({ success: true, data: { mode: 'full' } });
    expect(fullWorkflowMock).toHaveBeenCalledWith(ctx, args);
    expect(incrementalWorkflowMock).not.toHaveBeenCalled();
  });

  test('dispatches explicit incremental mode to the rescan implementation', async () => {
    const ctx = { marker: 'incremental-context' } as Parameters<
      typeof runHostAgentKnowledgeRescanWorkflow
    >[0];
    const args = { planSelection: { generationStage: 'deepMining' }, reason: 'test' } as Parameters<
      typeof runHostAgentKnowledgeRescanWorkflow
    >[1];

    const result = await runProjectIndexWorkflow(ctx, args, { mode: 'incremental' });

    expect(result).toMatchObject({ success: true, data: { mode: 'incremental' } });
    expect(incrementalWorkflowMock).toHaveBeenCalledWith(ctx, args);
    expect(fullWorkflowMock).not.toHaveBeenCalled();
  });

  test('keeps old public names as mode-specific wrappers on the unified entry module', async () => {
    const fullCtx = { marker: 'full-wrapper' } as Parameters<
      typeof runHostAgentColdStartWorkflow
    >[0];
    const fullArgs = { planSelection: { generationStage: 'coldStart' } } as Parameters<
      typeof runHostAgentColdStartWorkflow
    >[1];
    const incrementalCtx = { marker: 'incremental-wrapper' } as Parameters<
      typeof runHostAgentKnowledgeRescanWorkflow
    >[0];
    const incrementalArgs = {
      planSelection: { generationStage: 'deepMining' },
      reason: 'wrapper-test',
    } as Parameters<typeof runHostAgentKnowledgeRescanWorkflow>[1];

    await runHostAgentColdStartWorkflow(fullCtx, fullArgs);
    await runHostAgentKnowledgeRescanWorkflow(incrementalCtx, incrementalArgs);

    expect(fullWorkflowMock).toHaveBeenCalledWith(fullCtx, fullArgs);
    expect(incrementalWorkflowMock).toHaveBeenCalledWith(incrementalCtx, incrementalArgs);
    expect(getActiveSession).toBe(getActiveSessionMock);
  });
});
