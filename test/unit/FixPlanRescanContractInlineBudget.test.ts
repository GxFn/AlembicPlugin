import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  presentHostAgentKnowledgeRescanResponse,
  projectRescanEvidenceHints,
} from '@alembic/core/host-agent-workflows';
import { afterEach, describe, expect, test } from 'vitest';
import {
  attachBriefingTransportMeta,
  attachFullBriefingRef,
  BRIEFING_INLINE_BUDGET_BYTES,
  budgetBriefingResponseData,
} from '#recipe-pipeline/generate/briefing-budget.js';
import {
  CORE_TOOL_OUTPUT_SCHEMAS,
  findForbiddenCoreOutputField,
  RESCAN_OVER_BUDGET_EVIDENCE_HINTS_INLINE_BYTES,
} from '../../lib/host-runtime/mcp/core-tools/output.js';
import { serializeMcpToolResult } from '../../lib/host-runtime/mcp/output-contract.js';

// H1 复审：evidenceHints 进入 alembic_rescan 白名单后，rescan 预算步骤（无 compact 回调）超 18KB 时
// 仍把完整 data 内联返回。投影层必须在 meta.fullBriefingRef 存在时把 evidenceHints 收敛为有界内联，
// 完整正文留在 transient 引用里；未超预算时保持原样。

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const DIMENSIONS = ['architecture', 'networking', 'storage', 'ui', 'testing', 'tooling'];

function buildEvidencePlan(recipeCount: number) {
  const allRecipes = Array.from({ length: recipeCount }, (_, index) => {
    const verdict = index % 5 === 0 ? ('decay' as const) : ('healthy' as const);
    return {
      id: `recipe-${index}`,
      title: `Recipe ${index} keeps the shared router pattern`,
      trigger: `@recipe-trigger-${index}`,
      dimensionId: DIMENSIONS[index % DIMENSIONS.length],
      knowledgeType: 'code-pattern',
      doClause: 'Route every request through the shared router before dispatching.',
      lifecycle: 'active',
      // Core RescanEvidenceProjectors 的切片上限：markdown 500 / rationale 200 / coreCode 400 字符。
      content: {
        markdown: 'm'.repeat(500),
        rationale: 'r'.repeat(200),
        coreCode: 'c'.repeat(400),
      },
      sourceRefs: Array.from({ length: 5 }, (_, ref) => `src/module-${index}/file-${ref}.ts:1-40`),
      auditHint: {
        relevanceScore: verdict === 'decay' ? 0.3 : 0.9,
        verdict,
        decayReasons: verdict === 'decay' ? ['source moved'] : [],
      },
    };
  });
  const dimensionGaps = DIMENSIONS.map((dimensionId) => ({
    dimensionId,
    existingCount: allRecipes.filter((recipe) => recipe.dimensionId === dimensionId).length,
    gap: 2,
    executionMode: 'produce' as const,
    createBudget: 2,
    shouldExecute: true,
    existingTriggers: allRecipes
      .filter((recipe) => recipe.dimensionId === dimensionId)
      .map((recipe) => recipe.trigger),
    executionReasons: [],
  }));
  const needsVerification = allRecipes
    .filter((recipe) => recipe.auditHint.verdict === 'decay')
    .map((recipe) => ({
      recipeId: recipe.id,
      title: recipe.title,
      dimension: recipe.dimensionId,
      relevanceVerdict: 'decay',
      relevanceScore: 0.3,
      auditHint: 'source moved',
      decayReasons: ['source moved'],
    }));
  const autoResolved = allRecipes
    .filter((recipe) => recipe.auditHint.verdict === 'healthy')
    .map((recipe) => ({
      recipeId: recipe.id,
      resolution: 'auto-skip',
      reason: 'relevanceScore=0.9, verdict=healthy — 自动跳过',
    }));
  return {
    evidencePlan: {
      allRecipes,
      dimensionGaps,
      executionReasons: {},
      totalGap: 12,
      totalCreateBudget: 12,
      decayCount: needsVerification.length,
      occupiedTriggers: allRecipes.map((recipe) => recipe.trigger),
      coveredDimensions: 0,
      gapSummary: '需补齐维度。',
    },
    prescreen: { needsVerification, autoResolved, dimensionGaps: {} },
  };
}

