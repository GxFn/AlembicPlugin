/**
 * GMAP-6 deterministic Recipe mounting engine.
 *
 * Mounting uses ONLY recipe_source_refs + explicit metadata — never semantic or
 * keyword search, even when a search/vector lane is available. Mount targets are
 * chosen against the shared GMAP-3 ProjectContextRegion (LCA via region parentage),
 * so recipe_map mounts onto the exact same nodes/refs alembic_graph exposes.
 */
import type { ProjectContextRegion, RecipeMountType, RegionNode } from '../contracts/index.js';

export type RecipeRefStatus = 'active' | 'stale' | 'renamed' | 'unresolved' | 'metadata-only';

/** A recipe_source_refs row (subset the mounting engine reads). */
export interface RecipeSourceRefRow {
  recipeId: string;
  sourcePath: string;
  status?: string;
  newPath?: string | null;
}

/** Minimal Recipe metadata record (no full body). */
export interface RecipeRecordLite {
  id: string;
  title: string;
  kind?: string;
  category?: string;
  dimensionId?: string;
  scope?: string;
  moduleName?: string;
  tags: string[];
  sources: string[];
  summary?: string;
  lifecycle?: string;
  sourceFile?: string | null;
}

export interface NormalizedRecipeRef {
  recipeId: string;
  raw: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  status: RecipeRefStatus;
  newPath?: string;
}

export interface MountDecision {
  mountNodeId: string;
  mountLevel: RegionNode['kind'];
  mountType: RecipeMountType;
  matchedRefs: string[];
  reason: string;
}

export interface MountDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  recipeId?: string;
  path?: string;
  retryable: boolean;
}

// ─── Ref normalization ───────────────────────────────────────

const REF_STATUS_VALUES = new Set<RecipeRefStatus>([
  'active',
  'stale',
  'renamed',
  'unresolved',
  'metadata-only',
]);

export function normalizeRecipeRef(
  recipeId: string,
  raw: string,
  status?: string,
  newPath?: string | null
): NormalizedRecipeRef {
  const normalizedStatus = normalizeRefStatus(status);
  const parsed = parseRefPath(raw);
  return {
    recipeId,
    raw,
    ...(parsed.filePath ? { filePath: parsed.filePath } : {}),
    ...(parsed.startLine === undefined ? {} : { startLine: parsed.startLine }),
    ...(parsed.endLine === undefined ? {} : { endLine: parsed.endLine }),
    status: parsed.filePath ? normalizedStatus : 'metadata-only',
    ...(newPath ? { newPath: normalizeRefPathString(newPath) } : {}),
  };
}

function normalizeRefStatus(status?: string): RecipeRefStatus {
  if (status && REF_STATUS_VALUES.has(status as RecipeRefStatus)) {
    return status as RecipeRefStatus;
  }
  return status ? 'active' : 'active';
}

// Parse `path`, `path:10`, `path:L10`, `path:10-20`, `path:L10-L20`, `path#L10`.
function parseRefPath(raw: string): { filePath?: string; startLine?: number; endLine?: number } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }
  const hashSplit = trimmed.split('#');
  const head = hashSplit[0] ?? trimmed;
  const lineSpecFromHash = hashSplit.length > 1 ? hashSplit.slice(1).join('#') : undefined;
  const colonIndex = head.lastIndexOf(':');
  let pathPart = head;
  let lineSpec = lineSpecFromHash;
  if (lineSpec === undefined && colonIndex > 1) {
    const after = head.slice(colonIndex + 1);
    if (/^[Ll]?\d+(?:\s*-\s*[Ll]?\d+)?$/.test(after)) {
      pathPart = head.slice(0, colonIndex);
      lineSpec = after;
    }
  }
  const filePath = normalizeRefPathString(pathPart);
  if (!filePath) {
    return {};
  }
  const lines = parseLineSpec(lineSpec);
  return { filePath, ...lines };
}

function parseLineSpec(spec?: string): { startLine?: number; endLine?: number } {
  if (!spec) {
    return {};
  }
  const match = spec.match(/^[Ll]?(\d+)(?:\s*-\s*[Ll]?(\d+))?$/);
  if (!match) {
    return {};
  }
  const startLine = Number(match[1]);
  const endLine = match[2] ? Number(match[2]) : startLine;
  if (!Number.isFinite(startLine)) {
    return {};
  }
  return { startLine, endLine: Number.isFinite(endLine) ? endLine : startLine };
}

