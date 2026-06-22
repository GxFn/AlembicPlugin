import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import { KnowledgeEntry } from '@alembic/core/knowledge';
import {
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { routePlanTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

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

  test('draft persists a Core Plan from real ProjectContext and dynamic planning signals', async () => {
    const draft = await draftPlan({ maxBudget: 6, maxRecommendedDimensions: 4 });

    expect(draft.success).toBe(true);
    expect(draft.data?.projectContextSignature).toMatch(/^pcsig:/);
    expect(draft.data?.plan).toMatchObject({ planStatus: 'draft', version: 1 });

    const planningBrief = asRecord(draft.data?.planningBrief);
    const projectContext = asRecord(planningBrief.projectContext);
    expect(projectContext.fileCount as number).toBeGreaterThan(0);
    expect(projectContext.requestKinds).toEqual(expect.arrayContaining(['space', 'repo']));

    const sourceReports = asRecord(draft.data?.sourceReports);
    const planningAids = asRecord(sourceReports.planningAids);
    expect(asArray(planningAids.dimensionOrder).length).toBeGreaterThan(0);
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
    const planSignalKinds = asArray(dynamicSignals.planSignals).map((item) => asRecord(item).kind);
    expect(planSignalKinds).toContain('new-module');

    const plan = asRecord(draft.data?.plan);
    const stored = repositories.planRepository.get(String(plan.planId), Number(plan.version));
    expect(stored?.planningBrief).toMatchObject({
      projectContext: expect.objectContaining({ primaryLanguage: 'typescript' }),
    });
    expect(JSON.stringify(stored?.intent)).not.toContain('codeRecipeMapping');
  });

  test('draft grounds focused Swift projects with repo-level ProjectContext fallback', async () => {
    await replaceFixtureProject(createSwiftFixtureProject());

    const draft = await draftPlan({
      focusModules: ['Sources/Features/VideoFeed', 'Sources/Infrastructure', 'BiliDili/Modules'],
      goal: 'RG-10 BiliDili planning truthfulness for Swift UI networking concurrency signals',
      maxBudget: 6,
      maxRecommendedDimensions: 8,
    });

    expect(draft.success).toBe(true);
    expect(draft.errorCode).toBeUndefined();

    const planningBrief = asRecord(draft.data?.planningBrief);
    const projectContext = asRecord(planningBrief.projectContext);
    expect(projectContext).toMatchObject({
      factSource: 'project-context-repo-fallback',
      primaryLanguage: 'swift',
    });
    expect(projectContext.fileCount as number).toBeGreaterThan(0);
    expect(projectContext.moduleCount as number).toBeGreaterThan(0);
    expect(asArray(projectContext.requestKinds)).toEqual(expect.arrayContaining(['repo']));
    expect(asArray(projectContext.frameworks)).toEqual(
      expect.arrayContaining(['swiftui', 'uikit', 'networking', 'async'])
    );
    expect(
      asArray(projectContext.moduleSeeds).map((seed) => String(asRecord(seed).modulePath))
    ).toEqual(
      expect.arrayContaining([
        'Sources/Features/VideoFeed',
        'Sources/Infrastructure',
        'BiliDili/Modules',
      ])
    );
    expect(asArray(projectContext.fallbackDiagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'project-context-repo-fallback',
          fileCount: expect.any(Number),
        }),
      ])
    );

    const sourceReports = asRecord(draft.data?.sourceReports);
    const planningAids = asRecord(sourceReports.planningAids);
    const recommendedDimensions = asArray(planningAids.recommendedDimensions).map((item) =>
      String(asRecord(item).dimensionId)
    );
    expect(recommendedDimensions).toEqual(
      expect.arrayContaining(['swift-objc-idiom', 'swiftui-patterns'])
    );
    expect(recommendedDimensions).toEqual(
      expect.arrayContaining(['networking-api', 'concurrency-async'])
    );

    const plan = asRecord(draft.data?.plan);
    const stored = repositories.planRepository.get(String(plan.planId), Number(plan.version));
    expect(stored?.planningBrief).toMatchObject({
      projectContext: expect.objectContaining({
        factSource: 'project-context-repo-fallback',
        primaryLanguage: 'swift',
      }),
    });
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

    const storedDraft = repositories.planRepository.get(planId, version);
    expect(storedDraft).toBeTruthy();
    if (!storedDraft) {
      throw new Error('Expected stored draft Plan in stale-version test.');
    }
    repositories.planRepository.saveDraft({
      planId,
      projectRoot,
      projectContextSignature: signature,
      intent: storedDraft.intent,
      planningBrief: storedDraft.planningBrief,
      rationale: ['newer draft for stale-version test'],
    });

    const stale = await callPlan({
      operation: 'confirm',
      basePlanId: planId,
      baseVersion: version,
      projectContextSignature: signature,
      selectedDimensions: [
        { id: firstDimensionId(storedDraft.intent), reason: 'confirm baseline' },
      ],
    });
    expect(stale).toMatchObject({
      success: false,
      errorCode: 'PLAN_STALE_VERSION',
    });

    const confirmed = await callPlan({
      operation: 'confirm',
      basePlanId: planId,
      baseVersion: version,
      projectContextSignature: signature,
      allowStaleVersion: true,
      selectedDimensions: [
        { id: firstDimensionId(storedDraft.intent), reason: 'confirm baseline' },
      ],
      scale: { totalRecipeBudget: 3, perStage: { coldStart: 2, deepMining: 1, module: 1 } },
      moduleBindings: [
        {
          modulePath: 'src',
          dimensions: [firstDimensionId(storedDraft.intent)],
          targetRecipes: 2,
        },
      ],
      plannedNextActions: [{ tool: 'alembic_recipe_map', reason: 'inspect planned source refs' }],
      rationale: 'Agent confirmed the tested Plan intent.',
    });

    expect(confirmed).toMatchObject({ success: true });
    expect(asRecord(confirmed.data?.plan)).toMatchObject({ planStatus: 'confirmed' });
    expect(repositories.planRepository.getActiveConfirmed(projectRoot)?.planId).toBe(planId);
  });

  test('get returns active confirmed Plan with Core read-time generation-state projection', async () => {
    const draft = await draftPlan();
    const plan = asRecord(draft.data?.plan);
    const storedDraft = repositories.planRepository.get(String(plan.planId), Number(plan.version));
    if (!storedDraft) {
      throw new Error('Expected stored draft Plan in projection test.');
    }
    const dimensionId = firstDimensionId(storedDraft.intent);
    const signature = String(draft.data?.projectContextSignature);
    const confirmed = await callPlan({
      operation: 'confirm',
      basePlanId: String(plan.planId),
      baseVersion: Number(plan.version),
      projectContextSignature: signature,
      selectedDimensions: [{ id: dimensionId, reason: 'projection fixture' }],
      moduleBindings: [{ modulePath: 'src', dimensions: [dimensionId], targetRecipes: 2 }],
      scale: { totalRecipeBudget: 2, perStage: { coldStart: 1, deepMining: 1, module: 1 } },
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

    const get = await callPlan({ operation: 'get' });
    expect(get.success).toBe(true);
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
    const coverage = asRecord(planState.coverage);
    const byDimension = asRecord(coverage.byDimension);
    expect(asRecord(byDimension[dimensionId])).toMatchObject({ generated: 1 });
    expect(asRecord(get.data?.signature)).toMatchObject({ matches: true });
    expect(asRecord(get.data?.projectContextCreationGuide)).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'plan-get',
      confirmedPlanBoundary: {
        moduleScope: ['src'],
        planId: String(plan.planId),
      },
    });
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

function firstDimensionId(intent: unknown): string {
  const dimensions = asArray(asRecord(intent).dimensions);
  const first = asRecord(dimensions[0]);
  return String(first.dimensionId);
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
