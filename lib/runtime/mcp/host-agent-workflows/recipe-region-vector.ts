import type { RecipeSourceRefsBridge } from '@alembic/core/vector';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { ServiceMap } from '#inject/ServiceMap.js';

// PDR-2b: Build local Recipe semantic-region vectors inside the in-process
// bootstrap/rescan path (PDR-2a). These region chunks are what subject-less
// prime retrieves to earn recipe-semantic-region trust evidence (full quality,
// no lexical downgrade). The build is:
//   - embed-gated: region chunks must be embedded by the local Ollama provider;
//     when that provider is absent we skip entirely rather than running
//     syncRecipeSemanticRegions (whose removeStale step precedes the embed step
//     and would otherwise strip changed-recipe chunks without re-embedding them).
//   - non-blocking: any failure is logged and swallowed so rescan still returns.

interface RegionVectorBuildContext {
  container: ServiceContainer;
  logger: { info(message: string, meta?: Record<string, unknown>): void };
  logPrefix: string;
}

export interface RecipeRegionVectorBuildReport {
  bridgeRecipeCount: number;
  bridgeRefCount: number;
  entries: number;
  reason: string | null;
  status: 'failed' | 'skipped' | 'synced';
  syncResult: Awaited<ReturnType<ServiceMap['vectorService']['syncRecipeSemanticRegions']>> | null;
  vectorStatsAfter: Record<string, unknown> | null;
  vectorStatsBefore: Record<string, unknown> | null;
}

interface RecipeSourceRefRepositoryLike {
  findActiveByRecipeIds?: (ids: string[]) => Array<{
    newPath?: string | null;
    recipeId: string;
    sourcePath: string;
    status?: string;
  }>;
  findByRecipeId?: (id: string) => Array<{
    newPath?: string | null;
    recipeId: string;
    sourcePath: string;
    status?: string;
  }>;
}

// Recipe corpora are small (low thousands at most); one large page avoids paging
// loops in the synchronous rescan path.
const REGION_BUILD_PAGE_SIZE = 100_000;

export async function buildRecipeSemanticRegionVectors(
  ctx: RegionVectorBuildContext
): Promise<RecipeRegionVectorBuildReport> {
  const { container, logger, logPrefix } = ctx;

  let vectorService: ServiceMap['vectorService'];
  let knowledgeService: ServiceMap['knowledgeService'];
  try {
    vectorService = container.get('vectorService');
    knowledgeService = container.get('knowledgeService');
  } catch (err: unknown) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (services unavailable)`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return skippedRegionBuildReport(
      'services-unavailable',
      err instanceof Error ? err.message : String(err)
    );
  }

  // Embed gate — probe before touching the index (see header note on removeStale).
  let embedProviderAvailable = false;
  const vectorStatsBefore = await readVectorStats(vectorService);
  try {
    embedProviderAvailable = (await vectorService.getStats()).embedProviderAvailable;
  } catch (err: unknown) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (vector stats unavailable)`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return skippedRegionBuildReport(
      'vector-stats-unavailable',
      err instanceof Error ? err.message : String(err),
      { vectorStatsBefore }
    );
  }
  if (!embedProviderAvailable) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (embed provider unavailable)`);
    return skippedRegionBuildReport('embed-provider-unavailable', null, { vectorStatsBefore });
  }

  let entries: Parameters<typeof vectorService.syncRecipeSemanticRegions>[0];
  try {
    const listed = await knowledgeService.list({}, { page: 1, pageSize: REGION_BUILD_PAGE_SIZE });
    entries = (listed?.data ?? []).map(
      (entry: { toJSON(): unknown }) =>
        entry.toJSON() as Parameters<typeof vectorService.syncRecipeSemanticRegions>[0][number]
    );
  } catch (err: unknown) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (knowledge list failed)`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return skippedRegionBuildReport(
      'knowledge-list-failed',
      err instanceof Error ? err.message : String(err),
      { vectorStatsBefore }
    );
  }
  if (entries.length === 0) {
    return skippedRegionBuildReport('no-recipe-entries', null, { vectorStatsBefore });
  }

  try {
    const bridge = buildSourceRefsBridgeByRecipeId(
      container,
      entries.map((entry) => entry.id)
    );
    const result = await vectorService.syncRecipeSemanticRegions(entries, {
      sourceRefsBridgeByRecipeId: bridge.byRecipeId,
    });
    await flushVectorStore(container);
    const vectorStatsAfter = await readVectorStats(vectorService);
    logger.info(`[${logPrefix}] Recipe semantic-region vectors synced`, {
      status: result.status,
      scanned: result.scanned,
      generated: result.generated,
      upserted: result.upserted,
      removed: result.removed,
      degradedReason: result.degradedReason,
      bridgeRecipeCount: bridge.recipeCount,
      bridgeRefCount: bridge.refCount,
    });
    return {
      bridgeRecipeCount: bridge.recipeCount,
      bridgeRefCount: bridge.refCount,
      entries: entries.length,
      reason: null,
      status: 'synced',
      syncResult: result,
      vectorStatsAfter,
      vectorStatsBefore,
    };
  } catch (err: unknown) {
    logger.info(`[${logPrefix}] Recipe region-vector build failed (non-blocking)`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      bridgeRecipeCount: 0,
      bridgeRefCount: 0,
      entries: entries.length,
      reason: err instanceof Error ? err.message : String(err),
      status: 'failed',
      syncResult: null,
      vectorStatsAfter: await readVectorStats(vectorService),
      vectorStatsBefore,
    };
  }
}

