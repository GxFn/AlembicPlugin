/**
 * Candidates API 路由
 * 候选条目的 AI 补齐、润色预览/应用
 */

import Logger from '@alembic/core/logging';
import { ValidationError } from '@alembic/core/shared';
import express, { type Request, type Response } from 'express';
import {
  BootstrapRefineBody,
  EnrichBody,
  RefineApplyBody,
  RefinePreviewBody,
} from '#shared/schemas/http-requests.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ═══ AI 语义字段补齐 ════════════════════════════════════ */

/**
 * POST /api/v1/candidates/enrich
 * 对若干候选条目进行 AI 语义字段补全
 * Body: { candidateIds: string[] }
 */
router.post('/enrich', validate(EnrichBody), async (req: Request, res: Response): Promise<void> => {
  const { candidateIds } = req.body;

  res.json({
    success: true,
    data: {
      enriched: 0,
      total: candidateIds.length,
      hostManaged: true,
      unavailable: true,
      message: 'AlembicPlugin 不再执行候选 AI 补齐；请由宿主 agent 或外部编排提交补齐结果。',
      results: candidateIds.map((id: string) => ({
        id,
        enriched: false,
        skipped: true,
        reason: 'HOST_AI_MANAGED',
      })),
    },
  });
});

/* ═══ Bootstrap 内容润色 ═════════════════════════════════ */

/**
 * POST /api/v1/candidates/bootstrap-refine
 * AI 内容润色（适用于 Bootstrap 产出的批量候选）
 * Body: { candidateIds?: string[], userPrompt?: string, dryRun?: boolean }
 */
router.post(
  '/bootstrap-refine',
  validate(BootstrapRefineBody),
  async (req: Request, res: Response) => {
    const { candidateIds, userPrompt, dryRun } = req.body;
    res.status(501).json({
      success: false,
      error: {
        code: 'HOST_AI_MANAGED',
        message:
          'Bootstrap 候选润色已从 AlembicPlugin 删除；请由宿主 agent 生成 preview 后再调用 apply。',
      },
      data: {
        candidateIds,
        dryRun: Boolean(dryRun),
        hasUserPrompt: Boolean(userPrompt),
        hostManaged: true,
      },
    });
  }
);

/* ═══ 对话式润色 — 工具函数 ═══════════════════════════════ */

/**
 * 从 KnowledgeEntry 提取前端 DiffView 所需的 before 字段
 * 与前端 extractBefore() 保持一致
 */
function extractBeforeFields(json: Record<string, unknown>) {
  return {
    title: json.title || '',
    description: json.description || '',
    pattern: (json.content as Record<string, unknown>)?.pattern || '',
    markdown: (json.content as Record<string, unknown>)?.markdown || '',
    rationale: (json.content as Record<string, unknown>)?.rationale || '',
    tags: json.tags || [],
    confidence: (json.reasoning as Record<string, unknown>)?.confidence ?? 0.6,
    relations: json.relations || {},
    aiInsight: json.aiInsight || null,
    agentNotes: json.agentNotes || null,
  };
}

