import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const strictFailure = vi.hoisted(() => ({
  embedding: 'none' as 'mismatch' | 'none' | 'unavailable',
  route: 'none' as 'corrupt-store' | 'id-set-mismatch' | 'invalid-store-path' | 'none' | 'provider',
}));

vi.mock(
  '../../lib/host-runtime/mcp/host/public-knowledge-read-route.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../lib/host-runtime/mcp/host/public-knowledge-read-route.js')
      >();
    const nodePath = await import('node:path');
    return {
      ...original,
      resolvePublicKnowledgeReadRoute: (
        ...args: Parameters<typeof original.resolvePublicKnowledgeReadRoute>
      ) => {
        const route = original.resolvePublicKnowledgeReadRoute(...args);
        if (strictFailure.route === 'none' || route.state !== 'ready' || !route.strictPublication) {
          return route;
        }
        if (strictFailure.route === 'provider') {
          return {
            ...route,
            strictPublication: {
              ...route.strictPublication,
              vector: {
                ...route.strictPublication.vector,
                model: 'controlled-model',
                provider: 'controlled-provider',
              },
            },
          };
        }
        if (strictFailure.route === 'id-set-mismatch') {
          return {
            ...route,
            strictPublication: {
              ...route.strictPublication,
              vector: {
                ...route.strictPublication.vector,
                expectedIds: route.strictPublication.vector.expectedIds.slice(1),
              },
            },
          };
        }
        if (strictFailure.route === 'invalid-store-path') {
          return {
            ...route,
            strictPublication: {
              ...route.strictPublication,
              vector: {
                ...route.strictPublication.vector,
                indexPath: nodePath.resolve(route.dataRoot, '..', 'outside-vector-index.json'),
              },
            },
          };
        }
        const relativePath = 'corrupt-vector-index.json';
        return {
          ...route,
          strictPublication: {
            files: [
              ...route.strictPublication.files,
              {
                byteHash: 'test-only-route-seam',
                relativePath,
                size: 2,
              },
            ],
            vector: {
              ...route.strictPublication.vector,
              indexPath: nodePath.join(route.dataRoot, relativePath),
            },
          },
        };
      },
    };
  }
);

vi.mock('../../lib/recipe-pipeline/vector/LocalEmbedding.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../lib/recipe-pipeline/vector/LocalEmbedding.js')>();
  return {
    ...original,
    selectLocalEmbedLane: async (
      ...args: Parameters<typeof original.selectLocalEmbedLane>
    ): ReturnType<typeof original.selectLocalEmbedLane> => {
      if (strictFailure.embedding === 'none') {
        return original.selectLocalEmbedLane(...args);
      }
      if (strictFailure.embedding === 'unavailable') {
        return { diagnostics: [], lane: 'keyword', provider: null };
      }
      return {
        diagnostics: [],
        lane: 'controlled',
        provider: {
          describeCapabilities: () => ({
            batchSupported: true,
            dimension: 3,
            formatProfile: 'symmetric',
            inputKinds: ['query', 'document'],
            model: 'controlled-model',
            normalization: 'not-normalized',
            provider: 'different-provider',
          }),
          embedDocuments: async (values: readonly string[]) => values.map(() => [1, 0, 0]),
          embedQuery: async () => [1, 0, 0],
        },
      };
    },
  };
});

import {
  isStrictPublicationErrorCode,
  StrictPublicationError,
} from '../../lib/host-runtime/context/StrictPublicationError.js';
import { HostMcpServer } from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { ReadOnlyJsonVectorReader } from '../../lib/host-runtime/mcp/host/read-only-json-vector-reader.js';

const FIXTURE_ROOT = path.resolve('test/fixtures/strict-publication-v1/recipe-publications');
const SNAPSHOT_ID = 'snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d';
const roots: string[] = [];
const previousHome = process.env.ALEMBIC_HOME;

