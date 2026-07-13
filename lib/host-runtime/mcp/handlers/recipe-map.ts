/**
 * alembic_recipe_map — replaces alembic_project_matrix.
 *
 * Returns a bounded ProjectContext region (the shared GMAP-3 ProjectContextRegion,
 * so refs round-trip with alembic_graph) plus deterministic Recipe mounts/rollups.
 * Mounting reads Recipe data ONLY via Core RecipeContext source-refs + metadata
 * (no semantic/keyword search) and never invokes another MCP handler.
 */
import {
  createRecipeContextServiceFromCore,
  type RecipeContextEnvelope,
  type RecipeContextRequest,
  type RecipeContextResult,
} from '@alembic/core/recipe-context-capabilities';
import {
  type AlembicRecipeMapOutput,
  createAlembicRecipeMapMcpResult,
  defaultProjectGraphProvider,
  type MapFocus,
  type MapRadius,
  type RegionFocus,
  type RegionFocusKind,
} from '#service/project-knowledge-context/index.js';
import {
  budgetRecipeMapOutput,
  defaultRecipeMapProvider,
  type MountDiagnostic,
  type RecipeMapDeps,
  type RecipeMapRequest,
  type RecipeRecordLite,
  type RecipeSourceRefRow,
} from '#service/project-knowledge-context/recipe-map/index.js';
import type { ProjectContextContinuationPage } from '#service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { type McpContext, requireRequestProjectRuntime } from './types.js';

interface RecipeMapArgs {
  cancelCursor?: string;
  cursor?: string;
  pageSize?: number;
  focus?: {
    kind?: string;
    refId?: string;
    nodeId?: string;
    filePath?: string;
    line?: number;
    sourceRef?: string;
    moduleName?: string;
    repoId?: string;
  };
  radius?: MapRadius;
  projectRoot?: string;
  activeFile?: string;
  includeRecipes?: boolean;
  includeRollups?: boolean;
  recipeMountLimit?: number;
  nodeLimit?: number;
  [key: string]: unknown;
}

interface RecipeContextRecipeRecord {
  category?: string;
  dimensionId?: string;
  id: string;
  kind?: string;
  lifecycle?: string;
  moduleName?: string;
  scope?: string;
  sourceFile?: string | null;
  sources?: string[];
  summary?: string;
  tags?: string[];
  title: string;
}

interface RecipeContextListData {
  page?: number;
  pageSize?: number;
  recipes?: RecipeContextRecipeRecord[];
  total?: number;
}

interface RecipeContextSourceRefData {
  refs?: Array<{
    newPath?: string | null;
    recipeId: string;
    sourcePath: string;
    status?: string;
  }>;
}

const RECIPE_MAP_FOCUS_KINDS = new Set<RegionFocusKind>([
  'space',
  'repo',
  'map',
  'module',
  'file',
  'symbol',
  'anchor',
]);

export async function recipeMap(ctx: McpContext, args: RecipeMapArgs = {}) {
  const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;
  const execution = ctx.projectContextExecution;
  if (args.cursor || args.cancelCursor) {
    if (!execution) {
      throw new Error('ProjectContext continuation requires the public request-scoped runtime.');
    }
    if (args.cancelCursor) {
      const cancelled = await execution.buildSessions.cancelContinuation<AlembicRecipeMapOutput>({
        cursor: args.cancelCursor,
        projectRoot,
      });
      if (!cancelled.context) {
        throw new Error('Recipe Map continuation cancellation lost its bounded result context.');
      }
      return createAlembicRecipeMapMcpResult(
        cancelledRecipeMapContinuation(cancelled.context, cancelled)
      );
    }
    const cursor = args.cursor;
    if (!cursor) {
      throw new Error('Recipe Map continuation cursor is required.');
    }
    const page = await execution.buildSessions.readContinuation<RecipeMapPageEntry>({
      cursor,
      projectRoot,
    });
    return createAlembicRecipeMapMcpResult(materializeRecipeMapContinuation(page));
  }
  const request = normalizeRecipeMapRequest(args, projectRoot);
  const deps = buildRecipeMapDeps(ctx);
  const output = await defaultRecipeMapProvider.resolveRecipeMap(request, deps);
  const budgeted = budgetRecipeMapOutput(output);
  const factSessionRef = budgeted.meta.factSessionRef;
  if (!execution || !factSessionRef) {
    return createAlembicRecipeMapMcpResult(budgeted);
  }
  const page = await execution.buildSessions.publishContinuation({
    context: recipeMapContinuationBase(budgeted),
    factSessionRef,
    items: recipeMapPageEntries(budgeted),
    pageSize: args.pageSize ?? 100,
    projectRoot,
  });
  return createAlembicRecipeMapMcpResult(materializeRecipeMapContinuation(page));
}

