/**
 * MCP Handlers — 系统类
 * status (MTC-4: renamed from health; the resident half of the merged
 * alembic_status tool. Optional aspect narrows the view: 'runtime' returns
 * runtime checks/services/session, 'knowledge' returns the knowledge base
 * stats block, omitted returns the full status.)
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { PACKAGE_ROOT } from '#shared/package-assets.js';
import { envelope } from '../envelope.js';
import { buildMcpToolUsageView } from '../session-usage.js';
import type { KnowledgeBaseStats, McpContext } from './types.js';

const execFileAsync = promisify(execFile);

type RuntimeChecks = { database: boolean; vectorStore: boolean };

export async function status(ctx: McpContext, args: Record<string, unknown> = {}) {
  const aspect = typeof args.aspect === 'string' ? args.aspect : undefined;
  const checks = { database: false, vectorStore: false };
  const issues: string[] = [];
  let knowledgeBase: KnowledgeBaseStats | null = null;

  // 1) Plugin 不再维护第三方 AI Provider 配置；健康检查只表达边界，不做 key 探测。
  const aiInfo = {
    provider: null,
    hasKey: false,
    owner: 'Alembic',
    pluginConfigRemoved: true,
  };

  // 2) Database 连通性 + 知识库统计
  try {
    const knowledgeRepo = ctx.container.get('knowledgeRepository') as {
      getStats(): Promise<Record<string, number>>;
    } | null;
    if (knowledgeRepo) {
      const stats = (await knowledgeRepo.getStats()) as Record<string, number> | null;
      checks.database = true;
      if (stats) {
        knowledgeBase = {
          recipes: {
            total: stats.total,
            active: stats.active,
            rules: stats.rules,
            patterns: stats.patterns,
            facts: stats.facts,
          },
          candidates: { total: stats.total, pending: stats.pending },
        };
      }
    }
  } catch (e: unknown) {
    issues.push(`database: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3) VectorStore 可用性
  try {
    const vs = ctx.container.get('vectorStore');
    if (vs) {
      const vsStats = typeof vs.getStats === 'function' ? await vs.getStats() : null;
      checks.vectorStore = true;
      if (vsStats) {
        knowledgeBase =
          knowledgeBase ||
          ({
            recipes: { total: 0, active: 0, rules: 0, patterns: 0, facts: 0 },
            candidates: { total: 0, pending: 0 },
          } as KnowledgeBaseStats);
        knowledgeBase.vectorIndex = {
          documentCount: resolveVectorDocumentCount(vsStats),
        };
      }
    }
  } catch (e: unknown) {
    issues.push(`vectorStore: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 6) 综合状态
  const allCritical = checks.database; // DB 是唯一硬性依赖
  const overallStatus = allCritical ? 'ok' : 'degraded';
  const version = readPackageVersion();
  const actionHints = buildActionHints(checks, knowledgeBase);
  // 主体 app（alembic-ai）安装态：直接问 npm，未装才引导安装（详见 buildMainBodyAppDescriptor）。
  const mainBodyApp = await buildMainBodyAppDescriptor();
  const runtimeView = buildRuntimeView({
    ctx,
    overallStatus,
    version,
    aiInfo,
    checks,
    issues,
    actionHints,
    mainBodyApp,
  });
  // aspect narrows the merged status view; omitting it returns the full status
  // (runtime + knowledge), preserving the legacy alembic_health output shape.
  const data = selectStatusData(aspect, runtimeView, {
    status: overallStatus,
    version,
    knowledgeBase,
    ...(actionHints.length ? { actionHints } : {}),
  });

  return envelope({
    success: true,
    data,
    meta: { tool: 'alembic_status' },
  });
}

function buildActionHints(
  checks: RuntimeChecks,
  knowledgeBase: KnowledgeBaseStats | null
): string[] {
  const actionHints: string[] = [];
  if (!checks.database) {
    actionHints.push(
      'DB 不可用不影响冷启动：alembic_bootstrap 不依赖数据库（纯文件系统分析），可直接调用。DB 会在首次 submit_knowledge 时自动重试初始化。'
    );
  }
  if (!knowledgeBase || knowledgeBase.recipes.total === 0) {
    actionHints.push(
      '知识库为空，建议执行冷启动：(1) 调用 alembic_bootstrap 获取 Mission Briefing → (2) 按维度分析代码并提交知识 → (3) 调用 alembic_dimension_complete 完成每个维度。'
    );
    actionHints.push(
      '💡 冷启动指引：调用 alembic_bootstrap 获取 Mission Briefing → 按维度分析代码 → 调用 alembic_dimension_complete 完成每个维度'
    );
  }
  return actionHints;
}

/** 供测试注入的命令执行器：默认真跑命令并返回 stdout。 */
type CommandRunner = (command: string, args: string[]) => Promise<string>;

