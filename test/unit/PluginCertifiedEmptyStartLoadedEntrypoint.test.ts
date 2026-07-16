import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import {
  _resetGenerateSessionManagersForTesting,
  getOrCreateSessionManager,
} from '@alembic/core/host-agent-workflows';
import {
  FileCertifiedProjectFactsStore,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import { createAlembicRepositories } from '@alembic/core/repositories';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  routeGraphTool,
  routePlanTool,
  routeRecipeMapTool,
} from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import {
  assertExactRepositoryTuples,
  openPluginCertifiedProjection,
  pluginCertifiedStoreRoot,
  readPluginCertifiedCarrierFromProjectContext,
} from '../../lib/project-facts/PluginCertifiedProjectFactsRuntime.js';
import { runHostAgentColdStartWorkflow } from '../../lib/recipe-pipeline/generate/cold-start.js';
import { runHostAgentDimensionCompletionWorkflow } from '../../lib/recipe-pipeline/generate/dimension-completion.js';
import { buildHostAgentProjectContextAnalysis } from '../../lib/recipe-pipeline/generate/project-context-analysis.js';
import { createReadOnlyRecipeMapRepositories } from '../../lib/repository/recipe-map/ReadOnlyRecipeMapServices.js';
import { ModuleService } from '../../lib/service/module/ModuleService.js';
import type { AlembicGraphOutput } from '../../lib/service/project-knowledge-context/contracts/AlembicGraphOutput.js';
import type { AlembicRecipeMapOutput } from '../../lib/service/project-knowledge-context/contracts/AlembicRecipeMapOutput.js';
import { ProjectContextBuildSessionManager } from '../../lib/service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { resolveScopeAwareWorkspace } from '../../lib/shared/project-scope-runtime.js';

const tempRoots: string[] = [];
const databaseRuntimes: AlembicDatabaseRuntime[] = [];
const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

