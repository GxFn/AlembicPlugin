import { afterEach, describe, expect, test, vi } from 'vitest';
import { routePlanTool } from '../../lib/recipe-generation/plan-tool.js';
import { CORE_TOOL_OUTPUT_SCHEMAS } from '../../lib/runtime/mcp/core-tools/output.js';
import { PlanInput } from '../../lib/shared/schemas/mcp-tools.js';

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

describe('alembic_plan confirm stateless planSelection', () => {
  afterEach(() => {
    projectContextExecuteMock.mockClear();
  });

  test.each([
    {
      name: 'missing rationale',
      mutate: (payload: Record<string, unknown>) => {
        delete payload.rationale;
      },
      message: 'rationale is required',
    },
    {
      name: 'targetRecipes <= 0',
      mutate: (payload: Record<string, unknown>) => {
        const dimension = asRecord(asArray(payload.selectedDimensions)[0]);
        dimension.targetRecipes = 0;
      },
      message: 'selectedDimensions[0].targetRecipes must be > 0',
    },
    {
      name: 'no dimensions',
      mutate: (payload: Record<string, unknown>) => {
        payload.selectedDimensions = [];
      },
      message: 'selectedDimensions are required',
    },
    {
      name: 'no totalRecipeBudget',
      mutate: (payload: Record<string, unknown>) => {
        delete asRecord(payload.scale).totalRecipeBudget;
      },
      message: 'scale.totalRecipeBudget is required',
    },
    {
      name: 'binding references unknown dimension',
      mutate: (payload: Record<string, unknown>) => {
        asRecord(asArray(payload.moduleBindings)[0]).dimensions = ['security-auth'];
      },
      message: 'moduleBindings[0] references unknown dimension security-auth',
    },
  ])('rejects incomplete payload: $name', async ({ mutate, message }) => {
    const payload = validConfirmPayload();
    mutate(payload);

    const response = await callConfirm(payload);

    expect(response).toMatchObject({
      success: false,
      errorCode: 'PLAN_CONFIRM_PAYLOAD_REQUIRED',
    });
    expect(readDiagnosticMessages(response)).toContain(message);
  });

  test('returns only the flat single-stage planSelection and performs no ProjectContext collection', async () => {
    const response = await callConfirm(validConfirmPayload());

    expect(response.success).toBe(true);
    expect(projectContextExecuteMock).not.toHaveBeenCalled();
    expect(Object.keys(response.data ?? {}).sort()).toEqual([
      'nextActions',
      'operation',
      'planSelection',
      'projectRoot',
      'status',
    ]);

    const planSelection = asRecord(response.data?.planSelection);
    expect(planSelection).toEqual({
      generationStage: 'coldStart',
      dimensions: ['architecture'],
      scale: {
        totalRecipeBudget: 3,
        maxFiles: 17,
        contentMaxLines: 41,
        depthLevels: ['project', 'module'],
      },
      moduleBindings: [
        {
          modulePath: 'Sources/App',
          dimensions: ['architecture'],
          targetRecipes: 2,
          priority: 1,
        },
      ],
    });

    const raw = JSON.stringify(response.data);
    for (const forbidden of [
      'plan',
      'planId',
      'version',
      'projectContextSignature',
      'currentProjectContextSignature',
      'projectContextCreationGuide',
      'stages',
      'perStage',
    ]) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  test('input schema rejects legacy confirm identity and multi-stage residue', () => {
    const payload = validConfirmPayload();
    payload.planId = 'legacy-plan';
    payload.version = 2;
    payload.projectContextSignature = 'legacy-signature';
    asRecord(asArray(payload.selectedDimensions)[0]).stage = 'coldStart';
    asRecord(payload.scale).perStage = { coldStart: 3 };

    const parsed = PlanInput.safeParse(payload);

    expect(parsed.success).toBe(false);
  });

  test('clean-output schema rejects confirm legacy business keys', () => {
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_plan.safeParse({
      ok: true,
      status: 'confirmed',
      summary: 'legacy confirm leak',
      toolName: 'alembic_plan',
      meta: {
        contractVersion: 1,
        outputSchema: 'alembic_plan_clean_output',
        projector: 'core-tools-clean-output-projector',
        toolName: 'alembic_plan',
      },
      operation: 'confirm',
      projectRoot: '/tmp/project',
      planSelection: {
        generationStage: 'coldStart',
        dimensions: ['architecture'],
        scale: { totalRecipeBudget: 3 },
        moduleBindings: [
          {
            modulePath: 'Sources/App',
            dimensions: ['architecture'],
            targetRecipes: 2,
            priority: 1,
          },
        ],
      },
      projectContextCreationGuide: { planId: 'legacy-plan' },
    });

    expect(parsed.success).toBe(false);
  });
});

async function callConfirm(payload: Record<string, unknown>): Promise<PlanToolResponse> {
  return (await routePlanTool(
    createContext(),
    payload as Parameters<typeof routePlanTool>[1]
  )) as PlanToolResponse;
}

function createContext() {
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

function validConfirmPayload(): Record<string, unknown> {
  return {
    operation: 'confirm',
    projectRoot: '/tmp/stateless-confirm-project',
    generationStage: 'coldStart',
    projectProfile: {
      projectType: 'swift-package',
      primaryLanguage: 'swift',
      secondaryLanguages: [],
      frameworks: ['swift-package-manager'],
      moduleCount: 1,
      fileCount: 2,
    },
    selectedDimensions: [
      {
        dimensionId: 'architecture',
        priority: 1,
        rationale: 'Architecture recipes are needed for the cold-start pass.',
        targetRecipes: 2,
      },
    ],
    scale: {
      totalRecipeBudget: 3,
      maxFiles: 17,
      contentMaxLines: 41,
      depthLevels: ['project', 'module'],
    },
    moduleBindings: [
      {
        modulePath: 'Sources/App',
        dimensions: ['architecture'],
        targetRecipes: 2,
        priority: 1,
      },
    ],
    plannedNextActions: [
      {
        tool: 'alembic_bootstrap',
        order: 1,
        reason: 'Generate the selected cold-start recipes.',
        modulePaths: ['Sources/App'],
      },
    ],
    rationale: 'Agent selected a single-stage cold-start plan from projectInfoTree L0.',
    evidenceRefs: [{ kind: 'project-context', ref: 'projectInfoTree:L0' }],
  };
}

function readDiagnosticMessages(response: PlanToolResponse): string[] {
  return asArray(asRecord(response.data).planDiagnostics).map((diagnostic) =>
    String(asRecord(diagnostic).message)
  );
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
