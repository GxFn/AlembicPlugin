import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseConnection } from '@alembic/core/database';
import { SourceGraphRepositoryImpl } from '@alembic/core/source-graph';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import { CodexMcpServer } from '../../lib/codex/mcp/CodexMcpServer.js';
import { serializeMcpToolResult } from '../../lib/codex/mcp/output-contract.js';
import {
  buildFullSourceGraphIndexForProject,
  buildSourceGraphOperation,
  buildSourceGraphStatus,
  resetSourceGraphRuntimeCacheForTests,
} from '../../lib/codex/mcp/source-graph/status.js';

const sourceGraphToolNames = [
  'alembic_source_graph_status',
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
      ...sourceGraphToolNames,
    ]);
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

  test('runs Codex source graph query tools through the Core facade', async () => {
    const projectRoot = createProject();

    const full = await statusData(projectRoot, { now: 6_000 }, (root, args) =>
      buildFullSourceGraphIndexForProject(root, args)
    );
    const generationId = graphString(full, 'generationId');
    expect(generationId).toBeTruthy();
    await resetSourceGraphRuntimeCacheForTests();
    await seedRelationEdges(projectRoot, generationId);

    const search = await operationData(projectRoot, 'alembic_symbol_search', {
      query: 'helper',
      now: 6_100,
    });
    expect(search).toMatchObject({ operation: 'search', ready: true });
    expect(symbolIds(search, 'symbols')).toContain('src/helper.ts#helper');
    expect(sourceSectionTexts(search).join('\n')).toContain('helper');

    const explore = await operationData(projectRoot, 'alembic_code_explore', {
      filePath: 'src/index.ts',
      kind: 'function',
      query: 'run',
      now: 6_200,
    });
    expect(explore).toMatchObject({ operation: 'explore', ready: true });
    expect(symbolIds(explore, 'symbols')).toContain('src/index.ts#run');

    const node = await operationData(projectRoot, 'alembic_source_node', {
      nodeId: 'src/helper.ts#helper',
      now: 6_300,
    });
    expect(node).toMatchObject({
      operation: 'node',
      ready: true,
      symbol: { symbolId: 'src/helper.ts#helper' },
    });

    const callers = await operationData(projectRoot, 'alembic_callers', {
      symbolId: 'src/helper.ts#helper',
      now: 6_400,
    });
    expect(symbolIds(callers, 'callers')).toContain('src/index.ts#run');

    const callees = await operationData(projectRoot, 'alembic_callees', {
      symbolId: 'src/index.ts#run',
      now: 6_500,
    });
    expect(symbolIds(callees, 'callees')).toContain('src/helper.ts#helper');

    const impact = await operationData(projectRoot, 'alembic_code_impact', {
      changedFiles: ['src/helper.ts'],
      now: 6_600,
    });
    expect(impact).toMatchObject({ operation: 'impact', ready: true });
    expect(stringFieldArray(impact, 'impactedFiles')).toEqual(
      expect.arrayContaining(['src/helper.ts', 'test/helper.test.ts'])
    );

    const affectedTests = await operationData(projectRoot, 'alembic_affected_tests', {
      changedFiles: ['src/index.ts'],
      now: 6_700,
    });
    expect(affectedTests).toMatchObject({
      operation: 'affected-tests',
      ready: false,
      unknownReason: expect.stringContaining('No source_graph symbol_to_test edge'),
    });
    expect(diagnosticCodes(affectedTests)).toContain('affected-tests-unknown');
  });

  test('gates source query text when Core freshness is stale', async () => {
    const projectRoot = createProject();
    await statusData(projectRoot, { now: 7_000 }, (root, args) =>
      buildFullSourceGraphIndexForProject(root, args)
    );

    writeFileSync(
      join(projectRoot, 'src', 'helper.ts'),
      'export function helper() { return 42; }\n',
      'utf8'
    );

    const stale = await operationData(projectRoot, 'alembic_symbol_search', {
      catchUp: false,
      query: 'helper',
      now: 7_100,
    });

    expect(stale).toMatchObject({
      operation: 'search',
      ready: false,
      graph: { freshness: 'stale' },
    });
    expect(sourceSectionTexts(stale)).toEqual([]);
    expect(stale.nextActions).toContain('run_incremental_source_graph_index');
  });

  test('serializes compiled CodexMcpServer calls with clean source graph outputs', async () => {
    const projectRoot = createProject();
    const full = await statusData(projectRoot, { now: 8_000 }, (root, args) =>
      buildFullSourceGraphIndexForProject(root, args)
    );
    await resetSourceGraphRuntimeCacheForTests();
    await seedRelationEdges(projectRoot, graphString(full, 'generationId'));

    const server = new CodexMcpServer({ projectRoot });
    const raw = await server.handleToolCall('alembic_symbol_search', {
      query: 'helper',
      now: 8_100,
    });
    const serialized = serializeMcpToolResult('alembic_symbol_search', raw, {
      isErrorResult: (value) =>
        !!value && typeof value === 'object' && (value as { success?: unknown }).success === false,
    });
    const structured = serialized.structuredContent as Record<string, unknown>;

    expect(structured).toMatchObject({
      ok: true,
      operation: 'search',
      ready: true,
      status: 'ready',
      toolName: 'alembic_symbol_search',
    });
    expect(structured).not.toHaveProperty('data');
    expect(structured).not.toHaveProperty('success');
    expect(JSON.stringify(structured)).not.toContain('residentService');
    expect(JSON.stringify(structured)).not.toContain(projectRoot);
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
  mkdirSync(join(projectRoot, 'test'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'test', 'helper.test.ts'),
    "import { helper } from '../src/helper.js';\nexport function helperTest() { return helper(); }\n",
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

async function operationData(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const envelope = await buildSourceGraphOperation(projectRoot, args, toolName);
  expect(envelope).toMatchObject({ success: true });
  expect(envelope.data).toBeTypeOf('object');
  return envelope.data as Record<string, unknown>;
}

async function seedRelationEdges(projectRoot: string, generationId: string): Promise<void> {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const connection = new DatabaseConnection({ path: resolver.databasePath }, resolver);
  await connection.connect();
  try {
    const repository = new SourceGraphRepositoryImpl(connection.getDrizzle());
    await repository.upsertEdge({
      generationId,
      projectRoot,
      edgeId: 'call:index-run-to-helper',
      kind: 'calls',
      fromSymbolId: 'src/index.ts#run',
      toSymbolId: 'src/helper.ts#helper',
      fromFilePath: 'src/index.ts',
      toFilePath: 'src/helper.ts',
      siteFilePath: 'src/index.ts',
      site: { startLine: 2, startColumn: 24, endLine: 2, endColumn: 32 },
      provenance: 'deterministic',
      confidence: 1,
    });
    await repository.upsertEdge({
      generationId,
      projectRoot,
      edgeId: 'test:helper-to-helper-test',
      kind: 'symbol_to_test',
      fromSymbolId: 'src/helper.ts#helper',
      fromFilePath: 'src/helper.ts',
      toFilePath: 'test/helper.test.ts',
      provenance: 'deterministic',
      confidence: 1,
    });
  } finally {
    connection.close();
  }
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

function graphString(structured: Record<string, unknown>, fieldName: string): string {
  const graph = structured.graph as Record<string, unknown> | undefined;
  const value = graph?.[fieldName];
  return typeof value === 'string' ? value : '';
}

function symbolIds(structured: Record<string, unknown>, fieldName: string): string[] {
  const value = structured[fieldName];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) =>
      item && typeof item === 'object' && 'symbolId' in item
        ? (item as { symbolId?: unknown }).symbolId
        : undefined
    )
    .filter((item): item is string => typeof item === 'string');
}

function stringFieldArray(structured: Record<string, unknown>, fieldName: string): string[] {
  const value = structured[fieldName];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sourceSectionTexts(structured: Record<string, unknown>): string[] {
  const value = structured.sourceSections;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) =>
      item && typeof item === 'object' && 'text' in item
        ? (item as { text?: unknown }).text
        : undefined
    )
    .filter((item): item is string => typeof item === 'string');
}

function diagnosticCodes(structured: Record<string, unknown>): string[] {
  const value = structured.diagnostics;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) =>
      item && typeof item === 'object' && 'code' in item
        ? (item as { code?: unknown }).code
        : undefined
    )
    .filter((item): item is string => typeof item === 'string');
}
