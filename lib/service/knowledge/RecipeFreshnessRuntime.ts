import type {
  RecipeFreshnessEntry,
  RecipeFreshnessRecipeResult,
  RecipeFreshnessRefreshResult,
  RecipeFreshnessService,
  RecipeFreshnessVectorSummary,
} from '@alembic/core/knowledge';
import type { KnowledgeRepository } from '@alembic/core/repositories';
import {
  syncRecipeSemanticMemoriesForEntries,
  type RecipeSemanticMemoryEntry,
} from '#recipe-generation/host-agent-workflows/recipe-region-vector.js';

export interface RecipeFreshnessContainer {
  get(name: string): unknown;
}

export type RecipeFreshnessPublicStatus = 'completed' | 'degraded' | 'failed' | 'skipped';

export interface RecipeFreshnessPublicRecipe {
  recipeId: string;
  status: RecipeFreshnessPublicStatus;
  retrievalMayBeStale: boolean;
  sourceRefs: {
    status: string;
    activeCount: number;
    staleCount: number;
    allCount: number;
    activeRefs: string[];
    staleRefs: string[];
    reconcile?: {
      inserted: number;
      active: number;
      stale: number;
      skipped: number;
      recipesProcessed: number;
      cleaned?: number;
    };
    errors?: string[];
  };
  vector: {
    status: string;
    availabilityStatus: string | null;
    availabilityReason: string | null;
    entrySyncStatus: string;
    regionSyncStatus: string;
    degradedReason?: string;
    regionSync?: {
      status: string;
      scanned?: number;
      generated?: number;
      upserted?: number;
      removed?: number;
      degradedReason?: string;
      errors?: string[];
    };
    errors?: string[];
  };
  skippedReason?: string;
  errors?: string[];
}

export interface RecipeFreshnessPublicOutput {
  status: RecipeFreshnessPublicStatus;
  requested: number;
  processed: number;
  retrievalMayBeStale: boolean;
  recipes: RecipeFreshnessPublicRecipe[];
  errors?: string[];
}

export interface CreatedRecipeFreshnessInput {
  id: string;
  title?: string;
  raw?: unknown;
}

const STRING_RECIPE_FRESHNESS_FIELDS = [
  'title',
  'description',
  'lifecycle',
  'language',
  'dimensionId',
  'category',
  'knowledgeType',
  'kind',
  'trigger',
  'topicHint',
  'whenClause',
  'doClause',
  'dontClause',
  'coreCode',
  'usageGuide',
  'moduleName',
  'contentHash',
] as const;

export async function refreshCreatedRecipeFreshness(
  container: RecipeFreshnessContainer,
  created: readonly CreatedRecipeFreshnessInput[]
): Promise<RecipeFreshnessPublicOutput | null> {
  if (created.length === 0) {
    return null;
  }

  const service = getRecipeFreshnessService(container);
  if (!service) {
    return skippedFreshnessOutput(
      created.map((entry) => entry.id),
      'recipeFreshnessService-unavailable'
    );
  }

  const entries: RecipeFreshnessEntry[] = [];
  const skipped: RecipeFreshnessPublicRecipe[] = [];
  for (const item of created) {
    const rawEntry = toRecipeFreshnessEntry(item.raw);
    if (rawEntry) {
      entries.push(rawEntry);
      continue;
    }

    const loaded = await loadRecipeFreshnessEntry(container, item.id);
    if (loaded) {
      entries.push(loaded);
      continue;
    }

    skipped.push(skippedRecipe(item.id, 'saved-entry-unavailable'));
  }

  return refreshRecipeFreshnessEntries(container, service, entries, {
    requested: created.length,
    skipped,
  });
}

