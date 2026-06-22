import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import {
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runHostAgentColdStartWorkflow } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';
import { runHostAgentKnowledgeRescanWorkflow } from '../../lib/recipe-generation/host-agent-workflows/knowledge-rescan.js';
import {
  acquirePlanGenerationLease,
  type PlanGenerationGateReady,
} from '../../lib/recipe-generation/plan-generation-gate.js';
import { routePlanTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

interface ToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message?: string;
  success: boolean;
}

let projectRoot: string;
let runtime: AlembicDatabaseRuntime;
let repositories: AlembicRepositoryBundle;

const silentLogger = {
  info() {},
  warn() {},
};

describe('Plan-driven generation gate', () => {
  beforeEach(async () => {
    projectRoot = createFixtureProject();
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

  test('blocks bootstrap before cleanup when no confirmed Plan exists', async () => {
    const result = (await runHostAgentColdStartWorkflow(createContext(), {
      rebuild: true,
    })) as ToolResponse;

    expect(result).toMatchObject({
      success: false,
      errorCode: 'PLAN_REQUIRED',
    });
    expect(result.data).toMatchObject({
      needsUserInput: true,
      planGate: expect.objectContaining({ status: 'blocked', generationStage: 'coldStart' }),
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
  });

  test('confirmed Plan drives bootstrap testMode without fullReset', async () => {
    const { dimensionId } = await confirmPlan({
      dimensionStage: 'coldStart',
      modulePath: 'src/api',
    });

    const result = (await runHostAgentColdStartWorkflow(createContext(), {
      dimensions: [dimensionId],
      scaleOverride: { maxFiles: 6, contentMaxLines: 12, totalRecipeBudget: 1 },
      testMode: true,
    })) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.planGate).toMatchObject({
      cleanupPolicy: 'none',
      generationStage: 'coldStart',
      selectedDimensions: [dimensionId],
      testMode: true,
    });
    expect(result.data?.testMode).toMatchObject({
      enabled: true,
      dimensions: [dimensionId],
    });
    expect(result.data?.projectContextCreationGuide).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'bootstrap',
      confirmedPlanBoundary: {
        generationStage: 'coldStart',
        moduleScope: ['src/api'],
        testMode: true,
      },
    });
    expect(actionTools(asArray(result.data?.recipeCreationNextActions))).toEqual(
      expect.arrayContaining([
        'alembic_recipe_map',
        'alembic_graph',
        'alembic_search',
        'alembic_prime',
        'alembic_submit_knowledge',
      ])
    );
    expect(asRecord(result.data?.cleanup)).toMatchObject({
      clearedTables: 0,
      deletedRecipes: 0,
      trash: null,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
  });

  test('focused Swift confirmed Plan drives bootstrap with scoped signature reuse', async () => {
    await replaceFixtureProject(createSwiftFixtureProject());
    const focusModules = [
      'Sources/Features/VideoFeed',
      'Sources/Infrastructure',
      'BiliDili/Modules',
    ];
    const { dimensionId } = await confirmPlan({
      dimensionStage: 'coldStart',
      draftHints: {
        focusModules,
        goal: 'RG-10 focused BiliDili generation gate regression',
        maxBudget: 6,
        maxRecommendedDimensions: 6,
      },
      modulePath: 'Sources/Features/VideoFeed',
    });

    const activePlan = (await routePlanTool(createContext(), {
      operation: 'get',
      projectRoot,
    })) as ToolResponse;
    expect(activePlan.success).toBe(true);
    expect(activePlan.data?.currentProjectContextSignature).toBe(
      activePlan.data?.projectContextSignature
    );
    expect(asRecord(activePlan.data?.signature)).toMatchObject({ matches: true });

    const result = (await runHostAgentColdStartWorkflow(createContext(), {
      dimensions: [dimensionId],
      scaleOverride: { maxFiles: 8, contentMaxLines: 16, totalRecipeBudget: 1 },
      testMode: true,
    })) as ToolResponse;

    expect(result.success).toBe(true);
    expect(asRecord(result.data?.planGate)).toMatchObject({
      cleanupPolicy: 'none',
      generationStage: 'coldStart',
      signature: expect.objectContaining({ matches: true }),
      testMode: true,
    });
    expect(result.data?.testMode).toMatchObject({
      enabled: true,
      dimensions: [dimensionId],
    });
  });

  test('focused Swift generation gate rejects scoped source changes after confirmation', async () => {
    await replaceFixtureProject(createSwiftFixtureProject());
    const { dimensionId } = await confirmPlan({
      dimensionStage: 'coldStart',
      draftHints: {
        focusModules: ['Sources/Features/VideoFeed', 'Sources/Infrastructure', 'BiliDili/Modules'],
        goal: 'RG-10 focused BiliDili stale gate regression',
        maxBudget: 6,
        maxRecommendedDimensions: 6,
      },
      modulePath: 'Sources/Features/VideoFeed',
    });
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

    const result = (await runHostAgentColdStartWorkflow(createContext(), {
      dimensions: [dimensionId],
      scaleOverride: { maxFiles: 8, contentMaxLines: 16, totalRecipeBudget: 1 },
      testMode: true,
    })) as ToolResponse;

    expect(result).toMatchObject({
      success: false,
      errorCode: 'PLAN_PROJECT_CONTEXT_STALE',
    });
    expect(asRecord(asRecord(result.data?.planGate).signature)).toMatchObject({
      matches: false,
    });
  });

  test('confirmed Plan drives moduleMining rescan with scoped ProjectContext and no cleanup', async () => {
    const { dimensionId } = await confirmPlan({
      dimensionStage: 'deepMining',
      modulePath: 'src/api',
    });

    const result = (await runHostAgentKnowledgeRescanWorkflow(createContext(), {
      dimensions: [dimensionId],
      generationStage: 'moduleMining',
      moduleScope: ['src/api'],
      reason: 'rg4 moduleMining test mode',
      scaleOverride: { maxFiles: 6, contentMaxLines: 12, totalRecipeBudget: 1 },
      testMode: true,
    })) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.planGate).toMatchObject({
      cleanupPolicy: 'none',
      generationStage: 'moduleMining',
      moduleScope: ['src/api'],
      selectedDimensions: [dimensionId],
      testMode: true,
    });
    expect(result.data?.moduleScope).toEqual(['src/api']);
    expect(result.data?.projectContextCreationGuide).toMatchObject({
      source: 'RG-5-project-context-anchored-creation',
      stage: 'rescan',
      confirmedPlanBoundary: {
        generationStage: 'moduleMining',
        moduleScope: ['src/api'],
        testMode: true,
      },
    });
    expect(actionTools(asArray(result.data?.recipeCreationNextActions))).toEqual(
      expect.arrayContaining([
        'alembic_recipe_map',
        'alembic_graph',
        'alembic_search',
        'alembic_prime',
        'alembic_submit_knowledge',
      ])
    );
    expect(asRecord(result.data?.rescan)).toMatchObject({
      cleanedFiles: 0,
      cleanedTables: 0,
      archive: null,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
  });

  test('moduleMining lease blocks duplicate rescanId until release', () => {
    const gate = buildReadyGate({
      cleanupPolicy: 'none',
      generationStage: 'moduleMining',
      moduleScope: ['src/api'],
      testMode: true,
    });
    const first = acquirePlanGenerationLease({
      gate,
      idempotencyKey: 'rg4-module-mining-rescan',
      toolName: 'alembic_rescan',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error('expected first lease acquisition to succeed');
    }

    try {
      const duplicate = acquirePlanGenerationLease({
        gate,
        idempotencyKey: 'rg4-module-mining-rescan',
        toolName: 'alembic_rescan',
      });

      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) {
        duplicate.lease.release();
        throw new Error('expected duplicate lease acquisition to be blocked');
      }
      expect(duplicate.response).toMatchObject({
        success: false,
        errorCode: 'PLAN_GENERATION_IN_PROGRESS',
        data: {
          needsUserInput: false,
          planGate: {
            status: 'in-progress',
            generationStage: 'moduleMining',
            cleanupPolicy: 'none',
          },
        },
      });
      expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
    } finally {
      first.lease.release();
    }

    const afterRelease = acquirePlanGenerationLease({
      gate,
      idempotencyKey: 'rg4-module-mining-rescan',
      toolName: 'alembic_rescan',
    });
    expect(afterRelease.ok).toBe(true);
    if (afterRelease.ok) {
      afterRelease.lease.release();
    }
  });
});

async function confirmPlan(input: {
  dimensionStage: 'coldStart' | 'deepMining';
  draftHints?: Record<string, unknown>;
  modulePath: string;
}): Promise<{ dimensionId: string; planId: string; version: number }> {
  const draft = (await routePlanTool(createContext(), {
    operation: 'draft',
    allowSignatureMismatch: false,
    allowStaleVersion: false,
    projectRoot,
    hints: {
      maxBudget: 3,
      maxRecommendedDimensions: 3,
      ...(input.draftHints ?? {}),
    },
  })) as ToolResponse;
  if (!draft.success) {
    throw new Error(`draft failed: ${JSON.stringify(draft, null, 2)}`);
  }
  const plan = asRecord(draft.data?.plan);
  const stored = repositories.planRepository.get(String(plan.planId), Number(plan.version));
  if (!stored) {
    throw new Error('Expected draft Plan to be persisted.');
  }
  const dimensionId = stored.intent.dimensions[0]?.dimensionId;
  if (!dimensionId) {
    throw new Error('Expected draft Plan to contain at least one dimension.');
  }
  const signature = String(draft.data?.projectContextSignature);
  const confirmed = (await routePlanTool(createContext(), {
    operation: 'confirm',
    allowSignatureMismatch: false,
    allowStaleVersion: false,
    basePlanId: String(plan.planId),
    baseVersion: Number(plan.version),
    projectContextSignature: signature,
    selectedDimensions: [
      {
        id: dimensionId,
        reason: `RG4 ${input.dimensionStage} fixture`,
        stage: input.dimensionStage,
        targetRecipes: 1,
      },
    ],
    scale: {
      totalRecipeBudget: 2,
      perStage: { coldStart: 1, deepMining: 1, module: 1 },
    },
    moduleBindings: [
      {
        modulePath: input.modulePath,
        dimensions: [dimensionId],
        targetRecipes: 1,
      },
    ],
    plannedNextActions: [
      {
        tool: 'alembic_rescan',
        reason: 'RG4 Plan-driven generation fixture',
      },
    ],
  })) as ToolResponse;
  expect(confirmed.success).toBe(true);
  return {
    dimensionId,
    planId: String(plan.planId),
    version: Number(plan.version),
  };
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

function createContext(): McpContext {
  const services: Record<string, unknown> = {
    database: runtime.connection,
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
      singletons: {
        _projectRoot: projectRoot,
      },
    },
    logger: silentLogger,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-swift-fixture-'));
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
    'Sources/Features/VideoFeed/VideoFeedViewModel.swift',
    [
      'import Foundation',
      'import Infrastructure',
      '',
      '@MainActor',
      'final class VideoFeedViewModel: ObservableObject {',
      '  @Published private(set) var pages: [FeedPage] = []',
      '  private let repository = FeedRepository(client: VideoAPIClient())',
      '  func refresh() async {',
      '    pages = (try? await repository.fetchPages(cursor: nil)) ?? []',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/Infrastructure/Networking/Repository/FeedRepository.swift',
    [
      'import Foundation',
      '',
      'public struct FeedPage { public let cursor: String? }',
      'public final class FeedRepository {',
      '  private let client: VideoAPIClient',
      '  public init(client: VideoAPIClient) { self.client = client }',
      '  public func fetchPages(cursor: String?) async throws -> [FeedPage] {',
      '    try await client.fetchFeed(cursor: cursor).map { _ in [FeedPage(cursor: nil)] }',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/Infrastructure/Networking/VideoAPIClient.swift',
    [
      'import Foundation',
      '',
      'public final class VideoAPIClient {',
      '  public init() {}',
      '  public func fetchFeed(cursor: String?) async throws -> Data {',
      '    Data(cursor?.utf8 ?? [])',
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

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
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

function buildReadyGate(overrides: Partial<PlanGenerationGateReady> = {}): PlanGenerationGateReady {
  const generationStage = overrides.generationStage ?? 'moduleMining';
  const cleanupPolicy = overrides.cleanupPolicy ?? 'none';
  const moduleScope = overrides.moduleScope ?? ['src/api'];
  const testMode = overrides.testMode ?? true;
  return {
    cleanupPolicy,
    currentProjectContextSignature: 'fixture-signature',
    dimensionIds: ['architecture'],
    generationStage,
    moduleScope,
    plan: {
      planId: 'fixture-plan',
      version: 1,
    },
    planGate: {
      status: 'ready',
      toolName: 'alembic_rescan',
      generationStage,
      cleanupPolicy,
      testMode,
      moduleScope,
    },
    planState: {},
    planView: {},
    projectRoot,
    scale: {
      contentMaxLines: 12,
      maxFiles: 6,
      totalRecipeBudget: 1,
    },
    signature: { matches: true },
    testMode,
    ...overrides,
  };
}