function normalizeRefPathString(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return normalized.length > 0 ? normalized : undefined;
}

// ─── Region index (node lookup + ancestry/LCA) ───────────────

export interface RegionIndex {
  rootNodeId: string;
  byId: Map<string, RegionNode>;
  ancestorsOf(nodeId: string): string[];
  nodeForPath(filePath: string): RegionNode | undefined;
  lca(nodeIds: readonly string[]): string;
}

export function buildRegionIndex(region: ProjectContextRegion): RegionIndex {
  const byId = new Map<string, RegionNode>();
  for (const node of [region.rootNode, ...region.breadcrumb, ...region.nodes]) {
    if (!byId.has(node.nodeId)) {
      byId.set(node.nodeId, node);
    }
  }
  const rootNodeId = region.rootNode.nodeId;

  const ancestorsOf = (nodeId: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>([nodeId]);
    let current = byId.get(nodeId)?.parentNodeId;
    while (current && !seen.has(current) && chain.length < 64) {
      seen.add(current);
      chain.push(current);
      current = byId.get(current)?.parentNodeId;
    }
    if (!chain.includes(rootNodeId) && nodeId !== rootNodeId) {
      chain.push(rootNodeId);
    }
    return chain;
  };

  const nodeForPath = (filePath: string): RegionNode | undefined => {
    const target = normalizeRefPathString(filePath);
    if (!target) {
      return undefined;
    }
    // Exact path match. A path:line source ref mounts to the FILE node, not a
    // symbol/slice that happens to share the file path.
    const exact = [...byId.values()]
      .filter((node) => node.path && normalizeRefPathString(node.path) === target)
      .sort((a, b) => pathMountRank(a.kind) - pathMountRank(b.kind))[0];
    if (exact) {
      return exact;
    }
    // Nearest visible ancestor by longest owning path prefix.
    return [...byId.values()]
      .filter((node) => node.path && pathOwns(normalizeRefPathString(node.path) ?? '', target))
      .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
  };

  const lca = (nodeIds: readonly string[]): string => {
    const present = nodeIds.filter((id) => byId.has(id));
    if (present.length === 0) {
      return rootNodeId;
    }
    if (present.length === 1) {
      return present[0] as string;
    }
    // Intersect ancestor chains (each chain includes the node itself first).
    let common: string[] | null = null;
    for (const id of present) {
      const chain = [id, ...ancestorsOf(id)];
      common = common === null ? chain : common.filter((node) => chain.includes(node));
    }
    // The deepest shared ancestor = first chain entry of the first node that is in common.
    const firstChain = [present[0] as string, ...ancestorsOf(present[0] as string)];
    for (const candidate of firstChain) {
      if (common?.includes(candidate)) {
        return candidate;
      }
    }
    return rootNodeId;
  };

  return { rootNodeId, byId, ancestorsOf, nodeForPath, lca };
}

// Ranking for resolving a path:line source ref to a mount node: prefer the file
// node over a symbol/slice that merely shares the file path.
function pathMountRank(kind: RegionNode['kind']): number {
  const order: Record<string, number> = {
    file: 0,
    'source-slice': 1,
    'anchor-range': 1,
    directory: 2,
    'module-layer': 2,
    module: 3,
    map: 4,
    repo: 5,
    space: 6,
    symbol: 8,
  };
  return order[kind] ?? 9;
}

function regionKindRank(kind: RegionNode['kind']): number {
  // Lower = more specific (preferred as exact mount target).
  const order: Record<string, number> = {
    symbol: 0,
    'source-slice': 1,
    'anchor-range': 1,
    file: 2,
    'module-layer': 3,
    directory: 3,
    module: 4,
    map: 5,
    repo: 6,
    space: 7,
  };
  return order[kind] ?? 9;
}

function pathOwns(ownerPath: string, filePath: string): boolean {
  if (!ownerPath || ownerPath === '.') {
    return true;
  }
  return filePath === ownerPath || filePath.startsWith(`${ownerPath}/`);
}

// ─── Mount target selection (deterministic) ──────────────────

const GLOBAL_SCOPE_HINTS = new Set([
  'global',
  'space',
  'project',
  'project-wide',
  'architecture',
  'workspace',
  'all',
]);

