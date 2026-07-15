/**
 * GMAP-4/7 RecipeMapProvider — orchestrates the shared ProjectContext region
 * (GMAP-3) + recipe_source_refs/metadata (GMAP-2 RecipeContext) into the bounded,
 * Recipe-free-body AlembicRecipeMapOutput. The provider takes injected deps so the
 * deterministic engine is unit-testable without a DB or the MCP tool surface; the
 * handler wires the real region + RecipeContext. It never calls another MCP tool.
 */

import { jsonByteLength } from '@alembic/core/service/planFacts';
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
  resolveRegion(
    focus: RegionFocus,
    projectRoot: string,
    radius: MapRadius
  ): Promise<ProjectContextRegion>;
  querySourceRefs(query: {
    pathPrefix?: string;
  }): Promise<{ rows: RecipeSourceRefRow[]; diagnostics: MountDiagnostic[] }>;
  listRecipes(): Promise<RecipeRecordLite[]>;
}

const DEFAULT_REF_LIMIT = 80;
export const RECIPE_MAP_INLINE_BUDGET_BYTES = 20 * 1024;
const RECIPE_MAP_TRUTH_BUDGET_BYTES = 14 * 1024;

export class RecipeMapProvider {
  async resolveRecipeMap(
    request: RecipeMapRequest,
    deps: RecipeMapDeps
  ): Promise<AlembicRecipeMapOutput> {
    return budgetRecipeMapOutput(await this.resolveBoundedRecipeMap(request, deps));
  }

  async resolveBoundedRecipeMap(
    request: RecipeMapRequest,
    deps: RecipeMapDeps
  ): Promise<AlembicRecipeMapOutput> {
    let region: ProjectContextRegion;
    try {
      region = await deps.resolveRegion(request.focus, request.projectRoot, request.radius);
    } catch (error) {
      return failedRecipeMapOutput(request, error);
    }

    let diagnostics: MapDiagnostic[] = region.diagnostics.map(regionDiagnosticToMap);
    const index = buildRegionIndex(region);

    let mounts: RecipeMountSummary[] = [];
    let deferred: string[] = [];
    let candidateRecipeCount = 0;
    let uncoveredRecipeCount = 0;
    let usedRecordSourceFallback = false;
    if (request.includeRecipes) {
      const collected = await collectRecipeMounts(region, index, deps, diagnostics);
      mounts = collected.mounts;
      deferred = collected.deferredRecipeIds;
      candidateRecipeCount = collected.candidateRecipeCount;
      uncoveredRecipeCount = collected.uncoveredRecipes.length;
      usedRecordSourceFallback = collected.usedRecordSourceFallback;
      if (collected.uncoveredRecipes.length > 0) {
        const sample = collected.uncoveredRecipes
          .slice(0, 5)
          .map((recipe) => recipe.title)
          .join(', ');
        const overflow =
          collected.uncoveredRecipes.length > 5
            ? ` (+${collected.uncoveredRecipes.length - 5} more)`
            : '';
        diagnostics.push({
          code: 'recipes-outside-region',
          severity: 'info',
          message: `${collected.uncoveredRecipes.length} recipe(s) have no mount in this region: ${sample}${overflow}. Focus a repo/module/file to inspect a narrower complete region.`,
          retryable: false,
        });
      }
    }
    const allMounts = mounts.sort(compareMounts);
    const displayedMounts = allMounts.slice(0, request.recipeMountLimit);
    if (usedRecordSourceFallback && mounts.length + deferred.length > 0) {
      diagnostics = suppressResolvedSourceRefMissDiagnostics(diagnostics);
    }

    const rollups = request.includeRollups ? buildRollups(region, index, allMounts, deferred) : [];
    const nodes = projectRegionNodes(region, index, allMounts, deferred).slice(
      0,
      request.nodeLimit
    );
    const rootNode = mapNodeSummary(region.rootNode, index, allMounts, deferred);
    const breadcrumb = region.breadcrumb.map((node) =>
      mapNodeSummary(node, index, allMounts, deferred)
    );

    const boundedDiagnostics = dedupeMapDiagnostics(diagnostics).slice(0, 200);
    const status = deriveStatus(region, boundedDiagnostics, allMounts);
    const summary = `alembic_recipe_map ${request.focus.kind} displayed ${displayedMounts.length} of ${allMounts.length} recipe mounts over ${nodes.length} region nodes (ProjectContext ${status}).`;

    const output = AlembicRecipeMapOutputSchema.parse({
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
        relations: region.relations,
        truncated: region.truncated || region.nodes.length > nodes.length,
      },
      refs: region.refs.slice(0, DEFAULT_REF_LIMIT),
      recipeMounts: displayedMounts,
      recipeRollups: rollups,
      conservation: {
        candidateRecipes: candidateRecipeCount,
        mountedTotal: allMounts.length,
        deferredTotal: deferred.length,
        uncoveredTotal: uncoveredRecipeCount,
        displayedMounts: displayedMounts.length,
        omittedMounts: allMounts.length - displayedMounts.length,
        completeness: 'complete',
        mountAccountingCompleteness: 'complete',
      },
      projectCoverageStatus: 'unavailable',
      finalCoverageReceipt: null,
      diagnostics: boundedDiagnostics,
      nextActions: buildNextActions(request, displayedMounts, boundedDiagnostics),
      limits: {
        nodeLimit: request.nodeLimit,
        recipeMountLimit: request.recipeMountLimit,
        appliedRecipeMountLimit: displayedMounts.length,
        recipeMountLimitReason: recipeMountLimitReason(
          request.recipeMountLimit,
          allMounts.length,
          displayedMounts.length
        ),
        refLimit: DEFAULT_REF_LIMIT,
        detailLevel: request.detailLevel,
      },
      meta: {
        contractVersion: ALEMBIC_RECIPE_MAP_OUTPUT_CONTRACT_VERSION,
        fullMapRef: null,
        outputSchema: 'AlembicRecipeMapOutput',
        producer: 'RecipeMapProvider',
        ...(region.meta?.factSessionRef ? { factSessionRef: region.meta.factSessionRef } : {}),
        ...(region.meta?.factFingerprint ? { factFingerprint: region.meta.factFingerprint } : {}),
      },
    });
    return output;
  }
}

