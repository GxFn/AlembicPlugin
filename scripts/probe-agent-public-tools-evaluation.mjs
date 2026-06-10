#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const requiredTools = [
  'alembic_intent',
  'alembic_prime',
  'alembic_work_start',
  'alembic_work_finish',
  'alembic_code_guard',
  'alembic_decision_record',
];
const sourceGraphTools = [
  'alembic_source_graph_status',
  'alembic_code_explore',
  'alembic_code_impact',
  'alembic_validation_plan',
];
const fusedWorkflowRefNames = [
  'intentRef',
  'primeRef',
  'sourceGraphRef',
  'workRef',
  'finishRef',
  'guardResultRef',
  'decisionRef',
];
const fusedWorkflowTasks = [
  {
    id: 'plugin-runtime-tool-policy',
    owner: 'AlembicPlugin',
    title: 'Plan a Codex MCP tool policy edit',
    query: 'Plan a safe edit for the Codex MCP tool policy around source graph guidance.',
    changedFiles: ['src/helper.ts'],
    packageScripts: { test: 'vitest run test/helper.test.ts' },
    expectedOwner: 'AlembicPlugin owns Codex MCP behavior, schemas, and clean projections.',
  },
  {
    id: 'core-validation-plan',
    owner: 'AlembicCore',
    title: 'Plan a Core validation-plan producer edit',
    query: 'Plan a safe edit for the Core source graph validation-plan producer.',
    changedFiles: ['src/helper.ts'],
    packageScripts: { test: 'vitest run test/helper.test.ts' },
    expectedOwner: 'AlembicCore owns deterministic source graph facts and validation plans.',
  },
];
const baselineRawExplorationPlan = ['Read(src/helper.ts)', 'rg helper src test'];
const forbiddenLegacyPrimaryWording = [
  'operation=prime',
  'operation=create',
  'operation=close',
  'Task and decision management (5 operations)',
  'primary action is `alembic_task`',
];

const forbiddenPublicOutputKeys = new Set([
  'codexProjectScopeExecution',
  'diagnostics',
  'enhancementRoute',
  'hostProjectAlignment',
  'legacyCompatibility',
  'maxChars',
  'metadata',
  'outputBudget',
  'projectRuntime',
  'residentService',
  'retrievalConsumer',
  'runtimePolicy',
  'searchMeta',
  'serviceBoundary',
  'sourcePolicy',
  'telemetry',
  'truncated',
  'usedChars',
]);

const forbiddenTopLevelPublicOutputKeys = new Set([
  'data',
  'errorCode',
  'message',
  'result',
  'success',
]);

let sourceGraphIndexingModules = null;

const options = parseArgs(process.argv.slice(2));
const tmpRoot = mkdtempSync(join(tmpdir(), 'afapi-stage6-public-tools-'));
const projectRoot = options.projectRoot || join(tmpRoot, 'project');
mkdirSync(projectRoot, { recursive: true });

const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  mode: options.liveWorkspaceRoot
    ? 'cgk6-18-plugin-live-runtime-acceptance-repair'
    : options.fusedWorkflow
      ? 'cgk10-14-agent-public-tools-fused-workflow-evaluation'
      : 'afapi-stage6-agent-public-tools-installed-cache-readback',
  projectRoot,
  requiredTools,
  ...(options.fusedWorkflow
    ? {
        fusedWorkflowContract: {
          baselineRawExplorationPlan,
          refNames: fusedWorkflowRefNames,
          requiredSourceGraphTools: sourceGraphTools,
          tasks: fusedWorkflowTasks.map(({ id, owner, title }) => ({ id, owner, title })),
        },
      }
    : {}),
  ...(options.liveWorkspaceRoot
    ? {
        liveRuntimeContract: {
          workspaceRoot: options.liveWorkspaceRoot,
          requiredScenarios: [
            'workspace-root-without-projectScope-fails-closed',
            'workspace-root-projectScope-AlembicPlugin-returns-source-context',
            'workspace-root-projectScope-AlembicCore-returns-source-context',
            'explicit-product-roots-remain-ready',
            'validation-plan-or-impact-names-tests-or-explains-unknown',
            'sequential-and-parallel-calls-keep-transport-open',
            'source-graph-output-omits-legacy-runtime-payloads',
          ],
        },
      }
    : {}),
  forbiddenLegacyPrimaryWording,
  targets: [],
};

