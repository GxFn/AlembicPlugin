import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPlanScaleChecklistEn } from '@alembic/core/plans';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { projectCoreToolOutput } from '../../lib/host-runtime/mcp/core-tools/output.js';
import { resolvePlanGenerationGate } from '../../lib/recipe-pipeline/plan/plan-generation-gate.js';
import { routePlanTool } from '../../lib/recipe-pipeline/plan/plan-tool.js';
import { GenerateInput, PlanInput, RescanInput } from '../../lib/shared/schemas/mcp-tools.js';

// H2：plan draft 的 agentDecisionChecklist 由 Core renderPlanScaleChecklistEn 渲染，要求 Agent
// 读 dimensionEvidenceDensity 并输出 scale.dimensionBudgets（totalRecipeBudget = 各维度之和）。
// 本测试钉住插件契约与该 checklist 一致：draft 给出密度、confirm/planSelection 接受并校验
// dimensionBudgets、gate 把它透传给 Core applyPlanSelection。

const projectContextExecuteMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('confirm must not collect ProjectContext');
  })
);

vi.mock('@alembic/core/project-context-capabilities', () => ({
  ProjectContextCapabilities: {
    execute: projectContextExecuteMock,
  },
}));

interface PlanToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

let fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots = [];
  projectContextExecuteMock.mockClear();
});

describe('H2 plan checklist contract: dimensionEvidenceDensity + scale.dimensionBudgets', () => {
  test('the checklist the draft hands out names dimensionEvidenceDensity and scale.dimensionBudgets', () => {
    const checklist = renderPlanScaleChecklistEn().join('\n');
    expect(checklist).toContain('dimensionEvidenceDensity');
    expect(checklist).toContain('scale.dimensionBudgets');
  });

  test('draft exposes dimensionEvidenceDensity and the clean output keeps it', async () => {
    const projectRoot = createSmallSwiftProject();
    const draft = (await routePlanTool(createDraftContext(projectRoot), {
      operation: 'draft',
      projectRoot,
    })) as PlanToolResponse;

    expect(draft.success).toBe(true);
    const density = asArray(draft.data?.dimensionEvidenceDensity).map(asRecord);
    const candidateIds = asArray(draft.data?.candidateDimensions).map((entry) =>
      String(asRecord(entry).id)
    );
    expect(density.length).toBe(candidateIds.length);
    expect(density.map((entry) => entry.id)).toEqual(candidateIds);
    for (const entry of density) {
      expect(typeof entry.strength).toBe('number');
      expect(typeof entry.matchedFiles).toBe('number');
      expect(typeof entry.matchedModules).toBe('number');
      expect(typeof entry.matchedFrameworks).toBe('number');
      expect(Array.isArray(entry.sampleHits)).toBe(true);
    }

    const clean = projectCoreToolOutput(draft, 'alembic_plan') as Record<string, unknown>;
    expect(asArray(clean.dimensionEvidenceDensity)).toHaveLength(density.length);
  });

  test('PlanInput confirm accepts scale.dimensionBudgets that follow the checklist', () => {
    const parsed = PlanInput.safeParse(confirmPayload());
    expect(parsed.success).toBe(true);
  });

  test('GenerateInput and RescanInput planSelection accept scale.dimensionBudgets', () => {
    const cold = GenerateInput.safeParse({
      planSelection: selection('coldStart', { architecture: 4, 'coding-standards': 3 }, 7),
    });
    expect(cold.success).toBe(true);
    const deep = RescanInput.safeParse({
      planSelection: selection('deepMining', { architecture: 4, 'coding-standards': 3 }, 7),
    });
    expect(deep.success).toBe(true);
  });

  test('confirm carries dimensionBudgets into planSelection and its next action args', async () => {
    const response = (await routePlanTool(
      createConfirmContext(),
      confirmPayload() as Parameters<typeof routePlanTool>[1]
    )) as PlanToolResponse;

    expect(response.success).toBe(true);
    const planSelection = asRecord(response.data?.planSelection);
    expect(asRecord(planSelection.scale).dimensionBudgets).toEqual({
      architecture: 4,
      'coding-standards': 3,
    });
    const nextArgs = asRecord(asRecord(asArray(response.data?.nextActions)[0]).args);
    expect(asRecord(asRecord(nextArgs.planSelection).scale).dimensionBudgets).toEqual({
      architecture: 4,
      'coding-standards': 3,
    });
  });

  test.each([
    {
      name: 'budget key outside selected dimensions',
      budgets: { architecture: 4, 'testing-quality': 3 },
      total: 7,
      message: 'scale.dimensionBudgets references unselected dimension testing-quality',
    },
    {
      name: 'sum differs from totalRecipeBudget',
      budgets: { architecture: 4, 'coding-standards': 3 },
      total: 9,
      message: 'scale.totalRecipeBudget (9) must equal the sum of scale.dimensionBudgets (7)',
    },
  ])('confirm rejects dimensionBudgets with $name', async ({ budgets, total, message }) => {
    const payload = confirmPayload();
    const scale = asRecord(payload.scale);
    scale.dimensionBudgets = budgets;
    scale.totalRecipeBudget = total;

    const response = (await routePlanTool(
      createConfirmContext(),
      payload as Parameters<typeof routePlanTool>[1]
    )) as PlanToolResponse;

    expect(response).toMatchObject({
      success: false,
      errorCode: 'PLAN_CONFIRM_PAYLOAD_REQUIRED',
    });
    const messages = asArray(response.data?.planDiagnostics).map((entry) =>
      String(asRecord(entry).message)
    );
    expect(messages).toContain(message);
  });

  test('gate passes dimensionBudgets through Core applyPlanSelection into planGate.scale', async () => {
    const gate = await resolvePlanGenerationGate(
      createGateContext(),
      {
        planSelection: selection(
          'deepMining',
          { architecture: 4, 'coding-standards': 3 },
          7
        ) as never,
        projectRoot: '/tmp/h2-plan-gate',
      },
      { defaultStage: 'deepMining', toolName: 'alembic_rescan' }
    );

    expect(gate.ok).toBe(true);
    if (!gate.ok) {
      return;
    }
    expect(gate.value.planSelection.scale.dimensionBudgets).toEqual({
      architecture: 4,
      'coding-standards': 3,
    });
    expect(asRecord(gate.value.planGate.scale).dimensionBudgets).toEqual({
      architecture: 4,
      'coding-standards': 3,
    });
  });

  test.each([
    {
      name: 'unselected dimension key',
      budgets: { architecture: 4, 'testing-quality': 3 },
      total: 7,
      reason:
        'planSelection.scale.dimensionBudgets references unselected dimension testing-quality.',
    },
    {
      name: 'sum mismatch',
      budgets: { architecture: 4, 'coding-standards': 3 },
      total: 12,
      reason:
        'planSelection.scale.totalRecipeBudget (12) must equal the sum of planSelection.scale.dimensionBudgets (7).',
    },
  ])('gate blocks planSelection whose dimensionBudgets has $name', async ({
    budgets,
    total,
    reason,
  }) => {
    const gate = await resolvePlanGenerationGate(
      createGateContext(),
      {
        planSelection: selection('deepMining', budgets, total) as never,
        projectRoot: '/tmp/h2-plan-gate',
      },
      { defaultStage: 'deepMining', toolName: 'alembic_rescan' }
    );

    expect(gate.ok).toBe(false);
    if (gate.ok) {
      return;
    }
    expect(gate.response).toMatchObject({ errorCode: 'PLAN_REQUIRED' });
    expect(asRecord(gate.response.data).blockedReason).toBe(reason);
  });

  test('selection without dimensionBudgets keeps the legacy projection shape', async () => {
    const legacy = selection('deepMining', undefined, 7);
    const gate = await resolvePlanGenerationGate(
      createGateContext(),
      { planSelection: legacy as never, projectRoot: '/tmp/h2-plan-gate' },
      { defaultStage: 'deepMining', toolName: 'alembic_rescan' }
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) {
      return;
    }
    expect(asRecord(gate.value.planGate.scale)).not.toHaveProperty('dimensionBudgets');
  });
});

