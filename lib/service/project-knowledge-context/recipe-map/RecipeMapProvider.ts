/**
 * GMAP-4/7 RecipeMapProvider — orchestrates the shared ProjectContext region
 * (GMAP-3) + recipe_source_refs/metadata (GMAP-2 RecipeContext) into the bounded,
 * Recipe-free-body AlembicRecipeMapOutput. The provider takes injected deps so the
 * deterministic engine is unit-testable without a DB or the MCP tool surface; the
 * handler wires the real region + RecipeContext. It never calls another MCP tool.
 */
import {
  ALEMBIC_RECIPE_MAP_OUTPUT_CONTRACT_VERSION,
  type AlembicRecipeMapOutput,
  AlembicRecipeMapOutputSchema,
  type AlembicRecipeMapStatus,
  type MapDiagnostic,
  type MapFocus,
  type MapNextAction,
  type MapNodeSummary,
  type MapRadius,
  type ProjectContextRegion,
  type RecipeMountSummary,
  type RecipeRollupSummary,
  type RegionFocus,
  type RegionNode,
} from '../contracts/index.js';
import {
  buildRegionIndex,
  compareMounts,
  type MountDiagnostic,
  type NormalizedRecipeRef,
  normalizeRecipeRef,
  type RecipeRecordLite,
  type RecipeSourceRefRow,
  selectMountTarget,
} from './mounting.js';

export interface RecipeMapRequest {
  focus: RegionFocus;
  rawFocus: MapFocus;
  projectRoot: string;
  radius: MapRadius;
  includeRecipes: boolean;
  includeRollups: boolean;
  recipeMountLimit: number;
  nodeLimit: number;
  detailLevel: 'summary' | 'standard' | 'detailed';
}

export interface RecipeMapDeps {
  resolveRegion(focus: RegionFocus, projectRoot: string): Promise<ProjectContextRegion>;
  querySourceRefs(query: {
    pathPrefix?: string;
  }): Promise<{ rows: RecipeSourceRefRow[]; diagnostics: MountDiagnostic[] }>;
  listRecipes(): Promise<RecipeRecordLite[]>;
}

const DEFAULT_REF_LIMIT = 80;

export class RecipeMapProvider {
  async resolveRecipeMap(
    request: RecipeMapRequest,
    deps: RecipeMapDeps
  ): Promise<AlembicRecipeMapOutput> {
    let region: ProjectContextRegion;
    try {
      region = await deps.resolveRegion(request.focus, request.projectRoot);
    } catch (error) {
      return failedRecipeMapOutput(request, error);
    }

    const diagnostics: MapDiagnostic[] = region.diagnostics.map(regionDiagnosticToMap);
    const index = buildRegionIndex(region);

    let mounts: RecipeMountSummary[] = [];
    let deferred: string[] = [];
    if (request.includeRecipes) {
      const collected = await collectRecipeMounts(region, index, deps, diagnostics);
      mounts = collected.mounts;
      deferred = collected.deferredRecipeIds;
    }
    mounts = mounts.sort(compareMounts).slice(0, request.recipeMountLimit);

    const rollups = request.includeRollups ? buildRollups(region, index, mounts, deferred) : [];
    const nodes = projectRegionNodes(region, index, mounts, deferred).slice(0, request.nodeLimit);
    const rootNode = mapNodeSummary(region.rootNode, index, mounts, deferred);
    const breadcrumb = region.breadcrumb.map((node) =>
      mapNodeSummary(node, index, mounts, deferred)
    );

    const status = deriveStatus(region, diagnostics, mounts);
    const summary = `alembic_recipe_map ${request.focus.kind} returned ${mounts.length} recipe mounts over ${nodes.length} region nodes (ProjectContext ${status}).`;

    return AlembicRecipeMapOutputSchema.parse({
      ok: status !== 'failed',
      status,
      tool: 'alembic_recipe_map',
      toolName: 'alembic_recipe_map',
      summary,
      project: region.project,
      focus: request.rawFocus,
      radius: request.radius,
      region: {
        rootNode,
        breadcrumb,
        nodes,
        truncated: region.truncated || region.nodes.length > nodes.length,
      },
      refs: region.refs.slice(0, DEFAULT_REF_LIMIT),
      recipeMounts: mounts,
      recipeRollups: rollups,
      diagnostics: dedupeMapDiagnostics(diagnostics).slice(0, 200),
      nextActions: buildNextActions(request, mounts),
      limits: {
        nodeLimit: request.nodeLimit,
        recipeMountLimit: request.recipeMountLimit,
        refLimit: DEFAULT_REF_LIMIT,
        detailLevel: request.detailLevel,
      },
      meta: {
        contractVersion: ALEMBIC_RECIPE_MAP_OUTPUT_CONTRACT_VERSION,
        outputSchema: 'AlembicRecipeMapOutput',
        producer: 'RecipeMapProvider',
      },
    });
  }
}

