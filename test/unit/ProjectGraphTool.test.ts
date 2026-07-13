import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { routeGraphTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { ALEMBIC_GRAPH_QUERY_KINDS } from '../../lib/service/project-knowledge-context/contracts/AlembicGraphOutput.js';
import {
  defaultProjectGraphProvider,
  executeWithProjectContextRepoDeadline,
  resolveExistingGraphModulePath,
} from '../../lib/service/project-knowledge-context/project/ProjectGraphProvider.js';
import { ProjectContextBuildSessionManager } from '../../lib/service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { GRAPH_QUERY_KINDS, GraphInput } from '../../lib/shared/schemas/mcp-tools.js';

const tempRoots: string[] = [];
let previousAlembicHome: string | undefined;

// The 9 queryKinds that map 1:1 onto ProjectContext request classes.
const PROJECT_CONTEXT_QUERY_KINDS = [
  'space',
  'repo',
  'map',
  'module',
  'module-layers',
  'file-flow',
  'file-symbols',
  'source-slice',
  'anchor-range',
] as const;

const FILE_SCOPED_QUERY_KINDS = new Set([
  'file-flow',
  'file-symbols',
  'source-slice',
  'anchor-range',
]);

const ALLOWED_NODE_TYPES = new Set([
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
]);

type GraphResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: GraphOutput;
};
interface GraphOutput {
  ok: boolean;
  status: string;
  tool: string;
  queryKind: string;
  summary: string;
  continuation?: { nextCursor: string | null };
  project: Record<string, unknown>;
  repoCoverage: {
    discoveredRepoIds: string[];
    failedRepoIds: string[];
    omittedRepoIds: string[];
    requested: number;
    attempted: number;
    succeeded: number;
    failed: number;
    omitted: number;
    completeness: string;
  };
  nodes: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  refs: Array<Record<string, unknown>>;
  slices?: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  nextActions: Array<Record<string, unknown>>;
  limits: { truncated: boolean; itemLimit: number; refLimit: number; relationLimit: number };
  meta: Record<string, unknown>;
}

function projectContextRequestKinds(output: GraphOutput): string[] {
  const projectContext = output.meta.projectContext as { requestKinds?: unknown } | undefined;
  return Array.isArray(projectContext?.requestKinds)
    ? projectContext.requestKinds.map((kind) => String(kind))
    : [];
}

function graphStableKeys(output: GraphOutput): string[] {
  return [
    ...output.nodes.map((node) => `node:${String(node.id)}`),
    ...output.relations.map(
      (relation) =>
        `relation:${String(relation.fromId)}\0${String(relation.relationType)}\0${String(relation.toId)}`
    ),
    ...output.refs.map((ref) => `ref:${String(ref.id)}`),
    ...(output.slices ?? []).map(
      (slice) =>
        `slice:${String(slice.refId ?? '')}\0${String(slice.filePath)}\0${JSON.stringify(slice.range)}`
    ),
  ];
}

async function runGraph(projectRoot: string, args: Record<string, unknown>): Promise<GraphOutput> {
  const result = (await routeGraphTool(createContext(projectRoot), {
    projectRoot,
    ...args,
  })) as GraphResult;
  // Visible MCP text must be the summary only.
  expect(result.content).toEqual([{ type: 'text', text: result.structuredContent.summary }]);
  return result.structuredContent;
}

