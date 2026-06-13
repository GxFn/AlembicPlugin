/**
 * MCP Tool Router — 参数路由层
 *
 * 将多模式工具（alembic_search / knowledge / structure / graph / guard / skill）
 * 按 operation / mode 参数路由到已有 handler 实现。
 *
 * 不包含业务逻辑，仅做参数解构 → 路由 → 转发。
 *
 * alembic_bootstrap 已迁移到 host-agent/bootstrap.js（宿主 Agent 路径）。
 */

import { dimensionTags } from '@alembic/core/dimensions';
import type { CreateRecipeResult } from '@alembic/core/knowledge';
import { getRequiredFieldsDescription } from '@alembic/core/knowledge';
import { getDeveloperIdentity } from '@alembic/core/shared';
import { resolveHostAgentDataRoot } from '#codex/mcp/host-agent-workflows/project-data-root.js';
import {
  buildEvidenceGateFailureData,
  primaryEvidenceGateCode,
  resolveBootstrapSession,
  shouldRunRecipeEvidenceGate,
  validateRecipeProductionEvidenceGate,
} from '#codex/mcp/host-agent-workflows/recipe-evidence-gate.js';
import {
  CODEX_HOST_AGENT_SOURCE,
  normalizeCodexHostAgentWriteSource,
} from '#codex/SourceBoundary.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import * as browseHandlers from '../../../runtime/mcp/handlers/browse.js';
import * as guardHandlers from '../../../runtime/mcp/handlers/guard.js';
import * as projectMatrixHandlers from '../../../runtime/mcp/handlers/project-matrix.js';
import * as searchHandlers from '../../../runtime/mcp/handlers/search.js';
import * as skillHandlers from '../../../runtime/mcp/handlers/skill.js';
import * as structureHandlers from '../../../runtime/mcp/handlers/structure.js';
import type {
  McpContext,
  ToolRouterGraphArgs,
  ToolRouterGuardArgs,
  ToolRouterKnowledgeArgs,
  ToolRouterSearchArgs,
  ToolRouterSkillArgs,
  ToolRouterStructureArgs,
} from '../../../runtime/mcp/handlers/types.js';

type PendingSemanticReview = NonNullable<CreateRecipeResult['pendingSemanticReview']>[number];

interface PendingSemanticReviewDecision {
  action: 'keep';
  newRecipeId: string;
  reasoning: string;
}

// ─── alembic_search (mode router) ────────────────────────

export async function routeProjectMatrixTool(ctx: McpContext, args: Record<string, unknown>) {
  return projectMatrixHandlers.projectMatrix(ctx, args);
}

/**
 * 搜索工具路由：根据 mode 参数路由到对应搜索 handler
 *   auto (默认) → search()
 *   keyword     → keywordSearch()
 *   semantic    → semanticSearch()
 *   context     → contextSearch()
 */
export async function routeSearchTool(ctx: McpContext, args: ToolRouterSearchArgs) {
  const mode = args.mode || 'auto';
  switch (mode) {
    case 'keyword':
      return searchHandlers.keywordSearch(ctx, args);
    case 'semantic':
      return searchHandlers.semanticSearch(ctx, args);
    case 'context':
      return searchHandlers.contextSearch(ctx, args);
    default:
      return searchHandlers.search(ctx, { ...args, mode });
  }
}

// ─── alembic_knowledge (operation router) ─────────────────────

/**
 * 知识浏览：根据 operation 参数路由
 *   list (默认) → listByKind() 或 listRecipes()
 *   get          → getRecipe()
 *   insights     → recipeInsights()
 *   confirm_usage → confirmUsage()
 */
export async function routeKnowledgeTool(ctx: McpContext, args: ToolRouterKnowledgeArgs) {
  const op = args.operation || 'list';
  switch (op) {
    case 'list': {
      const kind = args.kind;
      if (kind && kind !== 'all') {
        return browseHandlers.listByKind(ctx, kind, args);
      }
      return browseHandlers.listRecipes(ctx, args);
    }
    case 'get':
      return browseHandlers.getRecipe(ctx, args);
    case 'insights':
      return browseHandlers.recipeInsights(ctx, args);
    case 'confirm_usage':
      // confirmUsage expects { recipeId, usageType, feedback }
      // 适配：如果传了 id 但没传 recipeId，自动映射
      if (args.id && !args.recipeId) {
        args.recipeId = args.id;
      }
      return browseHandlers.confirmUsage(ctx, args);
    default:
      throw new Error(
        `Unknown knowledge operation: ${op}. Expected: list, get, insights, confirm_usage`
      );
  }
}