async function collectRecipeMounts(
  region: ProjectContextRegion,
  index: ReturnType<typeof buildRegionIndex>,
  deps: RecipeMapDeps,
  diagnostics: MapDiagnostic[]
): Promise<{ mounts: RecipeMountSummary[]; deferredRecipeIds: string[] }> {
  const scopePrefix = regionScopePrefix(region);
  const { rows, diagnostics: refDiagnostics } = await deps.querySourceRefs(
    scopePrefix ? { pathPrefix: scopePrefix } : {}
  );
  for (const diagnostic of refDiagnostics) {
    diagnostics.push(mountDiagnosticToMap(diagnostic));
  }
  const records = await deps.listRecipes();
  const recordById = new Map(records.map((record) => [record.id, record]));
  const rowsByRecipe = groupBy(rows, (row) => row.recipeId);

  // Candidate recipes = code recipes with refs in the region scope + global/
  // metadata-scope no-code recipes that apply to the focus region.
  const candidateIds = new Set<string>(rows.map((row) => row.recipeId));
  for (const record of records) {
    if (!rowsByRecipe.has(record.id) && noCodeRecipeAppliesToRegion(record, index)) {
      candidateIds.add(record.id);
    }
  }

  const mounts: RecipeMountSummary[] = [];
  const deferredRecipeIds: string[] = [];
  for (const recipeId of candidateIds) {
    const record = recordById.get(recipeId);
    if (!record) {
      continue;
    }
    const refs = normalizeRecipeRefs(record, rowsByRecipe.get(recipeId) ?? []);
    const { decision, diagnostics: mountDiagnostics } = selectMountTarget(record, refs, index);
    for (const diagnostic of mountDiagnostics) {
      diagnostics.push(mountDiagnosticToMap(diagnostic));
    }
    // Only surface mounts that land on a node visible in the queried region.
    if (!index.byId.has(decision.mountNodeId)) {
      continue;
    }
    // Code recipes whose real node is deeper than the region fall back to the
    // region root via source-ref-nearest-node. Per the Query Semantics, do not
    // dump them as direct mounts; defer them to descendant rollup counts.
    const isDeferredRollup =
      decision.mountType === 'source-ref-nearest-node' &&
      decision.mountNodeId === region.rootNode.nodeId &&
      refs.some((ref) => ref.filePath);
    if (isDeferredRollup) {
      deferredRecipeIds.push(record.id);
      continue;
    }
    mounts.push({
      recipeId: record.id,
      title: record.title,
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.category ? { category: record.category } : {}),
      ...(record.dimensionId ? { dimensionId: record.dimensionId } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
      mountNodeId: decision.mountNodeId,
      mountLevel: decision.mountLevel,
      mountType: decision.mountType,
      sourceRefs: refs.map((ref) => ref.raw).slice(0, 80),
      matchedRefs: decision.matchedRefs.slice(0, 80),
      reason: decision.reason,
      detailRef: `recipe:${record.id}`,
    });
  }
  return { mounts, deferredRecipeIds };
}

