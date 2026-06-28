/**
 * MCP Tool Router — 参数路由层
 *
 * 将多模式工具（alembic_search / graph / skill）
 * 按 operation / mode 参数路由到已有 handler 实现。
 *
 * 不包含业务逻辑，仅做参数解构 → 路由 → 转发。
 *
 * alembic_bootstrap 已迁移到 host-agent/bootstrap.js（宿主 Agent 路径）。
 */

import { dimensionTags } from '@alembic/core/dimensions';
import type { CreateRecipeItem, CreateRecipeResult } from '@alembic/core/knowledge';
import { getRequiredFieldsDescription } from '@alembic/core/knowledge';
import { getDeveloperIdentity, HOST_AGENT_SOURCE } from '@alembic/core/shared';
import { normalizeHostAgentWriteSource } from '#codex/SourceBoundary.js';
import {
  buildKnownModuleNames,
  buildResolveModuleFromSourceRefs,
} from '#recipe-generation/canonical-module-axis.js';
import { resolveHostAgentDataRoot } from '#recipe-generation/host-agent-workflows/project-data-root.js';
import {
  buildEvidenceGateFailureData,
  primaryEvidenceGateCode,
  type RecipeEvidenceGateResult,
  resolveBootstrapSession,
  shouldRunRecipeEvidenceGate,
  validateRecipeProductionEvidenceGate,
} from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';
import { routePlanTool as routePlanToolImpl } from '#recipe-generation/plan-tool.js';
import { assessProjectContextRelationshipGrounding } from '#recipe-generation/project-context-anchoring.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import {
  type RecipeContentQualityGateResult,
  validateSubmitKnowledgeContentQuality,
} from '../../../runtime/mcp/handlers/recipe-content-quality-gate.js';
import * as recipeMapHandlers from '../../../runtime/mcp/handlers/recipe-map.js';
import * as searchHandlers from '../../../runtime/mcp/handlers/search.js';
import * as skillHandlers from '../../../runtime/mcp/handlers/skill.js';
import * as structureHandlers from '../../../runtime/mcp/handlers/structure.js';
import type {
  McpContext,
  ToolRouterGraphArgs,
  ToolRouterSearchArgs,
  ToolRouterSkillArgs,
} from '../../../runtime/mcp/handlers/types.js';
import {
  type RecipeFreshnessPublicOutput,
  refreshCreatedRecipeFreshness,
} from '../../../service/knowledge/RecipeFreshnessRuntime.js';

type PendingSemanticReview = NonNullable<CreateRecipeResult['pendingSemanticReview']>[number];
type BootstrapSession = ReturnType<typeof resolveBootstrapSession>;

interface SubmitKnowledgeOptions {
  bootstrapSessionId?: string;
  clientId?: string;
  dimensionId?: string;
  skipConsolidation: boolean;
  source: unknown;
  supersedes?: string;
}

type SubmitItemsResult =
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; response: unknown };

type SubmitProjectContextResult =
  | { ok: true; projectRoot: string }
  | { ok: false; response: unknown };

interface PendingSemanticReviewDecision {
  action: 'keep';
  newRecipeId: string;
  reasoning: string;
}

// ─── alembic_search (mode router) ────────────────────────

// alembic_recipe_map replaces alembic_project_matrix. Single handler; focus-driven.
export async function routeRecipeMapTool(ctx: McpContext, args: Record<string, unknown>) {
  return recipeMapHandlers.recipeMap(ctx, args);
}

/**
 * 搜索工具路由：根据 mode 参数路由到对应搜索 handler
 *   auto (默认) → search()
 *   keyword     → keywordSearch()
 *   semantic    → semanticSearch()
 */
export async function routeSearchTool(ctx: McpContext, args: ToolRouterSearchArgs) {
  const mode = args.mode || 'auto';
  switch (mode) {
    case 'keyword':
      return searchHandlers.keywordSearch(ctx, args);
    case 'semantic':
      return searchHandlers.semanticSearch(ctx, args);
    default:
      return searchHandlers.search(ctx, { ...args, mode });
  }
}

// ─── alembic_knowledge (operation router) ─────────────────────

// MTC-1: routeKnowledgeTool / routeStructureTool / routeCallContextTool removed —
// alembic_knowledge / alembic_structure / alembic_call_context are retired tools.
// routeGraphTool (alembic_graph) below stays LIVE.

