import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FetchLike } from '@alembic/core/vector';
import { afterEach, describe, expect, test } from 'vitest';
import {
  prepareLocalEmbedProvider,
  register as registerVectorModule,
} from '../../lib/injection/modules/VectorModule.js';
import { buildServiceContainerRuntimeConfig } from '../../lib/injection/ServiceContainer.js';
import {
  DEFAULT_OLLAMA_EMBED_MODEL,
  DEFAULT_OLLAMA_ENDPOINT,
} from '../../lib/recipe-generation/vector/LocalEmbedding.js';

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspaceConfig(config: Record<string, unknown>): { configPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-runtime-config-'));
  cleanupRoots.push(root);
  const runtimeDir = path.join(root, '.asd');
  const configPath = path.join(runtimeDir, 'config.json');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath };
}

function fakeConfigLoader(sections: Record<string, unknown>) {
  return {
    get(key: string) {
      if (!(key in sections)) {
        throw new Error(`missing ${key}`);
      }
      return sections[key];
    },
  };
}

function fakeFetch(models: string[]): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: models.map((name) => ({ name })) }),
    text: async () => JSON.stringify({ models: models.map((name) => ({ name })) }),
  });
}

describe('ServiceContainer runtime config projection', () => {
  test('merges workspace vector.localEmbedding into the plain DI config', () => {
    const resolver = makeWorkspaceConfig({
      database: '.asd/alembic.db',
      vector: {
        localEmbedding: {
          enabled: true,
          endpoint: 'http://127.0.0.1:11434',
          model: 'qwen3-embedding:0.6b',
          laneOrder: 'local-first',
        },
      },
    });
    const config = buildServiceContainerRuntimeConfig(
      fakeConfigLoader({
        database: { type: 'sqlite', path: './.asd/alembic.db' },
        vector: {
          adapter: 'auto',
          hybrid: { rrfK: 60 },
          localEmbedding: { enabled: false },
        },
      }),
      resolver
    );

    expect(config.database).toEqual({ type: 'sqlite', path: './.asd/alembic.db' });
    expect(config.vector).toMatchObject({
      adapter: 'auto',
      hybrid: { rrfK: 60 },
      localEmbedding: {
        enabled: true,
        endpoint: 'http://127.0.0.1:11434',
        model: 'qwen3-embedding:0.6b',
        laneOrder: 'local-first',
      },
    });
  });

  test('feeds workspace localEmbedding config into VectorModule provider selection', async () => {
    const resolver = makeWorkspaceConfig({
      vector: {
        localEmbedding: {
          enabled: true,
          endpoint: DEFAULT_OLLAMA_ENDPOINT,
          model: DEFAULT_OLLAMA_EMBED_MODEL,
        },
      },
    });
    const config = buildServiceContainerRuntimeConfig(
      fakeConfigLoader({ vector: { adapter: 'auto', localEmbedding: { enabled: false } } }),
      resolver
    );
    const c = vectorModuleContainer(config);

    registerVectorModule(c as unknown as Parameters<typeof registerVectorModule>[0]);
    await prepareLocalEmbedProvider(
      c as unknown as Parameters<typeof prepareLocalEmbedProvider>[0],
      { fetchImpl: fakeFetch([DEFAULT_OLLAMA_EMBED_MODEL]) }
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
});

function vectorModuleContainer(config: Record<string, unknown>) {
  const singletons: Record<string, unknown> = {
    _config: config,
    logger: { info() {}, warn() {} },
  };
  const vectorStore = {
    batchUpsert() {},
    clear() {},
    getById() {},
    getStats: async () => ({ count: 0, dimension: 0, indexSize: 0 }),
    listIds: async () => [],
    remove() {},
    searchVector: async () => [],
    upsert() {},
  };
  const indexingPipeline = { run() {}, setAiProvider() {} };
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
