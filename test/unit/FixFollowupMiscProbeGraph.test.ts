import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { routeGraphTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { isErrorResult } from '../../lib/host-runtime/mcp/host/results.js';
import { serializeMcpToolResult } from '../../lib/host-runtime/mcp/output-contract.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { closeProjectIndexRelations } from '../../lib/service/project-knowledge-context/project/ProjectIndexRelations.js';

/**
 * W3e-4 回归：scripts/verify-codex-plugin-tools-local.mjs 的 graph 用例契约。
 * - host graph 用例不再要求知识库：未初始化项目上 alembic_graph 照常回答，探针断言必须成立；
 * - handler-fixture 用例直接调用 routeGraphTool，必须带请求级 projectRuntime
 *   （graph handler 通过 requireRequestProjectRuntime 读取项目身份，缺失时抛错）。
 * 这里在源码层复现探针的断言，探针本身由 Verify 阶段在重建 dist 后运行。
 */

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];
const servers: HostMcpServer[] = [];

interface Structured {
  ok?: boolean;
  status?: string;
  tool?: string;
  queryKind?: string;
  nodes: Array<{ nodeType?: string; path?: string }>;
  relations: Array<{ relationType?: string }>;
  diagnostics: Array<{ code?: string }>;
  meta?: { outputSchema?: string };
}

beforeEach(() => {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-probe-graph-home-'));
  createdRoots.push(process.env.ALEMBIC_HOME);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.shutdown();
  }
  closeProjectIndexRelations();
  resetServiceContainer();
  await resetPluginOwnedMcpServerForTests();
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('W3e-4: probe graph cases hold without project knowledge', () => {
  test('handler fixture without projectRuntime fails (the stale probe shape)', async () => {
    const fixtureRoot = makeFixtureProject();
    const ctx = {
      container: { get: () => undefined, singletons: { _projectRoot: fixtureRoot } },
    } as unknown as McpContext;

    await expect(
      routeGraphTool(ctx, {
        projectRoot: fixtureRoot,
        queryKind: 'file-symbols',
        filePath: 'lib/index.ts',
      })
    ).rejects.toThrow(/ProjectRuntimeContext is required/);
  });

  test('handler fixture with a request projectRuntime satisfies the probe assertions', async () => {
    const fixtureRoot = makeFixtureProject();
    const ctx = fixtureContext(fixtureRoot);

    const symbols = normalize(
      'alembic_graph',
      await routeGraphTool(ctx, {
        projectRoot: fixtureRoot,
        queryKind: 'file-symbols',
        filePath: 'lib/index.ts',
        budget: { itemLimit: 40, relationHopLimit: 4 },
      })
    );
    expectGraphBase(symbols, 'file-symbols', 'ready');
    expect(symbols.diagnostics).toEqual([]);
    expect(symbols.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);

    const fastFail = normalize(
      'alembic_graph',
      await routeGraphTool(fixtureContext(fixtureRoot), {
        projectRoot: fixtureRoot,
        queryKind: 'impact',
      })
    );
    expectGraphBase(fastFail, 'impact', 'partial');
    expect(fastFail.diagnostics.map((item) => item.code)).toContain(
      'project-graph-anchor-required'
    );
    expect(fastFail.nodes).toEqual([]);
  }, 60_000);

  test('host alembic_graph on an uninitialized project satisfies the host graph assertions', async () => {
    const projectRoot = makeFixtureProject();
    const server = new HostMcpServer({ projectRoot });
    servers.push(server);
    const status = (await server.handleToolCall('alembic_status', {})) as {
      data?: { initialized?: boolean };
    };
    expect(status.data?.initialized).toBe(false);

    const raw = await server.handleToolCall('alembic_graph', {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
      budget: { itemLimit: 80, relationHopLimit: 4 },
    });
    expect(isErrorResult(raw)).toBe(false);
    const symbols = normalize('alembic_graph', raw);
    expectGraphBase(symbols, 'file-symbols', 'ready');
    expect(symbols.diagnostics).toEqual([]);
    expect(
      symbols.nodes.some((node) => node.nodeType === 'file' && node.path === 'lib/index.ts')
    ).toBe(true);
    expect(symbols.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);
    expect(symbols.relations.some((relation) => relation.relationType === 'definesSymbol')).toBe(
      true
    );

    const missingAnchor = normalize(
      'alembic_graph',
      await server.handleToolCall('alembic_graph', { queryKind: 'impact' })
    );
    expectGraphBase(missingAnchor, 'impact', 'partial');
    expect(missingAnchor.diagnostics.map((item) => item.code)).toContain(
      'project-graph-anchor-required'
    );
  }, 60_000);
});

function expectGraphBase(structured: Structured, queryKind: string, status: string): void {
  expect(structured.tool).toBe('alembic_graph');
  expect(structured.queryKind).toBe(queryKind);
  expect(structured.status).toBe(status);
  expect(Array.isArray(structured.nodes)).toBe(true);
  expect(Array.isArray(structured.relations)).toBe(true);
  expect(Array.isArray(structured.diagnostics)).toBe(true);
  expect(structured.meta?.outputSchema).toBe('AlembicGraphOutput');
}

/** 与探针 normalizeToolResult 同口径：已序列化结果直接取 structuredContent，否则先序列化。 */
function normalize(toolName: string, raw: unknown): Structured {
  const record = raw as { content?: unknown; structuredContent?: unknown };
  const result =
    record && Array.isArray(record.content) && record.structuredContent
      ? record
      : (serializeMcpToolResult(toolName, raw, { isErrorResult }) as {
          structuredContent?: unknown;
        });
  return result.structuredContent as Structured;
}

function fixtureContext(fixtureRoot: string): McpContext {
  return {
    container: { get: () => undefined, singletons: { _projectRoot: fixtureRoot } },
    projectRuntime: buildProjectRuntimeContext({ projectRoot: fixtureRoot }),
  } as unknown as McpContext;
}

/** 与探针 createGraphFixtureProject 相同的最小 TS 项目。 */
function makeFixtureProject(): string {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-probe-graph-fixture-'))
  );
  createdRoots.push(fixtureRoot);
  fs.mkdirSync(path.join(fixtureRoot, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ name: 'local-plugin-tools-fixture', main: 'lib/index.ts', type: 'module' }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'lib', 'helper.ts'),
    'export function helper(value: string) { return value.toUpperCase(); }\n'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'lib', 'index.ts'),
    [
      'import { helper } from "./helper";',
      '',
      'export class Runner {',
      '  run(input: string) {',
      '    return helper(input);',
      '  }',
      '}',
      '',
      'export function runFixture() {',
      '  return new Runner().run("ok");',
      '}',
      '',
    ].join('\n')
  );
  return fixtureRoot;
}