export function budgetRecipeMapOutput(output: AlembicRecipeMapOutput): AlembicRecipeMapOutput {
  const fullInline = attachFullMapRef(output, null);
  const truthProjection = projectRecipeMapTruth(fullInline);
  return AlembicRecipeMapOutputSchema.parse(
    fitRecipeMountPresentation(truthProjection, fullInline.recipeMounts)
  );
}

function attachFullMapRef(
  output: AlembicRecipeMapOutput,
  fullMapRef: null
): AlembicRecipeMapOutput {
  return {
    ...output,
    meta: {
      ...output.meta,
      fullMapRef,
    },
  };
}

/**
 * Select a deterministic truth-field projection without considering the requested mount limit.
 * This prevents presentation bytes from changing region/rollup/diagnostic facts.
 */
function projectRecipeMapTruth(output: AlembicRecipeMapOutput): AlembicRecipeMapOutput {
  const basis = withRecipeMountPresentation(output, []);
  const caps = [
    { diagnostics: 200, nodes: 500, refs: 200, repIds: 20, rollups: 200 },
    { diagnostics: 80, nodes: 120, refs: 40, repIds: 5, rollups: 100 },
    { diagnostics: 40, nodes: 60, refs: 20, repIds: 3, rollups: 60 },
    { diagnostics: 20, nodes: 24, refs: 8, repIds: 3, rollups: 24 },
    { diagnostics: 10, nodes: 10, refs: 4, repIds: 2, rollups: 10 },
    { diagnostics: 5, nodes: 5, refs: 2, repIds: 1, rollups: 5 },
  ];
  const selected =
    caps.find(
      (candidate) =>
        jsonByteLength(trimRecipeMapArrays(basis, candidate)) <= RECIPE_MAP_TRUTH_BUDGET_BYTES
    ) ?? caps[5];
  return trimRecipeMapArrays(output, selected);
}

