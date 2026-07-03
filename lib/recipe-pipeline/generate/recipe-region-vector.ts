import type { RecipeSourceRefsBridge, VectorAvailability } from '@alembic/core/vector';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { ServiceMap } from '#inject/ServiceMap.js';

// PDR-2b: Build local Recipe semantic-region vectors inside the in-process
// bootstrap/rescan path (PDR-2a). These region chunks are what subject-less
// prime retrieves to earn recipe-semantic-region trust evidence (full quality,
// no lexical downgrade). The build is:
//   - availability-gated: region chunks must be embedded by an available provider;
//     when that provider is absent or degraded we skip entirely rather than running
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
  semanticMemories: RecipeSemanticMemorySyncReport | null;
  status: 'failed' | 'skipped' | 'synced';
  syncResult: Awaited<ReturnType<ServiceMap['vectorService']['syncRecipeSemanticRegions']>> | null;
  vectorAvailability: VectorAvailability | null;
  vectorStatsAfter: Record<string, unknown> | null;
  vectorStatsBefore: Record<string, unknown> | null;
}

export interface RecipeSemanticMemorySyncReport {
  created: number;
  deleted: number;
  reason: string | null;
  skipped: number;
  status: 'failed' | 'skipped' | 'synced';
  total: number;
  updated: number;
}

export interface RecipeSemanticMemorySyncContext {
  bridgeByRecipeId?: Record<string, RecipeSourceRefsBridge>;
  container: ServiceContainer;
  deleteStale?: boolean;
  entries: readonly RecipeSemanticMemoryEntry[];
  logger?: { info(message: string, meta?: Record<string, unknown>): void };
  logPrefix?: string;
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