describe('alembic_graph project graph tool (queryKind / AlembicGraphOutput)', () => {
  beforeEach(() => {
    previousAlembicHome = process.env.ALEMBIC_HOME;
  });

  afterEach(() => {
    if (previousAlembicHome === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = previousAlembicHome;
    }
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('public queryKind enum matches the service AlembicGraphOutput enum', () => {
    expect([...GRAPH_QUERY_KINDS]).toEqual([...ALEMBIC_GRAPH_QUERY_KINDS]);
    // 9 ProjectContext kinds + 4 derived traversals.
    expect(GRAPH_QUERY_KINDS).toHaveLength(13);
  });

  test('answers every ProjectContext queryKind with bounded, Recipe-free output', async () => {
    const projectRoot = createFixtureProject();
    for (const queryKind of PROJECT_CONTEXT_QUERY_KINDS) {
      const args: Record<string, unknown> = {
        queryKind,
        budget: { itemLimit: 50, relationHopLimit: 4 },
      };
      if (FILE_SCOPED_QUERY_KINDS.has(queryKind)) {
        args.filePath = 'lib/index.ts';
      }
      const output = await runGraph(projectRoot, args);

      expect(output).toMatchObject({
        ok: true,
        tool: 'alembic_graph',
        toolName: 'alembic_graph',
        queryKind,
        meta: {
          outputSchema: 'AlembicGraphOutput',
          contractVersion: 1,
          sourceOfTruth: false,
          callClaimsRequireSourceVerification: true,
        },
      });
      expect(['ready', 'partial', 'degraded']).toContain(output.status);

      // Bounded.
      expect(output.nodes.length).toBeLessThanOrEqual(output.limits.itemLimit);
      expect(output.refs.length).toBeLessThanOrEqual(output.limits.refLimit);
      expect(output.relations.length).toBeLessThanOrEqual(output.limits.relationLimit);

      // Detached from the KnowledgeContext middle-layer envelope: graph has its
      // own AlembicGraphOutput schema, with no KnowledgeContextToolOutput
      // `result`/`inventory` bag.
      expect(output).not.toHaveProperty('result');
      expect(output).not.toHaveProperty('inventory');
      expect(output.meta.outputSchema).not.toBe('KnowledgeContextToolOutput');

      // Recipe-free.
      const serialized = JSON.stringify(output).toLowerCase();
      expect(serialized).not.toContain('recipe');
      expect(serialized).not.toContain('coveredbyknowledge');
      expect(serialized).not.toContain('relationchain');
      expect(serialized).not.toContain('mount');
      expect(serialized).not.toContain('scorebreakdown');

      for (const node of output.nodes) {
        expect(ALLOWED_NODE_TYPES).toContain(node.nodeType);
        expect(node).not.toHaveProperty('recipeId');
      }
    }
  });

  test('stats summarizes bounded project graph counts', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'stats',
      budget: { itemLimit: 100, relationHopLimit: 10 },
    });
    expect(output.status).toBe('ready');
    expect(output.queryKind).toBe('stats');
    expect(output.nodes.length).toBeGreaterThan(0);
    expect(output.project).toMatchObject({ displayName: 'fixture-project' });
    expect(JSON.stringify(output.nodes)).not.toContain('recipe');
  });

  test('map and space return ProjectContext orientation nodes', async () => {
    const projectRoot = createFixtureProject();
    const map = await runGraph(projectRoot, { queryKind: 'map' });
    expect(map.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['project:fixture-project'])
    );
    const space = await runGraph(projectRoot, { queryKind: 'space' });
    // P-D D2(2026-07-11):space 区域扩容 target/module——非 node 项目(SPM)的真实
    // 挂载锚在 target/module 节点,旧集只许 project/package 使 recipe_map 恒 0 mounts。
    expect(
      space.nodes.every((node) =>
        ['project', 'package', 'target', 'module'].includes(String(node.nodeType))
      )
    ).toBe(true);
  });

  test('file-symbols exposes ProjectContext file + symbol nodes', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
    });
    const nodeTypes = new Set(output.nodes.map((node) => node.nodeType));
    expect(nodeTypes.has('file')).toBe(true);
    expect(output.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);
    expect(JSON.stringify(output)).not.toContain('recipe');
  });

  test('file-flow keeps call claims verification-bound to focused source', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-flow',
      filePath: 'lib/index.ts',
    });
    expect(output.meta).toMatchObject({
      sourceOfTruth: false,
      callClaimsRequireSourceVerification: true,
      projectContext: { suppressedErrorCount: expect.any(Number) },
    });
    expect(output.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queryKind: 'source-slice', required: true }),
      ])
    );
  });

  test('symbolName narrows file-symbols without silently returning sibling symbols', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
      symbolName: 'run',
    });
    const symbols = output.nodes.filter((node) => node.nodeType === 'symbol');
    expect(symbols.map((node) => node.label)).toEqual(['run']);
  });

  test('file-scoped queryKinds keep ProjectContext collection focused on the anchor', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
      budget: { itemLimit: 40, relationHopLimit: 4 },
    });
    expect(output.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);

    const requestKinds = projectContextRequestKinds(output);
    expect(requestKinds).toEqual(['file-symbols']);
    expect(requestKinds).not.toContain('space');
    expect(requestKinds).not.toContain('repo');
    expect(requestKinds).not.toContain('map');
    expect(requestKinds).not.toContain('module');
    expect(requestKinds).not.toContain('module-layers');
    expect(requestKinds).not.toContain('file-flow');
    expect(requestKinds).not.toContain('source-slice');
    expect(requestKinds).not.toContain('anchor-range');
  });

  test('file-scoped queryKinds avoid unrelated broad repo scan limit diagnostics', async () => {
    const projectRoot = createLargeFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
      budget: { itemLimit: 40, relationHopLimit: 4 },
    });
    expect(output.nodes.some((node) => node.nodeType === 'symbol')).toBe(true);
    expect(output.status).toBe('ready');
    expect(output.meta.projectContext?.suppressedErrorCount ?? 0).toBe(0);
    expect(JSON.stringify(output.diagnostics)).not.toContain('repo source file collection');
  });

  test('source-slice returns bounded ProjectContext source slices', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'source-slice',
      filePath: 'lib/index.ts',
    });
    expect(output.status).toBe('ready');
    expect(output.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeType: 'file', path: 'lib/index.ts' })])
    );
    expect(output.diagnostics).toEqual([]);
    expect(Array.isArray(output.slices)).toBe(true);
    expect((output.slices ?? []).length).toBeGreaterThan(0);
    for (const slice of output.slices ?? []) {
      expect(slice).toHaveProperty('filePath', 'lib/index.ts');
      expect(slice).toHaveProperty('range');
    }
  });

  test('derived impact traversal withholds output until a concrete ProjectContext anchor is supplied', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'impact',
      query: 'what changes if I touch this',
    });
    expect(output.nodes).toEqual([]);
    expect(output.relations).toEqual([]);
    expect(output.status).toBe('partial');
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-anchor-required'
    );
    expect(output.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_graph', queryKind: 'map', required: true }),
      ])
    );
  });

  test('missing-anchor graph requests fast-fail before ProjectContext execution', async () => {
    const projectRoot = createFixtureProject();
    const impact = await runGraph(projectRoot, { queryKind: 'impact' });
    expect(impact.status).toBe('partial');
    expect(impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-anchor-required'
    );

    const pathOutput = await runGraph(projectRoot, { queryKind: 'path', fromRefId: 'module:lib' });
    expect(pathOutput.status).toBe('partial');
    expect(pathOutput.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-path-anchor-required'
    );

    const fileSymbols = await runGraph(projectRoot, { queryKind: 'file-symbols' });
    expect(fileSymbols.status).toBe('partial');
    expect(fileSymbols.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-file-anchor-required'
    );

    expect(projectContextRequestKinds(impact)).toEqual([]);
    expect(projectContextRequestKinds(pathOutput)).toEqual([]);
    expect(projectContextRequestKinds(fileSymbols)).toEqual([]);
  });

  test('derived impact traversal runs from a resolved ProjectContext ref', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'impact',
      refId: 'file:lib/index.ts',
      budget: { itemLimit: 20, relationHopLimit: 4 },
    });
    expect(output.nodes.some((node) => node.id === 'file:lib/index.ts')).toBe(true);
    expect(output.relations.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).not.toContain('recipe');
  });

  test('file-scoped queryKind without an anchor returns a graph diagnostic, not a fallback', async () => {
    const projectRoot = createFixtureProject();
    const output = await runGraph(projectRoot, { queryKind: 'file-symbols' });
    expect(output.nodes).toEqual([]);
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-graph-file-anchor-required'
    );
    expect(output.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'alembic_graph', queryKind: 'map', required: true }),
      ])
    );
  });

  test('legacy operation is normalized onto queryKind without a second behavior branch', async () => {
    const projectRoot = createFixtureProject();
    // Stale operation, no queryKind → normalized.
    expect((await runGraph(projectRoot, { operation: 'stats' })).queryKind).toBe('stats');
    expect(
      (await runGraph(projectRoot, { operation: 'impact', refId: 'file:lib/index.ts' })).queryKind
    ).toBe('impact');
    expect((await runGraph(projectRoot, { operation: 'query' })).queryKind).toBe('map');
    // Explicit queryKind always wins over a stale operation alias.
    expect(
      (await runGraph(projectRoot, { queryKind: 'space', operation: 'stats' })).queryKind
    ).toBe('space');
  });

  test('rejects legacy Recipe graph input at the public schema boundary', () => {
    expect(GraphInput.safeParse({ nodeType: 'recipe' }).success).toBe(false);
    expect(GraphInput.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
    expect(GraphInput.safeParse({ relation: 'hasGap' }).success).toBe(false);
    expect(GraphInput.safeParse({ queryKind: 'recipe' }).success).toBe(false);
    expect(GraphInput.safeParse({ queryKind: 'coverage' }).success).toBe(false);
    // Valid new contract parses.
    expect(
      GraphInput.safeParse({ queryKind: 'source-slice', filePath: 'lib/index.ts' }).success
    ).toBe(true);
  });

  test('keeps alembic_graph on the ProjectContext direct boundary and off the middle layer', () => {
    const providerSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'lib/service/project-knowledge-context/project/ProjectGraphProvider.ts'
      ),
      'utf8'
    );
    expect(providerSource).toContain('ProjectContextCapabilities.execute');
    expect(providerSource).toContain('ProjectContextProjectGraphProvider');
    expect(providerSource).toContain('resolveAlembicGraph');
    expect(providerSource).not.toContain('walkProject');
    expect(providerSource).not.toContain('fs.readFileSync');

    const handlerSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/host-runtime/mcp/handlers/structure.ts'),
      'utf8'
    );
    // graph output no longer routes through the KnowledgeContext middle layer.
    expect(handlerSource).not.toContain('resolveMcpResult');
    expect(handlerSource).toContain('resolveAlembicGraph');
    expect(handlerSource).toContain('createAlembicGraphMcpResult');
  });

  test('returns a live first page while a later repository is still running and reconstructs terminal IDs', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    for (let index = 0; index < 400; index += 1) {
      writeFile(
        projectRoot,
        `AlembicAgent/src/slow-${String(index).padStart(3, '0')}.ts`,
        `export const slow${index} = ${index};\n`
      );
    }
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const ctx = createContext(projectRoot);
    ctx.projectContextExecution = { buildSessions: manager };
    try {
      const first = (await routeGraphTool(ctx, {
        pageSize: 1,
        projectRoot,
        queryKind: 'map',
      })) as GraphResult;
      expect(first.structuredContent.status).toBe('partial');
      expect(first.structuredContent.repoCoverage.requested).toBe(5);
      expect(first.structuredContent.repoCoverage.attempted).toBeGreaterThanOrEqual(1);
      expect(first.structuredContent.repoCoverage.attempted).toBeLessThan(
        first.structuredContent.repoCoverage.requested
      );
      expect(first.structuredContent.refs.some((ref) => ref.kind === 'repo')).toBe(true);

      const reconstructedKeys = graphStableKeys(first.structuredContent);
      let terminal = first.structuredContent;
      let cursor = first.structuredContent.continuation?.nextCursor;
      while (cursor) {
        const next = (await routeGraphTool(ctx, { cursor, projectRoot })) as GraphResult;
        terminal = next.structuredContent;
        reconstructedKeys.push(...graphStableKeys(next.structuredContent));
        cursor = next.structuredContent.continuation?.nextCursor;
      }
      expect(terminal.repoCoverage).toMatchObject({
        attempted: 5,
        completeness: 'complete',
        failed: 0,
        requested: 5,
        succeeded: 5,
      });
      const finalOutput = await defaultProjectGraphProvider.resolveAlembicGraph(
        { projectRoot, queryKind: 'map' },
        { buildSessions: manager }
      );
      expect(new Set(reconstructedKeys).size).toBe(reconstructedKeys.length);
      expect([...reconstructedKeys].sort()).toEqual(
        graphStableKeys(finalOutput as GraphOutput).sort()
      );
      expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  test('repo deadline aborts its child worker and waits for cleanup acknowledgement', async () => {
    let workerAborted = false;
    let workerSettled = false;
    const startedAt = Date.now();
    await expect(
      executeWithProjectContextRepoDeadline({
        cleanupTimeoutMs: 100,
        repoId: 'slow-repo',
        timeoutMs: 10,
        execute: (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                workerAborted = true;
                setTimeout(() => {
                  workerSettled = true;
                  reject(signal.reason);
                }, 15);
              },
              { once: true }
            );
          }),
      })
    ).rejects.toThrow('repo request exceeded 10ms for slow-repo');
    expect(workerAborted).toBe(true);
    expect(workerSettled).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  test('uses native ProjectScope registry as the default graph boundary', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'stats',
      budget: { itemLimit: 200, relationHopLimit: 10 },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).toContain('AlembicPlugin/lib/index.ts');
    expect(serialized).toContain('AlembicCore/src/index.ts');
    expect(serialized).toContain('AlembicDashboard');
    expect(serialized).toContain('AlembicAgent');
    expect(serialized).not.toContain('Test');
    expect(serialized).not.toContain('wakeflow-ledger');
    expect(serialized).not.toContain('legacy-docs-do-not-use');
    expect(output.repoCoverage).toMatchObject({
      requested: 5,
      attempted: 5,
      succeeded: 5,
      failed: 0,
      omitted: 0,
      completeness: 'complete',
      failedRepoIds: [],
      omittedRepoIds: [],
    });
    expect(output.repoCoverage.discoveredRepoIds).toEqual(
      expect.arrayContaining([
        'Alembic',
        'AlembicCore',
        'AlembicPlugin',
        'AlembicDashboard',
        'AlembicAgent',
      ])
    );
  });

  test('does not let a fixed repo file cap turn a discovered ProjectScope repository into failure', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    for (let index = 0; index < 260; index += 1) {
      writeFile(
        projectRoot,
        `Alembic/src/high-volume-${String(index).padStart(3, '0')}.ts`,
        `export const highVolume${index} = ${index};\n`
      );
    }

    const output = await runGraph(projectRoot, {
      queryKind: 'space',
      budget: { itemLimit: 500, relationHopLimit: 10 },
    });

    expect(output.repoCoverage).toMatchObject({
      requested: 5,
      attempted: 5,
      succeeded: 5,
      failed: 0,
      omitted: 0,
      completeness: 'complete',
    });
    expect(JSON.stringify(output.diagnostics)).not.toContain(
      'repo source file collection was truncated'
    );
    expect(JSON.stringify(output.diagnostics)).not.toContain(
      'parser is unavailable for language json'
    );
    expect(
      Number((output.meta.projectContext as { suppressedErrorCount?: number }).suppressedErrorCount)
    ).toBeGreaterThan(0);
  });

  test('discovers a single-root project plus every initialized Git submodule as repo coverage', async () => {
    const projectRoot = createGitSubmoduleFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'space',
      budget: { itemLimit: 500, relationHopLimit: 10 },
    });

    expect(output.repoCoverage).toMatchObject({
      requested: 5,
      attempted: 5,
      succeeded: 5,
      failed: 0,
      omitted: 0,
      completeness: 'complete',
    });
    expect(output.repoCoverage.discoveredRepoIds).toEqual(
      expect.arrayContaining([
        path.basename(projectRoot),
        'Packages/Foundation',
        'Packages/Network',
        'Packages/Player',
        'Packages/UI',
      ])
    );
  });

  test('keeps duplicate package and target labels distinct across repositories', async () => {
    const projectRoot = createDuplicateIdentityWorkspaceFixture();
    const output = await runGraph(projectRoot, {
      queryKind: 'stats',
      budget: { itemLimit: 200, relationHopLimit: 10 },
    });
    const duplicatePackages = output.nodes.filter(
      (node) => node.nodeType === 'package' && node.label === '@fixture/duplicate'
    );
    const duplicateTargets = output.nodes.filter(
      (node) => node.nodeType === 'target' && node.label === 'script:build'
    );
    expect(duplicatePackages).toHaveLength(2);
    expect(new Set(duplicatePackages.map((node) => node.id)).size).toBe(2);
    expect(duplicateTargets).toHaveLength(2);
    expect(new Set(duplicateTargets.map((node) => node.id)).size).toBe(2);
    for (const target of duplicateTargets) {
      expect(
        output.relations.some(
          (relation) =>
            relation.fromId === target.id &&
            relation.relationType === 'partOf' &&
            duplicatePackages.some((pkg) => pkg.id === relation.toId)
        )
      ).toBe(true);
    }
  });

  test('answers workspace-root file queries for deep sub-repository files', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    const filePath = 'AlembicPlugin/lib/host-runtime/mcp/handlers/agent-public-tools.ts';

    const symbols = await runGraph(projectRoot, {
      queryKind: 'file-symbols',
      filePath,
      budget: { itemLimit: 80, relationHopLimit: 10 },
    });
    expect(symbols.status).toBe('ready');
    expect(symbols.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeType: 'file', path: filePath }),
        expect.objectContaining({ nodeType: 'symbol', label: 'AgentPrimeArgs', path: filePath }),
        expect.objectContaining({ nodeType: 'symbol', label: 'primeHandler', path: filePath }),
      ])
    );
    expect(symbols.refs).toEqual(expect.arrayContaining([expect.objectContaining({ filePath })]));
    expect(JSON.stringify(symbols.diagnostics)).not.toContain('parser failed');

    const slice = await runGraph(projectRoot, {
      queryKind: 'source-slice',
      filePath,
      line: 5,
      radius: { beforeLines: 1, afterLines: 1 },
      budget: { itemLimit: 20, relationHopLimit: 4 },
    });
    expect(slice.status).toBe('ready');
    expect(slice.slices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath,
          range: expect.objectContaining({ startLine: 4, endLine: 6 }),
        }),
      ])
    );
    expect(JSON.stringify(slice.slices)).toContain('AgentPrimeArgs');
    expect(JSON.stringify(slice.diagnostics)).not.toContain('file was not found');
  });

  test('enriches real workspace file neighborhoods with ProjectContext ownership relations', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'neighborhood',
      refId: 'file:AlembicCore/src/index.ts',
      relationType: 'partOf',
      radius: { maxDepth: 1 },
      budget: { itemLimit: 20, relationHopLimit: 10 },
    });
    expect(output.queryKind).toBe('neighborhood');
    expect(output.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: 'file:alembiccore/src/index.ts',
          relationType: 'partOf',
          toId: 'directory:alembiccore/src',
        }),
        expect.objectContaining({
          fromId: 'file:alembiccore/src/index.ts',
          relationType: 'partOf',
          toType: 'package',
        }),
      ])
    );
    expect(JSON.stringify(output.diagnostics)).not.toContain('project-graph-relation-unavailable');
  });

  test('suppresses generated artifact paths in default ProjectContext graph probes', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'map',
      query: 'ProjectContext generated artifact dist build declaration vendor file-flow',
      budget: { itemLimit: 80, relationHopLimit: 8 },
    });
    const visibleOutput = JSON.stringify({
      nodes: output.nodes,
      relations: output.relations,
      refs: output.refs,
    }).toLowerCase();
    expect(visibleOutput).not.toContain('/dist/');
    expect(visibleOutput).not.toContain('/build/');
    expect(visibleOutput).not.toContain('/vendor/');
    expect(visibleOutput).not.toContain('.d.ts');
  });

  test('normalizes CamelCase identifiers and keeps specific multi-term matches above request noise', async () => {
    const projectRoot = createFixtureProject();
    writeFile(
      projectRoot,
      'lib/HostMcpServer.ts',
      'export class HostMcpServer { handleRequest() { return true; } }\n'
    );
    writeFile(
      projectRoot,
      'lib/ProjectLocationService.ts',
      'export class ProjectLocationService { resolveRequestRoot() { return "."; } }\n'
    );
    writeFile(
      projectRoot,
      'lib/RequestLogger.ts',
      'export class RequestLogger { request() { return "request"; } }\n'
    );

    const output = await runGraph(projectRoot, {
      queryKind: 'map',
      query: 'HostMcpServer ProjectLocationService request',
      budget: { itemLimit: 6, relationHopLimit: 4 },
    });
    const topPaths = output.nodes.slice(0, 4).map((node) => String(node.path ?? node.label));
    expect(topPaths.some((value) => value.includes('HostMcpServer'))).toBe(true);
    expect(topPaths.some((value) => value.includes('ProjectLocationService'))).toBe(true);
    expect(output.nodes[0]?.queryMatchedTerms).toEqual(
      expect.arrayContaining(['host', 'mcp', 'server'])
    );
    expect(String(output.nodes[0]?.path ?? output.nodes[0]?.label)).not.toContain('RequestLogger');
  });

  test('ranks exact multi-repo file-flow candidates before the bounded target cap', async () => {
    const projectRoot = createNativeScopeWorkspaceFixtureProject();
    const hostPath = 'AlembicPlugin/lib/host-runtime/mcp/HostMcpServer.ts';
    const locationPath = 'AlembicPlugin/lib/host-runtime/context/ProjectLocationService.ts';
    writeFile(
      projectRoot,
      hostPath,
      [
        'import { ProjectLocationService } from "../context/ProjectLocationService";',
        'export class HostMcpServer { handleRequest() { return true; } }',
        'export const projectLocationServiceType = ProjectLocationService;',
        ...Array.from(
          { length: 28 },
          (_, index) => `export function hostRequestHelper${index}() { return ${index}; }`
        ),
        '',
      ].join('\n')
    );
    writeFile(
      projectRoot,
      locationPath,
      [
        'import { HostMcpServer } from "../mcp/HostMcpServer";',
        'export class ProjectLocationService { resolveRequestRoot() { return "."; } }',
        'export const hostMcpServerType = HostMcpServer;',
        '',
      ].join('\n')
    );
    // These weak one-term candidates sort before the exact files lexically and exceed the
    // existing default file-flow cap. The cap must apply after query-quality ranking.
    for (let index = 0; index < 90; index += 1) {
      writeFile(
        projectRoot,
        `AlembicPlugin/lib/host-runtime/a-request-noise-${String(index).padStart(3, '0')}.ts`,
        `export const requestNoise${index} = "request";\n`
      );
    }
    for (let index = 0; index < 24; index += 1) {
      writeFile(
        projectRoot,
        `Alembic/src/a-service-noise-${String(index).padStart(3, '0')}.ts`,
        `export const serviceNoise${index} = "service";\n`
      );
    }

    const output = await runGraph(projectRoot, {
      queryKind: 'map',
      query: 'HostMcpServer ProjectLocationService request',
      budget: { itemLimit: 12, relationHopLimit: 4 },
    });
    const exactNodes = output.nodes.filter((node) =>
      [hostPath, locationPath].includes(String(node.path ?? ''))
    );

    expect(output.repoCoverage).toMatchObject({ completeness: 'complete', requested: 5 });
    expect(
      exactNodes,
      JSON.stringify({ meta: output.meta.projectContext, nodes: output.nodes }, null, 2)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeType: 'file', path: hostPath }),
        expect.objectContaining({ nodeType: 'symbol', path: hostPath, label: 'HostMcpServer' }),
        expect.objectContaining({ nodeType: 'file', path: locationPath }),
        expect.objectContaining({
          nodeType: 'symbol',
          path: locationPath,
          label: 'ProjectLocationService',
        }),
      ])
    );
    expect(
      output.nodes.filter((node) => String(node.path ?? '').includes('a-request-noise')).length
    ).toBeLessThan(exactNodes.length);
    expect(JSON.stringify(output.diagnostics)).not.toMatch(/cyclic|invalid-scope/i);
  });

  test('finds exact SwiftPM target files before weak app/module probes and reserves both identifiers', async () => {
    const projectRoot = createSwiftPackageGraphFixtureProject();
    const videoGatePath = 'Sources/BDVideoPlay/Generation/VideoPlayLoadGenerationGate.swift';
    const homeGatePath = 'Sources/BDHome/Refresh/HomeRequestRefreshGate.swift';

    const output = await runGraph(projectRoot, {
      queryKind: 'map',
      query: 'VideoPlayLoadGenerationGate HomeRequestRefreshGate request',
      budget: { itemLimit: 18, relationHopLimit: 4 },
    });
    const exactNodes = output.nodes.filter((node) =>
      [videoGatePath, homeGatePath].includes(String(node.path ?? ''))
    );

    expect(
      exactNodes,
      JSON.stringify({ meta: output.meta.projectContext, nodes: output.nodes }, null, 2)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeType: 'file', path: videoGatePath }),
        expect.objectContaining({
          nodeType: 'symbol',
          path: videoGatePath,
          label: 'VideoPlayLoadGenerationGate',
        }),
        expect.objectContaining({ nodeType: 'file', path: homeGatePath }),
        expect.objectContaining({
          nodeType: 'symbol',
          path: homeGatePath,
          label: 'HomeRequestRefreshGate',
        }),
      ])
    );
    expect(
      output.nodes.filter((node) => String(node.path ?? '').includes('AOXPlayer')).length
    ).toBeLessThan(exactNodes.length);
    expect(JSON.stringify(output.diagnostics)).not.toMatch(/cyclic|invalid-scope/i);
  });

  test('nested SwiftPM module probes use only existing canonical project paths', async () => {
    const projectRoot = createNestedSwiftPackageGraphFixtureProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'map',
      budget: { itemLimit: 24, relationHopLimit: 4 },
    });

    expect(output.repoCoverage).toMatchObject({ completeness: 'complete', failed: 0 });
    expect(JSON.stringify(output.diagnostics)).not.toMatch(/invalid-scope/i);
    for (const node of output.nodes) {
      const nodePath = typeof node.path === 'string' ? node.path : undefined;
      if (nodePath?.startsWith('Packages/AOXUIKit/')) {
        expect(fs.existsSync(path.join(projectRoot, nodePath))).toBe(true);
      }
    }
  });

  test('module seed reconciliation canonicalizes case and rejects nonexistent paths', async () => {
    const projectRoot = createNestedSwiftPackageGraphFixtureProject();
    expect(
      await resolveExistingGraphModulePath(projectRoot, 'Packages/AOXUIKit/sources/aoxuikit')
    ).toBe('Packages/AOXUIKit/Sources/AOXUIKit');
    expect(
      await resolveExistingGraphModulePath(
        projectRoot,
        'Packages/AOXUIKit/Packages/AOXUIKit/Sources/AOXUIKit'
      )
    ).toBeUndefined();
  });
});

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-project',
        main: 'lib/index.ts',
        scripts: { build: 'tsc -p tsconfig.json' },
        dependencies: { zod: '^3.0.0' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'helper.ts'),
    'export function helper() { return "ok"; }\n'
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'index.ts'),
    'import { helper } from "./helper";\nexport const sibling = true;\nexport function run() { return helper(); }\n'
  );
  return root;
}