// ─── alembic_graph (queryKind) ────────────────────────────────

/**
 * 项目图谱:单一 graph handler,按 queryKind 选取 ProjectContext 视图。
 * 旧 operation 参数在 handler 边界归一为 queryKind,不再二次分支路由。
 */
export async function routeGraphTool(ctx: McpContext, args: ToolRouterGraphArgs) {
  return structureHandlers.graph(ctx, args);
}

export async function routePlanTool(
  ctx: McpContext,
  args: Record<string, unknown>
): Promise<unknown> {
  return routePlanToolImpl(ctx, args as Parameters<typeof routePlanToolImpl>[1]);
}

export async function routeProjectSkillTool(ctx: McpContext, args: ToolRouterSkillArgs) {
  if (args.name && !args.skillName) {
    args.skillName = args.name;
  }
  return skillHandlers.projectSkill(ctx, args);
}

// ─── alembic_submit_knowledge (unified pipeline) ──────────────────────

/**
 * 统一提交管线：单条与批量走同一代码路径。
 *
 * 流程:
 *   1. 限流
 *   2. V3 字段增强（MCP 特有预处理）
 *   3. RecipeProductionGateway.create() — 统一管道
 *   4. Bootstrap session 追踪
 *   5. 返回统一结果
 *
 * 设计原则：
 *   - 不降级：缺字段不自动补全，要求 Agent 一次性生成完整数据
 *   - 不碎片化：优先增强已有 Recipe，而非总新建
 *   - 不重复提交：拒绝时不创建任何记录
 *   - 单条/批量完全一致的校验与融合逻辑
 */
export async function routeSubmitKnowledgeTool(ctx: McpContext, args: Record<string, unknown>) {
  const itemsResult = resolveSubmitKnowledgeItems(args);
  if (!itemsResult.ok) {
    return itemsResult.response;
  }
  const options = resolveSubmitKnowledgeOptions(args);
  const projectContext = await resolveSubmitProjectContext(ctx, options.clientId);
  if (!projectContext.ok) {
    return projectContext.response;
  }

  preprocessSubmitKnowledgeItems(itemsResult.items, options);
  const contentQualityGate = validateSubmitKnowledgeContentQuality(itemsResult.items);
  if (!contentQualityGate.ok) {
    return buildSubmitKnowledgeContentQualityResponse(contentQualityGate);
  }
  const bootstrapSession = resolveBootstrapSession(ctx.container, options.bootstrapSessionId);
  const dataRoot = resolveHostAgentDataRoot(
    ctx.container,
    bootstrapSession?.projectRoot || projectContext.projectRoot
  );
  const evidenceGateResponse = buildSubmitKnowledgeEvidenceGateResponse({
    args,
    bootstrapSession,
    items: itemsResult.items,
    projectRoot: projectContext.projectRoot,
    skipConsolidation: options.skipConsolidation,
  });
  if (evidenceGateResponse) {
    return evidenceGateResponse;
  }

  const gatewayResult = await createSubmitKnowledgeRecipes(
    ctx,
    dataRoot,
    itemsResult.items,
    options,
    readBootstrapSubmissionSets(bootstrapSession)
  );
  trackSubmitKnowledgeResult(ctx, itemsResult.items, options.dimensionId, gatewayResult);
  const freshness = await refreshCreatedRecipeFreshness(ctx.container, gatewayResult.created);
  return buildSubmitKnowledgeResponse(
    gatewayResult,
    itemsResult.items,
    options.supersedes,
    freshness
  );
}

function resolveSubmitKnowledgeItems(args: Record<string, unknown>): SubmitItemsResult {
  const items = args.items as Record<string, unknown>[] | undefined;
  if (items && Array.isArray(items) && items.length > 0) {
    return { ok: true, items };
  }
  return {
    ok: false,
    response: envelope({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'items 数组是必需的且不能为空。请传入 items: [{ title, language, ... }]',
      meta: { tool: 'alembic_submit_knowledge' },
    }),
  };
}

