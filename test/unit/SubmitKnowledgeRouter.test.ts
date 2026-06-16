import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSubmitKnowledgeTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

const gatewayState = vi.hoisted(() => ({
  createCalls: [] as unknown[],
  projectRoot: '/tmp/alembic-project',
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
    async create(request: unknown) {
      gatewayState.createCalls.push(request);
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
    resolveProjectRoot: () => gatewayState.projectRoot,
  };
});

vi.mock('#http/middleware/RateLimiter.js', () => ({
  checkRecipeSave: () => ({ allowed: true }),
}));

describe('routeSubmitKnowledgeTool pending semantic review nextAction', () => {
  beforeEach(() => {
    gatewayState.createCalls = [];
    gatewayState.projectRoot = '/tmp/alembic-project';
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

  it('blocks bootstrap Recipe submissions without source evidence before Core persistence', async () => {
    const projectRoot = makeProjectRoot();
    gatewayState.projectRoot = projectRoot;
    const result = await routeSubmitKnowledgeTool(makeContext({ projectRoot }), {
      dimensionId: 'architecture',
      sessionId: 'session-1',
      skipConsolidation: true,
      items: [
        {
          title: 'Missing Evidence',
          kind: 'fact',
          content: { markdown: 'This candidate has no source refs.' },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SOURCE_REFS_MISSING');
    expect(result.data).toMatchObject({
      problem: {
        status: 'rebuild-required',
      },
      evidenceGate: {
        status: 'rebuild-required',
      },
    });
    expect(gatewayState.createCalls).toHaveLength(0);
  });

  it('requires a production session when controller submissions request one', async () => {
    const projectRoot = makeProjectRoot();
    gatewayState.projectRoot = projectRoot;
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'source.ts'),
      ['export function sourceBoundRoute() {', '  return "production-session";', '}', ''].join('\n')
    );

    const result = await routeSubmitKnowledgeTool(makeContext(), {
      requireProductionSession: true,
      skipConsolidation: true,
      items: [
        {
          title: 'Production Session Required',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function sourceBoundRoute() {\n  return "production-session";\n}',
          content: {
            markdown:
              'Source-bound fact with concrete evidence from src/source.ts:1-3 and production session requirement.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
            confidence: 0.9,
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SESSION_NOT_FOUND');
    expect(gatewayState.createCalls).toHaveLength(0);
  });

  it('allows source-bound bootstrap Recipe submissions into the Core gateway', async () => {
    const projectRoot = makeProjectRoot();
    gatewayState.projectRoot = projectRoot;
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'source.ts'),
      ['export function realSource() {', '  return "source-bound";', '}', ''].join('\n')
    );

    const result = await routeSubmitKnowledgeTool(makeContext({ projectRoot }), {
      dimensionId: 'architecture',
      sessionId: 'session-1',
      skipConsolidation: true,
      items: [
        {
          title: 'Source Bound Fact',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function realSource() {\n  return "source-bound";\n}',
          content: {
            markdown:
              'Source-bound fact with concrete evidence from src/source.ts:1-3 and production bootstrap context.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
            confidence: 0.9,
          },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(gatewayState.createCalls).toHaveLength(1);
    expect(gatewayState.createCalls[0]).toMatchObject({
      options: {
        skipConsolidation: true,
      },
    });
  });

  it('forwards p11 bootstrapSessionRef references to the production evidence gate', async () => {
    const projectRoot = makeProjectRoot();
    gatewayState.projectRoot = projectRoot;
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'source.ts'),
      ['export function realSource() {', '  return "source-bound";', '}', ''].join('\n')
    );

    const result = await routeSubmitKnowledgeTool(makeContext({ projectRoot }), {
      bootstrapSessionRef: 'bootstrap-session:session-1',
      dimensionId: 'architecture',
      requireProductionSession: true,
      skipConsolidation: true,
      items: [
        {
          title: 'Source Bound Fact',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function realSource() {\n  return "source-bound";\n}',
          content: {
            markdown:
              'Source-bound fact with concrete evidence from src/source.ts:1-3 and production bootstrap context.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
            confidence: 0.9,
          },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(gatewayState.createCalls).toHaveLength(1);
    expect(gatewayState.createCalls[0]).toMatchObject({
      options: {
        skipConsolidation: true,
      },
    });
  });
});

function makeContext({ projectRoot }: { projectRoot?: string } = {}): McpContext {
  const session = projectRoot
    ? {
        id: 'session-1',
        projectRoot,
        dimensions: [{ id: 'architecture' }],
        getProgress: () => ({ remainingDimIds: ['architecture'] }),
        submissionTracker: {
          getAllSubmittedTitles: () => new Set<string>(),
          getAllSubmittedTriggers: () => new Set<string>(),
          recordRejection: vi.fn(),
          recordSubmission: vi.fn(),
        },
      }
    : null;
  return {
    container: {
      get(name: string) {
        if (name === 'knowledgeService') {
          return {};
        }
        if (name === 'bootstrapSessionManager') {
          return {
            getSession: (sessionId?: string) =>
              session && (!sessionId || sessionId === session.id) ? session : null,
          };
        }
        return null;
      },
    },
  };
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-submit-gate-'));
}