const defaultCommandRunner: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, { timeout: 5000, windowsHide: true });
  return stdout;
};

/**
 * 直接问 npm：alembic-ai 是否已全局安装。这是"该不该推荐安装主体 app"的正确信号——
 * 不拿"daemon 是否跑过"去间接推断（那会把「没装」和「装了但从未启动」混为一谈：daemon 入口
 * 只有 daemon 真跑过一次才写入）。未装时 `npm ls -g` 以非 0 退出 → reject；spawn 失败/超时
 * 同样 reject，都收敛为 false（安装始终需用户同意，误判偏保守无害）。
 */
export async function isMainBodyInstalledGlobally(
  run: CommandRunner = defaultCommandRunner
): Promise<boolean> {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const stdout = await run(npm, ['ls', '-g', 'alembic-ai', '--depth=0']);
    return /alembic-ai@/.test(stdout);
  } catch {
    return false;
  }
}

/**
 * 主体 app（alembic-ai）能力描述符。主体提供 Dashboard 与常驻 daemon 后台任务；插件核心
 * （bootstrap/rescan/search/guard/知识库）不依赖它（Ghost 模式）。installed 由直接的 npm 全局
 * 安装查询得出——只有确认「未安装」才给出安装引导；命令由宿主 agent 在征得用户同意后自行执行，
 * 不擅自装、不把命令当作待办甩给用户。这是冷静的能力元数据，不是每次 status 都催促的 hint。
 */
async function buildMainBodyAppDescriptor(): Promise<Record<string, unknown>> {
  const installed = await isMainBodyInstalledGlobally();
  const descriptor: Record<string, unknown> = {
    installed,
    optional: true,
    provides: ['dashboard', 'background-daemon-jobs'],
    note: 'Plugin core features (bootstrap, rescan, search, guard, knowledge base) work without it (Ghost mode).',
  };
  if (!installed) {
    descriptor.install = {
      package: 'alembic-ai',
      command: 'npm install -g alembic-ai',
      cli: 'alembic',
      requiresUserConsent: true,
      hostAgentGuidance:
        '主体 app（alembic-ai）未全局安装。它提供 Dashboard 和后台 daemon 任务，是可选增强——' +
        '插件其余能力无需它即可工作。若用户想要 Dashboard 或后台任务，可主动询问是否安装；征得同意后由宿主 ' +
        'agent 直接运行 command 字段的命令，不要在未经用户同意时安装，也不要把命令当作手动待办甩给用户。',
    };
  }
  return descriptor;
}

function buildRuntimeView(input: {
  actionHints: string[];
  aiInfo: Record<string, unknown>;
  checks: RuntimeChecks;
  ctx: McpContext;
  issues: string[];
  mainBodyApp: Record<string, unknown>;
  overallStatus: string;
  version: string;
}): Record<string, unknown> {
  const { actionHints, aiInfo, checks, ctx, issues, mainBodyApp, overallStatus, version } = input;
  return {
    status: overallStatus,
    version,
    uptime: Math.floor((Date.now() - (ctx.startedAt ?? Date.now())) / 1000),
    projectRoot: resolveProjectRoot(ctx.container),
    ai: aiInfo,
    // 主体 app（可选增强：Dashboard + 常驻 daemon 后台任务）安装态与安装引导；未装时据此
    // 引导宿主 agent 征得用户同意后安装 alembic-ai，不改变 Ghost 默认。
    mainBodyApp,
    checks,
    services: ctx.container.getServiceNames?.() ?? [],
    // P3: Session 信息
    ...(ctx.connection
      ? {
          session: {
            id: ctx.connection.id,
            toolCallCount: ctx.connection.toolCallCount,
            toolsUsed: Array.from(ctx.connection.toolsUsed),
            durationMs: Date.now() - ctx.connection.startedAt,
          },
          usage: buildMcpToolUsageView(ctx.connection.toolUsage),
        }
      : {}),
    ...(issues.length ? { issues } : {}),
    ...(actionHints.length ? { actionHints } : {}),
  };
}

function selectStatusData(
  aspect: string | undefined,
  runtimeView: Record<string, unknown>,
  knowledgeView: Record<string, unknown>
): Record<string, unknown> {
  if (aspect === 'knowledge') {
    return knowledgeView;
  }
  if (aspect === 'runtime') {
    return runtimeView;
  }
  return { ...runtimeView, knowledgeBase: knowledgeView.knowledgeBase };
}

function resolveVectorDocumentCount(stats: Record<string, unknown>): number {
  const value = stats.documentCount ?? stats.totalDocuments ?? stats.count;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readPackageVersion(): string {
  if (_pkgVersion) {
    return _pkgVersion;
  }
  try {
    const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
    _pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '2.0.0';
  } catch {
    _pkgVersion = '2.0.0';
  }
  return _pkgVersion ?? '2.0.0';
}

let _pkgVersion: string | null = null;
