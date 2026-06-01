import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSubmitKnowledgeTool } from '../../lib/codex/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/codex/mcp/handlers/types.js';

const gatewayState = vi.hoisted(() => ({
  result: {
    created: [
      {
        index: 0,
        id: 'recipe-semantic-001',
        title: 'Codex Recipe Interaction',
        lifecycle: 'candidate',
        raw: {},
      },
    ],
    rejected: [],
    merged: [],
    blocked: [],
    duplicates: [],
    supersedeProposal: null,
    pendingSemanticReview: [
      {
        index: 0,
        title: 'Codex Recipe Interaction',
        newRecipeId: 'recipe-semantic-001',
        createdRecipe: {
          id: 'recipe-semantic-001',
          title: 'Codex Recipe Interaction',
          lifecycle: 'candidate',
        },
        relatedRecipe: {
          id: 'recipe-existing-001',
          title: 'Existing Recipe',
          similarity: 0.52,
        },
        reason: '需要人工判断是否合并。',
      },
    ],
  },
}));

vi.mock('@alembic/core/knowledge', () => ({
  getRequiredFieldsDescription: () => 'title, trigger, body',
  RecipeProductionGateway: class RecipeProductionGateway {
    async create() {
      return gatewayState.result;
    }
  },
}));

vi.mock('@alembic/core/service/candidate', () => ({
  findSimilarRecipes: vi.fn(),
}));

vi.mock('@alembic/core/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/workspace')>();
  return {
    ...actual,
    resolveDataRoot: () => '/tmp/alembic-data',
    resolveProjectRoot: () => '/tmp/alembic-project',
  };
});

vi.mock('#http/middleware/RateLimiter.js', () => ({
  checkRecipeSave: () => ({ allowed: true }),
}));

describe('routeSubmitKnowledgeTool pending semantic review nextAction', () => {
  beforeEach(() => {
    gatewayState.result = {
      created: [
        {
          index: 0,
          id: 'recipe-semantic-001',
          title: 'Codex Recipe Interaction',
          lifecycle: 'candidate',
          raw: {},
        },
      ],
      rejected: [],
      merged: [],
      blocked: [],
      duplicates: [],
      supersedeProposal: null,
      pendingSemanticReview: [
        {
          index: 0,
          title: 'Codex Recipe Interaction',
          newRecipeId: 'recipe-semantic-001',
          createdRecipe: {
            id: 'recipe-semantic-001',
            title: 'Codex Recipe Interaction',
            lifecycle: 'candidate',
          },
          relatedRecipe: {
            id: 'recipe-existing-001',
            title: 'Existing Recipe',
            similarity: 0.52,
          },
          reason: '需要人工判断是否合并。',
        },
      ],
    };
  });

  it('uses Core-provided newRecipeId for alembic_consolidate decisions', async () => {
    const result = await routeSubmitKnowledgeTool(makeContext(), {
      items: [{ title: 'Codex Recipe Interaction' }],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      nextAction: {
        tool: 'alembic_consolidate',
        args: {
          decisions: [
            {
              newRecipeId: 'recipe-semantic-001',
              action: 'keep',
              reasoning: '需要人工判断是否合并。',
            },
          ],
        },
        required: false,
      },
    });
    const decisions = (result.data as { nextAction: { args: { decisions: unknown[] } } }).nextAction
      .args.decisions;
    expect(decisions).not.toContainEqual(expect.objectContaining({ newRecipeId: '' }));
  });

  it('falls back to createdRecipe.id without guessing candidate titles', async () => {
    gatewayState.result.pendingSemanticReview = [
      {
        index: 0,
        title: 'Codex Recipe Interaction',
        createdRecipe: {
          id: 'recipe-created-ref-001',
          title: 'Codex Recipe Interaction',
          lifecycle: 'candidate',
        },
        relatedRecipe: {
          id: 'recipe-existing-001',
          title: 'Existing Recipe',
          similarity: 0.52,
        },
        reason: 'createdRecipe 提供稳定引用。',
      },
    ];

    const result = await routeSubmitKnowledgeTool(makeContext(), {
      items: [{ title: 'Codex Recipe Interaction' }],
    });

    expect(result.data).toMatchObject({
      nextAction: {
        args: {
          decisions: [
            {
              newRecipeId: 'recipe-created-ref-001',
              action: 'keep',
              reasoning: 'createdRecipe 提供稳定引用。',
            },
          ],
        },
      },
    });
  });

  it('does not emit executable consolidate action when Core omits the recipe id', async () => {
    gatewayState.result.pendingSemanticReview = [
      {
        index: 0,
        title: 'Codex Recipe Interaction',
        relatedRecipe: {
          id: 'recipe-existing-001',
          title: 'Existing Recipe',
          similarity: 0.52,
        },
        reason: '缺少新 Recipe ID。',
      },
    ];

    const result = await routeSubmitKnowledgeTool(makeContext(), {
      items: [{ title: 'Codex Recipe Interaction' }],
    });

    expect(result.success).toBe(true);
    expect((result.data as { nextAction?: unknown }).nextAction).toBeUndefined();
    expect(result.data).toMatchObject({
      nextActionBlocked: {
        tool: 'alembic_consolidate',
        blockedCount: 1,
        missingRecipeId: [
          {
            index: 0,
            title: 'Codex Recipe Interaction',
            reason: '缺少新 Recipe ID。',
          },
        ],
      },
    });
  });
});

function makeContext(): McpContext {
  return {
    container: {
      get(name: string) {
        if (name === 'knowledgeService') {
          return {};
        }
        return null;
      },
    },
  };
}