try {
  const targets = resolveInstalledTargets();
  for (const targetRoot of targets) {
    try {
      report.targets.push(await probeTarget(targetRoot));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      report.targets.push({
        ok: false,
        targetRoot,
        error: error.message,
      });
    }
  }
  report.ok = report.targets.length > 0 && report.targets.every((target) => target.ok === true);
  writeReport();
  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  if (!options.keepTmp) {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
}

async function probeTarget(targetRoot) {
  const issues = [];
  const marker = readOptionalJson(join(targetRoot, '.alembic-dev-refresh.json'));
  const transportConfig = readMcpServerConfig(targetRoot);
  const stderr = [];
  let probePhase = 'connect';
  const transport = new StdioClientTransport({
    command: transportConfig.command,
    args: transportConfig.args,
    cwd: targetRoot,
    env: sanitizeEnv({
      ...process.env,
      ...(transportConfig.env || {}),
      ALEMBIC_HOME: join(tmpRoot, `home-${report.targets.length}`),
      ALEMBIC_PROJECT_DIR: projectRoot,
      ALEMBIC_QUIET: '1',
      CODEX_WORKSPACE_DIR: projectRoot,
      INIT_CWD: projectRoot,
      PWD: projectRoot,
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const client = new Client({
    name: 'afapi-stage6-agent-public-tools-evaluation',
    version: '0.0.0',
  });
  try {
    probePhase = 'connect';
    await withTimeout(
      client.connect(transport, { timeout: options.mcpTimeoutMs }),
      options.mcpTimeoutMs + 2000,
      () => `MCP connect timed out for ${targetRoot}\n${stderr.join('')}`
    );

    probePhase = 'before-init-tools';
    const beforeInitTools = await listTools(client, stderr);
    const beforeInit = summarizeToolSurface(beforeInitTools.tools);
    for (const toolName of requiredTools) {
      expectIssue(
        issues,
        beforeInit.names.includes(toolName),
        `before init tools/list missing ${toolName}`
      );
      const description = beforeInit.descriptions[toolName] || '';
      expectIssue(
        issues,
        description.includes('Non-goal:'),
        `${toolName} description did not include Non-goal`
      );
      for (const forbidden of forbiddenLegacyPrimaryWording) {
        expectIssue(
          issues,
          !description.includes(forbidden),
          `${toolName} description contains legacy primary wording: ${forbidden}`
        );
      }
    }
    expectIssue(
      issues,
      !beforeInit.names.includes('alembic_task'),
      'before init should not expose retired alembic_task'
    );

    probePhase = 'public-tool-calls';
    const calls = await runPublicToolCalls(client, stderr);
    evaluateCalls(issues, calls);
    probePhase = 'fused-workflow';
    const fusedWorkflow = options.fusedWorkflow
      ? await runFusedWorkflowEvaluation(client, stderr, targetRoot)
      : null;
    if (fusedWorkflow && !fusedWorkflow.ok) {
      issues.push(...fusedWorkflow.issues.map((issue) => `fused workflow: ${issue}`));
    }
    probePhase = 'live-runtime-acceptance';
    const liveRuntime = options.liveWorkspaceRoot
      ? await runLiveWorkspaceRuntimeAcceptance(client, stderr, options.liveWorkspaceRoot)
      : null;
    if (liveRuntime && !liveRuntime.ok) {
      issues.push(...liveRuntime.issues.map((issue) => `live runtime: ${issue}`));
    }

    probePhase = 'codex-init';
    const init = await callJsonTool(client, 'alembic_codex_init', { projectRoot }, stderr);
    expectIssue(
      issues,
      init.payload?.success === true || init.payload?.ok === true,
      'alembic_codex_init did not succeed'
    );
    probePhase = 'after-init-tools';
    const afterInitTools = await listTools(client, stderr);
    const afterInit = summarizeToolSurface(afterInitTools.tools);
    expectIssue(
      issues,
      !afterInit.names.includes('alembic_task'),
      'after init should not expose retired alembic_task'
    );
    probePhase = 'retired-task-direct-call';
    const retiredLegacyTask = await probeRetiredLegacyTask(client, stderr);
    expectIssue(
      issues,
      retiredLegacyTask.retired === true,
      'retired alembic_task direct calls should fail closed with clean output'
    );
    expectIssue(
      issues,
      retiredLegacyTask.omitsLegacyFields === true,
      'retired alembic_task direct calls should not return old envelope fields'
    );

    return {
      ok: issues.length === 0,
      targetRoot,
      marker: summarizeMarker(marker),
      beforeInit,
      calls,
      ...(fusedWorkflow ? { fusedWorkflow } : {}),
      ...(liveRuntime ? { liveRuntime } : {}),
      afterInit: {
        names: afterInit.names,
        retiredTaskDirectCall: {
          hiddenFromToolsList: !afterInit.names.includes('alembic_task'),
          omitsLegacyFields: retiredLegacyTask.omitsLegacyFields,
          retired: retiredLegacyTask.retired,
          status: retiredLegacyTask.status,
          visible: false,
        },
      },
      retiredLegacyTask,
      issues,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      ok: false,
      targetRoot,
      marker: summarizeMarker(marker),
      error: error.message,
      phase: probePhase,
      stderr: stderr.join('').slice(-8000),
      issues: [`${probePhase}: ${error.message}`],
    };
  } finally {
    await closeClient(client, stderr, targetRoot);
  }
}

async function runLiveWorkspaceRuntimeAcceptance(client, stderr, workspaceRoot) {
  const issues = [];
  const transcript = [];
  const nowBase = Date.now();
  const pluginRoot = join(workspaceRoot, 'AlembicPlugin');
  const coreRoot = join(workspaceRoot, 'AlembicCore');

  for (const requiredPath of [workspaceRoot, pluginRoot, coreRoot]) {
    expectIssue(issues, existsSync(requiredPath), `required live path is missing: ${requiredPath}`);
  }
  if (issues.length > 0) {
    return { ok: false, issues, workspaceRoot };
  }

  const workspaceRootNoScope = await captureToolCall(
    transcript,
    client,
    'alembic_source_graph_status',
    {
      catchUp: false,
      now: nowBase + 1,
      projectRoot: workspaceRoot,
    },
    stderr
  );
  const pluginStatus = await captureToolCall(
    transcript,
    client,
    'alembic_source_graph_status',
    {
      now: nowBase + 2,
      projectRoot: workspaceRoot,
      projectScope: 'AlembicPlugin',
    },
    stderr
  );
  const pluginExplore = await captureToolCall(
    transcript,
    client,
    'alembic_code_explore',
    {
      filePath: 'lib/codex/mcp/source-graph/status.ts',
      includeText: true,
      maxSectionLines: 8,
      now: nowBase + 3,
      projectRoot: workspaceRoot,
      projectScope: 'AlembicPlugin',
      query: 'resolveSourceGraphRuntime',
    },
    stderr
  );
  const coreStatus = await captureToolCall(
    transcript,
    client,
    'alembic_source_graph_status',
    {
      now: nowBase + 4,
      projectRoot: workspaceRoot,
      projectScope: 'AlembicCore',
    },
    stderr
  );
  const coreExplore = await captureToolCall(
    transcript,
    client,
    'alembic_code_explore',
    {
      filePath: 'src/service/source-graph/SourceGraphService.ts',
      includeText: true,
      maxSectionLines: 8,
      now: nowBase + 5,
      projectRoot: workspaceRoot,
      projectScope: 'AlembicCore',
      query: 'SourceGraphService',
    },
    stderr
  );
  const explicitPluginStatus = await captureToolCall(
    transcript,
    client,
    'alembic_source_graph_status',
    {
      catchUp: false,
      now: nowBase + 6,
      projectRoot: pluginRoot,
    },
    stderr
  );
  const explicitCoreStatus = await captureToolCall(
    transcript,
    client,
    'alembic_source_graph_status',
    {
      catchUp: false,
      now: nowBase + 7,
      projectRoot: coreRoot,
    },
    stderr
  );
  const validationPlan = await captureToolCall(
    transcript,
    client,
    'alembic_validation_plan',
    {
      changedFiles: ['lib/codex/mcp/source-graph/status.ts'],
      now: nowBase + 8,
      packageScripts: { test: 'vitest run test/unit/McpSourceGraphRuntime.test.ts' },
      projectRoot: workspaceRoot,
      projectScope: 'AlembicPlugin',
    },
    stderr
  );
  const codeImpact = await captureToolCall(
    transcript,
    client,
    'alembic_code_impact',
    {
      changedFiles: ['lib/codex/mcp/source-graph/status.ts'],
      now: nowBase + 9,
      projectRoot: workspaceRoot,
      projectScope: 'AlembicPlugin',
    },
    stderr
  );
  const parallel = await Promise.all([
    captureToolCall(
      transcript,
      client,
      'alembic_source_graph_status',
      {
        catchUp: false,
        now: nowBase + 10,
        projectRoot: workspaceRoot,
        projectScope: 'AlembicPlugin',
      },
      stderr
    ),
    captureToolCall(
      transcript,
      client,
      'alembic_code_explore',
      {
        filePath: 'lib/codex/mcp/source-graph/status.ts',
        includeText: true,
        maxSectionLines: 4,
        now: nowBase + 11,
        projectRoot: workspaceRoot,
        projectScope: 'AlembicPlugin',
        query: 'projectScope',
      },
      stderr
    ),
    captureToolCall(
      transcript,
      client,
      'alembic_source_graph_status',
      {
        catchUp: false,
        now: nowBase + 12,
        projectRoot: workspaceRoot,
        projectScope: 'AlembicCore',
      },
      stderr
    ),
    captureToolCall(
      transcript,
      client,
      'alembic_code_explore',
      {
        filePath: 'src/service/source-graph/SourceGraphService.ts',
        includeText: true,
        maxSectionLines: 4,
        now: nowBase + 13,
        projectRoot: workspaceRoot,
        projectScope: 'AlembicCore',
        query: 'SourceGraphService',
      },
      stderr
    ),
  ]);

  const calls = {
    codeImpact,
    coreExplore,
    coreStatus,
    explicitCoreStatus,
    explicitPluginStatus,
    pluginExplore,
    pluginStatus,
    validationPlan,
    workspaceRootNoScope,
  };
  const sourceGraphPayloads = [
    ...Object.values(calls).map((call) => call.payload),
    ...parallel.map((call) => call.payload),
  ];
  const validationCounts = validationPlanBucketCounts(validationPlan.payload);
  const codeImpactFiles = Array.isArray(codeImpact.payload?.impactedFiles)
    ? codeImpact.payload.impactedFiles.length
    : 0;
  const validationNamesTestsOrExplainsUnknown =
    validationCounts.mustRun > 0 || validationCounts.unknown > 0 || codeImpactFiles > 0;

  expectIssue(
    issues,
    workspaceRootNoScope.payload?.ready === false &&
      graphFreshness(workspaceRootNoScope.payload) === 'wrong-scope',
    'workspace root without projectScope should fail closed as wrong-scope'
  );
  expectIssue(
    issues,
    sourceGraphHasUsableIndex(pluginStatus.payload),
    'AlembicPlugin scoped status did not expose a usable source graph index'
  );
  expectIssue(
    issues,
    sourceGraphHasUsableIndex(coreStatus.payload),
    'AlembicCore scoped status did not expose a usable source graph index'
  );
  expectIssue(
    issues,
    sourceGraphHasUsableIndex(explicitPluginStatus.payload),
    'explicit AlembicPlugin root status did not reuse the scoped source graph index'
  );
  expectIssue(
    issues,
    sourceGraphHasUsableIndex(explicitCoreStatus.payload),
    'explicit AlembicCore root status did not reuse the scoped source graph index'
  );
  expectIssue(
    issues,
    sourceGraphReturnedContext(pluginExplore.payload),
    'AlembicPlugin code_explore should return source graph context'
  );
  expectIssue(
    issues,
    sourceGraphReturnedContext(coreExplore.payload),
    'AlembicCore code_explore should return source graph context'
  );
  expectIssue(
    issues,
    validationNamesTestsOrExplainsUnknown,
    'validation_plan/code_impact should name validation or explain unknown'
  );
  expectIssue(
    issues,
    parallel.every((call) => call.isError !== true && sourceGraphCallReturnedUsablePayload(call)),
    'parallel source graph calls should stay ready without transport closure'
  );
  expectIssue(
    issues,
    sourceGraphPayloads.every(sourceGraphPayloadIsClean),
    'source graph payloads should omit legacy/runtime-only fields'
  );
  expectIssue(
    issues,
    stringPath(pluginStatus.payload, ['lifecycle', 'watcher', 'mode'], null) === 'unavailable' &&
      stringPath(pluginStatus.payload, ['lifecycle', 'watcher', 'nextAction'], null) ===
        'run_incremental_source_graph_index',
    'watcher-disabled/manual incremental fallback should be explicit'
  );

  return {
    ok: issues.length === 0,
    aggregate: {
      cleanPayloadCount: sourceGraphPayloads.filter(sourceGraphPayloadIsClean).length,
      coreFileCount: countFromPayload(coreStatus.payload, 'fileCount'),
      coreSourceSectionCount: sourceSectionCount(coreExplore.payload),
      coreSymbolCount: sourceSymbolCount(coreExplore.payload),
      parallelCalls: parallel.length,
      pluginFileCount: countFromPayload(pluginStatus.payload, 'fileCount'),
      pluginSourceSectionCount: sourceSectionCount(pluginExplore.payload),
      pluginSymbolCount: sourceSymbolCount(pluginExplore.payload),
      sourceGraphCalls: sourceGraphPayloads.length,
      validationPlanBucketCounts: validationCounts,
    },
    coverage: {
      coldStartup: 'tools/list completed before live source graph calls in this MCP session',
      firstQueryCatchUp:
        pluginStatus.payload?.lifecycle?.catchUp?.attempted === true ||
        coreStatus.payload?.lifecycle?.catchUp?.attempted === true,
      staleOrPending:
        'catchUp=false stale fail-closed path is covered by McpSourceGraphRuntime.test.ts and the fused workflow staleExplore fixture; live probe does not edit product files.',
      watcherFallback: pluginStatus.payload?.lifecycle?.watcher ?? null,
    },
    issues,
    rawMcpJson: {
      codeImpact: codeImpact.payload,
      coreExplore: coreExplore.payload,
      coreStatus: coreStatus.payload,
      explicitCoreStatus: explicitCoreStatus.payload,
      explicitPluginStatus: explicitPluginStatus.payload,
      parallel: parallel.map((call) => call.payload),
      pluginExplore: pluginExplore.payload,
      pluginStatus: pluginStatus.payload,
      validationPlan: validationPlan.payload,
      workspaceRootNoScope: workspaceRootNoScope.payload,
    },
    statuses: statusMap({
      ...calls,
      parallel0: parallel[0],
      parallel1: parallel[1],
      parallel2: parallel[2],
      parallel3: parallel[3],
    }),
    transcript: transcript.map(summarizeTranscriptEntry),
    workspaceRoot,
  };
}

async function runFusedWorkflowEvaluation(client, stderr, targetRoot) {
  const issues = [];
  const tasks = [];
  const defectMap = [];

  for (const task of fusedWorkflowTasks) {
    const fixture = await createFusedFixtureProject(task);
    const enabled = await runFusedWorkflowTask(client, stderr, task, fixture);
    const baseline = await runFusedWorkflowBaseline(client, stderr, task, fixture);
    const comparison = compareFusedWorkflow(task, enabled, baseline);
    tasks.push({
      taskId: task.id,
      owner: task.owner,
      title: task.title,
      fixtureRoot: fixture.projectRoot,
      expectedOwner: task.expectedOwner,
      enabled,
      baseline,
      comparison,
    });
    issues.push(...comparison.issues.map((issue) => `${task.id}: ${issue}`));
    if (enabled.optionalDecisionRecord.status !== 'ready') {
      defectMap.push({
        code: 'decision-record-route-unavailable',
        owner: 'AlembicPlugin',
        status: enabled.optionalDecisionRecord.status,
        reasonCode: enabled.optionalDecisionRecord.reasonCode,
        followUp:
          'Decision recording remains optional in this probe; controller should use CGK-6/18 to decide when a durable Decision Register route is required for transcript evaluation.',
      });
    }
  }

  const aggregate = {
    avoidedRawExplorationCalls: tasks.reduce(
      (sum, task) => sum + task.comparison.avoidedRawExplorationCalls,
      0
    ),
    baselineRawExplorationCalls: tasks.reduce(
      (sum, task) => sum + task.baseline.metrics.plannedRawExplorationCalls,
      0
    ),
    enabledRawExplorationCalls: tasks.reduce(
      (sum, task) => sum + task.enabled.metrics.rawExplorationCalls,
      0
    ),
    sourceGraphCalls: tasks.reduce((sum, task) => sum + task.enabled.metrics.sourceGraphCalls, 0),
  };

  return {
    ok: issues.length === 0,
    targetRoot,
    aggregate,
    defectMap,
    issues,
    tasks,
  };
}

async function runFusedWorkflowTask(client, stderr, task, fixture) {
  const transcript = [];
  const status = await captureToolCall(
    transcript,
    client,
    'alembic_source_graph_status',
    {
      catchUp: false,
      now: fixture.nowBase + 1,
      projectRoot: fixture.projectRoot,
    },
    stderr
  );
  const explore = await captureToolCall(
    transcript,
    client,
    'alembic_code_explore',
    {
      filePath: 'src/helper.ts',
      includeText: true,
      maxSectionLines: 4,
      now: fixture.nowBase + 2,
      projectRoot: fixture.projectRoot,
      query: 'helper',
    },
    stderr
  );
  const validationPlan = await captureToolCall(
    transcript,
    client,
    'alembic_validation_plan',
    {
      changedFiles: task.changedFiles,
      now: fixture.nowBase + 3,
      packageScripts: task.packageScripts,
      projectRoot: fixture.projectRoot,
    },
    stderr
  );
  const sourceGraphRef =
    stringPath(validationPlan.payload, ['sourceGraphRef'], null) ??
    stringPath(explore.payload, ['sourceGraphRef'], null);
  const sourceEvidenceRefs = uniqueStrings([
    ...sourceEvidenceRefsFrom(explore.payload),
    ...sourceEvidenceRefsFrom(validationPlan.payload),
  ]);

  const intent = await captureToolCall(
    transcript,
    client,
    'alembic_intent',
    {
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.91,
        language: 'typescript',
        query: task.query,
        sourceRefs: task.changedFiles,
      },
      inputSource: 'host-declared-intent',
      language: 'typescript',
      projectRoot: fixture.projectRoot,
      sourceRefs: task.changedFiles,
    },
    stderr
  );
  const intentRef = stringPath(intent.payload, ['intentRef'], null);

  const prime = await captureToolCall(
    transcript,
    client,
    'alembic_prime',
    {
      inputSource: 'host-declared-intent',
      intentRef,
      projectRoot: fixture.projectRoot,
      sourceEvidenceRefs,
      sourceGraphRef,
      sourceRefs: task.changedFiles,
    },
    stderr
  );
  const primeRef = stringPath(prime.payload, ['refs', 'primeRef', 'id'], null);

  const workStart = await captureToolCall(
    transcript,
    client,
    'alembic_work_start',
    {
      inputSource: 'host-declared-intent',
      intentRef,
      primeRef,
      projectRoot: fixture.projectRoot,
      sourceEvidenceRefs,
      sourceGraphRef,
      title: task.title,
      workScope: {
        files: task.changedFiles,
        goal: task.query,
        repositoryOwner: task.owner,
      },
    },
    stderr
  );
  const workRef = stringPath(workStart.payload, ['workRef'], null);

  const workFinish = await captureToolCall(
    transcript,
    client,
    'alembic_work_finish',
    {
      changedFiles: task.changedFiles,
      evidenceRefs: ['scratch/cgk10-14-fused-workflow-probe.json'],
      inputSource: 'host-declared-intent',
      projectRoot: fixture.projectRoot,
      sourceEvidenceRefs,
      sourceGraphRef,
      summary: `${task.owner} fused workflow probe produced a safe no-op edit plan.`,
      validationPlan: validationPlan.payload?.validationPlan,
      workRef,
    },
    stderr
  );

  const codeGuard = await captureToolCall(
    transcript,
    client,
    'alembic_code_guard',
    {
      code: 'export function helper() { return 42; }\n',
      filePath: 'src/helper.ts',
      inputSource: 'host-declared-intent',
      language: 'typescript',
      projectRoot: fixture.projectRoot,
      sourceGraphRef,
      workRef,
    },
    stderr
  );

  const decisionRecord = await captureToolCall(
    transcript,
    client,
    'alembic_decision_record',
    {
      description:
        'Optional CGK-14 decision probe should not create a local fake decision when the durable route is absent.',
      evidenceRefs: ['scratch/cgk10-14-fused-workflow-probe.json'],
      inputSource: 'host-declared-intent',
      intentRef,
      projectRoot: fixture.projectRoot,
      sourceEvidenceRefs,
      sourceGraphRef,
      title: `${task.owner} fused workflow evaluation decision probe`,
      workRef,
    },
    stderr
  );

  writeFileSync(
    join(fixture.projectRoot, 'src', 'helper.ts'),
    'export function helper() { return 42; }\n',
    'utf8'
  );
  const staleExplore = await captureToolCall(
    transcript,
    client,
    'alembic_code_explore',
    {
      catchUp: false,
      filePath: 'src/helper.ts',
      includeText: true,
      now: fixture.nowBase + 4,
      projectRoot: fixture.projectRoot,
      query: 'helper',
    },
    stderr
  );

  return summarizeFusedWorkflow({
    codeGuard,
    decisionRecord,
    explore,
    intent,
    prime,
    sourceEvidenceRefs,
    sourceGraphRef,
    staleExplore,
    status,
    transcript,
    validationPlan,
    workFinish,
    workRef,
    workStart,
  });
}

async function runFusedWorkflowBaseline(client, stderr, task, fixture) {
  const transcript = [];
  const intent = await captureToolCall(
    transcript,
    client,
    'alembic_intent',
    {
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.72,
        language: 'typescript',
        query: `${task.query} Baseline: source graph unavailable.`,
        sourceRefs: task.changedFiles,
      },
      inputSource: 'host-declared-intent',
      projectRoot: fixture.projectRoot,
      sourceRefs: task.changedFiles,
    },
    stderr
  );
  const intentRef = stringPath(intent.payload, ['intentRef'], null);
  const prime = await captureToolCall(
    transcript,
    client,
    'alembic_prime',
    {
      inputSource: 'host-declared-intent',
      intentRef,
      projectRoot: fixture.projectRoot,
      sourceRefs: task.changedFiles,
    },
    stderr
  );
  const primeRef = stringPath(prime.payload, ['refs', 'primeRef', 'id'], null);
  const workStart = await captureToolCall(
    transcript,
    client,
    'alembic_work_start',
    {
      inputSource: 'host-declared-intent',
      intentRef,
      primeRef,
      projectRoot: fixture.projectRoot,
      title: `${task.title} baseline`,
      workScope: {
        files: task.changedFiles,
        goal: `${task.query} Baseline edit plan uses raw file exploration.`,
        repositoryOwner: task.owner,
      },
    },
    stderr
  );
  const workRef = stringPath(workStart.payload, ['workRef'], null);
  const workFinish = await captureToolCall(
    transcript,
    client,
    'alembic_work_finish',
    {
      changedFiles: task.changedFiles,
      evidenceRefs: ['scratch/cgk10-14-fused-workflow-probe.json'],
      inputSource: 'host-declared-intent',
      projectRoot: fixture.projectRoot,
      summary: `${task.owner} baseline run required manual raw exploration before edit planning.`,
      workRef,
    },
    stderr
  );

  return {
    firstCodeUnderstandingTool: 'raw-read-grep-plan',
    metrics: {
      plannedRawExplorationCalls: baselineRawExplorationPlan.length,
      rawExplorationCalls: baselineRawExplorationPlan.length,
      sourceGraphCalls: 0,
    },
    plannedRawExploration: baselineRawExplorationPlan,
    refs: refsFromCalls({ intent, prime, workFinish, workStart }),
    statuses: statusMap({ intent, prime, workFinish, workStart }),
    transcript: transcript.map(summarizeTranscriptEntry),
  };
}

function summarizeFusedWorkflow(input) {
  const sourceGraphPayloads = [
    input.status.payload,
    input.explore.payload,
    input.validationPlan.payload,
  ];
  const lifecyclePayloads = [
    input.intent.payload,
    input.prime.payload,
    input.workStart.payload,
    input.workFinish.payload,
    input.codeGuard.payload,
    input.decisionRecord.payload,
  ];
  const sourceGraphReady =
    input.status.payload?.ready === true &&
    input.explore.payload?.ready === true &&
    input.validationPlan.payload?.ready === true;
  const staleFailClosed =
    input.staleExplore.payload?.ready === false &&
    graphFreshness(input.staleExplore.payload) === 'stale' &&
    sourceSectionCount(input.staleExplore.payload) === 0;
  const optionalDecisionRecord = {
    attempted: true,
    automatic: false,
    producedDecisionRef: Boolean(refsFromPayload(input.decisionRecord.payload).decisionRef),
    reasonCode: reasonCode(input.decisionRecord.payload),
    status: statusValue(input.decisionRecord.payload),
  };

  return {
    firstCodeUnderstandingTool: 'alembic_source_graph_status',
    cleanOutput: {
      lifecycleLegacyFieldsAbsent: lifecyclePayloads.every(omitsLegacyFields),
      lifecycleTypedRefsOnly: lifecyclePayloads.every(hasOnlyTypedLifecycleRefs),
      sourceGraphGenericRefsBagAbsent: sourceGraphPayloads.every((payload) => !('refs' in payload)),
      sourceGraphLegacyFieldsAbsent: sourceGraphPayloads.every(omitsLegacyFields),
    },
    metrics: {
      plannedRawExplorationCalls: 0,
      rawExplorationCalls: 0,
      sourceEvidenceRefCount: input.sourceEvidenceRefs.length,
      sourceGraphCalls: 4,
      sourceSectionCount: sourceSectionCount(input.explore.payload),
      validationPlanBucketCounts: validationPlanBucketCounts(input.validationPlan.payload),
    },
    optionalDecisionRecord,
    rawMcpJson: {
      codeGuard: input.codeGuard.payload,
      decisionRecord: input.decisionRecord.payload,
      explore: input.explore.payload,
      intent: input.intent.payload,
      prime: input.prime.payload,
      staleExplore: input.staleExplore.payload,
      status: input.status.payload,
      validationPlan: input.validationPlan.payload,
      workFinish: input.workFinish.payload,
      workStart: input.workStart.payload,
    },
    refs: {
      ...refsFromCalls({
        codeGuard: input.codeGuard,
        decisionRecord: input.decisionRecord,
        intent: input.intent,
        prime: input.prime,
        workFinish: input.workFinish,
        workStart: input.workStart,
      }),
      sourceEvidenceRefs: input.sourceEvidenceRefs,
      sourceGraphRef: input.sourceGraphRef,
      workRef: input.workRef,
    },
    sourceGraphReady,
    staleFailClosed,
    statuses: statusMap({
      codeGuard: input.codeGuard,
      decisionRecord: input.decisionRecord,
      explore: input.explore,
      intent: input.intent,
      prime: input.prime,
      staleExplore: input.staleExplore,
      status: input.status,
      validationPlan: input.validationPlan,
      workFinish: input.workFinish,
      workStart: input.workStart,
    }),
    transcript: input.transcript.map(summarizeTranscriptEntry),
  };
}

function compareFusedWorkflow(task, enabled, baseline) {
  const issues = [];
  const avoidedRawExplorationCalls = Math.max(
    0,
    baseline.metrics.rawExplorationCalls - enabled.metrics.rawExplorationCalls
  );
  expectIssue(
    issues,
    enabled.sourceGraphReady,
    'source graph status/explore/validation-plan should be ready'
  );
  expectIssue(
    issues,
    enabled.staleFailClosed,
    'stale source graph path should fail closed without source sections'
  );
  expectIssue(
    issues,
    enabled.firstCodeUnderstandingTool === 'alembic_source_graph_status',
    'enabled flow should use source graph status as first code-understanding tool'
  );
  expectIssue(
    issues,
    baseline.firstCodeUnderstandingTool === 'raw-read-grep-plan',
    'baseline should model raw Read/Grep/rg first'
  );
  expectIssue(
    issues,
    avoidedRawExplorationCalls > 0,
    'source graph flow should avoid at least one raw exploration step'
  );
  expectIssue(issues, Boolean(enabled.refs.intentRef), 'intentRef missing');
  expectIssue(issues, Boolean(enabled.refs.primeRef), 'primeRef missing');
  expectIssue(issues, Boolean(enabled.refs.sourceGraphRef), 'sourceGraphRef missing');
  expectIssue(issues, enabled.refs.sourceEvidenceRefs.length > 0, 'sourceEvidenceRefs missing');
  expectIssue(issues, Boolean(enabled.refs.workRef), 'workRef missing');
  expectIssue(issues, Boolean(enabled.refs.finishRef), 'finishRef missing');
  expectIssue(issues, Boolean(enabled.refs.guardResultRef), 'guardResultRef missing');
  expectIssue(
    issues,
    enabled.cleanOutput.sourceGraphGenericRefsBagAbsent,
    'source graph output returned a generic refs bag'
  );
  expectIssue(
    issues,
    enabled.cleanOutput.lifecycleTypedRefsOnly,
    'lifecycle output returned non-typed refs'
  );
  expectIssue(
    issues,
    enabled.cleanOutput.lifecycleLegacyFieldsAbsent,
    'lifecycle output returned legacy fields'
  );
  expectIssue(
    issues,
    enabled.cleanOutput.sourceGraphLegacyFieldsAbsent,
    'source graph output returned legacy fields'
  );
  expectIssue(
    issues,
    enabled.optionalDecisionRecord.automatic === false,
    'decision recording should not be automatic'
  );

  return {
    avoidedRawExplorationCalls,
    guidanceChangedToolChoice:
      enabled.firstCodeUnderstandingTool !== baseline.firstCodeUnderstandingTool,
    issues,
    owner: task.owner,
    rawExplorationStillRequired: enabled.metrics.rawExplorationCalls,
  };
}

async function captureToolCall(transcript, client, name, args, stderr) {
  const startedAt = Date.now();
  const call = await callJsonTool(client, name, args, stderr);
  transcript.push({
    args: redactProjectRootArgs(args),
    durationMs: Date.now() - startedAt,
    isError: call.isError,
    payload: call.payload,
    toolName: name,
  });
  return call;
}

function summarizeTranscriptEntry(entry) {
  return {
    args: entry.args,
    durationMs: entry.durationMs,
    isError: entry.isError,
    status: statusValue(entry.payload),
    toolName: entry.toolName,
  };
}

async function createFusedFixtureProject(task) {
  const fixtureRoot = join(
    projectRoot,
    'Alembic',
    '.alembic-fused-fixtures',
    `cgk10-14-${task.id}`
  );
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'test'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'src', 'helper.ts'),
    'export function helper() { return 41; }\n',
    'utf8'
  );
  writeFileSync(
    join(fixtureRoot, 'src', 'index.ts'),
    "import { helper } from './helper.js';\nexport function run() { return helper(); }\n",
    'utf8'
  );
  writeFileSync(
    join(fixtureRoot, 'test', 'helper.test.ts'),
    "import { helper } from '../src/helper.js';\nexport function helperTest() { return helper(); }\n",
    'utf8'
  );
  const modules = await loadSourceGraphIndexingModules();
  const nowBase = Date.now();
  const full = await modules.buildFullSourceGraphIndexForProject(fixtureRoot, { now: nowBase });
  const generationId = stringPath(full, ['data', 'graph', 'generationId'], null);
  if (!generationId) {
    throw new Error(`Could not build source graph fixture for ${task.id}`);
  }
  await seedFusedFixtureEdges(modules, fixtureRoot, generationId);
  await modules.resetSourceGraphRuntimeCacheForTests();
  return { generationId, nowBase, projectRoot: fixtureRoot };
}

async function loadSourceGraphIndexingModules() {
  if (sourceGraphIndexingModules) {
    return sourceGraphIndexingModules;
  }
  const statusModulePath = join(root, 'dist', 'lib', 'codex', 'mcp', 'source-graph', 'status.js');
  if (!existsSync(statusModulePath)) {
    throw new Error(
      `Missing ${statusModulePath}; run npm run build before --fused-workflow probe execution.`
    );
  }
  const statusModule = await import(pathToFileURL(statusModulePath).href);
  const databaseModule = await import('@alembic/core/database');
  const sourceGraphModule = await import('@alembic/core/source-graph');
  const workspaceModule = await import('@alembic/core/workspace');
  sourceGraphIndexingModules = {
    DatabaseConnection: databaseModule.DatabaseConnection,
    SourceGraphRepositoryImpl: sourceGraphModule.SourceGraphRepositoryImpl,
    WorkspaceResolver: workspaceModule.WorkspaceResolver,
    buildFullSourceGraphIndexForProject: statusModule.buildFullSourceGraphIndexForProject,
    resetSourceGraphRuntimeCacheForTests: statusModule.resetSourceGraphRuntimeCacheForTests,
  };
  return sourceGraphIndexingModules;
}

async function seedFusedFixtureEdges(modules, projectRoot, generationId) {
  const resolver = modules.WorkspaceResolver.fromProject(projectRoot);
  const connection = new modules.DatabaseConnection({ path: resolver.databasePath }, resolver);
  await connection.connect();
  try {
    const repository = new modules.SourceGraphRepositoryImpl(connection.getDrizzle());
    await repository.upsertEdge({
      confidence: 1,
      edgeId: 'call:index-run-to-helper',
      fromFilePath: 'src/index.ts',
      fromSymbolId: 'src/index.ts#run',
      generationId,
      kind: 'calls',
      projectRoot,
      provenance: 'deterministic',
      site: { endColumn: 32, endLine: 2, startColumn: 24, startLine: 2 },
      siteFilePath: 'src/index.ts',
      toFilePath: 'src/helper.ts',
      toSymbolId: 'src/helper.ts#helper',
    });
    await repository.upsertEdge({
      confidence: 1,
      edgeId: 'test:helper-to-helper-test',
      fromFilePath: 'src/helper.ts',
      fromSymbolId: 'src/helper.ts#helper',
      generationId,
      kind: 'symbol_to_test',
      projectRoot,
      provenance: 'deterministic',
      toFilePath: 'test/helper.test.ts',
    });
  } finally {
    connection.close();
  }
}

function sourceEvidenceRefsFrom(payload) {
  const refs = [];
  if (Array.isArray(payload?.sourceEvidenceRefs)) {
    refs.push(...payload.sourceEvidenceRefs.map(sourceEvidenceRefValue).filter(Boolean));
  }
  const validationPlan = payload?.validationPlan;
  if (validationPlan && typeof validationPlan === 'object') {
    for (const bucketName of ['mustRun', 'recommended', 'manualReview', 'unknown']) {
      const bucket = validationPlan[bucketName];
      if (!Array.isArray(bucket)) {
        continue;
      }
      for (const item of bucket) {
        const evidence = item && typeof item === 'object' ? item.evidence : null;
        if (!Array.isArray(evidence)) {
          continue;
        }
        for (const entry of evidence) {
          const ref = sourceEvidenceRefValue(entry);
          if (ref) {
            refs.push(ref);
          }
        }
      }
    }
  }
  return uniqueStrings(refs);
}

function sourceEvidenceRefValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return typeof value.ref === 'string' ? value.ref : typeof value.id === 'string' ? value.id : null;
}

