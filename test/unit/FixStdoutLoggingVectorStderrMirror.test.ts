/**
 * W3e-2 回归：MCP 模式下 Core Logger 不挂 Console transport，VectorModule 的 warn（例如
 * Ollama 不可用回退到关键词基线）如果只进 Core Logger，展示 server stderr 的宿主就看不到。
 * 期望：info 只进 Core Logger；warn/error 额外镜像一行到 process.stderr；stdout 始终零写入。
 * 已有 Console transport（非 MCP 模式，全部级别走 stderr）时不重复镜像。
 */
import Logger from '@alembic/core/logging';
import type { FetchLike } from '@alembic/core/vector';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { prepareLocalEmbedProvider } from '../../lib/injection/modules/VectorModule.js';

type Container = Parameters<typeof prepareLocalEmbedProvider>[0];
type CoreLogger = ReturnType<typeof Logger.getInstance>;
type Transport = CoreLogger['transports'][number];

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

describe('W3e-2: VectorModule mirrors warn/error to stderr when Core Logger has no console', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let removedConsoleTransports: Transport[];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ALEMBIC_MCP_MODE = '1';

    // 模拟 MCP 模式：Core Logger 没有 Console transport（测试进程里实例可能已带 console）。
    const logger = Logger.getInstance();
    removedConsoleTransports = logger.transports.filter(
      (t) => (t as { name?: unknown }).name === 'console'
    );
    for (const transport of removedConsoleTransports) {
      logger.remove(transport);
    }

    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    for (const method of ['log', 'info', 'debug', 'table'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stdoutChunks.push(`console.${method}: ${args.map(String).join(' ')}`);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const logger = Logger.getInstance();
    for (const transport of removedConsoleTransports) {
      logger.add(transport);
    }
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test('Ollama fallback warning reaches stderr (once) and Core Logger, never stdout', async () => {
    const coreWarn = vi.spyOn(Logger.getInstance(), 'warn');
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: true } } });

    await prepareLocalEmbedProvider(c, { fetchImpl: ollamaFetch([]) });

    expect(coreWarn).toHaveBeenCalledWith(
      expect.stringContaining('[VectorModule] local embedding enabled but Ollama unavailable')
    );
    const mirrored = stderrChunks.filter((chunk) =>
      chunk.includes('[VectorModule] local embedding enabled but Ollama unavailable')
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatch(/\n$/);
    expect(stdoutChunks).toEqual([]);
  });

  test('throwing Ollama probe still surfaces a VectorModule warning on stderr', async () => {
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: true } } });
    const throwingFetch: FetchLike = async () => {
      throw new Error('boom-fetch');
    };

    await prepareLocalEmbedProvider(c, { fetchImpl: throwingFetch });

    const stderrText = stderrChunks.join('');
    expect(stderrText).toContain('[VectorModule]');
    expect(stdoutChunks).toEqual([]);
  });

  test('info lines stay on Core Logger only (no stderr mirror)', async () => {
    const coreInfo = vi.spyOn(Logger.getInstance(), 'info');
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: false } } });

    await prepareLocalEmbedProvider(c);

    expect(coreInfo).toHaveBeenCalledWith(
      '[VectorModule] local embedding disabled; using keyword baseline search.'
    );
    expect(stderrChunks.filter((chunk) => chunk.includes('[VectorModule]'))).toEqual([]);
    expect(stdoutChunks).toEqual([]);
  });

  test('no duplicate mirror when Core Logger already has a console transport', async () => {
    const logger = Logger.getInstance();
    // 伪造一个 name='console' 的 transport 代表非 MCP 模式下的 stderr Console 输出。
    const fakeConsole = { name: 'console' } as unknown as Transport;
    const transportsSpy = vi
      .spyOn(logger, 'transports', 'get')
      .mockReturnValue([...logger.transports, fakeConsole]);
    vi.spyOn(logger, 'warn').mockImplementation((() => logger) as unknown as CoreLogger['warn']);
    const c = productionShapedContainer({ vector: { localEmbedding: { enabled: true } } });

    await prepareLocalEmbedProvider(c, { fetchImpl: ollamaFetch([]) });

    expect(transportsSpy).toHaveBeenCalled();
    expect(stderrChunks.filter((chunk) => chunk.includes('[VectorModule]'))).toEqual([]);
    expect(stdoutChunks).toEqual([]);
  });
});