function resolveSubmitKnowledgeOptions(args: Record<string, unknown>): SubmitKnowledgeOptions {
  return {
    bootstrapSessionId:
      typeof args.sessionId === 'string'
        ? args.sessionId
        : typeof args.bootstrapSessionRef === 'string'
          ? normalizeBootstrapSessionRef(args.bootstrapSessionRef)
          : undefined,
    clientId: args.client_id as string | undefined,
    dimensionId: args.dimensionId as string | undefined,
    skipConsolidation: (args.skipConsolidation as boolean) === true,
    source: normalizeHostAgentWriteSource(args.source),
    supersedes: args.supersedes as string | undefined,
  };
}

async function resolveSubmitProjectContext(
  ctx: McpContext,
  clientId: string | undefined
): Promise<SubmitProjectContextResult> {
  const { checkRecipeSave } = await import('../RateLimiter.js');
  const { resolveProjectRoot } = await import('@alembic/core/workspace');
  const projectRoot = resolveProjectRoot(ctx.container);
  const limitCheck = checkRecipeSave(projectRoot, clientId || process.env.USER || 'mcp-client');
  if (limitCheck.allowed) {
    return { ok: true, projectRoot };
  }
  return {
    ok: false,
    response: envelope({
      success: false,
      message: `提交过于频繁，请 ${limitCheck.retryAfter}s 后再试。`,
      errorCode: 'RATE_LIMIT',
      meta: { tool: 'alembic_submit_knowledge' },
    }),
  };
}

function preprocessSubmitKnowledgeItems(
  items: Array<Record<string, unknown>>,
  options: SubmitKnowledgeOptions
): void {
  for (const item of items) {
    item.source = normalizeHostAgentWriteSource(item.source || options.source);
    if (options.dimensionId && !item.dimensionId) {
      item.dimensionId = options.dimensionId;
    }
    if (item.dimensionId && typeof item.dimensionId === 'string') {
      const existingTags = Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      item.tags = dimensionTags(item.dimensionId, existingTags);
    }
  }
}

function readBootstrapSubmissionSets(bootstrapSession: BootstrapSession): {
  existingTitles?: Set<string>;
  existingTriggers?: Set<string>;
} {
  try {
    return {
      existingTitles: bootstrapSession?.submissionTracker?.getAllSubmittedTitles?.(),
      existingTriggers: bootstrapSession?.submissionTracker?.getAllSubmittedTriggers?.(),
    };
  } catch {
    return {};
  }
}

async function createSubmitKnowledgeRecipes(
  ctx: McpContext,
  dataRoot: string,
  items: Array<Record<string, unknown>>,
  options: SubmitKnowledgeOptions,
  existing: { existingTitles?: Set<string>; existingTriggers?: Set<string> }
): Promise<CreateRecipeResult> {
  const gateway = await createSubmitKnowledgeGateway(ctx, dataRoot);
  return gateway.create({
    source: HOST_AGENT_SOURCE,
    items: items as CreateRecipeItem[],
    options: {
      skipConsolidation: options.skipConsolidation,
      supersedes: options.supersedes,
      existingTitles: existing.existingTitles,
      existingTriggers: existing.existingTriggers,
      userId: getDeveloperIdentity(),
    },
  });
}

async function createSubmitKnowledgeGateway(ctx: McpContext, dataRoot: string) {
  const { RecipeProductionGateway } = await import('@alembic/core/knowledge');
  const { findSimilarRecipes } = await import('@alembic/core/service/candidate');
  type GatewayOptions = ConstructorParameters<typeof RecipeProductionGateway>[0];
  // U1 #5：从 canonical ProjectMap.modules（ModuleService 已加载的内存投影）构造模块轴依赖，
  // 让 Core #deriveModuleName 按 canonical 轴校验显式 moduleName / 反查 sourceRefs 落点。
  // submit 是 async 路径，可安全 await moduleService；取不到模块轴时两个 dep 为 undefined，
  // Core 退回原 passthrough（加性、向后兼容）。
  const moduleAxis = await resolveSubmitKnowledgeModuleAxis(ctx);
  return new RecipeProductionGateway({
    knowledgeService: ctx.container.get('knowledgeService'),
    projectRoot: dataRoot,
    consolidationAdvisor: optionalContainerService(
      ctx,
      'consolidationAdvisor'
    ) as GatewayOptions['consolidationAdvisor'],
    proposalRepository: optionalContainerService(
      ctx,
      'proposalRepository'
    ) as GatewayOptions['proposalRepository'],
    evolutionGateway: optionalContainerService(
      ctx,
      'evolutionGateway'
    ) as GatewayOptions['evolutionGateway'],
    findSimilarRecipes,
    ...(moduleAxis.knownModuleNames ? { knownModuleNames: moduleAxis.knownModuleNames } : {}),
    ...(moduleAxis.resolveModuleFromSourceRefs
      ? { resolveModuleFromSourceRefs: moduleAxis.resolveModuleFromSourceRefs }
      : {}),
  });
}