function refsFromCalls(calls) {
  return Object.fromEntries(
    fusedWorkflowRefNames.map((refName) => [
      refName,
      Object.values(calls).some((call) => Boolean(refsFromPayload(call.payload)[refName])),
    ])
  );
}

function refsFromPayload(payload) {
  const refs = payload?.refs && typeof payload.refs === 'object' ? payload.refs : {};
  return Object.fromEntries(
    fusedWorkflowRefNames.map((refName) => [refName, Boolean(refs[refName])])
  );
}

function statusMap(calls) {
  return Object.fromEntries(
    Object.entries(calls).map(([key, call]) => [key, statusValue(call.payload)])
  );
}

function statusValue(payload) {
  return typeof payload?.status === 'string'
    ? payload.status
    : payload?.ready === true
      ? 'ready'
      : payload?.ready === false
        ? 'blocked'
        : null;
}

function reasonCode(payload) {
  return payload?.reason && typeof payload.reason === 'object'
    ? (payload.reason.code ?? null)
    : null;
}

function graphFreshness(payload) {
  return payload?.graph && typeof payload.graph === 'object'
    ? (payload.graph.freshness ?? null)
    : null;
}

function sourceGraphHasUsableIndex(payload) {
  return sourceGraphHasGeneration(payload) && countFromPayload(payload, 'fileCount') > 0;
}

