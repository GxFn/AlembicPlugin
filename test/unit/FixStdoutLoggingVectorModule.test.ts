/**
 * LANE I1 回归：MCP stdio 模式下 stdout 是 JSON-RPC 协议通道，任何运行时日志都不得写入。
 *
 * prepareLocalEmbedProvider 过去回退到 `console`（singletons.logger 在 lib 中从未赋值），
 * console.info 会写 stdout，破坏 JSON-RPC 流。这里用与生产一致的容器形状（不注入
 * singletons.logger）验证：日志改走 Core Logger（MCP 模式下无 Console transport、非 MCP 模式
 * 下 Console transport 全部级别走 stderr），stdout 零写入。
 */
import Logger from '@alembic/core/logging';
import type { FetchLike } from '@alembic/core/vector';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { registerKnowledgeEvolution } from '../../lib/injection/modules/KnowledgeEvolutionModule.js';
import { prepareLocalEmbedProvider } from '../../lib/injection/modules/VectorModule.js';
import { DEFAULT_OLLAMA_EMBED_MODEL } from '../../lib/recipe-pipeline/vector/LocalEmbedding.js';

type Container = Parameters<typeof prepareLocalEmbedProvider>[0];

function ollamaFetch(models: string[]): FetchLike {
  return async () => {
    const body = { models: models.map((name) => ({ name })) };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

/** 生产形状：singletons 中没有 logger（lib 内从未赋值），只有 _config。 */
function productionShapedContainer(config: Record<string, unknown>): Container {
  return {
    singletons: { _config: config },
    services: {},
    singleton: vi.fn(),
  } as unknown as Container;
}

const ENV_KEYS = [
  'ALEMBIC_MCP_MODE',
  'ALEMBIC_LOCAL_EMBEDDING_ENABLED',
  'ALEMBIC_OLLAMA_ENDPOINT',
  'ALEMBIC_OLLAMA_EMBED_MODEL',
] as const;

describe('LANE I1: VectorModule / KnowledgeEvolutionModule never write to stdout', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let stdoutChunks: string[];
  let stdoutBoundConsoleCalls: string[];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // 模拟 MCP stdio 服务进程
    process.env.ALEMBIC_MCP_MODE = '1';

    stdoutChunks = [];
    stdoutBoundConsoleCalls = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    // 真实 Node 进程里 console.log/info/debug/table 写 stdout；vitest 会拦截 console，
    // 因此同时把这些方法视为 stdout 写入点。
    for (const method of ['log', 'info', 'debug', 'table'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stdoutBoundConsoleCalls.push(`console.${method}: ${args.map(String).join(' ')}`);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test('local embedding disabled: log goes to Core Logger, zero stdout writes', async () => {
    const coreInfo = vi.spyOn(Logger.getInstance(), 'info');
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: false } } });

    await prepareLocalEmbedProvider(c);

    expect(stdoutBoundConsoleCalls).toEqual([]);
    expect(stdoutChunks).toEqual([]);
    expect(coreInfo).toHaveBeenCalledWith(
      '[VectorModule] local embedding disabled; using keyword baseline search.'
    );
  });

  test('Ollama lane selected: log goes to Core Logger, zero stdout writes', async () => {
    const coreInfo = vi.spyOn(Logger.getInstance(), 'info');
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: true } } });

    await prepareLocalEmbedProvider(c, { fetchImpl: ollamaFetch([DEFAULT_OLLAMA_EMBED_MODEL]) });

    const selection = (c.singletons as Record<string, unknown>)._localEmbedSelection as
      | { lane?: string; provider?: unknown }
      | undefined;
    expect(selection?.provider).toBeTruthy();
    expect(stdoutBoundConsoleCalls).toEqual([]);
    expect(stdoutChunks).toEqual([]);
    expect(coreInfo).toHaveBeenCalledWith(
      expect.stringContaining('[VectorModule] local embedding lane=')
    );
  });

  test('Ollama unavailable: warning goes to Core Logger, zero stdout writes', async () => {
    const coreWarn = vi.spyOn(Logger.getInstance(), 'warn');
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: true } } });

    await prepareLocalEmbedProvider(c, { fetchImpl: ollamaFetch([]) });

    expect(stdoutBoundConsoleCalls).toEqual([]);
    expect(stdoutChunks).toEqual([]);
    expect(coreWarn).toHaveBeenCalledWith(
      expect.stringContaining('[VectorModule] local embedding enabled but Ollama unavailable')
    );
  });

  test('embedding-sim provider receives the Core Logger instead of a null logger', () => {
    const coreDebug = vi.spyOn(Logger.getInstance(), 'debug');
    const factories = new Map<string, (ct: unknown) => unknown>();
    const registrar = {
      singleton: (name: string, factory: (ct: unknown) => unknown) => {
        factories.set(name, factory);
      },
    };
    registerKnowledgeEvolution(
      registrar as unknown as Parameters<typeof registerKnowledgeEvolution>[0]
    );

    const factory = factories.get('embeddingSimProvider');
    expect(factory).toBeTypeOf('function');
    // 无 vectorStore → provider 句柄为 null，并通过日志端口记录降级原因。
    const handle = factory?.({ services: {}, singletons: {}, get: vi.fn() });

    expect(handle).toBeNull();
    expect(coreDebug).toHaveBeenCalledWith(
      '[RecipeEmbeddingSimProvider] no vectorStore — embedding provider not wired'
    );
    expect(stdoutBoundConsoleCalls).toEqual([]);
    expect(stdoutChunks).toEqual([]);
  });
});
