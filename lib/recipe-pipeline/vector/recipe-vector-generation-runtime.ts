import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import {
  JsonVectorAdapter,
  RECIPE_REGION_VECTOR_ID_PREFIX,
  RecipeVectorGenerationManager,
  type RecipeVectorGenerationManifest,
  type RecipeVectorGenerationRoute,
  type RecipeVectorGenerationRouter,
  type RecipeVectorGenerationStoreFactory,
  VectorStore,
} from '@alembic/core/vector';

const GENERATION_ROOT = '.asd/context/recipe-vector-generations';
const ACTIVE_ROUTE_FILE = `${GENERATION_ROOT}/active.json`;
export const RECIPE_VECTOR_GENERATION_MANAGER_KEY = '_recipeVectorGenerationManager';

export interface RecipeVectorGenerationRuntime {
  generationManager: RecipeVectorGenerationManager;
  router: RecipeVectorGenerationRouter;
  storeFactory: RecipeVectorGenerationStoreFactory;
  vectorStore: VectorStore;
}

export function createRecipeVectorGenerationRuntime(input: {
  baseStore: VectorStore;
  dataRoot: string;
  writeZone?: WriteZone;
}): RecipeVectorGenerationRuntime {
  const persistence = new GenerationPersistence(input.dataRoot, input.writeZone);
  const factory = new JsonGenerationStoreFactory(persistence);
  const router = new FileGenerationRouter(persistence);
  return {
    generationManager: new RecipeVectorGenerationManager(factory, router),
    router,
    storeFactory: factory,
    vectorStore: new RoutedRecipeVectorStore(input.baseStore, router, factory),
  };
}

class FileGenerationRouter implements RecipeVectorGenerationRouter {
  readonly #persistence: GenerationPersistence;
  #activationTail: Promise<void> = Promise.resolve();

  constructor(persistence: GenerationPersistence) {
    this.#persistence = persistence;
  }

  async readActive(): Promise<RecipeVectorGenerationRoute | null> {
    return this.#persistence.readJson<RecipeVectorGenerationRoute>(ACTIVE_ROUTE_FILE);
  }

  async activate(
    next: RecipeVectorGenerationRoute,
    expectedPreviousGenerationId: string | null
  ): Promise<boolean> {
    const predecessor = this.#activationTail;
    let release: () => void = () => undefined;
    this.#activationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      const current = await this.readActive();
      if ((current?.generationId ?? null) !== expectedPreviousGenerationId) {
        return false;
      }
      await this.#persistence.writeJsonAtomic(ACTIVE_ROUTE_FILE, next);
      return true;
    } finally {
      release();
    }
  }
}

class JsonGenerationStoreFactory implements RecipeVectorGenerationStoreFactory {
  readonly #persistence: GenerationPersistence;
  readonly #stores = new Map<string, JsonVectorAdapter>();

  constructor(persistence: GenerationPersistence) {
    this.#persistence = persistence;
  }

  async createShadow(generationId: string): Promise<VectorStore> {
    await this.removeGeneration(generationId);
    return this.#open(generationId);
  }

  async open(generationId: string): Promise<VectorStore> {
    if (!(await this.#persistence.generationExists(generationId))) {
      throw new Error(`recipe-vector-generation-not-found:${generationId}`);
    }
    return this.#open(generationId);
  }

  async writeManifest(
    generationId: string,
    manifest: RecipeVectorGenerationManifest
  ): Promise<void> {
    await this.#persistence.writeJsonAtomic(
      `${this.#persistence.generationRelativeDir(generationId)}/manifest.json`,
      manifest
    );
  }