function normalizeRecipeRefs(
  record: RecipeRecordLite,
  rows: readonly RecipeSourceRefRow[]
): NormalizedRecipeRef[] {
  if (rows.length > 0) {
    return rows.map((row) =>
      normalizeRecipeRef(record.id, row.sourcePath, row.status, row.newPath)
    );
  }
  // Fall back to the Recipe record's own sources, then a weak sourceFile.
  const rawRefs =
    record.sources.length > 0 ? record.sources : record.sourceFile ? [record.sourceFile] : [];
  return rawRefs.map((raw) => normalizeRecipeRef(record.id, raw, 'active'));
}

function noCodeRecipeAppliesToRegion(
  record: RecipeRecordLite,
  index: ReturnType<typeof buildRegionIndex>
): boolean {
  const scope = (record.scope ?? '').toLowerCase();
  if (scope === 'global' || scope === 'space' || scope === 'project' || scope === 'architecture') {
    return true;
  }
  if ((record.category ?? '').toLowerCase().includes('architecture')) {
    return true;
  }
  if (record.moduleName) {
    return [...index.byId.values()].some(
      (node) => (node.kind === 'module' || node.kind === 'repo') && node.label === record.moduleName
    );
  }
  // No code refs and no usable scope: treat as global no-code.
  return record.sources.length === 0 && !record.sourceFile;
}

function buildRollups(
  region: ProjectContextRegion,
  index: ReturnType<typeof buildRegionIndex>,
  mounts: readonly RecipeMountSummary[],
  deferred: readonly string[]
): RecipeRollupSummary[] {
  return [region.rootNode, ...region.nodes]
    .map((node) => {
      const counts = recipeCountsForNode(node.nodeId, index, mounts, deferred);
      return {
        nodeId: node.nodeId,
        nodeKind: node.kind,
        directRecipeCount: counts.direct,
        descendantRecipeCount: counts.descendant,
        representativeRecipeIds: counts.representatives,
      };
    })
    .filter((rollup) => rollup.descendantRecipeCount > 0)
    .slice(0, 200);
}

function recipeCountsForNode(
  nodeId: string,
  index: ReturnType<typeof buildRegionIndex>,
  mounts: readonly RecipeMountSummary[],
  deferred: readonly string[]
): { direct: number; descendant: number; representatives: string[] } {
  const direct: string[] = [];
  const descendant: string[] = [];
  for (const mount of mounts) {
    if (mount.mountNodeId === nodeId) {
      direct.push(mount.recipeId);
      descendant.push(mount.recipeId);
    } else if (index.ancestorsOf(mount.mountNodeId).includes(nodeId)) {
      descendant.push(mount.recipeId);
    }
  }
  // Out-of-region deeper recipes roll up as descendants of the region root.
  if (nodeId === index.rootNodeId) {
    descendant.push(...deferred);
  }
  return {
    direct: direct.length,
    descendant: descendant.length,
    representatives: [...new Set([...direct, ...descendant])].slice(0, 10),
  };
}

function projectRegionNodes(
  region: ProjectContextRegion,
  index: ReturnType<typeof buildRegionIndex>,
  mounts: readonly RecipeMountSummary[],
  deferred: readonly string[]
): MapNodeSummary[] {
  return region.nodes.map((node) => mapNodeSummary(node, index, mounts, deferred));
}

function mapNodeSummary(
  node: RegionNode,
  index: ReturnType<typeof buildRegionIndex>,
  mounts: readonly RecipeMountSummary[],
  deferred: readonly string[]
): MapNodeSummary {
  const counts = recipeCountsForNode(node.nodeId, index, mounts, deferred);
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    label: node.label,
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.projectContextRef === undefined ? {} : { projectContextRef: node.projectContextRef }),
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    ...(node.childCount === undefined ? {} : { childCount: node.childCount }),
    directRecipeCount: counts.direct,
    descendantRecipeCount: counts.descendant,
    representativeRecipeIds: counts.representatives,
  };
}

