import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  presentHostAgentKnowledgeRescanEmptyProject,
  presentHostAgentKnowledgeRescanResponse,
  projectRescanEvidenceHints,
} from '@alembic/core/host-agent-workflows';
import { afterEach, describe, expect, test } from 'vitest';
import { buildGenerateRebuildConfirmationBlock } from '#recipe-pipeline/generate/cold-start.js';
import {
  type HostAgentDimensionCompletionContext,
  type HostAgentWorkflowSession,
  runHostAgentDimensionCompletionWorkflow,
} from '#recipe-pipeline/generate/dimension-completion.js';
import { resolvePlanGenerationGate } from '#recipe-pipeline/plan/plan-generation-gate.js';
import {
  CORE_TOOL_OUTPUT_SCHEMAS,
  findForbiddenCoreOutputField,
} from '../../lib/host-runtime/mcp/core-tools/output.js';
import { envelope } from '../../lib/host-runtime/mcp/envelope.js';
import { routePlanTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { serializeMcpToolResult } from '../../lib/host-runtime/mcp/output-contract.js';
import { TOOLS } from '../../lib/host-runtime/mcp/tools.js';

// H1：工具自身 message / 说明要求 Agent 读取的字段，必须穿过 clean-output 投影到达宿主
// （成功与 ok=false 的 blocked 信封都要可见），同时保持敏感键清洗。

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function project(toolName: Parameters<typeof serializeMcpToolResult>[0], legacy: unknown) {
  const result = serializeMcpToolResult(toolName, legacy, {
    isErrorResult: (value) =>
      !!value && typeof value === 'object' && (value as { success?: unknown }).success === false,
  });
  const structured = result.structuredContent as Record<string, unknown>;
  expect(findForbiddenCoreOutputField(structured)).toBeNull();
  expect(
    CORE_TOOL_OUTPUT_SCHEMAS[toolName as keyof typeof CORE_TOOL_OUTPUT_SCHEMAS].parse(structured)
  ).toEqual(structured);
  return { result, structured };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

describe('H1 alembic_rescan exposes the evidence its message tells the agent to read', () => {
  test('evidenceHints (allRecipes + occupiedTriggers), rescan, relevanceAudit and session reach the host', () => {
    const evidencePlan = {
      allRecipes: [
        {
          id: 'recipe-1',
          title: 'Use the shared router',
          trigger: '@shared-router',
          dimensionId: 'architecture',
          knowledgeType: 'code-pattern',
          doClause: 'Route through the shared router.',
          lifecycle: 'active',
          content: { markdown: '# router', rationale: 'single entry', coreCode: 'route()' },
          sourceRefs: ['src/router.ts:1-10'],
          auditHint: { relevanceScore: 0.4, verdict: 'decay' as const, decayReasons: ['moved'] },
        },
      ],
      dimensionGaps: [
        {
          dimensionId: 'architecture',
          existingCount: 1,
          gap: 2,
          executionMode: 'produce' as const,
          createBudget: 2,
          shouldExecute: true,
          existingTriggers: ['@shared-router'],
          executionReasons: [],
        },
      ],
      executionReasons: {},
      totalGap: 2,
      totalCreateBudget: 2,
      decayCount: 1,
      occupiedTriggers: ['@shared-router'],
      coveredDimensions: 0,
      gapSummary: '需补齐维度: architecture(需补2条)。',
    };
    const evidenceHints = projectRescanEvidenceHints({
      evidencePlan,
      prescreen: { needsVerification: ['recipe-1'], autoResolved: [], dimensionGaps: {} },
    } as unknown as Parameters<typeof projectRescanEvidenceHints>[0]);
    const response = presentHostAgentKnowledgeRescanResponse({
      recipeSnapshot: { count: 1 } as never,
      cleanResult: { clearedTables: ['a'], deletedFiles: 0 } as never,
      auditSummary: {
        totalAudited: 1,
        healthy: 0,
        watch: 0,
        decay: 1,
        severe: 0,
        dead: 0,
        proposalsCreated: 0,
        immediateDeprecated: 0,
      } as never,
      briefing: {
        evidenceHints,
        executionPlan: { tiers: [], totalDimensions: 1, workflow: 'evolve → submit → complete' },
        session: { id: 'session-rescan-1', state: 'active', dimensionCount: 1 },
        submissionSchema: { example: { title: 'x' }, recipeAuthoringFrontLoad: { rules: [] } },
        projectContext: { source: 'project-context', refs: [], sourceFiles: [] },
      },
      evidencePlan: evidencePlan as never,
      dimensions: [{ id: 'architecture' }] as never,
      reason: 'unit',
      responseTimeMs: 3,
    });

    // 前提：Core 的 rescan message 确实指示 Agent 读取 evidenceHints / allRecipes。
    expect(response.message).toContain('evidenceHints.constraints.occupiedTriggers');
    expect(response.message).toContain('allRecipes');

    const { structured } = project('alembic_rescan', response);
    const hints = asRecord(structured.evidenceHints);
    expect(hints.allRecipes).toEqual(evidencePlan.allRecipes);
    expect(asRecord(hints.constraints).occupiedTriggers).toEqual(['@shared-router']);
    expect(hints.dimensionGaps).toEqual(evidencePlan.dimensionGaps);
    expect(asRecord(hints.evolutionPrescreen).needsVerification).toEqual(['recipe-1']);
    expect(structured.rescan).toMatchObject({ preservedRecipes: 1, reason: 'unit' });
    expect(structured.relevanceAudit).toMatchObject({ totalAudited: 1, decay: 1 });
    expect(structured.session).toMatchObject({ id: 'session-rescan-1' });
    // 创作前置契约在 rescan 只挂在 submissionSchema（rescan 无 hostAgentContract）。
    expect(asRecord(structured.submissionSchema)).toHaveProperty('recipeAuthoringFrontLoad');
    // 原始 ProjectContext 内部结构仍不外泄。
    expect(structured).not.toHaveProperty('projectContext');
  });

  test('no-actionable release signal and the empty-project message stay visible', () => {
    const { structured } = project('alembic_rescan', {
      success: true,
      errorCode: null,
      message: 'Rescan done. coverageAdvisory=diminishing-returns',
      data: {
        session: null,
        noActionableHostAgentWork: {
          generationStage: 'deepMining',
          releasedEmptySession: true,
          sessionId: 'session-x',
          stopReason: 'diminishing-returns',
        },
      },
      meta: { tool: 'alembic_rescan' },
    });
    expect(structured.session).toBeNull();
    expect(structured.noActionableHostAgentWork).toMatchObject({
      releasedEmptySession: true,
      stopReason: 'diminishing-returns',
    });

    const empty = project(
      'alembic_rescan',
      presentHostAgentKnowledgeRescanEmptyProject({ responseTimeMs: 1 })
    ).structured;
    expect(empty.businessMessage).toBe('No source files found. Nothing to rescan.');
  });
});

describe('H1 plan-gate and rebuild blocked envelopes keep their recovery details', () => {
  test.each([
    'alembic_rescan',
    'alembic_bootstrap',
  ] as const)('%s PLAN_REQUIRED exposes blockedReason and nextActions', async (toolName) => {
    const gate = await resolvePlanGenerationGate(
      { container: { get: () => undefined } },
      { projectRoot: '/tmp/alembic-plan-gate-project' },
      {
        defaultStage: toolName === 'alembic_bootstrap' ? 'coldStart' : 'deepMining',
        toolName,
      }
    );
    expect(gate.ok).toBe(false);
    const response = (gate as { response: Record<string, unknown> }).response;
    const { result, structured } = project(toolName, response);
    expect(result.isError).toBe(true);
    expect(structured.status).toBe('blocked');
    expect(typeof structured.blockedReason).toBe('string');
    expect(String(structured.blockedReason).length).toBeGreaterThan(0);
    expect(structured.needsUserInput).toBe(true);
    expect(structured.nextActions).toEqual(asRecord(response.data).nextActions);
  });

  test('bootstrap rebuild confirmation block exposes the knowledge counts and next actions', () => {
    const block = buildGenerateRebuildConfirmationBlock({
      databaseEntryCount: 4,
      dbRecipeCount: 3,
      materializedRecipeCount: 3,
      recipeCount: 3,
      skillCount: 1,
      usable: true,
    } as never);
    expect(block).not.toBeNull();
    const { structured } = project('alembic_bootstrap', block);
    expect(structured.ok).toBe(false);
    expect(structured.needsUserInput).toBe(true);
    expect(structured.knowledge).toMatchObject({ recipeCount: 3, usable: true });
    expect(structured.nextActions).toEqual(asRecord(asRecord(block).data).nextActions);
  });
});

describe('H1 alembic_dimension_complete gate failures reach the host', () => {
  test('evidence gate failure exposes evidenceGate, rejectedItems and problem', async () => {
    const response = await runHostAgentDimensionCompletionWorkflow(
      createDimensionContext(),
      {
        dimensionId: 'architecture',
        analysisText:
          'Architecture analysis that is long enough to pass the basic input validation step.',
        keyFindings: ['One finding only.'],
      },
      {
        getActiveSession: () => createThinSession(),
        saveCheckpoint: async () => undefined,
        createEmitter: () => ({ emitDimensionComplete: () => {}, emitAllComplete: () => {} }),
      }
    );
    expect(response.success).toBe(false);
    const wrapped = envelope(response as Parameters<typeof envelope>[0]);
    const { result, structured } = project('alembic_dimension_complete', wrapped);
    expect(result.isError).toBe(true);
    expect(structured.status).toBe('blocked');
    const gate = asRecord(structured.evidenceGate);
    expect(gate.status).toBe('rebuild-required');
    expect(Array.isArray(gate.violations)).toBe(true);
    expect((gate.violations as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(structured.rejectedItems)).toBe(true);
    expect((structured.rejectedItems as unknown[]).length).toBe(
      (gate.violations as unknown[]).length
    );
    expect(asRecord(structured.problem)).toMatchObject({ status: 'rebuild-required' });
  });

  test('final-dimension knowledgeSkillAutoSync summary is visible on success', () => {
    const { structured } = project('alembic_dimension_complete', {
      success: true,
      errorCode: null,
      message: '',
      data: {
        dimensionId: 'architecture',
        isBootstrapComplete: true,
        knowledgeSkillAutoSync: {
          attempted: true,
          success: false,
          errorCode: 'AUTO_SKILL_REFRESH_FAILED',
          message: 'refresh failed',
          refreshedCount: 0,
          removedCount: 0,
        },
      },
      meta: { tool: 'alembic_dimension_complete' },
    });
    expect(structured.knowledgeSkillAutoSync).toMatchObject({
      attempted: true,
      errorCode: 'AUTO_SKILL_REFRESH_FAILED',
    });
  });
});

describe('H1 alembic_plan deepMining draft exposes coverageSeed', () => {
  test('real deepMining draft carries coverageSeed through the plan projector', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-plan-coverage-seed-'));
    tempRoots.push(projectRoot);
    const previousHome = process.env.ALEMBIC_HOME;
    process.env.ALEMBIC_HOME = projectRoot;
    try {
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'fixture-plan', main: 'src/index.ts' })
      );
      fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(projectRoot, 'src', 'util.ts'), 'export const b = 2;\n');
      const { projectLocationService } = await import(
        '../../lib/host-runtime/context/ProjectLocationService.js'
      );
      const coverageLedgerRepository = {
        listByProjectRoot: () => [
          {
            projectRoot,
            moduleId: 'fixture-plan',
            dimensionId: 'architecture',
            grade: 'thin',
            coveredCount: 1,
            totalCandidateCount: 1,
            valueScore: 5,
            exhausted: false,
            exhaustedReason: null,
          },
        ],
      };
      const ctx = {
        actor: { role: 'unit-test', user: 'unit-test' },
        container: {
          get: (name: string) =>
            name === 'coverageLedgerRepository' ? coverageLedgerRepository : undefined,
          singletons: { _projectRoot: projectRoot },
        },
        projectRuntime: {
          identity: { dataRoot: projectLocationService.resolve(projectRoot).dataRoot },
        },
      } as unknown as McpContext;
      const draft = (await routePlanTool(ctx, {
        operation: 'draft',
        projectRoot,
        generationStage: 'deepMining',
      })) as { success: boolean; data?: Record<string, unknown> };
      expect(draft.success).toBe(true);
      expect(draft.data).toHaveProperty('coverageSeed');

      const { structured } = project('alembic_plan', draft);
      expect(asRecord(structured.coverageSeed)).toMatchObject({
        gapCandidates: [expect.objectContaining({ dimensionId: 'architecture', grade: 'thin' })],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.ALEMBIC_HOME;
      } else {
        process.env.ALEMBIC_HOME = previousHome;
      }
    }
  });
});