function createLargeFixtureProject(): string {
  const root = createFixtureProject();
  for (let index = 0; index < 260; index += 1) {
    writeFile(
      root,
      `lib/generated/noise-${String(index).padStart(3, '0')}.ts`,
      'export const noise = true;\n'
    );
  }
  return root;
}

function createNativeScopeWorkspaceFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-native-scope-fixture-'));
  tempRoots.push(root);
  process.env.ALEMBIC_HOME = root;
  writeWorkspaceCoreFixture(root);
  writeWorkspacePluginFixture(root);
  writeNativeGraphMemberFixture(root, 'Alembic', 'src/index.ts');
  writeNativeGraphMemberFixture(root, 'AlembicDashboard', 'src/dashboard.tsx');
  writeFile(root, 'AlembicDashboard/config/naming-lint.json', '{"rules":[]}\n');
  writeNativeGraphMemberFixture(root, 'AlembicAgent', 'src/agent.ts');
  writeWorkspaceNoiseBoundaryFixture(root);
  writeNativeGraphProjectScope(root);
  return root;
}

function createSwiftPackageGraphFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-swift-package-fixture-'));
  tempRoots.push(root);
  writeFile(
    root,
    'Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(',
      '  name: "BiliDili",',
      '  products: [.library(name: "BiliDili", targets: ["BDVideoPlay", "BDHome"])],',
      '  targets: [',
      '    .target(name: "AOXPlayer", path: "Sources/AOXPlayer"),',
      '    .target(name: "BDVideoPlay", path: "Sources/BDVideoPlay"),',
      '    .target(name: "BDHome", path: "Sources/BDHome"),',
      '  ]',
      ')',
      '',
    ].join('\n')
  );
  writeFile(root, 'BiliDili/AppDelegate.swift', 'final class AppDelegate {}\n');
  for (let index = 0; index < 36; index += 1) {
    writeFile(
      root,
      `Sources/AOXPlayer/VideoPlayLoadRequest${String(index).padStart(2, '0')}.swift`,
      `public struct VideoPlayLoadRequest${index} { public init() {} }\n`
    );
  }
  writeFile(
    root,
    'Sources/BDVideoPlay/Generation/VideoPlayLoadGenerationGate.swift',
    [
      'public struct VideoPlayLoadGenerationGate {',
      '  public init() {}',
      '}',
      ...Array.from(
        { length: 28 },
        (_, index) =>
          `public struct VideoPlayLoadGenerationRequest${index} {\n  public init() {}\n}`
      ),
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/BDHome/Refresh/HomeRequestRefreshGate.swift',
    'public struct HomeRequestRefreshGate {\n  public init() {}\n}\n'
  );
  return root;
}

function createNestedSwiftPackageGraphFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-nested-swift-fixture-'));
  tempRoots.push(root);
  writeFile(root, 'package.json', JSON.stringify({ name: 'nested-swift-root' }, null, 2));
  writeFile(root, 'src/index.ts', 'export const rootProject = true;\n');
  writeFile(
    root,
    '.gitmodules',
    '[submodule "Packages/AOXUIKit"]\n\tpath = Packages/AOXUIKit\n\turl = https://example.invalid/AOXUIKit.git\n'
  );
  writeFile(root, 'Packages/AOXUIKit/.git', 'gitdir: ../../.git/modules/Packages/AOXUIKit\n');
  writeFile(
    root,
    'Packages/AOXUIKit/Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(',
      '  name: "AOXUIKit",',
      '  targets: [',
      '    .target(name: "AOXUIKit", path: "Sources/AOXUIKit"),',
      '    .testTarget(name: "AOXUIKitTests", path: "Tests/AOXUIKitTests"),',
      '  ]',
      ')',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Packages/AOXUIKit/Sources/AOXUIKit/Button.swift',
    'public struct Button { public init() {} }\n'
  );
  writeFile(
    root,
    'Packages/AOXUIKit/Tests/AOXUIKitTests/ButtonTests.swift',
    'struct ButtonTests {}\n'
  );
  writeFile(root, 'Packages/AOXUIKit/docs/readme.md', '# Documentation only\n');
  return root;
}

function createDuplicateIdentityWorkspaceFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-duplicate-scope-fixture-'));
  tempRoots.push(root);
  process.env.ALEMBIC_HOME = root;
  const memberNames = ['RepoA', 'RepoB'];
  for (const memberName of memberNames) {
    writeFile(
      root,
      `${memberName}/package.json`,
      JSON.stringify(
        {
          name: '@fixture/duplicate',
          main: 'src/index.ts',
          scripts: { build: 'tsc --noEmit' },
        },
        null,
        2
      )
    );
    writeFile(root, `${memberName}/src/index.ts`, `export const ${memberName} = true;\n`);
  }
  const projectScope = createProjectDescriptor({
    controlRoot: root,
    dataRoot: path.join(root, '.asd', 'workspaces', 'duplicate-graph-space'),
    displayName: 'DuplicateGraphWorkspace',
    folders: memberNames.map((memberName, index) => ({
      displayName: memberName,
      id: `folder-${memberName.toLowerCase()}`,
      path: path.join(root, memberName),
      repositoryId: memberName,
      role: index === 0 ? ('primary-source' as const) : ('source' as const),
    })),
    projectId: 'duplicate-graph-workspace',
    projectScopeId: 'scope-duplicate-graph-workspace',
  });
  const registryDir = path.join(root, '.asd');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)
  );
  return root;
}

function createGitSubmoduleFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-submodule-fixture-'));
  tempRoots.push(root);
  writeFile(
    root,
    'package.json',
    JSON.stringify({ name: 'single-root', main: 'src/index.ts' }, null, 2)
  );
  writeFile(root, 'src/index.ts', 'export const rootProject = true;\n');
  const submodules = ['Foundation', 'Network', 'Player', 'UI'];
  const sections: string[] = [];
  for (const name of submodules) {
    const relativeRoot = `Packages/${name}`;
    sections.push(
      `[submodule "${relativeRoot}"]`,
      `\tpath = ${relativeRoot}`,
      `\turl = https://example.invalid/${name}.git`
    );
    writeFile(
      root,
      `${relativeRoot}/package.json`,
      JSON.stringify({ name: `@fixture/${name.toLowerCase()}`, main: 'src/index.ts' }, null, 2)
    );
    writeFile(root, `${relativeRoot}/src/index.ts`, `export const ${name} = true;\n`);
    writeFile(root, `${relativeRoot}/.git`, `gitdir: ../../.git/modules/Packages/${name}\n`);
  }
  writeFile(root, '.gitmodules', `${sections.join('\n')}\n`);
  return root;
}

function writeNativeGraphMemberFixture(root: string, memberName: string, entryPath: string) {
  writeFile(
    root,
    `${memberName}/package.json`,
    JSON.stringify({ name: `@fixture/${memberName.toLowerCase()}`, main: entryPath }, null, 2)
  );
  writeFile(root, `${memberName}/${entryPath}`, `export const ${memberName} = true;\n`);
}

