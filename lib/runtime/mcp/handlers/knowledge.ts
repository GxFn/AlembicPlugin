/**
 * MCP Handlers — 知识条目生命周期(alembic_knowledge_lifecycle)。
 *
 * S3 收严(2026-07-02 用户决策)：本文件旧 submitKnowledge 及其私有 helper
 * (_checkRateLimit/_enrichToV3/_computeDepthGaps)已删除——它是零调用方死代码
 * (McpServer 的 alembic_submit_knowledge 走 tool-router.routeSubmitKnowledgeTool
 * 统一硬门管线),且其 UnifiedValidator 校验不拦截(pass=false 仍落库、仅挂 hints),
 * 与硬门语义冲突;保留只会给未来接线者留一条绕过门禁的旁路。
 */

import { getDeveloperIdentity } from '@alembic/core/shared';
import { envelope } from '../../../runtime/mcp/envelope.js';
import type { McpContext } from '../../../runtime/mcp/handlers/types.js';

/**
 * 知识条目生命周期操作 (alembic_knowledge_lifecycle)
 *
 * 简化为 3 状态: pending / active / deprecated
 * 宿主 Agent 允许 reactivate（废弃 → 待审核）；发布/废弃由开发者在 Dashboard 操作
 * 宿主 Agent 提交新条目走 alembic_submit_knowledge(tool-router 统一硬门管线)（→ pending）
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