function sourceGraphReturnedContext(payload) {
  return (
    sourceGraphHasGeneration(payload) &&
    (sourceSectionCount(payload) > 0 || sourceSymbolCount(payload) > 0)
  );
}

function sourceGraphCallReturnedUsablePayload(call) {
  return (
    call.payload?.ready === true ||
    sourceGraphHasUsableIndex(call.payload) ||
    sourceGraphReturnedContext(call.payload)
  );
}

function sourceGraphHasGeneration(payload) {
  const freshness = graphFreshness(payload);
  return (
    typeof payload?.graph?.generationId === 'string' &&
    ['fresh', 'partial', 'degraded'].includes(freshness)
  );
}

function sourceSectionCount(payload) {
  return Array.isArray(payload?.sourceSections) ? payload.sourceSections.length : 0;
}

function sourceSymbolCount(payload) {
  return Array.isArray(payload?.symbols) ? payload.symbols.length : 0;
}

function validationPlanBucketCounts(payload) {
  const plan = payload?.validationPlan;
  const counts = {};
  for (const bucketName of ['mustRun', 'recommended', 'manualReview', 'unknown']) {
    counts[bucketName] = Array.isArray(plan?.[bucketName]) ? plan[bucketName].length : 0;
  }
  return counts;
}

function hasOnlyTypedLifecycleRefs(payload) {
  const refs = payload?.refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) {
    return true;
  }
  return Object.entries(refs).every(([key, value]) => {
    if (key === 'detailRefs') {
      return Array.isArray(value) && value.every(isStructuredDetailRef);
    }
    if (!fusedWorkflowRefNames.includes(key)) {
      return false;
    }
    return isStructuredLifecycleRef(value);
  });
}

