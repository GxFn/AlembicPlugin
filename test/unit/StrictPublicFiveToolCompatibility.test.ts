import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createServingSnapshotManifestV1,
  type PublicKnowledgeRouteV1,
  preparePublicKnowledgeRouteV1,
  type ServingSnapshotManifestV1,
} from '@alembic/core/knowledge';
import {
  canonicalJsonStringify,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { HostMcpServer } from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { EmbeddedToolExecutor } from '../../lib/host-runtime/mcp/host/embedded-executor.js';
import {
  AgentPrimeOutputSchema,
  AgentWorkOutputSchema,
} from '../../lib/host-runtime/mcp/public-tools/output.js';

const FIXTURE_ROOT = path.resolve('test/fixtures/strict-publication-v1/recipe-publications');
const SNAPSHOT_ID = 'snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d';
const SNAPSHOT_PATH = `snapshots/${SNAPSHOT_ID}`;
const RECOVERY_UUID = '529c0223-fccc-41df-be50-20b6e25826b5';
const RECOVERED_SNAPSHOT_ID = `${SNAPSHOT_ID}-${RECOVERY_UUID}`;
const EXACT_PLANNING_IDENTITIES = {
  expansionLedgerHeadHash:
    'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  finalExpandedScheduleHash:
    'sha256:9aae474b7682a4de47b13b839349d788831cdb0b91a834e5b55d409be15bbcfe',
  finalCodeFactGenerationManifestHash:
    'sha256:351105afc1c5c300033f2389cb2bf9633deb4c305044d90a516e54170d1ad91e',
} as const;
const roots: string[] = [];
const previousHome = process.env.ALEMBIC_HOME;

afterEach(() => {
  process.env.ALEMBIC_HOME = previousHome;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('strict-publication-v1 formal five-tool compatibility', () => {
  test('resolves a Main-style recovered snapshot and surfaces it through MCP Recipe Map', async () => {
    const fixture = installFixture();
    rewriteFixtureAsRecoveredSnapshot(fixture.dataRoot);
    assertRecoveredFixtureConsistency(fixture.dataRoot);
    const transport = await openHostTransport(fixture.projectRoot);
    try {
      const result = await transport.client.callTool({
        name: 'alembic_recipe_map',
        arguments: { focus: { kind: 'space' }, nodeLimit: 40, recipeMountLimit: 20 },
      });
      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(readPublicationMeta(result)).toMatchObject({
        mode: 'strict-v1',
        routeState: 'ready',
        snapshotId: RECOVERED_SNAPSHOT_ID,
      });
      expect(asRecord(asRecord(result.structuredContent)?.servingCoverage)).toMatchObject({
        source: 'strict-publication-v1',
        status: 'complete',
        snapshotId: RECOVERED_SNAPSHOT_ID,
      });
    } finally {
      await transport.close();
    }
  }, 30_000);

  test('transports all five formal tools and Work with legal publication metadata', async () => {
    const fixture = installFixture();
    const transport = await openHostTransport(fixture.projectRoot);
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        [
          'alembic_search',
          { operation: 'search', query: 'strict result boundary', mode: 'semantic', limit: 3 },
        ],
        ['alembic_prime', { query: 'strict result boundary', limit: 3 }],
        ['alembic_recipe_map', { focus: { kind: 'space' }, nodeLimit: 40, recipeMountLimit: 20 }],
        [
          'alembic_code_guard',
          {
            operation: 'check',
            code: 'export function strictResult(value: string): string { return value; }',
            language: 'typescript',
          },
        ],
        ['alembic_graph', { queryKind: 'stats', budget: { itemLimit: 80 } }],
      ];
      const results: Record<string, Awaited<ReturnType<Client['callTool']>>> = {};
      for (const [name, args] of calls) {
        const result = await transport.client.callTool({ name, arguments: args });
        expect(CallToolResultSchema.parse(result), name).toBeTruthy();
        expect(result.isError, name).not.toBe(true);
        expect(readPublicationMeta(result), name).toMatchObject({
          mode: 'strict-v1',
          routeState: 'ready',
          snapshotId: SNAPSHOT_ID,
          ...EXACT_PLANNING_IDENTITIES,
        });
        expect(asRecord(result.structuredContent), name).not.toHaveProperty('_meta');
        results[name] = result;
      }
      const prime = results.alembic_prime;
      expect(CallToolResultSchema.parse(prime)).toBeTruthy();
      expect(AgentPrimeOutputSchema.parse(prime.structuredContent)).toMatchObject({
        ok: true,
        toolName: 'alembic_prime',
      });

      const work = await transport.client.callTool({
        name: 'alembic_work',
        arguments: {
          phase: 'start',
          title: 'Verify MCP publication transport',
          workScope: {
            goal: 'Keep clean structured payloads separate from transport metadata.',
            files: ['src/index.ts'],
          },
        },
      });
      expect(CallToolResultSchema.parse(work)).toBeTruthy();
      expect(AgentWorkOutputSchema.parse(work.structuredContent)).toMatchObject({
        ok: true,
        toolName: 'alembic_work',
      });
      expect(readPublicationMeta(work)).toMatchObject({
        mode: 'strict-v1',
        routeState: 'ready',
        snapshotId: SNAPSHOT_ID,
      });
      expect(asRecord(work.structuredContent)).not.toHaveProperty('_meta');
    } finally {
      await transport.close();
    }
  }, 30_000);

  test('keeps route-null failures and live Graph schema-legal across tools/call transport', async () => {
    const fixture = installFixture();
    fs.rmSync(path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json'));
    const transport = await openHostTransport(fixture.projectRoot);
    try {
      for (const [name, args] of [
        ['alembic_search', { query: 'strict' }],
        ['alembic_prime', { query: 'strict' }],
        ['alembic_recipe_map', {}],
        ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await transport.client.callTool({ name, arguments: args });
        expect(CallToolResultSchema.parse(result), name).toBeTruthy();
        expect(result.isError, name).toBe(true);
        expect(asRecord(result.structuredContent), name).toMatchObject({ ok: false });
        if (name === 'alembic_prime' || name === 'alembic_code_guard') {
          expect(asRecord(asRecord(result.structuredContent)?.error)?.code, name).toBe(
            'strict-publication-route-unavailable'
          );
          expect(JSON.stringify(result), name).not.toContain(
            'AGENT_PUBLIC_OUTPUT_PROJECTION_REJECTED'
          );
        }
        expect(readPublicationMeta(result), name).toMatchObject({
          mode: 'strict-v1',
          routeState: 'unavailable',
        });
        expect(asRecord(result.structuredContent), name).not.toHaveProperty('_meta');
      }

      const graph = await transport.client.callTool({
        name: 'alembic_graph',
        arguments: {
          queryKind: 'file-symbols',
          filePath: 'src/index.ts',
          budget: { itemLimit: 80 },
        },
      });
      expect(CallToolResultSchema.parse(graph)).toBeTruthy();
      expect(graph.isError).not.toBe(true);
      expect(JSON.stringify(graph.structuredContent)).toContain('src/index.ts');
      expect(readPublicationMeta(graph)).toMatchObject({
        mode: 'strict-v1',
        routeState: 'unavailable',
      });
      expect(asRecord(graph.structuredContent)).not.toHaveProperty('_meta');
    } finally {
      await transport.close();
    }
  }, 30_000);

  test('keeps corrupt-publication failures schema-legal across tools/call transport', async () => {
    const fixture = installFixture();
    fs.rmSync(
      path.join(
        fixture.dataRoot,
        '.asd/context/recipe-publications',
        SNAPSHOT_PATH,
        'data/.asd/alembic.db'
      )
    );
    const transport = await openHostTransport(fixture.projectRoot);
    try {
      for (const [name, args] of [
        ['alembic_search', { query: 'strict' }],
        ['alembic_prime', { query: 'strict' }],
        ['alembic_recipe_map', {}],
        ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
      ] as Array<[string, Record<string, unknown>]>) {
        if (name === 'alembic_prime' || name === 'alembic_code_guard') {
          expect(await transport.host.callPluginOwnedTool(name, args), name).toMatchObject({
            success: false,
            errorCode: 'STRICT_PUBLICATION_ARTIFACT_MISSING',
          });
        }
        const result = await transport.client.callTool({ name, arguments: args });
        expect(CallToolResultSchema.parse(result), name).toBeTruthy();
        expect(result.isError, name).toBe(true);
        expect(asRecord(result.structuredContent), name).toMatchObject({ ok: false });
        if (name === 'alembic_prime' || name === 'alembic_code_guard') {
          expect(asRecord(asRecord(result.structuredContent)?.error)?.code, name).toBe(
            'STRICT_PUBLICATION_ARTIFACT_MISSING'
          );
        }
        expect(readPublicationMeta(result), name).toMatchObject({
          mode: 'strict-v1',
          routeState: 'ready',
          snapshotId: SNAPSHOT_ID,
        });
        expect(asRecord(result.structuredContent), name).not.toHaveProperty('_meta');
      }

      const graph = await transport.client.callTool({
        name: 'alembic_graph',
        arguments: {
          queryKind: 'file-symbols',
          filePath: 'src/index.ts',
          budget: { itemLimit: 80 },
        },
      });
      expect(CallToolResultSchema.parse(graph)).toBeTruthy();
      expect(graph.isError).not.toBe(true);
      expect(JSON.stringify(graph.structuredContent)).toContain('src/index.ts');
      expect(readPublicationMeta(graph)).toMatchObject({
        mode: 'strict-v1',
        routeState: 'ready',
        snapshotId: SNAPSHOT_ID,
      });
      expect(asRecord(graph.structuredContent)).not.toHaveProperty('_meta');
    } finally {
      await transport.close();
    }
  }, 30_000);

  test.each([
    ['alembic_prime', { query: 'strict' }],
    [
      'alembic_work',
      {
        phase: 'start',
        title: 'Preserve producer failure code',
        workScope: { goal: 'Keep exact producer diagnostics.', files: ['src/index.ts'] },
      },
    ],
    ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'preserves the exact canonical %s producer failure through HostMcpServer transport',
    async (name, args) => {
      const fixture = installFixture();
      const transport = await openHostTransport(fixture.projectRoot);
      const producerFailure = createCanonicalProducerFailure(name, fixture.projectRoot);
      vi.spyOn(transport.host, 'callPluginOwnedTool').mockResolvedValue(producerFailure);
      try {
        const result = await transport.client.callTool({ name, arguments: args });
        expect(CallToolResultSchema.parse(result)).toBeTruthy();
        expect(result.isError).toBe(true);
        const structured = asRecord(result.structuredContent);
        expect(asRecord(structured?.error)?.code).toBe('STRICT_PUBLICATION_ARTIFACT_MISSING');
        expect(JSON.stringify(structured)).not.toContain('AGENT_PUBLIC_OUTPUT_PROJECTION_REJECTED');
        expect(readPublicationMeta(result)).toEqual(
          asRecord(asRecord(producerFailure._meta)?.alembicPublication)
        );
      } finally {
        await transport.close();
      }
    },
    30_000
  );

  test.each([
    ['alembic_prime', { query: 'strict' }],
    [
      'alembic_work',
      {
        phase: 'start',
        title: 'Reject malformed producer failure',
        workScope: { goal: 'Keep strict transport projection.', files: ['src/index.ts'] },
      },
    ],
    ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'fails closed when %s returns a malformed failure through HostMcpServer transport',
    async (name, args) => {
      const fixture = installFixture();
      const transport = await openHostTransport(fixture.projectRoot);
      const producerFailure = createCanonicalProducerFailure(name, fixture.projectRoot);
      vi.spyOn(transport.host, 'callPluginOwnedTool').mockResolvedValue({
        ...producerFailure,
        data: {
          ...asRecord(producerFailure.data),
          projectRuntime: {
            ...asRecord(asRecord(producerFailure.data)?.projectRuntime),
            unexpectedNestedRuntimeField: 'must-not-be-silently-dropped',
          },
        },
        unexpectedTransportField: 'must-not-be-silently-dropped',
      });
      try {
        const result = await transport.client.callTool({ name, arguments: args });
        expect(CallToolResultSchema.parse(result)).toBeTruthy();
        expect(result.isError).toBe(true);
        const structured = asRecord(result.structuredContent);
        expect(asRecord(structured?.error)?.code).toBe('AGENT_PUBLIC_OUTPUT_PROJECTION_REJECTED');
        expect(JSON.stringify(structured)).toContain('unexpectedTransportField');
        expect(JSON.stringify(structured)).toContain('unexpectedNestedRuntimeField');
        expect(JSON.stringify(structured)).not.toContain('"handler-error"');
      } finally {
        await transport.close();
      }
    },
    30_000
  );

  test('does not promote a strict-like token from a generic producer message', async () => {
    const fixture = installFixture();
    const transport = await openHostTransport(fixture.projectRoot);
    vi.spyOn(transport.host, 'callPluginOwnedTool').mockResolvedValue({
      ...createCanonicalProducerFailure('alembic_work', fixture.projectRoot),
      errorCode: 'CODEX_MCP_ERROR',
      message: 'Producer observed STRICT_PUBLICATION_FAKE_ONLY.',
    });
    try {
      const result = await transport.client.callTool({
        name: 'alembic_work',
        arguments: {
          phase: 'start',
          title: 'Keep generic diagnostics honest',
          workScope: { goal: 'Avoid false error attribution.', files: ['src/index.ts'] },
        },
      });
      expect(CallToolResultSchema.parse(result)).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(asRecord(asRecord(result.structuredContent)?.error)?.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(result)).not.toContain('CODEX_MCP_ERROR');
    } finally {
      await transport.close();
    }
  }, 30_000);

  test.each([
    ['alembic_prime', { query: 'strict' }],
    [
      'alembic_work',
      {
        phase: 'start',
        title: 'Reject malformed unavailable result',
        workScope: { goal: 'Keep unavailable projection strict.', files: ['src/index.ts'] },
      },
    ],
    ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'fails closed when %s returns status=unavailable with an unknown field',
    async (name, args) => {
      const fixture = installFixture();
      const transport = await openHostTransport(fixture.projectRoot);
      vi.spyOn(transport.host, 'callPluginOwnedTool').mockResolvedValue({
        ...createKnownUnavailableProducerResult(name, fixture.projectRoot),
        unexpectedUnavailableField: 'must-not-be-silently-dropped',
      });
      try {
        const result = await transport.client.callTool({ name, arguments: args });
        expect(CallToolResultSchema.parse(result)).toBeTruthy();
        expect(result.isError).toBe(true);
        const structured = asRecord(result.structuredContent);
        expect(asRecord(structured?.error)?.code).toBe('AGENT_PUBLIC_OUTPUT_PROJECTION_REJECTED');
        expect(JSON.stringify(structured)).toContain('unexpectedUnavailableField');
        expect(JSON.stringify(structured)).not.toContain('"handler-error"');
      } finally {
        await transport.close();
      }
    },
    30_000
  );

  test('routes all five formal tools through one accepted publication and keeps calls read-only', async () => {
    const fixture = installFixture();
    const before = fingerprintTree(fixture.dataRoot);
    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    expect(runtime.contractVersion).toBe(3);
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'strict-publication-plugin-test',
      hostProjectRoot: fixture.projectRoot,
    });
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        [
          'alembic_search',
          { operation: 'search', query: 'strict result boundary', mode: 'semantic', limit: 3 },
        ],
        ['alembic_prime', { query: 'strict result boundary', limit: 3 }],
        ['alembic_recipe_map', { focus: { kind: 'space' }, nodeLimit: 40, recipeMountLimit: 20 }],
        [
          'alembic_code_guard',
          {
            operation: 'check',
            code: 'export function strictResult(value: string): string { return value; }',
            language: 'typescript',
          },
        ],
        ['alembic_graph', { queryKind: 'stats', budget: { itemLimit: 80 } }],
      ];
      const outputs: Record<string, Record<string, unknown>> = {};
      for (const [name, args] of calls) {
        outputs[name] = (await executor.execute(name, args, {
          projectRoot: fixture.projectRoot,
          projectRuntime: runtime,
        })) as Record<string, unknown>;
        expect(JSON.stringify(outputs[name])).not.toContain(
          'Plugin-owned Codex tool execution failed'
        );
        expect(asRecord(asRecord(outputs[name]._meta)?.alembicPublication)).toMatchObject({
          mode: 'strict-v1',
          routeState: 'ready',
          sessionId: 'strict-integration-run',
          snapshotId: 'snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d',
          vectorGenerationId: '75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5',
        });
      }
      const search = asRecord(outputs.alembic_search.structuredContent);
      expect(asRecord(search?.result)).toMatchObject({ semanticUsed: true, vectorUsed: true });
      const recipeMap = asRecord(outputs.alembic_recipe_map.structuredContent);
      expect(asRecord(recipeMap?.servingCoverage)).toMatchObject({
        source: 'strict-publication-v1',
        status: 'complete',
        totalCells: 6,
        coveredByReadyRecipe: 6,
        receiptHash: 'sha256:8d50b0a1820f94db3fe75a627e2c663bd384a5c0cb2973e5e4951339d140656a',
      });
      expect(JSON.stringify(outputs.alembic_graph)).not.toContain('strict-expression-module');
      expect(fingerprintTree(fixture.dataRoot)).toEqual(before);
      expect(findSidecars(fixture.dataRoot)).toEqual([]);
    } finally {
      await executor.dispose();
    }
  }, 30_000);

  test('strict route-null isolates legacy knowledge while Graph remains live-source', async () => {
    const fixture = installFixture();
    fs.rmSync(path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json'));
    fs.copyFileSync(
      path.join(
        FIXTURE_ROOT,
        'snapshots/snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d/data/.asd/alembic.db'
      ),
      path.join(fixture.dataRoot, '.asd/alembic.db')
    );
    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    const executor = new EmbeddedToolExecutor({
      getSessionId: () => 'strict-route-null-test',
      hostProjectRoot: fixture.projectRoot,
    });
    try {
      for (const [name, args] of [
        ['alembic_search', { query: 'strict' }],
        ['alembic_prime', { query: 'strict' }],
        ['alembic_recipe_map', {}],
        ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await executor.execute(name, args, {
          projectRoot: fixture.projectRoot,
          projectRuntime: runtime,
        });
        expect(JSON.stringify(result)).toContain('strict-publication-route-unavailable');
        expect(JSON.stringify(result)).not.toContain('strict-expression-module');
      }
      const graph = await executor.execute(
        'alembic_graph',
        {
          queryKind: 'file-symbols',
          filePath: 'src/index.ts',
          budget: { itemLimit: 80 },
        },
        { projectRoot: fixture.projectRoot, projectRuntime: runtime }
      );
      expect(JSON.stringify(graph)).toContain('src/index.ts');
      expect(JSON.stringify(graph)).not.toContain('strict-expression-module');
    } finally {
      await executor.dispose();
    }
  }, 30_000);

  test.each([
    [
      'database is missing',
      (publicationRoot: string) => {
        fs.rmSync(path.join(publicationRoot, SNAPSHOT_PATH, 'data/.asd/alembic.db'));
      },
    ],
    [
      'Recipe is tampered',
      (publicationRoot: string) => {
        tamper(
          path.join(
            publicationRoot,
            SNAPSHOT_PATH,
            'data/Alembic/recipes/testing-quality/strict-expression-module-src-testing-quality.md'
          )
        );
      },
    ],
    [
      'vector store is missing',
      (publicationRoot: string) => {
        fs.rmSync(
          path.join(
            publicationRoot,
            SNAPSHOT_PATH,
            'data/.asd/context/recipe-vector-generations/75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5/store/.asd/context/index/vector_index.json'
          )
        );
      },
    ],
    [
      'final coverage is tampered',
      (publicationRoot: string) => {
        tamper(path.join(publicationRoot, SNAPSHOT_PATH, 'final-coverage.json'));
      },
    ],
  ])(
    'keeps formal Graph live when pointed knowledge %s and fails four knowledge tools closed',
    async (_label, mutatePublication) => {
      const fixture = installFixture();
      const publicationRoot = path.join(fixture.dataRoot, '.asd/context/recipe-publications');
      mutatePublication(publicationRoot);
      const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
      const executor = new EmbeddedToolExecutor({
        getSessionId: () => 'strict-graph-isolation-test',
        hostProjectRoot: fixture.projectRoot,
      });
      try {
        const graph = await executor.execute(
          'alembic_graph',
          {
            queryKind: 'file-symbols',
            filePath: 'src/index.ts',
            budget: { itemLimit: 80 },
          },
          { projectRoot: fixture.projectRoot, projectRuntime: runtime }
        );
        expect(JSON.stringify(graph)).toContain('src/index.ts');
        expect(JSON.stringify(graph)).not.toContain('Plugin-owned Codex tool execution failed');
        const graphRecord = asRecord(graph);
        const graphMeta = asRecord(graphRecord?._meta);
        expect(asRecord(graphMeta?.alembicPublication)).toMatchObject({
          mode: 'strict-v1',
          routeState: 'ready',
          sessionId: 'strict-integration-run',
          snapshotId: SNAPSHOT_ID,
        });

        for (const [name, args] of [
          ['alembic_search', { query: 'strict' }],
          ['alembic_prime', { query: 'strict' }],
          ['alembic_recipe_map', {}],
          ['alembic_code_guard', { operation: 'check', code: 'const strict = true;' }],
        ] as Array<[string, Record<string, unknown>]>) {
          const result = await executor.execute(name, args, {
            projectRoot: fixture.projectRoot,
            projectRuntime: runtime,
          });
          expect(JSON.stringify(result), name).toContain('STRICT_PUBLICATION_');
        }
      } finally {
        await executor.dispose();
      }
    },
    30_000
  );
});

function tamper(filePath: string): void {
  fs.chmodSync(filePath, 0o600);
  fs.appendFileSync(filePath, '\n ');
}

function installFixture(): { dataRoot: string; projectRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-five-tool-plugin-'));
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

/**
 * Mirrors Main's collision-recovery rename while rebuilding only the immutable
 * snapshot witnesses whose hashes include snapshotId. Core remains the contract
 * authority for the recovered id, serving manifest, and route bytes.
 */
function rewriteFixtureAsRecoveredSnapshot(dataRoot: string): void {
  const publicationRoot = path.join(dataRoot, '.asd/context/recipe-publications');
  const originalSnapshotRoot = path.join(publicationRoot, SNAPSHOT_PATH);
  const recoveredSnapshotRoot = path.join(publicationRoot, 'snapshots', RECOVERED_SNAPSHOT_ID);
  fs.renameSync(originalSnapshotRoot, recoveredSnapshotRoot);

  const validationPath = path.join(recoveredSnapshotRoot, 'serving-snapshot-validation.json');
  const validation = JSON.parse(fs.readFileSync(validationPath, 'utf8')) as Record<string, unknown>;
  const { receiptHash: _receiptHash, ...validationSemantic } = {
    ...validation,
    snapshotId: RECOVERED_SNAPSHOT_ID,
  };
  const recoveredValidation = {
    ...validationSemantic,
    receiptHash: hashCanonicalJson(validationSemantic),
  };
  fs.chmodSync(validationPath, 0o600);
  fs.writeFileSync(validationPath, `${JSON.stringify(recoveredValidation)}\n`);

  const manifestPath = path.join(recoveredSnapshotRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ServingSnapshotManifestV1;
  const { schemaVersion: _schemaVersion, manifestHash: _manifestHash, ...manifestInput } = manifest;
  const recoveredManifest = createServingSnapshotManifestV1({
    ...manifestInput,
    snapshotId: RECOVERED_SNAPSHOT_ID,
    servingSnapshotValidationHash: recoveredValidation.receiptHash,
  });
  fs.chmodSync(manifestPath, 0o600);
  fs.writeFileSync(manifestPath, `${JSON.stringify(recoveredManifest)}\n`);

  const routePath = path.join(publicationRoot, 'active.json');
  const route = JSON.parse(fs.readFileSync(routePath, 'utf8')) as PublicKnowledgeRouteV1;
  const recoveredRoute = preparePublicKnowledgeRouteV1({
    ...route,
    snapshotId: RECOVERED_SNAPSHOT_ID,
    servingSnapshotManifestHash: recoveredManifest.manifestHash,
  });
  fs.chmodSync(routePath, 0o600);
  fs.writeFileSync(routePath, recoveredRoute.canonicalBytes);
}

function assertRecoveredFixtureConsistency(dataRoot: string): void {
  const publicationRoot = path.join(dataRoot, '.asd/context/recipe-publications');
  const recoveredSnapshotRoot = path.join(publicationRoot, 'snapshots', RECOVERED_SNAPSHOT_ID);
  const route = JSON.parse(
    fs.readFileSync(path.join(publicationRoot, 'active.json'), 'utf8')
  ) as Record<string, unknown>;
  const validation = JSON.parse(
    fs.readFileSync(path.join(recoveredSnapshotRoot, 'serving-snapshot-validation.json'), 'utf8')
  ) as Record<string, unknown>;
  const candidateManifest = JSON.parse(
    fs.readFileSync(path.join(recoveredSnapshotRoot, 'data/candidate-data-manifest.json'), 'utf8')
  ) as Record<string, unknown>;
  const finalCoverage = JSON.parse(
    fs.readFileSync(path.join(recoveredSnapshotRoot, 'final-coverage.json'), 'utf8')
  ) as Record<string, unknown>;
  const { receiptHash, ...validationSemantic } = validation;
  expect(receiptHash).toBe(hashCanonicalJson(validationSemantic));
  expect(validation).toMatchObject({
    schemaVersion: 1,
    verdict: 'pass',
    failedPredicate: null,
    sessionId: route.sessionId,
    runId: route.sessionId,
    snapshotId: RECOVERED_SNAPSHOT_ID,
    candidateDataManifestHash: candidateManifest.manifestHash,
    finalCoverageBindingHash: finalCoverage.receiptHash,
    vectorGenerationId: route.vectorGenerationId,
    vectorManifestHash: route.vectorManifestHash,
    certifiedProjectFactsHash: route.certifiedProjectFactsHash,
    sourceRevisionVectorHash: route.sourceRevisionVectorHash,
    analysisFixpointHash: route.analysisFixpointHash,
  });
  const expectedServingRecipeIds = (finalCoverage.cells as Array<{ finalRecipeIds: string[] }>)
    .flatMap((cell) => cell.finalRecipeIds)
    .sort((left, right) => left.localeCompare(right));
  expect(canonicalJsonStringify(validation.servingRecipeIds)).toBe(
    canonicalJsonStringify(expectedServingRecipeIds)
  );
}

function fingerprintTree(root: string): Record<string, string> {
  return Object.fromEntries(
    walk(root).map((file) => [path.relative(root, file), fs.readFileSync(file).toString('base64')])
  );
}

function findSidecars(root: string): string[] {
  return walk(root)
    .filter((file) => /(?:-wal|-shm)$/u.test(file))
    .map((file) => path.relative(root, file));
}

function walk(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPublicationMeta(result: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(asRecord(result)?._meta)?.alembicPublication);
}

function createCanonicalProducerFailure(
  toolName: string,
  projectRoot: string
): Record<string, unknown> {
  const projectRuntime = buildProjectRuntimeContext({ projectRoot });
  return {
    success: false,
    message: 'Producer failed with STRICT_PUBLICATION_ARTIFACT_MISSING.',
    errorCode: 'STRICT_PUBLICATION_ARTIFACT_MISSING',
    tool: toolName,
    data: { projectRuntime },
    _meta: { alembicPublication: projectRuntime.publication },
  };
}

function createKnownUnavailableProducerResult(
  toolName: string,
  projectRoot: string
): Record<string, unknown> {
  const projectRuntime = buildProjectRuntimeContext({ projectRoot });
  const publication = {
    mode: 'strict-v1',
    routeState: 'unavailable',
    sessionId: null,
    snapshotId: null,
    vectorGenerationId: null,
    vectorManifestHash: null,
    sourceRevisionVectorHash: null,
    expansionLedgerHeadHash: null,
    finalExpandedScheduleHash: null,
    finalCodeFactGenerationManifestHash: null,
    sourceRevisionMatch: 'not-checked',
  };
  const unavailableRuntime = { ...projectRuntime, publication };
  const summary = 'Strict publication route is unavailable.';
  return {
    success: true,
    data: {
      status: 'unavailable',
      summary,
      items: [],
      results: [],
      relations: [],
      diagnostics: [
        {
          code: 'strict-publication-route-unavailable',
          severity: 'info',
          message: summary,
          retryable: false,
        },
      ],
      nextActions: [],
      project: {
        projectRoot: projectRuntime.identity.projectRoot,
        projectId: projectRuntime.identity.projectId,
        dataRoot: projectRuntime.identity.dataRoot,
        databasePath: projectRuntime.identity.databasePath,
        databaseExists: false,
        publication,
      },
      projectRuntime: unavailableRuntime,
    },
    message: summary,
    toolName,
    _meta: { alembicPublication: publication },
  };
}

async function openHostTransport(projectRoot: string): Promise<{
  client: Client;
  close(): Promise<void>;
  host: HostMcpServer;
}> {
  const host = new HostMcpServer({ projectRoot });
  host.sdkServer = new SdkMcpServer(
    { name: 'strict-publication-host-test', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  host.registerHandlers();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'strict-publication-client-test', version: '1.0.0' });
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
