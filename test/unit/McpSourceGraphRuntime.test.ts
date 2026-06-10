import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildFullSourceGraphIndexForProject,
  buildSourceGraphStatus,
  resetSourceGraphRuntimeCacheForTests,
} from '../../lib/codex/mcp/source-graph/status.js';

const disabledQueryTools = [
  'alembic_symbol_search',
  'alembic_code_explore',
  'alembic_source_node',
  'alembic_callers',
  'alembic_callees',
  'alembic_code_impact',
  'alembic_affected_tests',
];

let projectRoots: string[] = [];

afterEach(async () => {
  await resetSourceGraphRuntimeCacheForTests();
  for (const projectRoot of projectRoots) {
    rmSync(projectRoot, { force: true, recursive: true });
  }
  projectRoots = [];
});

describe('MCP source graph runtime status', () => {
  test('reports uninitialized without opening a missing Core source graph database', async () => {
    const projectRoot = createProject();

    const structured = await statusData(projectRoot, { catchUp: false, now: 1_000 });

    expect(structured).toMatchObject({
      operation: 'status',
      ready: false,
      graph: { freshness: 'uninitialized', nextAction: 'needs_source_graph_init' },
      lifecycle: {
        runtimeReady: true,
        sourceGraphInitialized: false,
        sourceGraphIndexed: false,
        sourceGraphFresh: false,
        databaseExists: false,
      },
    });
    expect(structured.nextActions).toContain('needs_source_graph_init');
    expect(guidanceToolNames(structured, 'sourceGraphTools')).toEqual([
      'alembic_source_graph_status',
    ]);
    for (const toolName of disabledQueryTools) {
      expect(JSON.stringify(structured.guidance)).not.toContain(toolName);
    }
  });

  test('uses Core full index freshness and bounded incremental catch-up', async () => {
    const projectRoot = createProject();

    const full = await statusData(projectRoot, { now: 2_000 }, (root, args) =>
      buildFullSourceGraphIndexForProject(root, args)
    );
    expect(full).toMatchObject({
      operation: 'status',
      ready: true,
      graph: { freshness: 'fresh' },
      lifecycle: {
        sourceGraphInitialized: true,
        sourceGraphIndexed: true,
        sourceGraphFresh: true,
        databaseExists: true,
      },
    });
    expect(count(full, 'fileCount')).toBeGreaterThanOrEqual(2);
    expect(count(full, 'symbolCount')).toBeGreaterThanOrEqual(2);

    writeFileSync(
      join(projectRoot, 'src', 'index.ts'),
      "import { helper } from './helper.js';\nexport function run() { return helper() + 1; }\n",
      'utf8'
    );

    const stale = await statusData(projectRoot, { catchUp: false, now: 3_000 });
    expect(stale).toMatchObject({
      ready: false,
      graph: { freshness: 'stale', nextAction: 'run_incremental_source_graph_index' },
      lifecycle: { sourceGraphFresh: false },
    });
    expect(stale.nextActions).toContain('run_incremental_source_graph_index');
    expect(count(stale, 'fileCount')).toBeGreaterThanOrEqual(2);

    const caughtUp = await statusData(projectRoot, { now: 4_000 });
    expect(caughtUp).toMatchObject({
      ready: true,
      graph: { freshness: 'fresh' },
      lifecycle: {
        sourceGraphFresh: true,
        catchUp: {
          attempted: true,
          changedFiles: ['src/index.ts'],
          deletedFiles: [],
          succeeded: true,
        },
      },
    });
    expect(caughtUp.nextActions).toContain('source_graph_ready');
  });

  test('fails closed when the requested project scope is invalid', async () => {
    const projectRoot = join(tmpdir(), `alembic-source-graph-missing-${Date.now()}`);

    const structured = await statusData(projectRoot, { catchUp: false, now: 5_000 });

    expect(structured).toMatchObject({
      operation: 'status',
      ready: false,
      graph: { freshness: 'wrong-scope', nextAction: 'select_project_scope' },
      lifecycle: {
        runtimeReady: false,
        sourceGraphInitialized: false,
        sourceGraphFresh: false,
        databaseExists: false,
      },
    });
    expect(structured.nextActions).toContain('select_project_scope');
  });
});

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-source-graph-runtime-'));
  projectRoots.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'src', 'helper.ts'),
    'export function helper() { return 41; }\n',
    'utf8'
  );
  writeFileSync(
    join(projectRoot, 'src', 'index.ts'),
    "import { helper } from './helper.js';\nexport function run() { return helper(); }\n",
    'utf8'
  );
  return projectRoot;
}

async function statusData(
  projectRoot: string,
  args: Record<string, unknown>,
  build = buildSourceGraphStatus
): Promise<Record<string, unknown>> {
  const envelope = await build(projectRoot, args);
  expect(envelope).toMatchObject({ success: true });
  expect(envelope.data).toBeTypeOf('object');
  return envelope.data as Record<string, unknown>;
}

function guidanceToolNames(structured: Record<string, unknown>, fieldName: string): string[] {
  const guidance = structured.guidance as Record<string, unknown> | undefined;
  const value = guidance?.[fieldName];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function count(structured: Record<string, unknown>, fieldName: string): number {
  const counts = structured.counts as Record<string, unknown> | undefined;
  const value = counts?.[fieldName];
  return typeof value === 'number' ? value : 0;
}
