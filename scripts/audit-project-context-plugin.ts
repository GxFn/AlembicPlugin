#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildProjectRuntimeContext } from '../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  routeGraphTool,
  routeRecipeMapTool,
} from '../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../lib/host-runtime/mcp/handlers/types.js';
import type { AlembicGraphOutput } from '../lib/service/project-knowledge-context/contracts/AlembicGraphOutput.js';
import type { AlembicRecipeMapOutput } from '../lib/service/project-knowledge-context/contracts/AlembicRecipeMapOutput.js';
import { ProjectContextBuildSessionManager } from '../lib/service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';

interface AuditArgs {
  mr5Root: string;
  outputDir: string;
  spRoot: string;
  timeoutMs: number;
}

interface ToolResult<T> {
  structuredContent: T;
}

interface ScenarioWorkerData {
  label: string;
  projectRoot: string;
}

interface CompletedScenarioProbe {
  result: Awaited<ReturnType<typeof probeScenario>>;
  status: 'completed';
}

interface IncompleteScenarioProbe {
  detail: string;
  label: string;
  status: 'failed' | 'timed-out';
}

type ScenarioProbe = CompletedScenarioProbe | IncompleteScenarioProbe;

if (isMainThread) {
  await main();
} else {
  const data = workerData as ScenarioWorkerData;
  try {
    const result = await probeScenario(data.label, data.projectRoot);
    parentPort?.postMessage({ result, status: 'completed' } satisfies CompletedScenarioProbe);
  } catch (error) {
    parentPort?.postMessage({
      detail: error instanceof Error ? error.message : String(error),
      label: data.label,
      status: 'failed',
    } satisfies IncompleteScenarioProbe);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outputDir, { recursive: true });

  const pluginRoot = process.cwd();
  const [mr5, sp] = await Promise.all([
    probeScenarioInWorker('MR5', args.mr5Root, args.timeoutMs),
    probeScenarioInWorker('SP-BILIDILI', args.spRoot, args.timeoutMs),
  ]);
  const completed = [mr5, sp].flatMap((probe) =>
    probe.status === 'completed' ? [probe.result] : []
  );
  const repository = repositoryIdentity(pluginRoot);
  const loadedCore = repositoryIdentity(path.resolve(pluginRoot, '../AlembicCore'));
  const runtime = {
    schemaVersion: 1,
    reportType: 'ProjectContextCapabilityRuntime.Plugin',
    taskId: 'i2-2-alembic-plugin-pcf-graph-map-t1',
    repository,
    loadedCore,
    probeDeadlineMs: args.timeoutMs,
    scenarios: [mr5, sp],
  };
  const bothCompleted = completed.length === 2;
  const audit = {
    schemaVersion: 1,
    reportType: 'ProjectContextCapabilityAuditReport.Plugin',
    taskId: 'i2-2-alembic-plugin-pcf-graph-map-t1',
    repository,
    loadedCore,
    invariants: {
      publicGraphTerminalReceiptsPresent:
        bothCompleted &&
        completed.every((scenario) => scenario.graph.terminalReceipt.phase === 'terminal'),
      progressAndTerminalAreDistinct:
        bothCompleted &&
        completed.every(
          (scenario) =>
            scenario.graph.firstReceipt.phase === 'progress' &&
            scenario.graph.terminalReceipt.phase === 'terminal'
        ),
      commandScriptsNeverReportedAsRepo:
        bothCompleted && completed.every((scenario) => scenario.map.commandScriptRepoCount === 0),
      mapCoverageNeverInvented:
        bothCompleted &&
        completed.every(
          (scenario) =>
            scenario.map.projectCoverageStatus !== 'complete' &&
            scenario.map.finalCoverageReceiptPresent === false
        ),
      perTypeContinuationAccountingPresent:
        bothCompleted && completed.every((scenario) => scenario.map.perTypeAccountingPresent),
      freshManagerSemanticIdentityCoveredByFocusedRegression: true,
    },
    boundary: {
      graphSource: 'request-scoped-live-project-context',
      recipeDependency: false,
      certifiedComparisonRequiresPersistedCarrier: true,
      genericLiveProbeVerdict: 'blocked-until-certified-carrier-is-present',
      finalDemandClaim: false,
      incompleteProbeConclusion: bothCompleted
        ? null
        : 'A failed or timed-out real-project probe is not passing evidence.',
      freshManagerSemanticIdentityEvidence:
        'test/unit/ProjectGraphTool.test.ts temporary-fixture regression',
    },
  };

  writeJson(path.join(args.outputDir, 'project-context-capability-runtime-plugin.json'), runtime);
  writeJson(path.join(args.outputDir, 'project-context-capability-audit-plugin.json'), audit);
}

async function probeScenarioInWorker(
  label: string,
  projectRoot: string,
  timeoutMs: number
): Promise<ScenarioProbe> {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { label, projectRoot } satisfies ScenarioWorkerData,
  });
  return new Promise((resolve) => {
    let settled = false;
    let timeoutTriggered = false;
    const finish = (probe: ScenarioProbe) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      void worker.terminate().finally(() => {
        finish({
          detail: `Read-only Graph/Map probe exceeded the ${timeoutMs}ms worker deadline.`,
          label,
          status: 'timed-out',
        });
      });
    }, timeoutMs);
    worker.once('message', (probe: ScenarioProbe) => finish(probe));
    worker.once('error', (error) => finish({ detail: error.message, label, status: 'failed' }));
    worker.once('exit', (code) => {
      if (code !== 0 && !timeoutTriggered) {
        finish({ detail: `Probe worker exited with code ${code}.`, label, status: 'failed' });
      }
    });
  });
}

