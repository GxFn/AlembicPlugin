/**
 * MCP Handlers — 项目结构 & 知识图谱
 * getTargets, getTargetFiles, getTargetMetadata, graphQuery, graphImpact, graphPath, graphStats
 */

import { LanguageService } from '@alembic/core/shared';
import { ModuleService } from '#service/module/ModuleService.js';
import {
  type AlembicGraphOutput,
  createAlembicGraphMcpResult,
  defaultProjectGraphProvider,
  type ProjectGraphInput,
  ProjectGraphInputSchema,
} from '#service/project-knowledge-context/index.js';
import type { ProjectContextContinuationPage } from '#service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { type McpContext, requireRequestProjectRuntime } from './types.js';

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

interface GraphArgs {
  cancelCursor?: string;
  cursor?: string;
  pageSize?: number;
  queryKind?: string;
  refId?: string;
  fromRefId?: string;
  toRefId?: string;
  filePath?: string;
  symbolName?: string;
  line?: number;
  radius?: {
    maxDepth?: number;
    beforeLines?: number;
    afterLines?: number;
    relationHops?: number;
  };
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

async function _getLoadedModuleService(ctx: McpContext) {
  const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;
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

export async function graph(ctx: McpContext, args: GraphArgs = {}) {
  const execution = ctx.projectContextExecution;
  if (args.cursor || args.cancelCursor) {
    if (!execution) {
      throw new Error('ProjectContext continuation requires the public request-scoped runtime.');
    }
    const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;
    if (args.cancelCursor) {
      const cancelled = await execution.buildSessions.cancelContinuation<AlembicGraphOutput>({
        cursor: args.cancelCursor,
        projectRoot,
      });
      if (!cancelled.context) {
        throw new Error('Graph continuation cancellation lost its bounded result context.');
      }
      const output = cancelledGraphContinuation(cancelled.context, cancelled);
      return createAlembicGraphMcpResult(output);
    }
    const cursor = args.cursor;
    if (!cursor) {
      throw new Error('Graph continuation cursor is required.');
    }
    const page = await execution.buildSessions.readContinuation<GraphPageEntry>({
      cursor,
      projectRoot,
    });
    return createAlembicGraphMcpResult(materializeGraphContinuation(page));
  }
  const input = normalizeProjectGraphInput(ctx, args);
  const output = await defaultProjectGraphProvider.resolveAlembicGraph(input, execution);
  const factSessionRef = output.meta.projectContext?.factSessionRef;
  if (!execution || !factSessionRef) {
    return createAlembicGraphMcpResult(output);
  }
  const page = await execution.buildSessions.publishContinuation({
    context: graphContinuationBase(output),
    factSessionRef,
    items: graphPageEntries(output),
    pageSize: args.pageSize ?? 100,
    projectRoot: output.project.projectRoot,
  });
  return createAlembicGraphMcpResult(materializeGraphContinuation(page));
}

type GraphPageEntry =
  | { kind: 'node'; value: AlembicGraphOutput['nodes'][number] }
  | { kind: 'relation'; value: AlembicGraphOutput['relations'][number] }
  | { kind: 'ref'; value: AlembicGraphOutput['refs'][number] }
  | { kind: 'slice'; value: NonNullable<AlembicGraphOutput['slices']>[number] };

function graphPageEntries(output: AlembicGraphOutput): GraphPageEntry[] {
  return [
    ...output.nodes.map((value): GraphPageEntry => ({ kind: 'node', value })),
    ...output.relations.map((value): GraphPageEntry => ({ kind: 'relation', value })),
    ...output.refs.map((value): GraphPageEntry => ({ kind: 'ref', value })),
    ...(output.slices ?? []).map((value): GraphPageEntry => ({ kind: 'slice', value })),
  ];
}

function graphContinuationBase(output: AlembicGraphOutput): AlembicGraphOutput {
  return {
    ...output,
    nodes: [],
    relations: [],
    refs: [],
    slices: [],
    continuation: undefined,
  };
}

function materializeGraphContinuation(
  page: ProjectContextContinuationPage<GraphPageEntry>
): AlembicGraphOutput {
  const base = page.context as AlembicGraphOutput | undefined;
  if (!base) {
    throw new Error('Graph continuation lost its bounded result context.');
  }
  const nodes: AlembicGraphOutput['nodes'] = [];
  const relations: AlembicGraphOutput['relations'] = [];
  const refs: AlembicGraphOutput['refs'] = [];
  const slices: NonNullable<AlembicGraphOutput['slices']> = [];
  for (const entry of page.items) {
    if (entry.kind === 'node') {
      nodes.push(entry.value);
    }
    if (entry.kind === 'relation') {
      relations.push(entry.value);
    }
    if (entry.kind === 'ref') {
      refs.push(entry.value);
    }
    if (entry.kind === 'slice') {
      slices.push(entry.value);
    }
  }
  return {
    ...base,
    status: page.hasMore && base.status === 'ready' ? 'partial' : base.status,
    summary: `${base.summary} Continuation page ${page.page}${page.hasMore ? ' has more facts.' : ' is terminal.'}`,
    nodes,
    relations,
    refs,
    slices,
    continuation: {
      accumulatedCounts: page.accumulatedCounts,
      factSessionRef: page.factSessionRef,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      page: page.page,
      resultRef: page.resultRef,
    },
  };
}

function cancelledGraphContinuation(
  base: AlembicGraphOutput,
  cancelled: { factSessionRef: string; resultRef: string }
): AlembicGraphOutput {
  return {
    ...graphContinuationBase(base),
    status: 'partial',
    summary: 'alembic_graph continuation cancelled; ephemeral result chunks were removed.',
    diagnostics: [
      ...base.diagnostics,
      {
        code: 'project-context-continuation-cancelled',
        message: 'The caller explicitly cancelled the opaque continuation.',
        retryable: true,
        severity: 'info',
      },
    ],
    continuation: {
      accumulatedCounts: { items: 0 },
      factSessionRef: cancelled.factSessionRef,
      hasMore: false,
      nextCursor: null,
      page: 1,
      resultRef: cancelled.resultRef,
    },
  };
}

// Deprecated operation-named entrypoints. Retained only as stale-input
// compatibility wrappers that normalize onto queryKind; they do not define a
// second behavior branch. New callers should pass queryKind to `graph`.
export async function graphQuery(ctx: McpContext, args: GraphArgs) {
  return graph(ctx, { ...args, operation: 'query' });
}

export async function graphImpact(ctx: McpContext, args: GraphArgs) {
  return graph(ctx, { ...args, operation: 'impact' });
}

export async function graphPath(ctx: McpContext, args: GraphArgs) {
  return graph(ctx, { ...args, operation: 'path' });
}

export async function graphNeighborhood(ctx: McpContext, args: GraphArgs) {
  return graph(ctx, { ...args, operation: 'neighborhood' });
}

function normalizeProjectGraphInput(ctx: McpContext, args: GraphArgs): ProjectGraphInput {
  const containerProjectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;
  const hostDeclaredIntent = readRecord(args.hostDeclaredIntent);
  const query = readString(args.query) ?? readString(hostDeclaredIntent?.query);
  // ProjectContext-shaped public anchors are normalized onto the provider's
  // existing anchor fields: filePath→activeFile, refId→nodeId, fromRefId/toRefId
  // →fromId/toId, radius.maxDepth→maxDepth.
  const activeFile = args.filePath ?? args.activeFile;
  const nodeId = args.refId ?? args.nodeId;
  const fromId = args.fromRefId ?? args.fromId;
  const toId = args.toRefId ?? args.toId;
  const maxDepth = args.radius?.maxDepth ?? args.maxDepth;
  return ProjectGraphInputSchema.parse({
    ...(args.queryKind ? { queryKind: args.queryKind } : {}),
    ...(activeFile ? { activeFile } : {}),
    ...(args.budget ? { budget: args.budget } : {}),
    ...(args.detailLevel ? { detailLevel: args.detailLevel } : {}),
    ...(args.direction ? { direction: args.direction } : {}),
    ...(args.filePath ? { filePath: args.filePath } : {}),
    ...(args.freshnessPolicy ? { freshnessPolicy: args.freshnessPolicy } : {}),
    ...(fromId ? { fromId } : {}),
    ...(args.fromRefId ? { fromRefId: args.fromRefId } : {}),
    ...(args.fromType ? { fromType: args.fromType } : {}),
    ...(args.inputSource ? { inputSource: args.inputSource } : {}),
    ...(args.line ? { line: args.line } : {}),
    ...(maxDepth ? { maxDepth } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(args.nodeType ? { nodeType: args.nodeType } : {}),
    ...(args.operation ? { operation: args.operation } : {}),
    projectRoot: args.projectRoot ?? containerProjectRoot,
    ...(args.radius ? { radius: args.radius } : {}),
    ...(args.refId ? { refId: args.refId } : {}),
    ...(hostDeclaredIntent === undefined ? {} : { hostDeclaredIntent }),
    ...(query === undefined ? {} : { query }),
    ...(args.relationType ? { relationType: args.relationType } : {}),
    ...(args.sourceEvidenceRefs ? { sourceEvidenceRefs: args.sourceEvidenceRefs } : {}),
    ...(args.sourceRefs ? { sourceRefs: args.sourceRefs } : {}),
    ...(args.symbolName ? { symbolName: args.symbolName } : {}),
    ...(toId ? { toId } : {}),
    ...(args.toRefId ? { toRefId: args.toRefId } : {}),
    ...(args.toType ? { toType: args.toType } : {}),
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ─── call_context — 调用链上下文 (Phase 5) ──────────────────

/**
 * alembic_call_context handler
 * 查询方法的调用者、被调用者、影响半径
 */
export async function graphStats(ctx: McpContext, args: GraphArgs = {}) {
  return graph(ctx, { ...args, operation: 'stats' });
}