beforeEach(() => {
  strictFailure.embedding = 'none';
  strictFailure.route = 'none';
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ALEMBIC_HOME = previousHome;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('strict publication producer error transport', () => {
  test.each([
    {
      code: 'STRICT_PUBLICATION_VECTOR_PROVIDER_UNAVAILABLE',
      embedding: 'unavailable',
      label: 'unavailable vector provider',
      route: 'provider',
    },
    {
      code: 'STRICT_PUBLICATION_VECTOR_PROVIDER_MISMATCH',
      embedding: 'mismatch',
      label: 'mismatched vector provider',
      route: 'provider',
    },
    {
      code: 'STRICT_PUBLICATION_VECTOR_STORE_INVALID',
      embedding: 'none',
      label: 'corrupt vector store',
      route: 'corrupt-store',
    },
    {
      code: 'STRICT_PUBLICATION_VECTOR_STORE_PATH_INVALID',
      embedding: 'none',
      label: 'out-of-root vector store path',
      route: 'invalid-store-path',
    },
    {
      code: 'STRICT_PUBLICATION_VECTOR_ID_SET_MISMATCH',
      embedding: 'none',
      label: 'snapshot vector id set mismatch',
      route: 'id-set-mismatch',
    },
  ] as const)('preserves the exact $label code from the real Search producer through HostMcpServer', async ({
    code,
    embedding,
    route,
  }) => {
    const fixture = installFixture();
    strictFailure.embedding = embedding;
    strictFailure.route = route;
    if (route === 'corrupt-store') {
      fs.writeFileSync(
        path.join(strictSnapshotDataRoot(fixture.dataRoot), 'corrupt-vector-index.json'),
        '{}'
      );
    }
    const transport = await openHostTransport(fixture.projectRoot);
    const args = {
      operation: 'search',
      query: 'strict producer transport',
      mode: 'semantic',
      limit: 3,
    };
    try {
      const producer = asRecord(await transport.host.callPluginOwnedTool('alembic_search', args));
      expect(producer?.success).toBe(false);
      expect(producer?.errorCode).toBe(code);

      const result = await transport.client.callTool({
        name: 'alembic_search',
        arguments: args,
      });
      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        diagnostics: [expect.objectContaining({ code, severity: 'error' })],
      });
      expect(asRecord(result.structuredContent)).not.toHaveProperty('_meta');
      expect(asRecord(asRecord(result)?._meta)?.alembicPublication).toMatchObject({
        mode: 'strict-v1',
        routeState: 'ready',
        snapshotId: SNAPSHOT_ID,
      });
    } finally {
      await transport.close();
    }
  }, 30_000);

  test.each([
    {
      code: 'STRICT_PUBLICATION_VECTOR_STORE_INVALID',
      content: '{}',
      label: 'non-array store',
    },
    {
      code: 'STRICT_PUBLICATION_VECTOR_ITEM_INVALID',
      content: JSON.stringify([{ content: 'invalid', id: 'item-1', metadata: {}, vector: [1] }]),
      label: 'invalid vector item',
    },
    {
      code: 'STRICT_PUBLICATION_VECTOR_ID_SET_MISMATCH',
      content: JSON.stringify([validVectorItem('duplicate'), validVectorItem('duplicate')]),
      label: 'duplicate vector ids',
    },
  ] as const)('uses the bounded producer contract for a $label', ({ code, content }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-vector-reader-'));
    roots.push(root);
    const indexPath = path.join(root, 'vector-index.json');
    fs.writeFileSync(indexPath, content);

    expect(() => new ReadOnlyJsonVectorReader(indexPath, 3)).toThrow(
      expect.objectContaining({
        code,
        name: 'StrictPublicationError',
        retryable: false,
      })
    );
  });

  test('uses the bounded producer contract for a query dimension mismatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-vector-reader-'));
    roots.push(root);
    const indexPath = path.join(root, 'vector-index.json');
    fs.writeFileSync(indexPath, JSON.stringify([validVectorItem('item-1')]));
    const reader = new ReadOnlyJsonVectorReader(indexPath, 3);

    await expect(reader.searchVector([1, 0])).rejects.toMatchObject({
      code: 'STRICT_PUBLICATION_VECTOR_QUERY_DIMENSION_MISMATCH',
      message: 'STRICT_PUBLICATION_VECTOR_QUERY_DIMENSION_MISMATCH:3:2',
      name: 'StrictPublicationError',
      retryable: false,
    });
  });

  test('registers every strict error literal and leaves no plain-Error strict throw in the public reader chain', () => {
    const files = [
      'lib/host-runtime/context/StrictPublicKnowledgeResolver.ts',
      'lib/host-runtime/mcp/host/read-only-json-vector-reader.ts',
      'lib/host-runtime/mcp/host/read-only-search-executor.ts',
      'lib/host-runtime/mcp/host/read-only-search-snapshot.ts',
    ];
    const sources = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
    const unregistered = sources.flatMap(({ file, source }) =>
      [...source.matchAll(/['"`](STRICT_PUBLICATION_[A-Z0-9_]+)/gu)]
        .map((match) => match[1])
        .filter((code): code is string => !!code && !isStrictPublicationErrorCode(code))
        .map((code) => `${file}:${code}`)
    );
    const plainErrorThrows = sources.flatMap(({ file, source }) =>
      [
        ...source.matchAll(
          /throw\s+new\s+Error\s*\(\s*(?:['"][^'"]*STRICT_PUBLICATION_[A-Z0-9_]+|`[^`]*STRICT_PUBLICATION_[A-Z0-9_]+)/gu
        ),
      ].map((match) => `${file}:${match[0]}`)
    );

    expect(unregistered).toEqual([]);
    expect(plainErrorThrows).toEqual([]);
    expect(sources.map(({ source }) => source).join('\n')).not.toMatch(
      /throw\s+new\s+Error\s*\(\s*code\s*\)/u
    );
  });

  test('rejects fake strict tokens without constructing the registered error type', () => {
    try {
      new StrictPublicationError('STRICT_PUBLICATION_FAKE_ONLY' as never);
      throw new Error('expected the fake code to be rejected');
    } catch (error: unknown) {
      expect(error).not.toBeInstanceOf(StrictPublicationError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Unsupported strict publication error code: STRICT_PUBLICATION_FAKE_ONLY'
      );
    }
  });

  test('does not promote a strict-like token from a generic Search producer failure', async () => {
    const fixture = installFixture();
    strictFailure.embedding = 'unavailable';
    strictFailure.route = 'provider';
    const transport = await openHostTransport(fixture.projectRoot);
    const args = {
      operation: 'search',
      query: 'strict-like generic diagnostic',
      mode: 'semantic',
      limit: 3,
    };
    try {
      const producer = asRecord(await transport.host.callPluginOwnedTool('alembic_search', args));
      expect(producer?.errorCode).toBe('STRICT_PUBLICATION_VECTOR_PROVIDER_UNAVAILABLE');
      vi.spyOn(transport.host, 'callPluginOwnedTool').mockResolvedValue({
        ...producer,
        errorCode: 'CODEX_MCP_ERROR',
        message: 'Producer observed STRICT_PUBLICATION_FAKE_ONLY.',
      });

      const result = await transport.client.callTool({
        name: 'alembic_search',
        arguments: args,
      });
      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: 'CODEX_MCP_ERROR',
            severity: 'error',
          }),
        ],
      });
      const diagnostics = asRecord(result.structuredContent)?.diagnostics;
      expect(asRecord(Array.isArray(diagnostics) ? diagnostics[0] : null)?.code).not.toBe(
        'STRICT_PUBLICATION_FAKE_ONLY'
      );
    } finally {
      await transport.close();
    }
  }, 30_000);
});

