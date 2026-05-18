/**
 * AI API routes.
 *
 * AlembicPlugin no longer owns local AI execution.
 * These routes keep host-managed configuration and compatibility surfaces,
 * while AI/Agent execution endpoints fail closed with an explicit boundary.
 */

import Logger from '@alembic/core/logging';
import {
  collectAiEnvOverrides,
  isAiEnvReady,
  maskAiEnvConfig,
  PROVIDER_KEY_ENV,
  WorkspaceSettingsStore,
} from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import express, { type Request, type Response } from 'express';
import {
  createHostManagedProvider,
  listHostAiProviders,
  readHostAiConfigInfo,
} from '../../codex/HostAiAdapter.js';
import { getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  AiChatBody,
  AiConfigBody,
  AiFormatUsageGuideBody,
  AiLangBody,
  AiStreamBody,
  AiSummarizeBody,
  AiTaskBody,
  AiToolBody,
  AiTranslateBody,
  AiWorkspaceConfigBody,
} from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

const AI_CONFIG_GATEWAY_ACTION = 'update:config';
const AI_CONFIG_GATEWAY_RESOURCE = 'ai_config';

interface GatewayCheckOnlyLike {
  checkOnly?(request: {
    actor: string;
    action: string;
    resource?: string;
    data?: Record<string, unknown>;
    session?: string;
  }): Promise<{
    success: boolean;
    requestId?: string;
    error?: { message: string; statusCode?: number; code?: string };
  }>;
}

function getContainer() {
  return getServiceContainer();
}

function sendHostManagedUnavailable(res: Response, feature: string): void {
  res.status(501).json({
    success: false,
    error: {
      code: 'HOST_AI_MANAGED',
      message: `${feature} 已从 AlembicPlugin 删除。插件模式只保留宿主 AI 配置状态，实际 AI/Agent 执行由 Codex/IDE 宿主或 Core 外部编排提供。`,
    },
    data: {
      available: false,
      hostManaged: true,
    },
  });
}

function hasDeveloperRole(req: Request) {
  return ['admin', 'developer', 'owner'].includes(req.resolvedRole || '');
}

function requireDeveloperRole(req: Request, res: Response) {
  if (hasDeveloperRole(req)) {
    return true;
  }
  res.status(403).json({
    success: false,
    error: { code: 'FORBIDDEN', message: '需要 developer 权限才能修改 AI 配置' },
  });
  return false;
}

export async function ensureAiConfigUpdateAllowed(
  req: Request,
  res: Response,
  gateway?: GatewayCheckOnlyLike | null,
  updates: Record<string, string> = {}
) {
  if (!gateway?.checkOnly) {
    res.status(503).json({
      success: false,
      error: {
        code: 'GATEWAY_UNAVAILABLE',
        message: 'AI 配置写入需要 Gateway 权限检查，但 Gateway 不可用',
      },
    });
    return false;
  }

  const result = await gateway.checkOnly({
    actor: req.resolvedRole || 'anonymous',
    action: AI_CONFIG_GATEWAY_ACTION,
    resource: AI_CONFIG_GATEWAY_RESOURCE,
    data: {
      keys: Object.keys(updates),
      _ip: req.ip,
      _userAgent: req.headers['user-agent'] || '',
      _resolvedUser: req.resolvedUser || undefined,
    },
    session: req.headers['x-session-id'] as string | undefined,
  });

  if (result.success) {
    return true;
  }

  res.status(result.error?.statusCode || 403).json({
    success: false,
    error: {
      code: result.error?.code || 'GATEWAY_DENIED',
      message: result.error?.message || 'AI 配置写入未通过 Gateway 权限检查',
      requestId: result.requestId,
    },
  });
  return false;
}

router.get('/lang', async (_req: Request, res: Response): Promise<void> => {
  const container = getContainer();
  res.json({ success: true, data: { lang: container.getLang() || 'zh' } });
});

router.post('/lang', validate(AiLangBody), async (req: Request, res: Response): Promise<void> => {
  const { lang } = req.body;
  const container = getContainer();
  container.setLang(lang);
  logger.info(`UI language preference updated to "${lang}"`);
  res.json({ success: true, data: { lang } });
});

