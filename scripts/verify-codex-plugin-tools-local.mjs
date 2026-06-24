#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const projectRoot = resolve(options.projectRoot || root);
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-plugin-tools-local-'));
const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  mode: 'codex-plugin-tools-in-process',
  transport: 'none',
  entrypoint: 'HostMcpServer.handleToolCall',
  projectRoot,
  graphFile: options.graphFile,
  cases: [],
  issues: [],
  skipped: [],
};

const previousEnv = snapshotEnv([
  'ALEMBIC_CODEX_MCP_MODE',
  'ALEMBIC_HOME',
  'ALEMBIC_MCP_MODE',
  'ALEMBIC_PLUGIN_HOST',
  'ALEMBIC_PROJECT_DIR',
  'ALEMBIC_QUIET',
  'ALEMBIC_RUNTIME_MODE',
  'CODEX_WORKSPACE_DIR',
  'CODEX_WORKSPACE_ROOT',
  'INIT_CWD',
  'PWD',
]);

let server = null;
let resetPluginOwnedMcpServerForTests = null;

try {
  assert(
    existsSync(join(root, 'dist', 'lib', 'runtime', 'mcp', 'HostMcpServer.js')),
    'dist runtime is missing; run npm run build before the fast local probe, or use npm run verify:codex-plugin:tools-local.'
  );
  assert(existsSync(projectRoot), `project root does not exist: ${projectRoot}`);

  configureHostEnv({ projectRoot, tmpRoot });

  const [{ HostMcpServer, resetPluginOwnedMcpServerForTests: resetMcp }, outputContract] =
    await Promise.all([
      importModule('dist/lib/runtime/mcp/HostMcpServer.js'),
      importModule('dist/lib/runtime/mcp/output-contract.js'),
    ]);
  resetPluginOwnedMcpServerForTests = resetMcp;
  const serializeMcpToolResult = outputContract.serializeMcpToolResult;
  server = new HostMcpServer({ projectRoot, waitUntilReadyMs: options.timeoutMs });

  const context = {
    projectRoot,
    report,
    serializeMcpToolResult,
    server,
  };

  const knowledge = await runStatusCases(context);
  await runAgentLifecycleCases(context);
  await runSearchAndMapCases(context);
  await runHostGraphCases(context, knowledge);
  if (!options.skipHandlerFixture) {
    const { routeGraphTool } = await importModule('dist/lib/runtime/mcp/handlers/tool-router.js');
    await runGraphHandlerFixtureCases({ ...context, routeGraphTool });
  }

  report.ok = report.issues.length === 0 && report.cases.every((entry) => entry.ok !== false);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  report.issues.push(message);
  report.ok = false;
} finally {
  try {
    await server?.shutdown?.();
  } catch (err) {
    report.issues.push(
      `HostMcpServer shutdown failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    await resetPluginOwnedMcpServerForTests?.();
  } catch (err) {
    report.issues.push(
      `embedded MCP reset failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  restoreEnv(previousEnv);
  if (options.keepTmp) {
    report.tmpRoot = tmpRoot;
  } else {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
  writeReport(report, options);
}

if (!report.ok) {
  process.exitCode = 1;
}

async function runStatusCases(context) {
  await runCase(context, {
    id: 'host/status',
    toolName: 'alembic_status',
    args: {},
    assert({ structured }) {
      expect(structured.ok === true, 'status should be ok');
      expect(structured.status === 'ready', `status should be ready, got ${structured.status}`);
      expect(
        structured.project?.root === projectRoot,
        `status project.root mismatch: ${structured.project?.root}`
      );
      expect(structured.daemon?.status === 'stopped', 'daemon-less runtime should report stopped');
      return {
        initialized: structured.initialized === true,
        knowledgeUsable: structured.knowledge?.usable === true,
        workspaceMode: structured.workspace?.mode ?? null,
      };
    },
  });

  const knowledgeCase = await runCase(context, {
    id: 'host/status-knowledge',
    toolName: 'alembic_status',
    args: { aspect: 'knowledge' },
    assert({ structured }) {
      expect(structured.ok === true, 'knowledge status should be ok');
      expect(structured.knowledge && typeof structured.knowledge === 'object', 'missing knowledge');
      return {
        databaseEntryCount: structured.knowledge.databaseEntryCount ?? null,
        dbRecipeCount: structured.knowledge.dbRecipeCount ?? null,
        hasKnowledge: structured.knowledge.hasKnowledge === true,
        materializedRecipeCount: structured.knowledge.materializedRecipeCount ?? null,
        recipeCount: structured.knowledge.recipeCount ?? null,
        usable: structured.knowledge.usable === true,
      };
    },
  });

  await runCase(context, {
    id: 'host/status-runtime',
    toolName: 'alembic_status',
    args: { aspect: 'runtime' },
    assert({ structured }) {
      expect(structured.ok === true, 'runtime status should be ok');
      expect(structured.plugin?.ok === true, 'plugin runtime checks should pass');
      expect(structured.codex?.pluginHost === 'codex', 'runtime should identify codex host');
      return {
        pluginOk: structured.plugin?.ok === true,
        runtimeMode: structured.runtimeIdentity?.mode ?? null,
      };
    },
  });

  return {
    usable: knowledgeCase.metrics?.usable === true,
    hasKnowledge: knowledgeCase.metrics?.hasKnowledge === true,
  };
}

async function runAgentLifecycleCases(context) {
  await runCase(context, {
    id: 'host/prime',
    toolName: 'alembic_prime',
    args: {
      taskAction: 'implement',
      requirementGoal: 'validate AlembicPlugin tools without real MCP transport',
      capability: 'Codex plugin MCP tool validation',
      integrationBoundary: 'in-process HostMcpServer tool call',
      qualityConcerns: ['testing', 'contract fidelity'],
    },
    assert({ structured }) {
      expect(structured.ok === true, 'prime should return a clean ok response');
      expect(
        ['ready', 'degraded'].includes(structured.status),
        `prime should be ready or degraded, got ${structured.status}`
      );
      expect(structured.refs?.primeRef?.id, 'prime should return a primeRef');
      const projectContextGuidance = structured.primePackage?.projectContextGuidance;
      expect(projectContextGuidance, 'prime should return ProjectContext guidance');
      expect(
        projectContextGuidance?.recommendedTools?.includes('alembic_recipe_map'),
        'prime should recommend alembic_recipe_map for ProjectContext orientation'
      );
      expect(
        projectContextGuidance?.recommendedTools?.includes('alembic_graph'),
        'prime should recommend alembic_graph for ProjectContext orientation'
      );
      expect(
        !JSON.stringify(projectContextGuidance).includes('alembic_project_matrix'),
        'prime ProjectContext guidance should not point at retired alembic_project_matrix'
      );
      return {
        detailRefs: structured.detailRefs?.length ?? structured.refs?.detailRefs?.length ?? 0,
        primeRef: structured.refs?.primeRef?.id ?? null,
        projectContextTools: projectContextGuidance?.recommendedTools ?? [],
        status: structured.status,
      };
    },
  });

  await runCase(context, {
    id: 'host/work-start-finish',
    toolName: 'alembic_work',
    async execute() {
      const start = await callHostTool(context, 'alembic_work', {
        phase: 'start',
        title: 'local plugin tool validation',
        workScope: {
          goal: 'exercise the in-process AlembicPlugin work lifecycle',
          files: [options.graphFile],
        },
      });
      assertCleanToolResult(start, 'alembic_work');
      expect(start.structured.status === 'ready', 'work start should be ready');
      const workRef = start.structured.workRef ?? start.structured.refs?.workRef?.id;
      expect(typeof workRef === 'string' && workRef.length > 0, 'work start missing workRef');

      const finish = await callHostTool(context, 'alembic_work', {
        phase: 'finish',
        workRef,
        outcome: 'completed',
        summary: 'In-process local validation lifecycle completed.',
        changedFiles: [options.graphFile],
        evidenceRefs: ['scripts/verify-codex-plugin-tools-local.mjs'],
      });
      assertCleanToolResult(finish, 'alembic_work');
      expect(finish.structured.status === 'ready', 'work finish should be ready');
      expect(finish.structured.finishRef, 'work finish missing finishRef');
      expect(
        finish.structured.guardRecommendation?.tool === 'alembic_code_guard',
        'work finish should recommend or skip alembic_code_guard explicitly'
      );
      return {
        normalized: finish,
        metrics: {
          finishRef: finish.structured.finishRef,
          guardAction: finish.structured.guardRecommendation?.action ?? null,
          workRef,
        },
        summary: `${start.structured.summary} ${finish.structured.summary}`,
      };
    },
  });

  await runCase(context, {
    id: 'host/code-guard-missing-scope',
    toolName: 'alembic_code_guard',
    args: {},
    assert({ normalized, structured }) {
      expect(structured.ok === false, 'no-scope code guard should fail closed');
      expect(structured.status === 'blocked', `code guard should block, got ${structured.status}`);
      expect(normalized.result.isError === true, 'blocked guard should serialize as isError');
      expect(
        structured.reason?.code === 'missing-guard-scope',
        `unexpected guard blocker: ${structured.reason?.code}`
      );
      return { reasonCode: structured.reason?.code ?? null };
    },
  });
}

async function runSearchAndMapCases(context) {
  await runCase(context, {
    id: 'host/search',
    toolName: 'alembic_search',
    args: { query: 'MCP tool validation', limit: 3 },
    assert({ structured }) {
      expect(structured.ok === true, 'search should return a clean ok response');
      expect(structured.toolName === 'alembic_search', 'search toolName mismatch');
      expect(Array.isArray(structured.items), 'search should expose bounded items');
      return {
        diagnostics: structured.diagnostics?.map((item) => item.code).filter(Boolean) ?? [],
        items: structured.items.length,
        status: structured.status,
      };
    },
  });

  await runCase(context, {
    id: 'host/search-projectcontext-zero-match-guidance',
    toolName: 'alembic_search',
    args: {
      activeFile: options.graphFile,
      limit: 5,
      query:
        'definitely-missing ProjectContext handler fixture file-symbols source-slice anchor-range',
    },
    assert({ structured }) {
      expect(structured.ok === true, 'project-context zero search should return clean ok');
      expect(structured.inventory?.zeroMatch === true, 'search should record zeroMatch=true');
      expect(structured.items.length === 0, 'zero direct match search should not leak candidates');
      const tools = structured.nextActions?.map((action) => action.tool) ?? [];
      expect(
        tools.includes('alembic_recipe_map'),
        'zero-match ProjectContext search should recommend alembic_recipe_map'
      );
      expect(
        tools.includes('alembic_graph'),
        'zero-match ProjectContext search should recommend alembic_graph'
      );
      expect(
        tools.includes('alembic_search'),
        'zero-match search should keep the exact Recipe retry route'
      );
      return {
        nextActionTools: tools,
        status: structured.status,
        zeroMatch: structured.inventory?.zeroMatch === true,
      };
    },
  });

  await runCase(context, {
    id: 'host/recipe-map-file',
    toolName: 'alembic_recipe_map',
    args: {
      focus: { kind: 'file', filePath: options.graphFile },
      includeRecipes: false,
      includeRollups: true,
      nodeLimit: 25,
    },
    assert({ structured }) {
      expect(structured.ok === true, 'recipe map should return a clean ok response');
      expect(structured.status === 'ready', `recipe map should be ready, got ${structured.status}`);
      expect(structured.focus?.kind === 'file', 'recipe map focus should stay file-scoped');
      expect(structured.region?.nodes?.length > 0, 'recipe map should return region nodes');
      return {
        mounts: structured.recipeMounts?.length ?? 0,
        regionNodes: structured.region?.nodes?.length ?? 0,
        rollups: structured.recipeRollups?.length ?? 0,
      };
    },
  });

  await runCase(context, {
    id: 'host/recipe-map-file-relevance',
    toolName: 'alembic_recipe_map',
    args: {
      focus: { kind: 'file', filePath: options.graphFile },
      includeRecipes: true,
      includeRollups: true,
      nodeLimit: 25,
      recipeMountLimit: 50,
    },
    assert({ structured }) {
      expect(structured.ok === true, 'recipe map with recipes should return clean ok');
      expect(structured.focus?.kind === 'file', 'recipe map focus should stay file-scoped');
      const rootNodeId = structured.region?.rootNode?.nodeId;
      const misleadingRootMounts = (structured.recipeMounts ?? []).filter(
        (mount) =>
          mount.mountNodeId === rootNodeId &&
          Array.isArray(mount.sourceRefs) &&
          mount.sourceRefs.length === 0 &&
          (mount.mountType === 'metadata-scope' || mount.mountType === 'global-no-code')
      );
      expect(
        misleadingRootMounts.length === 0,
        `file recipe_map should not direct-mount metadata-only Recipes at the file root: ${misleadingRootMounts
          .map((mount) => mount.recipeId)
          .join(', ')}`
      );
      return {
        metadataOnlyRootMounts: misleadingRootMounts.length,
        mounts: structured.recipeMounts?.length ?? 0,
        status: structured.status,
      };
    },
  });
}

async function runHostGraphCases(context, knowledge) {
  if (!knowledge.usable) {
    const message =
      'host graph cases require usable project knowledge; run alembic_status/alembic_bootstrap for this project or pass --allow-knowledge-skip.';
    if (options.allowKnowledgeSkip) {
      for (const id of [
        'host/graph-file-symbols',
        'host/graph-source-slice',
        'host/graph-anchor-range',
        'host/graph-missing-anchor',
        'host/graph-path-missing-endpoint',
        'host/graph-missing-file-anchor',
      ]) {
        report.skipped.push({ id, reason: message });
      }
      return;
    }
    throw new Error(message);
  }

  const anchorLine = findLine(
    options.graphFile,
    /async callPluginOwnedTool|routeGraphTool|class HostMcpServer/u
  );
  await runGraphCase(context, {
    id: 'host/graph-file-symbols',
    args: {
      queryKind: 'file-symbols',
      filePath: options.graphFile,
      budget: { itemLimit: 80, relationHopLimit: 4 },
    },
    assertGraph(structured) {
      expect(
        structured.status === 'ready',
        `file-symbols should be ready, got ${structured.status}`
      );
      expect(
        structured.nodes.some(
          (node) => node.nodeType === 'file' && node.path === options.graphFile
        ),
        'file-symbols missing file node'
      );
      expect(
        structured.nodes.some((node) => node.nodeType === 'symbol'),
        'file-symbols missing symbol nodes'
      );
      expect(
        structured.relations.some((relation) => relation.relationType === 'definesSymbol'),
        'file-symbols missing definesSymbol relations'
      );
    },
  });

  await runGraphCase(context, {
    id: 'host/graph-source-slice',
    args: {
      queryKind: 'source-slice',
      filePath: options.graphFile,
      line: anchorLine,
      radius: { beforeLines: 4, afterLines: 8 },
      budget: { itemLimit: 30, relationHopLimit: 3 },
    },
    assertGraph(structured) {
      expect(
        structured.status === 'ready',
        `source-slice should be ready, got ${structured.status}`
      );
      expect((structured.slices ?? []).length > 0, 'source-slice missing source slices');
      expect(
        (structured.slices ?? []).some(
          (slice) => typeof slice.text === 'string' && slice.text.length > 0
        ),
        'source-slice should include bounded source text'
      );
    },
  });

  await runGraphCase(context, {
    id: 'host/graph-anchor-range',
    args: {
      queryKind: 'anchor-range',
      filePath: options.graphFile,
      line: anchorLine,
      radius: { beforeLines: 4, afterLines: 8, relationHops: 3 },
      budget: { itemLimit: 40, relationHopLimit: 4 },
    },
    assertGraph(structured) {
      expect(
        structured.status === 'ready',
        `anchor-range should be ready, got ${structured.status}`
      );
      expect(structured.nodes.length > 0, 'anchor-range missing nodes');
      expect((structured.slices ?? []).length > 0, 'anchor-range missing source slice');
    },
  });

  await runGraphCase(context, {
    id: 'host/graph-missing-anchor',
    args: { queryKind: 'impact' },
    expectedStatus: 'partial',
    expectedDiagnostic: 'project-graph-anchor-required',
  });

  await runGraphCase(context, {
    id: 'host/graph-path-missing-endpoint',
    args: { queryKind: 'path', fromRefId: `file:${options.graphFile}` },
    expectedStatus: 'partial',
    expectedDiagnostic: 'project-graph-path-anchor-required',
  });

  await runGraphCase(context, {
    id: 'host/graph-missing-file-anchor',
    args: { queryKind: 'file-symbols' },
    expectedStatus: 'partial',
    expectedDiagnostic: 'project-graph-file-anchor-required',
  });
}

async function runGraphHandlerFixtureCases(context) {
  const fixtureRoot = createGraphFixtureProject(tmpRoot);
  const handlerContext = {
    container: {
      get: () => undefined,
      singletons: { _projectRoot: fixtureRoot },
    },
  };

  await runCase(context, {
    id: 'handler-fixture/graph-file-symbols',
    toolName: 'alembic_graph',
    async execute() {
      const normalized = normalizeToolResult(
        'alembic_graph',
        await withTimeout(
          context.routeGraphTool(handlerContext, {
            projectRoot: fixtureRoot,
            queryKind: 'file-symbols',
            filePath: 'lib/index.ts',
            budget: { itemLimit: 40, relationHopLimit: 4 },
          }),
          options.timeoutMs,
          'handler fixture file-symbols timed out'
        ),
        context.serializeMcpToolResult
      );
      assertCleanToolResult(normalized, 'alembic_graph');
      assertGraphBase(normalized.structured, {
        expectedQueryKind: 'file-symbols',
        expectedStatus: 'ready',
      });
      expect(
        normalized.structured.nodes.some((node) => node.nodeType === 'symbol'),
        'handler fixture should expose symbol nodes'
      );
      return {
        normalized,
        metrics: graphMetrics(normalized.structured),
      };
    },
  });

  await runCase(context, {
    id: 'handler-fixture/graph-fast-fail',
    toolName: 'alembic_graph',
    async execute() {
      const normalized = normalizeToolResult(
        'alembic_graph',
        await withTimeout(
          context.routeGraphTool(handlerContext, {
            projectRoot: fixtureRoot,
            queryKind: 'impact',
          }),
          options.timeoutMs,
          'handler fixture fast-fail timed out'
        ),
        context.serializeMcpToolResult
      );
      assertCleanToolResult(normalized, 'alembic_graph');
      assertGraphBase(normalized.structured, {
        expectedDiagnostic: 'project-graph-anchor-required',
        expectedQueryKind: 'impact',
        expectedStatus: 'partial',
      });
      expect(normalized.structured.nodes.length === 0, 'fast-fail should not build graph nodes');
      return {
        normalized,
        metrics: graphMetrics(normalized.structured),
      };
    },
  });
}

async function runGraphCase(
  context,
  { args, assertGraph, expectedDiagnostic, expectedStatus = 'ready', id }
) {
  await runCase(context, {
    id,
    toolName: 'alembic_graph',
    args,
    assert({ structured }) {
      assertGraphBase(structured, {
        expectedDiagnostic,
        expectedQueryKind: args.queryKind,
        expectedStatus,
      });
      assertGraph?.(structured);
      return graphMetrics(structured);
    },
  });
}

function assertGraphBase(structured, { expectedDiagnostic, expectedQueryKind, expectedStatus }) {
  expect(structured.tool === 'alembic_graph', 'graph tool discriminator mismatch');
  expect(
    structured.queryKind === expectedQueryKind,
    `graph queryKind mismatch: expected ${expectedQueryKind}, got ${structured.queryKind}`
  );
  expect(
    structured.status === expectedStatus,
    `graph status mismatch: expected ${expectedStatus}, got ${structured.status}`
  );
  expect(Array.isArray(structured.nodes), 'graph nodes should be an array');
  expect(Array.isArray(structured.relations), 'graph relations should be an array');
  expect(Array.isArray(structured.refs), 'graph refs should be an array');
  expect(Array.isArray(structured.diagnostics), 'graph diagnostics should be an array');
  expect(structured.meta?.outputSchema === 'AlembicGraphOutput', 'graph outputSchema mismatch');
  assertGraphRecipeFree(structured);
  if (expectedDiagnostic) {
    expect(
      structured.diagnostics.some((item) => item.code === expectedDiagnostic),
      `missing graph diagnostic ${expectedDiagnostic}`
    );
  } else {
    expect(
      structured.diagnostics.length === 0,
      `unexpected graph diagnostics: ${diagnosticCodes(structured)}`
    );
  }
}

async function runCase(context, definition) {
  if (!shouldRunCase(definition.id)) {
    report.skipped.push({ id: definition.id, reason: 'filtered by --case' });
    return { ok: true, skipped: true };
  }
  const startedAt = Date.now();
  try {
    const output = definition.execute
      ? await withTimeout(
          definition.execute(),
          options.timeoutMs,
          `${definition.id} timed out after ${options.timeoutMs}ms`
        )
      : {
          normalized: await callHostTool(context, definition.toolName, definition.args ?? {}),
        };
    const normalized = output.normalized;
    assertCleanToolResult(normalized, definition.toolName);
    const metrics = {
      ...(output.metrics ?? {}),
      ...(definition.assert?.({ normalized, structured: normalized.structured }) ?? {}),
    };
    const entry = {
      id: definition.id,
      ok: true,
      toolName: definition.toolName,
      durationMs: Date.now() - startedAt,
      status: normalized.structured.status,
      summary: output.summary ?? normalized.structured.summary,
      metrics,
    };
    report.cases.push(entry);
    return entry;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const entry = {
      id: definition.id,
      ok: false,
      toolName: definition.toolName,
      durationMs: Date.now() - startedAt,
      error: message,
    };
    report.cases.push(entry);
    report.issues.push(`${definition.id}: ${message}`);
    return entry;
  }
}

async function callHostTool(context, toolName, args) {
  const raw = await withTimeout(
    context.server.handleToolCall(toolName, args),
    options.timeoutMs,
    `${toolName} timed out after ${options.timeoutMs}ms`
  );
  return normalizeToolResult(toolName, raw, context.serializeMcpToolResult);
}

function normalizeToolResult(toolName, raw, serializeMcpToolResult) {
  const result =
    raw && typeof raw === 'object' && Array.isArray(raw.content) && raw.structuredContent
      ? raw
      : serializeMcpToolResult(toolName, raw, { isErrorResult });
  const structured = result?.structuredContent;
  return {
    raw,
    result,
    structured,
    wrapperKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
  };
}

function assertCleanToolResult(normalized, toolName) {
  const { result, structured } = normalized;
  expect(result && typeof result === 'object', `${toolName} did not return a tool result object`);
  expect(structured && typeof structured === 'object', `${toolName} missing structuredContent`);
  expect(structured.toolName === toolName, `${toolName} structuredContent.toolName mismatch`);
  expect(
    typeof structured.summary === 'string' && structured.summary.length > 0,
    `${toolName} missing summary`
  );
  expect(
    Array.isArray(result.content) &&
      result.content.length === 1 &&
      result.content[0]?.type === 'text' &&
      result.content[0]?.text === structured.summary,
    `${toolName} visible content must be summary-only`
  );
  expect(structured.meta?.contractVersion === 1, `${toolName} missing clean contractVersion=1`);
  for (const field of ['success', 'errorCode', 'message', 'data']) {
    expect(!Object.hasOwn(structured, field), `${toolName} leaked old envelope field ${field}`);
  }
  if (structured.ok === false) {
    expect(result.isError === true, `${toolName} failed output should serialize with isError=true`);
  }
}

function assertGraphRecipeFree(structured) {
  const serialized = JSON.stringify(structured).toLowerCase();
  for (const forbidden of ['recipeid', 'coveredbyknowledge', 'relationchain', 'scorebreakdown']) {
    expect(!serialized.includes(forbidden), `alembic_graph leaked ${forbidden}`);
  }
}

function graphMetrics(structured) {
  return {
    diagnostics: diagnosticCodes(structured),
    nodes: structured.nodes?.length ?? 0,
    refs: structured.refs?.length ?? 0,
    relations: structured.relations?.length ?? 0,
    slices: structured.slices?.length ?? 0,
  };
}

function diagnosticCodes(structured) {
  return structured.diagnostics?.map((item) => item.code).filter(Boolean) ?? [];
}

function createGraphFixtureProject(baseRoot) {
  const fixtureRoot = join(baseRoot, 'graph-fixture');
  mkdirSync(join(fixtureRoot, 'lib'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'local-plugin-tools-fixture',
        main: 'lib/index.ts',
        type: 'module',
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(fixtureRoot, 'lib', 'helper.ts'),
    'export function helper(value: string) { return value.toUpperCase(); }\n'
  );
  writeFileSync(
    join(fixtureRoot, 'lib', 'index.ts'),
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

function findLine(relativePath, pattern) {
  const absolutePath = resolve(projectRoot, relativePath);
  assert(existsSync(absolutePath), `graph file does not exist: ${relativePath}`);
  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/u);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    return index + 1;
  }
  return Math.max(1, Math.floor(lines.length / 2));
}

function configureHostEnv({ projectRoot, tmpRoot }) {
  if (options.sandboxHome) {
    const home = join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    process.env.ALEMBIC_HOME = home;
    report.alembicHome = home;
  } else if (options.alembicHome) {
    process.env.ALEMBIC_HOME = resolve(options.alembicHome);
    report.alembicHome = process.env.ALEMBIC_HOME;
  } else {
    report.alembicHome = process.env.ALEMBIC_HOME || null;
  }
  process.env.ALEMBIC_CODEX_MCP_MODE = '1';
  process.env.ALEMBIC_MCP_MODE = '1';
  process.env.ALEMBIC_PLUGIN_HOST = process.env.ALEMBIC_PLUGIN_HOST || 'codex';
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  process.env.ALEMBIC_QUIET = '1';
  process.env.ALEMBIC_RUNTIME_MODE = process.env.ALEMBIC_RUNTIME_MODE || 'plugin';
  process.env.CODEX_WORKSPACE_DIR = projectRoot;
  process.env.CODEX_WORKSPACE_ROOT = process.env.CODEX_WORKSPACE_ROOT || projectRoot;
  process.env.INIT_CWD = projectRoot;
  process.env.PWD = projectRoot;
}

function shouldRunCase(id) {
  return options.caseIds.length === 0 || options.caseIds.includes(id);
}

async function importModule(relativePath) {
  return import(pathToFileURL(join(root, relativePath)).href);
}

function writeReport(nextReport, nextOptions) {
  if (nextOptions.reportPath) {
    const target = resolve(nextOptions.reportPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(nextReport, null, 2)}\n`);
  }
  if (nextOptions.json) {
    process.stdout.write(`${JSON.stringify(nextReport, null, 2)}\n`);
    return;
  }
  const passed = nextReport.cases.filter((entry) => entry.ok).length;
  const failed = nextReport.cases.filter((entry) => entry.ok === false).length;
  process.stdout.write(
    `${nextReport.ok ? 'ok' : 'failed'} codex-plugin-tools-in-process ` +
      `passed=${passed} failed=${failed} skipped=${nextReport.skipped.length} ` +
      `project=${relative(root, projectRoot) || '.'}\n`
  );
  for (const entry of nextReport.cases) {
    const status = entry.ok ? 'PASS' : 'FAIL';
    const detail = entry.ok ? `${entry.status} ${entry.summary}` : entry.error;
    process.stdout.write(`  ${status} ${entry.id}: ${detail}\n`);
  }
  for (const skipped of nextReport.skipped) {
    process.stdout.write(`  SKIP ${skipped.id}: ${skipped.reason}\n`);
  }
  if (nextReport.issues.length > 0) {
    process.stdout.write(`issues:\n`);
    for (const issue of nextReport.issues) {
      process.stdout.write(`  - ${issue}\n`);
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function defaultOptions() {
  return {
    allowKnowledgeSkip: false,
    alembicHome: '',
    caseIds: [],
    graphFile: 'lib/runtime/mcp/HostMcpServer.ts',
    json: false,
    keepTmp: false,
    projectRoot: root,
    reportPath: '',
    sandboxHome: false,
    skipHandlerFixture: false,
    timeoutMs: 30000,
  };
}

function booleanOptionHandlers() {
  return {
    '--allow-knowledge-skip': (parsed) => {
      parsed.allowKnowledgeSkip = true;
    },
    '--json': (parsed) => {
      parsed.json = true;
    },
    '--keep-tmp': (parsed) => {
      parsed.keepTmp = true;
    },
    '--sandbox-home': (parsed) => {
      parsed.sandboxHome = true;
    },
    '--skip-handler-fixture': (parsed) => {
      parsed.skipHandlerFixture = true;
    },
  };
}

function valueOptionHandlers() {
  return {
    '--alembic-home': (parsed, value) => {
      parsed.alembicHome = value;
    },
    '--case': (parsed, value) => {
      parsed.caseIds.push(value);
    },
    '--graph-file': (parsed, value) => {
      parsed.graphFile = value || parsed.graphFile;
    },
    '--project-root': (parsed, value) => {
      parsed.projectRoot = value || root;
    },
    '--report-path': (parsed, value) => {
      parsed.reportPath = value;
    },
    '--timeout-ms': (parsed, value) => {
      parsed.timeoutMs = Number(value || parsed.timeoutMs);
    },
  };
}

function parseArgs(args) {
  const parsed = defaultOptions();
  for (let index = 0; index < args.length; index += 1) {
    index = readOption(parsed, args, index);
  }
  return finalizeOptions(parsed);
}

function readOption(parsed, args, index) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') {
    printUsage();
    process.exit(0);
  }
  const booleanHandler = booleanOptionHandlers()[arg];
  if (booleanHandler) {
    booleanHandler(parsed);
    return index;
  }
  const valueHandler = valueOptionHandlers()[arg];
  if (valueHandler) {
    valueHandler(parsed, args[index + 1] || '');
    return index + 1;
  }
  throw new Error(`Unknown option: ${arg}`);
}

function finalizeOptions(parsed) {
  parsed.caseIds = parsed.caseIds.filter(Boolean);
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
    throw new Error('--timeout-ms must be a number >= 1000');
  }
  return parsed;
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/verify-codex-plugin-tools-local.mjs [options]

Runs AlembicPlugin tool validation in the current Node process. It does not
open a real MCP stdio transport and does not require restarting Codex.

Options:
  --project-root <path>       Project root to validate. Defaults to this repo.
  --graph-file <path>         Relative file used by graph cases.
  --case <id>                 Run one case id. Repeatable.
  --allow-knowledge-skip      Skip host graph cases when project knowledge is unavailable.
  --sandbox-home              Use a temporary ALEMBIC_HOME for local-tool checks.
  --alembic-home <path>       Use an explicit ALEMBIC_HOME.
  --skip-handler-fixture      Skip direct handler fixture graph cases.
  --timeout-ms <ms>           Per-case timeout. Default: 30000.
  --json                      Print the full JSON report.
  --report-path <path>        Write the JSON report to a file.
  --keep-tmp                  Keep temporary fixture files.
`);
}

function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function isErrorResult(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    value.ok === false ||
    value.success === false ||
    value.isError === true ||
    Boolean(value.errorCode)
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