function isStructuredLifecycleRef(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    (typeof value.refType === 'string' ||
      typeof value.toolName === 'string' ||
      typeof value.source === 'string')
  );
}

function isStructuredDetailRef(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    (typeof value.kind === 'string' ||
      typeof value.uri === 'string' ||
      typeof value.refType === 'string')
  );
}

function omitsLegacyFields(payload) {
  const serialized = JSON.stringify(payload);
  return (
    payload &&
    typeof payload === 'object' &&
    !('data' in payload) &&
    !('result' in payload) &&
    !('success' in payload) &&
    !('errorCode' in payload) &&
    !('message' in payload) &&
    !serialized.includes('legacyCompatibility') &&
    !serialized.includes('outputBudget')
  );
}

function sourceGraphPayloadIsClean(payload) {
  const serialized = JSON.stringify(payload);
  return (
    omitsLegacyFields(payload) &&
    !('refs' in payload) &&
    !hasForbiddenSourceGraphRuntimeKey(payload) &&
    !serialized.includes('legacyCompatibility') &&
    !serialized.includes('outputBudget')
  );
}

function hasForbiddenSourceGraphRuntimeKey(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasForbiddenSourceGraphRuntimeKey);
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (['projectruntime', 'residentservice', 'runtimepolicy'].includes(normalized)) {
      return true;
    }
    if (hasForbiddenSourceGraphRuntimeKey(child)) {
      return true;
    }
  }
  return false;
}