function confirmPayload(): Record<string, unknown> {
  return {
    operation: 'confirm',
    projectRoot: '/tmp/h2-confirm-project',
    generationStage: 'coldStart',
    projectProfile: {
      projectType: 'swift-package',
      primaryLanguage: 'swift',
      secondaryLanguages: [],
      frameworks: [],
      moduleCount: 1,
      fileCount: 2,
    },
    selectedDimensions: [
      {
        dimensionId: 'architecture',
        priority: 1,
        rationale: 'Strong structural evidence.',
        targetRecipes: 4,
      },
      {
        dimensionId: 'coding-standards',
        priority: 2,
        rationale: 'Medium evidence.',
        targetRecipes: 3,
      },
    ],
    scale: {
      totalRecipeBudget: 7,
      dimensionBudgets: { architecture: 4, 'coding-standards': 3 },
      maxFiles: 17,
      contentMaxLines: 41,
      depthLevels: ['project', 'module'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources/App',
        dimensions: ['architecture', 'coding-standards'],
        targetRecipes: 7,
        priority: 1,
      },
    ],
    plannedNextActions: [
      {
        tool: 'alembic_bootstrap',
        order: 1,
        reason: 'Generate the selected cold-start recipes.',
      },
    ],
    evidenceRefs: [{ kind: 'project-context', ref: 'projectInfoTree:L0' }],
    rationale: 'Budgets follow dimensionEvidenceDensity.',
  };
}

function selection(
  generationStage: 'coldStart' | 'deepMining',
  dimensionBudgets: Record<string, number> | undefined,
  totalRecipeBudget: number
): Record<string, unknown> {
  return {
    generationStage,
    dimensions: ['architecture', 'coding-standards'],
    scale: {
      totalRecipeBudget,
      ...(dimensionBudgets ? { dimensionBudgets } : {}),
      maxFiles: 37,
      contentMaxLines: 91,
      depthLevels: ['project'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources',
        dimensions: ['architecture', 'coding-standards'],
        targetRecipes: 3,
        priority: 1,
      },
    ],
  };
}

function createDraftContext(projectRoot: string) {
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: (name: string) => {
        throw new Error(`unexpected service lookup ${name}`);
      },
      singletons: {},
    },
    projectRuntime: { identity: { dataRoot: projectRoot } },
  };
}

function createConfirmContext() {
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: (name: string) => {
        throw new Error(`unexpected storage read: ${name}`);
      },
      singletons: {},
    },
  };
}

function createGateContext() {
  return {
    container: {
      get: (name: string) => {
        throw new Error(`unexpected storage or scan dependency read: ${name}`);
      },
      singletons: { _projectRoot: '/tmp/h2-plan-gate' },
    },
    logger: {
      info() {},
      warn() {},
    },
  };
}

function createSmallSwiftProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-plan-density-'));
  fixtureRoots.push(root);
  writeFile(
    root,
    'Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(name: "H2Density", targets: [.target(name: "App", path: "Sources")])',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/App/AppView.swift',
    ['import SwiftUI', '', 'public struct AppView: View {', '  public init() {}', '}', ''].join(
      '\n'
    )
  );
  writeFile(
    root,
    'Sources/App/AppService.swift',
    ['public struct AppService {', '  public init() {}', '}', ''].join('\n')
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