function writeNativeGraphProjectScope(root: string) {
  const memberNames = [
    'Alembic',
    'AlembicCore',
    'AlembicPlugin',
    'AlembicDashboard',
    'AlembicAgent',
  ];
  const projectScope = createProjectDescriptor({
    controlRoot: root,
    dataRoot: path.join(root, '.asd', 'workspaces', 'alembic-graph-space'),
    displayName: 'AlembicWorkspace',
    folders: memberNames.map((memberName, index) => ({
      displayName: memberName,
      id: `folder-${memberName.toLowerCase()}`,
      path: path.join(root, memberName),
      repositoryId: memberName,
      role: index === 0 ? ('primary-source' as const) : ('source' as const),
    })),
    projectId: 'alembic-graph-workspace',
    projectScopeId: 'scope-alembic-graph-workspace',
  });
  const registryDir = path.join(root, '.asd');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)
  );
}

function writeWorkspaceCoreFixture(root: string) {
  writeFile(
    root,
    'AlembicCore/package.json',
    JSON.stringify(
      {
        name: '@fixture/core',
        main: 'dist/project-context/GeneratedProjectContext.js',
        types: 'dist/project-context/GeneratedProjectContext.d.ts',
      },
      null,
      2
    )
  );
  writeFile(root, 'AlembicCore/.claude/settings.json', '{}\n');
  writeFile(
    root,
    'AlembicCore/vitest.unit.config.ts',
    'import baseConfig from "./vitest.config";\nexport default baseConfig;\n'
  );
  writeFile(root, 'AlembicCore/src/index.ts', 'export const core = "core";\n');
  writeFile(
    root,
    'AlembicCore/src/project-context.ts',
    'export * from "./domain/project-context/ProjectContextRequestKinds";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/domain/project-context/ProjectContextRequestKinds.ts',
    'export type ProjectContextRequestKind = "source-slice" | "file-symbols" | "file-flow" | "module" | "map" | "repo" | "space";\n'
  );
  writeFile(
    root,
    'AlembicCore/src/repository/RecipeRepository.ts',
    'export class RecipeRepository {}\n'
  );
  writeFile(
    root,
    'AlembicCore/dist/project-context/GeneratedProjectContext.js',
    'export const generatedProjectContext = true;\n'
  );
  writeFile(
    root,
    'AlembicCore/dist/project-context/GeneratedProjectContext.d.ts',
    'export declare const generatedProjectContext: boolean;\n'
  );
  writeFile(
    root,
    'AlembicCore/build/project-context/GeneratedBuildOutput.js',
    'export const generatedBuildOutput = true;\n'
  );
  writeFile(
    root,
    'AlembicCore/vendor/AlembicCore/src/repository/LegacyRepository.ts',
    'export class LegacyRepository {}\n'
  );
}

