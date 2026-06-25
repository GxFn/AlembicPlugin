import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSubmitKnowledgeTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

const gatewayState = vi.hoisted(() => ({
  createCalls: [] as unknown[],
  freshnessCalls: [] as unknown[],
  freshnessResult: {
    errors: [],
    processed: 1,
    recipes: [
      {
        errors: [],
        recipeId: 'recipe-semantic-001',
        retrievalMayBeStale: true,
        sourceRefs: {
          activeRefs: ['src/current.ts:1-3'],
          active: 1,
          allRefs: ['src/current.ts:1-3', 'src/old.ts:8-9'],
          cleaned: 1,
          errors: [],
          inserted: 1,
          recipesProcessed: 1,
          skipped: 0,
          staleRefs: ['src/old.ts:8-9'],
          stale: 1,
          status: 'completed',
        },
        sourceRefsBridge: {
          refs: ['src/current.ts:1-3'],
          status: 'partial',
        },
        vector: {
          availability: {
            available: false,
            embedProviderConfigured: false,
            probeStatus: 'not-applicable',
            reason: 'embed-provider-missing',
            status: 'unavailable',
          },
          degradedReason: 'embed-provider-missing',
          entrySyncStatus: 'skipped',
          errors: [],
          regionSyncStatus: 'skipped',
          status: 'degraded',
        },
      },
    ],
    requested: 1,
    retrievalMayBeStale: true,
    status: 'degraded',
  },
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

vi.mock('../../lib/runtime/mcp/RateLimiter.js', () => ({
  checkRecipeSave: () => ({ allowed: true }),
}));

describe('routeSubmitKnowledgeTool pending semantic review nextAction', () => {
  beforeEach(() => {
    gatewayState.createCalls = [];
    gatewayState.freshnessCalls = [];
    gatewayState.projectRoot = '/tmp/alembic-project';
    gatewayState.freshnessResult = {
      errors: [],
      processed: 1,
      recipes: [
        {
          errors: [],
          recipeId: 'recipe-semantic-001',
          retrievalMayBeStale: true,
          sourceRefs: {
            activeRefs: ['src/current.ts:1-3'],
            active: 1,
            allRefs: ['src/current.ts:1-3', 'src/old.ts:8-9'],
            cleaned: 1,
            errors: [],
            inserted: 1,
            recipesProcessed: 1,
            skipped: 0,
            staleRefs: ['src/old.ts:8-9'],
            stale: 1,
            status: 'completed',
          },
          sourceRefsBridge: {
            refs: ['src/current.ts:1-3'],
            status: 'partial',
          },
          vector: {
            availability: {
              available: false,
              embedProviderConfigured: false,
              probeStatus: 'not-applicable',
              reason: 'embed-provider-missing',
              status: 'unavailable',
            },
            degradedReason: 'embed-provider-missing',
            entrySyncStatus: 'skipped',
            errors: [],
            regionSyncStatus: 'skipped',
            status: 'degraded',
          },
        },
      ],
      requested: 1,
      retrievalMayBeStale: true,
      status: 'degraded',
    };
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
      items: [makeValidSubmitItem({ title: 'Codex Recipe Interaction' })],
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
      items: [makeValidSubmitItem({ title: 'Codex Recipe Interaction' })],
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
      items: [makeValidSubmitItem({ title: 'Codex Recipe Interaction' })],
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

  it('blocks non-English do/dont clauses and missing project contrast before Core create', async () => {
    const result = await routeSubmitKnowledgeTool(makeContext(), {
      skipConsolidation: true,
      items: [
        {
          title: 'Non English Quality',
          doClause: '使用项目级网络封装',
          dontClause: '不要直接调用底层 HTTP 客户端',
          content: {
            markdown: 'This candidate explains the project route but has no contrast markers.',
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('QUALITY_GATE_FAILED');
    expect(result.message).toContain('Recipe content quality gate failed (3 violations)');
    expect(result.message).toContain('DO_CLAUSE_NON_ENGLISH');
    expect(result.message).toContain('DONT_CLAUSE_NON_ENGLISH');
    expect(result.message).toContain('CONTENT_CONTRAST_MISSING');
    expect(result.data).toMatchObject({
      problem: {
        status: 'rebuild-required',
        type: 'alembic.recipe-content-quality.rebuild-required',
      },
      commonErrors: expect.arrayContaining([
        'DO_CLAUSE_NON_ENGLISH',
        'DONT_CLAUSE_NON_ENGLISH',
        'CONTENT_CONTRAST_MISSING',
      ]),
      rejectedItems: expect.arrayContaining([
        expect.objectContaining({ code: 'DO_CLAUSE_NON_ENGLISH', field: 'doClause' }),
        expect.objectContaining({ code: 'DONT_CLAUSE_NON_ENGLISH', field: 'dontClause' }),
        expect.objectContaining({ code: 'CONTENT_CONTRAST_MISSING', field: 'content.markdown' }),
      ]),
    });
    expect(gatewayState.createCalls).toHaveLength(0);
  });

  it('blocks English but non-imperative do/dont clauses before Core create', async () => {
    const result = await routeSubmitKnowledgeTool(makeContext(), {
      skipConsolidation: true,
      items: [
        makeValidSubmitItem({
          title: 'Non Imperative Quality',
          doClause: 'The service should use the shared retry helper',
          dontClause: 'Callbacks are not allowed in feature modules',
        }),
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('QUALITY_GATE_FAILED');
    expect(result.message).toContain('DO_CLAUSE_NON_IMPERATIVE');
    expect(result.message).toContain('DONT_CLAUSE_NON_IMPERATIVE');
    expect(gatewayState.createCalls).toHaveLength(0);
  });

  it('blocks bootstrap Recipe submissions with actionable snippet mismatch details', async () => {
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
        makeValidSubmitItem({
          title: 'Mismatched Evidence',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function realSource() {\n  return "polished";\n}',
          content: {
            markdown:
              'This candidate cites src/source.ts:1-3 but the submitted snippet was rewritten instead of copied from that exact source range.\n✅ Use source text copied from the cited range.\n❌ Do not rewrite the source text while keeping the same citation.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
          },
        }),
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SNIPPET_MISMATCH');
    expect(result.message).toContain('Recipe evidence gate failed (1 violation)');
    expect(result.message).toContain('#0 SNIPPET_MISMATCH');
    expect(result.message).toContain(
      'Cite the exact source line range that contains the submitted code snippet.'
    );
    expect(result.data).toMatchObject({
      problem: {
        status: 'rebuild-required',
        nextAction: 'Cite the exact source line range that contains the submitted code snippet.',
      },
      evidenceGate: {
        status: 'rebuild-required',
        violationCount: 1,
        violations: [
          {
            code: 'SNIPPET_MISMATCH',
            itemIndex: 0,
            nextAction:
              'Cite the exact source line range that contains the submitted code snippet.',
          },
        ],
      },
      rejectedItems: [
        {
          code: 'SNIPPET_MISMATCH',
          index: 0,
          nextAction: 'Cite the exact source line range that contains the submitted code snippet.',
        },
      ],
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
        makeValidSubmitItem({
          title: 'Production Session Required',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function sourceBoundRoute() {\n  return "production-session";\n}',
          content: {
            markdown:
              'Source-bound fact with concrete evidence from src/source.ts:1-3 and production session requirement.\n✅ Use the production bootstrap session before submitting this Recipe.\n❌ Do not submit controller production evidence without a session.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
            confidence: 0.9,
          },
        }),
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
        makeValidSubmitItem({
          title: 'Source Bound Fact',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function realSource() {\n  return "source-bound";\n}',
          content: {
            markdown:
              'Source-bound fact with concrete evidence from src/source.ts:1-3 and production bootstrap context.\n✅ Use the exact source-bound route when writing this Recipe.\n❌ Do not submit a generic fact without the cited source.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
            confidence: 0.9,
          },
        }),
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

  it('refreshes created Recipes and returns source-ref/vector freshness summaries', async () => {
    gatewayState.result.created = [
      {
        index: 0,
        id: 'recipe-semantic-001',
        title: 'Codex Recipe Interaction',
        lifecycle: 'candidate',
        raw: {
          id: 'recipe-semantic-001',
          title: 'Codex Recipe Interaction',
          content: { markdown: 'Fresh recipe content.' },
          reasoning: { sources: ['src/current.ts:1-3'] },
        },
      },
    ];

    const result = await routeSubmitKnowledgeTool(makeContext(), {
      items: [makeValidSubmitItem({ title: 'Codex Recipe Interaction' })],
      skipConsolidation: true,
    });

    expect(gatewayState.freshnessCalls).toHaveLength(1);
    expect(gatewayState.freshnessCalls[0]).toMatchObject([
      {
        id: 'recipe-semantic-001',
        title: 'Codex Recipe Interaction',
      },
    ]);
    expect(result.data).toMatchObject({
      status: 'degraded',
      finality: 'non-final',
      degraded: true,
      degradedReasons: expect.arrayContaining([
        'freshness:degraded',
        'freshness:retrieval-may-be-stale',
        'vector:recipe-semantic-001:embed-provider-missing',
      ]),
      freshness: {
        status: 'degraded',
        processed: 1,
        retrievalMayBeStale: true,
        recipes: [
          {
            recipeId: 'recipe-semantic-001',
            sourceRefs: {
              activeCount: 1,
              activeRefs: ['src/current.ts:1-3'],
              reconcile: {
                active: 1,
                cleaned: 1,
                inserted: 1,
                recipesProcessed: 1,
                skipped: 0,
                stale: 1,
              },
              staleCount: 1,
              staleRefs: ['src/old.ts:8-9'],
            },
            vector: {
              status: 'degraded',
              availabilityStatus: 'unavailable',
              availabilityReason: 'embed-provider-missing',
              degradedReason: 'embed-provider-missing',
            },
          },
        ],
      },
      retrievalMayBeStale: true,
    });
  });

  it('surfaces ready local Ollama semantic indexing without embed-provider-missing degradation', async () => {
    gatewayState.result.created = [
      {
        index: 0,
        id: 'recipe-semantic-001',
        title: 'Codex Recipe Interaction',
        lifecycle: 'candidate',
        raw: {
          id: 'recipe-semantic-001',
          title: 'Codex Recipe Interaction',
          content: { markdown: 'Fresh recipe content.' },
          reasoning: { sources: ['src/current.ts:1-3'] },
        },
      },
    ];
    gatewayState.result.pendingSemanticReview = [];
    gatewayState.freshnessResult = {
      errors: [],
      processed: 1,
      recipes: [
        {
          errors: [],
          recipeId: 'recipe-semantic-001',
          retrievalMayBeStale: false,
          sourceRefs: {
            activeRefs: ['src/current.ts:1-3'],
            active: 1,
            allRefs: ['src/current.ts:1-3'],
            cleaned: 0,
            errors: [],
            inserted: 1,
            recipesProcessed: 1,
            skipped: 0,
            staleRefs: [],
            stale: 0,
            status: 'completed',
          },
          sourceRefsBridge: {
            refs: ['src/current.ts:1-3'],
            status: 'active',
          },
          vector: {
            availability: {
              available: true,
              embedProviderConfigured: true,
              probeStatus: 'available',
              reason: 'embed-provider-ready',
              status: 'available',
            },
            degradedReason: null,
            entrySyncStatus: 'synced',
            errors: [],
            regionSyncStatus: 'synced',
            status: 'completed',
          },
        },
      ],
      requested: 1,
      retrievalMayBeStale: false,
      status: 'completed',
    };

    const result = await routeSubmitKnowledgeTool(makeContext(), {
      items: [makeValidSubmitItem({ title: 'Codex Recipe Interaction' })],
      skipConsolidation: true,
    });

    const degradedReasons = Array.isArray(result.data.degradedReasons)
      ? result.data.degradedReasons
      : [];
    expect(result.data).toMatchObject({
      freshness: {
        status: 'completed',
        recipes: [
          {
            recipeId: 'recipe-semantic-001',
            vector: {
              status: 'completed',
              availabilityStatus: 'available',
              availabilityReason: 'embed-provider-ready',
              regionSyncStatus: 'synced',
            },
          },
        ],
      },
    });
    expect(degradedReasons).not.toContain('vector:recipe-semantic-001:embed-provider-missing');
    expect(degradedReasons).not.toContain('vector:recipe-semantic-001:embed-provider-unavailable');
  });

  it('keeps created Recipes visible as degraded and non-final when freshness is unavailable', async () => {
    const result = await routeSubmitKnowledgeTool(
      makeContext({ freshnessServiceAvailable: false }),
      {
        items: [makeValidSubmitItem({ title: 'Codex Recipe Interaction' })],
        skipConsolidation: true,
      }
    );

    expect(result.success).toBe(true);
    expect(gatewayState.createCalls).toHaveLength(1);
    expect(result.data).toMatchObject({
      status: 'degraded',
      finality: 'non-final',
      degraded: true,
      degradedReasons: expect.arrayContaining([
        'freshness:skipped',
        'freshness:retrieval-may-be-stale',
        'freshness:recipe-semantic-001:recipeFreshnessService-unavailable',
      ]),
      freshness: {
        status: 'skipped',
        retrievalMayBeStale: true,
        recipes: [
          expect.objectContaining({
            recipeId: 'recipe-semantic-001',
            status: 'skipped',
            skippedReason: 'recipeFreshnessService-unavailable',
          }),
        ],
      },
      retrievalMayBeStale: true,
    });
  });

  it('returns ProjectContext relationship grounding guidance without blocking normal submit', async () => {
    const result = await routeSubmitKnowledgeTool(makeContext(), {
      skipConsolidation: true,
      items: [
        makeValidSubmitItem({
          title: 'Relationship Claim Needs Graph',
          relationshipClaim: true,
          description: 'The API client call chain depends on the React app entrypoint.',
          content: {
            markdown:
              'The caller/callee relationship should be grounded before this Recipe is final.\n✅ Use graph refs and source refs when claiming the API client call chain.\n❌ Do not claim caller/callee relationships from prose alone.',
          },
          reasoning: {
            whyStandard: 'This relationship affects dependency and impact claims.',
          },
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(gatewayState.createCalls).toHaveLength(1);
    expect(result.data).toMatchObject({
      status: 'degraded',
      finality: 'non-final',
      degraded: true,
      degradedReasons: expect.arrayContaining([
        'relationship-grounding:needs-evidence',
        'relationship-grounding:missing-graph-evidence',
        'relationship-grounding:missing-source-evidence',
      ]),
      retrievalMayBeStale: true,
      relationshipGrounding: {
        status: 'needs-evidence',
        finality: 'non-final',
        retrievalMayBeStale: true,
        relationshipClaimCount: 1,
        missingGraphEvidenceCount: 1,
        missingSourceEvidenceCount: 1,
        requiredEvidenceFields: expect.arrayContaining(['sourceGraphRefs', 'graphRefs']),
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'alembic_recipe_map' }),
          expect.objectContaining({ tool: 'alembic_graph' }),
        ]),
      },
    });
  });

  it('marks relationship claims grounded when graph refs are supplied', async () => {
    const result = await routeSubmitKnowledgeTool(makeContext(), {
      skipConsolidation: true,
      items: [
        makeValidSubmitItem({
          title: 'Relationship Claim With Graph',
          relationshipClaim: true,
          sourceRefs: ['src/api/client.ts:1-3'],
          sourceGraphRefs: ['pc:module:src/api:call-chain'],
          description: 'The graph ref grounds the caller/callee relationship.',
          reasoning: {
            whyStandard: 'The graph ref and source ref ground the relationship claim.',
          },
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      relationshipGrounding: {
        status: 'grounded',
        finality: 'final',
        acceptedGraphRefCount: 1,
        acceptedSourceRefCount: 1,
        missingGraphEvidenceCount: 0,
        missingSourceEvidenceCount: 0,
      },
    });
  });

  it('marks relationship graph refs non-final when source refs are missing', async () => {
    const result = await routeSubmitKnowledgeTool(makeContext(), {
      skipConsolidation: true,
      items: [
        makeValidSubmitItem({
          title: 'Relationship Claim Missing Source',
          relationshipClaim: true,
          sourceGraphRefs: ['pc:module:src/api:call-chain'],
          description: 'The graph ref alone is not enough for a source-anchored Recipe.',
          reasoning: {
            whyStandard: 'This intentionally omits source refs to keep the warning path visible.',
          },
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      status: 'degraded',
      finality: 'non-final',
      relationshipGrounding: {
        status: 'needs-evidence',
        missingGraphEvidenceCount: 0,
        missingSourceEvidenceCount: 1,
      },
      retrievalMayBeStale: true,
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
        makeValidSubmitItem({
          title: 'Source Bound Fact',
          kind: 'fact',
          sourceRefs: ['src/source.ts:1-3'],
          coreCode: 'export function realSource() {\n  return "source-bound";\n}',
          content: {
            markdown:
              'Source-bound fact with concrete evidence from src/source.ts:1-3 and production bootstrap context.\n✅ Use the exact source-bound route when writing this Recipe.\n❌ Do not submit a generic fact without the cited source.',
          },
          reasoning: {
            sources: ['src/source.ts:1-3'],
            confidence: 0.9,
          },
        }),
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

function makeValidSubmitItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const baseContent = {
    markdown:
      'Project-specific close-up for the Alembic submit route.\n✅ Use source-grounded Recipe candidates with exact project references.\n❌ Do not submit generic guidance without a project counterexample.',
    rationale: 'The quality gate needs visible project contrast before Core create runs.',
  };
  const overrideContent = isRecord(overrides.content) ? overrides.content : {};
  return {
    title: 'Codex Recipe Interaction',
    description: 'Use source-grounded Recipe candidates for the current project.',
    trigger: '@codex-recipe-interaction',
    language: 'typescript',
    kind: 'pattern',
    category: 'Tool',
    knowledgeType: 'code-pattern',
    doClause: 'Use source-grounded Recipe candidates for project-specific guidance',
    dontClause: 'Do not submit generic guidance without source evidence',
    whenClause: 'When submitting Alembic Recipe candidates from a Codex session',
    coreCode: 'routeSubmitKnowledgeTool(ctx, args)\nvalidateSubmitKnowledgeContentQuality(items)',
    headers: ['import { routeSubmitKnowledgeTool } from "#runtime/mcp/handlers/tool-router"'],
    usageGuide:
      '### When to Use\n- Source-grounded Recipe submission\n\n### When Not to Use\n- Generic advice\n\n### Steps\n1. Collect source refs.\n2. Submit validated candidates.\n\n### Key Points\n- Keep candidates project-specific.',
    reasoning: {
      whyStandard: 'The plugin submit route requires source-grounded, reusable guidance.',
      sources: ['lib/runtime/mcp/handlers/tool-router.ts:143-180'],
      confidence: 0.9,
    },
    ...overrides,
    content: {
      ...baseContent,
      ...overrideContent,
    },
  };
}

function makeContext({
  freshnessServiceAvailable = true,
  projectRoot,
}: {
  freshnessServiceAvailable?: boolean;
  projectRoot?: string;
} = {}): McpContext {
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
        if (name === 'recipeFreshnessService') {
          if (!freshnessServiceAvailable) {
            return null;
          }
          return {
            refreshRecipes(entries: unknown) {
              gatewayState.freshnessCalls.push(entries);
              return gatewayState.freshnessResult;
            },
          };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
