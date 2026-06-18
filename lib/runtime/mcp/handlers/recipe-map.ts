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
  type RecipeListContext,
  type RecipeRecord,
  type RecipeSourceRefContext,
} from '@alembic/core/recipe-context';
import { resolveProjectRoot } from '@alembic/core/workspace';
import {
  createAlembicRecipeMapMcpResult,
  defaultProjectGraphProvider,
  type MapFocus,
  type MapRadius,
  type RegionFocus,
  type RegionFocusKind,
} from '#service/project-knowledge-context/index.js';
import {
  defaultRecipeMapProvider,
  type MountDiagnostic,
  type RecipeMapDeps,
  type RecipeMapRequest,
  type RecipeRecordLite,
  type RecipeSourceRefRow,
} from '#service/project-knowledge-context/recipe-map/index.js';
import type { McpContext } from '../../../runtime/mcp/handlers/types.js';

interface RecipeMapArgs {
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
  detailLevel?: 'summary' | 'standard' | 'detailed';
  [key: string]: unknown;
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
  const projectRoot = args.projectRoot ?? resolveProjectRoot(ctx?.container);
  const request = normalizeRecipeMapRequest(args, projectRoot);
  const deps = buildRecipeMapDeps(ctx);
  const output = await defaultRecipeMapProvider.resolveRecipeMap(request, deps);
  return createAlembicRecipeMapMcpResult(output);
}

function normalizeRecipeMapRequest(args: RecipeMapArgs, projectRoot: string): RecipeMapRequest {
  const focusKind = recipeMapFocusKind(args.focus?.kind);
  const refId = args.focus?.refId ?? args.focus?.nodeId;
  const filePath = args.focus?.filePath ?? args.activeFile;
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
    detailLevel: args.detailLevel ?? 'summary',
  };
}

function recipeMapFocusKind(kind: string | undefined): RegionFocusKind {
  if (kind && RECIPE_MAP_FOCUS_KINDS.has(kind as RegionFocusKind)) {
    return kind as RegionFocusKind;
  }
  return 'space';
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function buildRecipeMapDeps(ctx: McpContext): RecipeMapDeps {
  const resolveRegion: RecipeMapDeps['resolveRegion'] = (focus, projectRoot) =>
    defaultProjectGraphProvider.resolveProjectContextRegion({ focus, projectRoot });

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
      const data = envelope.data as RecipeSourceRefContext;
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
      const envelope = await recipeContext.execute({
        kind: 'list',
        payload: { filter: {}, pageSize: 200 },
      } as RecipeContextRequest);
      const data = envelope.data as RecipeListContext;
      return (data.recipes ?? []).map(toRecipeRecordLite);
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

function toRecipeRecordLite(record: RecipeRecord): RecipeRecordLite {
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
