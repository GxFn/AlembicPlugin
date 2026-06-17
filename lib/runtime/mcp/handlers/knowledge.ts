/**
 * MCP Handlers — V3 知识条目提交 & 生命周期
 * submitKnowledge, submitKnowledgeBatch, knowledgeLifecycle
 */

import { dimensionTags } from '@alembic/core/dimensions';
import { UnifiedValidator } from '@alembic/core/knowledge';
import { getDeveloperIdentity } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { normalizeCodexHostAgentWriteSource } from '#codex/SourceBoundary.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import type { McpContext, McpServiceContainer } from '../../../runtime/mcp/handlers/types.js';

// ─── 限流 ──────────────────────────────────────────────────

async function _checkRateLimit(
  toolName: string,
  clientId: string | undefined,
  container?: Parameters<typeof resolveProjectRoot>[0]
) {
  const { checkRecipeSave } = await import('#http/middleware/RateLimiter.js');
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
  data.source = normalizeCodexHostAgentWriteSource(data.source);

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