router.get('/providers', async (_req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const manager = container.singletons?._aiProviderManager as
    | {
        name?: string;
        model?: string;
      }
    | undefined;
  const configInfo = readHostAiConfigInfo(resolveProjectRoot(container));
  const activeProvider =
    manager?.name || configInfo.provider || process.env.ALEMBIC_AI_PROVIDER || '';
  const activeModel = manager?.model || configInfo.model || process.env.ALEMBIC_AI_MODEL || '';
  const providers = listHostAiProviders({
    activeProvider,
    activeModel,
    env: process.env,
  });

  res.json({
    success: true,
    data: {
      providers,
      active: { provider: activeProvider, model: activeModel },
      hostManaged: true,
    },
  });
});

router.post('/probe', async (req: Request, res: Response): Promise<void> => {
  const { provider: providerName, apiKey } = req.body;
  if (!providerName) {
    return void res
      .status(400)
      .json({ success: false, error: { message: 'provider is required' } });
  }

  const normalized = String(providerName).toLowerCase();
  res.json({
    success: true,
    data: {
      provider: normalized,
      status: 'host-managed',
      canProbe: false,
      hasProvidedKey: Boolean(apiKey),
      message: 'AlembicPlugin 不再内置 provider 探测，连通性由宿主 agent 验证。',
    },
  });
});

router.get('/config', async (_req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const manager = container.singletons?._aiProviderManager as {
    name: string;
    model: string;
    isMock: boolean;
  };
  res.json({
    success: true,
    data: {
      provider: manager.name,
      model: manager.model,
      isMock: manager.isMock,
      hostManaged: true,
    },
  });
});

router.post(
  '/config',
  validate(AiConfigBody),
  async (req: Request, res: Response): Promise<void> => {
    const { provider, model } = req.body;
    const newProvider = createHostManagedProvider({
      provider: provider.toLowerCase(),
      model: model || undefined,
    });
    const container = getServiceContainer();
    container.reloadAiProvider(newProvider as unknown as Record<string, unknown>);
    logger.info('AI provider selection updated for host agent', {
      provider: provider.toLowerCase(),
      model: newProvider.model,
    });

    res.json({
      success: true,
      data: {
        provider: provider.toLowerCase(),
        model: newProvider.model,
        name: newProvider.name,
        hostManaged: true,
      },
    });
  }
);

router.post('/mock/cleanup', async (_req: Request, res: Response): Promise<void> => {
  const container = getContainer();
  const knowledgeService = container.get('knowledgeService');
  const knowledgeRepo = container.get('knowledgeRepository') as {
    findIdsBySource(source: string): Promise<string[]>;
  };
  const legacySources = ['mock-bootstrap', 'mock-pipeline'];
  let totalDeleted = 0;

  for (const source of legacySources) {
    const ids = await knowledgeRepo.findIdsBySource(source);
    for (const id of ids) {
      try {
        await knowledgeService.delete(id, { userId: 'system:legacy-cleanup' });
        totalDeleted++;
      } catch {
        logger.debug(`Legacy cleanup: failed to delete ${id}`);
      }
    }
  }

  try {
    const memoryRepo = container.get('memoryRepository') as
      | {
          clearBootstrapMemories(): Promise<number>;
        }
      | undefined;
    await memoryRepo?.clearBootstrapMemories();
  } catch {
    /* optional repository */
  }

  logger.info(`Legacy generated candidate cleanup completed: ${totalDeleted} entries deleted`);
  getRealtimeService()?.broadcastEvent('mock-cleanup-completed', { deleted: totalDeleted });

  res.json({
    success: true,
    data: { deleted: totalDeleted, hostManaged: true },
  });
});

router.post(
  '/summarize',
  validate(AiSummarizeBody),
  async (_req: Request, res: Response): Promise<void> => {
    sendHostManagedUnavailable(res, 'AI 摘要生成');
  }
);

router.post(
  '/translate',
  validate(AiTranslateBody),
  async (_req: Request, res: Response): Promise<void> => {
    sendHostManagedUnavailable(res, 'AI 翻译');
  }
);

router.post('/chat', validate(AiChatBody), async (_req: Request, res: Response): Promise<void> => {
  sendHostManagedUnavailable(res, 'AI 对话');
});

router.post(
  '/agent/tool',
  validate(AiToolBody),
  async (_req: Request, res: Response): Promise<void> => {
    sendHostManagedUnavailable(res, 'HTTP Agent 工具直通');
  }
);

router.post(
  '/agent/task',
  validate(AiTaskBody),
  async (_req: Request, res: Response): Promise<void> => {
    sendHostManagedUnavailable(res, 'HTTP Agent 任务');
  }
);

router.get('/agent/capabilities', async (_req: Request, res: Response): Promise<void> => {
  sendHostManagedUnavailable(res, 'HTTP Agent 能力清单');
});

