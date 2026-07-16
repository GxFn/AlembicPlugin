import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '@alembic/core/events';
import type { RecipeRetrievalProfile } from '@alembic/core/knowledge';
import {
  type EmbeddingPort,
  JsonVectorAdapter,
  RECIPE_REGION_VECTOR_ID_PREFIX,
  type RecipeRegionSourceEntry,
  syncRecipeSemanticRegionVectors,
  VectorLifecycleCoordinator,
} from '@alembic/core/vector';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecipeVectorGenerationRuntime } from '../../lib/recipe-pipeline/vector/recipe-vector-generation-runtime.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('Recipe vector generation runtime', () => {
  it('removes a deleted Recipe identity across content-hash generations and the legacy base', async () => {
    const dataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'alembic-recipe-generation-delete-')
    );
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    await base.init();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    const recipeId = 'recipe-delete-1';
    const oldId = canonicalRecipeVectorId(recipeId, 'a'.repeat(24));
    const newId = canonicalRecipeVectorId(recipeId, 'b'.repeat(24));
    const oldGuidanceId = canonicalRecipeVectorId(
      recipeId,
      'c'.repeat(24),
      'applicability',
      'guidance'
    );
    const newGuidanceId = canonicalRecipeVectorId(
      recipeId,
      'd'.repeat(24),
      'applicability',
      'guidance'
    );
    const legacyId = `entry_${recipeId}`;

    await base.upsert(vectorItem(legacyId, recipeId, 'legacy base'));
    await base.upsert(vectorItem(oldId, recipeId, 'stale canonical base'));
    const oldGeneration = await runtime.storeFactory.createShadow('generation-old');
    await oldGeneration.batchUpsert([
      vectorItem(oldId, recipeId, 'old generation intent'),
      vectorItem(oldGuidanceId, recipeId, 'old generation guidance'),
    ]);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-old', manifestHash: 'manifest-old' },
        null
      )
    ).toBe(true);

    const newGeneration = await runtime.storeFactory.createShadow('generation-new');
    await newGeneration.batchUpsert([
      vectorItem(newId, recipeId, 'new generation intent'),
      vectorItem(newGuidanceId, recipeId, 'new generation guidance'),
    ]);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-new', manifestHash: 'manifest-new' },
        'generation-old'
      )
    ).toBe(true);

    const cleanup = await syncRecipeSemanticRegionVectors(runtime.vectorStore, null, [], {
      maintenanceScope: {
        kind: 'authoritative-corpus',
        nonDeprecatedRecipeIds: [],
      },
      removeStale: true,
    });

    expect(cleanup).toMatchObject({ removed: 2 });
    expect(await base.getById(legacyId)).toBeNull();
    expect(await base.getById(oldId)).toBeNull();
    expect(await newGeneration.getById(newId)).toBeNull();
    expect(await newGeneration.getById(newGuidanceId)).toBeNull();
    expect(await oldGeneration.getById(oldId)).toBeNull();
    expect(await oldGeneration.getById(oldGuidanceId)).toBeNull();
    expect(
      await runtime.generationManager.rollback({
        generationId: 'generation-old',
        manifestHash: 'manifest-old',
      })
    ).toBe(true);
    expect(await runtime.vectorStore.getById(oldId)).toBeNull();
    expect(await runtime.vectorStore.listIds()).not.toContain(oldId);
    expect(
      (await runtime.vectorStore.searchVector([1, 0], { topK: 10 })).map((hit) => hit.item.id)
    ).not.toContain(oldId);
  });

  it.each([
    ['knowledge deletion', 'knowledge:deleted', { entryId: 'recipe-terminal-1' }],
    [
      'deprecated transition',
      'lifecycle:transition',
      { entryId: 'recipe-terminal-1', to: 'deprecated' },
    ],
  ])('removes provider-offline terminal truth from base and rollback-only generations after %s', async (_label, eventName, payload) => {
    const dataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'alembic-recipe-generation-terminal-')
    );
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    await base.init();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    const recipeId = 'recipe-terminal-1';
    const legacyId = `entry_${recipeId}`;
    const baseCanonicalId = canonicalRecipeVectorId(recipeId, 'a'.repeat(24));
    const rollbackIntentId = canonicalRecipeVectorId(recipeId, 'b'.repeat(24));
    const rollbackGuidanceId = canonicalRecipeVectorId(
      recipeId,
      'c'.repeat(24),
      'applicability',
      'guidance'
    );
    const rollbackUnrelatedId = canonicalRecipeVectorId('recipe-unrelated-1', 'd'.repeat(24));
    const currentUnrelatedId = canonicalRecipeVectorId('recipe-unrelated-2', 'e'.repeat(24));

    await base.batchUpsert([
      vectorItem(legacyId, recipeId, 'legacy base residue'),
      vectorItem(baseCanonicalId, recipeId, 'canonical base residue'),
    ]);
    const rollbackGeneration = await runtime.storeFactory.createShadow('generation-rollback');
    await rollbackGeneration.batchUpsert([
      vectorItem(rollbackIntentId, recipeId, 'rollback-only target intent'),
      vectorItem(rollbackGuidanceId, recipeId, 'rollback-only target guidance'),
      vectorItem(rollbackUnrelatedId, 'recipe-unrelated-1', 'rollback unrelated'),
    ]);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-rollback', manifestHash: 'manifest-rollback' },
        null
      )
    ).toBe(true);
    const currentGeneration = await runtime.storeFactory.createShadow('generation-current');
    await currentGeneration.upsert(
      vectorItem(currentUnrelatedId, 'recipe-unrelated-2', 'current unrelated')
    );
    expect(
      await runtime.router.activate(
        { generationId: 'generation-current', manifestHash: 'manifest-current' },
        'generation-rollback'
      )
    ).toBe(true);

    const eventBus = new EventBus({ maxListeners: 10 });
    const coordinator = new VectorLifecycleCoordinator({
      vectorStore: runtime.vectorStore,
      embedProvider: null,
      contextualEnricher: null,
      debounceMs: 60_000,
      recipeVectorTruthRemover: runtime.recipeVectorTruthRemover,
    });
    coordinator.bindEventBus(eventBus);
    eventBus.emit(eventName, payload);
    await coordinator.flush();

    expect(await base.getById(legacyId)).toBeNull();
    expect(await base.getById(baseCanonicalId)).toBeNull();
    expect(await rollbackGeneration.getById(rollbackIntentId)).toBeNull();
    expect(await rollbackGeneration.getById(rollbackGuidanceId)).toBeNull();
    expect(await rollbackGeneration.getById(rollbackUnrelatedId)).not.toBeNull();
    expect(await currentGeneration.getById(currentUnrelatedId)).not.toBeNull();
    expect(
      await runtime.generationManager.rollback({
        generationId: 'generation-rollback',
        manifestHash: 'manifest-rollback',
      })
    ).toBe(true);
    expect(await runtime.vectorStore.getById(rollbackIntentId)).toBeNull();
    expect(await runtime.vectorStore.getById(rollbackUnrelatedId)).not.toBeNull();
    await coordinator.destroy();
  });

  it('surfaces partial terminal cleanup and completes it on an idempotent retry', async () => {
    const dataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'alembic-recipe-generation-terminal-retry-')
    );
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    await base.init();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    const recipeId = 'recipe-terminal-retry-1';
    const legacyId = `entry_${recipeId}`;
    const baseCanonicalId = canonicalRecipeVectorId(recipeId, 'f'.repeat(24));
    const rollbackId = canonicalRecipeVectorId(recipeId, '1'.repeat(24));
    await base.batchUpsert([
      vectorItem(legacyId, recipeId, 'legacy retry residue'),
      vectorItem(baseCanonicalId, recipeId, 'canonical retry residue'),
    ]);
    const rollbackGeneration = await runtime.storeFactory.createShadow('generation-retry-old');
    await rollbackGeneration.upsert(vectorItem(rollbackId, recipeId, 'rollback retry target'));

    const truthRemover = runtime.recipeVectorTruthRemover;
    const originalRemove = base.remove.bind(base);
    let failed = false;
    vi.spyOn(base, 'remove').mockImplementation(async (id: string) => {
      if (id === legacyId && !failed) {
        failed = true;
        throw new Error('base-terminal-remove-failed');
      }
      await originalRemove(id);
    });

    await expect(truthRemover.removeRecipeByIdentity(recipeId)).rejects.toThrow(
      'base-terminal-remove-failed'
    );
    expect(await rollbackGeneration.getById(rollbackId)).toBeNull();
    await expect(truthRemover.removeRecipeByIdentity(recipeId)).resolves.toBeUndefined();
    expect(await base.getById(legacyId)).toBeNull();
    expect(await base.getById(baseCanonicalId)).toBeNull();
  });

  it('does not let a failed terminal cleanup erase a newer same-Recipe upsert', async () => {
    const dataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'alembic-recipe-generation-terminal-newer-event-')
    );
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    await base.init();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    expect(runtime.recipeVectorTruthRemover).toBeDefined();
    const eventBus = new EventBus({ maxListeners: 10 });
    const recipeId = 'recipe-terminal-newer-event-1';
    const replacement = {
      ...generationRecipe(),
      id: recipeId,
      title: 'Newer live replacement wins over the failed terminal event',
    };
    const controlledRemover = {
      removeRecipeByIdentity: vi.fn(async (removedRecipeId: string) => {
        eventBus.emit('knowledge:changed', {
          action: 'update',
          entryId: removedRecipeId,
          entry: replacement,
        });
        throw new Error('terminal-cleanup-failed-before-newer-event');
      }),
    };
    const coordinator = new VectorLifecycleCoordinator({
      vectorStore: runtime.vectorStore,
      embedProvider: embedProvider(),
      contextualEnricher: null,
      debounceMs: 60_000,
      recipeVectorTruthRemover: controlledRemover,
    });
    coordinator.bindEventBus(eventBus);
    eventBus.emit('knowledge:deleted', { entryId: recipeId });

    await expect(coordinator.flush()).rejects.toThrow('terminal-cleanup-failed-before-newer-event');
    await coordinator.flush();

    expect(controlledRemover.removeRecipeByIdentity).toHaveBeenCalledOnce();
    expect(
      (await runtime.vectorStore.listIds()).some(
        (id) => id.startsWith(RECIPE_REGION_VECTOR_ID_PREFIX) && id.includes(recipeId)
      )
    ).toBe(true);
    await coordinator.destroy();
  });

  it('preserves a live replacement while retiring its stale content-hash id', async () => {
    const dataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'alembic-recipe-generation-live-update-')
    );
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    await base.init();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    const recipeId = 'recipe-live-update-1';
    const staleId = canonicalRecipeVectorId(recipeId, 'c'.repeat(24));
    const replacementId = canonicalRecipeVectorId(recipeId, 'd'.repeat(24));
    const active = await runtime.storeFactory.createShadow('generation-live-update');
    await active.batchUpsert([
      vectorItem(staleId, recipeId, 'stale'),
      vectorItem(replacementId, recipeId, 'replacement'),
    ]);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-live-update', manifestHash: 'manifest-live-update' },
        null
      )
    ).toBe(true);

    await runtime.vectorStore.remove(staleId);

    expect(await runtime.vectorStore.getById(staleId)).toBeNull();
    expect(await runtime.vectorStore.getById(replacementId)).toMatchObject({
      content: 'replacement',
    });
  });

  it('serializes active-route CAS across independent runtimes sharing one dataRoot', async () => {
    const dataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'alembic-recipe-generation-multi-runtime-')
    );
    roots.push(dataRoot);
    const baseA = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-a.json'),
    });
    const baseB = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-b.json'),
    });
    await Promise.all([baseA.init(), baseB.init()]);
    const runtimeA = createRecipeVectorGenerationRuntime({ baseStore: baseA, dataRoot });
    const runtimeB = createRecipeVectorGenerationRuntime({ baseStore: baseB, dataRoot });
    expect(
      await runtimeA.router.activate({ generationId: 'seed', manifestHash: 'seed-hash' }, null)
    ).toBe(true);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const previous = await runtimeA.router.readActive();
      const left = {
        generationId: `left-${attempt}`,
        manifestHash: `left-hash-${attempt}`,
      };
      const right = {
        generationId: `right-${attempt}`,
        manifestHash: `right-hash-${attempt}`,
      };
      const outcomes = await Promise.allSettled([
        runtimeA.router.activate(left, previous?.generationId ?? null),
        runtimeB.router.activate(right, previous?.generationId ?? null),
      ]);

      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      const values = outcomes
        .filter(
          (outcome): outcome is PromiseFulfilledResult<boolean> => outcome.status === 'fulfilled'
        )
        .map((outcome) => outcome.value)
        .sort();
      expect(values).toEqual([false, true]);
      expect(await runtimeB.router.readActive()).toEqual(await runtimeA.router.readActive());
      expect([left.generationId, right.generationId]).toContain(
        (await runtimeA.router.readActive())?.generationId
      );
    }
    const generationFiles = await fs.promises.readdir(
      path.join(dataRoot, '.asd/context/recipe-vector-generations')
    );
    expect(
      generationFiles.filter((name) => name.startsWith('active.json.') && name.endsWith('.tmp'))
    ).toEqual([]);
    await expect(
      fs.promises.stat(path.join(dataRoot, '.asd/context/recipe-vector-generations.active.lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('routes only verified active generations, supports rollback, and removes offline across stores', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipe-generation-'));
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    base.initSync();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    const recipeId = `${RECIPE_REGION_VECTOR_ID_PREFIX}recipe-1:intent`;
    const staleRecipeId = `${RECIPE_REGION_VECTOR_ID_PREFIX}stale-recipe:intent`;
    const legacyRecipeId = 'entry_recipe-1';
    const generalId = 'source-document-1';
    await runtime.vectorStore.upsert({
      id: generalId,
      content: 'general',
      vector: [0, 1],
      metadata: { type: 'source' },
    });
    await runtime.vectorStore.upsert({
      id: legacyRecipeId,
      content: 'legacy generic Recipe candidate',
      vector: [1, 0],
      metadata: { kind: 'pattern' },
    });
    await runtime.vectorStore.upsert({
      id: staleRecipeId,
      content: 'stale canonical Recipe candidate',
      vector: [1, 0],
      metadata: { kind: 'pattern' },
    });

    const resetShadow = await runtime.storeFactory.createShadow('generation-reset');
    await resetShadow.upsert({
      id: recipeId,
      content: 'must be cleared',
      vector: [1, 0],
      metadata: {},
    });
    const cleanShadow = await runtime.storeFactory.createShadow('generation-reset');
    expect(await cleanShadow.getById(recipeId)).toBeNull();

    const first = await runtime.storeFactory.createShadow('generation-1');
    await first.upsert({
      id: recipeId,
      content: 'first generation',
      vector: [1, 0],
      metadata: { generationId: 'generation-1' },
    });
    expect(
      await runtime.router.activate(
        { generationId: 'generation-1', manifestHash: 'manifest-1' },
        null
      )
    ).toBe(true);
    expect(await runtime.vectorStore.getById(recipeId)).toMatchObject({
      content: 'first generation',
    });
    expect(await runtime.vectorStore.getById(generalId)).toMatchObject({ content: 'general' });
    expect(await runtime.vectorStore.getById(legacyRecipeId)).toBeNull();
    expect(await runtime.vectorStore.getById(staleRecipeId)).toBeNull();
    expect(await runtime.vectorStore.listIds()).not.toContain(legacyRecipeId);
    expect(await runtime.vectorStore.listIds()).not.toContain(staleRecipeId);
    expect(
      (await runtime.vectorStore.searchVector([1, 0], { topK: 10 })).map((hit) => hit.item.id)
    ).not.toContain(legacyRecipeId);

    const second = await runtime.storeFactory.createShadow('generation-2');
    await second.upsert({
      id: recipeId,
      content: 'second generation',
      vector: [1, 0],
      metadata: { generationId: 'generation-2' },
    });
    const concurrentActivation = await Promise.all([
      runtime.router.activate(
        { generationId: 'generation-2', manifestHash: 'manifest-2' },
        'generation-1'
      ),
      runtime.router.activate(
        { generationId: 'generation-reset', manifestHash: 'manifest-reset' },
        'generation-1'
      ),
    ]);
    expect([...concurrentActivation].sort()).toEqual([false, true]);
    const concurrentWinner = await runtime.router.readActive();
    expect(['generation-2', 'generation-reset']).toContain(concurrentWinner?.generationId);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-1', manifestHash: 'manifest-1' },
        concurrentWinner?.generationId ?? null
      )
    ).toBe(true);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-2', manifestHash: 'manifest-2' },
        null
      )
    ).toBe(false);
    expect(await runtime.vectorStore.getById(recipeId)).toMatchObject({
      content: 'first generation',
    });
    expect(
      await runtime.router.activate(
        { generationId: 'generation-2', manifestHash: 'manifest-2' },
        'generation-1'
      )
    ).toBe(true);
    expect(await runtime.vectorStore.getById(recipeId)).toMatchObject({
      content: 'second generation',
    });

    expect(
      await runtime.generationManager.rollback({
        generationId: 'generation-1',
        manifestHash: 'manifest-1',
      })
    ).toBe(true);
    expect(await runtime.vectorStore.getById(recipeId)).toMatchObject({
      content: 'first generation',
    });

    await runtime.vectorStore.clear();
    expect(await runtime.vectorStore.getById(generalId)).toBeNull();
    expect(await runtime.vectorStore.getById(recipeId)).toMatchObject({
      content: 'first generation',
    });
    expect(await runtime.router.readActive()).toEqual({
      generationId: 'generation-1',
      manifestHash: 'manifest-1',
    });

    vi.spyOn(base, 'remove').mockRejectedValueOnce(new Error('base-remove-failed'));
    await expect(runtime.vectorStore.remove(recipeId)).rejects.toThrow(
      'recipe-vector-remove-failed:base:base-remove-failed'
    );
    expect(await first.getById(recipeId)).toBeNull();
    expect(await second.getById(recipeId)).toBeNull();
    expect(await runtime.vectorStore.getById(recipeId)).toBeNull();
    expect(await runtime.vectorStore.getById(generalId)).toBeNull();
  });

  it('builds the Core document set in a verified shadow and preserves active truth on failure', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipe-generation-build-'));
    roots.push(dataRoot);
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    base.initSync();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });
    const recipe = generationRecipe();

    const full = await runtime.generationManager.buildAndActivate([recipe], embedProvider());
    expect(full).toMatchObject({
      status: 'activated',
      inspection: { healthy: true },
      manifest: { createdFrom: 'full-build', status: 'ready' },
    });
    expect(full.manifest?.expectedIds.length).toBeGreaterThan(0);
    for (const id of full.manifest?.expectedIds ?? []) {
      expect(await runtime.vectorStore.getById(id)).toMatchObject({
        metadata: expect.objectContaining({
          documentSetHash: expect.any(String),
          profileHash: expect.any(String),
          sourceContentHash: expect.any(String),
        }),
      });
    }

    const incremental = await runtime.generationManager.buildAndActivate(
      [recipe],
      embedProvider(),
      { createdFrom: 'incremental' }
    );
    expect(incremental).toMatchObject({
      status: 'already-active',
      generationId: full.generationId,
      manifest: { manifestHash: full.manifest?.manifestHash },
    });

    const failed = await runtime.generationManager.buildAndActivate(
      [recipe],
      embedProvider({ fail: true, model: 'changed-model' })
    );
    expect(failed).toMatchObject({
      status: 'failed',
      active: full.active,
    });
    expect(await runtime.router.readActive()).toEqual(full.active);
    const preservedId = full.manifest?.expectedIds[0] ?? '';
    expect(preservedId).not.toBe('');
    expect(await runtime.vectorStore.getById(preservedId)).not.toBeNull();
  });

  it('fails closed instead of treating a corrupt active route as no generation', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipe-route-corrupt-'));
    roots.push(dataRoot);
    const routeFile = path.join(dataRoot, '.asd/context/recipe-vector-generations/active.json');
    await fs.promises.mkdir(path.dirname(routeFile), { recursive: true });
    await fs.promises.writeFile(routeFile, '{not-json');
    const base = new JsonVectorAdapter(dataRoot, {
      indexPath: path.join(dataRoot, '.asd/context/base-vector-index.json'),
    });
    base.initSync();
    const runtime = createRecipeVectorGenerationRuntime({ baseStore: base, dataRoot });

    await expect(runtime.router.readActive()).rejects.toThrow('recipe-vector-json-invalid');
    await expect(
      runtime.router.activate({ generationId: 'generation-1', manifestHash: 'manifest-1' }, null)
    ).rejects.toThrow('recipe-vector-json-invalid');
  });
});