afterEach(() => {
  for (const runtime of databaseRuntimes.splice(0)) {
    runtime.close();
  }
  _resetGenerateSessionManagersForTesting();
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('Plugin certified empty-start loaded entrypoint', () => {
  test('actual Plan draft captures one carrier and strict consumers reject its removal', async () => {
    const projectRoot = createProject();
    const ctx = createLoadedContext(projectRoot);

    const response = (await routePlanTool(ctx, {
      generationStage: 'coldStart',
      hints: { maxBudget: 64 },
      operation: 'draft',
      projectRoot,
    })) as { success?: boolean };

    expect(response.success).toBe(true);
    const session = getOrCreateSessionManager(ctx.container).getAnySession(undefined, {
      projectRoot,
    });
    expect(session).not.toBeNull();
    const carrier = readPluginCertifiedCarrierFromProjectContext(
      session?.toSnapshot().projectContext
    );
    expect(carrier).not.toBeNull();
    expect(carrier?.receipts.plan).toMatchObject({
      artifactId: carrier?.artifactId,
      consumer: 'plan',
      sourceVectorHash: carrier?.sourceVectorHash,
    });

    const sourceFile = path.join(projectRoot, 'plugin-empty-start', 'src/index.ts');
    const sourceBytes = fs.readFileSync(sourceFile);
    fs.appendFileSync(sourceFile, 'export const drifted = true;\n');
    const graphDrift = await captureRejection(
      routeGraphTool(ctx, { projectRoot, queryKind: 'map' })
    );
    expect(readStrictBypassKinds(graphDrift)).toEqual(['direct-project-context']);
    expect(readStrictBypassCounters(graphDrift)).toMatchObject({
      directProjectContextCallCount: 1,
    });
    fs.writeFileSync(sourceFile, sourceBytes);
    const retryCarrier = readPluginCertifiedCarrierFromProjectContext(
      session?.toSnapshot().projectContext
    );
    expect(Object.values(retryCarrier?.plugin?.counters ?? {}).every((count) => count === 0)).toBe(
      true
    );

    const missingCarrierContext = structuredClone(session?.toSnapshot().projectContext ?? {});
    delete missingCarrierContext.certifiedProjectFacts;
    session?.replaceProjectContext(missingCarrierContext);
    const planBypass = await captureRejection(
      routePlanTool(ctx, {
        generationStage: 'coldStart',
        hints: { maxBudget: 64 },
        operation: 'draft',
        projectRoot,
      })
    );
    expect(readStrictBypassKinds(planBypass)).toEqual(['collect-plan-project-context']);
    expect(readStrictBypassCounters(planBypass)).toMatchObject({
      directProjectContextCallCount: 1,
    });

    const generationBypass = await captureRejection(
      buildHostAgentProjectContextAnalysis({
        certifiedSession: {
          container: ctx.container,
          dataRoot: ctx.projectRuntime?.identity.dataRoot ?? projectRoot,
          strict: true,
        },
        projectRoot,
        source: 'codex-host-bootstrap',
      })
    );
    expect(readStrictBypassKinds(generationBypass)).toEqual([
      'capped-module-axis',
      'direct-project-context',
      'raw-filesystem',
      'synthetic-project-scope',
    ]);
    expect(readStrictBypassCounters(generationBypass)).toMatchObject({
      cappedModuleProjectionCount: 1,
      directProjectContextCallCount: 1,
      rawFilesystemFallbackCount: 1,
      synthesizedProjectScopeFactCount: 1,
    });

    const routerModule = (await import(
      '../../lib/host-runtime/mcp/handlers/tool-router.js'
    )) as unknown as {
      resolveSubmitKnowledgeModuleAxis?: (
        context: McpContext,
        strictCertifiedAxis: boolean
      ) => Promise<unknown>;
    };
    expect(routerModule.resolveSubmitKnowledgeModuleAxis).toBeTypeOf('function');
    const submitAxisBypass = await captureRejection(
      routerModule.resolveSubmitKnowledgeModuleAxis?.(ctx, true) ?? Promise.resolve()
    );
    expect(readStrictBypassKinds(submitAxisBypass)).toEqual([
      'core-passthrough',
      'empty-module-axis',
    ]);
    expect(readStrictBypassCounters(submitAxisBypass)).toMatchObject({
      emptyModuleAxisPassthroughCount: 2,
    });
    await expect(routeGraphTool(ctx, { projectRoot, queryKind: 'map' })).rejects.toThrow(
      /strict Graph\/Map session is missing/
    );
    const moduleService = new ModuleService(projectRoot, {
      certifiedFactsProvider: () => null,
      certifiedFactsRequired: () => true,
    });
    const moduleBypass = await captureRejection(moduleService.listCanonicalModules());
    expect(readStrictBypassKinds(moduleBypass)).toEqual([
      'direct-project-context',
      'raw-filesystem',
    ]);
    expect(readStrictBypassCounters(moduleBypass)).toMatchObject({
      directProjectContextCallCount: 1,
      rawFilesystemFallbackCount: 1,
    });
  });

  test('strict loaded Plan rejects synthetic ProjectScope before capture', async () => {
    const projectRoot = createBareProjectWithoutScope();
    const ctx = createLoadedContext(projectRoot);
    const error = await captureRejection(
      routePlanTool(ctx, {
        generationStage: 'coldStart',
        hints: { maxBudget: 64 },
        operation: 'draft',
        projectRoot,
      })
    );

    expect(readStrictBypassKinds(error)).toEqual(['synthetic-project-scope']);
    expect(readStrictBypassCounters(error)).toMatchObject({
      synthesizedProjectScopeFactCount: 1,
    });
  });

  test('native root+4 pristine I2 adapter chain conserves one artifact through all five loaded consumers and a fresh manager', async () => {
    const fixture = createNativeRootPlusFourProject();
    const { ctx, services } = createLoadedContextHarness(fixture.controlRoot);
    expect(fs.existsSync(fixture.dataRoot)).toBe(false);
    expect(
      getOrCreateSessionManager(ctx.container).getAnySession(undefined, {
        projectRoot: fixture.controlRoot,
      })
    ).toBeNull();
    const response = (await routePlanTool(ctx, {
      generationStage: 'coldStart',
      hints: { maxBudget: 256 },
      operation: 'draft',
      projectRoot: fixture.controlRoot,
    })) as { data?: Record<string, unknown>; success?: boolean };
    expect(response.success).toBe(true);

    const manager = getOrCreateSessionManager(ctx.container);
    const session = manager.getAnySession(undefined, { projectRoot: fixture.controlRoot });
    expect(session).not.toBeNull();
    const planCarrier = readPluginCertifiedCarrierFromProjectContext(
      session?.toSnapshot().projectContext
    );
    expect(planCarrier).not.toBeNull();
    if (!session || !planCarrier) {
      throw new Error('Plan did not persist its certified HostAgent session.');
    }
    const artifact = await new FileCertifiedProjectFactsStore(
      pluginCertifiedStoreRoot(fixture.dataRoot)
    ).open(planCarrier.artifactId as never, planCarrier.certificationBindingHash as never);
    const scriptInventory = artifact.facts.inventory.files.find(
      (file) => file.repoId === 'BiliDili' && file.relativePath === 'scripts/eligible-build.ts'
    );
    expect(scriptInventory).toMatchObject({
      language: 'typescript',
      relativePath: 'scripts/eligible-build.ts',
      repoId: 'BiliDili',
    });
    expect(scriptInventory?.ownerModuleIds).toEqual([]);
    expect(scriptInventory?.ownersV2).toEqual([]);
    const frozenScript = artifact.facts.detail.frozenFiles?.find(
      (file) => file.repoId === 'BiliDili' && file.relativePath === 'scripts/eligible-build.ts'
    );
    expect(frozenScript).toMatchObject({
      blobHash: scriptInventory?.blobSha256,
      status: 'frozen-blob-available',
    });
    expect(frozenScript?.fullChunkRefs).toContain(scriptInventory?.blobSha256);
    expect(
      artifact.chunks.some(
        (chunk) => chunk.blobHash === frozenScript?.blobHash && chunk.byteLength > 0
      )
    ).toBe(true);
    const scriptOutcome = artifact.facts.requestOutcomes.find(
      (outcome) =>
        (outcome.selector as { filePath?: unknown }).filePath === 'scripts/eligible-build.ts'
    );
    expect(scriptOutcome).toMatchObject({
      language: 'typescript',
      ownerSurfaceId: 'language:typescript:typescript',
      repoId: 'BiliDili',
      terminalStatus: 'completed',
    });
    expect(scriptOutcome?.sourceRanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'scripts/eligible-build.ts',
          repoId: 'BiliDili',
        }),
      ])
    );
    const baseArtifactHash = hashCanonicalJson(artifact);
    const exactTuples = artifact.manifest.sourceRevisionVector.entries.map((entry) => ({
      repoId: entry.repoId,
      relativeRoot: entry.relativeRoot,
      revision: entry.revision,
    }));
    expect(
      exactTuples
        .map(({ repoId, relativeRoot }) => ({ repoId, relativeRoot }))
        .sort((left, right) => left.repoId.localeCompare(right.repoId))
    ).toEqual(
      [...fixture.repositoryRoots].sort((left, right) => left.repoId.localeCompare(right.repoId))
    );
    expect(() => assertExactRepositoryTuples({ artifact, observed: exactTuples })).not.toThrow();

    const planProjection = await openPluginCertifiedProjection({
      carrier: planCarrier,
      dataRoot: fixture.dataRoot,
    });
    expect(planProjection.modules.length).toBeGreaterThan(24);

    const moduleService = new ModuleService(fixture.controlRoot, {
      certifiedFactsProvider: () => {
        const active = manager.getAnySession(undefined, { projectRoot: fixture.controlRoot });
        const carrier = active
          ? readPluginCertifiedCarrierFromProjectContext(active.toSnapshot().projectContext)
          : null;
        return active && carrier
          ? {
              carrier,
              dataRoot: fixture.dataRoot,
              projectRoot: fixture.controlRoot,
              session: active,
            }
          : null;
      },
    });
    services.set('moduleService', moduleService);

    const runtime = await openAlembicDatabase(
      { path: path.join(fixture.dataRoot, 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(fixture.controlRoot) }
    );
    databaseRuntimes.push(runtime);
    const repositories = createAlembicRepositories(runtime.connection);
    services.set('database', runtime.connection);
    services.set('gitDiffCheckpointRepository', repositories.gitDiffCheckpointRepository);
    services.set('knowledgeRepository', repositories.knowledgeRepository);
    services.set('lifecycleEventRepository', repositories.lifecycleEventRepository);
    services.set('planRepository', repositories.planRepository);
    services.set('proposalGateway', {
      submit: async () => ({ id: 'proposal-certified-root-plus-four' }),
    });
    services.set('proposalRepository', repositories.proposalRepository);
    services.set('recipeSourceRefRepository', repositories.recipeSourceRefRepository);

    const draftData = readRecord(response.data);
    const projectInfoTree = readRecord(draftData.projectInfoTree);
    const candidateDimensionIds = readRecordArray(draftData.candidateDimensions).map((item) =>
      String(item.id)
    );
    expect(candidateDimensionIds).toContain('architecture');
    const confirmed = (await routePlanTool(ctx, {
      evidenceRefs: [
        {
          detail: 'Certified root+4 draft projectInfoTree',
          kind: 'project-context',
          ref: `projectInfoTree:${String(projectInfoTree.primaryLanguage)}:${String(projectInfoTree.fileCount)}`,
        },
      ],
      generationStage: 'coldStart',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          modulePath: 'BiliDili/Sources/Core/Feature00',
          targetRecipes: 3,
        },
      ],
      operation: 'confirm',
      plannedNextActions: [
        {
          reason:
            'Exercise the strict pristine I2 adapter chain; I3 authorized rebuild remains pending.',
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
        primaryLanguage: String(projectInfoTree.primaryLanguage ?? 'swift'),
        projectType: String(projectInfoTree.projectType ?? 'swift-package'),
        secondaryLanguages: stringArray(projectInfoTree.secondaryLanguages),
      },
      projectRoot: fixture.controlRoot,
      rationale: 'Confirm the certified root+4 pristine I2 adapter path without fallback.',
      scale: {
        contentMaxLines: 120,
        depthLevels: ['project', 'module'],
        maxFiles: 128,
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
    })) as { data?: Record<string, unknown>; success?: boolean };
    expect(confirmed.success, JSON.stringify(confirmed, null, 2)).toBe(true);
    const planSelection = readRecord(readRecord(confirmed.data).planSelection);
    const coldStart = (await runHostAgentColdStartWorkflow(
      ctx as never,
      {
        planSelection,
        testMode: true,
      } as never
    )) as Record<string, unknown>;
    expect(coldStart.success, JSON.stringify(coldStart, null, 2)).toBe(true);
    const generationCarrier = readPluginCertifiedCarrierFromProjectContext(
      session.toSnapshot().projectContext
    );
    expect(generationCarrier?.receipts['recipe-generation']).toMatchObject({
      artifactId: planCarrier.artifactId,
      sourceVectorHash: planCarrier.sourceVectorHash,
    });

    const database = new Database(path.join(fixture.dataRoot, 'recipe-map.db'));
    database.exec(`
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
    database
      .prepare('INSERT INTO knowledge_entries (id, title, tags, sources) VALUES (?, ?, ?, ?)')
      .run(
        'recipe-root-plus-four',
        'Root plus four module boundary',
        '[]',
        JSON.stringify(['BiliDili/Sources/Core/Feature00/Feature.swift:1'])
      );
    database
      .prepare('INSERT INTO recipe_source_refs (recipe_id, source_path, status) VALUES (?, ?, ?)')
      .run('recipe-root-plus-four', 'BiliDili/Sources/Core/Feature00/Feature.swift:1', 'active');
    database.pragma('query_only = ON');
    const recipeRepositories = createReadOnlyRecipeMapRepositories(database);
    services.set('knowledgeService', recipeRepositories.knowledgeService);
    services.set('recipeSourceRefRepository', recipeRepositories.sourceRefRepository);
    const buildSessions = new ProjectContextBuildSessionManager({ ttlMs: 15_000 });
    ctx.projectContextExecution = { buildSessions };
    try {
      const graph = await readTerminalGraph(ctx, fixture.controlRoot);
      expect(
        graph.status,
        JSON.stringify(
          {
            continuation: graph.continuation,
            diagnostics: graph.diagnostics,
            projectContext: graph.meta?.projectContext,
            repoCoverage: graph.repoCoverage,
            status: graph.status,
            summary: graph.summary,
          },
          null,
          2
        )
      ).toBe('ready');
      expect(errorDiagnostics(graph)).toHaveLength(0);
      expect(JSON.stringify(graph)).not.toContain('scripts/audit');
      expect((await moduleService.listCanonicalModules()).length).toBeGreaterThan(24);

      const recipeMap = await readTerminalRecipeMap(ctx, fixture.controlRoot);
      expect(
        recipeMap.status,
        JSON.stringify(
          {
            conservation: recipeMap.conservation,
            diagnostics: recipeMap.diagnostics,
            projectCoverageStatus: recipeMap.projectCoverageStatus,
            region: recipeMap.region,
            status: recipeMap.status,
          },
          null,
          2
        )
      ).toBe('ready');
      expect(errorDiagnostics(recipeMap)).toHaveLength(0);
      expect(recipeMap.conservation).toMatchObject({
        completeness: 'complete',
        mountAccountingCompleteness: 'complete',
      });
      expect(recipeMap.projectCoverageStatus).toBe('complete');
      expect(recipeMap.finalCoverageReceipt).toMatchObject({
        canonicalScopeHash: planCarrier.canonicalScopeHash,
        sourceVectorHash: planCarrier.sourceVectorHash,
      });
    } finally {
      await buildSessions.dispose();
      database.close();
    }

    const beforeFifth = readPluginCertifiedCarrierFromProjectContext(
      session.toSnapshot().projectContext
    );
    expect(Object.keys(beforeFifth?.receipts ?? {}).sort()).toEqual([
      'dependency-graph',
      'module-coverage',
      'plan',
      'recipe-generation',
    ]);
    if (!beforeFifth) {
      throw new Error('Four-consumer carrier was not persisted.');
    }
    const submitted = [
      {
        id: 'recipe-dimension-a',
        source: 'BiliDili/Sources/Core/Feature00/Feature.swift:1',
      },
      {
        id: 'recipe-dimension-b',
        source: 'BiliDili/Sources/Core/Feature01/Feature.swift:1',
      },
      {
        id: 'recipe-dimension-c',
        source: 'BiliDili/Packages/AOXFoundationKit/Sources/AOXFoundationKit/Runtime.swift:1',
      },
    ];
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
      get: async (recipeId: string) => ({
        title: recipeId,
        tags: ['certified'],
      }),
      update: async () => undefined,
    });
    services.set('coverageLedgerRepository', createCoverageLedgerRepository());
    const completionArgs = {
      analysisText: longCertifiedAnalysis(),
      dimensionId: 'architecture',
      keyFindings: [
        'The root package and all four AOX repositories are bound to one certified source vector.',
        'Plan, generation, dependency graph, and module coverage reopen the same artifact.',
        'The module axis retains every certified owner beyond the historical twenty-four limit.',
      ],
      referencedFiles: submitted.map((recipe) => recipe.source.split(':')[0]),
      submittedRecipeIds: submitted.map((recipe) => recipe.id),
    };
    const missingReceiptCarrier = structuredClone(beforeFifth);
    delete missingReceiptCarrier.receipts['dependency-graph'];
    session.replaceProjectContext({
      ...session.toSnapshot().projectContext,
      certifiedProjectFacts: missingReceiptCarrier,
    });
    const blockedSideEffects = { emitter: 0, skill: 0, checkpoint: 0 };
    const blockedCompletion = await runHostAgentDimensionCompletionWorkflow(
      ctx as never,
      completionArgs,
      {
        createEmitter: () => {
          blockedSideEffects.emitter += 1;
          return {
            emitAllComplete: () => undefined,
            emitDimensionComplete: () => undefined,
          };
        },
        generateSkill: async () => {
          blockedSideEffects.skill += 1;
          return { success: true };
        },
        getActiveSession: () => session,
        saveCheckpoint: async () => {
          blockedSideEffects.checkpoint += 1;
        },
      }
    );
    expect(blockedCompletion).toMatchObject({
      errorCode: 'CERTIFIED_PROJECT_CONTEXT_BLOCKED',
      success: false,
    });
    expect(blockedSideEffects).toEqual({ emitter: 0, skill: 0, checkpoint: 0 });
    expect(
      readPluginCertifiedCarrierFromProjectContext(session.toSnapshot().projectContext)?.receipts[
        'dimension-completion'
      ]
    ).toBeUndefined();
    session.replaceProjectContext({
      ...session.toSnapshot().projectContext,
      certifiedProjectFacts: beforeFifth,
    });

    const completion = await runHostAgentDimensionCompletionWorkflow(ctx as never, completionArgs, {
      createEmitter: () => ({
        emitAllComplete: () => undefined,
        emitDimensionComplete: () => undefined,
      }),
      getActiveSession: () => session,
      saveCheckpoint: async () => undefined,
    });
    expect(completion.success, JSON.stringify(completion, null, 2)).toBe(true);

    _resetGenerateSessionManagersForTesting();
    const fresh = createLoadedContextHarness(fixture.controlRoot);
    const reloaded = getOrCreateSessionManager(fresh.ctx.container).getAnySession(session.id, {
      projectRoot: fixture.controlRoot,
    });
    const reloadedCarrier = reloaded
      ? readPluginCertifiedCarrierFromProjectContext(reloaded.toSnapshot().projectContext)
      : null;
    expect(reloadedCarrier?.artifactId).toBe(planCarrier.artifactId);
    expect(reloadedCarrier?.sourceVectorHash).toBe(planCarrier.sourceVectorHash);
    expect(reloadedCarrier?.receipts['dimension-completion']?.consumer).toBe(
      'dimension-completion'
    );
    expect(reloadedCarrier?.plugin?.counters).toEqual({
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 0,
      emptyModuleAxisPassthroughCount: 0,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    });
    expect(
      new Set(
        reloadedCarrier?.plugin?.instrumentation
          .filter((event) => event.kind === 'consumer-reopen')
          .map((event) => event.consumer)
      )
    ).toEqual(
      new Set([
        'plan',
        'recipe-generation',
        'dependency-graph',
        'module-coverage',
        'dimension-completion',
      ])
    );
    expect(
      reloadedCarrier?.plugin?.instrumentation.filter((event) => event.kind === 'module-projection')
    ).toHaveLength(5);
    for (const consumer of [
      'plan',
      'recipe-generation',
      'dependency-graph',
      'module-coverage',
      'dimension-completion',
    ] as const) {
      expect(reloadedCarrier?.receipts[consumer]).toMatchObject({
        artifactId: planCarrier.artifactId,
        certificationBindingHash: planCarrier.certificationBindingHash,
        consumer,
        factsContentHash: planCarrier.factsContentHash,
        sourceVectorHash: planCarrier.sourceVectorHash,
      });
    }
    const reopenedBaseArtifact = await new FileCertifiedProjectFactsStore(
      pluginCertifiedStoreRoot(fixture.dataRoot)
    ).open(planCarrier.artifactId as never, planCarrier.certificationBindingHash as never);
    expect(hashCanonicalJson(reopenedBaseArtifact)).toBe(baseArtifactHash);
  }, 60_000);
});

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-certified-empty-start-'));
  tempRoots.push(root);
  process.env.ALEMBIC_HOME = root;
  const runtimeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-certified-empty-data-'));
  tempRoots.push(runtimeParent);
  const sourceRoot = path.join(root, 'plugin-empty-start');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/plugin-empty-start', type: 'module' }, null, 2)
  );
  fs.writeFileSync(path.join(sourceRoot, 'src/index.ts'), 'export const loaded = true;\n');
  const descriptor = createProjectDescriptor({
    controlRoot: root,
    dataRoot: path.join(runtimeParent, 'project-data'),
    displayName: 'Plugin Empty Start',
    folders: [
      {
        displayName: 'plugin-empty-start',
        id: 'folder-plugin-empty-start',
        path: sourceRoot,
        repositoryId: 'plugin-empty-start',
        role: 'primary-source',
      },
    ],
    projectId: 'plugin-empty-start',
    projectScopeId: 'scope-plugin-empty-start',
  });
  fs.mkdirSync(path.join(root, '.asd'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([descriptor]), null, 2)
  );
  return root;
}

function createBareProjectWithoutScope(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-certified-synthetic-scope-'));
  tempRoots.push(root);
  process.env.ALEMBIC_HOME = root;
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@fixture/plugin-synthetic-scope', type: 'module' }, null, 2)
  );
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const loaded = true;\n');
  return root;
}

function createLoadedContext(projectRoot: string): McpContext {
  return createLoadedContextHarness(projectRoot).ctx;
}

function createLoadedContextHarness(projectRoot: string): {
  ctx: McpContext;
  services: Map<string, unknown>;
} {
  const services = new Map<string, unknown>();
  const container: McpContext['container'] = {
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
  };
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

function createNativeRootPlusFourProject(): {
  controlRoot: string;
  dataRoot: string;
  repositoryRoots: Array<{ repoId: string; relativeRoot: string }>;
} {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-certified-root-plus-four-'));
  tempRoots.push(controlRoot);
  process.env.ALEMBIC_HOME = controlRoot;
  const repositoryRoots = [
    { repoId: 'BiliDili', relativeRoot: 'BiliDili' },
    { repoId: 'AOXFoundationKit', relativeRoot: 'BiliDili/Packages/AOXFoundationKit' },
    { repoId: 'AOXNetworkKit', relativeRoot: 'BiliDili/Packages/AOXNetworkKit' },
    { repoId: 'AOXPlayer', relativeRoot: 'BiliDili/Packages/AOXPlayer' },
    { repoId: 'AOXUIKit', relativeRoot: 'BiliDili/Packages/AOXUIKit' },
  ];
  for (const repository of repositoryRoots) {
    fs.mkdirSync(path.join(controlRoot, repository.relativeRoot), { recursive: true });
    writeProjectFile(
      controlRoot,
      `${repository.relativeRoot}/Package.swift`,
      [
        '// swift-tools-version: 5.9',
        'import PackageDescription',
        `let package = Package(name: "${repository.repoId}", targets: [.target(name: "${repository.repoId}", path: "Sources")])`,
        '',
      ].join('\n')
    );
  }
  for (let index = 0; index < 25; index += 1) {
    writeProjectFile(
      controlRoot,
      `BiliDili/Sources/Core/Feature${String(index).padStart(2, '0')}/Feature.swift`,
      `public struct Feature${index} { public let value = ${index} }\n`
    );
  }
  for (const repository of repositoryRoots.slice(1)) {
    writeProjectFile(
      controlRoot,
      `${repository.relativeRoot}/Sources/${repository.repoId}/Runtime.swift`,
      `public struct ${repository.repoId}Runtime { public init() {} }\n`
    );
  }
  writeProjectFile(
    controlRoot,
    'BiliDili/scripts/eligible-build.ts',
    'export const buildTarget = "BiliDili";\n'
  );
  const runtimeParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plugin-certified-root-plus-four-data-')
  );
  tempRoots.push(runtimeParent);
  const dataRoot = path.join(runtimeParent, 'bili-dili');
  const descriptor = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: 'BiliDili Workspace',
    folders: repositoryRoots.map((repository, index) => ({
      displayName: repository.repoId,
      id: `folder-${repository.repoId}`,
      path: path.join(controlRoot, repository.relativeRoot),
      repositoryId: repository.repoId,
      role: index === 0 ? ('primary-source' as const) : ('source' as const),
    })),
    projectId: 'bili-dili',
    projectScopeId: 'scope-bili-dili',
  });
  fs.mkdirSync(path.join(controlRoot, '.asd'), { recursive: true });
  fs.writeFileSync(
    path.join(controlRoot, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([descriptor]), null, 2)
  );
  return { controlRoot, dataRoot, repositoryRoots };
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

async function readTerminalGraph(
  ctx: McpContext,
  projectRoot: string
): Promise<AlembicGraphOutput> {
  let response = (await routeGraphTool(ctx, {
    budget: { itemLimit: 500 },
    pageSize: 1_000,
    projectRoot,
    queryKind: 'map',
  })) as { structuredContent: AlembicGraphOutput };
  while (response.structuredContent.continuation?.nextCursor) {
    response = (await routeGraphTool(ctx, {
      cursor: response.structuredContent.continuation.nextCursor,
      projectRoot,
    })) as typeof response;
  }
  expect(response.structuredContent.continuation?.hasMore ?? false).toBe(false);
  return response.structuredContent;
}

async function readTerminalRecipeMap(
  ctx: McpContext,
  projectRoot: string
): Promise<AlembicRecipeMapOutput> {
  let response = (await routeRecipeMapTool(ctx, {
    focus: { kind: 'space' },
    nodeLimit: 500,
    pageSize: 1_000,
    projectRoot,
  })) as { structuredContent: AlembicRecipeMapOutput };
  while (response.structuredContent.continuation?.nextCursor) {
    response = (await routeRecipeMapTool(ctx, {
      cursor: response.structuredContent.continuation.nextCursor,
      projectRoot,
    })) as typeof response;
  }
  expect(response.structuredContent.continuation?.hasMore ?? false).toBe(false);
  return response.structuredContent;
}

function errorDiagnostics(output: { diagnostics: Array<{ severity: string }> }): unknown[] {
  return (Array.isArray(output.diagnostics) ? output.diagnostics : []).filter(
    (diagnostic) => diagnostic?.severity === 'error'
  );
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

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the strict entrypoint to fail closed.');
}

function readStrictBypassKinds(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const events = (value as { strictBypassEvents?: unknown }).strictBypassEvents;
  if (!Array.isArray(events)) {
    return [];
  }
  return events
    .flatMap((event) =>
      event &&
      typeof event === 'object' &&
      typeof (event as { bypass?: unknown }).bypass === 'string'
        ? [(event as { bypass: string }).bypass]
        : []
    )
    .sort();
}

function readStrictBypassCounters(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const counters = (value as { strictCounters?: unknown }).strictCounters;
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(counters).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number'
    )
  );
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

function longCertifiedAnalysis(): string {
  return [
    '## Certified ProjectContext lineage',
    '',
    'The loaded Plugin Plan entrypoint captured the accepted root plus four repository scope exactly once.',
    'The generation adapter reopened the same immutable source vector and retained all module owners.',
    'The dependency graph and module coverage adapters projected the identical artifact without live fallback.',
    'The dimension completion preflight validates the same canonical module axis before any completion side effects.',
    '',
    'This evidence is grounded in the BiliDili and AOX source files referenced by the submitted Recipes.',
  ].join('\n');
}
