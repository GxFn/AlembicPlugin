import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { runWorkflowCompletionFinalizer } from '#workflows/capabilities/completion/WorkflowCompletionFinalizer.js';

describe('WorkflowCompletionFinalizer', () => {
  test('keeps retired project refresh as a no-op before immediate semantic memory', async () => {
    const events: string[] = [];
    const container = createContainer(events);
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      dataRoot: process.cwd(),
      log,
      dependencies: {
        getServiceContainer: () => container,
        scheduleTask: () => events.push('schedule'),
      },
      semanticMemory: { mode: 'immediate' },
    });

    expect(events).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      '[DimensionComplete] Project information refresh skipped: panorama provider retired; ProjectContext reads are live.'
    );
    expect(result.semanticMemoryResult).toBeNull();
    expect(result.panoramaStatus).toBe('completed');
  });

  test('scheduled semantic memory uses the workflow scheduler', async () => {
    const scheduled: Array<() => Promise<void>> = [];

    await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => ({ services: {}, get: () => undefined }),
        scheduleTask: (task) => scheduled.push(task),
      },
    });

    expect(scheduled).toHaveLength(1);
  });

  test('can skip panorama while keeping scheduled semantic memory', async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];

    const result = await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => createContainer(events),
        scheduleTask: (task) => scheduled.push(task),
      },
      steps: { panorama: 'skip' },
    });

    expect(events).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(result).toMatchObject({
      panoramaStatus: 'skipped',
    });
  });

  test('keeps completion side effects in dedicated step modules', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/workflows/capabilities/completion/WorkflowCompletionFinalizer.ts'),
      'utf8'
    );

    expect(source).toContain('CompletionSteps.js');
    expect(source).toContain('refreshPanorama');
    expect(source).toContain('consolidateSemanticMemory');
  });
});

function createContainer(events: string[]) {
  void events;
  return {
    services: {},
    get: () => undefined,
  };
}