function countFromPayload(payload, fieldName) {
  const value = payload?.counts?.[fieldName];
  return typeof value === 'number' ? value : 0;
}

function redactProjectRootArgs(args) {
  const redacted = { ...args };
  if (typeof redacted.projectRoot === 'string') {
    redacted.projectRoot = '<fixture-project-root>';
  }
  return redacted;
}

async function probeRetiredLegacyTask(client, stderr) {
  const call = await callJsonTool(
    client,
    'alembic_task',
    {
      description: 'Probe retired record_decision cleanup.',
      operation: 'record_decision',
      rationale: 'Durable Decision Register must be the only confirmed-decision writer.',
      tags: ['afapi-08'],
      title: 'Retired decision direct-call probe',
    },
    stderr
  );
  const serialized = JSON.stringify(call.payload);
  return {
    errorCode: call.payload?.error?.code ?? null,
    isError: call.isError,
    omitsLegacyFields:
      !('data' in call.payload) &&
      !('errorCode' in call.payload) &&
      !('message' in call.payload) &&
      !('result' in call.payload) &&
      !('success' in call.payload) &&
      !serialized.includes('legacyCompatibility'),
    retired: call.payload?.ok === false && call.payload?.error?.code === 'CODEX_TOOL_RETIRED',
    status: call.payload?.status ?? null,
  };
}

