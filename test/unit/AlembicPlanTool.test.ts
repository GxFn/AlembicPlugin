import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import { ALL_DIMENSION_IDS } from '@alembic/core/dimensions';
import { KnowledgeEntry } from '@alembic/core/knowledge';
import {
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { routePlanTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import { PlanInput as PlanInputSchema } from '../../lib/shared/schemas/mcp-tools.js';

interface PlanToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

let projectRoot: string;
let runtime: AlembicDatabaseRuntime;
let repositories: AlembicRepositoryBundle;

describe('alembic_plan tool', () => {
  beforeEach(async () => {
    projectRoot = createFixtureProject();
    fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
    runtime = await openAlembicDatabase(
      { path: path.join(projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(projectRoot) }
    );
    repositories = createAlembicRepositories(runtime.connection);
  });

  afterEach(() => {
    runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('draft persists a Core Plan fact package from real ProjectContext and dynamic planning signals', async () => {
    const draft = await draftPlan({ maxBudget: 6 });

    expect(draft.success).toBe(true);
    expect(draft.data?.projectContextSignature).toMatch(/^pcsig:/);
    expect(draft.data?.plan).toMatchObject({ planStatus: 'draft', version: 1 });

    const planningBrief = asRecord(draft.data?.planningBrief);
    const projectContext = asRecord(planningBrief.projectContext);
    expect(projectContext.fileCount as number).toBeGreaterThan(0);
    expect(projectContext.requestKinds).toEqual(expect.arrayContaining(['space', 'repo']));

    const sourceReports = asRecord(draft.data?.sourceReports);
    const dimensionCatalog = asRecord(sourceReports.dimensionCatalog);
    expect(dimensionCatalog).toMatchObject({
      source: 'DIMENSION_REGISTRY',
      dimensionCount: 25,
      policy: {
        allDimensionsReturned: true,
        agentOwnsRelevanceAndScale: true,
        languageApplicableIsFactualOnly: true,
        noDraftRankingOrFiltering: true,
      },
    });
    const catalogDimensions = asArray(dimensionCatalog.dimensions).map(asRecord);
    expect(catalogDimensions.map((dimension) => String(dimension.id))).toEqual([
      ...ALL_DIMENSION_IDS,
    ]);
    for (const dimension of catalogDimensions) {
      expect(asArray(asRecord(dimension.sop).steps).length).toBeGreaterThan(0);
      expect(asArray(asRecord(dimension.analysisGuide).steps).length).toBeGreaterThan(0);
      expect(asArray(asRecord(dimension.submissionSpec).knowledgeTypes).length).toBeGreaterThan(0);
      expect(dimension).toHaveProperty('languageApplicable');
      expect(dimension).toHaveProperty('languageApplicability');
      for (const forbidden of [
        'active',
        'skip',
        'skipped',
        'rank',
        'score',
        'scale',
        'recommend',
        'recommended',
        'top',
        'subset',
        'weight',
      ]) {
        expect(dimension).not.toHaveProperty(forbidden);
      }
    }
    const planningAids = asRecord(sourceReports.planningAids);
    expect(planningAids).not.toHaveProperty('selection');
    expect(planningAids).not.toHaveProperty('dimensionOrder');
    expect(planningAids).not.toHaveProperty('recommendedDimensions');
    expect(asRecord(draft.data?.projectContextCreationGuide)).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'plan-draft',
      confirmedPlanBoundary: { noPluginOnlyPlanStore: true },
    });
    expect(asRecord(planningBrief.projectContextCreationGuide)).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'plan-draft',
    });
    expect(
      actionTools(asArray(asRecord(draft.data?.projectContextCreationGuide).nextActions))
    ).toEqual(
      expect.arrayContaining([
        'alembic_recipe_map',
        'alembic_graph',
        'alembic_search',
        'alembic_prime',
        'alembic_submit_knowledge',
      ])
    );

    const dynamicSignals = asRecord(sourceReports.dynamicSignals);
    expect(asArray(asRecord(dynamicSignals.coverage).byModule).length).toBeGreaterThan(0);
    const planSignalKinds = asArray(dynamicSignals.planSignals).map((item) => asRecord(item).kind);
    expect(planSignalKinds).not.toContain('new-module');

    const plan = asRecord(draft.data?.plan);
    expect(plan).not.toHaveProperty('planningBrief');
    const stored = repositories.planRepository.get(String(plan.planId), Number(plan.version));
    expect(stored?.planningBrief).toBeNull();
    expect(stored?.intent.dimensions).toEqual([]);
  });

  test('draft returns pure collected facts without active-skip filtering or count-only summaries', async () => {
    const draft = await draftPlan({ maxBudget: 6 });

    expect(draft.success).toBe(true);

    const topLevelGuide = asRecord(draft.data?.projectContextCreationGuide);
    const guideDimensionIds = asArray(asRecord(topLevelGuide.confirmedPlanBoundary).dimensionIds)
      .map(String)
      .filter((id) => id.length > 0);
    expect(guideDimensionIds.length).toBeGreaterThan(10);
    expect(guideDimensionIds).toEqual(
      expect.arrayContaining(['architecture', 'coding-standards', 'networking-api'])
    );

    const planningBrief = asRecord(draft.data?.planningBrief);
    const projectContext = asRecord(planningBrief.projectContext);
    const repoFacts = asRecord(projectContext.repoFacts);
    expect(asArray(repoFacts.sourceFiles).length).toBeGreaterThan(0);
    const presenterInput = asRecord(projectContext.presenterInput);
    expect(asArray(presenterInput.envelopes).length).toBeGreaterThan(0);
    expect(asArray(presenterInput.files).length).toBeGreaterThan(0);
    expect(asArray(presenterInput.modules).length).toBeGreaterThan(0);

    const sourceReports = asRecord(draft.data?.sourceReports);
    const dimensionCatalog = asRecord(sourceReports.dimensionCatalog);
    const catalogDimensions = asArray(dimensionCatalog.dimensions).map(asRecord);
    expect(catalogDimensions).toHaveLength(25);
    expect(catalogDimensions.map((dimension) => String(dimension.id))).toEqual([
      ...ALL_DIMENSION_IDS,
    ]);
    expect(catalogDimensions.find((dimension) => dimension.id === 'architecture')).toMatchObject({
      languageApplicable: true,
      languageApplicability: { reason: 'universal-dimension' },
    });
    const planningAids = asRecord(sourceReports.planningAids);
    expect(planningAids).not.toHaveProperty('selection');
    expect(JSON.stringify(planningAids)).not.toMatch(
      /activeDimensionIds|skippedDimensionIds|lowConfidenceDimensions/
    );

    const missionBriefing = asRecord(sourceReports.missionBriefing);
    const missionDimensionIds = asArray(missionBriefing.dimensions)
      .map((dimension) => String(asRecord(dimension).id))
      .filter((id) => id.length > 0);
    expect(missionDimensionIds.length).toBeGreaterThan(10);
    expect(missionDimensionIds).toEqual(
      expect.arrayContaining(['architecture', 'coding-standards', 'networking-api'])
    );
    expect(missionBriefing).toHaveProperty('projectContext');
  });

  test('PlanInput schema routes confirm validation to complete Agent-authored payloads only', () => {
    expect(PlanInputSchema.safeParse({ operation: 'draft', hints: { maxBudget: 4 } }).success).toBe(
      true
    );
    expect(PlanInputSchema.safeParse({ operation: 'get', projectRoot }).success).toBe(true);

    const incomplete = PlanInputSchema.safeParse({
      operation: 'confirm',
      basePlanId: 'plan-test',
      baseVersion: 1,
      projectContextSignature: 'pcsig:test',
    });
    expect(incomplete.success).toBe(false);
    if (!incomplete.success) {
      const issuePaths = incomplete.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toEqual(
        expect.arrayContaining([
          'selectedDimensions',
          'scale',
          'moduleBindings',
          'plannedNextActions',
          'evidenceRefs',
          'rationale',
        ])
      );
    }

    const complete = PlanInputSchema.safeParse({
      operation: 'confirm',
      basePlanId: 'plan-test',
      baseVersion: 1,
      projectContextSignature: 'pcsig:test',
      selectedDimensions: confirmedDimensions(['architecture'], 'coldStart'),
      scale: {
        totalRecipeBudget: 3,
        perStage: { coldStart: 1, deepMining: 1, module: 1 },
        depthLevels: ['project'],
      },
      moduleBindings: [{ modulePath: 'src', dimensions: ['architecture'], targetRecipes: 1 }],
      plannedNextActions: [{ tool: 'alembic_recipe_map', reason: 'inspect source refs' }],
      evidenceRefs: [
        { kind: 'project-context', ref: 'pcsig:test', detail: 'schema regression fixture' },
      ],
      rationale: 'Agent authored a complete Plan payload.',
    });
    expect(complete.success).toBe(true);
  });

  test('draft surfaces focused Swift ProjectContext facts without local source guesses', async () => {
    await replaceFixtureProject(createSwiftFixtureProject());

    const draft = await draftPlan({
      focusModules: ['Sources/Features/VideoFeed', 'Sources/Infrastructure', 'BiliDili/Modules'],
      goal: 'RG-10 BiliDili planning truthfulness for Swift UI networking concurrency signals',
      maxBudget: 6,
    });

    expect(draft.success).toBe(true);
    expect(draft.errorCode).toBeUndefined();

    const planningBrief = asRecord(draft.data?.planningBrief);
    const projectContext = asRecord(planningBrief.projectContext);
    expect(projectContext).toMatchObject({
      factSource: 'project-context',
      primaryLanguage: 'swift',
    });
    expect(projectContext.fileCount as number).toBeGreaterThan(0);
    expect(projectContext.moduleCount as number).toBeGreaterThan(0);
    expect(asArray(projectContext.requestKinds)).toEqual(expect.arrayContaining(['repo']));
    expect(
      asArray(projectContext.moduleSeeds).map((seed) => String(asRecord(seed).modulePath))
    ).toEqual(expect.arrayContaining(['Sources', 'BiliDili', 'Package.swift']));
    const repoFacts = asRecord(projectContext.repoFacts);
    const repoSourceFiles = asArray(repoFacts.sourceFiles).map((file) =>
      String(asRecord(file).filePath)
    );
    expect(repoSourceFiles).toEqual(
      expect.arrayContaining([
        'Sources/Features/VideoFeed/VideoFeedViewController.swift',
        'Sources/Infrastructure/Networking/VideoAPIClient.swift',
        'BiliDili/Modules/NetworkModule.swift',
        'Package.swift',
      ])
    );
    expect(asRecord(repoFacts.sourceFilesByLanguage).swift).toBeGreaterThanOrEqual(4);
    const presenterInput = asRecord(projectContext.presenterInput);
    const presenterFilePaths = asArray(presenterInput.files).map((file) =>
      String(asRecord(file).filePath)
    );
    expect(presenterFilePaths).toEqual(
      expect.arrayContaining([
        'Sources/Features/VideoFeed/VideoFeedViewController.swift',
        'Sources/Infrastructure/Networking/VideoAPIClient.swift',
        'BiliDili/Modules/NetworkModule.swift',
      ])
    );
    expect(projectContext).not.toHaveProperty('fallbackDiagnostics');
    expect(projectContext).not.toHaveProperty('signatureScope');

    const sourceReports = asRecord(draft.data?.sourceReports);
    const dimensionCatalog = asRecord(sourceReports.dimensionCatalog);
    const catalogDimensions = asArray(dimensionCatalog.dimensions).map(asRecord);
    expect(catalogDimensions).toHaveLength(25);
    expect(catalogDimensions.map((dimension) => String(dimension.id))).toEqual([
      ...ALL_DIMENSION_IDS,
    ]);
    const catalogById = new Map(
      catalogDimensions.map((dimension) => [String(dimension.id), dimension])
    );
    expect(catalogById.get('architecture')).toMatchObject({
      languageApplicable: true,
      languageApplicability: { reason: 'universal-dimension' },
    });
    expect(catalogById.get('swift-objc-idiom')).toMatchObject({
      languageApplicable: true,
      languageApplicability: { reason: 'language-match', matchedLanguages: ['swift'] },
    });
    expect(catalogById.get('react-patterns')).toMatchObject({
      languageApplicable: false,
      languageApplicability: { reason: 'no-factual-match' },
    });
    expect(asRecord(dimensionCatalog.projectFacts)).toMatchObject({
      primaryLanguage: 'swift',
      languages: expect.arrayContaining(['swift']),
    });
    const planningAids = asRecord(sourceReports.planningAids);
    expect(planningAids).not.toHaveProperty('selection');
    expect(planningAids).not.toHaveProperty('recommendedDimensions');
    const missionBriefing = asRecord(sourceReports.missionBriefing);
    expect(missionBriefing).toHaveProperty('architectureOverview');
    expect(missionBriefing).toHaveProperty('ast');
    expect(missionBriefing).toHaveProperty('callGraph');
    expect(missionBriefing).toHaveProperty('dependencyGraph');
    expect(missionBriefing).toHaveProperty('guardFindings');
    expect(missionBriefing).toHaveProperty('mustCoverModules');
    const missionSourceFiles = asArray(asRecord(missionBriefing.projectContext).sourceFiles).map(
      (file) => String(asRecord(file).filePath)
    );
    expect(missionSourceFiles).toEqual(
      expect.arrayContaining([
        'Sources/Features/VideoFeed/VideoFeedViewController.swift',
        'Sources/Infrastructure/Networking/VideoAPIClient.swift',
      ])
    );
    const dynamicSignals = asRecord(sourceReports.dynamicSignals);
    expect(asArray(asRecord(dynamicSignals.coverage).byModule).length).toBeGreaterThan(0);

    const plan = asRecord(draft.data?.plan);
    expect(plan).not.toHaveProperty('planningBrief');
    const stored = repositories.planRepository.get(String(plan.planId), Number(plan.version));
    expect(stored?.planningBrief).toBeNull();

    const selectedDimensionIds = requireDimensionIdsFromDraftCatalog(draft, [
      'swift-objc-idiom',
      'react-patterns',
      'swiftui-patterns',
    ]);
    const confirmed = await callPlan({
      operation: 'confirm',
      basePlanId: String(plan.planId),
      baseVersion: Number(plan.version),
      projectContextSignature: String(draft.data?.projectContextSignature),
      selectedDimensions: confirmedDimensions(selectedDimensionIds, 'coldStart'),
      scale: {
        budgetLevel: 'focused',
        scale: 'small',
        totalRecipeBudget: 6,
        perStage: { coldStart: 3, deepMining: 2, module: 3 },
        depthLevels: ['project', 'module'],
      },
      moduleBindings: moduleBindingsFromDraft(draft, selectedDimensionIds),
      plannedNextActions: [
        {
          tool: 'alembic_bootstrap',
          reason: 'Run bounded test-mode scoped generation for confirmed RG-10 dimensions.',
          order: 1,
          dimensionIds: selectedDimensionIds,
        },
        {
          tool: 'alembic_rescan',
          reason: 'Run bounded moduleMining after controlled BiliDili commit changes.',
          order: 2,
          dimensionIds: selectedDimensionIds,
        },
      ],
      evidenceRefs: projectContextEvidenceRefs(draft),
      rationale:
        'RG-10 Test confirms an evidence-grounded BiliDili Plan from ProjectContext facts.',
    });
    expect(confirmed.success).toBe(true);
    const confirmedPlan = asRecord(confirmed.data?.plan);
    expect(confirmedPlan).toMatchObject({ planStatus: 'confirmed' });
    expect(confirmedPlan).not.toHaveProperty('planningBrief');
    expect(
      asArray(asRecord(confirmedPlan.intent).dimensions).map((dimension) =>
        String(asRecord(dimension).dimensionId)
      )
    ).toEqual(selectedDimensionIds);
    expect(asRecord(confirmed.data?.projectContextCreationGuide)).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'plan-confirm',
      confirmedPlanBoundary: {
        dimensionIds: selectedDimensionIds,
      },
    });

    const get = await callPlan({ operation: 'get' });
    expect(get.success).toBe(true);
    const getPlan = asRecord(get.data?.plan);
    expect(
      asArray(asRecord(getPlan.intent).dimensions).map((dimension) =>
        String(asRecord(dimension).dimensionId)
      )
    ).toEqual(selectedDimensionIds);
    expect(asRecord(get.data?.projectContextCreationGuide)).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'plan-get',
      confirmedPlanBoundary: {
        dimensionIds: selectedDimensionIds,
        moduleScope: expect.arrayContaining(['Sources', 'BiliDili', 'Package.swift']),
        planId: String(plan.planId),
      },
    });
  });

  test('confirm rejects stale focused Swift drafts after scoped source changes', async () => {
    await replaceFixtureProject(createSwiftFixtureProject());

    const draft = await draftPlan({
      focusModules: ['Sources/Features/VideoFeed', 'Sources/Infrastructure', 'BiliDili/Modules'],
      goal: 'RG-10 stale signature protection for focused Swift ProjectContext scope',
      maxBudget: 6,
    });
    expect(draft.success).toBe(true);

    writeFile(
      projectRoot,
      'Sources/Features/VideoFeed/VideoFeedCoordinator.swift',
      [
        'import SwiftUI',
        'import Infrastructure',
        '',
        'struct VideoFeedCoordinator: View {',
        '  var body: some View { Text("Fresh Feed") }',
        '}',
        '',
      ].join('\n')
    );

    const plan = asRecord(draft.data?.plan);
    const selectedDimensionIds = dimensionIdsFromDraftFacts(draft, 2);
    const stale = await callPlan({
      operation: 'confirm',
      basePlanId: String(plan.planId),
      baseVersion: Number(plan.version),
      projectContextSignature: String(draft.data?.projectContextSignature),
      selectedDimensions: confirmedDimensions(selectedDimensionIds, 'coldStart'),
      scale: {
        budgetLevel: 'focused',
        scale: 'small',
        totalRecipeBudget: 4,
        perStage: { coldStart: 2, deepMining: 1, module: 2 },
        depthLevels: ['project', 'module'],
      },
      moduleBindings: moduleBindingsFromDraft(draft, selectedDimensionIds),
      plannedNextActions: [
        {
          tool: 'alembic_bootstrap',
          reason: 'Confirm stale protection before generation.',
          order: 1,
          dimensionIds: selectedDimensionIds,
        },
      ],
      evidenceRefs: projectContextEvidenceRefs(draft),
      rationale: 'The source changed after draft, so strict confirm must reject it.',
    });

    expect(stale).toMatchObject({
      success: false,
      errorCode: 'PLAN_PROJECT_CONTEXT_STALE',
    });
    expect(asRecord(stale.data?.signature)).toMatchObject({ matches: false });
  });

  test('confirm rejects signature echo mismatch and stale base versions before confirming intent', async () => {
    const draft = await draftPlan();
    const plan = asRecord(draft.data?.plan);
    const planId = String(plan.planId);
    const version = Number(plan.version);
    const signature = String(draft.data?.projectContextSignature);

    const mismatch = await callPlan({
      operation: 'confirm',
      basePlanId: planId,
      baseVersion: version,
      projectContextSignature: 'pcsig:not-the-draft',
    });
    expect(mismatch).toMatchObject({
      success: false,
      errorCode: 'PLAN_SIGNATURE_ECHO_MISMATCH',
    });

    const missingPayload = await callPlan({
      operation: 'confirm',
      basePlanId: planId,
      baseVersion: version,
      projectContextSignature: signature,
    });
    expect(missingPayload).toMatchObject({
      success: false,
      errorCode: 'PLAN_CONFIRM_PAYLOAD_REQUIRED',
    });

    const storedDraft = repositories.planRepository.get(planId, version);
    expect(storedDraft).toBeTruthy();
    if (!storedDraft) {
      throw new Error('Expected stored draft Plan in stale-version test.');
    }
    repositories.planRepository.saveDraft({
      planId,
      projectRoot,
      projectContextSignature: signature,
      rationale: ['newer draft for stale-version test'],
    });
    const selectedDimensionIds = dimensionIdsFromDraftFacts(draft, 1);

    const stale = await callPlan({
      operation: 'confirm',
      basePlanId: planId,
      baseVersion: version,
      projectContextSignature: signature,
      selectedDimensions: confirmedDimensions(selectedDimensionIds, 'coldStart'),
      scale: {
        totalRecipeBudget: 3,
        perStage: { coldStart: 2, deepMining: 1, module: 1 },
        depthLevels: ['project'],
      },
      moduleBindings: [
        {
          modulePath: 'src',
          dimensions: selectedDimensionIds,
          targetRecipes: 2,
        },
      ],
      plannedNextActions: [{ tool: 'alembic_recipe_map', reason: 'inspect planned source refs' }],
      evidenceRefs: projectContextEvidenceRefs(draft),
      rationale: 'Agent confirms the tested Plan intent.',
    });
    expect(stale).toMatchObject({
      success: false,
      errorCode: 'PLAN_STALE_VERSION',
    });

    const latest = repositories.planRepository.get(planId);
    expect(latest?.version).toBe(version + 1);
    const confirmed = await callPlan({
      operation: 'confirm',
      basePlanId: planId,
      baseVersion: version + 1,
      projectContextSignature: signature,
      selectedDimensions: confirmedDimensions(selectedDimensionIds, 'coldStart'),
      scale: {
        totalRecipeBudget: 3,
        perStage: { coldStart: 2, deepMining: 1, module: 1 },
        depthLevels: ['project'],
      },
      moduleBindings: [
        {
          modulePath: 'src',
          dimensions: selectedDimensionIds,
          targetRecipes: 2,
        },
      ],
      plannedNextActions: [{ tool: 'alembic_recipe_map', reason: 'inspect planned source refs' }],
      evidenceRefs: projectContextEvidenceRefs(draft),
      rationale: 'Agent confirmed the tested Plan intent.',
    });

    expect(confirmed).toMatchObject({ success: true });
    const confirmedPlan = asRecord(confirmed.data?.plan);
    expect(confirmedPlan).toMatchObject({ planStatus: 'confirmed' });
    expect(confirmedPlan).not.toHaveProperty('planningBrief');
    expect(repositories.planRepository.getActiveConfirmed(projectRoot)?.planId).toBe(planId);
  });

  test('get returns active confirmed Plan with Core read-time generation-state projection', async () => {
    const draft = await draftPlan();
    const plan = asRecord(draft.data?.plan);
    const storedDraft = repositories.planRepository.get(String(plan.planId), Number(plan.version));
    if (!storedDraft) {
      throw new Error('Expected stored draft Plan in projection test.');
    }
    const dimensionId = dimensionIdsFromDraftFacts(draft, 1)[0];
    const signature = String(draft.data?.projectContextSignature);
    const confirmed = await callPlan({
      operation: 'confirm',
      basePlanId: String(plan.planId),
      baseVersion: Number(plan.version),
      projectContextSignature: signature,
      selectedDimensions: confirmedDimensions([dimensionId], 'coldStart').map((dimension) => ({
        ...dimension,
        targetRecipes: 2,
      })),
      moduleBindings: [{ modulePath: 'src', dimensions: [dimensionId], targetRecipes: 2 }],
      scale: {
        totalRecipeBudget: 2,
        perStage: { coldStart: 1, deepMining: 1, module: 1 },
        depthLevels: ['project'],
      },
      plannedNextActions: [{ tool: 'alembic_bootstrap', reason: 'Run projection fixture.' }],
      evidenceRefs: projectContextEvidenceRefs(draft),
      rationale: 'Projection fixture confirms a complete Plan payload.',
    });
    expect(confirmed.success).toBe(true);

    const recipe = new KnowledgeEntry({
      id: 'recipe-plan-architecture',
      title: 'React app entrypoint recipe',
      description: 'Recipe anchored to the fixture app source.',
      lifecycle: 'active',
      language: 'typescript',
      dimensionId,
      category: 'architecture',
      knowledgeType: 'code-pattern',
      sourceFile: 'src/App.tsx',
      content: {
        pattern: 'App composes the React view and API client.',
        rationale: 'Used by alembic_plan projection test.',
      },
      reasoning: {
        confidence: 0.9,
        sources: ['src/App.tsx'],
        whyStandard: 'Entrypoint source is the correct architectural anchor.',
      },
    });
    await repositories.knowledgeRepository.create(recipe);
    repositories.recipeSourceRefRepository.upsert({
      recipeId: recipe.id,
      sourcePath: 'src/App.tsx',
      status: 'active',
      verifiedAt: 100,
    });
    const unanchoredRecipe = new KnowledgeEntry({
      id: 'recipe-plan-unanchored',
      title: 'React API client unanchored recipe',
      description: 'Recipe has a legacy sourceFile but no recipe_source_refs bridge.',
      lifecycle: 'active',
      language: 'typescript',
      dimensionId,
      category: 'architecture',
      knowledgeType: 'code-pattern',
      sourceFile: 'src/api/client.ts',
      content: {
        pattern: 'The API client fetches user data.',
        rationale: 'Used by alembic_plan missing source-ref projection test.',
      },
      reasoning: {
        confidence: 0.9,
        sources: ['src/api/client.ts'],
        whyStandard: 'Legacy sourceFile without source refs must not count as generated.',
      },
    });
    await repositories.knowledgeRepository.create(unanchoredRecipe);

    const get = await callPlan({ operation: 'get' });
    expect(get.success).toBe(true);
    expect(asRecord(get.data?.plan)).not.toHaveProperty('planningBrief');
    expect(asRecord(asRecord(get.data?.planView).intent)).not.toHaveProperty('planningBrief');
    const planState = asRecord(get.data?.planState);
    expect(asArray(planState.codeRecipeMapping)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          codeRegion: 'src/App.tsx',
          recipeIds: ['recipe-plan-architecture'],
          status: 'generated',
        }),
      ])
    );
    expect(asArray(planState.codeRecipeMapping)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          codeRegion: 'src/api/client.ts',
          recipeIds: ['recipe-plan-unanchored'],
          status: 'missing',
        }),
      ])
    );
    const coverage = asRecord(planState.coverage);
    const byDimension = asRecord(coverage.byDimension);
    expect(asRecord(byDimension[dimensionId])).toMatchObject({ generated: 1 });
    const byModuleDimension = asRecord(coverage.byModuleDimension);
    expect(asRecord(asRecord(byModuleDimension.src)[dimensionId])).toMatchObject({
      generated: 1,
      missing: 1,
      planned: 2,
    });
    expect(asArray(coverage.gaps)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimensionId,
          modulePath: 'src',
          generated: 1,
          missing: 1,
          planned: 2,
        }),
      ])
    );
    expect(asRecord(get.data?.signature)).toMatchObject({ matches: true });
    expect(asRecord(get.data?.projectContextCreationGuide)).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'plan-get',
      confirmedPlanBoundary: {
        dimensionIds: [dimensionId],
        moduleScope: ['src'],
        planId: String(plan.planId),
      },
    });
    expect(asArray(asRecord(get.data?.projectContextCreationGuide).nextActions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'alembic_submit_knowledge',
          argsTemplate: expect.objectContaining({
            items: [
              expect.objectContaining({
                dimensionId,
              }),
            ],
          }),
        }),
      ])
    );
    expect(actionTools(asArray(get.data?.nextActions))).toEqual(
      expect.arrayContaining([
        'alembic_recipe_map',
        'alembic_graph',
        'alembic_search',
        'alembic_prime',
        'alembic_submit_knowledge',
      ])
    );
  });
});

