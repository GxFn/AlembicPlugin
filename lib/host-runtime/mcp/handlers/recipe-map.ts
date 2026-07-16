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
  RECIPE_MAP_INLINE_BUDGET_BYTES,
  type RecipeMapDeps,
  type RecipeMapRequest,
  type RecipeRecordLite,
  type RecipeSourceRefRow,
} from '#service/project-knowledge-context/recipe-map/index.js';
import type { ProjectContextContinuationPage } from '#service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { resolvePublicKnowledgePublication } from '../../context/StrictPublicKnowledgeResolver.js';
import { resolveCertifiedGraphExecutionOptions } from './structure.js';
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
  servingCoverageOffset?: number;
  servingCoverageLimit?: number;
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
  const identity = requireRequestProjectRuntime(ctx).identity;
  const projectRoot = acceptedRecipeMapControlRoot(identity);
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
  const graphExecution = await resolveCertifiedGraphExecutionOptions(
    ctx,
    projectRoot,
    ctx.projectContextExecution
  );
  const deps = buildRecipeMapDeps(ctx, graphExecution, {
    limit: args.servingCoverageLimit,
    offset: args.servingCoverageOffset,
  });
  const output = execution
    ? await defaultRecipeMapProvider.resolveBoundedRecipeMap(request, deps)
    : await defaultRecipeMapProvider.resolveRecipeMap(request, deps);
  const factSessionRef = output.meta.factSessionRef;
  if (!execution || !factSessionRef) {
    return createAlembicRecipeMapMcpResult(budgetRecipeMapOutput(output));
  }
  const context = budgetRecipeMapOutput(recipeMapContinuationBase(output));
  const items = recipeMapPageEntries(output);
  const page = await execution.buildSessions.publishContinuation({
    context,
    factSessionRef,
    items,
    pageSize: recipeMapContinuationPageSize(context, items, args.pageSize ?? 100),
    projectRoot,
  });
  return createAlembicRecipeMapMcpResult(materializeRecipeMapContinuation(page));
}

function acceptedRecipeMapControlRoot(identity: {
  projectRoot: string;
  projectScope?: unknown;
}): string {
  const scope =
    identity.projectScope && typeof identity.projectScope === 'object'
      ? (identity.projectScope as Record<string, unknown>)
      : undefined;
  return typeof scope?.controlRoot === 'string' && scope.controlRoot.length > 0
    ? scope.controlRoot
    : identity.projectRoot;
}

type RecipeMapPageEntry =
  | { kind: 'node'; value: AlembicRecipeMapOutput['region']['nodes'][number] }
  | { kind: 'relation'; value: AlembicRecipeMapOutput['region']['relations'][number] }
  | { kind: 'ref'; value: AlembicRecipeMapOutput['refs'][number] }
  | { kind: 'mount'; value: AlembicRecipeMapOutput['recipeMounts'][number] }
  | { kind: 'rollup'; value: AlembicRecipeMapOutput['recipeRollups'][number] };

function recipeMapPageEntries(output: AlembicRecipeMapOutput): RecipeMapPageEntry[] {
  return [
    // Mounts lead the stream so conservation can truthfully report the
    // cumulative delivered mount projection on every later/terminal page.
    ...output.recipeMounts.map((value): RecipeMapPageEntry => ({ kind: 'mount', value })),
    ...output.region.nodes.map((value): RecipeMapPageEntry => ({ kind: 'node', value })),
    ...output.region.relations.map((value): RecipeMapPageEntry => ({ kind: 'relation', value })),
    ...output.refs.map((value): RecipeMapPageEntry => ({ kind: 'ref', value })),
    ...output.recipeRollups.map((value): RecipeMapPageEntry => ({ kind: 'rollup', value })),
  ];
}