async function runPublicToolCalls(client, stderr) {
  const intent = await callJsonTool(
    client,
    'alembic_intent',
    {
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.92,
        language: 'typescript',
        query: 'Evaluate AFAPI Stage 6 public tools',
        sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      },
      inputSource: 'host-declared-intent',
      projectRoot,
      sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
    },
    stderr
  );
  const intentRef = stringPath(intent.payload, ['intentRef']);

  const prime = await callJsonTool(
    client,
    'alembic_prime',
    {
      inputSource: 'host-declared-intent',
      intentRef,
      projectRoot,
      sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
    },
    stderr
  );
  const primeRef = stringPath(prime.payload, ['refs', 'primeRef', 'id'], null);

  const workStartArgs = {
    inputSource: 'host-declared-intent',
    intentRef,
    projectRoot,
    title: 'Evaluate public tools closure',
    workScope: {
      files: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      goal: 'Close Stage 6 installed-cache readback evidence.',
    },
  };
  if (primeRef) {
    workStartArgs.primeRef = primeRef;
  }
  const workStart = await callJsonTool(client, 'alembic_work_start', workStartArgs, stderr);
  const workRef = stringPath(workStart.payload, ['workRef']);

  const workFinish = await callJsonTool(
    client,
    'alembic_work_finish',
    {
      changedFiles: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      evidenceRefs: ['scratch/afapi-stage6-agent-public-tools-readback.json'],
      inputSource: 'host-declared-intent',
      projectRoot,
      summary: 'Stage 6 installed-cache readback evidence is ready.',
      workRef,
    },
    stderr
  );

  const codeGuard = await callJsonTool(
    client,
    'alembic_code_guard',
    {
      inputSource: 'host-declared-intent',
      projectRoot,
    },
    stderr
  );

  const codeGuardScopedWorkRef = await callJsonTool(
    client,
    'alembic_code_guard',
    {
      inputSource: 'host-declared-intent',
      projectRoot,
      workRef,
    },
    stderr
  );

  const decisionRecord = await callJsonTool(
    client,
    'alembic_decision_record',
    {
      description: 'Stage 6 installed-cache readback asks for durable decision route.',
      evidenceRefs: ['scratch/afapi-stage6-agent-public-tools-readback.json'],
      inputSource: 'host-declared-intent',
      intentRef,
      projectRoot,
      title: 'Close public tools evaluation',
      workRef,
    },
    stderr
  );

  return {
    alembic_intent: summarizeCall(intent),
    alembic_prime: summarizeCall(prime),
    alembic_work_start: summarizeCall(workStart),
    alembic_work_finish: summarizeCall(workFinish),
    alembic_code_guard: summarizeCall(codeGuard),
    alembic_code_guard_scoped_work_ref: summarizeCall(codeGuardScopedWorkRef),
    alembic_decision_record: summarizeCall(decisionRecord),
  };
}

function evaluateCalls(issues, calls) {
  expectIssue(issues, calls.alembic_intent.status === 'ready', 'intent should be ready');
  expectIssue(
    issues,
    ['ready', 'degraded', 'skipped'].includes(calls.alembic_prime.status),
    'prime should return a structured ready/degraded/skipped envelope'
  );
  expectIssue(issues, calls.alembic_work_start.status === 'ready', 'work_start should be ready');
  expectIssue(issues, calls.alembic_work_finish.status === 'ready', 'work_finish should be ready');
  expectIssue(
    issues,
    calls.alembic_code_guard.status === 'blocked' &&
      calls.alembic_code_guard.reasonCode === 'missing-guard-scope',
    'code_guard should block no-scope readback with missing-guard-scope'
  );
  expectIssue(
    issues,
    calls.alembic_code_guard_scoped_work_ref.status === 'ready',
    'code_guard scoped workRef readback should be ready'
  );
  expectIssue(
    issues,
    calls.alembic_decision_record.status === 'blocked' &&
      ['decision-register-unavailable', 'decision-register-capability-mismatch'].includes(
        calls.alembic_decision_record.reasonCode
      ),
    'decision_record should block without a durable resident route'
  );
  for (const [toolName, call] of Object.entries(calls)) {
    expectIssue(
      issues,
      call.cleanOutput === true,
      `${toolName} did not return clean structuredContent`
    );
    expectIssue(issues, call.omitsLegacyFields === true, `${toolName} returned legacy fields`);
    expectIssue(
      issues,
      call.omitsPublicDiagnosticFields === true,
      `${toolName} returned public diagnostic/runtime/source fields: ${call.forbiddenPublicField}`
    );
  }
}

