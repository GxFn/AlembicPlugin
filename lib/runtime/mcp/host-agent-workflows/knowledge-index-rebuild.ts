import type { ServiceContainer } from '#inject/ServiceContainer.js';
import {
  buildRecipeSemanticRegionVectors,
  type RecipeRegionVectorBuildReport,
} from './recipe-region-vector.js';

interface KnowledgeIndexRebuildContext {
  container: ServiceContainer;
  db: unknown;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  logPrefix: string;
}

interface KnowledgeSyncServiceLike {
  sync(
    db: unknown,
    opts?: { force?: boolean }
  ): {
    created: number;
    skipped: number;
    synced: number;
    updated: number;
    violations?: string[];
  };
}

interface SourceRefReconcilerLike {
  reconcile(opts?: { force?: boolean }): Promise<{
    active: number;
    cleaned?: number;
    inserted: number;
    recipesProcessed: number;
    skipped: number;
    stale: number;
  }>;
}

export interface KnowledgeIndexRebuildReport {
  knowledgeSync: ReturnType<KnowledgeSyncServiceLike['sync']> | null;
  recipeRegionVectors: RecipeRegionVectorBuildReport;
  sourceRefs: Awaited<ReturnType<SourceRefReconcilerLike['reconcile']>> | null;
}

/**
 * Rebuild local derived Recipe indexes from the canonical knowledge rows.
 *
 * This is intentionally shared by rescan and local verification scripts:
 * - KnowledgeSyncService restores Recipe files -> knowledge_entries.
 * - SourceRefReconciler restores knowledge_entries.reasoning.sources -> recipe_source_refs.
 * - Recipe semantic-region vectors then use recipe_source_refs as their bridge metadata.
 */
export async function rebuildLocalKnowledgeIndexes(
  ctx: KnowledgeIndexRebuildContext
): Promise<KnowledgeIndexRebuildReport> {
  const knowledgeSync = syncKnowledgeEntries(ctx);
  const sourceRefs = await reconcileSourceRefs(ctx);
  const recipeRegionVectors = await buildRecipeSemanticRegionVectors({
    container: ctx.container,
    logger: ctx.logger,
    logPrefix: ctx.logPrefix,
  });

  return { knowledgeSync, recipeRegionVectors, sourceRefs };
}

function syncKnowledgeEntries(
  ctx: KnowledgeIndexRebuildContext
): ReturnType<KnowledgeSyncServiceLike['sync']> | null {
  try {
    const syncService = ctx.container.get('knowledgeSyncService') as KnowledgeSyncServiceLike;
    const report = syncService.sync(ctx.db, { force: true });
    ctx.logger.info(`[${ctx.logPrefix}] KnowledgeSyncService sync complete`, {
      created: report.created,
      skipped: report.skipped,
      synced: report.synced,
      updated: report.updated,
      violations: report.violations?.length ?? 0,
    });
    return report;
  } catch (err: unknown) {
    ctx.logger.warn(
      `[${ctx.logPrefix}] KnowledgeSyncService sync failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function reconcileSourceRefs(
  ctx: KnowledgeIndexRebuildContext
): Promise<Awaited<ReturnType<SourceRefReconcilerLike['reconcile']>> | null> {
  try {
    const reconciler = ctx.container.get('sourceRefReconciler') as SourceRefReconcilerLike;
    const report = await reconciler.reconcile({ force: true });
    ctx.logger.info(`[${ctx.logPrefix}] SourceRefReconciler reconcile complete`, {
      active: report.active,
      cleaned: report.cleaned ?? 0,
      inserted: report.inserted,
      recipesProcessed: report.recipesProcessed,
      skipped: report.skipped,
      stale: report.stale,
    });
    return report;
  } catch (err: unknown) {
    ctx.logger.warn(
      `[${ctx.logPrefix}] SourceRefReconciler reconcile failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