/**
 * U1 #5：解析 submit-knowledge 路径的 canonical 模块轴依赖。
 * best-effort：moduleService 不可取 / 未加载出模块 / 加载抛错 → 返回空，让 Core 退回 passthrough。
 */
async function resolveSubmitKnowledgeModuleAxis(ctx: McpContext): Promise<{
  knownModuleNames?: string[];
  resolveModuleFromSourceRefs?: (sourceRefs: string[]) => string | undefined;
}> {
  try {
    const moduleService = optionalContainerService(ctx, 'moduleService') as {
      listCanonicalModules?: () => Promise<Array<{ id?: string; name: string; path?: string }>>;
    } | null;
    if (!moduleService || typeof moduleService.listCanonicalModules !== 'function') {
      return {};
    }
    const modules = await moduleService.listCanonicalModules();
    if (!Array.isArray(modules) || modules.length === 0) {
      return {};
    }
    return {
      knownModuleNames: buildKnownModuleNames(modules),
      resolveModuleFromSourceRefs: buildResolveModuleFromSourceRefs(modules),
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    // ctx.logger 在 McpContext 上是 index-signature（unknown），做类型守卫再调用。
    const logger = ctx.logger;
    if (
      logger &&
      typeof logger === 'object' &&
      typeof (logger as { warn?: unknown }).warn === 'function'
    ) {
      (logger as { warn: (msg: string, meta?: Record<string, unknown>) => void }).warn(
        '[SubmitKnowledge] canonical module axis unavailable — Core passthrough',
        { reason }
      );
    }
    return {};
  }
}

function optionalContainerService(ctx: McpContext, name: string): unknown {
  try {
    return ctx.container.get(name) ?? null;
  } catch {
    return null;
  }
}

function trackSubmitKnowledgeResult(
  ctx: McpContext,
  items: Array<Record<string, unknown>>,
  dimensionId: string | undefined,
  gatewayResult: CreateRecipeResult
): void {
  for (const created of gatewayResult.created) {
    _trackSubmission(
      ctx,
      items.find((it) => it.title === created.title) || {},
      dimensionId,
      created.id
    );
  }
  for (const rej of gatewayResult.rejected) {
    _trackRejection(ctx, items[rej.index] || {}, dimensionId);
  }
}

function buildSubmitKnowledgeResponse(
  gatewayResult: CreateRecipeResult,
  items: Array<Record<string, unknown>>,
  supersedes: string | undefined,
  freshness: RecipeFreshnessPublicOutput | null
) {
  const successCount = gatewayResult.created.length;
  const data: Record<string, unknown> = {
    count: successCount,
    total: items.length,
  };

  appendCreatedSubmitData(data, gatewayResult, items);
  appendRejectedSubmitData(data, gatewayResult, items.length);
  appendBlockedSubmitData(data, gatewayResult);
  appendProposalSubmitData(data, gatewayResult, supersedes);
  appendPendingSemanticReviewData(data, gatewayResult);
  appendRelationshipGroundingData(data, items);
  appendSubmitFreshnessData(data, freshness);
  appendSubmitTruthfulnessData(data, freshness);

  if (successCount === 0 && gatewayResult.rejected.length === items.length) {
    return buildAllRejectedSubmitResponse(data, gatewayResult, items.length);
  }

  const allOk = successCount === items.length;
  return envelope({
    success: successCount > 0,
    data,
    message: allOk
      ? `已提交 ${successCount} 条知识条目。`
      : `已提交 ${successCount}/${items.length} 条知识条目。`,
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

function appendSubmitFreshnessData(
  data: Record<string, unknown>,
  freshness: RecipeFreshnessPublicOutput | null
): void {
  if (!freshness) {
    return;
  }
  data.freshness = freshness;
  data.retrievalMayBeStale = freshness.retrievalMayBeStale;
}

function appendSubmitTruthfulnessData(
  data: Record<string, unknown>,
  freshness: RecipeFreshnessPublicOutput | null
): void {
  const degradedReasons = collectSubmitDegradedReasons(data, freshness);
  const degraded = degradedReasons.length > 0;
  data.status = degraded ? 'degraded' : 'completed';
  data.finality = degraded ? 'non-final' : 'final';
  if (degraded) {
    data.degraded = true;
    data.degradedReasons = degradedReasons;
    data.retrievalMayBeStale = true;
  } else if (data.retrievalMayBeStale !== true) {
    data.retrievalMayBeStale = false;
  }
}

function collectSubmitDegradedReasons(
  data: Record<string, unknown>,
  freshness: RecipeFreshnessPublicOutput | null
): string[] {
  const reasons: string[] = [];
  if (freshness) {
    if (freshness.status !== 'completed') {
      reasons.push(`freshness:${freshness.status}`);
    }
    if (freshness.retrievalMayBeStale) {
      reasons.push('freshness:retrieval-may-be-stale');
    }
    for (const recipe of freshness.recipes) {
      if (recipe.status !== 'completed') {
        reasons.push(`freshness:${recipe.recipeId}:${recipe.status}`);
      }
      if (recipe.skippedReason) {
        reasons.push(`freshness:${recipe.recipeId}:${recipe.skippedReason}`);
      }
      for (const error of recipe.errors ?? []) {
        reasons.push(`freshness:${recipe.recipeId}:${error}`);
      }
      for (const error of recipe.sourceRefs.errors ?? []) {
        reasons.push(`source-refs:${recipe.recipeId}:${error}`);
      }
      if (recipe.vector.degradedReason) {
        reasons.push(`vector:${recipe.recipeId}:${recipe.vector.degradedReason}`);
      }
      if (recipe.vector.availabilityReason) {
        reasons.push(`vector:${recipe.recipeId}:${recipe.vector.availabilityReason}`);
      }
    }
    for (const error of freshness.errors ?? []) {
      reasons.push(`freshness:${error}`);
    }
  }

  const relationshipGrounding = readRecord(data.relationshipGrounding);
  if (relationshipGrounding.status === 'needs-evidence') {
    reasons.push('relationship-grounding:needs-evidence');
    if ((readNumber(relationshipGrounding.missingGraphEvidenceCount) ?? 0) > 0) {
      reasons.push('relationship-grounding:missing-graph-evidence');
    }
    if ((readNumber(relationshipGrounding.missingSourceEvidenceCount) ?? 0) > 0) {
      reasons.push('relationship-grounding:missing-source-evidence');
    }
  }
  return uniqueStrings(reasons);
}

function appendCreatedSubmitData(
  data: Record<string, unknown>,
  gatewayResult: CreateRecipeResult,
  items: Array<Record<string, unknown>>
): void {
  if (gatewayResult.created.length > 0) {
    data.ids = gatewayResult.created.map((c) => c.id);
  }
  const hostAgentAnalysisLinkage = buildHostAgentAnalysisLinkage(items, gatewayResult.created);
  if (hostAgentAnalysisLinkage.length > 0) {
    const linkage = {
      links: hostAgentAnalysisLinkage,
      message:
        'Optional HostAgentAnalysisUnit linkage was accepted for host-agent progress backfill; submissions without unitId remain valid.',
    };
    data.hostAgentAnalysisLinkage = linkage;
    data.ideAgentAnalysisLinkage = linkage;
  }
}

function appendRejectedSubmitData(
  data: Record<string, unknown>,
  gatewayResult: CreateRecipeResult,
  itemCount: number
): void {
  if (gatewayResult.rejected.length === 0) {
    return;
  }
  const rejectedItems = gatewayResult.rejected.map((r) => ({
    index: r.index,
    title: r.title,
    errors: r.errors,
    warnings: r.warnings,
  }));
  data.rejectedItems = rejectedItems;
  data.rejectedSummary = {
    rejectedCount: rejectedItems.length,
    commonErrors: [...new Set(rejectedItems.flatMap((it) => it.errors))],
    message: `${rejectedItems.length}/${itemCount} 条知识条目因校验未通过被拒绝。`,
  };
}

function appendBlockedSubmitData(
  data: Record<string, unknown>,
  gatewayResult: CreateRecipeResult
): void {
  if (gatewayResult.blocked.length === 0) {
    return;
  }
  data.blockedItems = gatewayResult.blocked;
  data.blockedSummary = {
    blockedCount: gatewayResult.blocked.length,
    message: `${gatewayResult.blocked.length} 条因融合分析被阻塞（与已有 Recipe 重叠或实质性不足）。设 skipConsolidation: true 可跳过。`,
  };
}

function appendProposalSubmitData(
  data: Record<string, unknown>,
  gatewayResult: CreateRecipeResult,
  supersedes: string | undefined
): void {
  const createdProposals = collectCreatedSubmitProposals(gatewayResult, supersedes);
  if (createdProposals.length === 0) {
    return;
  }
  data.proposals = createdProposals;
  data.proposalSummary = {
    proposalCount: createdProposals.length,
    message: `${createdProposals.length} 条已创建进化提案，系统将在观察窗口到期后自动执行。无需额外操作。`,
  };
}

function collectCreatedSubmitProposals(
  gatewayResult: CreateRecipeResult,
  supersedes: string | undefined
): unknown[] {
  const createdProposals: unknown[] = gatewayResult.merged.map((m) => ({
    proposalId: m.proposalId,
    type: m.type,
    targetRecipe: { id: m.targetRecipeId, title: m.targetTitle },
    status: m.status,
    expiresAt: m.expiresAt,
    message: m.message,
  }));
  if (gatewayResult.supersedeProposal) {
    createdProposals.push({
      proposalId: gatewayResult.supersedeProposal.proposalId,
      type: 'supersede',
      targetRecipe: { id: supersedes, title: supersedes },
      status: 'observing',
      expiresAt: 0,
      message: `已创建替代提案。`,
    });
  }
  return createdProposals;
}

function appendPendingSemanticReviewData(
  data: Record<string, unknown>,
  gatewayResult: CreateRecipeResult
): void {
  if (!gatewayResult.pendingSemanticReview || gatewayResult.pendingSemanticReview.length === 0) {
    return;
  }
  const reviewActions = gatewayResult.pendingSemanticReview.map((review) => ({
    review,
    decision: _buildPendingSemanticReviewDecision(review),
  }));
  data.pendingSemanticReview = gatewayResult.pendingSemanticReview;
  appendConsolidateNextAction(data, reviewActions);
  appendConsolidateBlockedAction(data, reviewActions);
}

function appendRelationshipGroundingData(
  data: Record<string, unknown>,
  items: Array<Record<string, unknown>>
): void {
  const relationshipGrounding = assessProjectContextRelationshipGrounding(items);
  if (relationshipGrounding) {
    data.relationshipGrounding = relationshipGrounding;
  }
}

function appendConsolidateNextAction(
  data: Record<string, unknown>,
  reviewActions: Array<{
    review: PendingSemanticReview;
    decision: PendingSemanticReviewDecision | null;
  }>
): void {
  const decisions = reviewActions
    .map((entry) => entry.decision)
    .filter((decision): decision is PendingSemanticReviewDecision => decision !== null);
  if (decisions.length === 0) {
    return;
  }
  data.nextAction = {
    tool: 'alembic_consolidate',
    args: { decisions },
    required: false,
    reason:
      `${decisions.length} 条候选处于相似度模糊区间（0.4-0.65），` +
      `字段分析不明确，建议阅读源代码后调用 alembic_consolidate 判断是否需要合并。`,
  };
}

function appendConsolidateBlockedAction(
  data: Record<string, unknown>,
  reviewActions: Array<{
    review: PendingSemanticReview;
    decision: PendingSemanticReviewDecision | null;
  }>
): void {
  const missingRecipeId = reviewActions
    .filter((entry) => entry.decision === null)
    .map((entry) => ({
      index: entry.review.index,
      title: entry.review.title,
      reason: entry.review.reason,
    }));
  if (missingRecipeId.length === 0) {
    return;
  }
  data.nextActionBlocked = {
    tool: 'alembic_consolidate',
    blockedCount: missingRecipeId.length,
    missingRecipeId,
    reason:
      `Core 未返回 pendingSemanticReview[].newRecipeId 或 createdRecipe.id，` +
      `Plugin 不会猜测新 Recipe ID，也不会生成不可执行的 consolidate 指令。`,
  };
}

function buildAllRejectedSubmitResponse(
  data: Record<string, unknown>,
  gatewayResult: CreateRecipeResult,
  itemCount: number
) {
  return envelope({
    success: false,
    errorCode: 'INCOMPLETE_SUBMISSION',
    message: `全部 ${itemCount} 条知识条目被拒绝。请在单次调用中补齐所有字段后重新提交。`,
    data: {
      rejectedItems: data.rejectedItems,
      requiredFields: getRequiredFieldsDescription(),
      commonErrors: [...new Set(gatewayResult.rejected.flatMap((it) => it.errors))],
      ...(data.relationshipGrounding ? { relationshipGrounding: data.relationshipGrounding } : {}),
    },
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

function buildSubmitKnowledgeContentQualityResponse(qualityGate: RecipeContentQualityGateResult) {
  return envelope({
    success: false,
    errorCode: 'QUALITY_GATE_FAILED',
    message: buildSubmitKnowledgeContentQualitySummary(qualityGate),
    data: {
      commonErrors: [...new Set(qualityGate.violations.map((violation) => violation.code))],
      problem: {
        type: 'alembic.recipe-content-quality.rebuild-required',
        status: 'rebuild-required',
        title: 'Recipe content quality did not meet P5 authoring constraints',
        nextAction:
          qualityGate.violations[0]?.nextAction ||
          'Rewrite the candidate so doClause/dontClause and content.markdown meet the Recipe quality contract.',
      },
      rejectedItems: qualityGate.violations.map((violation) => ({
        code: violation.code,
        field: violation.field,
        index: violation.itemIndex,
        message: violation.message,
        nextAction: violation.nextAction,
      })),
      requiredFields: getRequiredFieldsDescription(),
    },
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

function buildSubmitKnowledgeContentQualitySummary(
  qualityGate: RecipeContentQualityGateResult
): string {
  const violationCount = qualityGate.violations.length;
  const violationWord = violationCount === 1 ? 'violation' : 'violations';
  const actionableItems = qualityGate.violations
    .map((violation) => `#${violation.itemIndex} ${violation.code} → ${violation.nextAction}`)
    .join(' | ');
  return actionableItems
    ? `Recipe content quality gate failed (${violationCount} ${violationWord}): ${actionableItems}`
    : 'Recipe content quality gate failed (0 violations): rebuild candidates with English imperative do/dont clauses and ✅/❌ contrast.';
}

function buildSubmitKnowledgeEvidenceGateResponse({
  args,
  bootstrapSession,
  items,
  projectRoot,
  skipConsolidation,
}: {
  args: Record<string, unknown>;
  bootstrapSession: ReturnType<typeof resolveBootstrapSession>;
  items: Array<Record<string, unknown>>;
  projectRoot: string;
  skipConsolidation: boolean;
}) {
  if (
    !shouldRunRecipeEvidenceGate({
      args,
      items,
      session: bootstrapSession,
    })
  ) {
    return null;
  }

  const evidenceGate = validateRecipeProductionEvidenceGate({
    args,
    items,
    projectRoot,
    session: bootstrapSession,
    skipConsolidation,
  });
  if (evidenceGate.ok) {
    return null;
  }

  return envelope({
    success: false,
    errorCode: primaryEvidenceGateCode(evidenceGate),
    message: buildSubmitKnowledgeEvidenceGateSummary(evidenceGate),
    data: {
      ...buildEvidenceGateFailureData(evidenceGate),
      problem: {
        type: 'alembic.recipe-evidence-gate.rebuild-required',
        status: 'rebuild-required',
        title: 'Recipe evidence did not meet the bootstrap production floor',
        nextAction:
          evidenceGate.violations[0]?.nextAction ||
          'Repair source refs, snippets, and bootstrap session binding before resubmitting.',
      },
      requiredFields: getRequiredFieldsDescription(),
    },
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

function buildSubmitKnowledgeEvidenceGateSummary(evidenceGate: RecipeEvidenceGateResult): string {
  const violationCount = evidenceGate.violations.length;
  const violationWord = violationCount === 1 ? 'violation' : 'violations';
  const actionableItems = evidenceGate.violations
    .map((violation) => {
      const itemIndex = typeof violation.itemIndex === 'number' ? `#${violation.itemIndex}` : '#-';
      return `${itemIndex} ${violation.code} \u2192 ${violation.nextAction}`;
    })
    .join(' | ');
  return actionableItems
    ? `Recipe evidence gate failed (${violationCount} ${violationWord}): ${actionableItems}`
    : 'Recipe evidence gate failed (0 violations): rebuild the candidates with concrete source evidence.';
}

function normalizeBootstrapSessionRef(ref: string): string {
  return ref.startsWith('bootstrap-session:') ? ref.slice('bootstrap-session:'.length) : ref;
}

// ── BootstrapSession 提交追踪辅助函数 ───────────────────────

interface SessionTrackerLike {
  submissionTracker?: {
    getAllSubmittedTriggers?(): Set<string>;
    recordRejection(dimId: string, title: string, reason: string): void;
    recordSubmission(dimId: string, item: unknown, recipeId: string): void;
  };
  getProgress(): { remainingDimIds: string[] };
}

function _getSession(ctx: McpContext): { session: SessionTrackerLike; dimId: string } | null {
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    const session: SessionTrackerLike | null = sessionManager?.getSession?.();
    if (!session?.submissionTracker) {
      return null;
    }
    const progress = session.getProgress();
    return { session, dimId: progress.remainingDimIds[0] || 'unknown' };
  } catch {
    return null;
  }
}

function _trackSubmission(
  ctx: McpContext,
  item: Record<string, unknown>,
  dimensionId: string | undefined,
  recipeId: string
) {
  const s = _getSession(ctx);
  if (!s) {
    return;
  }
  try {
    const dimId = dimensionId || (item.dimensionId as string) || s.dimId;
    s.session.submissionTracker?.recordSubmission(dimId, item, recipeId);
  } catch {
    /* best effort */
  }
}

function _trackRejection(
  ctx: McpContext,
  item: Record<string, unknown>,
  dimensionId: string | undefined
) {
  const s = _getSession(ctx);
  if (!s) {
    return;
  }
  try {
    const dimId = dimensionId || (item.dimensionId as string) || s.dimId;
    s.session.submissionTracker?.recordRejection(
      dimId,
      (item.title as string) || '(untitled)',
      'validation failed'
    );
  } catch {
    /* best effort */
  }
}

function _buildPendingSemanticReviewDecision(
  review: PendingSemanticReview
): PendingSemanticReviewDecision | null {
  const newRecipeId = _resolvePendingSemanticReviewRecipeId(review);
  if (!newRecipeId) {
    return null;
  }

  return {
    newRecipeId,
    action: 'keep',
    reasoning: review.reason,
  };
}

function buildHostAgentAnalysisLinkage(
  items: Record<string, unknown>[],
  created: CreateRecipeResult['created']
): Array<{
  analysisUnitIds: string[];
  recipeId: string;
  sourceRefs: string[];
  title: string;
}> {
  const createdByTitle = new Map(created.map((entry) => [entry.title, entry]));
  const links = [];
  for (const item of items) {
    const title = typeof item.title === 'string' ? item.title : '';
    const createdRecipe = createdByTitle.get(title);
    if (!createdRecipe) {
      continue;
    }
    const analysisUnitIds = uniqueStrings([
      ...(typeof item.unitId === 'string' ? [item.unitId] : []),
      ...stringArray(item.analysisUnitIds),
    ]);
    const sourceRefs = stringArray(item.sourceRefs);
    if (analysisUnitIds.length === 0 && sourceRefs.length === 0) {
      continue;
    }
    links.push({
      recipeId: createdRecipe.id,
      title: createdRecipe.title,
      analysisUnitIds,
      sourceRefs,
    });
  }
  return links;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.filter((item) => item.trim().length > 0))];
}

function _resolvePendingSemanticReviewRecipeId(review: PendingSemanticReview): string | null {
  // Core 生产侧保证 newRecipeId；createdRecipe.id 是同一生产侧给出的稳定 created item 引用。
  const directId = review.newRecipeId?.trim();
  if (directId) {
    return directId;
  }
  const createdRecipeId = review.createdRecipe?.id.trim();
  if (createdRecipeId) {
    return createdRecipeId;
  }
  return null;
}