export async function refreshRecipeFreshnessByIds(
  container: RecipeFreshnessContainer,
  recipeIds: readonly string[]
): Promise<RecipeFreshnessPublicOutput | null> {
  const ids = uniqueNonEmptyStrings(recipeIds);
  if (ids.length === 0) {
    return null;
  }

  const service = getRecipeFreshnessService(container);
  if (!service) {
    return skippedFreshnessOutput(ids, 'recipeFreshnessService-unavailable');
  }

  const entries: RecipeFreshnessEntry[] = [];
  const skipped: RecipeFreshnessPublicRecipe[] = [];
  for (const id of ids) {
    const loaded = await loadRecipeFreshnessEntry(container, id);
    if (loaded) {
      entries.push(loaded);
    } else {
      skipped.push(skippedRecipe(id, 'saved-entry-unavailable'));
    }
  }

  return refreshRecipeFreshnessEntries(container, service, entries, {
    requested: ids.length,
    skipped,
  });
}

export function mergeFreshnessOutputs(
  outputs: Array<RecipeFreshnessPublicOutput | null | undefined>,
  skipped: RecipeFreshnessPublicRecipe[] = []
): RecipeFreshnessPublicOutput | null {
  const present = outputs.filter(
    (output): output is RecipeFreshnessPublicOutput => output !== null && output !== undefined
  );
  if (present.length === 0 && skipped.length === 0) {
    return null;
  }

  const recipes = [...present.flatMap((output) => output.recipes), ...skipped];
  const errors = present.flatMap((output) => output.errors ?? []);
  const processed = recipes.filter((recipe) => recipe.status !== 'skipped').length;
  const requested = present.reduce((sum, output) => sum + output.requested, 0) + skipped.length;
  const retrievalMayBeStale = recipes.some((recipe) => recipe.retrievalMayBeStale);

  return {
    status: summarizeStatus(recipes),
    requested,
    processed,
    retrievalMayBeStale,
    recipes,
    ...(errors.length > 0 ? { errors: uniqueNonEmptyStrings(errors) } : {}),
  };
}

export function skippedFreshnessOutput(
  recipeIds: readonly string[],
  reason: string
): RecipeFreshnessPublicOutput {
  const recipes = uniqueNonEmptyStrings(recipeIds).map((id) => skippedRecipe(id, reason));
  return {
    status: 'skipped',
    requested: recipes.length,
    processed: 0,
    retrievalMayBeStale: true,
    recipes,
  };
}

export function skippedRecipe(recipeId: string, reason: string): RecipeFreshnessPublicRecipe {
  return {
    recipeId,
    status: 'skipped',
    retrievalMayBeStale: true,
    skippedReason: reason,
    sourceRefs: {
      status: 'skipped',
      activeCount: 0,
      staleCount: 0,
      allCount: 0,
      activeRefs: [],
      staleRefs: [],
    },
    vector: {
      status: 'skipped',
      availabilityStatus: null,
      availabilityReason: null,
      entrySyncStatus: 'skipped',
      regionSyncStatus: 'skipped',
    },
  };
}

async function refreshRecipeFreshnessEntries(
  container: RecipeFreshnessContainer,
  service: RecipeFreshnessService,
  entries: readonly RecipeFreshnessEntry[],
  options: { requested: number; skipped?: RecipeFreshnessPublicRecipe[] }
): Promise<RecipeFreshnessPublicOutput> {
  const skipped = options.skipped ?? [];
  if (entries.length === 0) {
    return (
      mergeFreshnessOutputs([], skipped) ?? {
        status: 'skipped',
        requested: options.requested,
        processed: 0,
        retrievalMayBeStale: true,
        recipes: skipped,
      }
    );
  }

  try {
    const result = await service.refreshRecipes(entries, {
      maxRecipes: Math.max(entries.length, 1),
    });
    const publicResult = summarizeRefreshResult(result, options.requested);
    await syncSemanticMemoriesForFreshRecipes(container, entries, publicResult);
    return mergeFreshnessOutputs([publicResult], skipped) ?? publicResult;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const failedRecipes = entries.map((entry) => ({
      ...skippedRecipe(entry.id, 'recipeFreshnessService-error'),
      status: 'failed' as const,
      errors: [message],
    }));
    return {
      status: 'failed',
      requested: options.requested,
      processed: 0,
      retrievalMayBeStale: true,
      recipes: [...failedRecipes, ...skipped],
      errors: [message],
    };
  }
}

