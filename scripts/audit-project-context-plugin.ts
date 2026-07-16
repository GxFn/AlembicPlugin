#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { openAlembicDatabase } from '@alembic/core/database';
import {
  _resetGenerateSessionManagersForTesting,
  getOrCreateSessionManager,
} from '@alembic/core/host-agent-workflows';
import { FileCertifiedProjectFactsStore } from '@alembic/core/project-context-foundation';
import { createAlembicRepositories } from '@alembic/core/repositories';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { buildProjectRuntimeContext } from '../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  routeGraphTool,
  routePlanTool,
  routeRecipeMapTool,
} from '../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../lib/host-runtime/mcp/handlers/types.js';
import { PLUGIN_CORE_ALIGNED_SOURCE_POLICY } from '../lib/project-facts/PluginCertifiedProjectFactsProducer.js';
import {
  assertExactRepositoryTuples,
  openPluginCertifiedProjection,
  PLUGIN_CERTIFIED_ENTRYPOINTS,
  pluginCertifiedStoreRoot,
  readPluginCertifiedCarrierFromProjectContext,
} from '../lib/project-facts/PluginCertifiedProjectFactsRuntime.js';
import { runHostAgentColdStartWorkflow } from '../lib/recipe-pipeline/generate/cold-start.js';
import { runHostAgentDimensionCompletionWorkflow } from '../lib/recipe-pipeline/generate/dimension-completion.js';
import { createReadOnlyRecipeMapRepositories } from '../lib/repository/recipe-map/ReadOnlyRecipeMapServices.js';
import { ModuleService } from '../lib/service/module/ModuleService.js';
import {
  type AlembicGraphOutput,
  isProjectContextSuppressedObservationSummaryConserved,
} from '../lib/service/project-knowledge-context/contracts/AlembicGraphOutput.js';
import type { AlembicRecipeMapOutput } from '../lib/service/project-knowledge-context/contracts/AlembicRecipeMapOutput.js';
import { ProjectContextBuildSessionManager } from '../lib/service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { resolveScopeAwareWorkspace } from '../lib/shared/project-scope-runtime.js';

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
  auditHome: string;
  dataRoot: string;
  label: string;
  projectRoot: string;
}