router.post(
  '/format-usage-guide',
  validate(AiFormatUsageGuideBody),
  async (req: Request, res: Response): Promise<void> => {
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

function getWorkspaceSettingsStore() {
  const container = getServiceContainer();
  return WorkspaceSettingsStore.fromProject(resolveProjectRoot(container));
}

function readLlmConfig() {
  const store = getWorkspaceSettingsStore();
  const settingsConfig = store.readAiConfig();
  const processConfig = collectAiEnvOverrides(settingsConfig.env, process.env);
  const rawVars = {
    ...settingsConfig.env,
    ...processConfig,
  };
  const vars = maskAiEnvConfig(rawVars);
  const hasSettings = settingsConfig.hasSettingsFile || settingsConfig.hasSecretsFile;
  const hasProcessConfig = Object.keys(processConfig).length > 0;

  return {
    vars,
    hasSettingsFile: settingsConfig.hasSettingsFile,
    hasSecretsFile: settingsConfig.hasSecretsFile,
    settingsPath: settingsConfig.settingsPath,
    secretsPath: settingsConfig.secretsPath,
    configSource: hasProcessConfig
      ? 'runtime-overrides'
      : hasSettings
        ? 'workspace-settings'
        : 'empty',
    llmReady: isAiEnvReady(rawVars),
    hostManaged: true,
  };
}

router.get('/env-config', async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: readLlmConfig() });
});

router.get('/workspace-config', async (_req: Request, res: Response): Promise<void> => {
  res.json({ success: true, data: readLlmConfig() });
});

async function saveLlmConfig(req: Request, res: Response): Promise<void> {
  if (!requireDeveloperRole(req, res)) {
    return;
  }

  const {
    provider,
    model,
    apiKey,
    proxy,
    reasoningEffort,
    embedProvider,
    embedModel,
    embedBaseUrl,
    embedApiKey,
    providerKeys,
  } = req.body;

  const updates: Record<string, string> = {
    ALEMBIC_AI_PROVIDER: provider,
  };
  if (model) {
    updates.ALEMBIC_AI_MODEL = model;
  }
  if (proxy) {
    updates.ALEMBIC_AI_PROXY = proxy;
  }
  if (reasoningEffort) {
    updates.ALEMBIC_AI_REASONING_EFFORT = reasoningEffort;
  }

  const providerKeyMap: Record<string, string> = {
    ...PROVIDER_KEY_ENV,
  };

  if (providerKeys && typeof providerKeys === 'object') {
    for (const [pid, key] of Object.entries(providerKeys as Record<string, string>)) {
      const envKey = providerKeyMap[pid];
      if (envKey && key) {
        updates[envKey] = String(key);
      }
    }
  }

  const keyName = providerKeyMap[provider];
  if (keyName && apiKey) {
    updates[keyName] = apiKey;
  }

  if (embedProvider) {
    updates.ALEMBIC_EMBED_PROVIDER = embedProvider;
    if (embedModel) {
      updates.ALEMBIC_EMBED_MODEL = embedModel;
    }
    if (embedBaseUrl) {
      updates.ALEMBIC_EMBED_BASE_URL = embedBaseUrl;
    }
    if (embedApiKey) {
      updates.ALEMBIC_EMBED_API_KEY = embedApiKey;
    }
  }

  const container = getServiceContainer();
  const gateway = container.get('gateway') as GatewayCheckOnlyLike;
  if (!(await ensureAiConfigUpdateAllowed(req, res, gateway, updates))) {
    return;
  }

  const store = getWorkspaceSettingsStore();
  store.writeAiConfig(updates);
  logger.info('LLM workspace config updated for host-managed AI', { provider, model });

  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = String(v);
  }

  container.reloadAiProvider(
    createHostManagedProvider({
      provider: provider.toLowerCase(),
      model: model || undefined,
    }) as unknown as Record<string, unknown>
  );
  logger.info('AI provider selection refreshed for host agent after env update', {
    provider,
    model,
  });

  res.json({ success: true, data: readLlmConfig() });
}

router.post('/env-config', validate(AiWorkspaceConfigBody), saveLlmConfig);
router.post('/workspace-config', validate(AiWorkspaceConfigBody), saveLlmConfig);

router.post(
  '/chat/stream',
  validate(AiStreamBody),
  async (_req: Request, res: Response): Promise<void> => {
    sendHostManagedUnavailable(res, 'AI 对话流');
  }
);

router.get('/chat/events/:sessionId', (_req: Request, res: Response): void => {
  sendHostManagedUnavailable(res, 'AI 对话流事件');
});

export default router;