  async readManifest(generationId: string): Promise<RecipeVectorGenerationManifest | null> {
    return this.#persistence.readJson<RecipeVectorGenerationManifest>(
      `${this.#persistence.generationRelativeDir(generationId)}/manifest.json`
    );
  }

  async removeGeneration(generationId: string): Promise<void> {
    this.#stores.get(generationId)?.destroy();
    this.#stores.delete(generationId);
    await this.#persistence.removeGeneration(generationId);
  }

  async removeRecipeDocumentFromEveryGeneration(id: string): Promise<void> {
    const failures: string[] = [];
    for (const generationId of await this.#persistence.listGenerationIds()) {
      try {
        const store = await this.open(generationId);
        await store.remove(id);
      } catch (error) {
        failures.push(`${generationId}:${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`recipe-vector-generation-remove-failed:${failures.join(',')}`);
    }
  }

  async #open(generationId: string): Promise<JsonVectorAdapter> {
    const cached = this.#stores.get(generationId);
    if (cached) {
      return cached;
    }
    const indexPath = this.#persistence.absolute(
      `${this.#persistence.generationRelativeDir(generationId)}/vector_index.json`
    );
    const store = new JsonVectorAdapter(this.#persistence.dataRoot, {
      indexPath,
      ...(this.#persistence.writeZone ? { writeZone: this.#persistence.writeZone } : {}),
    });
    await store.init();
    this.#stores.set(generationId, store);
    return store;
  }
}

class RoutedRecipeVectorStore extends VectorStore {
  readonly #base: VectorStore;
  readonly #router: RecipeVectorGenerationRouter;
  readonly #factory: JsonGenerationStoreFactory;

  constructor(
    base: VectorStore,
    router: RecipeVectorGenerationRouter,
    factory: JsonGenerationStoreFactory
  ) {
    super();
    this.#base = base;
    this.#router = router;
    this.#factory = factory;
  }

  async init(): Promise<void> {
    await this.#base.init();
  }

  async upsert(item: Parameters<VectorStore['upsert']>[0]): Promise<void> {
    const target = isRecipeDocumentId(item.id) ? await this.#activeStore() : null;
    await (target ?? this.#base).upsert(item);
  }

  async batchUpsert(items: Parameters<VectorStore['batchUpsert']>[0]): Promise<void> {
    const recipeItems = items.filter((item) => isRecipeDocumentId(item.id));
    const baseItems = items.filter((item) => !isRecipeDocumentId(item.id));
    const active = recipeItems.length > 0 ? await this.#activeStore() : null;
    if (baseItems.length > 0) {
      await this.#base.batchUpsert(baseItems);
    }
    if (recipeItems.length > 0) {
      await (active ?? this.#base).batchUpsert(recipeItems);
    }
  }

  async remove(id: string): Promise<void> {
    const failures: string[] = [];
    try {
      await this.#base.remove(id);
    } catch (error) {
      failures.push(`base:${errorMessage(error)}`);
    }
    if (isRecipeDocumentId(id)) {
      try {
        await this.#factory.removeRecipeDocumentFromEveryGeneration(id);
      } catch (error) {
        failures.push(`generations:${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`recipe-vector-remove-failed:${failures.join(',')}`);
    }
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const active = await this.#activeStore();
    if (active && isLegacyEntryDocumentId(id)) {
      return null;
    }
    if (isRecipeDocumentId(id)) {
      if (active) {
        return active.getById(id);
      }
    }
    return this.#base.getById(id);
  }

  async searchVector(
    queryVector: number[],
    options: Record<string, unknown> = {}
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>> {
    const active = await this.#activeStore();
    const [baseHits, generationHits] = await Promise.all([
      this.#base.searchVector(queryVector, options),
      active ? active.searchVector(queryVector, options) : Promise.resolve([]),
    ]);
    return mergeHits(baseHits, generationHits, options, Boolean(active));
  }

  async searchByFilter(filter: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const active = await this.#activeStore();
    const [baseItems, generationItems] = await Promise.all([
      this.#base.searchByFilter(filter),
      active ? active.searchByFilter(filter) : Promise.resolve([]),
    ]);
    return mergeItems(baseItems, generationItems, Boolean(active));
  }

  async listIds(): Promise<string[]> {
    const active = await this.#activeStore();
    const [baseIds, generationIds] = await Promise.all([
      this.#base.listIds(),
      active ? active.listIds() : Promise.resolve([]),
    ]);
    return [
      ...new Set([
        ...baseIds.filter((id) => !active || !isSupersededBaseDocumentId(id)),
        ...generationIds,
      ]),
    ];
  }

  async clear(): Promise<void> {
    // Generic index rebuilds may clear the mutable base lane, but the active
    // Recipe generation remains queryable until a verified shadow replaces it.
    // Clearing it in place would leave a healthy-looking route/manifest that
    // points at an empty document set.
    await this.#base.clear();
  }

  async getStats(): Promise<{ count: number; indexSize: number }> {
    const active = await this.#activeStore();
    const [base, generation] = await Promise.all([
      this.#base.getStats(),
      active ? active.getStats() : Promise.resolve({ count: 0, indexSize: 0 }),
    ]);
    return {
      count: (await this.listIds()).length,
      indexSize: base.indexSize + generation.indexSize,
    };
  }

  destroy(): void {
    this.#base.destroy();
  }

  async #activeStore(): Promise<VectorStore | null> {
    const active = await this.#router.readActive();
    return active ? this.#factory.open(active.generationId) : null;
  }
}

class GenerationPersistence {
  readonly dataRoot: string;
  readonly writeZone?: WriteZone;

  constructor(dataRoot: string, writeZone?: WriteZone) {
    this.dataRoot = dataRoot;
    this.writeZone = writeZone;
  }

  absolute(relativePath: string): string {
    return path.join(this.dataRoot, relativePath);
  }

  generationRelativeDir(generationId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(generationId)) {
      throw new Error('recipe-vector-generation-id-invalid');
    }
    return `${GENERATION_ROOT}/${generationId}`;
  }

  async generationExists(generationId: string): Promise<boolean> {
    try {
      return (await stat(this.absolute(this.generationRelativeDir(generationId)))).isDirectory();
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  async listGenerationIds(): Promise<string[]> {
    const root = this.absolute(GENERATION_ROOT);
    try {
      return (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  async readJson<T>(relativePath: string): Promise<T | null> {
    const file = this.absolute(relativePath);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(`recipe-vector-json-invalid:${relativePath}:${errorMessage(error)}`);
    }
  }

  async writeJsonAtomic(relativePath: string, value: unknown): Promise<void> {
    const temporaryPath = `${relativePath}.tmp`;
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (this.writeZone) {
      const temporary = this.writeZone.data(temporaryPath);
      const target = this.writeZone.data(relativePath);
      await this.writeZone.writeFileAsync(temporary, content);
      this.writeZone.rename(temporary, target);
      return;
    }
    const target = this.absolute(relativePath);
    const temporary = this.absolute(temporaryPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, content);
    await rename(temporary, target);
  }

  async removeGeneration(generationId: string): Promise<void> {
    const relativeDir = this.generationRelativeDir(generationId);
    if (this.writeZone) {
      await this.writeZone.removeAsync(this.writeZone.data(relativeDir), { recursive: true });
      return;
    }
    await rm(this.absolute(relativeDir), { force: true, recursive: true });
  }
}

function isRecipeDocumentId(id: string): boolean {
  return id.startsWith(RECIPE_REGION_VECTOR_ID_PREFIX);
}

function isLegacyEntryDocumentId(id: string): boolean {
  return id.startsWith('entry_');
}

function isSupersededBaseDocumentId(id: string): boolean {
  return isRecipeDocumentId(id) || isLegacyEntryDocumentId(id);
}

function itemId(item: Record<string, unknown>): string {
  return typeof item.id === 'string' ? item.id : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'ENOENT'
  );
}

function mergeHits(
  baseHits: Array<{ item: Record<string, unknown>; score: number }>,
  generationHits: Array<{ item: Record<string, unknown>; score: number }>,
  options: Record<string, unknown>,
  hasActiveGeneration: boolean
) {
  const byId = new Map<string, { item: Record<string, unknown>; score: number }>();
  for (const hit of [...baseHits, ...generationHits]) {
    const id = itemId(hit.item);
    if (!id || (hasActiveGeneration && baseHits.includes(hit) && isSupersededBaseDocumentId(id))) {
      continue;
    }
    const current = byId.get(id);
    if (!current || hit.score > current.score) {
      byId.set(id, hit);
    }
  }
  const topK = typeof options.topK === 'number' ? options.topK : 10;
  return [...byId.values()].sort((left, right) => right.score - left.score).slice(0, topK);
}

function mergeItems(
  baseItems: Record<string, unknown>[],
  generationItems: Record<string, unknown>[],
  hasActiveGeneration: boolean
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of baseItems) {
    const id = itemId(item);
    if (id && (!hasActiveGeneration || !isSupersededBaseDocumentId(id))) {
      byId.set(id, item);
    }
  }
  for (const item of generationItems) {
    const id = itemId(item);
    if (id) {
      byId.set(id, item);
    }
  }
  return [...byId.values()];
}