async function buildBudgetedRescanResponse(recipeCount: number) {
  const { evidencePlan, prescreen } = buildEvidencePlan(recipeCount);
  const evidenceHints = projectRescanEvidenceHints({
    evidencePlan,
    prescreen,
  } as unknown as Parameters<typeof projectRescanEvidenceHints>[0]);
  const response = presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot: { count: recipeCount } as never,
    cleanResult: { clearedTables: ['a'], deletedFiles: 0 } as never,
    auditSummary: {
      totalAudited: recipeCount,
      healthy: recipeCount - prescreen.needsVerification.length,
      watch: 0,
      decay: prescreen.needsVerification.length,
      severe: 0,
      dead: 0,
      proposalsCreated: 0,
      immediateDeprecated: 0,
    } as never,
    briefing: {
      evidenceHints,
      executionPlan: { tiers: [], totalDimensions: DIMENSIONS.length, workflow: 'evolve → submit' },
      session: { id: 'session-rescan-budget', state: 'active', dimensionCount: DIMENSIONS.length },
      submissionSchema: { example: { title: 'x' }, recipeAuthoringFrontLoad: { rules: [] } },
    },
    evidencePlan: evidencePlan as never,
    dimensions: DIMENSIONS.map((id) => ({ id })) as never,
    reason: 'unit',
    responseTimeMs: 3,
  }) as unknown as Record<string, unknown>;

  // 走真实的 rescan 预算步骤（与 knowledge-rescan.ts 相同参数：无 compact 回调）。
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-rescan-budget-'));
  tempRoots.push(dataRoot);
  await budgetBriefingResponseData(response, {
    dataRoot,
    projectRoot: path.join(dataRoot, 'project'),
    transportName: 'rescan-briefing',
    inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
    attachRef: (data, ref) => attachFullBriefingRef(data, ref),
  });
  attachBriefingTransportMeta(response, asRecord(response.data));
  return { response, evidencePlan, prescreen };
}

function project(legacy: unknown) {
  const result = serializeMcpToolResult('alembic_rescan', legacy, {
    isErrorResult: (value) =>
      !!value && typeof value === 'object' && (value as { success?: unknown }).success === false,
  });
  const structured = result.structuredContent as Record<string, unknown>;
  expect(findForbiddenCoreOutputField(structured)).toBeNull();
  expect(CORE_TOOL_OUTPUT_SCHEMAS.alembic_rescan.parse(structured)).toEqual(structured);
  return structured;
}