async function probeScenario(label: string, projectRoot: string) {
  const manager = new ProjectContextBuildSessionManager({ ttlMs: 30_000 });
  const ctx = createContext(projectRoot, manager);
  try {
    const firstRun = await graphPages(projectRoot, ctx);
    const map = await recipeMapPages(projectRoot, ctx);
    return {
      label,
      graph: {
        firstReceipt: receiptSummary(firstRun.first.meta.projectContext?.liveProbeReceipt),
        terminalReceipt: receiptSummary(firstRun.terminal.meta.projectContext?.liveProbeReceipt),
        repoCoverage: firstRun.terminal.repoCoverage,
        status: firstRun.terminal.status,
        diagnostics: firstRun.terminal.diagnostics,
        projectContextMeta: firstRun.terminal.meta.projectContext ?? null,
        freshManagerSemanticIdentityStable: 'covered-by-focused-temporary-fixture-regression',
        recipeFieldsPresent: /recipeId|recipeMounts|recipeRollups/.test(
          JSON.stringify(firstRun.terminal)
        ),
      },
      map,
    };
  } finally {
    await manager.dispose();
  }
}

async function graphPages(projectRoot: string, ctx: McpContext) {
  let result = (await routeGraphTool(ctx, {
    pageSize: 100,
    projectRoot,
    queryKind: 'space',
  })) as unknown as ToolResult<AlembicGraphOutput>;
  const first = result.structuredContent;
  let terminal = first;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const cursor = terminal.continuation?.nextCursor;
    if (!cursor) {
      return { first, terminal };
    }
    result = (await routeGraphTool(ctx, {
      cursor,
      projectRoot,
    })) as unknown as ToolResult<AlembicGraphOutput>;
    terminal = result.structuredContent;
  }
  throw new Error(`${projectRoot} Graph continuation exceeded the page safety bound.`);
}

async function recipeMapPages(projectRoot: string, ctx: McpContext) {
  let result = (await routeRecipeMapTool(ctx, {
    focus: { kind: 'space' },
    includeRecipes: false,
    pageSize: 25,
    projectRoot,
  })) as unknown as ToolResult<AlembicRecipeMapOutput>;
  const first = result.structuredContent;
  let terminal = first;
  const scriptNodes = new Map<string, AlembicRecipeMapOutput['region']['rootNode']>();
  for (let pages = 0; pages < 10_000; pages += 1) {
    for (const node of [terminal.region.rootNode, ...terminal.region.nodes]) {
      if (node.label.startsWith('script:')) {
        scriptNodes.set(node.nodeId, node);
      }
    }
    const cursor = terminal.continuation?.nextCursor;
    if (!cursor) {
      const scripts = [...scriptNodes.values()];
      return {
        commandScriptRepoCount: scripts.filter((node) => node.kind === 'repo').length,
        commandScriptTargetCount: scripts.filter((node) => node.kind === 'target').length,
        finalCoverageReceiptPresent: terminal.finalCoverageReceipt !== null,
        firstTypeAccounting: first.continuation?.typeAccounting ?? null,
        mountAccountingCompleteness: terminal.conservation.mountAccountingCompleteness,
        perTypeAccountingPresent: Boolean(
          first.continuation?.typeAccounting && terminal.continuation?.typeAccounting
        ),
        projectCoverageStatus: terminal.projectCoverageStatus,
        terminalTypeAccounting: terminal.continuation?.typeAccounting ?? null,
      };
    }
    result = (await routeRecipeMapTool(ctx, {
      cursor,
      projectRoot,
    })) as unknown as ToolResult<AlembicRecipeMapOutput>;
    terminal = result.structuredContent;
  }
  throw new Error(`${projectRoot} Recipe Map continuation exceeded the page safety bound.`);
}

function createContext(
  projectRoot: string,
  buildSessions: ProjectContextBuildSessionManager
): McpContext {
  return {
    container: {
      get: () => undefined,
      singletons: { _projectRoot: projectRoot },
    },
    projectContextExecution: { buildSessions },
    projectRuntime: buildProjectRuntimeContext({ projectRoot }),
  } as unknown as McpContext;
}

function receiptSummary(
  receipt: NonNullable<AlembicGraphOutput['meta']['projectContext']>['liveProbeReceipt'] | undefined
) {
  if (!receipt) {
    throw new Error('Graph output is missing ProjectContextLiveProbeReceipt.');
  }
  return {
    phase: receipt.phase,
    verdict: receipt.verdict,
    comparisonStatus: receipt.comparisonStatus,
    canonicalScopeHash: receipt.canonicalScopeHash,
    observedSourceVectorHash: receipt.observedSourceVectorHash,
    certifiedSourceVectorHash: receipt.certifiedSourceVectorHash,
    terminalSemanticOutputHash: receipt.terminalSemanticOutputHash,
    repoIdentityHash: receipt.repoIdentityHash,
    moduleIdentityHash: receipt.moduleIdentityHash,
    blockingReasons: receipt.blockingReasons,
  };
}

function repositoryIdentity(repositoryRoot: string) {
  return {
    commit: git(repositoryRoot, ['rev-parse', 'HEAD']),
    tree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
  };
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv: string[]): AuditArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error('Audit arguments must be --name value pairs.');
    }
    values.set(key.slice(2), value);
  }
  const mr5Root = values.get('mr5-root');
  const spRoot = values.get('sp-root');
  const outputDir = values.get('output-dir');
  if (!mr5Root || !spRoot || !outputDir) {
    throw new Error('Required: --mr5-root, --sp-root, and --output-dir.');
  }
  const timeoutMs = Number.parseInt(values.get('timeout-ms') ?? '30000', 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer.');
  }
  return {
    mr5Root: path.resolve(mr5Root),
    outputDir: path.resolve(outputDir),
    spRoot: path.resolve(spRoot),
    timeoutMs,
  };
}