function writeWorkspacePluginFixture(root: string) {
  writeFile(
    root,
    'AlembicPlugin/package.json',
    JSON.stringify({ name: '@fixture/plugin', main: 'lib/index.ts' }, null, 2)
  );
  writeFile(
    root,
    'AlembicPlugin/lib/index.ts',
    'import { core } from "../../AlembicCore/src/index";\nexport const plugin = core;\n'
  );
  writeFile(
    root,
    'AlembicPlugin/lib/host-runtime/mcp/handlers/agent-public-tools.ts',
    [
      'interface AgentPublicBaseArgs {',
      '  projectRoot?: string;',
      '}',
      '',
      'interface AgentPrimeArgs extends AgentPublicBaseArgs {',
      '  workAction: string;',
      '}',
      '',
      'export async function primeHandler(args: AgentPrimeArgs) {',
      '  return args.workAction;',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'AlembicPlugin/lib/host-runtime/mcp/handlers/structure.ts',
    'export const projectContextGraphHandler = true;\n'
  );
}

function writeWorkspaceNoiseBoundaryFixture(root: string) {
  writeFile(root, 'Test/lib/index.ts', 'export const testSurface = true;\n');
  writeFile(root, 'wakeflow-ledger/AlembicWorkspace/index.md', '# ledger\n');
  writeFile(root, 'legacy-docs-do-not-use/index.md', '# legacy\n');
}

function writeFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createContext(projectRoot: string): McpContext {
  return {
    container: {
      get: () => undefined,
      singletons: { _projectRoot: projectRoot },
    },
    projectRuntime: buildProjectRuntimeContext({ projectRoot }),
  } as unknown as McpContext;
}
