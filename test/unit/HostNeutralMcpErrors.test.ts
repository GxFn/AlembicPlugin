import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodeGraphProjectContextSession } from '@alembic/core/project-context';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  EmptyResultSchema,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

const injectedPrimeFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../lib/host-runtime/mcp/host/read-only-prime-executor.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../lib/host-runtime/mcp/host/read-only-prime-executor.js')
    >();
  return {
    ...original,
    executeReadOnlyPrime: async (
      ...args: Parameters<typeof original.executeReadOnlyPrime>
    ): ReturnType<typeof original.executeReadOnlyPrime> => {
      if (injectedPrimeFailure.enabled) {
        throw new Error('shared execution exploded with STRICT_PUBLICATION_FAKE_ONLY');
      }
      return original.executeReadOnlyPrime(...args);
    },
  };
});

import { CODEX_PLUGIN_ROOT_ENV, resolveHostRuntimeContext } from '../../lib/host-runtime/index.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { failureResult } from '../../lib/host-runtime/mcp/host/results.js';
import { McpServer } from '../../lib/host-runtime/mcp/McpServer.js';

const roots: string[] = [];
const previousPluginRoot = process.env[CODEX_PLUGIN_ROOT_ENV];
const previousToolDeadline = process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS;

afterEach(async () => {
  injectedPrimeFailure.enabled = false;
  vi.restoreAllMocks();
  await resetPluginOwnedMcpServerForTests();
  if (previousPluginRoot === undefined) {
    delete process.env[CODEX_PLUGIN_ROOT_ENV];
  } else {
    process.env[CODEX_PLUGIN_ROOT_ENV] = previousPluginRoot;
  }
  if (previousToolDeadline === undefined) {
    delete process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS;
  } else {
    process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS = previousToolDeadline;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('host-neutral MCP execution errors', () => {
  test('SDK sender string cancellation reaches the real CodeGraph owner and returns CANCELLED after cleanup', async () => {
    const projectRoot = installProject();
    writeFileSync(join(projectRoot, 'symbols.ts'), 'export const sdkProduced = 1;\n');
    const dataRoot = join(projectRoot, 'runtime');
    process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS = '5000';
    const completed = Promise.withResolvers<CallToolResult>();
    const ready = Promise.withResolvers<string>();
    const transport = await openHostTransport(projectRoot, shellRoots().codex, completed.resolve);
    vi.spyOn(transport.host, 'handleToolCall').mockImplementation(async (_name, _args, options) =>
      withCodeGraphProjectContextSession(
        { dataRoot, signal: options.signal },
        async (context, runtime) => {
          const symbols = await context.execute({
            kind: 'file-symbols',
            scope: { projectRoot },
            payload: { filePath: 'symbols.ts' },
          });
          expect(JSON.stringify(symbols.data)).toContain('"name":"sdkProduced"');
          ready.resolve(runtime.runtimeRoot);
          return new Promise<never>((_resolve, reject) =>
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            })
          );
        }
      )
    );
    const sender = new AbortController();
    const clientResult = transport.client
      .callTool(
        { name: 'alembic_plan', arguments: { operation: 'draft', generationStage: 'coldStart' } },
        undefined,
        { signal: sender.signal }
      )
      .catch((error) => error);
    try {
      const runtimeRoot = await Promise.race([
        ready.promise,
        completed.promise.then(() => {
          throw new Error('Transport settled before the real worker was ready.');
        }),
      ]);
      expect(readdirSync(runtimeRoot)).toHaveLength(1);
      // SDK Client 会发送 notifications/cancelled，protocol 将 reason 字符串原样 abort。
      sender.abort('User cancelled the transport request');
      const result = await completed.promise;
      expect(asRecord(asRecord(result.structuredContent)?.error)).toMatchObject({
        code: 'CANCELLED',
        message: 'User cancelled the transport request',
      });
      expect(readdirSync(runtimeRoot)).toEqual([]);
      await clientResult;
    } finally {
      sender.abort('test cleanup');
      await transport.close();
    }
  }, 15_000);

  test.each([
    'cancel',
    'business',
  ])('embedded SDK registration preserves string sender cancellation and %s classification', async (failure) => {
    const projectRoot = installProject();
    const embedded = new McpServer({ projectRoot, container: { get: () => undefined } });
    embedded.sdkServer = new SdkMcpServer(
      { name: 'embedded-transport-cancel-test', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    const completed = Promise.withResolvers<CallToolResult>();
    const ready = Promise.withResolvers<void>();
    observeCallToolResult(embedded.sdkServer, completed.resolve);
    embedded._registerHandlers();
    const client = await connectClient(embedded.sdkServer);
    vi.spyOn(embedded, '_resolveHandler').mockReturnValue(async (ctx) => {
      ready.resolve();
      if (!ctx.signal) {
        throw new Error('Sender signal did not reach the embedded handler.');
      }
      await new Promise<void>((resolve) =>
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
      );
      if (failure === 'business') {
        throw Object.assign(new Error('Business failure wins independently of cancellation'), {
          code: 'NOT_FOUND',
        });
      }
      ctx.signal.throwIfAborted();
    });
    const sender = new AbortController();
    const clientResult = client
      .callTool(
        { name: 'alembic_plan', arguments: { operation: 'draft', generationStage: 'coldStart' } },
        undefined,
        { signal: sender.signal }
      )
      .catch((error) => error);
    try {
      await ready.promise;
      sender.abort('Embedded transport string reason');
      const result = await completed.promise;
      expect(asRecord(asRecord(result.structuredContent)?.error)).toMatchObject(
        failure === 'cancel'
          ? { code: 'CANCELLED', message: 'Embedded transport string reason' }
          : { code: 'NOT_FOUND', message: 'Business failure wins independently of cancellation' }
      );
      await clientResult;
    } finally {
      sender.abort('test cleanup');
      await client.close();
      await embedded.shutdown();
    }
  });

  test('public direct Graph keeps caller AbortError as CANCELLED outside wrapHandler', async () => {
    const projectRoot = installProject();
    writeFileSync(join(projectRoot, 'symbols.ts'), 'export const sdkProduced = 1;\n');
    const host = new HostMcpServer({ projectRoot });
    const controller = new AbortController();
    controller.abort(new DOMException('Graph request cancelled by caller', 'AbortError'));
    try {
      const result = await host.handleToolCall(
        'alembic_graph',
        { queryKind: 'file-symbols', filePath: 'symbols.ts' },
        { signal: controller.signal }
      );
      expect(asRecord(result)).toMatchObject({
        success: false,
        errorCode: 'CANCELLED',
        message: expect.stringContaining('Graph request cancelled by caller'),
      });
    } finally {
      await host.shutdown();
    }
  });

  test('failureResult owns one explicit top-level code and keeps data non-competing', () => {
    expect(failureResult('alembic_prime', 'generic failure')).toEqual({
      success: false,
      message: 'generic failure',
      errorCode: 'INTERNAL_ERROR',
      tool: 'alembic_prime',
      data: {},
    });
    expect(
      failureResult('alembic_search', 'strict failure', {
        code: 'STRICT_PUBLICATION_VECTOR_STORE_INVALID',
        data: { retryable: false },
      })
    ).toEqual({
      success: false,
      message: 'strict failure',
      errorCode: 'STRICT_PUBLICATION_VECTOR_STORE_INVALID',
      tool: 'alembic_search',
      data: { retryable: false },
    });
  });

  test('a real SDK transport returns the same host-neutral generic failure on Codex and Claude Code', async () => {
    const projectRoot = installProject();
    injectedPrimeFailure.enabled = true;
    const results = [];

    for (const shellRoot of Object.values(shellRoots())) {
      const transport = await openHostTransport(projectRoot, shellRoot);
      try {
        const producer = asRecord(
          await transport.host.callPluginOwnedTool('alembic_prime', {
            query: 'host-neutral generic failure',
          })
        );
        expect(producer?.errorCode).toBe('INTERNAL_ERROR');
        expect(asRecord(producer?.data)).not.toHaveProperty('errorCode');
        expect(producer?.message).toBe(
          'Plugin-owned tool execution failed: shared execution exploded with STRICT_PUBLICATION_FAKE_ONLY'
        );

        const result = await transport.client.callTool({
          name: 'alembic_prime',
          arguments: { query: 'host-neutral generic failure' },
        });
        expect(CallToolResultSchema.parse(result)).toBeTruthy();
        expect(result.isError).toBe(true);
        expect(asRecord(result._meta)).toHaveProperty('alembicPublication');
        expect(result.structuredContent).toMatchObject({
          diagnostics: [expect.objectContaining({ code: 'INTERNAL_ERROR', severity: 'error' })],
          error: {
            code: 'INTERNAL_ERROR',
            mcpErrorCode: 'core.failure.internal-error',
            reasonCode: 'internal-error',
          },
        });
        expect(JSON.stringify({ producer, result })).not.toContain('CODEX_MCP_ERROR');
        results.push({
          content: result.content,
          diagnostic: asRecord(
            Array.isArray(asRecord(result.structuredContent)?.diagnostics)
              ? (asRecord(result.structuredContent)?.diagnostics as unknown[])[0]
              : null
          ),
          error: asRecord(asRecord(result.structuredContent)?.error),
          isError: result.isError,
        });
      } finally {
        await transport.close();
      }
    }

    expect(results[1]).toEqual(results[0]);
  }, 30_000);

  test('deprecated CODEX_MCP_ERROR input normalizes to INTERNAL_ERROR without promoting message tokens', async () => {
    const projectRoot = installProject();
    const transport = await openHostTransport(projectRoot, shellRoots().codex);
    injectedPrimeFailure.enabled = true;
    try {
      const producer = asRecord(
        await transport.host.callPluginOwnedTool('alembic_prime', {
          query: 'legacy compatibility input',
        })
      );
      vi.spyOn(transport.host, 'callPluginOwnedTool').mockResolvedValue({
        ...producer,
        errorCode: 'CODEX_MCP_ERROR',
        message: 'Legacy producer observed STRICT_PUBLICATION_FAKE_ONLY.',
      });

      const result = await transport.client.callTool({
        name: 'alembic_prime',
        arguments: { query: 'legacy compatibility input' },
      });
      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(asRecord(result._meta)).toHaveProperty('alembicPublication');
      expect(asRecord(asRecord(result.structuredContent)?.error)).toMatchObject({
        code: 'INTERNAL_ERROR',
        mcpErrorCode: 'core.failure.internal-error',
      });
      expect(
        asRecord((asRecord(result.structuredContent)?.diagnostics as unknown[])[0])?.code
      ).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(result)).not.toContain('CODEX_MCP_ERROR');
      expect(JSON.stringify(result)).toContain('STRICT_PUBLICATION_FAKE_ONLY');
    } finally {
      await transport.close();
    }
  }, 30_000);

  test('keeps JSON-RPC protocol errors separate from CallToolResult execution errors', async () => {
    const projectRoot = installProject();
    const transport = await openHostTransport(projectRoot, shellRoots().codex);
    try {
      await expect(
        transport.client.request(
          { method: 'alembic/test-missing-method', params: {} } as never,
          EmptyResultSchema
        )
      ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });

      vi.spyOn(transport.host, 'handleToolCall').mockRejectedValue(
        new Error('outer tool execution exploded')
      );
      const result = await transport.client.callTool({
        name: 'alembic_prime',
        arguments: { query: 'outer generic failure' },
      });
      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(asRecord(asRecord(result.structuredContent)?.error)).toMatchObject({
        code: 'INTERNAL_ERROR',
        mcpErrorCode: 'core.failure.internal-error',
      });
    } finally {
      await transport.close();
    }
  }, 30_000);

  test('preserves TOOL_TIMEOUT instead of collapsing it into the generic code', async () => {
    const projectRoot = installProject();
    process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS = '10';
    const transport = await openHostTransport(projectRoot, shellRoots().codex);
    try {
      vi.spyOn(transport.host, 'handleToolCall').mockImplementation(
        (_name, _args, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
          })
      );
      const result = await transport.client.callTool({
        name: 'alembic_prime',
        arguments: { query: 'timeout preservation' },
      });

      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(asRecord(asRecord(result.structuredContent)?.error)?.code).toBe('TOOL_TIMEOUT');
    } finally {
      await transport.close();
    }
  }, 30_000);

  test('preserves a real SDK Search timeout and sibling knowledge-projector timeouts', async () => {
    const projectRoot = installProject();
    process.env.ALEMBIC_MCP_TOOL_DEADLINE_MS = '10';
    const transport = await openHostTransport(projectRoot, shellRoots().codex);
    try {
      vi.spyOn(transport.host, 'handleToolCall').mockImplementation(
        (_name, _args, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
          })
      );
      for (const request of [
        {
          name: 'alembic_search',
          arguments: {
            operation: 'search',
            query: 'search timeout preservation',
          },
        },
        {
          name: 'alembic_graph',
          arguments: {
            queryKind: 'map',
          },
        },
        {
          name: 'alembic_recipe_map',
          arguments: {},
        },
      ]) {
        const result = await transport.client.callTool(request);

        expect(CallToolResultSchema.parse(result), request.name).toBeTruthy();
        expect(result.isError, request.name).toBe(true);
        expect(
          asRecord((asRecord(result.structuredContent)?.diagnostics as unknown[])[0]),
          request.name
        ).toMatchObject({
          code: 'TOOL_TIMEOUT',
          retryable: true,
          severity: 'error',
        });
        expect(asRecord(asRecord(result.structuredContent)?.error), request.name).toMatchObject({
          code: 'TOOL_TIMEOUT',
          mcpErrorCode: 'core.failure.timeout',
          reasonCode: 'timeout',
        });
        expect(asRecord(result._meta), request.name).toHaveProperty('alembicPublication');
        expect(asRecord(result.structuredContent), request.name).not.toHaveProperty('_meta');
      }
    } finally {
      await transport.close();
    }
  }, 30_000);
});

function installProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'host-neutral-mcp-errors-'));
  roots.push(projectRoot);
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'host-neutral-mcp-errors-fixture', private: true, type: 'module' })
  );
  return projectRoot;
}

function shellRoots(): { claudeCode: string; codex: string } {
  const codex = resolveHostRuntimeContext().pluginRoot;
  return { codex, claudeCode: join(codex, '..', 'alembic-claude-code') };
}

async function openHostTransport(
  projectRoot: string,
  shellRoot: string,
  onCallToolResult?: (result: CallToolResult) => void
): Promise<{
  client: Client;
  close(): Promise<void>;
  host: HostMcpServer;
}> {
  process.env[CODEX_PLUGIN_ROOT_ENV] = shellRoot;
  await resetPluginOwnedMcpServerForTests();
  const host = new HostMcpServer({ projectRoot });
  host.sdkServer = new SdkMcpServer(
    { name: 'host-neutral-mcp-errors-test', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  if (onCallToolResult) {
    observeCallToolResult(host.sdkServer, onCallToolResult);
  }
  host.registerHandlers();
  const client = await connectClient(host.sdkServer);
  return {
    client,
    host,
    async close(): Promise<void> {
      await client.close();
      await host.shutdown();
    },
  };
}

// SDK 在收到取消通知后不再往客户端发送该响应；这里仅观察真实注册 callback 的最终值，
// 请求、取消通知和 extra.signal 仍全程经过 SDK InMemoryTransport/Protocol。
function observeCallToolResult(
  sdk: SdkMcpServer,
  onResult: (result: CallToolResult) => void
): void {
  const register = sdk.server.setRequestHandler.bind(sdk.server);
  vi.spyOn(sdk.server, 'setRequestHandler').mockImplementation((schema, handler) => {
    register(schema, async (request, extra) => {
      const result = await handler(request, extra);
      if (schema === CallToolRequestSchema) {
        onResult(CallToolResultSchema.parse(result));
      }
      return result;
    });
  });
}

async function connectClient(sdk: SdkMcpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'host-neutral-mcp-errors-client', version: '1.0.0' });
  await sdk.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  return client;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