/** Fit only the mount presentation into the bytes left after the stable truth projection. */
function fitRecipeMountPresentation(
  truthProjection: AlembicRecipeMapOutput,
  requestedMounts: readonly RecipeMountSummary[]
): AlembicRecipeMapOutput {
  for (const refsPerMount of [8, 3, 1, 0]) {
    const compactMounts = requestedMounts.map((mount) => ({
      ...mount,
      sourceRefs: mount.sourceRefs.slice(0, refsPerMount),
      matchedRefs: mount.matchedRefs.slice(0, refsPerMount),
    }));
    const candidate = withRecipeMountPresentation(truthProjection, compactMounts);
    if (jsonByteLength(candidate) <= RECIPE_MAP_INLINE_BUDGET_BYTES) {
      return candidate;
    }
  }

  const refFree = requestedMounts.map((mount) => ({
    ...mount,
    sourceRefs: [],
    matchedRefs: [],
  }));
  let low = 0;
  let high = refFree.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = withRecipeMountPresentation(truthProjection, refFree.slice(0, mid));
    if (jsonByteLength(candidate) <= RECIPE_MAP_INLINE_BUDGET_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return withRecipeMountPresentation(truthProjection, refFree.slice(0, low));
}

function withRecipeMountPresentation(
  output: AlembicRecipeMapOutput,
  mounts: readonly RecipeMountSummary[]
): AlembicRecipeMapOutput {
  const displayedMounts = mounts.length;
  return {
    ...output,
    summary: `alembic_recipe_map ${output.focus.kind} displayed ${displayedMounts} of ${output.conservation.mountedTotal} recipe mounts over ${output.region.nodes.length} region nodes (ProjectContext ${output.status}).`,
    recipeMounts: [...mounts],
    conservation: {
      ...output.conservation,
      displayedMounts,
      omittedMounts: output.conservation.mountedTotal - displayedMounts,
    },
    limits: {
      ...output.limits,
      appliedRecipeMountLimit: displayedMounts,
      recipeMountLimitReason: recipeMountLimitReason(
        output.limits.recipeMountLimit,
        output.conservation.mountedTotal,
        displayedMounts
      ),
    },
  };
}

function recipeMountLimitReason(
  requestedLimit: number,
  mountedTotal: number,
  displayedMounts: number
): AlembicRecipeMapOutput['limits']['recipeMountLimitReason'] {
  if (displayedMounts < Math.min(requestedLimit, mountedTotal)) {
    return 'inline-byte-budget';
  }
  return mountedTotal < requestedLimit ? 'available-mounts' : 'requested-limit';
}

function trimRecipeMapArrays(
  output: AlembicRecipeMapOutput,
  caps: { diagnostics: number; nodes: number; refs: number; repIds: number; rollups: number }
): AlembicRecipeMapOutput {
  const trimRepIds = <T extends { representativeRecipeIds: string[] }>(node: T): T => ({
    ...node,
    representativeRecipeIds: node.representativeRecipeIds.slice(0, caps.repIds),
  });
  const nodes = output.region.nodes.slice(0, caps.nodes).map(trimRepIds);
  return {
    ...output,
    refs: output.refs.slice(0, caps.refs),
    region: {
      ...output.region,
      rootNode: trimRepIds(output.region.rootNode),
      breadcrumb: output.region.breadcrumb.map(trimRepIds),
      nodes,
      truncated: output.region.truncated || output.region.nodes.length > nodes.length,
    },
    recipeRollups: output.recipeRollups.slice(0, caps.rollups).map(trimRepIds),
    diagnostics: output.diagnostics.slice(0, caps.diagnostics),
  };
}

async function collectRecipeMounts(
  region: ProjectContextRegion,
  index: ReturnType<typeof buildRegionIndex>,
  deps: RecipeMapDeps,
  diagnostics: MapDiagnostic[]
): Promise<{
  candidateRecipeCount: number;
  deferredRecipeIds: string[];
  mounts: RecipeMountSummary[];
  uncoveredRecipes: Array<{ id: string; title: string }>;
  usedRecordSourceFallback: boolean;
}> {
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
  let usedRecordSourceFallback = false;
  for (const record of records) {
    if (!rowsByRecipe.has(record.id) && recordFallbackRefsApplyToScope(record, scopePrefix)) {
      candidateIds.add(record.id);
      usedRecordSourceFallback = true;
      continue;
    }
    if (!rowsByRecipe.has(record.id) && noCodeRecipeAppliesToRegion(record, index, region)) {
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
  // M2 未入区诊断（2026-07-06）：库内 recipe 在本 region 既无 mount 也未进
  // deferred rollup 的清单——space 级 rollup 61≠75 这类差值的可解释面。
  const coveredIds = new Set<string>([
    ...mounts.map((mount) => mount.recipeId),
    ...deferredRecipeIds,
  ]);
  const uncoveredRecipes = [...recordById.values()]
    .filter((record) => !coveredIds.has(record.id))
    .map((record) => ({ id: record.id, title: record.title }));
  return {
    candidateRecipeCount: records.length,
    mounts,
    deferredRecipeIds,
    uncoveredRecipes,
    usedRecordSourceFallback,
  };
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

function recordFallbackRefsApplyToScope(record: RecipeRecordLite, scopePrefix?: string): boolean {
  const refs = normalizeRecipeRefs(record, []);
  const codeRefs = refs.filter((ref) => ref.filePath);
  if (codeRefs.length === 0) {
    return false;
  }
  if (!scopePrefix) {
    return true;
  }
  const normalizedScope = normalizeRecipeRef(record.id, scopePrefix, 'active').filePath;
  if (!normalizedScope) {
    return true;
  }
  return codeRefs.some(
    (ref) => ref.filePath === normalizedScope || ref.filePath?.startsWith(`${normalizedScope}/`)
  );
}

function noCodeRecipeAppliesToRegion(
  record: RecipeRecordLite,
  index: ReturnType<typeof buildRegionIndex>,
  region: ProjectContextRegion
): boolean {
  const scope = (record.scope ?? '').toLowerCase();
  const broadFocus = metadataOnlyRecipeCanMountAtRoot(region.rootNode.kind);
  if (scope === 'global' || scope === 'space' || scope === 'project' || scope === 'architecture') {
    return broadFocus;
  }
  if ((record.category ?? '').toLowerCase().includes('architecture')) {
    return broadFocus;
  }
  if (record.moduleName) {
    return [...index.byId.values()].some(
      (node) => (node.kind === 'module' || node.kind === 'repo') && node.label === record.moduleName
    );
  }
  // No code refs and no usable scope are project-wide guidance only. Do not
  // attach them to a focused file/symbol as if they were local evidence.
  return broadFocus && record.sources.length === 0 && !record.sourceFile && !record.scope;
}

function metadataOnlyRecipeCanMountAtRoot(kind: RegionNode['kind']): boolean {
  return (
    kind === 'space' ||
    kind === 'repo' ||
    kind === 'map' ||
    kind === 'module' ||
    kind === 'module-layer' ||
    kind === 'directory'
  );
}

function buildRollups(
  region: ProjectContextRegion,
  index: ReturnType<typeof buildRegionIndex>,
  mounts: readonly RecipeMountSummary[],
  deferred: readonly string[]
): RecipeRollupSummary[] {
  return [
    ...new Map([region.rootNode, ...region.nodes].map((node) => [node.nodeId, node])).values(),
  ]
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
    representatives: [...new Set([...direct, ...descendant])].slice(0, 2),
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
  mounts: readonly RecipeMountSummary[],
  diagnostics: readonly MapDiagnostic[]
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
  if (diagnostics.some(needsSourceRefReconciliation)) {
    const hasDriftedRef = diagnostics.some((diagnostic) =>
      /drift/.test(`${diagnostic.code} ${diagnostic.message}`.toLowerCase())
    );
    actions.push({
      tool: 'alembic_rescan',
      reason: hasDriftedRef
        ? 'Reconcile drifted source-ref anchors whose files still exist but whose anchored content changed; alembic_recipe_map remains read-only and performs no repair.'
        : 'Reconcile stale or unresolved source-ref anchors with an authorized rescan; alembic_recipe_map remains read-only and performs no repair.',
      required: false,
    });
  }
  return actions.slice(0, 20);
}

function needsSourceRefReconciliation(diagnostic: MapDiagnostic): boolean {
  const text = `${diagnostic.code} ${diagnostic.message} ${diagnostic.path ?? ''}`.toLowerCase();
  return /source[- ]?ref|stale|drift|unresolved/.test(text);
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
        `${diagnostic.code}\u0000${diagnostic.recipeId ?? ''}\u0000${canonicalizeSingleLineAnchor(
          diagnostic.path ?? ''
        )}\u0000${canonicalizeSingleLineAnchor(diagnostic.message)}`,
        diagnostic,
      ])
    ).values(),
  ];
}

function canonicalizeSingleLineAnchor(value: string): string {
  return value.replace(/:(\d+)-\1\b/g, ':$1');
}

function suppressResolvedSourceRefMissDiagnostics(diagnostics: MapDiagnostic[]): MapDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      !(
        diagnostic.code === 'recipe-context-unresolved' &&
        /No source refs matched the query/i.test(diagnostic.message)
      )
  );
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
      relations: [],
      truncated: false,
    },
    refs: [],
    recipeMounts: [],
    recipeRollups: [],
    conservation: {
      candidateRecipes: 0,
      mountedTotal: 0,
      deferredTotal: 0,
      uncoveredTotal: 0,
      displayedMounts: 0,
      omittedMounts: 0,
      completeness: 'unknown',
      mountAccountingCompleteness: 'unknown',
    },
    projectCoverageStatus: 'unavailable',
    finalCoverageReceipt: null,
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
      appliedRecipeMountLimit: 0,
      recipeMountLimitReason: recipeMountLimitReason(request.recipeMountLimit, 0, 0),
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
