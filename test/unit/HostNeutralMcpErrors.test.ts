import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
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
  shellRoot: string
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
  host.registerHandlers();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'host-neutral-mcp-errors-client', version: '1.0.0' });
  await host.sdkServer.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  return {
    client,
    host,
    async close(): Promise<void> {
      await client.close();
      await host.shutdown();
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