export function selectMountTarget(
  recipe: RecipeRecordLite,
  refs: readonly NormalizedRecipeRef[],
  index: RegionIndex
): { decision: MountDecision; diagnostics: MountDiagnostic[] } {
  const diagnostics: MountDiagnostic[] = [];
  const codeRefs = refs.filter((ref) => ref.filePath);
  const liveRefs = codeRefs.filter((ref) => ref.status === 'active' || ref.status === 'renamed');
  const degraded = codeRefs.filter((ref) => ref.status === 'stale' || ref.status === 'unresolved');

  for (const ref of degraded) {
    diagnostics.push({
      code: ref.status === 'stale' ? 'recipe-stale-ref' : 'recipe-unresolved-ref',
      severity: 'warning',
      message: `Recipe ${recipe.id} has a ${ref.status} source ref: ${ref.raw}`,
      recipeId: recipe.id,
      ...(ref.filePath ? { path: ref.filePath } : {}),
      retryable: false,
    });
  }

  // No code refs → metadata-only mounting.
  if (codeRefs.length === 0) {
    return { decision: metadataOnlyDecision(recipe, index, diagnostics), diagnostics };
  }

  // No live refs but degraded ones exist → degraded mount at nearest visible node.
  if (liveRefs.length === 0) {
    const sample = degraded[0] as NormalizedRecipeRef;
    const node =
      (sample.filePath ? index.nodeForPath(sample.filePath) : undefined) ??
      index.byId.get(index.rootNodeId);
    return {
      decision: {
        mountNodeId: node?.nodeId ?? index.rootNodeId,
        mountLevel: node?.kind ?? 'space',
        mountType: sample.status === 'stale' ? 'degraded-stale' : 'degraded-unresolved',
        matchedRefs: degraded.map((ref) => ref.raw),
        reason: `All source refs are ${sample.status}; mounted to nearest visible node as degraded.`,
      },
      diagnostics,
    };
  }

  // Resolve each live ref to its visible region node.
  const resolved = liveRefs.map((ref) => ({
    ref,
    node: ref.filePath ? index.nodeForPath(ref.filePath) : undefined,
  }));
  const matchedNodeIds = [
    ...new Set(
      resolved.map((entry) => entry.node?.nodeId).filter((id): id is string => Boolean(id))
    ),
  ];

  if (matchedNodeIds.length === 0) {
    const node = index.byId.get(index.rootNodeId);
    return {
      decision: {
        mountNodeId: index.rootNodeId,
        mountLevel: node?.kind ?? 'space',
        mountType: 'source-ref-nearest-node',
        matchedRefs: liveRefs.map((ref) => ref.raw),
        reason: 'Source refs are outside the queried region; mounted to the nearest visible root.',
      },
      diagnostics,
    };
  }

  if (matchedNodeIds.length === 1) {
    const entry = resolved.find((item) => item.node) as {
      ref: NormalizedRecipeRef;
      node: RegionNode;
    };
    const node = entry.node;
    const mountType = singleRefMountType(entry.ref, node);
    return {
      decision: {
        mountNodeId: node.nodeId,
        mountLevel: node.kind,
        mountType,
        matchedRefs: liveRefs.map((ref) => ref.raw),
        reason: singleRefReason(mountType, node),
      },
      diagnostics,
    };
  }

  // Multiple distinct nodes → lowest common ancestor.
  const lca = index.lca(matchedNodeIds);
  const lcaNode = index.byId.get(lca);
  const crossRepo = isCrossRepo(matchedNodeIds, index);
  return {
    decision: {
      mountNodeId: lca,
      mountLevel: lcaNode?.kind ?? 'space',
      mountType: crossRepo ? 'cross-repo-common-ancestor' : 'multi-ref-common-ancestor',
      matchedRefs: liveRefs.map((ref) => ref.raw),
      reason: crossRepo
        ? 'Source refs span multiple repos; mounted to the common space ancestor.'
        : 'Source refs span multiple nodes; mounted to their lowest common ancestor.',
    },
    diagnostics,
  };
}