type RecipeMapPageEntry =
  | { kind: 'node'; value: AlembicRecipeMapOutput['region']['nodes'][number] }
  | { kind: 'ref'; value: AlembicRecipeMapOutput['refs'][number] }
  | { kind: 'mount'; value: AlembicRecipeMapOutput['recipeMounts'][number] }
  | { kind: 'rollup'; value: AlembicRecipeMapOutput['recipeRollups'][number] };

function recipeMapPageEntries(output: AlembicRecipeMapOutput): RecipeMapPageEntry[] {
  return [
    ...output.region.nodes.map((value): RecipeMapPageEntry => ({ kind: 'node', value })),
    ...output.refs.map((value): RecipeMapPageEntry => ({ kind: 'ref', value })),
    ...output.recipeMounts.map((value): RecipeMapPageEntry => ({ kind: 'mount', value })),
    ...output.recipeRollups.map((value): RecipeMapPageEntry => ({ kind: 'rollup', value })),
  ];
}

function recipeMapContinuationBase(output: AlembicRecipeMapOutput): AlembicRecipeMapOutput {
  return {
    ...output,
    region: { ...output.region, nodes: [] },
    refs: [],
    recipeMounts: [],
    recipeRollups: [],
    continuation: undefined,
  };
}

function materializeRecipeMapContinuation(
  page: ProjectContextContinuationPage<RecipeMapPageEntry>
): AlembicRecipeMapOutput {
  const base = page.context as AlembicRecipeMapOutput | undefined;
  if (!base) {
    throw new Error('Recipe Map continuation lost its bounded result context.');
  }
  const nodes: AlembicRecipeMapOutput['region']['nodes'] = [];
  const refs: AlembicRecipeMapOutput['refs'] = [];
  const mounts: AlembicRecipeMapOutput['recipeMounts'] = [];
  const rollups: AlembicRecipeMapOutput['recipeRollups'] = [];
  for (const entry of page.items) {
    if (entry.kind === 'node') {
      nodes.push(entry.value);
    }
    if (entry.kind === 'ref') {
      refs.push(entry.value);
    }
    if (entry.kind === 'mount') {
      mounts.push(entry.value);
    }
    if (entry.kind === 'rollup') {
      rollups.push(entry.value);
    }
  }
  const displayedMounts = mounts.length;
  return {
    ...base,
    status: page.hasMore && base.status === 'ready' ? 'partial' : base.status,
    summary: `${base.summary} Continuation page ${page.page}${page.hasMore ? ' has more facts.' : ' is terminal.'}`,
    region: { ...base.region, nodes },
    refs,
    recipeMounts: mounts,
    recipeRollups: rollups,
    conservation: {
      ...base.conservation,
      displayedMounts,
      omittedMounts: Math.max(0, base.conservation.mountedTotal - displayedMounts),
    },
    limits: {
      ...base.limits,
      appliedRecipeMountLimit: displayedMounts,
      recipeMountLimitReason: recipeMapPageLimitReason(base, displayedMounts),
    },
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

function recipeMapPageLimitReason(
  base: AlembicRecipeMapOutput,
  displayedMounts: number
): AlembicRecipeMapOutput['limits']['recipeMountLimitReason'] {
  if (displayedMounts < Math.min(base.limits.recipeMountLimit, base.conservation.mountedTotal)) {
    return 'inline-byte-budget';
  }
  return base.conservation.mountedTotal < base.limits.recipeMountLimit
    ? 'available-mounts'
    : 'requested-limit';
}

function cancelledRecipeMapContinuation(
  base: AlembicRecipeMapOutput,
  cancelled: { factSessionRef: string; resultRef: string }
): AlembicRecipeMapOutput {
  const empty = recipeMapContinuationBase(base);
  return {
    ...empty,
    status: 'partial',
    summary: 'alembic_recipe_map continuation cancelled; ephemeral result chunks were removed.',
    diagnostics: [
      ...base.diagnostics,
      {
        code: 'project-context-continuation-cancelled',
        message: 'The caller explicitly cancelled the opaque continuation.',
        retryable: true,
        severity: 'info',
      },
    ],
    conservation: {
      ...base.conservation,
      displayedMounts: 0,
      omittedMounts: base.conservation.mountedTotal,
    },
    limits: {
      ...base.limits,
      appliedRecipeMountLimit: 0,
      recipeMountLimitReason: recipeMapPageLimitReason(base, 0),
    },
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

function normalizeRecipeMapRequest(args: RecipeMapArgs, projectRoot: string): RecipeMapRequest {
  const sourceRefPath = sourcePathFromRecipeMapRef(args.focus?.sourceRef);
  const focusKind = recipeMapFocusKind(
    args.focus?.kind,
    Boolean(sourceRefPath),
    Boolean(args.focus?.moduleName),
    Boolean(args.focus?.repoId)
  );
  const refId = args.focus?.refId ?? args.focus?.nodeId ?? args.focus?.repoId;
  const filePath =
    args.focus?.filePath ?? args.activeFile ?? sourceRefPath ?? args.focus?.moduleName;
  const rawFocus: MapFocus = {
    kind: focusKind,
    ...(args.focus?.refId ? { refId: args.focus.refId } : {}),
    ...(args.focus?.nodeId ? { nodeId: args.focus.nodeId } : {}),
    ...(args.focus?.filePath ? { filePath: args.focus.filePath } : {}),
    ...(args.focus?.line === undefined ? {} : { line: args.focus.line }),
    ...(args.focus?.sourceRef ? { sourceRef: args.focus.sourceRef } : {}),
    ...(args.focus?.moduleName ? { moduleName: args.focus.moduleName } : {}),
    ...(args.focus?.repoId ? { repoId: args.focus.repoId } : {}),
  };
  const focus: RegionFocus = {
    kind: focusKind,
    ...(refId ? { refId } : {}),
    ...(filePath ? { filePath } : {}),
    ...(args.focus?.line === undefined ? {} : { line: args.focus.line }),
  };
  return {
    focus,
    rawFocus,
    projectRoot,
    radius: args.radius ?? {},
    includeRecipes: args.includeRecipes !== false,
    includeRollups: args.includeRollups !== false,
    recipeMountLimit: clampInt(args.recipeMountLimit, 50, 0, 200),
    nodeLimit: clampInt(args.nodeLimit, 60, 1, 500),
    detailLevel: 'summary',
  };
}

function recipeMapFocusKind(
  kind: string | undefined,
  hasSourceRef: boolean,
  hasModuleName: boolean,
  hasRepoId: boolean
): RegionFocusKind {
  if (kind && RECIPE_MAP_FOCUS_KINDS.has(kind as RegionFocusKind)) {
    return kind as RegionFocusKind;
  }
  if (kind) {
    throw new Error(`Unsupported recipe_map focus kind: ${kind}`);
  }
  if (hasSourceRef) {
    return 'file';
  }
  if (hasModuleName) {
    return 'module';
  }
  if (hasRepoId) {
    return 'repo';
  }
  return 'space';
}

function sourcePathFromRecipeMapRef(sourceRef: string | undefined): string | undefined {
  const value = sourceRef?.trim();
  if (!value) {
    return undefined;
  }
  return value.replace(/#L?\d+(?:-L?\d+)?$/, '').replace(/:L?\d+(?:-L?\d+)?$/, '');
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function buildRecipeMapDeps(ctx: McpContext): RecipeMapDeps {
  const resolveRegion: RecipeMapDeps['resolveRegion'] = (focus, projectRoot, radius) =>
    defaultProjectGraphProvider.resolveProjectContextRegion(
      { focus, projectRoot, radius },
      ctx.projectContextExecution
    );

  const recipeContext = buildRecipeContextService(ctx);
  if (!recipeContext) {
    return {
      resolveRegion,
      querySourceRefs: async () => ({
        rows: [],
        diagnostics: [
          {
            code: 'recipe-context-unavailable',
            severity: 'warning',
            message:
              'RecipeContext (knowledgeService + recipeSourceRefRepository) is unavailable; returning region structure without Recipe mounts.',
            retryable: true,
          } satisfies MountDiagnostic,
        ],
      }),
      listRecipes: async () => [],
    };
  }

  return {
    resolveRegion,
    querySourceRefs: async (query) => {
      const envelope = await recipeContext.execute({
        kind: 'source-refs',
        payload: query.pathPrefix ? { pathPrefix: query.pathPrefix } : {},
      } as RecipeContextRequest);
      const data = envelope.data as RecipeContextSourceRefData;
      return {
        rows: (data.refs ?? []).map(
          (view): RecipeSourceRefRow => ({
            recipeId: view.recipeId,
            sourcePath: view.sourcePath,
            ...(view.status === undefined ? {} : { status: view.status }),
            ...(view.newPath === undefined || view.newPath === null
              ? {}
              : { newPath: view.newPath }),
          })
        ),
        diagnostics: envelopeDiagnostics(envelope),
      };
    },
    listRecipes: async () => {
      const records: RecipeRecordLite[] = [];
      const pageSize = 200;
      for (let page = 1; page <= 10_000; page += 1) {
        const envelope = await recipeContext.execute({
          kind: 'list',
          payload: { filter: {}, page, pageSize },
        } as RecipeContextRequest);
        const data = envelope.data as RecipeContextListData;
        const pageRecords = (data.recipes ?? []).map(toRecipeRecordLite);
        records.push(...pageRecords);
        const total = data.total ?? records.length;
        if (records.length >= total || pageRecords.length === 0) {
          return records;
        }
      }
      throw new Error('RecipeContext pagination exceeded the 10,000 page safety bound.');
    },
  };
}

function buildRecipeContextService(
  ctx: McpContext
): ReturnType<typeof createRecipeContextServiceFromCore> | null {
  const knowledge = safeGet(ctx, 'knowledgeService');
  const sourceRefRepository = safeGet(ctx, 'recipeSourceRefRepository');
  if (!knowledge || !sourceRefRepository) {
    return null;
  }
  // PDR-2b: wire VectorService so the region lane (searchRegions, Core-fixed) is
  // active; absent it the RecipeContextService degrades to no region retrieval.
  const vectorService = safeGet(ctx, 'vectorService');
  try {
    return createRecipeContextServiceFromCore({
      knowledge: knowledge as Parameters<typeof createRecipeContextServiceFromCore>[0]['knowledge'],
      sourceRefRepository: sourceRefRepository as Parameters<
        typeof createRecipeContextServiceFromCore
      >[0]['sourceRefRepository'],
      vectorService: (vectorService ?? null) as Parameters<
        typeof createRecipeContextServiceFromCore
      >[0]['vectorService'],
    });
  } catch {
    return null;
  }
}

function safeGet(ctx: McpContext, name: string): unknown {
  try {
    return ctx?.container?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function envelopeDiagnostics(
  envelope: RecipeContextEnvelope<RecipeContextResult>
): MountDiagnostic[] {
  return (envelope.errors ?? []).map((error) => ({
    code: `recipe-context-${error.code}`,
    severity: error.severity,
    message: error.message,
    ...(error.recipeId ? { recipeId: error.recipeId } : {}),
    ...(error.path ? { path: error.path } : {}),
    retryable: error.retryable,
  }));
}

function toRecipeRecordLite(record: RecipeContextRecipeRecord): RecipeRecordLite {
  return {
    id: record.id,
    title: record.title,
    ...(record.kind ? { kind: record.kind } : {}),
    ...(record.category ? { category: record.category } : {}),
    ...(record.dimensionId ? { dimensionId: record.dimensionId } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.moduleName ? { moduleName: record.moduleName } : {}),
    tags: record.tags ?? [],
    sources: record.sources ?? [],
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.lifecycle ? { lifecycle: record.lifecycle } : {}),
    ...(record.sourceFile === undefined || record.sourceFile === null
      ? {}
      : { sourceFile: record.sourceFile }),
  };
}
