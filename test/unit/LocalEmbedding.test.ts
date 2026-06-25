import type { FetchLike } from '@alembic/core/vector';
import { describe, expect, test, vi } from 'vitest';
import {
  prepareLocalEmbedProvider,
  register as registerVectorModule,
} from '../../lib/injection/modules/VectorModule.js';
import {
  DEFAULT_OLLAMA_EMBED_MODEL,
  DEFAULT_OLLAMA_ENDPOINT,
  detectOllamaEmbedding,
  localEmbeddingSetupGuidance,
  resolveLocalEmbeddingConfig,
  selectLocalEmbedLane,
} from '../../lib/recipe-generation/vector/LocalEmbedding.js';

// Fake Ollama /api/tags transport so detection/selection are deterministic + offline.
function fakeFetch(models: string[], opts: { fail?: boolean; status?: number } = {}): FetchLike {
  return async () => {
    if (opts.fail) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }
    if (opts.status && opts.status !== 200) {
      return {
        ok: false,
        status: opts.status,
        json: async () => ({}),
        text: async () => '',
      };
    }
    const body = { models: models.map((name) => ({ name })) };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

describe('LocalEmbedding config + env (GMAP-L3)', () => {
  test('applies defaults (disabled, local-first, default endpoint/model)', () => {
    const config = resolveLocalEmbeddingConfig(undefined, {} as NodeJS.ProcessEnv);
    expect(config).toEqual({
      enabled: false,
      endpoint: DEFAULT_OLLAMA_ENDPOINT,
      model: DEFAULT_OLLAMA_EMBED_MODEL,
      laneOrder: 'local-first',
    });
  });

  test('reads config.json vector.localEmbedding', () => {
    const config = resolveLocalEmbeddingConfig(
      { localEmbedding: { enabled: true, endpoint: 'http://host:9999', model: 'm1' } },
      {} as NodeJS.ProcessEnv
    );
    expect(config).toMatchObject({ enabled: true, endpoint: 'http://host:9999', model: 'm1' });
  });

  test('host env overrides config.json (env wins)', () => {
    const config = resolveLocalEmbeddingConfig(
      { localEmbedding: { enabled: false, model: 'config-model' } },
      {
        ALEMBIC_LOCAL_EMBEDDING_ENABLED: '1',
        ALEMBIC_OLLAMA_ENDPOINT: 'http://env-host:1234',
        ALEMBIC_OLLAMA_EMBED_MODEL: 'env-model',
      } as unknown as NodeJS.ProcessEnv
    );
    expect(config).toMatchObject({
      enabled: true,
      endpoint: 'http://env-host:1234',
      model: 'env-model',
    });
  });

  test('ALEMBIC_LOCAL_EMBEDDING_ENABLED=0 disables even if config enabled', () => {
    const config = resolveLocalEmbeddingConfig({ localEmbedding: { enabled: true } }, {
      ALEMBIC_LOCAL_EMBEDDING_ENABLED: '0',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
  });
});

describe('LocalEmbedding detection (GMAP-L2)', () => {
  test('available when endpoint reachable + model pulled (tolerates tag suffix)', async () => {
    const result = await detectOllamaEmbedding(
      { endpoint: DEFAULT_OLLAMA_ENDPOINT, model: 'qwen3-embedding' },
      fakeFetch(['qwen3-embedding:latest', 'llama3'])
    );
    expect(result.available).toBe(true);
    expect(result.model).toBe('qwen3-embedding');
  });

  test('unavailable + reason when the model is not pulled', async () => {
    const result = await detectOllamaEmbedding(
      { endpoint: DEFAULT_OLLAMA_ENDPOINT, model: 'qwen3-embedding' },
      fakeFetch(['some-other-model'])
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('unavailable + reason when the endpoint is unreachable (no throw)', async () => {
    const result = await detectOllamaEmbedding(
      { endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding' },
      fakeFetch([], { fail: true })
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('LocalEmbedding local-first lane selection (GMAP-L3)', () => {
  test('enabled + Ollama available → selects the Ollama provider', async () => {
    const selection = await selectLocalEmbedLane(
      {
        enabled: true,
        endpoint: DEFAULT_OLLAMA_ENDPOINT,
        model: 'qwen3-embedding',
        laneOrder: 'local-first',
      },
      { fetchImpl: fakeFetch(['qwen3-embedding']) }
    );
    expect(selection.lane).toBe('ollama');
    expect(selection.provider).not.toBeNull();
  });

  test('enabled + Ollama absent → clean degrade to keyword baseline (null provider) + diagnostic', async () => {
    const selection = await selectLocalEmbedLane(
      {
        enabled: true,
        endpoint: DEFAULT_OLLAMA_ENDPOINT,
        model: 'qwen3-embedding',
        laneOrder: 'local-first',
      },
      { fetchImpl: fakeFetch([], { fail: true }) }
    );
    expect(selection.lane).toBe('keyword');
    expect(selection.provider).toBeNull();
    const ollamaDiag = selection.diagnostics.find((d) => d.name === 'ollama');
    expect(ollamaDiag?.available).toBe(false);
    expect(ollamaDiag?.reason).toBeTruthy();
  });

  test('disabled → keyword baseline without probing', async () => {
    const probe = vi.fn();
    const selection = await selectLocalEmbedLane(
      {
        enabled: false,
        endpoint: DEFAULT_OLLAMA_ENDPOINT,
        model: 'qwen3-embedding',
        laneOrder: 'local-first',
      },
      { fetchImpl: probe as unknown as FetchLike }
    );
    expect(selection.lane).toBe('keyword');
    expect(selection.provider).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  test("laneOrder 'keyword-only' forces keyword even when enabled", async () => {
    const selection = await selectLocalEmbedLane(
      {
        enabled: true,
        endpoint: DEFAULT_OLLAMA_ENDPOINT,
        model: 'qwen3-embedding',
        laneOrder: 'keyword-only',
      },
      { fetchImpl: fakeFetch(['qwen3-embedding']) }
    );
    expect(selection.lane).toBe('keyword');
    expect(selection.provider).toBeNull();
  });
});

describe('VectorModule injection (GMAP-L3)', () => {
  function fakeContainer(config: Record<string, unknown>) {
    const singletons: Record<string, unknown> = {
      _config: config,
      logger: { info() {}, warn() {} },
    };
    return {
      singletons,
      services: {},
      singleton: vi.fn(),
    } as unknown as Parameters<typeof prepareLocalEmbedProvider>[0];
  }

  test('disabled config → no selection stored (factory injects keyword baseline / null)', async () => {
    const c = fakeContainer({ vector: { localEmbedding: { enabled: false } } });
    await prepareLocalEmbedProvider(c);
    expect((c.singletons as Record<string, unknown>)._localEmbedSelection).toBeUndefined();
  });

  test('enabled config + pulled Ollama model injects a provider that reports embed-provider-ready', async () => {
    const c = vectorModuleContainer({
      vector: {
        localEmbedding: {
          enabled: true,
          endpoint: DEFAULT_OLLAMA_ENDPOINT,
          model: DEFAULT_OLLAMA_EMBED_MODEL,
        },
      },
    });
    registerVectorModule(c as unknown as Parameters<typeof registerVectorModule>[0]);
    await prepareLocalEmbedProvider(
      c as unknown as Parameters<typeof prepareLocalEmbedProvider>[0],
      {
        fetchImpl: fakeFetch([DEFAULT_OLLAMA_EMBED_MODEL]),
      }
    );

    const vectorService = c.get('vectorService') as {
      getAvailability(): Promise<Record<string, unknown>>;
    };
    await expect(vectorService.getAvailability()).resolves.toMatchObject({
      available: true,
      reason: 'embed-provider-ready',
      status: 'available',
    });
  });

  test('register wires the vectorService factory without throwing', () => {
    const c = fakeContainer({});
    expect(() =>
      registerVectorModule(c as unknown as Parameters<typeof registerVectorModule>[0])
    ).not.toThrow();
  });

  test('setup guidance lists Ollama install + pull + enable steps (no model download by the plugin)', () => {
    const guidance = localEmbeddingSetupGuidance(resolveLocalEmbeddingConfig({}));
    const joined = guidance.join('\n');
    expect(joined).toContain('ollama pull');
    expect(joined).toContain('/api/tags');
    expect(joined).toContain('ALEMBIC_LOCAL_EMBEDDING_ENABLED');
    expect(joined.toLowerCase()).toContain('keyword');
  });
});

function vectorModuleContainer(config: Record<string, unknown>) {
  const singletons: Record<string, unknown> = {
    _config: config,
    logger: { info() {}, warn() {} },
  };
  const vectorStore = {
    batchUpsert: vi.fn(),
    clear: vi.fn(),
    getById: vi.fn(),
    getStats: vi.fn(async () => ({ count: 0, dimension: 0, indexSize: 0 })),
    listIds: vi.fn(async () => []),
    remove: vi.fn(),
    searchVector: vi.fn(async () => []),
    upsert: vi.fn(),
  };
  const indexingPipeline = { run: vi.fn(), setAiProvider: vi.fn() };
  const services: Record<string, () => unknown> = {
    indexingPipeline: () => indexingPipeline,
    vectorStore: () => vectorStore,
  };
  const container = {
    singletons,
    services,
    get(name: string) {
      const factory = services[name];
      if (!factory) {
        throw new Error(`missing service ${name}`);
      }
      return factory();
    },
    register(name: string, factory: () => unknown) {
      services[name] = factory;
    },
    singleton(name: string, factory: (ct: unknown) => unknown) {
      services[name] = () => {
        if (!(name in singletons)) {
          singletons[name] = factory(container);
        }
        return singletons[name];
      };
    },
  };
  return container;
}
