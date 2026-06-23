import { describe, expect, test } from 'vitest';
import { resolvePlanGenerationGate } from '../../lib/recipe-generation/plan-generation-gate.js';

describe('stateless planSelection generation gate', () => {
  test('blocks generation when planSelection is missing without reading storage', async () => {
    const gate = await resolvePlanGenerationGate(
      {
        container: {
          get: (name: string) => {
            throw new Error(`unexpected storage read: ${name}`);
          },
          singletons: { _projectRoot: '/tmp/stateless-plan-gate' },
        },
      },
      undefined,
      { defaultStage: 'coldStart', toolName: 'alembic_bootstrap' }
    );

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
      expect(String(gate.response.data?.blockedReason)).toContain('planSelection');
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
        planSelection: {
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
        },
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
    }
  });
});
