import { evaluateProjectAnalysisIncrementalPlan } from '@alembic/core/project-intelligence';
import { describe, expect, test, vi } from 'vitest';

function createDb(marker: string) {
  const drizzleAccesses: string[] = [];
  const emptyLatestSnapshotQuery = {
    from: () => emptyLatestSnapshotQuery,
    get: () => null,
    limit: () => emptyLatestSnapshotQuery,
    orderBy: () => emptyLatestSnapshotQuery,
    where: () => emptyLatestSnapshotQuery,
  };
  return {
    db: {
      getDrizzle: () => {
        drizzleAccesses.push(marker);
        return {
          select: () => emptyLatestSnapshotQuery,
        };
      },
    },
    drizzleAccesses,
  };
}

describe('ProjectIntelligenceIncrementalPlanner', () => {
  test('resolves the workflow database from container.get("database")', async () => {
    const { db, drizzleAccesses } = createDb('database');
    const report = { phases: {}, startTime: Date.now() };

    const result = await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container: { get: (name: string) => (name === 'database' ? db : null) },
        logger: { info: vi.fn() },
      },
      allFiles: [{ path: '/repo/a.ts', relativePath: 'a.ts', content: 'export {}' }],
      report,
    });

    expect(drizzleAccesses).toEqual(['database']);
    expect(result.incrementalPlan?.mode).toBe('full');
    expect(result.warnings).toEqual([]);
    expect(report.phases.incremental?.plan).toBe(result.incrementalPlan);
  });

  test('preserves this binding when resolving database from a ServiceContainer-like object', async () => {
    const { db, drizzleAccesses } = createDb('bound-database');
    const container = {
      get(name: string) {
        return this === container && name === 'database' ? db : null;
      },
    };

    const result = await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container,
        logger: { info: vi.fn() },
      },
      allFiles: [],
      report: null,
    });

    expect(drizzleAccesses).toEqual(['bound-database']);
    expect(result.incrementalPlan?.mode).toBe('full');
    expect(result.warnings).toEqual([]);
  });

  test('falls back through resolver aliases before reporting missing db', async () => {
    const { db, drizzleAccesses } = createDb('ctx-db');

    await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container: {
          get: () => {
            throw new Error('missing');
          },
        },
        db,
        logger: { info: vi.fn() },
      },
      allFiles: [],
      report: null,
    });

    expect(drizzleAccesses).toEqual(['ctx-db']);

    const result = await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container: { get: () => null, resolve: () => null },
        logger: { info: vi.fn() },
      },
      allFiles: [],
      report: null,
    });

    expect(result.incrementalPlan).toBeNull();
    expect(result.warnings).toEqual(['incremental: db not available, falling back to full']);
  });
});