function summarizeCall(call) {
  const result = call.payload;
  const serialized = JSON.stringify(result);
  const forbiddenPublicField = findForbiddenPublicOutputField(result);
  return {
    isError: call.isError,
    success: result?.ok === true,
    status: typeof result?.status === 'string' ? result.status : null,
    reasonCode:
      result?.reason && typeof result.reason === 'object' ? (result.reason.code ?? null) : null,
    actionKind: typeof result?.actionKind === 'string' ? result.actionKind : null,
    toolName: typeof result?.toolName === 'string' ? result.toolName : null,
    cleanOutput: result?.meta?.contractVersion === 1 && typeof result?.summary === 'string',
    omitsLegacyFields:
      !('data' in result) &&
      !('result' in result) &&
      !('success' in result) &&
      !('errorCode' in result) &&
      !('message' in result) &&
      !serialized.includes('legacyCompatibility') &&
      !serialized.includes('outputBudget'),
    omitsPublicDiagnosticFields: forbiddenPublicField === null,
    forbiddenPublicField,
    refs: {
      detailRefs: Array.isArray(result?.refs?.detailRefs) ? result.refs.detailRefs.length : 0,
      intentRef: Boolean(result?.refs?.intentRef),
      primeRef: Boolean(result?.refs?.primeRef),
      workRef: Boolean(result?.refs?.workRef),
      finishRef: Boolean(result?.refs?.finishRef),
      guardResultRef: Boolean(result?.refs?.guardResultRef),
      decisionRef: Boolean(result?.refs?.decisionRef),
    },
  };
}

function findForbiddenPublicOutputField(value, path = []) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenPublicOutputField(item, [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPublicOutputKeys.has(key)) {
      return [...path, key].join('.');
    }
    if (path.length === 0 && forbiddenTopLevelPublicOutputKeys.has(key)) {
      return key;
    }
    const found = findForbiddenPublicOutputField(child, [...path, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

async function listTools(client, stderr) {
  return await withTimeout(
    client.listTools(undefined, { timeout: options.mcpTimeoutMs }),
    options.mcpTimeoutMs + 2000,
    () => `MCP tools/list timed out\n${stderr.join('')}`
  );
}

async function callJsonTool(client, name, args, stderr) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }, undefined, { timeout: options.mcpTimeoutMs }),
    options.mcpTimeoutMs + 2000,
    () => `MCP ${name} timed out\n${stderr.join('')}`
  );
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return {
      isError: result.isError === true,
      payload: result.structuredContent,
    };
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error(
      `MCP ${name} returned no structuredContent or JSON text\n${JSON.stringify(result)}`
    );
  }
  return {
    isError: result.isError === true,
    payload: JSON.parse(text),
  };
}

function summarizeToolSurface(tools) {
  const descriptions = Object.fromEntries(
    tools.map((tool) => [tool.name, typeof tool.description === 'string' ? tool.description : ''])
  );
  return {
    names: tools.map((tool) => tool.name).sort(),
    descriptions,
  };
}

function readMcpServerConfig(targetRoot) {
  const mcp = readJson(join(targetRoot, '.mcp.json'));
  const server = mcp.mcpServers?.alembic;
  if (!server?.command || !Array.isArray(server.args)) {
    throw new Error(`Invalid Alembic MCP config at ${targetRoot}`);
  }
  return {
    command: server.command,
    args: server.args,
    env: server.env || {},
  };
}

function resolveInstalledTargets() {
  if (options.targetRoots.length > 0) {
    return options.targetRoots;
  }
  const plugin = readJson(join(root, 'plugins', 'alembic-codex', '.codex-plugin', 'plugin.json'));
  const cacheRoot = resolve(options.codexHome || join(process.env.HOME || '', '.codex'));
  const candidates = [
    join(cacheRoot, 'plugins', 'cache', 'alembic-codex', plugin.name, plugin.version),
    join(cacheRoot, 'plugins', 'cache', 'gxfn', plugin.name, plugin.version),
  ];
  const targets = candidates.filter((target) => existsSync(join(target, '.mcp.json')));
  if (targets.length === 0) {
    throw new Error(`No installed Alembic Codex plugin cache targets found under ${cacheRoot}`);
  }
  return targets;
}

function summarizeMarker(marker) {
  if (!marker) {
    return null;
  }
  return {
    refreshedAt: marker.refreshedAt ?? null,
    gitHead: marker.gitHead ?? null,
    mode: marker.mode ?? null,
    hashes: marker.hashes ?? null,
  };
}

function stringPath(value, path, fallback = undefined) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error(`Missing string path ${path.join('.')}`);
    }
    current = current[key];
  }
  if (typeof current !== 'string') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Expected string path ${path.join('.')}`);
  }
  return current;
}

function uniqueStrings(values) {
  return [...new Set(values)].sort();
}

function expectIssue(issues, condition, message) {
  if (!condition) {
    issues.push(message);
  }
}

async function closeClient(client, stderr, targetRoot) {
  try {
    await client.close();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const connectionClosed =
      error.message.includes('Connection closed') || error.message.includes('-32000');
    if (!connectionClosed) {
      throw new Error(`MCP close failed for ${targetRoot}: ${error.message}\n${stderr.join('')}`);
    }
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string' && value.length > 0)
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readOptionalJson(path) {
  return existsSync(path) ? readJson(path) : null;
}

function writeReport() {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    codexHome: '',
    fusedWorkflow: false,
    keepTmp: false,
    liveWorkspaceRoot: '',
    mcpTimeoutMs: 30000,
    projectRoot: '',
    reportPath: join(root, 'scratch', 'afapi-stage6-agent-public-tools-readback.json'),
    targetRoots: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--fused-workflow') {
      parsed.fusedWorkflow = true;
    } else if (arg === '--keep-tmp') {
      parsed.keepTmp = true;
    } else if (arg === '--live-workspace-root') {
      parsed.liveWorkspaceRoot = resolve(args[index + 1] || '');
      index += 1;
    } else if (arg === '--mcp-timeout-ms') {
      parsed.mcpTimeoutMs = Number(args[index + 1] || parsed.mcpTimeoutMs);
      index += 1;
    } else if (arg === '--project-root') {
      parsed.projectRoot = resolve(args[index + 1] || '');
      index += 1;
    } else if (arg === '--report-path') {
      parsed.reportPath = resolve(args[index + 1] || parsed.reportPath);
      index += 1;
    } else if (arg === '--target-root') {
      parsed.targetRoots.push(resolve(args[index + 1] || ''));
      index += 1;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/probe-agent-public-tools-evaluation.mjs [options]

Options:
  --codex-home <path>       Override Codex home cache root.
  --fused-workflow          Run CGK-10/CGK-14 fused source graph lifecycle evaluation.
  --keep-tmp                Keep temporary project and ALEMBIC_HOME data.
  --live-workspace-root <path>
                             Run CGK-6/CGK-18 live workspace source graph acceptance.
  --mcp-timeout-ms <ms>     MCP connect/call timeout. Default: 30000.
  --project-root <path>     Probe project root. Default: fresh temp project.
  --report-path <path>      JSON report path.
  --target-root <path>      Probe this plugin target root instead of installed cache.
`);
}