// ─── alembic_structure (operation router) ─────────────────────

/**
 * 项目结构：根据 operation 参数路由
 *   targets (默认) → getTargets()
 *   files          → getTargetFiles()
 *   metadata       → getTargetMetadata()
 */
export async function routeStructureTool(ctx: McpContext, args: ToolRouterStructureArgs) {
  const op = args.operation || 'targets';
  switch (op) {
    case 'targets':
      return structureHandlers.getTargets(ctx, args);
    case 'files':
      return structureHandlers.getTargetFiles(ctx, args);
    case 'metadata':
      return structureHandlers.getTargetMetadata(ctx, args);
    default:
      throw new Error(`Unknown structure operation: ${op}. Expected: targets, files, metadata`);
  }
}

// ─── alembic_call_context (Phase 5) ─────────────────────

/** 调用链上下文查询：直接转发到 structure.callContext */
export async function routeCallContextTool(ctx: McpContext, args: ToolRouterStructureArgs) {
  return structureHandlers.callContext(ctx, args);
}

// ─── alembic_graph (operation router) ─────────────────────────

/**
 * 项目图谱：根据 operation 参数路由
 *   query        → graphQuery()
 *   impact       → graphImpact()
 *   path         → graphPath()
 *   stats        → graphStats()
 *   neighborhood → graphNeighborhood()
 */
export async function routeGraphTool(ctx: McpContext, args: ToolRouterGraphArgs) {
  const op = args.operation || 'query';
  switch (op) {
    case 'query':
      return structureHandlers.graphQuery(ctx, args);
    case 'impact':
      return structureHandlers.graphImpact(ctx, args);
    case 'path':
      return structureHandlers.graphPath(ctx, args);
    case 'stats':
      return structureHandlers.graphStats(ctx, args);
    case 'neighborhood':
      return structureHandlers.graphNeighborhood(ctx, args);
    default:
      throw new Error(
        `Unknown graph operation: ${op}. Expected: query, impact, path, stats, neighborhood`
      );
  }
}

// ─── alembic_guard (input router) ─────────────────────────

/**
 * Guard 检查：按参数自动路由
 *   operation: 'coverage_matrix'    → guardCoverageMatrix()    (模块覆盖率矩阵)
 *   operation: 'compliance_report'  → guardComplianceReport()  (3D 合规报告)
 *   无参数       → blocked          (旧 whole-diff fallback 已禁用)
 *   有 files     → guardReview()    (指定文件 + inline recipe) — files 为 string[] 或 {path}[]
 *   有 code      → guardCheck()     (单文件内联检查)
 */
