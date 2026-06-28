import { afterEach, describe, expect, test, vi } from 'vitest';

const runProjectIndexWorkflowMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, _args: unknown, options: { mode: string }) => ({
    success: true,
    data: { mode: options.mode },
  }))
);

const projectIndexColdStartMock = vi.hoisted(() => vi.fn());
const projectIndexRescanMock = vi.hoisted(() => vi.fn());
const getActiveSessionMock = vi.hoisted(() => vi.fn(() => null));

vi.mock('../../lib/recipe-generation/host-agent-workflows/project-index.js', () => ({
  getActiveSession: getActiveSessionMock,
  runHostAgentColdStartWorkflow: projectIndexColdStartMock,
  runHostAgentKnowledgeRescanWorkflow: projectIndexRescanMock,
  runProjectIndexWorkflow: runProjectIndexWorkflowMock,
}));

import { runHostAgentColdStartWorkflow as legacyColdStartWorkflow } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';
import { runHostAgentKnowledgeRescanWorkflow as legacyRescanWorkflow } from '../../lib/recipe-generation/host-agent-workflows/knowledge-rescan.js';
import {
  bootstrapForHostAgent,
  runProjectIndexWorkflow as bootstrapProjectIndexWorkflow,
  getActiveSession,
} from '../../lib/runtime/mcp/handlers/host-agent/bootstrap.js';
import {
  rescanForHostAgent,
  runProjectIndexWorkflow as rescanProjectIndexWorkflow,
} from '../../lib/runtime/mcp/handlers/host-agent/rescan.js';

describe('host-agent project-index compatibility exports', () => {
  afterEach(() => {
    runProjectIndexWorkflowMock.mockClear();
    projectIndexColdStartMock.mockClear();
    projectIndexRescanMock.mockClear();
    getActiveSessionMock.mockClear();
  });

  test('keeps MCP handler re-exports attached to the unified project-index module', () => {
    expect(bootstrapForHostAgent).toBe(projectIndexColdStartMock);
    expect(rescanForHostAgent).toBe(projectIndexRescanMock);
    expect(bootstrapProjectIndexWorkflow).toBe(runProjectIndexWorkflowMock);
    expect(rescanProjectIndexWorkflow).toBe(runProjectIndexWorkflowMock);
    expect(getActiveSession).toBe(getActiveSessionMock);
  });

  test('old cold-start module name forwards to full mode', async () => {
    const ctx = { marker: 'legacy-full' } as Parameters<typeof legacyColdStartWorkflow>[0];
    const args = { planSelection: { generationStage: 'coldStart' } } as Parameters<
      typeof legacyColdStartWorkflow
    >[1];

    const result = await legacyColdStartWorkflow(ctx, args);

    expect(result).toMatchObject({ success: true, data: { mode: 'full' } });
    expect(runProjectIndexWorkflowMock).toHaveBeenCalledWith(ctx, args, { mode: 'full' });
  });

  test('old knowledge-rescan module name forwards to incremental mode', async () => {
    const ctx = { marker: 'legacy-incremental' } as Parameters<typeof legacyRescanWorkflow>[0];
    const args = {
      planSelection: { generationStage: 'deepMining' },
      reason: 'legacy',
    } as Parameters<typeof legacyRescanWorkflow>[1];

    const result = await legacyRescanWorkflow(ctx, args);

    expect(result).toMatchObject({ success: true, data: { mode: 'incremental' } });
    expect(runProjectIndexWorkflowMock).toHaveBeenCalledWith(ctx, args, { mode: 'incremental' });
  });
});
