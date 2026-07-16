import type { CertifiedProjectFactsArtifactV1 } from '@alembic/core/project-context-foundation';
import {
  hashBytes,
  hashCanonicalJson,
  type ProjectContextConsumerProjectionReceiptV2,
} from '@alembic/core/project-context-foundation';
import { describe, expect, test } from 'vitest';
import {
  assertExactRepositoryTuples,
  assertPluginCertifiedCarrier,
  type PluginCertifiedCarrier,
  persistPluginCertifiedCarrier,
  projectPluginCertifiedFacts,
  readPluginCertifiedCarrierFromProjectContext,
} from '../../lib/project-facts/PluginCertifiedProjectFactsRuntime.js';

const HASH = hashCanonicalJson({ fixture: 'plugin-pcf' });

describe('PluginCertifiedProjectFactsRuntime', () => {
  test('projects the complete artifact module axis without the historical 24-module cap', () => {
    const artifact = fixtureArtifact(30);
    const projection = projectPluginCertifiedFacts(artifact, 'plugin-read');

    expect(projection.modules).toHaveLength(30);
    expect(projection.files).toHaveLength(30);
    expect(projection.modules.at(-1)?.id).toBe('repo-root::module:29');
    expect(projection.files.every((file) => file.byteLength > 0 && file.blobHash.length > 0)).toBe(
      true
    );
  });

  test('allows incremental receipt persistence and rejects any stale present binding', () => {
    const carrier = fixtureCarrier();
    expect(() => assertPluginCertifiedCarrier(carrier)).not.toThrow();

    const missing = structuredClone(carrier);
    delete missing.receipts.plan;
    expect(() => assertPluginCertifiedCarrier(missing)).not.toThrow();

    const stale = structuredClone(carrier);
    stale.sourceVectorHash = hashCanonicalJson({ stale: true });
    expect(() => assertPluginCertifiedCarrier(stale)).toThrow(/stale plan binding/);
  });

  test('persists the namespaced Plugin receipt extension on the same bounded session carrier', () => {
    const carrier = fixtureCarrier();
    carrier.plugin = {
      version: 1,
      counters: {
        cappedModuleProjectionCount: 0,
        directProjectContextCallCount: 0,
        emptyModuleAxisPassthroughCount: 0,
        rawFilesystemFallbackCount: 0,
        synthesizedProjectScopeFactCount: 0,
      },
      dimensionCompletionReceipt: fixtureReceipt('dimension-completion'),
      instrumentation: [
        {
          consumer: 'dimension-completion',
          entrypoint: 'lib/recipe-pipeline/generate/dimension-completion.js',
          kind: 'consumer-reopen',
          receiptHash: fixtureReceipt('dimension-completion').receiptHash,
        },
        {
          consumer: 'dimension-completion',
          entrypoint: 'lib/recipe-pipeline/generate/dimension-completion.js',
          emittedModuleCount: 30,
          expectedOwnerModuleCount: 30,
          kind: 'module-projection',
        },
      ],
      knowledgeRescanApplicability: 'applicable',
      moduleAxisHash: hashCanonicalJson({ modules: 30 }),
    };
    let projectContext: Record<string, unknown> = { certifiedProjectFacts: carrier };
    const session = {
      id: 'session-1',
      projectRoot: '/workspace/project',
      replaceProjectContext(next: Record<string, unknown>) {
        projectContext = structuredClone(next);
      },
      toSnapshot: () => ({ projectContext: structuredClone(projectContext) }),
    };

    expect(
      persistPluginCertifiedCarrier({
        carrier,
        projectRoot: '/workspace/project',
        session,
      })
    ).toBe('session-1');
    const reloaded = readPluginCertifiedCarrierFromProjectContext(
      session.toSnapshot().projectContext
    );
    expect(reloaded?.plugin?.dimensionCompletionReceipt?.consumer).toBe('dimension-completion');
    expect(reloaded?.plugin?.counters).toEqual({
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 0,
      emptyModuleAxisPassthroughCount: 0,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    });
  });

  test('fails exact repository reconciliation for extra, missing, id, path, or revision drift', () => {
    const artifact = fixtureArtifact(1);
    const exact = artifact.manifest.sourceRevisionVector.entries.map((entry) => ({
      repoId: entry.repoId,
      relativeRoot: entry.relativeRoot,
      revision: entry.revision,
    }));
    expect(() => assertExactRepositoryTuples({ artifact, observed: exact })).not.toThrow();
    expect(() =>
      assertExactRepositoryTuples({
        artifact,
        observed: [...exact, { ...exact[0], repoId: 'extra' }],
      })
    ).toThrow(/do not match/);
    expect(() => assertExactRepositoryTuples({ artifact, observed: [] })).toThrow(/do not match/);
    expect(() =>
      assertExactRepositoryTuples({
        artifact,
        observed: [{ ...exact[0], relativeRoot: 'alias' }],
      })
    ).toThrow(/do not match/);
    expect(() =>
      assertExactRepositoryTuples({
        artifact,
        observed: [
          {
            ...exact[0],
            revision: { kind: 'content', workingTreeContentHash: hashCanonicalJson('drift') },
          },
        ],
      })
    ).toThrow(/do not match/);
  });
});