/** 将宿主返回的润色 preview 合并到 before 上生成 after，并构造 knowledgeService.update() 所需的 updateData */
function buildUpdateFromRefineResult(
  before: Record<string, unknown>,
  parsed: Record<string, unknown>
) {
  // ─── key 别名归一化：AI 可能返回不精确的 key，统一映射到标准 key ───
  const KEY_ALIASES = {
    // description 别名
    summary: 'description',
    desc: 'description',
    摘要: 'description',
    描述: 'description',
    // pattern 别名
    content: 'pattern',
    designPattern: 'pattern',
    内容: 'pattern',
    代码: 'pattern',
    标准用法: 'pattern',
    // markdown 别名
    markdownDoc: 'markdown',
    Markdown文档: 'markdown',
    文档: 'markdown',
    doc: 'markdown',
    // rationale 别名
    design: 'rationale',
    设计原理: 'rationale',
    原理: 'rationale',
    design_rationale: 'rationale',
    designRationale: 'rationale',
    // tags 别名
    tag: 'tags',
    label: 'tags',
    labels: 'tags',
    标签: 'tags',
    // confidence 别名
    score: 'confidence',
    置信度: 'confidence',
    评分: 'confidence',
    // aiInsight 别名
    ai_insight: 'aiInsight',
    insight: 'aiInsight',
    aiinsight: 'aiInsight',
    洞察: 'aiInsight',
    // agentNotes 别名
    agent_notes: 'agentNotes',
    notes: 'agentNotes',
    agentnotes: 'agentNotes',
    笔记: 'agentNotes',
    // relations 别名
    relation: 'relations',
    关联: 'relations',
    关联关系: 'relations',
  };

  const VALID_KEYS = new Set([
    'description',
    'pattern',
    'markdown',
    'rationale',
    'tags',
    'confidence',
    'aiInsight',
    'agentNotes',
    'relations',
  ]);
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (VALID_KEYS.has(key)) {
      normalized[key] = value;
    } else {
      const mapped =
        (KEY_ALIASES as Record<string, string>)[key] ||
        (KEY_ALIASES as Record<string, string>)[key.toLowerCase()];
      if (mapped && !(mapped in normalized)) {
        normalized[mapped] = value;
      }
    }
  }

  // 确保未返回的字段保留 before 值
  for (const k of VALID_KEYS) {
    if (!(k in normalized)) {
      normalized[k] = before[k];
    }
  }

  const after = { ...before };
  const updateData: Record<string, unknown> = {};
  let changed = false;

  if (normalized.description != null && normalized.description !== before.description) {
    after.description = normalized.description;
    updateData.description = normalized.description;
    changed = true;
  }
  if (normalized.pattern != null && normalized.pattern !== before.pattern) {
    after.pattern = normalized.pattern;
    updateData._patternChanged = normalized.pattern;
    changed = true;
  }
  if (normalized.markdown != null && normalized.markdown !== before.markdown) {
    after.markdown = normalized.markdown;
    updateData._markdownChanged = normalized.markdown;
    changed = true;
  }
  if (normalized.rationale != null && normalized.rationale !== before.rationale) {
    after.rationale = normalized.rationale;
    updateData._rationaleChanged = normalized.rationale;
    changed = true;
  }
  if (normalized.tags != null && Array.isArray(normalized.tags)) {
    const newTags = JSON.stringify(normalized.tags);
    if (newTags !== JSON.stringify(before.tags)) {
      after.tags = normalized.tags;
      updateData.tags = normalized.tags;
      changed = true;
    }
  }
  if (typeof normalized.confidence === 'number' && normalized.confidence !== before.confidence) {
    after.confidence = normalized.confidence;
    updateData._confidenceChanged = normalized.confidence;
    changed = true;
  }
  if (normalized.aiInsight !== undefined && normalized.aiInsight !== before.aiInsight) {
    after.aiInsight = normalized.aiInsight;
    updateData.aiInsight = normalized.aiInsight;
    changed = true;
  }
  if (normalized.agentNotes !== undefined) {
    const newNotes = JSON.stringify(normalized.agentNotes);
    if (newNotes !== JSON.stringify(before.agentNotes)) {
      after.agentNotes = normalized.agentNotes;
      updateData.agentNotes = normalized.agentNotes;
      changed = true;
    }
  }
  if (normalized.relations !== undefined) {
    const newRels = JSON.stringify(normalized.relations);
    if (newRels !== JSON.stringify(before.relations)) {
      after.relations = normalized.relations;
      updateData.relations = normalized.relations;
      changed = true;
    }
  }

  return { after, updateData, changed };
}

/* ═══ 对话式润色 — 预览 ══════════════════════════════════ */

/**
 * POST /api/v1/candidates/refine-preview
 * 插件模式不再执行本地 AI 润色；返回 before 原文和 host-managed 边界信息。
 * Body: { candidateId: string, userPrompt: string }
 */
router.post('/refine-preview', validate(RefinePreviewBody), async (req: Request, res: Response) => {
  const { candidateId, userPrompt } = req.body;

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  const entry = await knowledgeService.get(candidateId);
  if (!entry) {
    throw new ValidationError('Candidate not found');
  }
  const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
  const before = extractBeforeFields(json as Record<string, unknown>);

  res.status(501).json({
    success: false,
    error: {
      code: 'HOST_AI_MANAGED',
      message: '候选润色预览已从 AlembicPlugin 删除；请由宿主 agent 生成 preview。',
    },
    data: {
      candidateId,
      before,
      after: before,
      preview: null,
      hasUserPrompt: Boolean(userPrompt?.trim()),
      hostManaged: true,
    },
  });
});

/* ═══ 对话式润色 — 流式预览 (SSE) ═══════════════════════ */

