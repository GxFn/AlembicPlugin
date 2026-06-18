/**
 * MCP Handlers — 系统类
 * status (MTC-4: renamed from health; the resident half of the merged
 * alembic_status tool. Optional aspect narrows the view: 'runtime' returns
 * runtime checks/services/session, 'knowledge' returns the knowledge base
 * stats block, omitted returns the full status.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { PACKAGE_ROOT } from '#shared/package-assets.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import type { KnowledgeBaseStats, McpContext } from '../../../runtime/mcp/handlers/types.js';

export async function status(ctx: McpContext, args: Record<string, unknown> = {}) {
  const aspect = typeof args.aspect === 'string' ? args.aspect : undefined;
  const checks = { database: false, gateway: false, vectorStore: false };
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

  // 3) Gateway 可用性
  try {
    const gw = ctx.container.get('gateway');
    checks.gateway = !!gw;
  } catch (e: unknown) {
    issues.push(`gateway: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4) VectorStore 可用性
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

  // 5) 版本号（从 Alembic 包自身的 package.json 读取，不依赖 cwd）
  if (!_pkgVersion) {
    try {
      const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
      _pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '2.0.0';
    } catch {
      _pkgVersion = '2.0.0';
    }
  }

  // 6) 综合状态
  const allCritical = checks.database; // DB 是唯一硬性依赖
  const overallStatus = allCritical ? 'ok' : 'degraded';

  // 如果 DB 不可用但冷启动仍可执行，附加提示避免 Agent 浪费时间修复 DB
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

  const runtimeView = {
    status: overallStatus,
    version: _pkgVersion,
    uptime: Math.floor((Date.now() - (ctx.startedAt ?? Date.now())) / 1000),
    projectRoot: resolveProjectRoot(ctx.container),
    ai: aiInfo,
    checks,
    services: ctx.container.getServiceNames?.() ?? [],
    // P3: Session 信息
    ...(ctx.session
      ? {
          session: {
            id: ctx.session.id,
            intentPhase: ctx.session.intent?.phase ?? 'idle',
            toolCallCount: ctx.session.toolCallCount,
            toolsUsed: Array.from(ctx.session.toolsUsed),
            durationMs: Date.now() - ctx.session.startedAt,
          },
        }
      : {}),
    ...(issues.length ? { issues } : {}),
    ...(actionHints.length ? { actionHints } : {}),
  };
  // aspect narrows the merged status view; omitting it returns the full status
  // (runtime + knowledge), preserving the legacy alembic_health output shape.
  const data =
    aspect === 'knowledge'
      ? {
          status: overallStatus,
          version: _pkgVersion,
          knowledgeBase,
          ...(actionHints.length ? { actionHints } : {}),
        }
      : aspect === 'runtime'
        ? runtimeView
        : { ...runtimeView, knowledgeBase };

  return envelope({
    success: true,
    data,
    meta: { tool: 'alembic_status' },
  });
}

function resolveVectorDocumentCount(stats: Record<string, unknown>): number {
  const value = stats.documentCount ?? stats.totalDocuments ?? stats.count;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

let _pkgVersion: string | null = null;