function recipeMapContinuationBase(output: AlembicRecipeMapOutput): AlembicRecipeMapOutput {
  return {
    ...output,
    region: { ...output.region, nodes: [], relations: [] },
    refs: [],
    recipeMounts: [],
    recipeRollups: [],
    continuation: undefined,
    meta: {
      ...output.meta,
      continuationTotals: {
        mounts: output.recipeMounts.length,
        nodes: output.region.nodes.length,
        refs: output.refs.length,
        relations: output.region.relations.length,
        rollups: output.recipeRollups.length,
      },
    },
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
  const relations: AlembicRecipeMapOutput['region']['relations'] = [];
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
    if (entry.kind === 'relation') {
      relations.push(entry.value);
    }
    if (entry.kind === 'mount') {
      mounts.push(entry.value);
    }
    if (entry.kind === 'rollup') {
      rollups.push(entry.value);
    }
  }
  const pageMounts = mounts.length;
  const typeAccounting = recipeMapTypeAccounting(base, page, {
    mounts: pageMounts,
    nodes: nodes.length,
    refs: refs.length,
    relations: relations.length,
    rollups: rollups.length,
  });
  const rawPage = {
    ...base,
    status: page.hasMore && base.status === 'ready' ? 'partial' : base.status,
    summary: `${base.summary} Continuation page ${page.page}${page.hasMore ? ' has more facts.' : ' is terminal.'}`,
    region: { ...base.region, nodes, relations },
    refs,
    recipeMounts: mounts,
    recipeRollups: rollups,
    conservation: {
      ...base.conservation,
      displayedMounts: pageMounts,
      omittedMounts: Math.max(0, base.conservation.mountedTotal - pageMounts),
    },
    limits: {
      ...base.limits,
      appliedRecipeMountLimit: pageMounts,
      recipeMountLimitReason: recipeMapPageLimitReason(base, pageMounts),
    },
    continuation: {
      accumulatedCounts: page.accumulatedCounts,
      factSessionRef: page.factSessionRef,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      page: page.page,
      resultRef: page.resultRef,
      typeAccounting,
    },
  } satisfies AlembicRecipeMapOutput;
  // The generic budgeter temporarily rewrites conservation to this page's
  // inline mounts. Keep the terminal marker out of that intermediate parse;
  // terminal cumulative truth is restored immediately below.
  const budgetedPage = budgetRecipeMapOutput(
    page.hasMore
      ? rawPage
      : {
          ...rawPage,
          continuation: { ...rawPage.continuation, hasMore: true },
        }
  );
  const completeMountProjection = Math.min(
    base.limits.recipeMountLimit,
    base.conservation.mountedTotal
  );
  const cumulativeMounts = Math.min(page.accumulatedCounts.items, completeMountProjection);
  return {
    ...budgetedPage,
    summary: `${base.summary} Continuation page ${page.page} delivered ${cumulativeMounts} of ${base.conservation.mountedTotal} bounded mounts${page.hasMore ? ' and has more facts.' : ' and is terminal.'}`,
    conservation: {
      ...budgetedPage.conservation,
      displayedMounts: cumulativeMounts,
      omittedMounts: Math.max(0, base.conservation.mountedTotal - cumulativeMounts),
    },
    limits: {
      ...budgetedPage.limits,
      appliedRecipeMountLimit: cumulativeMounts,
      recipeMountLimitReason: recipeMapPageLimitReason(base, cumulativeMounts),
    },
    continuation: rawPage.continuation,
  };
}

function recipeMapContinuationPageSize(
  base: AlembicRecipeMapOutput,
  items: readonly RecipeMapPageEntry[],
  requestedPageSize: number
): number {
  const maximum = Math.max(
    1,
    Math.min(
      items.length || 1,
      Number.isFinite(requestedPageSize) ? Math.max(1, Math.trunc(requestedPageSize)) : 100
    )
  );
  let low = 1;
  let high = maximum;
  let selected = 0;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (recipeMapContinuationChunksFit(base, items, candidate)) {
      selected = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  if (selected === 0) {
    throw new Error(
      'Recipe Map continuation cannot preserve a stable item within the inline byte budget.'
    );
  }
  return selected;
}

function recipeMapContinuationChunksFit(
  base: AlembicRecipeMapOutput,
  items: readonly RecipeMapPageEntry[],
  pageSize: number
): boolean {
  if (items.length === 0) {
    return true;
  }
  const opaque = 'x'.repeat(240);
  for (let start = 0; start < items.length; start += pageSize) {
    const chunk = items.slice(start, start + pageSize);
    const hasMore = start + chunk.length < items.length;
    const output = materializeRecipeMapContinuation({
      accumulatedCounts: { items: start + chunk.length },
      context: base,
      factSessionRef: opaque,
      hasMore,
      items: chunk,
      nextCursor: hasMore ? opaque : null,
      page: Math.floor(start / pageSize) + 1,
      resultRef: opaque,
    });
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > RECIPE_MAP_INLINE_BUDGET_BYTES) {
      return false;
    }
    const expectedKeys = chunk.map(recipeMapPageEntryKey);
    const actualKeys = recipeMapPageEntries(output).map(recipeMapPageEntryKey);
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      return false;
    }
  }
  return true;
}

function recipeMapPageEntryKey(entry: RecipeMapPageEntry): string {
  if (entry.kind === 'node' || entry.kind === 'rollup') {
    return `${entry.kind}:${entry.value.nodeId}`;
  }
  if (entry.kind === 'ref') {
    return `ref:${entry.value.id}`;
  }
  if (entry.kind === 'relation') {
    return `relation:${entry.value.fromId}\u0000${entry.value.relationType}\u0000${entry.value.toId}`;
  }
  return `mount:${entry.value.recipeId}\u0000${entry.value.mountNodeId}\u0000${entry.value.mountType}`;
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
      completeness: 'incomplete',
      mountAccountingCompleteness: 'incomplete',
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
      typeAccounting: recipeMapCancelledTypeAccounting(base),
    },
  };
}