  // Availability gate — probe before touching the index (see header note on removeStale).
  const vectorStatsBefore = await readVectorStats(vectorService);
  let vectorAvailability: VectorAvailability;
  try {
    vectorAvailability = await vectorService.getAvailability();
  } catch (err: unknown) {
    logger.info(
      `[${logPrefix}] Recipe region-vector build skipped (vector availability unavailable)`,
      {
        reason: err instanceof Error ? err.message : String(err),
      }
    );
    return skippedRegionBuildReport(
      'vector-availability-unavailable',
      err instanceof Error ? err.message : String(err),
      { vectorStatsBefore }
    );
  }
  if (!vectorAvailability.available) {
    logger.info(`[${logPrefix}] Recipe region-vector build skipped (vector unavailable)`, {
      availability: summarizeVectorAvailability(vectorAvailability),
    });
    return skippedRegionBuildReport(vectorAvailability.reason, null, {
      vectorAvailability,
      vectorStatsBefore,
    });
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
      { vectorAvailability, vectorStatsBefore }
    );
  }
  if (entries.length === 0) {
    return skippedRegionBuildReport('no-recipe-entries', null, {
      vectorAvailability,
      vectorStatsBefore,
    });
  }

  const bridge = buildSourceRefsBridgeByRecipeId(
    container,
    entries.map((entry) => entry.id)
  );
  let semanticMemories: RecipeSemanticMemorySyncReport | null = null;
  try {
    const result = await syncRecipeSemanticRegionVectorsInBatches(
      vectorService,
      entries,
      bridge.byRecipeId
    );
    semanticMemories = await syncRecipeSemanticMemoriesForEntries({
      bridgeByRecipeId: bridge.byRecipeId,
      container,
      deleteStale: true,
      entries,
      logger,
      logPrefix,
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
      semanticMemoryStatus: semanticMemories.status,
      semanticMemoryTotal: semanticMemories.total,
    });
    return {
      bridgeRecipeCount: bridge.recipeCount,
      bridgeRefCount: bridge.refCount,
      entries: entries.length,
      reason: null,
      semanticMemories,
      status: 'synced',
      syncResult: result,
      vectorAvailability,
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
      semanticMemories:
        semanticMemories ??
        (await syncRecipeSemanticMemoriesForEntries({
          bridgeByRecipeId: bridge.byRecipeId,
          container,
          deleteStale: true,
          entries,
          logger,
          logPrefix,
        })),
      status: 'failed',
      syncResult: null,
      vectorAvailability,
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
  if (!repo) {
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

async function syncRecipeSemanticRegionVectorsInBatches(
  vectorService: ServiceMap['vectorService'],
  entries: Parameters<ServiceMap['vectorService']['syncRecipeSemanticRegions']>[0],
  bridgeByRecipeId: Record<string, RecipeSourceRefsBridge>
): Promise<RecipeRegionSyncResult> {
  const aggregate = emptyRecipeRegionSyncResult();
  for (let index = 0; index < entries.length; index += RECIPE_REGION_SYNC_BATCH_SIZE) {
    const batch = entries.slice(index, index + RECIPE_REGION_SYNC_BATCH_SIZE);
    const result = await vectorService.syncRecipeSemanticRegions(batch, {
      sourceRefsBridgeByRecipeId: pickBridgeForEntries(bridgeByRecipeId, batch),
    });
    mergeRecipeRegionSyncResult(aggregate, result);
  }
  return aggregate;
}

function pickBridgeForEntries(
  bridgeByRecipeId: Record<string, RecipeSourceRefsBridge>,
  entries: readonly RecipeSemanticMemoryEntry[]
): Record<string, RecipeSourceRefsBridge> {
  const picked: Record<string, RecipeSourceRefsBridge> = {};
  for (const entry of entries) {
    const bridge = bridgeByRecipeId[entry.id];
    if (bridge) {
      picked[entry.id] = bridge;
    }
  }
  return picked;
}

function emptyRecipeRegionSyncResult(): RecipeRegionSyncResult {
  return {
    embedded: 0,
    errors: [],
    generated: 0,
    generatedMetadata: [],
    removed: 0,
    scanned: 0,
    skipped: 0,
    status: 'completed',
    upserted: 0,
  } as RecipeRegionSyncResult;
}

function mergeRecipeRegionSyncResult(
  aggregate: RecipeRegionSyncResult,
  result: RecipeRegionSyncResult
): void {
  aggregate.scanned += result.scanned;
  aggregate.generated += result.generated;
  aggregate.embedded += result.embedded;
  aggregate.upserted += result.upserted;
  aggregate.removed += result.removed;
  aggregate.skipped += result.skipped;
  if (Array.isArray(result.errors)) {
    aggregate.errors.push(...result.errors);
  }
  if (Array.isArray(result.generatedMetadata)) {
    aggregate.generatedMetadata?.push(...result.generatedMetadata);
  }
  if (result.degradedReason && !aggregate.degradedReason) {
    aggregate.degradedReason = result.degradedReason;
  }
  if (result.status === 'failed') {
    aggregate.status = 'failed';
  } else if (aggregate.status !== 'failed' && result.status === 'degraded') {
    aggregate.status = 'degraded';
  }
}

interface RecipeSemanticMemoryRepositoryLike {
  create(data: {
    bootstrapSession?: string | null;
    content: string;
    id: string;
    importance?: number;
    relatedEntities?: string[];
    source?: string;
    sourceDimension?: string | null;
    sourceEvidence?: string | null;
    tags?: string[];
    type?: string;
  }): Promise<unknown> | unknown;
  delete(id: string): Promise<boolean> | boolean;
  findById(id: string): Promise<unknown | null> | unknown | null;
  getAllActive(filters?: { source?: string; type?: string }):
    | Promise<Array<{ id: string }>>
    | Array<{
        id: string;
      }>;
  update(
    id: string,
    updates: {
      content?: string;
      importance?: number;
      relatedEntities?: string[];
      tags?: string[];
    }
  ): Promise<boolean> | boolean;
}

export type RecipeSemanticMemoryEntry = Parameters<
  ServiceMap['vectorService']['syncRecipeSemanticRegions']
>[0][number];
type RecipeRegionSyncResult = Awaited<
  ReturnType<ServiceMap['vectorService']['syncRecipeSemanticRegions']>
>;

const RECIPE_SEMANTIC_MEMORY_ID_PREFIX = 'recipe-region-memory:';
const RECIPE_SEMANTIC_MEMORY_SOURCE = 'recipe-region-vector';
const RECIPE_REGION_SYNC_BATCH_SIZE = 6;

export async function syncRecipeSemanticMemoriesForEntries({
  bridgeByRecipeId,
  container,
  deleteStale = false,
  entries,
  logger = { info: () => undefined },
  logPrefix = 'recipe-freshness',
}: RecipeSemanticMemorySyncContext): Promise<RecipeSemanticMemorySyncReport> {
  const effectiveBridge =
    bridgeByRecipeId ??
    buildSourceRefsBridgeByRecipeId(
      container,
      entries.map((entry) => entry.id)
    ).byRecipeId;

  let memoryRepository: RecipeSemanticMemoryRepositoryLike;
  try {
    memoryRepository = container.get('memoryRepository') as RecipeSemanticMemoryRepositoryLike;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.info(`[${logPrefix}] Recipe semantic memory sync skipped`, {
      reason: `memory-repository-unavailable:${reason}`,
    });
    return emptySemanticMemoryReport('skipped', `memory-repository-unavailable:${reason}`);
  }
  if (!memoryRepository) {
    logger.info(`[${logPrefix}] Recipe semantic memory sync skipped`, {
      reason: 'memory-repository-unavailable',
    });
    return emptySemanticMemoryReport('skipped', 'memory-repository-unavailable');
  }

  const memories = entries
    .filter((entry) => !isDeprecatedRecipeEntry(entry))
    .map((entry) => buildRecipeSemanticMemory(entry, effectiveBridge[entry.id]))
    .filter((memory) => memory.content.length > 0);
  if (memories.length === 0) {
    return emptySemanticMemoryReport('skipped', 'no-recipe-memory-entries');
  }

  const expectedIds = new Set(memories.map((memory) => memory.id));
  const report: RecipeSemanticMemorySyncReport = {
    created: 0,
    deleted: 0,
    reason: null,
    skipped: 0,
    status: 'synced',
    total: memories.length,
    updated: 0,
  };

  try {
    for (const memory of memories) {
      const existing = await memoryRepository.findById(memory.id);
      if (existing) {
        await memoryRepository.update(memory.id, {
          content: memory.content,
          importance: memory.importance,
          relatedEntities: memory.relatedEntities,
          tags: memory.tags,
        });
        report.updated++;
      } else {
        await memoryRepository.create(memory);
        report.created++;
      }
    }

    if (deleteStale) {
      const active = await memoryRepository.getAllActive({
        source: RECIPE_SEMANTIC_MEMORY_SOURCE,
      });
      for (const row of active) {
        if (!row.id.startsWith(RECIPE_SEMANTIC_MEMORY_ID_PREFIX)) {
          continue;
        }
        if (expectedIds.has(row.id)) {
          continue;
        }
        const deleted = await memoryRepository.delete(row.id);
        if (deleted) {
          report.deleted++;
        }
      }
    }

    logger.info(`[${logPrefix}] Recipe semantic memories synced`, {
      created: report.created,
      deleted: report.deleted,
      total: report.total,
      updated: report.updated,
    });
    return report;
  } catch (err: unknown) {
    report.status = 'failed';
    report.reason = err instanceof Error ? err.message : String(err);
    logger.info(`[${logPrefix}] Recipe semantic memory sync failed (non-blocking)`, {
      reason: report.reason,
    });
    return report;
  }
}

function buildRecipeSemanticMemory(
  entry: RecipeSemanticMemoryEntry,
  bridge: RecipeSourceRefsBridge | undefined
) {
  const bridgeRefs = compactStringArray(bridge?.refs);
  const sourceRefs = bridgeRefs.length
    ? bridgeRefs
    : compactStringArray(normalizeRecord(entry.reasoning).sources);
  const tags = compactStringArray([
    'recipe',
    'recipe-region-vector',
    entry.dimensionId ? `dimension:${entry.dimensionId}` : null,
    entry.category,
    entry.kind,
    entry.knowledgeType,
    entry.language,
    ...compactStringArray(entry.tags),
  ]);
  return {
    content: clipText(
      compactStringArray([
        entry.title ? `Title: ${entry.title}` : null,
        entry.trigger ? `Trigger: ${entry.trigger}` : null,
        entry.description ? `Description: ${entry.description}` : null,
        entry.topicHint ? `Topic: ${entry.topicHint}` : null,
        entry.whenClause ? `When: ${entry.whenClause}` : null,
        entry.doClause ? `Do: ${entry.doClause}` : null,
        entry.dontClause ? `Avoid: ${entry.dontClause}` : null,
        entry.usageGuide ? `Usage: ${entry.usageGuide}` : null,
        textFromContent(entry.content),
        textFromReasoning(entry.reasoning),
        sourceRefs.length > 0 ? `Sources: ${sourceRefs.slice(0, 6).join(', ')}` : null,
      ]).join('\n'),
      1200
    ),
    id: `${RECIPE_SEMANTIC_MEMORY_ID_PREFIX}${entry.id}`,
    importance: importanceFromQuality(normalizeRecord(entry).quality),
    relatedEntities: sourceRefs.slice(0, 20),
    source: RECIPE_SEMANTIC_MEMORY_SOURCE,
    sourceDimension: compactString(entry.dimensionId) || null,
    sourceEvidence: JSON.stringify({
      recipeId: entry.id,
      sourceRefs: sourceRefs.slice(0, 20),
      title: compactString(entry.title),
    }),
    tags,
    type: 'recipe',
  };
}

function textFromContent(content: unknown): string {
  const record = normalizeRecord(content);
  return compactStringArray([
    record.pattern ? `Pattern: ${record.pattern}` : null,
    record.markdown,
    record.rationale ? `Rationale: ${record.rationale}` : null,
  ]).join('\n');
}

function textFromReasoning(reasoning: unknown): string {
  const record = normalizeRecord(reasoning);
  return compactStringArray([
    record.whyStandard ? `Why: ${record.whyStandard}` : null,
    Array.isArray(record.alternatives) && record.alternatives.length > 0
      ? `Alternatives: ${compactStringArray(record.alternatives).slice(0, 4).join('; ')}`
      : null,
  ]).join('\n');
}

function importanceFromQuality(quality: unknown): number {
  const overall = Number(normalizeRecord(quality).overall);
  if (Number.isFinite(overall)) {
    return overall > 10
      ? Math.max(1, Math.min(10, overall / 10))
      : Math.max(1, Math.min(10, overall));
  }
  return 6;
}

function isDeprecatedRecipeEntry(entry: RecipeSemanticMemoryEntry): boolean {
  return compactString(entry.lifecycle).toLowerCase() === 'deprecated';
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function compactString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compactStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map(compactString).filter(Boolean);
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function emptySemanticMemoryReport(
  status: RecipeSemanticMemorySyncReport['status'],
  reason: string | null
): RecipeSemanticMemorySyncReport {
  return {
    created: 0,
    deleted: 0,
    reason,
    skipped: 0,
    status,
    total: 0,
    updated: 0,
  };
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

function summarizeVectorAvailability(availability: VectorAvailability): Record<string, unknown> {
  return {
    available: availability.available,
    detail: availability.detail,
    embedProviderConfigured: availability.embedProviderConfigured,
    probeStatus: availability.probeStatus,
    reason: availability.reason,
    status: availability.status,
  };
}

function skippedRegionBuildReport(
  reason: string,
  detail: string | null,
  opts: {
    vectorAvailability?: VectorAvailability | null;
    vectorStatsBefore?: Record<string, unknown> | null;
  } = {}
): RecipeRegionVectorBuildReport {
  return {
    bridgeRecipeCount: 0,
    bridgeRefCount: 0,
    entries: 0,
    reason: detail ? `${reason}: ${detail}` : reason,
    semanticMemories: null,
    status: 'skipped',
    syncResult: null,
    vectorAvailability: opts.vectorAvailability ?? null,
    vectorStatsAfter: opts.vectorStatsBefore ?? null,
    vectorStatsBefore: opts.vectorStatsBefore ?? null,
  };
}
