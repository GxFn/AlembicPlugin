import { describe, expect, test } from 'vitest';
import { runHostAgentColdStartWorkflow } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';
import { runHostAgentKnowledgeRescanWorkflow } from '../../lib/recipe-generation/host-agent-workflows/knowledge-rescan.js';
import { resolvePlanGenerationGate } from '../../lib/recipe-generation/plan-generation-gate.js';
import { BootstrapInput, RescanInput } from '../../lib/shared/schemas/mcp-tools.js';

describe('stateless planSelection generation gate', () => {
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
      expect(gate.value.planGate).toMatchObject({
        plan: { selectionSource: 'stateless-planSelection' },
      });
    }
  });
});

function createNoStorageContext() {
  return {
    container: {
      get: (name: string) => {
        throw new Error(`unexpected storage or scan dependency read: ${name}`);
      },
      singletons: { _projectRoot: '/tmp/stateless-plan-gate' },
    },
    logger: {
      info() {},
      warn() {},
    },
  };
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
