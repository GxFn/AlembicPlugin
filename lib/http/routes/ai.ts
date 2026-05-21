/**
 * AI compatibility routes.
 *
 * AlembicPlugin 的 HTTP 入口只保留极少量非 AI 执行的兼容工具；第三方
 * provider 配置、key 写入、探测、chat/embed/agent 执行都已从 Plugin 删除。
 */

import Logger from '@alembic/core/logging';
import express, { type Response } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { AiFormatUsageGuideBody, AiLangBody } from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

const REMOVED_AI_CONFIG_PAYLOAD = {
  available: false,
  configOwner: 'Alembic',
  hostAgentOwner: 'Codex',
  pluginConfigRemoved: true,
  residentSearchOwner: 'Alembic resident service',
};

function getContainer() {
  return getServiceContainer();
}

function sendPluginExternalAiRemoved(res: Response, feature: string): void {
  res.status(410).json({
    success: false,
    error: {
      code: 'PLUGIN_AI_CONFIG_REMOVED',
      message: `${feature} 已从 AlembicPlugin 删除。Plugin 不再配置第三方 AI provider，也不保存 API key；Codex 推理归宿主 agent，语义/向量增强归 Alembic resident service。`,
    },
    data: REMOVED_AI_CONFIG_PAYLOAD,
  });
}

router.get('/lang', async (_req, res): Promise<void> => {
  const container = getContainer();
  res.json({ success: true, data: { lang: container.getLang() || 'zh' } });
});

router.post('/lang', validate(AiLangBody), async (req, res): Promise<void> => {
  const { lang } = req.body;
  const container = getContainer();
  container.setLang(lang);
  logger.info(`UI language preference updated to "${lang}"`);
  res.json({ success: true, data: { lang } });
});

router.post(
  '/format-usage-guide',
  validate(AiFormatUsageGuideBody),
  async (req, res): Promise<void> => {
    const { text } = req.body;
    if (!text) {
      return void res.json({ success: true, data: { formatted: '' } });
    }

    let formatted = text.trim();
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    formatted = formatted.replace(/```(\w+)?\n/g, '\n```$1\n');

    res.json({ success: true, data: { formatted } });
  }
);

router.get('/providers', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider 列表');
});

router.post('/probe', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider 探测');
});

router.get('/config', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider 配置读取');
});

router.post('/config', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider 配置写入');
});

router.get('/env-config', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider 环境配置读取');
});

router.post('/env-config', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider 环境配置写入');
});

router.get('/workspace-config', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider workspace 配置读取');
});

router.post('/workspace-config', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI provider workspace 配置写入');
});

router.post('/mock/cleanup', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, '历史 mock AI 清理');
});

router.post('/summarize', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI 摘要生成');
});

router.post('/translate', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI 翻译');
});

router.post('/chat', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI 对话');
});

router.post('/chat/stream', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI 对话流');
});

router.get('/chat/events/:sessionId', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'AI 对话流事件');
});

router.post('/agent/tool', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'HTTP Agent 工具直通');
});

router.post('/agent/task', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'HTTP Agent 任务');
});

router.get('/agent/capabilities', async (_req, res): Promise<void> => {
  sendPluginExternalAiRemoved(res, 'HTTP Agent 能力清单');
});

export default router;
