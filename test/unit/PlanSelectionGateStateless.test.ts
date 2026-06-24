import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runHostAgentColdStartWorkflow } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';
import { runHostAgentKnowledgeRescanWorkflow } from '../../lib/recipe-generation/host-agent-workflows/knowledge-rescan.js';
import { resolvePlanGenerationGate } from '../../lib/recipe-generation/plan-generation-gate.js';
import { BootstrapInput, RescanInput } from '../../lib/shared/schemas/mcp-tools.js';

const fixtureRoots: string[] = [];

describe('stateless planSelection generation gate', () => {
  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('executor schemas require planSelection on bootstrap and rescan', () => {
    expect(BootstrapInput.safeParse({}).success).toBe(false);
    expect(RescanInput.safeParse({ reason: 'missing-planSelection' }).success).toBe(false);
    expect(BootstrapInput.safeParse({ planSelection: coldStartSelection() }).success).toBe(true);
    expect(BootstrapInput.safeParse({ planSelection: rescanSelection() }).success).toBe(false);
    expect(BootstrapInput.safeParse({ planSelection: moduleMiningSelection() }).success).toBe(
      false
    );
    expect(
      RescanInput.safeParse({
        planSelection: coldStartSelection(),
        reason: 'schema-stage-mismatch',
      }).success
    ).toBe(false);
    expect(
      RescanInput.safeParse({
        planSelection: rescanSelection(),
        reason: 'schema-required-planSelection',
      }).success
    ).toBe(true);
    expect(
      RescanInput.safeParse({
        planSelection: moduleMiningSelection(),
        reason: 'schema-required-planSelection',
      }).success
    ).toBe(true);
  });

  test('bootstrap and rescan block before scan execution when planSelection is missing', async () => {
    const ctx = createNoStorageContext();

    const bootstrap = (await runHostAgentColdStartWorkflow(ctx, {
      rebuild: true,
    } as Parameters<typeof runHostAgentColdStartWorkflow>[1])) as Record<string, unknown>;
    const rescan = (await runHostAgentKnowledgeRescanWorkflow(ctx, {
      reason: 'missing-planSelection',
    } as Parameters<typeof runHostAgentKnowledgeRescanWorkflow>[1])) as Record<string, unknown>;

    for (const response of [bootstrap, rescan]) {
      expect(response).toMatchObject({
        success: false,
        errorCode: 'PLAN_REQUIRED',
        data: {
          needsUserInput: true,
          planGate: { status: 'blocked', errorCode: 'PLAN_REQUIRED' },
        },
      });
      expect(JSON.stringify(response)).toContain('planSelection');
      expect(JSON.stringify(response)).toContain('alembic_plan');
    }
  });

  test('gate blocks generation when planSelection is missing without reading storage', async () => {
    const gate = await resolvePlanGenerationGate(createNoStorageContext(), undefined, {
      defaultStage: 'coldStart',
      toolName: 'alembic_bootstrap',
    });

    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response).toMatchObject({
        success: false,
        errorCode: 'PLAN_REQUIRED',
        data: {
          generationStage: 'coldStart',
          planGate: { status: 'blocked', errorCode: 'PLAN_REQUIRED' },
        },
      });
      expect(String(gate.response.message)).toContain('planSelection');
      expect(String(gate.response.data?.blockedReason)).toContain('planSelection');
    }
  });

  test('gate rejects planSelection stage mismatches instead of changing executor stage', async () => {
    const ctx = createNoStorageContext();

    const bootstrapWithDeepPlan = await resolvePlanGenerationGate(
      ctx,
      {
        planSelection: rescanSelection(),
      },
      { defaultStage: 'coldStart', toolName: 'alembic_bootstrap' }
    );
    const rescanWithColdPlan = await resolvePlanGenerationGate(
      ctx,
      {
        planSelection: coldStartSelection(),
      },
      { defaultStage: 'deepMining', toolName: 'alembic_rescan' }
    );

    expect(bootstrapWithDeepPlan.ok).toBe(false);
    if (!bootstrapWithDeepPlan.ok) {
      expect(bootstrapWithDeepPlan.response).toMatchObject({
        success: false,
        errorCode: 'PLAN_REQUIRED',
        data: {
          generationStage: 'coldStart',
          planGate: { status: 'blocked', errorCode: 'PLAN_REQUIRED' },
        },
      });
      expect(String(bootstrapWithDeepPlan.response.data?.blockedReason)).toContain(
        'does not match requested coldStart'
      );
    }

    expect(rescanWithColdPlan.ok).toBe(false);
    if (!rescanWithColdPlan.ok) {
      expect(rescanWithColdPlan.response).toMatchObject({
        success: false,
        errorCode: 'PLAN_REQUIRED',
        data: {
          generationStage: 'deepMining',
          planGate: { status: 'blocked', errorCode: 'PLAN_REQUIRED' },
        },
      });
      expect(String(rescanWithColdPlan.response.data?.blockedReason)).toContain(
        'does not match requested deepMining'
      );
    }
  });

  test('gate rejects runtime payloads that request unsupported executor stages', async () => {
    const ctx = createNoStorageContext();

    const bootstrapWithDeepRequest = await resolvePlanGenerationGate(
      ctx,
      {
        generationStage: 'deepMining',
        planSelection: rescanSelection(),
      },
      { defaultStage: 'coldStart', toolName: 'alembic_bootstrap' }
    );
    const rescanWithColdRequest = await resolvePlanGenerationGate(
      ctx,
      {
        generationStage: 'coldStart',
        planSelection: coldStartSelection(),
      },
      { defaultStage: 'deepMining', toolName: 'alembic_rescan' }
    );

    expect(bootstrapWithDeepRequest.ok).toBe(false);
    if (!bootstrapWithDeepRequest.ok) {
      expect(String(bootstrapWithDeepRequest.response.data?.blockedReason)).toContain(
        'alembic_bootstrap only supports coldStart'
      );
    }
    expect(rescanWithColdRequest.ok).toBe(false);
    if (!rescanWithColdRequest.ok) {
      expect(String(rescanWithColdRequest.response.data?.blockedReason)).toContain(
        'alembic_rescan requires deepMining or moduleMining'
      );
    }
  });

  test('uses dimensions, module scope, and live scale from planSelection', async () => {
    const gate = await resolvePlanGenerationGate(
      {
        container: {
          get: (name: string) => {
            throw new Error(`unexpected storage read: ${name}`);
          },
          singletons: { _projectRoot: '/tmp/stateless-plan-gate' },
        },
      },
      {
        planSelection: rescanSelection(),
      },
      { defaultStage: 'deepMining', toolName: 'alembic_rescan' }
    );

    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.value.dimensionIds).toEqual(['architecture', 'swift-objc-idiom']);
      expect(gate.value.moduleScope).toEqual(['Sources']);
      expect(gate.value.scale).toEqual({
        totalRecipeBudget: 7,
        maxFiles: 37,
        contentMaxLines: 91,
      });
      expect(gate.value.planGate).toMatchObject({
        status: 'ready',
        generationStage: 'deepMining',
        selectedDimensions: ['architecture', 'swift-objc-idiom'],
        moduleScope: ['Sources'],
      });
      expect(gate.value.planGate).not.toHaveProperty('plan');
      expect(gate.value.planGate).not.toHaveProperty('signature');
      expect(gate.value.planGate).not.toHaveProperty('coverageGaps');
    }
  });

  test('bootstrap mission briefing uses planSelection dimensions and attaches SOP guides', async () => {
    const projectRoot = createSmallSwiftProject();
    const response = (await runHostAgentColdStartWorkflow(createNoStorageContext(projectRoot), {
      dimensions: ['architecture'],
      planSelection: {
        generationStage: 'coldStart',
        dimensions: ['architecture', 'swift-objc-idiom'],
        scale: {
          totalRecipeBudget: 4,
          maxFiles: 12,
          contentMaxLines: 24,
          depthLevels: ['project'],
        },
        moduleBindings: [
          {
            modulePath: 'Sources/App',
            dimensions: ['architecture', 'swift-objc-idiom'],
            targetRecipes: 2,
          },
        ],
      },
      scaleOverride: { totalRecipeBudget: 1, maxFiles: 6, contentMaxLines: 12 },
      testMode: true,
    })) as Record<string, unknown>;

    expect(response).toMatchObject({ success: true });
    const data = asRecord(response.data);
    const dimensionTasks = asArray(data.dimensions).map(asRecord);
    expect(dimensionTasks.map((dimension) => String(dimension.id))).toEqual([
      'architecture',
      'swift-objc-idiom',
    ]);
    const inlineGuidanceDimensions = asArray(
      asRecord(data.currentDimensionGuidance).dimensions
    ).map(asRecord);
    expect(inlineGuidanceDimensions.map((dimension) => String(dimension.dimensionId))).toEqual([
      'architecture',
      'swift-objc-idiom',
    ]);
    expect(
      inlineGuidanceDimensions.some(
        (dimension) => asArray(asRecord(dimension.analysisGuide).steps).length > 0
      )
    ).toBe(true);
    const fullBriefing = readFullBriefingFromResponse(response);
    const fullDimensionTasks = asArray(fullBriefing.dimensions).map(asRecord);
    for (const dimension of fullDimensionTasks.filter((dimension) =>
      ['architecture', 'swift-objc-idiom'].includes(String(dimension.id))
    )) {
      expect(asArray(asRecord(dimension.analysisGuide).steps).length).toBeGreaterThan(0);
    }
    expect(asRecord(data.planGate)).toMatchObject({
      selectedDimensions: ['architecture', 'swift-objc-idiom'],
      testMode: true,
    });
  });
});