function installFixture(): { dataRoot: string; projectRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-error-transport-plugin-'));
  roots.push(root);
  process.env.ALEMBIC_HOME = root;
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src/index.ts'),
    'export function liveProjectSource(value: string): string { return value; }\n'
  );
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'strict-publication-live-project', type: 'module' })
  );
  fs.mkdirSync(dataRoot, { recursive: true });
  const descriptor = createProjectDescriptor({
    controlRoot: root,
    dataRoot,
    projectId: 'project-strict-main',
    projectScopeId: 'scope-strict-main',
    currentFolderId: 'folder-strict-main',
    folders: [{ id: 'folder-strict-main', path: projectRoot }],
  });
  fs.mkdirSync(path.join(root, '.asd'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([descriptor]))
  );
  fs.mkdirSync(path.join(dataRoot, '.asd/context'), { recursive: true });
  fs.cpSync(FIXTURE_ROOT, path.join(dataRoot, '.asd/context/recipe-publications'), {
    recursive: true,
  });
  return { dataRoot, projectRoot };
}

function strictSnapshotDataRoot(dataRoot: string): string {
  return path.join(dataRoot, '.asd/context/recipe-publications/snapshots', SNAPSHOT_ID, 'data');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validVectorItem(id: string): Record<string, unknown> {
  return {
    content: `content:${id}`,
    id,
    metadata: {},
    vector: [1, 0, 0],
  };
}

async function openHostTransport(projectRoot: string): Promise<{
  client: Client;
  close(): Promise<void>;
  host: HostMcpServer;
}> {
  const host = new HostMcpServer({ projectRoot });
  host.sdkServer = new SdkMcpServer(
    { name: 'strict-error-transport-host-test', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  host.registerHandlers();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'strict-error-transport-client-test', version: '1.0.0' });
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