function recipeMapTypeAccounting(
  base: AlembicRecipeMapOutput,
  page: ProjectContextContinuationPage<RecipeMapPageEntry>,
  shown: { mounts: number; nodes: number; refs: number; relations: number; rollups: number }
) {
  const totals = requireRecipeMapContinuationTotals(base);
  let remainingBudget = page.accumulatedCounts.items;
  const cumulative = {
    mounts: Math.min(totals.mounts, remainingBudget),
    nodes: 0,
    refs: 0,
    relations: 0,
    rollups: 0,
  };
  remainingBudget -= cumulative.mounts;
  cumulative.nodes = Math.min(totals.nodes, Math.max(0, remainingBudget));
  remainingBudget -= cumulative.nodes;
  cumulative.relations = Math.min(totals.relations, Math.max(0, remainingBudget));
  remainingBudget -= cumulative.relations;
  cumulative.refs = Math.min(totals.refs, Math.max(0, remainingBudget));
  remainingBudget -= cumulative.refs;
  cumulative.rollups = Math.min(totals.rollups, Math.max(0, remainingBudget));
  return Object.fromEntries(
    (['mounts', 'nodes', 'relations', 'refs', 'rollups'] as const).map((kind) => [
      kind,
      {
        shown: shown[kind],
        total: totals[kind],
        remaining: totals[kind] - cumulative[kind],
        cumulative: cumulative[kind],
      },
    ])
  ) as NonNullable<AlembicRecipeMapOutput['continuation']>['typeAccounting'];
}

function recipeMapCancelledTypeAccounting(base: AlembicRecipeMapOutput) {
  const totals = requireRecipeMapContinuationTotals(base);
  return Object.fromEntries(
    (['mounts', 'nodes', 'relations', 'refs', 'rollups'] as const).map((kind) => [
      kind,
      { shown: 0, total: totals[kind], remaining: totals[kind], cumulative: 0 },
    ])
  ) as NonNullable<AlembicRecipeMapOutput['continuation']>['typeAccounting'];
}

function requireRecipeMapContinuationTotals(base: AlembicRecipeMapOutput) {
  const totals = base.meta.continuationTotals;
  if (!totals) {
    throw new Error('Recipe Map continuation is missing per-type totals.');
  }
  return totals;
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

function buildRecipeMapDeps(
  ctx: McpContext,
  graphExecution: Parameters<typeof defaultProjectGraphProvider.resolveProjectContextRegion>[1],
  servingCoveragePage: { limit?: number; offset?: number }
): RecipeMapDeps {
  const resolveRegion: RecipeMapDeps['resolveRegion'] = (focus, projectRoot, radius, nodeLimit) =>
    defaultProjectGraphProvider.resolveProjectContextRegion(
      { focus, projectRoot, radius, ...(nodeLimit === undefined ? {} : { nodeLimit }) },
      graphExecution
    );

  const recipeContext = buildRecipeContextService(ctx);
  const servingCoverage = strictServingCoverage(ctx, servingCoveragePage);
  const certifiedProbe = graphExecution?.certifiedProbe;
  const projectCoverage: RecipeMapDeps['projectCoverage'] = certifiedProbe
    ? {
        finalCoverageReceipt: {
          canonicalScopeHash: certifiedProbe.canonicalScopeHash,
          receiptHash: certifiedProbe.receiptHash,
          sourceVectorHash: certifiedProbe.observedSourceVectorHash,
        },
        status:
          certifiedProbe.comparisonStatus === 'matched' &&
          certifiedProbe.blockingReasons.length === 0
            ? 'complete'
            : 'partial',
      }
    : { finalCoverageReceipt: null, status: 'unavailable' };
  if (!recipeContext) {
    return {
      projectCoverage,
      servingCoverage,
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
    projectCoverage,
    servingCoverage,
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

function strictServingCoverage(
  ctx: McpContext,
  page: { limit?: number; offset?: number }
): RecipeMapDeps['servingCoverage'] {
  const runtime = requireRequestProjectRuntime(ctx);
  const publication = resolvePublicKnowledgePublication(runtime.identity);
  runtime.publication = publication.provenance;
  if (publication.state !== 'ready') {
    return null;
  }
  const cells = [...publication.finalCoverage.cells].sort((left, right) =>
    left.cellId.localeCompare(right.cellId)
  );
  const offset = Math.min(page.offset ?? 0, cells.length);
  const limit = Math.min(50, Math.max(1, page.limit ?? 25));
  const displayed = cells.slice(offset, offset + limit);
  const count = (disposition: (typeof cells)[number]['finalDisposition']) =>
    cells.filter((cell) => cell.finalDisposition === disposition).length;
  const nextOffset = offset + displayed.length < cells.length ? offset + displayed.length : null;
  const failed = count('failed');
  const unknown = count('unknown');
  return {
    source: 'strict-publication-v1',
    status: failed === 0 && unknown === 0 ? 'complete' : 'blocked',
    snapshotId: publication.route.snapshotId,
    receiptHash: publication.finalCoverage.receiptHash,
    totalCells: cells.length,
    coveredByReadyRecipe: count('covered-by-ready-recipe'),
    investigatedEmpty: count('investigated-empty'),
    failed,
    unknown,
    displayedCells: displayed.length,
    remainingCells: Math.max(0, cells.length - offset - displayed.length),
    cells: displayed.map((cell) => ({
      cellId: cell.cellId,
      finalDisposition: cell.finalDisposition,
      finalRecipeCount: cell.finalRecipeIds.length,
    })),
    continuation: { offset, limit, nextOffset, hasMore: nextOffset !== null },
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