describe('H1 review: over-budget alembic_rescan keeps a bounded inline evidenceHints', () => {
  test.each([
    150, 400,
  ])('%i recipes: inline evidenceHints stays within the cap while the full body stays in fullBriefingRef', async (recipeCount) => {
    const { response, evidencePlan, prescreen } = await buildBudgetedRescanResponse(recipeCount);
    const fullBriefingRef = asRecord(asRecord(response.meta).fullBriefingRef);
    // 前提：原始 data 确实超预算，预算步骤写了 transient 并附引用，但未瘦身内联。
    expect(typeof fullBriefingRef.path).toBe('string');
    expect(bytes(response.data)).toBeGreaterThan(BRIEFING_INLINE_BUDGET_BYTES);
    const transient = JSON.parse(fs.readFileSync(String(fullBriefingRef.path), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(asRecord(transient.evidenceHints).allRecipes).toEqual(evidencePlan.allRecipes);

    const structured = project(response);
    const hints = asRecord(structured.evidenceHints);
    expect(bytes(hints)).toBeLessThanOrEqual(RESCAN_OVER_BUDGET_EVIDENCE_HINTS_INLINE_BYTES);
    // 整个 structuredContent 与配方数量脱钩：保持在 cold-start 同口径的 20KB 硬上限内。
    expect(bytes(structured)).toBeLessThanOrEqual(20 * 1024);
    expect(asRecord(structured.meta).fullBriefingRef).toEqual(fullBriefingRef);

    // 硬约束仍完整内联：去重 trigger 列表与每维执行模式/创建预算。
    const constraints = asRecord(hints.constraints);
    expect(constraints.occupiedTriggers).toEqual(evidencePlan.occupiedTriggers);
    expect(Array.isArray(constraints.rules)).toBe(true);
    const gaps = hints.dimensionGaps as Array<Record<string, unknown>>;
    expect(gaps.map((gap) => [gap.dimensionId, gap.executionMode, gap.createBudget])).toEqual(
      evidencePlan.dimensionGaps.map((gap) => [
        gap.dimensionId,
        gap.executionMode,
        gap.createBudget,
      ])
    );
    expect(asRecord(hints.evolutionGuide).totalCount).toBe(recipeCount);

    // 内联 allRecipes 为瘦身条目（无正文/sourceRefs），并显式标注总数与完整体位置。
    const inlineRecipes = hints.allRecipes as Array<Record<string, unknown>>;
    for (const recipe of inlineRecipes) {
      expect(recipe).not.toHaveProperty('content');
      expect(recipe).not.toHaveProperty('sourceRefs');
      expect(typeof recipe.trigger).toBe('string');
    }
    const projection = asRecord(hints.inlineProjection);
    expect(projection.mode).toBe('over-budget-compact');
    expect(projection.fullBriefingRef).toBe('meta.fullBriefingRef');
    expect(asRecord(projection.allRecipes).total).toBe(recipeCount);
    expect(asRecord(projection.allRecipes).inline).toBe(inlineRecipes.length);
    expect(asRecord(projection.needsVerification).total).toBe(prescreen.needsVerification.length);
    expect(asRecord(projection.autoResolved).total).toBe(prescreen.autoResolved.length);

    // 需验证（衰退）配方在瘦身列表中排前：一旦出现非优先配方，优先配方必须已全部内联。
    const priorityIds = new Set(prescreen.needsVerification.map((item) => item.recipeId));
    const firstNonPriority = inlineRecipes.findIndex(
      (recipe) => !priorityIds.has(String(recipe.id))
    );
    if (firstNonPriority >= 0) {
      expect(firstNonPriority).toBe(priorityIds.size);
    } else {
      expect(inlineRecipes.every((recipe) => priorityIds.has(String(recipe.id)))).toBe(true);
    }
    const inlineNeedsVerification = asRecord(hints.evolutionPrescreen)
      .needsVerification as unknown[];
    expect(asRecord(projection.needsVerification).inline).toBe(inlineNeedsVerification.length);
    // autoResolved（healthy 自动跳过，无需 Agent 动作）只留计数。
    expect(asRecord(hints.evolutionPrescreen).autoResolved).toEqual([]);
  });

  test('150 recipes: needsVerification (the actionable list) is inlined before the slim recipe list', async () => {
    const { prescreen, response } = await buildBudgetedRescanResponse(150);
    const hints = asRecord(project(response).evidenceHints);
    const needsVerification = asRecord(hints.evolutionPrescreen).needsVerification as unknown[];
    expect(needsVerification).toEqual(prescreen.needsVerification);
  });

  test('under-budget rescan keeps evidenceHints unchanged and adds no inlineProjection', async () => {
    const { response, evidencePlan } = await buildBudgetedRescanResponse(3);
    expect(asRecord(response.meta).fullBriefingRef).toBeNull();
    const hints = asRecord(project(response).evidenceHints);
    expect(hints.allRecipes).toEqual(evidencePlan.allRecipes);
    expect(hints).not.toHaveProperty('inlineProjection');
  });
});