async function syncSemanticMemoriesForFreshRecipes(
  container: RecipeFreshnessContainer,
  entries: readonly RecipeFreshnessEntry[],
  freshness: RecipeFreshnessPublicOutput
): Promise<void> {
  const freshRecipeIds = new Set(
    freshness.recipes
      .filter((recipe) => recipeVectorRefreshWasRunnable(recipe))
      .map((recipe) => recipe.recipeId)
  );
  const freshEntries = entries.filter((entry) => freshRecipeIds.has(entry.id));
  if (freshEntries.length === 0) {
    return;
  }

  await syncRecipeSemanticMemoriesForEntries({
    container: container as import('#inject/ServiceContainer.js').ServiceContainer,
    deleteStale: false,
    entries: freshEntries as readonly RecipeSemanticMemoryEntry[],
    logPrefix: 'recipe-freshness',
  });
}

function recipeVectorRefreshWasRunnable(recipe: RecipeFreshnessPublicRecipe): boolean {
  return (
    recipe.vector.status !== 'failed' &&
    recipe.vector.status !== 'skipped' &&
    recipe.vector.regionSyncStatus !== 'failed' &&
    recipe.vector.regionSyncStatus !== 'skipped'
  );
}

function summarizeRefreshResult(
  result: RecipeFreshnessRefreshResult,
  requested: number
): RecipeFreshnessPublicOutput {
  const recipes = result.recipes.map(summarizeRecipeResult);
  return {
    status: result.status === 'completed' ? 'completed' : result.status,
    requested,
    processed: result.processed,
    retrievalMayBeStale: result.retrievalMayBeStale,
    recipes,
    ...(result.errors.length > 0 ? { errors: result.errors } : {}),
  };
}