function buildSourceRefsBridgeByRecipeId(
  container: ServiceContainer,
  recipeIds: readonly string[]
): {
  byRecipeId: Record<string, RecipeSourceRefsBridge>;
  recipeCount: number;
  refCount: number;
} {
  let repo: RecipeSourceRefRepositoryLike;
  try {
    repo = container.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryLike;
  } catch {
    return { byRecipeId: {}, recipeCount: 0, refCount: 0 };
  }

  const refsByRecipe = new Map<string, string[]>();
  if (typeof repo.findActiveByRecipeIds === 'function') {
    for (const row of repo.findActiveByRecipeIds([...recipeIds])) {
      const sourcePath = row.status === 'renamed' && row.newPath ? row.newPath : row.sourcePath;
      pushUniqueRef(refsByRecipe, row.recipeId, sourcePath);
    }
  } else if (typeof repo.findByRecipeId === 'function') {
    for (const recipeId of recipeIds) {
      for (const row of repo.findByRecipeId(recipeId)) {
        if (row.status === 'stale') {
          continue;
        }
        const sourcePath = row.status === 'renamed' && row.newPath ? row.newPath : row.sourcePath;
        pushUniqueRef(refsByRecipe, recipeId, sourcePath);
      }
    }
  }

  const byRecipeId: Record<string, RecipeSourceRefsBridge> = {};
  let refCount = 0;
  for (const [recipeId, refs] of refsByRecipe) {
    if (refs.length === 0) {
      continue;
    }
    byRecipeId[recipeId] = { status: 'active', refs };
    refCount += refs.length;
  }
  return { byRecipeId, recipeCount: Object.keys(byRecipeId).length, refCount };
}

function pushUniqueRef(refsByRecipe: Map<string, string[]>, recipeId: string, sourcePath: string) {
  if (!sourcePath) {
    return;
  }
  const refs = refsByRecipe.get(recipeId) ?? [];
  if (!refs.includes(sourcePath)) {
    refs.push(sourcePath);
  }
  refsByRecipe.set(recipeId, refs);
}

async function flushVectorStore(container: ServiceContainer): Promise<void> {
  try {
    const vectorStore = container.get('vectorStore') as { flush?: () => Promise<void> };
    await vectorStore.flush?.();
  } catch {
    // Flush is best-effort; WAL-backed stores also persist on their own cadence.
  }
}

async function readVectorStats(
  vectorService: ServiceMap['vectorService']
): Promise<Record<string, unknown> | null> {
  try {
    return (await vectorService.getStats()) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function skippedRegionBuildReport(
  reason: string,
  detail: string | null,
  opts: { vectorStatsBefore?: Record<string, unknown> | null } = {}
): RecipeRegionVectorBuildReport {
  return {
    bridgeRecipeCount: 0,
    bridgeRefCount: 0,
    entries: 0,
    reason: detail ? `${reason}: ${detail}` : reason,
    status: 'skipped',
    syncResult: null,
    vectorStatsAfter: opts.vectorStatsBefore ?? null,
    vectorStatsBefore: opts.vectorStatsBefore ?? null,
  };
}
