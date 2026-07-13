import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RecipeRetrievalProfile } from '@alembic/core/knowledge';
import {
  type EmbeddingPort,
  JsonVectorAdapter,
  RECIPE_REGION_VECTOR_ID_PREFIX,
  type RecipeRegionSourceEntry,
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
    expect(concurrentActivation).toEqual([true, false]);
    expect(
      await runtime.router.activate(
        { generationId: 'generation-1', manifestHash: 'manifest-1' },
        'generation-2'
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