function metadataOnlyDecision(
  recipe: RecipeRecordLite,
  index: RegionIndex,
  diagnostics: MountDiagnostic[]
): MountDecision {
  const scopeHint = (recipe.scope ?? '').toLowerCase();
  const isGlobal =
    GLOBAL_SCOPE_HINTS.has(scopeHint) ||
    (recipe.category ?? '').toLowerCase().includes('architecture');
  if (isGlobal || (!recipe.moduleName && !recipe.scope)) {
    const root = index.byId.get(index.rootNodeId);
    return {
      mountNodeId: index.rootNodeId,
      mountLevel: root?.kind ?? 'space',
      mountType: 'global-no-code',
      matchedRefs: [],
      reason: 'No code refs and global/architecture metadata; mounted at the space root.',
    };
  }
  // module/repo metadata scope — only when resolvable without guessing.
  const target = recipe.moduleName
    ? [...index.byId.values()].find(
        (node) =>
          (node.kind === 'module' || node.kind === 'repo') &&
          (node.label === recipe.moduleName ||
            normalizeRefPathString(node.path ?? '') ===
              normalizeRefPathString(recipe.moduleName ?? ''))
      )
    : undefined;
  if (target) {
    return {
      mountNodeId: target.nodeId,
      mountLevel: target.kind,
      mountType: 'metadata-scope',
      matchedRefs: [],
      reason: `No code refs; mounted to ${target.kind} '${target.label}' by explicit metadata scope.`,
    };
  }
  diagnostics.push({
    code: 'recipe-metadata-scope-unresolved',
    severity: 'info',
    message: `Recipe ${recipe.id} has metadata scope '${recipe.moduleName ?? recipe.scope ?? ''}' that does not resolve in the queried region; mounted at root.`,
    recipeId: recipe.id,
    retryable: false,
  });
  const root = index.byId.get(index.rootNodeId);
  return {
    mountNodeId: index.rootNodeId,
    mountLevel: root?.kind ?? 'space',
    mountType: 'metadata-scope',
    matchedRefs: [],
    reason: 'No code refs; unresolved metadata scope mounted at the space root.',
  };
}

function singleRefMountType(ref: NormalizedRecipeRef, node: RegionNode): RecipeMountType {
  const exactFile =
    node.kind === 'file' && node.path && normalizeRefPathString(node.path) === ref.filePath;
  if (!exactFile) {
    return 'source-ref-nearest-node';
  }
  if (ref.startLine !== undefined && ref.endLine !== undefined && ref.endLine > ref.startLine) {
    return 'source-range';
  }
  if (ref.startLine !== undefined) {
    return 'source-line';
  }
  return 'source-file';
}

function singleRefReason(mountType: RecipeMountType, node: RegionNode): string {
  if (mountType === 'source-ref-nearest-node') {
    return `Deeper source node is outside the queried region; mounted to nearest visible ${node.kind} '${node.label}'.`;
  }
  return `Mounted to ${node.kind} '${node.label}' by ${mountType} source ref.`;
}

function isCrossRepo(nodeIds: readonly string[], index: RegionIndex): boolean {
  const repos = new Set<string>();
  for (const id of nodeIds) {
    const chain = [id, ...index.ancestorsOf(id)];
    const repo = chain.find((nodeId) => index.byId.get(nodeId)?.kind === 'repo');
    repos.add(repo ?? '∅');
  }
  return repos.size > 1;
}

// ─── Deterministic ordering ──────────────────────────────────

const MOUNT_TYPE_ORDER: Record<RecipeMountType, number> = {
  'source-range': 0,
  'source-line': 0,
  'source-file': 1,
  'source-ref-nearest-node': 2,
  'multi-ref-common-ancestor': 3,
  'cross-repo-common-ancestor': 3,
  'global-no-code': 5,
  'metadata-scope': 6,
  'degraded-stale': 7,
  'degraded-unresolved': 7,
};

export function mountSortKey(mount: {
  mountType: RecipeMountType;
  mountLevel: RegionNode['kind'];
  recipeId: string;
  title: string;
}): [number, number, string] {
  return [MOUNT_TYPE_ORDER[mount.mountType] ?? 9, regionKindRank(mount.mountLevel), mount.recipeId];
}

export function compareMounts(
  a: {
    mountType: RecipeMountType;
    mountLevel: RegionNode['kind'];
    recipeId: string;
    title: string;
  },
  b: { mountType: RecipeMountType; mountLevel: RegionNode['kind']; recipeId: string; title: string }
): number {
  const ka = mountSortKey(a);
  const kb = mountSortKey(b);
  return (
    ka[0] - kb[0] ||
    ka[1] - kb[1] ||
    a.title.localeCompare(b.title) ||
    a.recipeId.localeCompare(b.recipeId)
  );
}