function fixtureCarrier(): PluginCertifiedCarrier {
  return {
    artifactId: 'cpf-v1:plugin-fixture',
    baseReadbackUnchanged: true,
    canonicalScopeHash: HASH,
    certificationBindingHash: HASH,
    factsContentHash: HASH,
    preparationId: 'prep-v1:00000000-0000-4000-8000-000000000001',
    preparationReceiptHash: HASH,
    receipts: Object.fromEntries(
      ['plan', 'recipe-generation', 'dependency-graph', 'module-coverage'].map((consumer) => [
        consumer,
        fixtureReceipt(consumer),
      ])
    ),
    sourceVectorHash: HASH,
  };
}

function fixtureReceipt(consumer: string): ProjectContextConsumerProjectionReceiptV2 {
  const semantic = {
    kind: 'ProjectContextConsumerProjectionReceiptV2' as const,
    version: 2 as const,
    artifactId: 'cpf-v1:plugin-fixture' as const,
    sourceVectorHash: HASH,
    factsContentHash: HASH,
    certificationBindingHash: HASH,
    consumer: consumer as ProjectContextConsumerProjectionReceiptV2['consumer'],
    adapterVersion: 'fixture-adapter-v1',
    projectionContentHash: HASH,
    entrypoint:
      consumer === 'dimension-completion'
        ? 'lib/recipe-pipeline/generate/dimension-completion.js'
        : `lib/${consumer}.js`,
    runId: `fixture-${consumer}`,
    payloadSchemaHash: HASH,
    loadEvidenceHash: HASH,
  };
  return { ...semantic, receiptHash: hashCanonicalJson(semantic) };
}

function fixtureArtifact(moduleCount: number): CertifiedProjectFactsArtifactV1 {
  const chunks = Array.from({ length: moduleCount }, (_, index) => {
    const bytes = Buffer.from(`export const module${index} = ${index};\n`);
    return {
      blobHash: hashBytes(bytes),
      byteLength: bytes.byteLength,
      dataBase64: bytes.toString('base64'),
    };
  });
  const files = chunks.map((chunk, index) => ({
    repoId: 'repo-root',
    relativePath: `src/module-${String(index).padStart(2, '0')}.ts`,
    language: 'typescript',
    mode: '100644',
    sizeBytes: chunk.byteLength,
    blobSha256: chunk.blobHash,
    ownerModuleIds: [`module:${String(index).padStart(2, '0')}`],
  }));
  const sourceEntry = {
    scopeId: 'scope-root',
    repoId: 'repo-root',
    relativeRoot: '.',
    revision: { kind: 'content' as const, workingTreeContentHash: HASH },
    eligibleInventoryHash: HASH,
    includeExcludePolicyHash: HASH,
  };
  return {
    artifactId: 'cpf-v1:plugin-fixture',
    sourceVectorHash: HASH,
    factsContentHash: HASH,
    certificationBindingHash: HASH,
    manifest: {
      projectScopeManifest: {
        kind: 'ProjectScopeManifestV1',
        version: 1,
        projectMode: 'single-repository',
        projectIdentity: { projectId: 'project-root', scopeId: 'scope-root' },
        repositories: [{ scopeId: 'scope-root', repoId: 'repo-root', relativeRoot: '.' }],
        acceptedDeclarationHash: HASH,
        canonicalScopeHash: HASH,
        receiptHash: HASH,
      },
      sourceRevisionVector: {
        kind: 'SourceRevisionVectorV1',
        version: 1,
        entries: [sourceEntry],
        sourceVectorHash: HASH,
      },
    },
    facts: {
      inventory: { files },
      detail: {
        frozenFiles: files.map((file) => ({
          repoId: file.repoId,
          relativePath: file.relativePath,
          blobHash: file.blobSha256,
          byteLength: file.sizeBytes,
          fullChunkRefs: [file.blobSha256],
          status: 'frozen-blob-available',
        })),
      },
      requestOutcomes: [],
    },
    chunks,
  } as unknown as CertifiedProjectFactsArtifactV1;
}
