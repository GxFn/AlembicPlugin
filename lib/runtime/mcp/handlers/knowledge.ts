/**
 * MCP Handlers — V3 知识条目提交 & 生命周期
 * submitKnowledge, submitKnowledgeBatch, knowledgeLifecycle
 */

import { dimensionTags } from '@alembic/core/dimensions';
import {
  DEPTH_DIMENSIONS,
  resolveGroundedSourcePaths,
  reviewRecipeDepth,
  UnifiedValidator,
} from '@alembic/core/knowledge';
import { getDeveloperIdentity } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { normalizeHostAgentWriteSource } from '#codex/SourceBoundary.js';
import { createSourceRefResolver } from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import type { McpContext, McpServiceContainer } from '../../../runtime/mcp/handlers/types.js';

// ─── 限流 ──────────────────────────────────────────────────

async function _checkRateLimit(
  toolName: string,
  clientId: string | undefined,
  container?: Parameters<typeof resolveProjectRoot>[0]
) {
  const { checkRecipeSave } = await import('../RateLimiter.js');
  const projectRoot = resolveProjectRoot(container);
  const limitCheck = checkRecipeSave(projectRoot, clientId || process.env.USER || 'mcp-client');
  if (!limitCheck.allowed) {
    return envelope({
      success: false,
      message: `提交过于频繁，请 ${limitCheck.retryAfter}s 后再试。`,
      errorCode: 'RATE_LIMIT',
      meta: { tool: toolName },
    });
  }
  return null;
}

// ─── V3 字段增强 ────────────────────────────────────────────

/**
 * 将 MCP wire format 增强为 V3 KnowledgeEntry 数据：
 *   - 确保 Codex/宿主 Agent 新写入 source 为 'host-agent'
 *   - RecipeExtractor 语义标签（程序化）
 *   - 其余 V3 字段由调用方生成，缺失即留空（KnowledgeEntry 构造函数填默认值）
 *
 * 注意: QualityScorer 评分已统一为 KnowledgeService.create() 后置执行 (R9)。
 * _enrichToV3 不再内联 QualityScorer，避免外部路径双重评分。
 */
interface EnrichInput {
  source?: string;
  title?: string;
  language?: string;
  tags?: string[];
  category?: string;
  dimensionId?: string;
  content?: { pattern?: string; [key: string]: unknown };
  [key: string]: unknown;
}

function _enrichToV3(args: EnrichInput, container: McpServiceContainer | null): EnrichInput {
  const data: EnrichInput = { ...args };

  // 来源标记（非调用方职责）
  data.source = normalizeHostAgentWriteSource(data.source);

  // RecipeExtractor 语义标签（程序化）
  try {
    const recipeExtractor = container?.get?.('recipeExtractor');
    if (recipeExtractor) {
      const codeForTags = data.content?.pattern || '';
      if (codeForTags) {
        const extracted = recipeExtractor.extractFromContent(
          codeForTags,
          `${data.title || 'unknown'}.${data.language || 'unknown'}`,
          ''
        );
        if (extracted.semanticTags?.length > 0) {
          data.tags = [...new Set([...(data.tags || []), ...extracted.semanticTags])];
        }
        if (
          (!data.category || data.category === 'Utility') &&
          extracted.category &&
          extracted.category !== 'general'
        ) {
          data.category = extracted.category;
        }
      }
    }
  } catch {
    /* best effort */
  }

  if (data.dimensionId) {
    data.tags = dimensionTags(data.dimensionId, data.tags || []);
  }

  return data;
}

// ─── V3 wire format → KnowledgeService.create() ────────────

/**
 * 单条知识提交 (alembic_submit_knowledge)
 *
 * MCP wire format → V3 增强 → KnowledgeService.create()
 * 增强包括：source='host-agent'、reasoning 默认值、插件适配字段补齐、QualityScorer、语义标签。
 */
/** P4/C11: 从可能非数组的值安全取 string[]（用于喂 reviewRecipeDepth 的结构化深度字段）。 */
function _stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

/**
 * P4/C11: 计算 recipe 的深度接地缺口（纯 guidance，非 gate——不拒绝提交、不倒 floor）。与 in-process
 * retry(C9)对称：都用 Core `reviewRecipeDepth` 判定「哪些深度维度缺真实 file:line 接地」。接地集经与门禁
 * 同一 `createSourceRefResolver` + `resolveGroundedSourcePaths` 重算，只认真解析成功的 refs。缺口只报维度名，
 * 绝不提示补写具体内容（防诱导编造）。best-effort：任何解析/fs 异常都吞掉返回 null，不阻塞提交。
 */