function canonicalRecipeVectorId(
  recipeId: string,
  hash: string,
  regionClass = 'identity',
  documentRole = 'intent'
): string {
  return `${RECIPE_REGION_VECTOR_ID_PREFIX}${recipeId}_${regionClass}_ps1_${documentRole}_${hash}`;
}

function vectorItem(id: string, recipeId: string, content: string) {
  return {
    id,
    content,
    vector: [1, 0],
    metadata: { recipeId, type: 'recipe-semantic-region' },
  };
}

function generationRecipe(): RecipeRegionSourceEntry {
  const source: RecipeRegionSourceEntry = {
    id: 'recipe-generation-1',
    title: 'Build Recipe retrieval vectors in a shadow generation',
    description: 'Keep the active generation queryable until exact verification succeeds.',
    trigger: 'when Recipe retrieval truth changes',
    lifecycle: 'active',
    language: 'typescript',
    category: 'architecture',
    kind: 'pattern',
    knowledgeType: 'code-pattern',
    whenClause: 'When the provider, model, dimension, projection schema, or corpus changes.',
    doClause: 'Build and verify the complete document set before activation.',
    dontClause: 'Do not mutate or clear the active generation before verification.',
    coreCode: 'const shadow = await factory.createShadow(generationId);',
    content: {
      pattern: 'const shadow = await factory.createShadow(generationId);',
      rationale: 'Atomic activation prevents partial mixed-generation reads.',
    },
    reasoning: {
      whyStandard: 'A failed rebuild must preserve the current searchable generation.',
      sources: ['lib/recipe-pipeline/vector/recipe-vector-generation-runtime.ts:1-80'],
    },
  };
  const retrievalProfile: RecipeRetrievalProfile = {
    schemaVersion: '1',
    primaryLanguage: 'en',
    summary: {
      primary: 'Build and verify a shadow Recipe vector generation before activation.',
      technicalEnglish: 'Use compare-and-swap activation to preserve the active generation.',
    },
    concepts: [
      {
        term: 'shadow generation',
        language: 'en',
        provenanceRefs: ['field:description'],
      },
    ],
    scenarios: [],
    exclusions: [],
    provenance: {
      evidenceRefs: ['lib/recipe-pipeline/vector/recipe-vector-generation-runtime.ts:1-80'],
      sourceFieldRefs: ['field:description'],
      sourceContentHash: 'fixture-source-content-hash',
      generator: 'plugin-integration-test',
    },
  };
  return { ...source, retrievalProfile };
}

function embedProvider(options: { fail?: boolean; model?: string } = {}): EmbeddingPort {
  return {
    describeCapabilities: () => ({
      provider: 'plugin-test-provider',
      model: options.model ?? 'plugin-test-model',
      dimension: 3,
      inputKinds: ['query', 'document'],
      batchSupported: true,
      normalization: 'normalized',
      formatProfile: 'asymmetric',
    }),
    embedQuery: async () => [1, 0, 0],
    embedDocuments: async (texts) => {
      if (options.fail) {
        throw new Error('provider-build-failed');
      }
      return texts.map(() => [1, 0, 0]);
    },
  };
}
