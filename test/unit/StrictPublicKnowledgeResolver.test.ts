import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createStrictPublicationMarkerV1,
  preparePublicKnowledgeRouteV1,
} from '@alembic/core/knowledge';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { resolvePublicKnowledgePublication } from '../../lib/host-runtime/context/StrictPublicKnowledgeResolver.js';

const FIXTURE_ROOT = path.resolve('test/fixtures/strict-publication-v1/recipe-publications');
const SNAPSHOT_ID = 'snapshot-23eb0db0c7f77684b3c604f5515a5951faa2193c8597172105946dbb20b1692d';
const roots: string[] = [];
const previousHome = process.env.ALEMBIC_HOME;

afterEach(() => {
  process.env.ALEMBIC_HOME = previousHome;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('strict public knowledge publication resolver', () => {
  test('resolves the accepted Main physical bundle from the fixed ordinary namespace', () => {
    const fixture = installFixture();
    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    const resolution = resolvePublicKnowledgePublication(runtime.identity);

    expect(resolution.state).toBe('ready');
    if (resolution.state !== 'ready') {
      throw new Error('expected ready strict publication');
    }
    expect(runtime.publication).toMatchObject({
      mode: 'strict-v1',
      routeState: 'ready',
      sessionId: 'strict-integration-run',
      snapshotId: SNAPSHOT_ID,
      vectorGenerationId: '75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5',
      sourceRevisionVectorHash:
        'sha256:ff2a1058b28f4a35e445f45277b46df4432b93c64b25d0ed2a40969280e9265c',
    });
    expect(JSON.stringify(runtime.publication)).not.toContain(fixture.root);
    expect(resolution.dataRoot).toBe(
      path.join(fixture.dataRoot, '.asd/context/recipe-publications/snapshots', SNAPSHOT_ID, 'data')
    );
    expect(resolution.finalCoverage.cells).toHaveLength(6);
    expect(resolution.vector.expectedIds).toHaveLength(24);
  });

  test('treats a valid strict marker with no active route as unavailable, never legacy', () => {
    const fixture = installFixture();
    fs.rmSync(path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json'));
    fs.mkdirSync(path.join(fixture.dataRoot, '.asd'), { recursive: true });
    fs.writeFileSync(path.join(fixture.dataRoot, '.asd/alembic.db'), 'legacy-must-not-open');

    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    expect(runtime.publication).toEqual({
      mode: 'strict-v1',
      routeState: 'unavailable',
      sessionId: null,
      snapshotId: null,
      vectorGenerationId: null,
      vectorManifestHash: null,
      sourceRevisionVectorHash: null,
      sourceRevisionMatch: 'not-checked',
    });
    expect(resolvePublicKnowledgePublication(runtime.identity)).toEqual({
      provenance: runtime.publication,
      state: 'unavailable',
    });
  });

  test.each([
    ['marker', 'marker.json'],
    ['route', 'active.json'],
    ['database', `${snapshotPath()}/data/.asd/alembic.db`],
    [
      'recipe',
      `${snapshotPath()}/data/Alembic/recipes/testing-quality/strict-expression-module-src-testing-quality.md`,
    ],
    [
      'vector',
      `${snapshotPath()}/data/.asd/context/recipe-vector-generations/75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5/store/.asd/context/index/vector_index.json`,
    ],
    ['manifest', `${snapshotPath()}/manifest.json`],
    ['final coverage', `${snapshotPath()}/final-coverage.json`],
    ['serving validation', `${snapshotPath()}/serving-snapshot-validation.json`],
    ['candidate manifest', `${snapshotPath()}/data/candidate-data-manifest.json`],
    [
      'vector manifest',
      `${snapshotPath()}/data/.asd/context/recipe-vector-generations/75abdb099a96a552751e37e1-529c0223-fccc-41df-be50-20b6e25826b5/manifest.json`,
    ],
    ['lineage', `${snapshotPath()}/lineage.json`],
    ['G4 receipt', `${snapshotPath()}/g4-receipt.json`],
  ])('fails closed when the accepted %s artifact is tampered', (_label, relativePath) => {
    const fixture = installFixture();
    const target = path.join(fixture.dataRoot, '.asd/context/recipe-publications', relativePath);
    fs.chmodSync(target, 0o600);
    fs.appendFileSync(target, '\n ');
    expect(() => buildProjectRuntimeContext({ projectRoot: fixture.projectRoot })).toThrow(
      /STRICT_PUBLICATION_/
    );
  });

  test('allows legacy resolution only when the strict marker is absent', () => {
    const fixture = installFixture();
    fs.rmSync(path.join(fixture.dataRoot, '.asd/context/recipe-publications/marker.json'));
    const runtime = buildProjectRuntimeContext({ projectRoot: fixture.projectRoot });
    expect(runtime.publication).toMatchObject({ mode: 'legacy', routeState: 'legacy' });
    expect(resolvePublicKnowledgePublication(runtime.identity).state).toBe('legacy');
  });

  test('rejects a valid marker bound to another project identity', () => {
    const fixture = installFixture({ projectId: 'another-project' });
    expect(() => buildProjectRuntimeContext({ projectRoot: fixture.projectRoot })).toThrow(
      'STRICT_PUBLICATION_PROJECT_IDENTITY_MISMATCH'
    );
  });

  test('rejects a valid marker bound to another migration bundle', () => {
    const fixture = installFixture();
    const markerPath = path.join(fixture.dataRoot, '.asd/context/recipe-publications/marker.json');
    const marker = createStrictPublicationMarkerV1({
      mode: 'strict-v1',
      routeSchemaVersion: 1,
      projectIdentityHash:
        'sha256:aa8ba3ec4c62f5ad06f743a34ececbf8dc28d0446e0a61ff4509113ccca2cc78',
      migrationBundleHash: `sha256:${'1'.repeat(64)}`,
    });
    fs.chmodSync(markerPath, 0o600);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    expect(() => buildProjectRuntimeContext({ projectRoot: fixture.projectRoot })).toThrow(
      'STRICT_PUBLICATION_MIGRATION_BUNDLE_MISMATCH'
    );
  });

  test.each([
    ['cross generation', { vectorGenerationId: 'other-generation' }],
    ['traversal-shaped snapshot id', { snapshotId: '../private-candidate' }],
  ])('rejects a canonical %s route', (_label, patch) => {
    const fixture = installFixture();
    const routePath = path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json');
    const route = JSON.parse(fs.readFileSync(routePath, 'utf8')) as Record<string, unknown>;
    const prepared = preparePublicKnowledgeRouteV1({ ...route, ...patch } as never);
    fs.writeFileSync(routePath, prepared.canonicalBytes);
    expect(() => buildProjectRuntimeContext({ projectRoot: fixture.projectRoot })).toThrow(
      /STRICT_PUBLICATION_/
    );
  });

  test('rejects a symlink anywhere inside the selected snapshot route', () => {
    const fixture = installFixture();
    const snapshotRoot = path.join(
      fixture.dataRoot,
      '.asd/context/recipe-publications',
      snapshotPath()
    );
    const detached = path.join(fixture.root, 'detached-snapshot');
    fs.cpSync(snapshotRoot, detached, { recursive: true });
    fs.rmSync(snapshotRoot, { force: true, recursive: true });
    fs.symlinkSync(detached, snapshotRoot, 'dir');
    expect(() => buildProjectRuntimeContext({ projectRoot: fixture.projectRoot })).toThrow(
      'STRICT_PUBLICATION_SYMLINK_FORBIDDEN'
    );
  });

  test('rejects a symlinked metadata artifact inside a regular selected snapshot', () => {
    const fixture = installFixture();
    const manifestPath = path.join(
      fixture.dataRoot,
      '.asd/context/recipe-publications',
      snapshotPath(),
      'manifest.json'
    );
    const detached = path.join(fixture.root, 'detached-manifest.json');
    fs.copyFileSync(manifestPath, detached);
    fs.rmSync(manifestPath);
    fs.symlinkSync(detached, manifestPath, 'file');
    expect(() => buildProjectRuntimeContext({ projectRoot: fixture.projectRoot })).toThrow(
      'STRICT_PUBLICATION_SERVING_MANIFEST_INVALID'
    );
  });
});

function installFixture(options: { projectId?: string } = {}): {
  dataRoot: string;
  projectRoot: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-publication-plugin-'));
  roots.push(root);
  process.env.ALEMBIC_HOME = root;
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const descriptor = createProjectDescriptor({
    controlRoot: root,
    dataRoot,
    projectId: options.projectId ?? 'project-strict-main',
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
  return { dataRoot, projectRoot, root };
}

function snapshotPath(): string {
  return `snapshots/${SNAPSHOT_ID}`;
}
