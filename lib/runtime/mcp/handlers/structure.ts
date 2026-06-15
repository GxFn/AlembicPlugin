/**
 * MCP Handlers — 项目结构 & 知识图谱
 * getTargets, getTargetFiles, getTargetMetadata, graphQuery, graphImpact, graphPath, graphStats
 */

import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigPaths as Paths } from '@alembic/core/config';
import { LanguageService } from '@alembic/core/shared';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { ModuleService } from '#service/module/ModuleService.js';
import {
  defaultProjectGraphProvider,
  defaultProjectKnowledgeContextLayer,
  type ProjectGraphInput,
  ProjectGraphInputSchema,
} from '#service/project-knowledge-context/index.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import type { McpContext } from '../../../runtime/mcp/handlers/types.js';

// ─── Local Types ──────────────────────────────────────────

export interface TargetInfo {
  name: string;
  packageName?: string;
  packagePath?: string;
  type?: string;
  language?: string;
  framework?: string;
  path?: string;
  targetDir?: string;
  info?: { path?: string; sources?: string; dependencies?: unknown[] };
  metadata?: { dependencies?: unknown[] };
  [key: string]: unknown;
}

interface FileInfo {
  name: string;
  path: string;
  relativePath: string;
  size?: number;
  [key: string]: unknown;
}

interface ModuleServiceLike {
  load(): Promise<void>;
  listTargets(): Promise<TargetInfo[]>;
  getTargetFiles(target: TargetInfo): Promise<FileInfo[]>;
  getDependencyGraph?(): unknown;
}

interface ModuleServiceCache {
  projectRoot: string;
  service: ModuleServiceLike;
  targets: TargetInfo[];
}

interface GraphEdge {
  fromId?: string;
  toId?: string;
  fromType?: string;
  toType?: string;
  relation?: string;
  [key: string]: unknown;
}

interface StructureArgs {
  targetName?: string;
  includeSummary?: boolean;
  includeContent?: boolean;
  contentMaxLines?: number;
  maxFiles?: number;
  [key: string]: unknown;
}

interface GraphArgs {
  operation?: string;
  nodeId?: string;
  nodeType?: string;
  direction?: string;
  relationType?: string;
  fromId?: string;
  toId?: string;
  fromType?: string;
  toType?: string;
  projectRoot?: string;
  maxDepth?: number;
  methodName?: string;
  [key: string]: unknown;
}

// ─── ProjectContext-backed module service cache ──────────
// 同一 projectRoot 在模块生命期内只初始化一次
let _moduleServiceCache: ModuleServiceCache | null = null;

async function _getLoadedModuleService(ctx?: {
  container?: { singletons?: { _projectRoot?: unknown } };
}) {
  const projectRoot = resolveProjectRoot(ctx?.container);
  if (_moduleServiceCache && _moduleServiceCache.projectRoot === projectRoot) {
    return _moduleServiceCache;
  }

  const service = _resolveModuleService(ctx as McpContext, projectRoot);
  await service.load();
  const targets = (await service.listTargets()) || [];
  _moduleServiceCache = {
    projectRoot,
    service,
    targets: targets as unknown as TargetInfo[],
  };
  return _moduleServiceCache;
}

function _resolveModuleService(
  ctx: McpContext | undefined,
  projectRoot: string
): ModuleServiceLike {
  try {
    const service = ctx?.container?.get?.('moduleService') as ModuleServiceLike | undefined;
    if (
      service &&
      typeof service.load === 'function' &&
      typeof service.listTargets === 'function' &&
      typeof service.getTargetFiles === 'function'
    ) {
      return service;
    }
  } catch {
    /* moduleService is optional in lightweight MCP contexts */
  }
  return new ModuleService(projectRoot) as unknown as ModuleServiceLike;
}

function _findTarget(targets: TargetInfo[], targetName: string): TargetInfo {
  const t = targets.find((t: TargetInfo) => t.name === targetName);
  if (!t) {
    throw new Error(`Target not found: ${targetName}`);
  }
  return t;
}

/** 推断语言 — 委托给 LanguageService */
function _inferLang(filename: string): string {
  return LanguageService.inferLang(filename);
}