function summarizeRecipeResult(result: RecipeFreshnessRecipeResult): RecipeFreshnessPublicRecipe {
  const errors = uniqueNonEmptyStrings(result.errors);
  return {
    recipeId: result.recipeId,
    status: summarizeRecipeStatus(result),
    retrievalMayBeStale: result.retrievalMayBeStale,
    sourceRefs: {
      status: result.sourceRefs.status,
      activeCount: result.sourceRefs.activeRefs.length,
      staleCount: result.sourceRefs.staleRefs.length,
      allCount: result.sourceRefs.allRefs.length,
      activeRefs: boundedStrings(result.sourceRefs.activeRefs),
      staleRefs: boundedStrings(result.sourceRefs.staleRefs),
      reconcile: {
        inserted: result.sourceRefs.inserted,
        active: result.sourceRefs.active,
        stale: result.sourceRefs.stale,
        skipped: result.sourceRefs.skipped,
        recipesProcessed: result.sourceRefs.recipesProcessed,
        ...(result.sourceRefs.cleaned === undefined ? {} : { cleaned: result.sourceRefs.cleaned }),
      },
      ...(result.sourceRefs.errors.length > 0
        ? { errors: uniqueNonEmptyStrings(result.sourceRefs.errors) }
        : {}),
    },
    vector: summarizeVector(result.vector),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function summarizeVector(
  vector: RecipeFreshnessVectorSummary
): RecipeFreshnessPublicRecipe['vector'] {
  const regionSync = vector.regionSync
    ? {
        status: vector.regionSync.status,
        scanned: vector.regionSync.scanned,
        generated: vector.regionSync.generated,
        upserted: vector.regionSync.upserted,
        removed: vector.regionSync.removed,
        ...(vector.regionSync.degradedReason
          ? { degradedReason: vector.regionSync.degradedReason }
          : {}),
        ...(vector.regionSync.errors.length > 0
          ? { errors: uniqueNonEmptyStrings(vector.regionSync.errors) }
          : {}),
      }
    : undefined;

  return {
    status: vector.status,
    availabilityStatus: vector.availability?.status ?? null,
    availabilityReason: vector.availability?.reason ?? null,
    entrySyncStatus: vector.entrySyncStatus,
    regionSyncStatus: vector.regionSyncStatus,
    ...(vector.degradedReason ? { degradedReason: vector.degradedReason } : {}),
    ...(regionSync ? { regionSync } : {}),
    ...(vector.errors.length > 0 ? { errors: uniqueNonEmptyStrings(vector.errors) } : {}),
  };
}

function summarizeRecipeStatus(result: RecipeFreshnessRecipeResult): RecipeFreshnessPublicStatus {
  if (
    result.errors.length > 0 ||
    result.sourceRefs.status === 'failed' ||
    result.vector.status === 'failed'
  ) {
    return 'failed';
  }
  if (result.retrievalMayBeStale || result.vector.status === 'degraded') {
    return 'degraded';
  }
  return 'completed';
}

function summarizeStatus(
  recipes: readonly RecipeFreshnessPublicRecipe[]
): RecipeFreshnessPublicStatus {
  if (recipes.length === 0) {
    return 'skipped';
  }
  if (recipes.some((recipe) => recipe.status === 'failed')) {
    return 'failed';
  }
  if (recipes.some((recipe) => recipe.status === 'degraded')) {
    return 'degraded';
  }
  if (recipes.every((recipe) => recipe.status === 'skipped')) {
    return 'skipped';
  }
  return 'completed';
}

async function loadRecipeFreshnessEntry(
  container: RecipeFreshnessContainer,
  recipeId: string
): Promise<RecipeFreshnessEntry | null> {
  try {
    const repo = container.get('knowledgeRepository') as KnowledgeRepository | null;
    const entry = await repo?.findById?.(recipeId);
    return toRecipeFreshnessEntry(entry);
  } catch {
    return null;
  }
}

function getRecipeFreshnessService(
  container: RecipeFreshnessContainer
): RecipeFreshnessService | null {
  try {
    const service = container.get('recipeFreshnessService') as RecipeFreshnessService | null;
    if (service && typeof service.refreshRecipes === 'function') {
      return service;
    }
  } catch {
    return null;
  }
  return null;
}

export function toRecipeFreshnessEntry(value: unknown): RecipeFreshnessEntry | null {
  const jsonValue = toJsonRecord(value);
  if (!jsonValue) {
    return null;
  }
  const id = stringValue(jsonValue.id);
  if (!id) {
    return null;
  }

  const entry: RecipeFreshnessEntry = { id };
  copyStringFields(jsonValue, entry);
  copyArrayField(jsonValue, entry, 'tags');
  copyAnyField(jsonValue, entry, 'content');
  copyAnyField(jsonValue, entry, 'reasoning');
  copyNullableStringField(jsonValue, entry, 'sourceFile');
  copyUpdatedAt(jsonValue, entry);
  return entry;
}

function copyStringFields(source: Record<string, unknown>, target: RecipeFreshnessEntry): void {
  for (const field of STRING_RECIPE_FRESHNESS_FIELDS) {
    const value = stringValue(source[field]);
    if (value) {
      (target as unknown as Record<string, unknown>)[field] = value;
    }
  }
}

function copyArrayField(
  source: Record<string, unknown>,
  target: RecipeFreshnessEntry,
  field: 'tags'
): void {
  const values = stringArray(source[field]);
  if (values.length > 0) {
    target[field] = values;
  }
}

function copyAnyField(
  source: Record<string, unknown>,
  target: RecipeFreshnessEntry,
  field: 'content' | 'reasoning'
): void {
  if (source[field] !== undefined) {
    target[field] = source[field];
  }
}

function copyNullableStringField(
  source: Record<string, unknown>,
  target: RecipeFreshnessEntry,
  field: 'sourceFile'
): void {
  const value = nullableStringValue(source[field]);
  if (value !== undefined) {
    target[field] = value;
  }
}

function copyUpdatedAt(source: Record<string, unknown>, target: RecipeFreshnessEntry): void {
  const value = source.updatedAt;
  if (typeof value === 'number' || typeof value === 'string') {
    target.updatedAt = value;
  }
}

function toJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value) && typeof value.toJSON === 'function') {
    const json = value.toJSON();
    return isRecord(json) ? json : null;
  }
  return isRecord(value) ? value : null;
}

function boundedStrings(value: readonly string[], max = 10): string[] {
  return uniqueNonEmptyStrings(value).slice(0, max);
}

function uniqueNonEmptyStrings(value: readonly string[]): string[] {
  return [...new Set(value.filter((item) => item.trim().length > 0))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return stringValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
