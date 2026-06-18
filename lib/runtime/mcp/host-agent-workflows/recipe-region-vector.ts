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

// Recipe corpora are small (low thousands at most); one large page avoids paging
// loops in the synchronous rescan path.
const REGION_BUILD_PAGE_SIZE = 100_000;

export async function buildRecipeSemanticRegionVectors(
  ctx: RegionVectorBuildContext
): Promise<void> {
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
    return;
  }

  // Embed gate — probe before touching the index (see header note on removeStale).
  let embedProviderAvailable = false;
  try {
    embedProviderAvailable = (await vectorService.getStats()).embedProviderAvailable;
  } catch (err: unknown) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (vector stats unavailable)`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!embedProviderAvailable) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (embed provider unavailable)`);
    return;
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
    return;
  }
  if (entries.length === 0) {
    return;
  }

  try {
    const result = await vectorService.syncRecipeSemanticRegions(entries);
    logger.info(`[${logPrefix}] Recipe semantic-region vectors synced`, {
      status: result.status,
      scanned: result.scanned,
      generated: result.generated,
      upserted: result.upserted,
      removed: result.removed,
      degradedReason: result.degradedReason,
    });
  } catch (err: unknown) {
    logger.info(`[${logPrefix}] Recipe region-vector build failed (non-blocking)`, {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