interface AuditScopeRegistry {
  mr5AuditHome: string;
  mr5DataRoot: string;
  runtimeRoot: string;
  spAuditHome: string;
  spDataRoot: string;
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

const TASK_ID = 'i2-2-alembic-plugin-pcf-graph-map-rootcause3-t1';

if (isMainThread) {
  await main();
} else {
  const data = workerData as ScenarioWorkerData;
  try {
    const result = await probeScenario(data.label, data.projectRoot, data.dataRoot);
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
  const scopes = createAuditScopeRegistry(args);
  try {
    const pluginRoot = process.cwd();
    const sp = await probeScenarioInWorker(
      'SP-BILIDILI',
      args.spRoot,
      scopes.spDataRoot,
      scopes.spAuditHome,
      args.timeoutMs
    );
    const mr5 = await probeScenarioInWorker(
      'MR5',
      args.mr5Root,
      scopes.mr5DataRoot,
      scopes.mr5AuditHome,
      args.timeoutMs
    );
    const completed = [mr5, sp].flatMap((probe) =>
      probe.status === 'completed' ? [probe.result] : []
    );
    const repository = repositoryIdentity(pluginRoot);
    const loadedCore = repositoryIdentity(path.resolve(pluginRoot, '../AlembicCore'));
    const runtime = {
      schemaVersion: 1,
      reportType: 'ProjectContextCapabilityRuntime.Plugin',
      taskId: TASK_ID,
      repository,
      loadedCore,
      probeDeadlineMs: args.timeoutMs,
      scenarios: [mr5, sp],
    };
    const bothCompleted = completed.length === 2;
    const graphSuppressedObservationTruthReady =
      bothCompleted &&
      completed.every((scenario) => {
        const summary = scenario.graph.projectContextMeta?.suppressedObservations;
        return Boolean(
          summary &&
            isProjectContextSuppressedObservationSummaryConserved(summary) &&
            scenario.graph.projectContextMeta?.suppressedErrorCount === summary.observedCount &&
            summary.blockingCount === 0 &&
            summary.unclassifiedCount === 0
        );
      });
    const audit = {
      schemaVersion: 1,
      reportType: 'ProjectContextCapabilityAuditReport.Plugin',
      taskId: TASK_ID,
      repository,
      loadedCore,
      invariants: {
        graphAndMapTerminalReady:
          bothCompleted &&
          completed.every(
            (scenario) =>
              scenario.graph.status === 'ready' &&
              scenario.graph.errorDiagnosticCount === 0 &&
              graphSuppressedObservationTruthReady &&
              scenario.map.status === 'ready' &&
              scenario.map.errorDiagnosticCount === 0
          ),
        graphRecipeFree:
          bothCompleted &&
          completed.every((scenario) => scenario.graph.recipeFieldsPresent === false),
        graphIdentityDuplicatesZero:
          bothCompleted &&
          completed.every((scenario) => scenario.graph.duplicateIdentityCount === 0),
        graphSuppressedObservationsConserved: graphSuppressedObservationTruthReady,
        publicGraphTerminalReceiptsPresent:
          bothCompleted &&
          completed.every(
            (scenario) =>
              scenario.graph.terminalReceipt.phase === 'terminal' &&
              scenario.graph.terminalReceipt.verdict === 'passed' &&
              scenario.graph.terminalReceipt.comparisonStatus === 'matched'
          ),
        progressAndTerminalAreDistinct:
          bothCompleted &&
          completed.every(
            (scenario) =>
              scenario.graph.firstReceipt.phase === 'progress' &&
              scenario.graph.terminalReceipt.phase === 'terminal'
          ),
        commandScriptsNeverReportedAsRepo:
          bothCompleted && completed.every((scenario) => scenario.map.commandScriptRepoCount === 0),
        mapCoverageHasFinalCertifiedReceipt:
          bothCompleted &&
          completed.every(
            (scenario) =>
              scenario.map.projectCoverageStatus === 'complete' &&
              scenario.map.finalCoverageReceiptPresent === true
          ),
        perTypeContinuationAccountingPresent:
          bothCompleted && completed.every((scenario) => scenario.map.perTypeAccountingPresent),
        perTypeContinuationAccountingConserved:
          bothCompleted && completed.every((scenario) => scenario.map.perTypeAccountingConserved),
        allFiveConsumerReceiptsPersisted:
          bothCompleted && completed.every((scenario) => scenario.lineage.receiptCount === 5),
        exactFiveRepositoryScope:
          bothCompleted && completed.every((scenario) => scenario.lineage.repositoryCount === 5),
        uncappedModuleAxis:
          bothCompleted &&
          completed.every((scenario) => scenario.lineage.moduleCount > 0) &&
          completed.some((scenario) => scenario.lineage.moduleCount > 24),
        graphAndMapCompleteWithinSixtySeconds:
          bothCompleted &&
          completed.every(
            (scenario) =>
              scenario.phaseDurationsMs.graph < 60_000 && scenario.phaseDurationsMs.map < 60_000
          ),
        strictBypassCountersZero:
          bothCompleted && completed.every((scenario) => scenario.lineage.strictCountersZero),
        loadedEntrypointTraceComplete:
          bothCompleted && completed.every((scenario) => hasAllCertifiedConsumerTraces(scenario)),
        strictEntrypointDenominatorComplete:
          bothCompleted &&
          completed.every((scenario) => hasCompleteStrictEntrypointDenominator(scenario)),
        coreCanonicalSourcePolicyAligned:
          bothCompleted && completed.every((scenario) => scenario.lineage.coreAlignedSourcePolicy),
        eligibleScriptsRetainCertifiedSourceEvidence:
          bothCompleted &&
          completed.some((scenario) => scenario.lineage.eligibleScriptSourceCount > 0) &&
          completed.some((scenario) => scenario.lineage.eligibleScriptSourceRefCount > 0) &&
          completed.every((scenario) => scenario.lineage.eligibleScriptSourceConserved),
        pristineDataRootBeforePlan:
          bothCompleted && completed.every((scenario) => scenario.lineage.dataRootAbsentBeforePlan),
        freshManagerSemanticIdentityStable:
          bothCompleted &&
          completed.every((scenario) => scenario.lineage.freshManagerIdentityStable),
      },
      boundary: {
        graphSource: 'certified-foundation-envelopes-with-live-source-vector-probe',
        recipeDependency: false,
        certifiedComparisonRequiresPersistedCarrier: true,
        sourceRootsReadOnly: true,
        runtimeWritesConfinedToAuditOutput: true,
        i2AdapterChainOnly: true,
        i3ResetSingleFactsLlmPlan: 'pending',
        finalDemandClaim: false,
        incompleteProbeConclusion: bothCompleted
          ? null
          : 'A failed or timed-out real-project probe is not passing evidence.',
        globalLineageCandidate:
          'Main four upstream receipts plus the Plugin dimension-completion receipt; controller acceptance remains required.',
      },
    };

    writeJson(path.join(args.outputDir, 'project-context-capability-runtime-plugin.json'), runtime);
    writeJson(path.join(args.outputDir, 'project-context-capability-audit-plugin.json'), audit);
    if (!bothCompleted || Object.values(audit.invariants).some((value) => value !== true)) {
      throw new Error(
        'ProjectContext Plugin audit failed closed; inspect the runtime and audit JSON reports.'
      );
    }
  } finally {
    rmSync(scopes.runtimeRoot, { force: true, recursive: true });
  }
}

async function probeScenarioInWorker(
  label: string,
  projectRoot: string,
  dataRoot: string,
  auditHome: string,
  timeoutMs: number
): Promise<ScenarioProbe> {
  const worker = new Worker(new URL(import.meta.url), {
    env: { ...process.env, ALEMBIC_HOME: auditHome },
    workerData: { auditHome, dataRoot, label, projectRoot } satisfies ScenarioWorkerData,
  });
  return new Promise((resolve) => {
    let completionTriggered = false;
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
          detail: `Strict empty-start lineage probe exceeded the ${timeoutMs}ms worker deadline.`,
          label,
          status: 'timed-out',
        });
      });
    }, timeoutMs);
    worker.once('message', (probe: ScenarioProbe) => {
      completionTriggered = true;
      void worker.terminate().then(
        () => finish(probe),
        (error) =>
          finish({
            detail: `Probe worker cleanup failed: ${error instanceof Error ? error.message : String(error)}.`,
            label,
            status: 'failed',
          })
      );
    });
    worker.once('error', (error) => finish({ detail: error.message, label, status: 'failed' }));
    worker.once('exit', (code) => {
      if (code !== 0 && !timeoutTriggered && !completionTriggered) {
        finish({ detail: `Probe worker exited with code ${code}.`, label, status: 'failed' });
      }
    });
  });
}