/**
 * POST /api/v1/candidates/refine-preview-stream
 * 插件模式不再执行本地 AI 润色流。
 *
 * Body: { candidateId: string, userPrompt: string }
 */
router.post(
  '/refine-preview-stream',
  validate(RefinePreviewBody),
  async (req: Request, res: Response) => {
    const { candidateId, userPrompt } = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');

    const entry = await knowledgeService.get(candidateId);
    if (!entry) {
      throw new ValidationError('Candidate not found');
    }
    const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
    const before = extractBeforeFields(json as Record<string, unknown>);

    res.status(501).json({
      success: false,
      error: {
        code: 'HOST_AI_MANAGED',
        message: '候选流式润色预览已从 AlembicPlugin 删除；请由宿主 agent 生成 preview。',
      },
      data: {
        candidateId,
        before,
        after: before,
        preview: null,
        hasUserPrompt: Boolean(userPrompt?.trim()),
        hostManaged: true,
      },
    });
  }
);

/**
 * GET /api/v1/candidates/refine-preview/events/:sessionId
 * EventSource SSE 端点 — 消费润色预览进度事件
 *
 * 复用 scan/events 相同的 SSE 交付模式：回放缓冲 → 订阅实时 → 心跳保活
 */
router.get('/refine-preview/events/:sessionId', (req, res) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'HOST_AI_MANAGED',
      message: `候选润色事件流已从 AlembicPlugin 删除: ${req.params.sessionId}`,
    },
  });
});

/* ═══ 对话式润色 — 应用 ══════════════════════════════════ */

/**
 * POST /api/v1/candidates/refine-apply
 * 应用宿主传回的润色 preview。未提供 preview 时不再 fallback 调用插件本地 AI。
 * Body: { candidateId: string, userPrompt?: string, preview?: object }
 */
router.post(
  '/refine-apply',
  validate(RefineApplyBody),
  async (req: Request, res: Response): Promise<void> => {
    const { candidateId, userPrompt, preview } = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');

    const entry = await knowledgeService.get(candidateId);
    if (!entry) {
      throw new ValidationError('Candidate not found');
    }
    const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
    const before = extractBeforeFields(json as Record<string, unknown>);

    // 只应用宿主传回的 preview；没有 preview 时必须 fail closed。
    const parsed = preview || null;
    if (!parsed) {
      return void res.status(501).json({
        success: false,
        error: {
          code: 'HOST_AI_MANAGED',
          message: 'refine-apply 未提供 preview，AlembicPlugin 不再 fallback 调用本地 AI。',
        },
        data: {
          candidateId,
          before,
          hasUserPrompt: Boolean(userPrompt?.trim()),
          hostManaged: true,
        },
      });
    }

    if (!parsed) {
      return void res.json({
        success: true,
        data: { refined: 0, total: 1, candidate: json },
      });
    }

    const { updateData, changed } = buildUpdateFromRefineResult(before, parsed);

    if (changed) {
      // 处理需要嵌套写入的字段
      const finalUpdate: Record<string, unknown> = { ...updateData };
      delete finalUpdate._patternChanged;
      delete finalUpdate._confidenceChanged;
      delete finalUpdate._markdownChanged;
      delete finalUpdate._rationaleChanged;

      const contentPatch: Record<string, unknown> = { ...(json.content || {}) };
      let contentChanged = false;
      if (updateData._patternChanged != null) {
        contentPatch.pattern = updateData._patternChanged;
        contentChanged = true;
      }
      if (updateData._markdownChanged != null) {
        contentPatch.markdown = updateData._markdownChanged;
        contentChanged = true;
      }
      if (updateData._rationaleChanged != null) {
        contentPatch.rationale = updateData._rationaleChanged;
        contentChanged = true;
      }
      if (contentChanged) {
        finalUpdate.content = contentPatch;
      }
      if (updateData._confidenceChanged != null) {
        finalUpdate.reasoning = {
          ...(json.reasoning || {}),
          confidence: updateData._confidenceChanged,
        };
      }

      await knowledgeService.update(candidateId, finalUpdate, { userId: 'dashboard-refine' });
    }

    // 返回更新后的条目
    const updated = changed ? await knowledgeService.get(candidateId) : entry;
    const updatedJson = typeof updated?.toJSON === 'function' ? updated.toJSON() : updated;

    res.json({
      success: true,
      data: { refined: changed ? 1 : 0, total: 1, candidate: updatedJson },
    });
  }
);

export default router;