describe('H1 tool descriptions name fields that actually reach the host', () => {
  test('rescan/bootstrap descriptions do not promise the absent planState projection', () => {
    for (const name of ['alembic_rescan', 'alembic_bootstrap']) {
      const description = TOOLS.find((tool) => tool.name === name)?.description ?? '';
      expect(description).not.toContain('planState');
    }
    const rescanDescription =
      TOOLS.find((tool) => tool.name === 'alembic_rescan')?.description ?? '';
    expect(rescanDescription).toContain('evidenceHints (allRecipes');
    expect(rescanDescription).toContain('constraints.occupiedTriggers');
  });
});

function createDimensionContext(): HostAgentDimensionCompletionContext {
  const projectRoot = '/tmp/alembic-fix-plan-rescan-project';
  return {
    container: {
      singletons: {
        _projectRoot: projectRoot,
        _dataRoot: projectRoot,
        _workspaceResolver: { dataRoot: projectRoot },
      },
      get: () => null,
    },
    projectRuntime: { identity: { dataRoot: projectRoot } },
  } as unknown as HostAgentDimensionCompletionContext;
}

function createThinSession(): HostAgentWorkflowSession {
  const dimensions = [
    { id: 'architecture', label: 'Architecture', skillWorthy: false },
    { id: 'tooling', label: 'Tooling', skillWorthy: false },
  ];
  return {
    id: 'session-thin',
    projectRoot: '/tmp/alembic-fix-plan-rescan-project',
    expiresAt: Date.now(),
    dimensions,
    submissionTracker: {
      getSubmissions: (dimId: string) =>
        dimId === 'architecture'
          ? [{ recipeId: 'recipe-a', sources: ['src/a.ts:10-20'], title: 'A' }]
          : [],
      getAccumulatedEvidence: () => ({
        completedDimSummaries: [],
        sharedFiles: [],
        negativeSignals: [],
        usedTriggers: [],
      }),
    },
    sessionStore: { getDimensionReport: () => undefined },
    getSnapshotCache: () => ({ localPackageModules: [] }),
    getProgress: () => ({
      completed: 0,
      total: 2,
      completedDimIds: [],
      remainingDimIds: ['architecture', 'tooling'],
    }),
    isComplete: false,
    markDimensionComplete: () => ({
      updated: false,
      qualityReport: { totalScore: 72, pass: true, scores: {}, suggestions: [] },
    }),
    storeHints: () => {},
    getAccumulatedHints: () => ({}),
  } as unknown as HostAgentWorkflowSession;
}