async function probeScenario(label: string, projectRoot: string, dataRoot: string) {
  const startedAt = Date.now();
  const dataRootAbsentBeforePlan = !existsSync(dataRoot);
  const phaseTimingsMs: Record<string, number> = {};
  const mark = (phase: string) => {
    phaseTimingsMs[phase] = Date.now() - startedAt;
    process.stderr.write(`[pcf-audit] ${label} ${phase} ${phaseTimingsMs[phase]}ms\n`);
  };
  const { ctx, services } = createContext(projectRoot);
  if (path.resolve(ctx.projectRuntime?.identity.dataRoot ?? '') !== path.resolve(dataRoot)) {
    throw new Error(
      `${label} ProjectScope resolved an unexpected data root: ${String(ctx.projectRuntime?.identity.dataRoot)}`
    );
  }
  const buildSessions = new ProjectContextBuildSessionManager({ ttlMs: 30_000 });
  let databaseRuntime: Awaited<ReturnType<typeof openAlembicDatabase>> | null = null;
  let recipeDatabase: InstanceType<typeof Database> | null = null;
  ctx.projectContextExecution = { buildSessions };
  try {
    const draft = readToolResponse(
      await routePlanTool(ctx, {
        generationStage: 'coldStart',
        hints: { maxBudget: 512 },
        operation: 'draft',
        projectRoot,
      })
    );
    assertSuccessful(draft, `${label} Plan draft`);
    mark('plan-draft');
    const generateManager = getOrCreateSessionManager(ctx.container);
    const session = generateManager.getAnySession(undefined, { projectRoot });
    if (!session) {
      throw new Error(`${label} Plan draft did not persist its HostAgent session.`);
    }
    const planCarrier = readPluginCertifiedCarrierFromProjectContext(
      session.toSnapshot().projectContext
    );
    if (!planCarrier) {
      throw new Error(`${label} Plan draft did not persist its certified carrier.`);
    }

    const store = new FileCertifiedProjectFactsStore(pluginCertifiedStoreRoot(dataRoot));
    const artifact = await store.open(
      planCarrier.artifactId as never,
      planCarrier.certificationBindingHash as never
    );
    const exactTuples = artifact.manifest.sourceRevisionVector.entries.map((entry) => ({
      relativeRoot: entry.relativeRoot,
      repoId: entry.repoId,
      revision: entry.revision,
    }));
    assertExactRepositoryTuples({ artifact, observed: exactTuples });
    assertExpectedRepositories(label, exactTuples);
    mark('artifact-verified');

    const planProjection = await openPluginCertifiedProjection({
      carrier: planCarrier,
      dataRoot,
    });
    const scriptSources = eligibleScriptSourceEvidence(artifact, planProjection);
    const moduleService = new ModuleService(projectRoot, {
      certifiedFactsProvider: () => {
        const active = generateManager.getAnySession(undefined, { projectRoot });
        const carrier = active
          ? readPluginCertifiedCarrierFromProjectContext(active.toSnapshot().projectContext)
          : null;
        return active && carrier ? { carrier, dataRoot, projectRoot, session: active } : null;
      },
    });
    services.set('moduleService', moduleService);
    databaseRuntime = await openAlembicDatabase(
      { path: path.join(dataRoot, 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(projectRoot) }
    );
    const repositories = createAlembicRepositories(databaseRuntime.connection);
    services.set('database', databaseRuntime.connection);
    services.set('gitDiffCheckpointRepository', repositories.gitDiffCheckpointRepository);
    services.set('knowledgeRepository', repositories.knowledgeRepository);
    services.set('lifecycleEventRepository', repositories.lifecycleEventRepository);
    services.set('proposalGateway', {
      submit: async () => ({ id: `proposal-${label.toLowerCase()}` }),
    });
    services.set('proposalRepository', repositories.proposalRepository);
    services.set('recipeSourceRefRepository', repositories.recipeSourceRefRepository);
    mark('database-ready');
    const draftData = readRecord(draft.data);
    const projectInfoTree = readRecord(draftData.projectInfoTree);
    const confirmed = readToolResponse(
      await routePlanTool(ctx, {
        evidenceRefs: [
          {
            detail: `${label} certified ProjectInfoTree`,
            kind: 'project-context',
            ref: `projectInfoTree:${String(projectInfoTree.primaryLanguage)}:${String(projectInfoTree.fileCount)}`,
          },
        ],
        generationStage: 'coldStart',
        moduleBindings: [
          {
            dimensions: ['architecture'],
            modulePath: moduleBindingPath(planProjection.modules[0]?.ownedFiles[0]),
            targetRecipes: 3,
          },
        ],
        operation: 'confirm',
        plannedNextActions: [
          {
            reason: 'Exercise the pristine I2 adapter chain; the I3 rebuild remains pending.',
            tool: 'alembic_bootstrap',
          },
        ],
        projectProfile: {
          architectureHints: readRecordArray(projectInfoTree.children)
            .map((child) => String(child.path ?? ''))
            .filter(Boolean)
            .slice(0, 8),
          fileCount: Number(projectInfoTree.fileCount ?? 0),
          frameworks: stringArray(projectInfoTree.frameworks),
          moduleCount: Number(projectInfoTree.moduleCount ?? 0),
          primaryLanguage: String(projectInfoTree.primaryLanguage ?? 'unknown'),
          projectType: String(projectInfoTree.projectType ?? 'certified-project'),
          secondaryLanguages: stringArray(projectInfoTree.secondaryLanguages),
        },
        projectRoot,
        rationale: `${label} pristine I2 adapter audit without fallback; I3 remains pending.`,
        scale: {
          contentMaxLines: 120,
          depthLevels: ['project', 'module'],
          maxFiles: 5_000,
          totalRecipeBudget: 3,
        },
        selectedDimensions: [
          {
            dimensionId: 'architecture',
            priority: 1,
            rationale: 'Verify certified cross-repository architecture facts.',
            targetRecipes: 3,
          },
        ],
      })
    );
    assertSuccessful(confirmed, `${label} Plan confirm`);
    mark('plan-confirm');
    const planSelection = readRecord(readRecord(confirmed.data).planSelection);
    const coldStart = readToolResponse(
      await runHostAgentColdStartWorkflow(
        ctx as never,
        {
          planSelection,
          testMode: true,
        } as never
      )
    );
    assertSuccessful(coldStart, `${label} cold start`);
    mark('cold-start');

    recipeDatabase = new Database(path.join(dataRoot, 'recipe-map.db'));
    recipeDatabase.exec(`
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tags TEXT NOT NULL,
        sources TEXT NOT NULL
      );
      CREATE TABLE recipe_source_refs (
        recipe_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        status TEXT NOT NULL,
        new_path TEXT,
        verified_at INTEGER,
        PRIMARY KEY (recipe_id, source_path)
      );
    `);
    const mapSource = `${joinPortable(
      planProjection.files[0]?.repositoryRelativeRoot ?? '.',
      planProjection.files[0]?.relativePath ?? ''
    )}:1`;
    recipeDatabase
      .prepare('INSERT INTO knowledge_entries (id, title, tags, sources) VALUES (?, ?, ?, ?)')
      .run(
        'recipe-certified-audit',
        `${label} certified boundary`,
        '[]',
        JSON.stringify([mapSource])
      );
    recipeDatabase
      .prepare('INSERT INTO recipe_source_refs (recipe_id, source_path, status) VALUES (?, ?, ?)')
      .run('recipe-certified-audit', mapSource, 'active');
    recipeDatabase.pragma('query_only = ON');
    const recipeRepositories = createReadOnlyRecipeMapRepositories(recipeDatabase);
    services.set('knowledgeService', recipeRepositories.knowledgeService);
    services.set('recipeSourceRefRepository', recipeRepositories.sourceRefRepository);
    const firstRun = await graphPages(projectRoot, ctx);
    mark('graph-terminal');
    const map = await recipeMapPages(projectRoot, ctx);
    mark('map-terminal');
    const canonicalModules = await moduleService.listCanonicalModules();
    mark('module-axis');
    const beforeFifth = readPluginCertifiedCarrierFromProjectContext(
      session.toSnapshot().projectContext
    );
    if (!beforeFifth) {
      throw new Error(`${label} Graph/Map did not preserve the certified carrier.`);
    }
    const submitted = planProjection.files.slice(0, 3).map((file, index) => ({
      id: `recipe-${label.toLowerCase()}-${index + 1}`,
      source: `${joinPortable(file.repositoryRelativeRoot, file.relativePath)}:1`,
    }));
    if (submitted.length !== 3) {
      throw new Error(`${label} requires three certified source files for dimension evidence.`);
    }
    for (const recipe of submitted) {
      session.submissionTracker.recordSubmission(
        'architecture',
        {
          category: 'architecture',
          content: { markdown: `Verified ${recipe.id} from the certified source graph.` },
          coreCode: `struct ${recipe.id.replaceAll('-', '_')} {}`,
          kind: 'pattern',
          knowledgeType: 'pattern',
          reasoning: { confidence: 0.95, sources: [recipe.source] },
          sourceRefs: [recipe.source],
          title: recipe.id,
        },
        recipe.id
      );
    }
    services.set('knowledgeService', {
      get: async (recipeId: string) => ({ tags: ['certified'], title: recipeId }),
      update: async () => undefined,
    });
    services.set('coverageLedgerRepository', createCoverageLedgerRepository());
    const completion = readToolResponse(
      await runHostAgentDimensionCompletionWorkflow(
        ctx as never,
        {
          analysisText: longCertifiedAnalysis(label),
          dimensionId: 'architecture',
          keyFindings: [
            `${label} exact repository scope is bound to one certified source vector.`,
            'Plan, generation, dependency graph, and module coverage reopened the same artifact.',
            'The canonical module axis retains every owner beyond the historical twenty-four limit.',
          ],
          referencedFiles: submitted.map((recipe) => recipe.source.split(':')[0]),
          submittedRecipeIds: submitted.map((recipe) => recipe.id),
        },
        {
          createEmitter: () => ({
            emitAllComplete: () => undefined,
            emitDimensionComplete: () => undefined,
          }),
          generateSkill: async () => ({
            error: 'Real-project audit disables project-skill delivery writes.',
            success: false,
          }),
          getActiveSession: () => session as never,
          refreshKnowledgeSkills: () => ({
            data: { hasKnowledgeBase: false, refreshed: [], removed: [] },
            success: true,
          }),
          saveCheckpoint: async () => undefined,
        }
      )
    );
    assertSuccessful(completion, `${label} dimension completion`);
    mark('dimension-completion');
    const finalCarrier = readPluginCertifiedCarrierFromProjectContext(
      session.toSnapshot().projectContext
    );
    if (!finalCarrier) {
      throw new Error(`${label} dimension completion lost its certified carrier.`);
    }

    _resetGenerateSessionManagersForTesting();
    const fresh = createContext(projectRoot);
    const reloaded = getOrCreateSessionManager(fresh.ctx.container).getAnySession(session.id, {
      projectRoot,
    });
    const reloadedCarrier = reloaded
      ? readPluginCertifiedCarrierFromProjectContext(reloaded.toSnapshot().projectContext)
      : null;
    const freshManagerIdentityStable = Boolean(
      reloadedCarrier &&
        reloadedCarrier.artifactId === planCarrier.artifactId &&
        reloadedCarrier.sourceVectorHash === planCarrier.sourceVectorHash &&
        reloadedCarrier.receipts['dimension-completion']?.consumer === 'dimension-completion'
    );
    mark('fresh-manager');
    const counters = finalCarrier.plugin?.counters;
    return {
      label,
      phaseDurationsMs: {
        graph: phaseTimingsMs['graph-terminal'] - phaseTimingsMs['cold-start'],
        map: phaseTimingsMs['map-terminal'] - phaseTimingsMs['graph-terminal'],
      },
      phaseTimingsMs,
      graph: {
        duplicateIdentityCount: firstRun.duplicateIdentityCount,
        firstReceipt: receiptSummary(firstRun.first.meta.projectContext?.liveProbeReceipt),
        terminalReceipt: receiptSummary(firstRun.terminal.meta.projectContext?.liveProbeReceipt),
        repoCoverage: firstRun.terminal.repoCoverage,
        status: firstRun.terminal.status,
        errorDiagnosticCount: errorDiagnosticCount(firstRun.terminal),
        diagnostics: firstRun.terminal.diagnostics,
        projectContextMeta: firstRun.terminal.meta.projectContext ?? null,
        recipeFieldsPresent: /recipeId|recipeMounts|recipeRollups/.test(
          JSON.stringify(firstRun.terminal)
        ),
      },
      map,
      lineage: {
        artifactId: finalCarrier.artifactId,
        coreAlignedSourcePolicy:
          artifact.facts.inventory.includeExcludePolicy.version ===
            PLUGIN_CORE_ALIGNED_SOURCE_POLICY.version &&
          sameStrings(
            artifact.facts.inventory.includeExcludePolicy.includeExtensions,
            PLUGIN_CORE_ALIGNED_SOURCE_POLICY.includeExtensions
          ) &&
          sameStrings(
            artifact.facts.inventory.includeExcludePolicy.excludeDirectories,
            PLUGIN_CORE_ALIGNED_SOURCE_POLICY.excludeDirectories
          ),
        dataRootAbsentBeforePlan,
        eligibleScriptSourceConserved: scriptSources.every((source) => source.conserved),
        eligibleScriptSourceCount: scriptSources.length,
        eligibleScriptSourceRefCount: scriptSources.reduce(
          (count, source) => count + source.sourceRefCount,
          0
        ),
        eligibleScriptSources: scriptSources,
        exactRepositoryTuples: exactTuples,
        freshManagerIdentityStable,
        instrumentation: finalCarrier.plugin?.instrumentation ?? [],
        moduleCount: canonicalModules.length,
        preparationId: finalCarrier.preparationId,
        receiptCount: Object.keys(finalCarrier.receipts).length,
        receiptConsumers: Object.keys(finalCarrier.receipts).sort(),
        repositoryCount: exactTuples.length,
        sourceVectorHash: finalCarrier.sourceVectorHash,
        strictCounters: counters ?? null,
        strictCountersZero: Boolean(
          counters && Object.values(counters).every((count) => count === 0)
        ),
      },
    };
  } finally {
    await buildSessions.dispose();
    recipeDatabase?.close();
    databaseRuntime?.close();
    _resetGenerateSessionManagersForTesting();
  }
}

async function graphPages(projectRoot: string, ctx: McpContext) {
  let result = (await routeGraphTool(ctx, {
    budget: { itemLimit: 500 },
    pageSize: 100,
    projectRoot,
    queryKind: 'map',
  })) as unknown as ToolResult<AlembicGraphOutput>;
  const first = result.structuredContent;
  let terminal = first;
  const seenNodes = new Set<string>();
  const seenRelations = new Set<string>();
  const seenRefs = new Set<string>();
  let duplicateIdentityCount = 0;
  const observePage = (page: AlembicGraphOutput) => {
    for (const node of page.nodes) {
      duplicateIdentityCount += Number(seenNodes.has(node.id));
      seenNodes.add(node.id);
    }
    for (const relation of page.relations) {
      const identity = `${relation.fromId}\0${relation.relationType}\0${relation.toId}\0${relation.refId ?? ''}`;
      duplicateIdentityCount += Number(seenRelations.has(identity));
      seenRelations.add(identity);
    }
    for (const ref of page.refs) {
      duplicateIdentityCount += Number(seenRefs.has(ref.id));
      seenRefs.add(ref.id);
    }
  };
  observePage(first);
  for (let pages = 0; pages < 10_000; pages += 1) {
    const cursor = terminal.continuation?.nextCursor;
    if (!cursor) {
      return { duplicateIdentityCount, first, terminal };
    }
    result = (await routeGraphTool(ctx, {
      cursor,
      projectRoot,
    })) as unknown as ToolResult<AlembicGraphOutput>;
    terminal = result.structuredContent;
    observePage(terminal);
  }
  throw new Error(`${projectRoot} Graph continuation exceeded the page safety bound.`);
}

async function recipeMapPages(projectRoot: string, ctx: McpContext) {
  let result = (await routeRecipeMapTool(ctx, {
    focus: { kind: 'space' },
    nodeLimit: 500,
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
        perTypeAccountingConserved: continuationTypeAccountingConserved(
          first.continuation?.typeAccounting,
          terminal.continuation?.typeAccounting
        ),
        projectCoverageStatus: terminal.projectCoverageStatus,
        status: terminal.status,
        errorDiagnosticCount: errorDiagnosticCount(terminal),
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

function continuationTypeAccountingConserved(
  first:
    | NonNullable<NonNullable<AlembicRecipeMapOutput['continuation']>['typeAccounting']>
    | undefined,
  terminal:
    | NonNullable<NonNullable<AlembicRecipeMapOutput['continuation']>['typeAccounting']>
    | undefined
): boolean {
  if (!first || !terminal) {
    return false;
  }
  const kinds = ['mounts', 'nodes', 'refs', 'relations', 'rollups'] as const;
  return kinds.every(
    (kind) =>
      first[kind].total === terminal[kind].total &&
      terminal[kind].cumulative === terminal[kind].total &&
      terminal[kind].remaining === 0
  );
}

function hasAllCertifiedConsumerTraces(
  scenario: Awaited<ReturnType<typeof probeScenario>>
): boolean {
  const observed = new Set(
    scenario.lineage.instrumentation.flatMap((event) =>
      event.kind === 'consumer-reopen' ? [event.consumer] : []
    )
  );
  const expected = [
    'plan',
    'recipe-generation',
    'dependency-graph',
    'module-coverage',
    'dimension-completion',
  ] as const;
  return expected.every((consumer) => observed.has(consumer));
}

function hasCompleteStrictEntrypointDenominator(
  scenario: Awaited<ReturnType<typeof probeScenario>>
): boolean {
  const reopenEvents = scenario.lineage.instrumentation.filter(
    (event) => event.kind === 'consumer-reopen'
  );
  const moduleEvents = scenario.lineage.instrumentation.filter(
    (event) => event.kind === 'module-projection'
  );
  const bypassEvents = scenario.lineage.instrumentation.filter(
    (event) => event.kind === 'strict-bypass'
  );
  const expected = Object.entries(PLUGIN_CERTIFIED_ENTRYPOINTS);
  return (
    reopenEvents.length === expected.length &&
    moduleEvents.length === expected.length &&
    bypassEvents.length === 0 &&
    expected.every(
      ([consumer, entrypoint]) =>
        reopenEvents.some(
          (event) => event.consumer === consumer && event.entrypoint === entrypoint
        ) &&
        moduleEvents.some((event) => event.consumer === consumer && event.entrypoint === entrypoint)
    )
  );
}

function eligibleScriptSourceEvidence(
  artifact: Awaited<ReturnType<FileCertifiedProjectFactsStore['open']>>,
  projection: Awaited<ReturnType<typeof openPluginCertifiedProjection>>
) {
  return artifact.facts.inventory.files
    .filter((file) => file.relativePath.split('/').includes('scripts'))
    .map((file) => {
      const projected = projection.files.find(
        (candidate) =>
          candidate.repoId === file.repoId && candidate.relativePath === file.relativePath
      );
      const frozen = artifact.facts.detail.frozenFiles?.find(
        (candidate) =>
          candidate.repoId === file.repoId && candidate.relativePath === file.relativePath
      );
      const expectedModuleIds = file.ownerModuleIds
        .map((moduleId) => `${file.repoId}::${moduleId}`)
        .sort();
      const frozenBlobConserved = Boolean(
        frozen &&
          frozen.blobHash === file.blobSha256 &&
          frozen.fullChunkRefs.includes(file.blobSha256) &&
          artifact.chunks.some(
            (chunk) => chunk.blobHash === frozen.blobHash && chunk.byteLength === frozen.byteLength
          )
      );
      const projectionConserved = Boolean(
        projected &&
          projected.blobHash === file.blobSha256 &&
          sameStrings(projected.moduleIds, expectedModuleIds)
      );
      const sourceRefCount = artifact.facts.requestOutcomes.filter((outcome) =>
        outcome.sourceRanges.some(
          (range) => range.repoId === file.repoId && range.relativePath === file.relativePath
        )
      ).length;
      return {
        conserved: frozenBlobConserved && projectionConserved,
        frozenBlobConserved,
        inventoryOwnerModuleCount: file.ownerModuleIds.length,
        inventoryOwnerV2Count: file.ownersV2?.length ?? 0,
        projectionConserved,
        relativePath: file.relativePath,
        repoId: file.repoId,
        sourceRefCount,
      };
    });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function createContext(projectRoot: string): {
  ctx: McpContext;
  services: Map<string, unknown>;
} {
  const services = new Map<string, unknown>();
  const container = {
    get: (name: string) => services.get(name),
    register: (name: string, factory: () => unknown) => {
      if (!services.has(name)) {
        services.set(name, factory());
      }
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: resolveScopeAwareWorkspace(projectRoot),
    },
  } as McpContext['container'] & { register(name: string, factory: () => unknown): void };
  return {
    ctx: {
      container,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
      projectRuntime: buildProjectRuntimeContext({ projectRoot }),
    },
    services,
  };
}

function createAuditScopeRegistry(args: AuditArgs): AuditScopeRegistry {
  const runtimeRoot = path.join(args.outputDir, '.plugin-pcf-runtime');
  rmSync(runtimeRoot, { force: true, recursive: true });
  const mr5AuditHome = path.join(runtimeRoot, 'home', 'mr5');
  const spAuditHome = path.join(runtimeRoot, 'home', 'sp-bilidili');
  const mr5DataRoot = path.join(runtimeRoot, 'data', 'mr5');
  const spDataRoot = path.join(runtimeRoot, 'data', 'sp-bilidili');
  const mr5Descriptor = createProjectDescriptor({
    controlRoot: args.mr5Root,
    dataRoot: mr5DataRoot,
    displayName: 'MR5 audit scope',
    folders: ['Alembic', 'AlembicCore', 'AlembicPlugin', 'AlembicAgent', 'AlembicDashboard'].map(
      (repoId, index) => ({
        displayName: repoId,
        id: `mr5-${repoId.toLowerCase()}`,
        path: path.join(args.mr5Root, repoId),
        repositoryId: repoId,
        role: index === 0 ? ('primary-source' as const) : ('source' as const),
      })
    ),
    projectId: 'plugin-pcf-audit-mr5',
    projectScopeId: 'scope-plugin-pcf-audit-mr5',
  });
  const spDescriptor = createProjectDescriptor({
    controlRoot: args.spRoot,
    dataRoot: spDataRoot,
    displayName: 'SP BiliDili audit scope',
    folders: expectedRepositories('SP-BILIDILI').map((repository, index) => ({
      displayName: repository.repoId,
      id: `sp-${repository.repoId.toLowerCase()}`,
      path: path.join(args.spRoot, repository.relativeRoot),
      repositoryId: repository.repoId,
      role: index === 0 ? ('primary-source' as const) : ('source' as const),
    })),
    projectId: 'plugin-pcf-audit-sp-bilidili',
    projectScopeId: 'scope-plugin-pcf-audit-sp-bilidili',
  });
  writeAuditScopeRegistry(mr5AuditHome, mr5Descriptor);
  writeAuditScopeRegistry(spAuditHome, spDescriptor);
  return { mr5AuditHome, mr5DataRoot, runtimeRoot, spAuditHome, spDataRoot };
}

function writeAuditScopeRegistry(
  auditHome: string,
  descriptor: ReturnType<typeof createProjectDescriptor>
): void {
  const registryDir = path.join(auditHome, '.asd');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    path.join(registryDir, PROJECT_SCOPE_REGISTRY_FILENAME),
    `${JSON.stringify(createProjectScopeRegistryDocument([descriptor]), null, 2)}\n`,
    'utf8'
  );
}

function expectedRepositories(label: string): Array<{ relativeRoot: string; repoId: string }> {
  if (label === 'MR5') {
    return ['Alembic', 'AlembicCore', 'AlembicPlugin', 'AlembicAgent', 'AlembicDashboard'].map(
      (repoId) => ({ relativeRoot: repoId, repoId })
    );
  }
  if (label === 'SP-BILIDILI') {
    return [
      { relativeRoot: 'BiliDili', repoId: 'BiliDili' },
      {
        relativeRoot: 'BiliDili/Packages/AOXFoundationKit',
        repoId: 'AOXFoundationKit',
      },
      { relativeRoot: 'BiliDili/Packages/AOXNetworkKit', repoId: 'AOXNetworkKit' },
      { relativeRoot: 'BiliDili/Packages/AOXPlayer', repoId: 'AOXPlayer' },
      { relativeRoot: 'BiliDili/Packages/AOXUIKit', repoId: 'AOXUIKit' },
    ];
  }
  throw new TypeError(`Unknown audit scenario: ${label}`);
}

function assertExpectedRepositories(
  label: string,
  observed: Array<{ relativeRoot: string; repoId: string }>
): void {
  const normalize = (repositories: Array<{ relativeRoot: string; repoId: string }>) =>
    repositories
      .map(({ relativeRoot, repoId }) => ({ relativeRoot, repoId }))
      .sort((left, right) => left.repoId.localeCompare(right.repoId));
  if (
    JSON.stringify(normalize(observed)) !== JSON.stringify(normalize(expectedRepositories(label)))
  ) {
    throw new TypeError(`${label} certified artifact did not preserve its exact root+4 scope.`);
  }
}

function moduleBindingPath(ownedFile: string | undefined): string {
  if (!ownedFile) {
    throw new TypeError('Certified Plan projection has no owned module file.');
  }
  const directory = ownedFile.split('/').slice(0, -1).join('/');
  return directory || '.';
}

function joinPortable(root: string, relativePath: string): string {
  return root === '.' ? relativePath : `${root}/${relativePath}`;
}

function readToolResponse(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function assertSuccessful(response: Record<string, unknown>, label: string): void {
  if (response.success !== true) {
    throw new Error(`${label} failed: ${JSON.stringify(response)}`);
  }
}

function errorDiagnosticCount(output: { diagnostics?: unknown }): number {
  return (Array.isArray(output.diagnostics) ? output.diagnostics : []).filter((diagnostic) =>
    Boolean(
      diagnostic &&
        typeof diagnostic === 'object' &&
        (diagnostic as Record<string, unknown>).severity === 'error'
    )
  ).length;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(readRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function createCoverageLedgerRepository(): Record<string, unknown> {
  const cells: Record<string, unknown>[] = [];
  const rounds: Record<string, unknown>[] = [];
  return {
    listByProjectRoot: () => cells,
    listRoundsByProjectRoot: () => rounds,
    upsertCell: (input: Record<string, unknown>) => {
      const cell = {
        ...input,
        coveredCount: input.coveredCount ?? 0,
        coveredSourceRefs: input.coveredSourceRefs ?? [],
        createdAt: 0,
        deferred: false,
        exhausted: false,
        exhaustedReason: null,
        exhaustedSource: null,
        grade: input.grade ?? 'empty',
        totalCandidateCount: input.totalCandidateCount ?? 0,
        uncoveredHints: input.uncoveredHints ?? [],
        updatedAt: 0,
        valueScore: input.valueScore ?? null,
      };
      cells.push(cell);
      return cell;
    },
    upsertRound: (input: Record<string, unknown>) => {
      rounds.push(input);
      return input;
    },
  };
}

function longCertifiedAnalysis(label: string): string {
  return [
    `## ${label} certified ProjectContext lineage`,
    '',
    'The loaded Plugin Plan entrypoint captured the accepted root plus four repository scope exactly once.',
    'The generation adapter reopened the same immutable source vector and retained all module owners.',
    'The dependency graph and module coverage adapters projected the identical artifact without live fallback.',
    'The dimension completion preflight validates the same canonical module axis before any completion side effects.',
    '',
    'This evidence is grounded in certified source files referenced by the submitted Recipes.',
  ].join('\n');
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
    suppressedObservations: receipt.suppressedObservations,
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