async function draftPlan(hints: Record<string, unknown> = {}): Promise<PlanToolResponse> {
  return callPlan({ operation: 'draft', hints });
}

async function replaceFixtureProject(nextProjectRoot: string): Promise<void> {
  runtime.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = nextProjectRoot;
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  runtime = await openAlembicDatabase(
    { path: path.join(projectRoot, '.asd', 'alembic.db') },
    { workspaceResolver: WorkspaceResolver.fromProject(projectRoot) }
  );
  repositories = createAlembicRepositories(runtime.connection);
}

async function callPlan(args: Record<string, unknown>): Promise<PlanToolResponse> {
  return (await routePlanTool(createContext(), { projectRoot, ...args })) as PlanToolResponse;
}

function createContext(): McpContext {
  const services: Record<string, unknown> = {
    knowledgeRepository: repositories.knowledgeRepository,
    lifecycleEventRepository: repositories.lifecycleEventRepository,
    planRepository: repositories.planRepository,
    proposalRepository: repositories.proposalRepository,
    recipeSourceRefRepository: repositories.recipeSourceRefRepository,
  };
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: (name: string) => {
        if (!(name in services)) {
          throw new Error(`missing service ${name}`);
        }
        return services[name];
      },
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tool-fixture-'));
  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'plan-tool-fixture',
        main: 'src/App.tsx',
        scripts: { test: 'vitest run' },
        dependencies: { react: '^19.0.0', '@tanstack/react-query': '^5.0.0' },
        devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' },
      },
      null,
      2
    )
  );
  writeFile(
    root,
    'src/App.tsx',
    [
      'import React from "react";',
      'import { fetchUser } from "./api/client";',
      'export function App() {',
      '  return <main>{fetchUser("42").name}</main>;',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'src/api/client.ts',
    ['export function fetchUser(id: string) {', '  return { id, name: "Ada" };', '}', ''].join('\n')
  );
  writeFile(
    root,
    'src/App.test.ts',
    [
      'import { describe, expect, test } from "vitest";',
      'import { fetchUser } from "./api/client";',
      'describe("fetchUser", () => {',
      '  test("returns a user", () => expect(fetchUser("1").name).toBe("Ada"));',
      '});',
      '',
    ].join('\n')
  );
  return root;
}

function createSwiftFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tool-swift-fixture-'));
  writeFile(
    root,
    'Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(',
      '  name: "BiliDiliFixture",',
      '  platforms: [.iOS(.v17)],',
      '  products: [.library(name: "BiliDiliFixture", targets: ["VideoFeed", "Infrastructure"])],',
      '  targets: [',
      '    .target(name: "VideoFeed", dependencies: ["Infrastructure"], path: "Sources/Features/VideoFeed"),',
      '    .target(name: "Infrastructure", path: "Sources/Infrastructure"),',
      '  ]',
      ')',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/Features/VideoFeed/VideoFeedViewController.swift',
    [
      'import UIKit',
      'import SwiftUI',
      'import Infrastructure',
      '',
      'final class VideoFeedViewController: UIViewController {',
      '  private let client = VideoAPIClient()',
      '  override func viewDidLoad() {',
      '    super.viewDidLoad()',
      '    Task { await loadFeed() }',
      '  }',
      '  private func loadFeed() async {',
      '    _ = try? await client.fetchFeed()',
      '  }',
      '}',
      '',
      'struct VideoFeedPreview: View {',
      '  var body: some View { Text("Feed") }',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/Infrastructure/Networking/VideoAPIClient.swift',
    [
      'import Foundation',
      'import Combine',
      '',
      'public final class VideoAPIClient {',
      '  public init() {}',
      '  public func fetchFeed() async throws -> Data {',
      '    let url = URL(string: "https://example.test/feed")!',
      '    let (data, _) = try await URLSession.shared.data(from: url)',
      '    return data',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/Infrastructure/Concurrency/FeedRefreshActor.swift',
    [
      'import Foundation',
      '',
      'public actor FeedRefreshActor {',
      '  public func refresh(using client: VideoAPIClient) async throws -> Data {',
      '    try await client.fetchFeed()',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'BiliDili/Modules/NetworkModule.swift',
    [
      'import UIKit',
      'import Foundation',
      '',
      'final class NetworkModule {',
      '  func register() {',
      '    DispatchQueue.main.async { _ = UIView() }',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  return root;
}

function writeFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function dimensionIdsFromDraftFacts(draft: PlanToolResponse, count: number): string[] {
  const guide = asRecord(draft.data?.projectContextCreationGuide);
  const boundary = asRecord(guide.confirmedPlanBoundary);
  const guideDimensionIds = asArray(boundary.dimensionIds)
    .map(String)
    .filter((id) => id.length > 0)
    .slice(0, count);
  if (guideDimensionIds.length > 0) {
    return guideDimensionIds;
  }
  const sourceReports = asRecord(draft.data?.sourceReports);
  const missionBriefing = asRecord(sourceReports.missionBriefing);
  const missionDimensionIds = asArray(missionBriefing.dimensions)
    .map((dimension) => String(asRecord(dimension).id))
    .filter((id) => id.length > 0)
    .slice(0, count);
  if (missionDimensionIds.length === 0) {
    throw new Error('Expected draft fact package to include dimension ids.');
  }
  return missionDimensionIds;
}

function requireDimensionIdsFromDraftCatalog(
  draft: PlanToolResponse,
  dimensionIds: readonly string[]
): string[] {
  const sourceReports = asRecord(draft.data?.sourceReports);
  const catalog = asRecord(sourceReports.dimensionCatalog);
  const catalogIds = new Set(
    asArray(catalog.dimensions)
      .map((dimension) => String(asRecord(dimension).id))
      .filter((id) => id.length > 0)
  );
  for (const dimensionId of dimensionIds) {
    if (!catalogIds.has(dimensionId)) {
      throw new Error(`Expected draft dimension catalog to include ${dimensionId}.`);
    }
  }
  return [...dimensionIds];
}

function confirmedDimensions(
  dimensionIds: readonly string[],
  stage: 'coldStart' | 'deepMining'
): Array<{
  id: string;
  priority: number;
  rationale: string;
  stage: 'coldStart' | 'deepMining';
  targetRecipes: number;
}> {
  return dimensionIds.map((id, index) => ({
    id,
    priority: index + 1,
    rationale: `Agent-authored Plan dimension ${id}`,
    stage,
    targetRecipes: 1,
  }));
}

function projectContextEvidenceRefs(
  draft: PlanToolResponse
): Array<{ kind: 'project-context'; ref: string; detail: string }> {
  return [
    {
      kind: 'project-context',
      ref: String(draft.data?.projectContextSignature),
      detail: 'draft fact package signature',
    },
  ];
}

function moduleBindingsFromDraft(
  draft: PlanToolResponse,
  dimensionIds: string[]
): Array<{
  dimensions: string[];
  modulePath: string;
  priority: number;
  targetRecipes: number;
}> {
  const planningBrief = asRecord(draft.data?.planningBrief);
  const projectContext = asRecord(planningBrief.projectContext);
  return asArray(projectContext.moduleSeeds)
    .map((seed) => asRecord(seed))
    .map((seed, index) => ({
      dimensions: dimensionIds,
      modulePath: String(seed.modulePath ?? ''),
      priority: index + 1,
      targetRecipes: 1,
    }))
    .filter((binding) => binding.modulePath.length > 0)
    .slice(0, 3);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function actionTools(actions: unknown[]): string[] {
  return actions.map((action) => String(asRecord(action).tool));
}