function regionScopePrefix(region: ProjectContextRegion): string | undefined {
  const path = region.rootNode.path;
  if (!path || path === '.' || region.focus.kind === 'space') {
    return undefined;
  }
  // For a file focus use its directory so sibling refs in the same module mount.
  if (region.rootNode.kind === 'file') {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : undefined;
  }
  return path;
}

function buildNextActions(
  request: RecipeMapRequest,
  mounts: readonly RecipeMountSummary[]
): MapNextAction[] {
  const actions: MapNextAction[] = [
    {
      tool: 'alembic_graph',
      reason: 'Drill into pure ProjectContext structure, relations, or source for this region.',
      focusKind: request.focus.kind,
      required: false,
    },
  ];
  if (mounts.length > 0) {
    actions.push({
      tool: 'alembic_search',
      reason: 'Open a mounted Recipe by id (operation=get) for its full detail and body.',
      refId: mounts[0]?.detailRef,
      required: false,
    });
  }
  actions.push({
    tool: 'alembic_prime',
    reason: 'Use alembic_prime for task-semantic Recipe selection rather than structural mounting.',
    required: false,
  });
  return actions.slice(0, 20);
}

function deriveStatus(
  region: ProjectContextRegion,
  diagnostics: readonly MapDiagnostic[],
  mounts: readonly RecipeMountSummary[]
): AlembicRecipeMapStatus {
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (hasError) {
    return 'degraded';
  }
  const degradedMount = mounts.some((mount) => mount.mountType.startsWith('degraded-'));
  if (region.truncated || diagnostics.length > 0 || degradedMount) {
    return 'partial';
  }
  return 'ready';
}

function regionDiagnosticToMap(diagnostic: {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  retryable: boolean;
}): MapDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    retryable: diagnostic.retryable,
  };
}

function mountDiagnosticToMap(diagnostic: MountDiagnostic): MapDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.recipeId ? { recipeId: diagnostic.recipeId } : {}),
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    retryable: diagnostic.retryable,
  };
}

function dedupeMapDiagnostics(diagnostics: MapDiagnostic[]): MapDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code} ${diagnostic.recipeId ?? ''} ${diagnostic.message}`,
        diagnostic,
      ])
    ).values(),
  ];
}

function failedRecipeMapOutput(request: RecipeMapRequest, error: unknown): AlembicRecipeMapOutput {
  return AlembicRecipeMapOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_recipe_map',
    toolName: 'alembic_recipe_map',
    summary: `alembic_recipe_map ${request.focus.kind} failed before the region could be projected.`,
    project: { projectRoot: request.projectRoot },
    focus: request.rawFocus,
    radius: request.radius,
    region: {
      rootNode: {
        nodeId: 'project:unknown',
        kind: 'space',
        label: 'unknown',
        directRecipeCount: 0,
        descendantRecipeCount: 0,
        representativeRecipeIds: [],
      },
      breadcrumb: [],
      nodes: [],
      truncated: false,
    },
    refs: [],
    recipeMounts: [],
    recipeRollups: [],
    diagnostics: [
      {
        code: 'recipe-map-region-failed',
        severity: 'error',
        message: `ProjectContext region projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: true,
      },
    ],
    nextActions: [],
    limits: {
      nodeLimit: request.nodeLimit,
      recipeMountLimit: request.recipeMountLimit,
      refLimit: DEFAULT_REF_LIMIT,
      detailLevel: request.detailLevel,
    },
    meta: {
      contractVersion: ALEMBIC_RECIPE_MAP_OUTPUT_CONTRACT_VERSION,
      outputSchema: 'AlembicRecipeMapOutput',
      producer: 'RecipeMapProvider',
    },
  });
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

export const defaultRecipeMapProvider = new RecipeMapProvider();