function createNoStorageContext(projectRoot = '/tmp/stateless-plan-gate') {
  return {
    container: {
      get: (name: string) => {
        throw new Error(`unexpected storage or scan dependency read: ${name}`);
      },
      singletons: { _projectRoot: projectRoot },
    },
    logger: {
      info() {},
      warn() {},
    },
  };
}

function createSmallSwiftProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-selection-briefing-'));
  fixtureRoots.push(root);
  writeFile(
    root,
    'Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(name: "PlanSelectionBriefing", targets: [.target(name: "App", path: "Sources/App")])',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/App/AppView.swift',
    [
      'import SwiftUI',
      '',
      'public struct AppView: View {',
      '  public init() {}',
      '  public var body: some View { Text("Ready") }',
      '}',
      '',
    ].join('\n')
  );
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFullBriefingFromResponse(response: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(response.data);
  const meta = asRecord(data.meta);
  const fullBriefingRef = asRecord(meta.fullBriefingRef);
  const fullBriefingPath =
    typeof fullBriefingRef.path === 'string' ? fullBriefingRef.path : undefined;
  return fullBriefingPath ? JSON.parse(fs.readFileSync(fullBriefingPath, 'utf8')) : data;
}

function coldStartSelection() {
  return {
    generationStage: 'coldStart',
    dimensions: ['architecture'],
    scale: {
      totalRecipeBudget: 3,
      maxFiles: 17,
      contentMaxLines: 41,
      depthLevels: ['project'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources',
        dimensions: ['architecture'],
        targetRecipes: 2,
        priority: 1,
      },
    ],
  };
}

function rescanSelection() {
  return {
    generationStage: 'deepMining',
    dimensions: ['architecture', 'swift-objc-idiom'],
    scale: {
      totalRecipeBudget: 7,
      maxFiles: 37,
      contentMaxLines: 91,
      depthLevels: ['project', 'module'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources',
        dimensions: ['architecture', 'swift-objc-idiom'],
        targetRecipes: 3,
        priority: 1,
      },
    ],
  };
}

function moduleMiningSelection() {
  return {
    generationStage: 'moduleMining',
    dimensions: ['architecture', 'swift-objc-idiom'],
    scale: {
      totalRecipeBudget: 4,
      maxFiles: 23,
      contentMaxLines: 47,
      depthLevels: ['module'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources/App',
        dimensions: ['architecture', 'swift-objc-idiom'],
        targetRecipes: 2,
        priority: 1,
      },
    ],
  };
}