/** 推断 Target 职责 */
function _inferTargetRole(targetName: string): string {
  const n = targetName.toLowerCase();
  if (/core|kit|shared|common|foundation|base/i.test(n)) {
    return 'core';
  }
  if (/service|manager|provider|repository|store/i.test(n)) {
    return 'service';
  }
  if (/ui|view|screen|component|widget/i.test(n)) {
    return 'ui';
  }
  if (/network|api|http|grpc|socket/i.test(n)) {
    return 'networking';
  }
  if (/storage|database|cache|persist|realm|coredata/i.test(n)) {
    return 'storage';
  }
  if (/test|spec|mock|stub|fake/i.test(n)) {
    return 'test';
  }
  if (/app|main|launch|entry/i.test(n)) {
    return 'app';
  }
  if (/router|coordinator|navigation/i.test(n)) {
    return 'routing';
  }
  if (/util|helper|extension|tool/i.test(n)) {
    return 'utility';
  }
  if (/model|entity|dto|schema/i.test(n)) {
    return 'model';
  }
  if (/auth|login|session|token/i.test(n)) {
    return 'auth';
  }
  if (/config|setting|environment|constant/i.test(n)) {
    return 'config';
  }
  return 'feature';
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargets
// ═══════════════════════════════════════════════════════════

export async function getTargets(ctx: McpContext, args: StructureArgs = {}) {
  const { service, targets } = await _getLoadedModuleService(ctx);
  const includeSummary = args.includeSummary !== false; // 默认 true

  if (!includeSummary) {
    return envelope({ success: true, data: { targets }, meta: { tool: 'alembic_structure' } });
  }

  // 带摘要：每个 target 附加文件数、语言统计、推断职责
  const enriched: Array<{
    name: string;
    packageName: string | null;
    type: string;
    inferredRole: string;
    fileCount: number;
    languageStats: Record<string, number>;
  }> = [];
  const globalLangStats: Record<string, number> = {};
  let totalFiles = 0;

  for (const t of targets) {
    let fileCount = 0;
    const langStats: Record<string, number> = {};
    try {
      const fileList = await service.getTargetFiles(t);
      fileCount = fileList.length;
      for (const f of fileList) {
        const lang = _inferLang(f.name);
        langStats[lang] = (langStats[lang] || 0) + 1;
        globalLangStats[lang] = (globalLangStats[lang] || 0) + 1;
      }
    } catch {
      /* skip */
    }
    totalFiles += fileCount;
    enriched.push({
      name: t.name,
      packageName: t.packageName || null,
      type: t.type || 'target',
      inferredRole: _inferTargetRole(t.name),
      fileCount,
      languageStats: langStats,
    });
  }

  return envelope({
    success: true,
    data: {
      targets: enriched,
      summary: { targetCount: targets.length, totalFiles, languageStats: globalLangStats },
    },
    meta: { tool: 'alembic_structure' },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargetFiles
// ═══════════════════════════════════════════════════════════

export async function getTargetFiles(ctx: McpContext, args: StructureArgs) {
  if (!args.targetName) {
    throw new Error('targetName is required');
  }
  const { service, targets } = await _getLoadedModuleService(ctx);
  const target = _findTarget(targets, args.targetName);

  // 使用 ProjectContext-backed ModuleService 定位源文件
  const rawFiles = await service.getTargetFiles(target);

  const includeContent = args.includeContent || false;
  const contentMaxLines = args.contentMaxLines || 100;
  const maxFiles = args.maxFiles || 500;

  const files: Array<{
    name: string;
    path: string;
    relativePath: string;
    language: string;
    size: number;
    content?: string | null;
    totalLines?: number;
    truncated?: boolean;
  }> = [];
  for (const f of rawFiles) {
    if (files.length >= maxFiles) {
      break;
    }
    const entry: {
      name: string;
      path: string;
      relativePath: string;
      language: string;
      size: number;
      content?: string | null;
      totalLines?: number;
      truncated?: boolean;
    } = {
      name: f.name,
      path: f.path,
      relativePath: f.relativePath,
      language: _inferLang(f.name),
      size: f.size || 0,
    };
    if (includeContent) {
      try {
        const raw = await readFile(f.path, 'utf8');
        const lines = raw.split('\n');
        entry.content = lines.slice(0, contentMaxLines).join('\n');
        entry.totalLines = lines.length;
        entry.truncated = lines.length > contentMaxLines;
      } catch {
        entry.content = null;
        entry.totalLines = 0;
        entry.truncated = false;
      }
    }
    files.push(entry);
  }

  // 文件语言统计
  const langStats: Record<string, number> = {};
  for (const f of files) {
    langStats[f.language] = (langStats[f.language] || 0) + 1;
  }

  return envelope({
    success: true,
    data: {
      targetName: args.targetName,
      files,
      fileCount: files.length,
      totalAvailable: rawFiles.length,
      languageStats: langStats,
    },
    meta: { tool: 'alembic_structure' },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargetMetadata
// ═══════════════════════════════════════════════════════════

export async function getTargetMetadata(ctx: McpContext, args: StructureArgs) {
  if (!args.targetName) {
    throw new Error('targetName is required');
  }
  const loadedService = await _getLoadedModuleService(ctx);
  const { targets } = loadedService;
  const target = _findTarget(targets, args.targetName);
  const { projectRoot } = loadedService;

  // ── 基础元数据 ──
  const meta: Record<string, unknown> = {
    name: target.name,
    path: target.path || null,
    packageName: target.packageName || null,
    packagePath: target.packagePath || null,
    type: target.type || 'target',
    language: target.language || null,
    framework: target.framework || null,
    inferredRole: _inferTargetRole(target.name),
    targetDir: target.targetDir || null,
    sourcesPath: target.info?.path || null,
    sources: target.info?.sources || null,
    dependencies: target.info?.dependencies || target.metadata?.dependencies || [],
  };

  // ── SPM 图谱 (spmmap.json) ──
  try {
    const dataRoot = resolveDataRoot(ctx?.container as never) || projectRoot;
    const knowledgeDir = Paths.getProjectKnowledgePath(dataRoot);
    const mapPath = path.join(knowledgeDir, 'Alembic.spmmap.json');
    if (fs.existsSync(mapPath)) {
      const raw = await readFile(mapPath, 'utf8');
      const graph = JSON.parse(raw)?.graph || null;
      if (target.packageName && graph?.packages?.[target.packageName]) {
        const pkg = graph.packages[target.packageName];
        meta.packageDir = pkg.packageDir;
        meta.packageSwift = pkg.packageSwift;
        meta.packageTargets = pkg.targets || [];
      }
    }
  } catch {
    /* ignore */
  }

  // ── 知识图谱关系 (knowledge_edges) ──
  try {
    const graphService = ctx.container?.get('knowledgeGraphService');
    if (graphService) {
      const edges = await graphService.getEdges(target.name, 'module', 'both');
      meta.graphEdges = {
        outgoing: (edges.outgoing || []).map((e: GraphEdge) => ({
          toId: e.toId,
          toType: e.toType,
          relation: e.relation,
        })),
        incoming: (edges.incoming || []).map((e: GraphEdge) => ({
          fromId: e.fromId,
          fromType: e.fromType,
          relation: e.relation,
        })),
      };
    }
  } catch {
    /* knowledge_edges may not exist */
  }

  return envelope({ success: true, data: meta, meta: { tool: 'alembic_structure' } });
}

export async function graphQuery(ctx: McpContext, args: GraphArgs) {
  return resolveProjectGraphMcpResult(ctx, { ...args, operation: 'query' });
}

export async function graphImpact(ctx: McpContext, args: GraphArgs) {
  return resolveProjectGraphMcpResult(ctx, { ...args, operation: 'impact' });
}

export async function graphPath(ctx: McpContext, args: GraphArgs) {
  return resolveProjectGraphMcpResult(ctx, { ...args, operation: 'path' });
}

export async function graphNeighborhood(ctx: McpContext, args: GraphArgs) {
  return resolveProjectGraphMcpResult(ctx, { ...args, operation: 'neighborhood' });
}

async function resolveProjectGraphMcpResult(ctx: McpContext, args: GraphArgs) {
  const input = normalizeProjectGraphInput(ctx, args);
  const graph = await defaultProjectGraphProvider.resolveProjectGraph(input);
  return defaultProjectKnowledgeContextLayer.resolveMcpResult('alembic_graph', input, {
    payload: graph.payload,
    snapshot: graph.snapshot,
  });
}

function normalizeProjectGraphInput(ctx: McpContext, args: GraphArgs): ProjectGraphInput {
  const containerProjectRoot = resolveProjectRoot(ctx?.container);
  return ProjectGraphInputSchema.parse({
    ...(args.activeFile ? { activeFile: args.activeFile } : {}),
    ...(args.budget ? { budget: args.budget } : {}),
    ...(args.detailLevel ? { detailLevel: args.detailLevel } : {}),
    ...(args.direction ? { direction: args.direction } : {}),
    ...(args.freshnessPolicy ? { freshnessPolicy: args.freshnessPolicy } : {}),
    ...(args.fromId ? { fromId: args.fromId } : {}),
    ...(args.fromType ? { fromType: args.fromType } : {}),
    ...(args.inputSource ? { inputSource: args.inputSource } : {}),
    ...(args.intentKind ? { intentKind: args.intentKind } : {}),
    ...(args.maxDepth ? { maxDepth: args.maxDepth } : {}),
    ...(args.nodeId ? { nodeId: args.nodeId } : {}),
    ...(args.nodeType ? { nodeType: args.nodeType } : {}),
    ...(args.operation ? { operation: args.operation } : {}),
    projectRoot: args.projectRoot ?? containerProjectRoot,
    ...(args.query ? { query: args.query } : {}),
    ...(args.relationType ? { relationType: args.relationType } : {}),
    ...(args.sourceEvidenceRefs ? { sourceEvidenceRefs: args.sourceEvidenceRefs } : {}),
    ...(args.sourceRefs ? { sourceRefs: args.sourceRefs } : {}),
    ...(args.toId ? { toId: args.toId } : {}),
    ...(args.toType ? { toType: args.toType } : {}),
  });
}

// ─── call_context — 调用链上下文 (Phase 5) ──────────────────

/**
 * alembic_call_context handler
 * 查询方法的调用者、被调用者、影响半径
 */
export async function callContext(ctx: McpContext, args: GraphArgs) {
  if (!args.methodName) {
    throw new Error('Missing required parameter: methodName');
  }

  const ceg = ctx.container.get('codeEntityGraph');
  if (!ceg) {
    return envelope({
      success: false,
      message: 'CodeEntityGraph not available — 请先运行 bootstrap',
      meta: { tool: 'alembic_call_context' },
    });
  }

  const direction = args.direction || 'both';
  const maxDepth = Math.min(Math.max(args.maxDepth ?? 2, 1), 5);
  const result: Record<string, unknown> = {};

  try {
    if (direction === 'callers' || direction === 'both') {
      result.callers = ceg.getCallers(args.methodName, maxDepth);
    }
    if (direction === 'callees' || direction === 'both') {
      result.callees = ceg.getCallees(args.methodName, maxDepth);
    }
    if (direction === 'impact') {
      result.impact = ceg.getCallImpactRadius(args.methodName);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      return envelope({
        success: true,
        data: {
          methodName: args.methodName,
          callers: [],
          callees: [],
          note: 'knowledge_edges 表不存在，请运行 bootstrap 后再查询',
        },
        meta: { tool: 'alembic_call_context' },
      });
    }
    throw err;
  }

  return envelope({
    success: true,
    data: {
      methodName: args.methodName,
      direction,
      maxDepth,
      ...result,
    },
    meta: { tool: 'alembic_call_context' },
  });
}

// ─── graph_stats — 图谱统计 ────────────────────────────────

export async function graphStats(ctx: McpContext, args: GraphArgs = {}) {
  return resolveProjectGraphMcpResult(ctx, { ...args, operation: 'stats' });
}
