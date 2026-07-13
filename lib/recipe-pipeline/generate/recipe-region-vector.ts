import type { RecipeSourceRefsBridge, VectorAvailability } from '@alembic/core/vector';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { ServiceMap } from '#inject/ServiceMap.js';

interface RecipeRetrievalMaintenanceContext {
  container: ServiceContainer;
  logger: { info(message: string, meta?: Record<string, unknown>): void };
  logPrefix: string;
}

type VectorService = ServiceMap['vectorService'];
type RecipeEntry = Parameters<VectorService['buildRecipeRetrievalGeneration']>[0][number];
type GenerationResult = Awaited<ReturnType<VectorService['buildRecipeRetrievalGeneration']>>;
type SyncResult = Awaited<ReturnType<VectorService['syncRecipeSemanticRegions']>>;

export interface RecipeRetrievalMaintenanceReport {
  bridgeRecipeCount: number;
  bridgeRefCount: number;
  entries: number;
  generation: GenerationResult | null;
  reason: string | null;
  status: 'degraded' | 'failed' | 'skipped' | 'synced';
  syncResult: SyncResult | null;
  vectorAvailability: VectorAvailability | null;
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

const RECIPE_BUILD_PAGE_SIZE = 100_000;

/**
 * Explicit maintenance boundary for the Core Recipe retrieval document set.
 *
 * A provider-backed run builds and verifies a shadow generation before Core
 * activates it. When embedding is offline, the same boundary still invokes
 * Core's authoritative reconcile so deletes/deprecations do not depend on a
 * provider. Search and Prime never call this function.
 */
export async function maintainRecipeRetrievalDocuments(
  ctx: RecipeRetrievalMaintenanceContext
): Promise<RecipeRetrievalMaintenanceReport> {
  const { container, logger, logPrefix } = ctx;
  let vectorService: VectorService;
  let knowledgeService: ServiceMap['knowledgeService'];
  try {
    vectorService = container.get('vectorService');
    knowledgeService = container.get('knowledgeService');
  } catch (error: unknown) {
    return skippedReport('services-unavailable', errorMessage(error));
  }

  const vectorStatsBefore = await readVectorStats(vectorService);
  const vectorAvailability = await readVectorAvailability(vectorService, logger, logPrefix);
  let entries: RecipeEntry[];
  try {
    const listed = await knowledgeService.list({}, { page: 1, pageSize: RECIPE_BUILD_PAGE_SIZE });
    entries = (listed?.data ?? [])
      .map((entry: { toJSON(): unknown }) => entry.toJSON() as RecipeEntry)
      .filter((entry) => !isDeprecated(entry));
  } catch (error: unknown) {
    return skippedReport('knowledge-list-failed', errorMessage(error), {
      vectorAvailability,
      vectorStatsBefore,
    });
  }

  const bridge = buildSourceRefsBridgeByRecipeId(
    container,
    entries.map((entry) => entry.id)
  );
  let generation: GenerationResult | null = null;
  let syncResult: SyncResult | null = null;
  let status: RecipeRetrievalMaintenanceReport['status'];
  let reason: string | null = null;

  try {
    generation = await vectorService.buildRecipeRetrievalGeneration(entries);
    if (generation.status === 'activated' || generation.status === 'already-active') {
      status = 'synced';
    } else if (generation.errors.includes('embed-provider-unavailable')) {
      syncResult = await vectorService.syncRecipeSemanticRegions(entries, {
        maintenanceScope: {
          kind: 'authoritative-corpus',
          nonDeprecatedRecipeIds: entries.map((entry) => entry.id),
        },
        removeStale: true,
        sourceRefsBridgeByRecipeId: bridge.byRecipeId,
      });
      status = syncResult.status === 'failed' ? 'failed' : 'degraded';
      reason = syncResult.degradedReason ?? generation.errors[0] ?? 'embed-provider-unavailable';
    } else {
      status = 'failed';
      reason = generation.errors[0] ?? 'recipe-retrieval-generation-failed';
    }
  } catch (error: unknown) {
    status = 'failed';
    reason = `recipe-retrieval-maintenance-failed: ${errorMessage(error)}`;
  }

  const report: RecipeRetrievalMaintenanceReport = {
    bridgeRecipeCount: bridge.recipeCount,
    bridgeRefCount: bridge.refCount,
    entries: entries.length,
    generation,
    reason,
    status,
    syncResult,
    vectorAvailability,
    vectorStatsAfter: await readVectorStats(vectorService),
    vectorStatsBefore,
  };
  logger.info(`[${logPrefix}] Recipe retrieval maintenance ${status}`, {
    activeGenerationId: generation?.active?.generationId ?? null,
    bridgeRecipeCount: bridge.recipeCount,
    bridgeRefCount: bridge.refCount,
    entries: entries.length,
    generationId: generation?.generationId ?? null,
    generationStatus: generation?.status ?? 'failed',
    reason,
    removed: syncResult?.removed ?? 0,
  });
  return report;
}

function buildSourceRefsBridgeByRecipeId(
  container: ServiceContainer,
  recipeIds: readonly string[]
): {
  byRecipeId: Record<string, RecipeSourceRefsBridge>;
  recipeCount: number;
  refCount: number;
} {
  let repository: RecipeSourceRefRepositoryLike | null = null;
  try {
    repository = container.get('recipeSourceRefRepository') as RecipeSourceRefRepositoryLike;
  } catch {
    return { byRecipeId: {}, recipeCount: 0, refCount: 0 };
  }
  if (!repository) {
    return { byRecipeId: {}, recipeCount: 0, refCount: 0 };
  }

  const refsByRecipe = new Map<string, string[]>();
  if (repository.findActiveByRecipeIds) {
    for (const row of repository.findActiveByRecipeIds([...recipeIds])) {
      addRef(refsByRecipe, row.recipeId, effectiveSourcePath(row));
    }
  } else if (repository.findByRecipeId) {
    for (const recipeId of recipeIds) {
      for (const row of repository.findByRecipeId(recipeId)) {
        if (row.status !== 'stale') {
          addRef(refsByRecipe, recipeId, effectiveSourcePath(row));
        }
      }
    }
  }

  const byRecipeId: Record<string, RecipeSourceRefsBridge> = {};
  let refCount = 0;
  for (const [recipeId, refs] of refsByRecipe) {
    byRecipeId[recipeId] = { status: 'active', refs };
    refCount += refs.length;
  }
  return { byRecipeId, recipeCount: Object.keys(byRecipeId).length, refCount };
}

function effectiveSourcePath(row: {
  newPath?: string | null;
  sourcePath: string;
  status?: string;
}) {
  return row.status === 'renamed' && row.newPath ? row.newPath : row.sourcePath;
}

function addRef(refsByRecipe: Map<string, string[]>, recipeId: string, sourcePath: string): void {
  if (!sourcePath) {
    return;
  }
  const refs = refsByRecipe.get(recipeId) ?? [];
  if (!refs.includes(sourcePath)) {
    refs.push(sourcePath);
  }
  refsByRecipe.set(recipeId, refs);
}

function isDeprecated(entry: RecipeEntry): boolean {
  return typeof entry.lifecycle === 'string' && entry.lifecycle.toLowerCase() === 'deprecated';
}

async function readVectorAvailability(
  vectorService: VectorService,
  logger: RecipeRetrievalMaintenanceContext['logger'],
  logPrefix: string
): Promise<VectorAvailability | null> {
  try {
    return await vectorService.getAvailability();
  } catch (error: unknown) {
    logger.info(`[${logPrefix}] Recipe retrieval availability probe failed`, {
      reason: errorMessage(error),
    });
    return null;
  }
}

async function readVectorStats(
  vectorService: VectorService
): Promise<Record<string, unknown> | null> {
  try {
    return (await vectorService.getStats()) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function skippedReport(
  reason: string,
  detail: string,
  options: {
    vectorAvailability?: VectorAvailability | null;
    vectorStatsBefore?: Record<string, unknown> | null;
  } = {}
): RecipeRetrievalMaintenanceReport {
  return {
    bridgeRecipeCount: 0,
    bridgeRefCount: 0,
    entries: 0,
    generation: null,
    reason: detail ? `${reason}: ${detail}` : reason,
    status: 'skipped',
    syncResult: null,
    vectorAvailability: options.vectorAvailability ?? null,
    vectorStatsAfter: options.vectorStatsBefore ?? null,
    vectorStatsBefore: options.vectorStatsBefore ?? null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