export async function routeGuardTool(ctx: McpContext, args: ToolRouterGuardArgs) {
  // operation 显式路由
  if (args.operation === 'coverage_matrix') {
    return guardHandlers.guardCoverageMatrix(ctx, args);
  }
  if (args.operation === 'compliance_report') {
    return guardHandlers.guardComplianceReport(ctx, args);
  }
  // 有 code → 单文件检查（旧模式）
  if (args.code) {
    return guardHandlers.guardCheck(ctx, args);
  }
  // 有 files（string[] 或 {path}[]）→ review 模式；无参数由 handler 返回结构化 blocker。
  return guardHandlers.guardReview(ctx, args);
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
  const { RecipeProductionGateway } = await import('@alembic/core/knowledge');
  const { findSimilarRecipes } = await import('@alembic/core/service/candidate');

  const items = args.items as Record<string, unknown>[] | undefined;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return envelope({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'items 数组是必需的且不能为空。请传入 items: [{ title, language, ... }]',
      meta: { tool: 'alembic_submit_knowledge' },
    });
  }

  const skipConsolidation = (args.skipConsolidation as boolean) === true;
  const source = normalizeCodexHostAgentWriteSource(args.source);
  const dimensionId = args.dimensionId as string | undefined;
  const bootstrapSessionId =
    typeof args.sessionId === 'string'
      ? args.sessionId
      : typeof args.bootstrapSessionRef === 'string'
        ? args.bootstrapSessionRef
        : undefined;
  const clientId = args.client_id as string | undefined;
  const supersedes = args.supersedes as string | undefined;

  // ── Step 1: 限流 ──
  const { checkRecipeSave } = await import('#http/middleware/RateLimiter.js');
  const { resolveProjectRoot } = await import('@alembic/core/workspace');
  const projectRoot = resolveProjectRoot(ctx.container);
  const limitCheck = checkRecipeSave(projectRoot, clientId || process.env.USER || 'mcp-client');
  if (!limitCheck.allowed) {
    return envelope({
      success: false,
      message: `提交过于频繁，请 ${limitCheck.retryAfter}s 后再试。`,
      errorCode: 'RATE_LIMIT',
      meta: { tool: 'alembic_submit_knowledge' },
    });
  }

  // ── Step 2: MCP 特有预处理 ──
  // 注入批次级选项到各条目
  for (const item of items) {
    item.source = normalizeCodexHostAgentWriteSource(item.source || source);
    if (dimensionId && !item.dimensionId) {
      item.dimensionId = dimensionId;
    }
    if (item.dimensionId && typeof item.dimensionId === 'string') {
      const existingTags = Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      item.tags = dimensionTags(item.dimensionId, existingTags);
    }
  }

  const bootstrapSession = resolveBootstrapSession(ctx.container, bootstrapSessionId);
  const dataRoot = resolveHostAgentDataRoot(
    ctx.container,
    bootstrapSession?.projectRoot || projectRoot
  );
  const evidenceGateResponse = buildSubmitKnowledgeEvidenceGateResponse({
    args,
    bootstrapSession,
    items,
    projectRoot,
    skipConsolidation,
  });
  if (evidenceGateResponse) {
    return evidenceGateResponse;
  }

  // 获取 bootstrapSession 已提交标题用于跨维度去重
  let existingTitles: Set<string> | undefined;
  let existingTriggers: Set<string> | undefined;
  try {
    const bsSession = bootstrapSession;
    if (bsSession?.submissionTracker?.getAllSubmittedTitles) {
      existingTitles = bsSession.submissionTracker.getAllSubmittedTitles();
    }
    if (bsSession?.submissionTracker?.getAllSubmittedTriggers) {
      existingTriggers = bsSession.submissionTracker.getAllSubmittedTriggers();
    }
  } catch {
    /* best effort */
  }

  // ── Step 3: 委托 RecipeProductionGateway 统一管道 ──
  const knowledgeService = ctx.container.get('knowledgeService');
  let consolidationAdvisor = null;
  try {
    consolidationAdvisor = ctx.container.get('consolidationAdvisor');
  } catch {
    /* not registered */
  }
  let proposalRepository = null;
  try {
    proposalRepository = ctx.container.get('proposalRepository');
  } catch {
    /* not registered */
  }
  let evolutionGateway = null;
  try {
    evolutionGateway = ctx.container.get('evolutionGateway');
  } catch {
    /* not registered */
  }

  const gateway = new RecipeProductionGateway({
    knowledgeService,
    projectRoot: dataRoot,
    consolidationAdvisor: consolidationAdvisor ?? null,
    proposalRepository: proposalRepository ?? null,
    evolutionGateway: evolutionGateway ?? null,
    findSimilarRecipes,
  });

  const gatewayResult = await gateway.create({
    source: CODEX_HOST_AGENT_SOURCE,
    items: items as import('@alembic/core/knowledge').CreateRecipeItem[],
    options: {
      skipConsolidation,
      supersedes,
      existingTitles,
      existingTriggers,
      userId: getDeveloperIdentity(),
    },
  });

  // ── Step 4: Bootstrap session 追踪 ──
  for (const created of gatewayResult.created) {
    _trackSubmission(
      ctx,
      items.find((it) => it.title === created.title) || {},
      dimensionId,
      created.id
    );
  }
  for (const rej of gatewayResult.rejected) {
    const item = items[rej.index] || {};
    _trackRejection(ctx, item, dimensionId);
  }

  // ── Step 5: 构建统一响应 ──
  const successCount = gatewayResult.created.length;
  const data: Record<string, unknown> = {
    count: successCount,
    total: items.length,
  };

  if (gatewayResult.created.length > 0) {
    data.ids = gatewayResult.created.map((c) => c.id);
  }
  const ideAgentAnalysisLinkage = buildIDEAgentAnalysisLinkage(items, gatewayResult.created);
  if (ideAgentAnalysisLinkage.length > 0) {
    data.ideAgentAnalysisLinkage = {
      links: ideAgentAnalysisLinkage,
      message:
        'Optional IDEAgentAnalysisUnit linkage was accepted for host-agent progress backfill; submissions without unitId remain valid.',
    };
  }

  if (gatewayResult.rejected.length > 0) {
    const rejectedItems = gatewayResult.rejected.map((r) => ({
      index: r.index,
      title: r.title,
      errors: r.errors,
      warnings: r.warnings,
    }));
    const allMissing = [...new Set(rejectedItems.flatMap((it) => it.errors))];
    data.rejectedItems = rejectedItems;
    data.rejectedSummary = {
      rejectedCount: rejectedItems.length,
      commonErrors: allMissing,
      message: `${rejectedItems.length}/${items.length} 条知识条目因校验未通过被拒绝。`,
    };
  }

  if (gatewayResult.blocked.length > 0) {
    data.blockedItems = gatewayResult.blocked;
    data.blockedSummary = {
      blockedCount: gatewayResult.blocked.length,
      message: `${gatewayResult.blocked.length} 条因融合分析被阻塞（与已有 Recipe 重叠或实质性不足）。设 skipConsolidation: true 可跳过。`,
    };
  }

  const createdProposals: unknown[] = [];
  for (const m of gatewayResult.merged) {
    createdProposals.push({
      proposalId: m.proposalId,
      type: m.type,
      targetRecipe: { id: m.targetRecipeId, title: m.targetTitle },
      status: m.status,
      expiresAt: m.expiresAt,
      message: m.message,
    });
  }

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

  if (createdProposals.length > 0) {
    data.proposals = createdProposals;
    data.proposalSummary = {
      proposalCount: createdProposals.length,
      message: `${createdProposals.length} 条已创建进化提案，系统将在观察窗口到期后自动执行。无需额外操作。`,
    };
  }

  // ── pendingSemanticReview → nextAction tail instruction ──
  if (gatewayResult.pendingSemanticReview && gatewayResult.pendingSemanticReview.length > 0) {
    const reviewActions = gatewayResult.pendingSemanticReview.map((review) => ({
      review,
      decision: _buildPendingSemanticReviewDecision(review),
    }));
    const decisions = reviewActions
      .map((entry) => entry.decision)
      .filter((decision): decision is PendingSemanticReviewDecision => decision !== null);
    const missingRecipeId = reviewActions
      .filter((entry) => entry.decision === null)
      .map((entry) => ({
        index: entry.review.index,
        title: entry.review.title,
        reason: entry.review.reason,
      }));

    data.pendingSemanticReview = gatewayResult.pendingSemanticReview;
    if (decisions.length > 0) {
      data.nextAction = {
        tool: 'alembic_consolidate',
        args: {
          decisions,
        },
        required: false,
        reason:
          `${decisions.length} 条候选处于相似度模糊区间（0.4-0.65），` +
          `字段分析不明确，建议阅读源代码后调用 alembic_consolidate 判断是否需要合并。`,
      };
    }
    if (missingRecipeId.length > 0) {
      data.nextActionBlocked = {
        tool: 'alembic_consolidate',
        blockedCount: missingRecipeId.length,
        missingRecipeId,
        reason:
          `Core 未返回 pendingSemanticReview[].newRecipeId 或 createdRecipe.id，` +
          `Plugin 不会猜测新 Recipe ID，也不会生成不可执行的 consolidate 指令。`,
      };
    }
  }

  // 全部拒绝 → 特殊错误响应
  if (successCount === 0 && gatewayResult.rejected.length === items.length) {
    const allMissing = [...new Set(gatewayResult.rejected.flatMap((it) => it.errors))];
    return envelope({
      success: false,
      errorCode: 'INCOMPLETE_SUBMISSION',
      message: `全部 ${items.length} 条知识条目被拒绝。请在单次调用中补齐所有字段后重新提交。`,
      data: {
        rejectedItems: data.rejectedItems,
        requiredFields: getRequiredFieldsDescription(),
        commonErrors: allMissing,
      },
      meta: { tool: 'alembic_submit_knowledge' },
    });
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
    message:
      'Recipe evidence gate failed before persistence. Rebuild the rejected candidates with concrete source evidence.',
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

function buildIDEAgentAnalysisLinkage(
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