function _computeDepthGaps(
  args: Record<string, unknown>,
  container: McpServiceContainer
): Record<string, unknown> | null {
  try {
    const projectRoot = resolveProjectRoot(container);
    const { validSourcePaths } = resolveGroundedSourcePaths(args, {
      sourceRefResolver: createSourceRefResolver(),
      projectRoot,
    });
    const content = (args.content ?? {}) as Record<string, unknown>;
    const constraints = (args.constraints ?? {}) as Record<string, unknown>;
    const reasoning = (args.reasoning ?? {}) as Record<string, unknown>;
    const verification =
      content.verification && typeof content.verification === 'object'
        ? Object.values(content.verification as Record<string, unknown>)
            .filter((v): v is string => typeof v === 'string')
            .join('\n')
        : undefined;
    const review = reviewRecipeDepth(
      {
        markdown: typeof content.markdown === 'string' ? content.markdown : '',
        boundaries: _stringArray(constraints.boundaries),
        preconditions: _stringArray(constraints.preconditions),
        sideEffects: _stringArray(constraints.sideEffects),
        verification,
        alternatives: _stringArray(reasoning.alternatives),
      },
      { validSourcePaths }
    );
    // 深度已足够接地(无缺失维度、无未接地论述)就不打扰。
    if (review.missing.length === 0 && review.ungroundedClaims.length === 0) {
      return null;
    }
    const labelOf = (key: string): string =>
      DEPTH_DIMENSIONS.find((d) => d.key === key)?.label ?? key;
    return {
      groundedDimensions: review.grounded.map(labelOf),
      missingDimensions: review.missing.map(labelOf),
      ungroundedClaims: review.ungroundedClaims,
      groundedFileCount: review.groundedFileCount,
      note: '深度缺口仅供参考，不影响提交。缺接地的维度请回代码重挖真实 file:line，勿凭空补写。',
    };
  } catch {
    return null;
  }
}

export async function submitKnowledge(
  ctx: McpContext,
  args: Record<string, unknown> & { client_id?: string }
) {
  // 限流
  const blocked = await _checkRateLimit('alembic_submit_knowledge', args.client_id, ctx.container);
  if (blocked) {
    return blocked;
  }

  // Recipe-Ready 前置校验 — 使用 UnifiedValidator (统一门控)
  // 注意: 必须在 service.create() 之前校验，防止不合格数据入库
  const validator = new UnifiedValidator();
  const validation = validator.validate(args, { skipUniqueness: true });

  const service = ctx.container.get('knowledgeService');

  // V3 字段增强
  const enrichedData = _enrichToV3(args, ctx.container);

  const entry = await service.create(enrichedData, { userId: getDeveloperIdentity() });

  // ── QualityScorer 自动评分（R9: create 后置执行）──
  try {
    await service.updateQuality(entry.id, { userId: 'mcp' });
  } catch {
    /* best effort — 不阻塞创建流程 */
  }

  const data: Record<string, unknown> = {
    id: entry.id,
    lifecycle: entry.lifecycle,
    title: entry.title,
    kind: entry.kind,
  };

  if (!validation.pass) {
    data.recipeReadyHints = {
      ready: false,
      missingFields: validation.errors,
      suggestions: validation.warnings,
    };
  } else if (validation.warnings.length > 0) {
    data.recipeReadyHints = {
      ready: true,
      missingFields: [],
      suggestions: validation.warnings,
    };
  }

  // P4/C11: 深度接地缺口反馈——host 唯一 per-submit 反馈点，与 in-process retry 对称。纯 guidance：
  // 不改 validation.pass、不拒绝提交，只在已解析证据不足以覆盖深度维度时挂一个 depthGaps 提示。
  const depthGaps = _computeDepthGaps(args, ctx.container);
  if (depthGaps) {
    const hints = (data.recipeReadyHints ?? {
      ready: validation.pass,
      missingFields: [],
      suggestions: [],
    }) as Record<string, unknown>;
    hints.depthGaps = depthGaps;
    data.recipeReadyHints = hints;
  }

  return envelope({
    success: true,
    data,
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

/**
 * 知识条目生命周期操作 (alembic_knowledge_lifecycle)
 *
 * 简化为 3 状态: pending / active / deprecated
 * 宿主 Agent 允许 reactivate（废弃 → 待审核）；发布/废弃由开发者在 Dashboard 操作
 * 宿主 Agent 也可以通过 submitKnowledge / submitKnowledgeBatch 提交新条目（→ pending）
 */
const MCP_ALLOWED_LIFECYCLE_ACTIONS = new Set(['reactivate']);

export async function knowledgeLifecycle(
  ctx: McpContext,
  args: { id?: string; action?: string; [key: string]: unknown }
) {
  const { id, action } = args;
  if (!id || !action) {
    throw new Error('需要 id 和 action');
  }

  if (!MCP_ALLOWED_LIFECYCLE_ACTIONS.has(action)) {
    throw new Error(
      `[PERMISSION_DENIED] 宿主 Agent 不允许执行 "${action}" 操作，仅支持: reactivate。发布、废弃等操作请在 Dashboard 中完成。提交新知识请使用 alembic_submit_knowledge 工具。`
    );
  }

  const service = ctx.container.get('knowledgeService');
  const context = { userId: getDeveloperIdentity() };

  const entry = await service.reactivate(id, context);

  return envelope({
    success: true,
    data: {
      id: entry.id,
      lifecycle: entry.lifecycle,
      title: entry.title,
      action,
    },
    meta: { tool: 'alembic_knowledge_lifecycle' },
  });
}

// ─── (已删除: saveDocument — 已合并到 submit_knowledge 统一管线) ──
// ─── (已删除: _toReadinessInput — 统一使用 UnifiedValidator) ──
