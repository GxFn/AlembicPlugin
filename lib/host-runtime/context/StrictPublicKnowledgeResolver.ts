import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import {
  createFinalCoverageBindingReceiptV1,
  createServingSnapshotManifestV1,
  createStrictPublicationMarkerV1,
  type FinalCoverageBindingReceiptV1,
  type PreparedPublicKnowledgeRouteV1,
  type PublicKnowledgeRouteV1,
  preparePublicKnowledgeRouteV1,
  type ServingSnapshotManifestV1,
  type StrictPublicationMarkerV1,
} from '@alembic/core/knowledge';
import {
  buildProjectScopeManifestV1,
  canonicalJsonStringify,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import {
  StrictPublicationError,
  type StrictPublicationErrorCode,
} from './StrictPublicationError.js';

export const STRICT_PUBLICATION_ROOT_RELATIVE_PATH = '.asd/context/recipe-publications';
const STRICT_PUBLICATION_MARKER_FILE = 'marker.json';
const STRICT_PUBLICATION_ACTIVE_FILE = 'active.json';
const SNAPSHOT_ID_PATTERN = /^snapshot-[a-f0-9]{64}$/u;
const SHA_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
export interface ProjectRuntimePublicationProvenance {
  mode: 'legacy' | 'strict-v1';
  routeState: 'legacy' | 'ready' | 'unavailable';
  sessionId: string | null;
  snapshotId: string | null;
  vectorGenerationId: string | null;
  vectorManifestHash: string | null;
  sourceRevisionVectorHash: string | null;
  sourceRevisionMatch: 'matched' | 'mismatched' | 'not-checked' | 'unavailable';
}

export interface StrictVectorPublication {
  dimension: number;
  expectedIds: readonly string[];
  formatProfile: 'asymmetric' | 'symmetric';
  generationId: string;
  indexPath: string;
  manifestHash: string;
  model: string;
  normalization: 'normalized' | 'not-normalized' | 'provider-defined';
  provider: string;
}

export interface StrictReadyPublicKnowledgePublication {
  candidateDataManifest: Record<string, unknown>;
  dataFiles: readonly StrictPublicationDataFile[];
  dataRoot: string;
  databasePath: string;
  finalCoverage: FinalCoverageBindingReceiptV1;
  provenance: ProjectRuntimePublicationProvenance;
  route: PublicKnowledgeRouteV1;
  snapshotRoot: string;
  state: 'ready';
  vector: StrictVectorPublication;
}

export type PublicKnowledgePublicationResolution =
  | {
      provenance: ProjectRuntimePublicationProvenance;
      state: 'legacy' | 'unavailable';
    }
  | StrictReadyPublicKnowledgePublication;

export type PublicKnowledgePublicationObservation =
  | {
      provenance: ProjectRuntimePublicationProvenance;
      state: 'legacy' | 'unavailable';
    }
  | {
      provenance: ProjectRuntimePublicationProvenance;
      route: PublicKnowledgeRouteV1;
      state: 'ready';
    };

export interface StrictPublicationIdentityInput {
  dataRoot: string;
  projectId: string | null;
  projectRoot: string;
  projectScope: unknown | null;
  projectScopeId: string | null;
}

export interface StrictPublicationDataFile {
  byteHash: string;
  relativePath: string;
  size: number;
}

interface VectorManifestRecord extends Record<string, unknown> {
  dimension: number;
  expectedIds: string[];
  expectedIdsByRecipe: Record<string, string[]>;
  formatProfile: 'asymmetric' | 'symmetric';
  generationId: string;
  manifestHash: string;
  model: string;
  normalization: 'normalized' | 'not-normalized' | 'provider-defined';
  provider: string;
}

interface VectorItemRecord extends Record<string, unknown> {
  content: string;
  id: string;
  metadata: Record<string, unknown>;
  vector: number[];
}

export function resolvePublicKnowledgePublication(
  identity: StrictPublicationIdentityInput
): PublicKnowledgePublicationResolution {
  const observation = observePublicKnowledgePublication(identity);
  if (observation.state !== 'ready') {
    return observation;
  }

  const dataRoot = path.resolve(requireText(identity.dataRoot, 'dataRoot'));
  const publicationRoot = path.join(dataRoot, STRICT_PUBLICATION_ROOT_RELATIVE_PATH);
  const route = observation.route;
  const provenance = observation.provenance;

  const snapshotRoot = confinedChild(
    publicationRoot,
    path.join('snapshots', route.snapshotId),
    'STRICT_PUBLICATION_SNAPSHOT_PATH_INVALID'
  );
  assertRegularDirectory(dataRoot, snapshotRoot, 'STRICT_PUBLICATION_SNAPSHOT_INVALID');
  const physicalPublicationRoot = realpathSync.native(publicationRoot);
  const physicalSnapshotRoot = realpathSync.native(snapshotRoot);
  if (!physicalSnapshotRoot.startsWith(`${physicalPublicationRoot}${path.sep}`)) {
    fail('STRICT_PUBLICATION_SNAPSHOT_PATH_INVALID');
  }

  const candidateDataManifestPath = path.join(snapshotRoot, 'data/candidate-data-manifest.json');
  const candidateDataManifest = readCanonicalJson<Record<string, unknown>>(
    candidateDataManifestPath,
    'STRICT_PUBLICATION_CANDIDATE_MANIFEST_INVALID',
    true
  );
  verifyCandidateDataManifest(candidateDataManifest, route);

  const dataRootPath = path.join(snapshotRoot, 'data');
  assertRegularDirectory(dataRoot, dataRootPath, 'STRICT_PUBLICATION_DATA_ROOT_INVALID');
  const dataFiles = verifyDataFiles(dataRoot, dataRootPath, candidateDataManifest);

  const candidateCoverage = readCanonicalJson<Record<string, unknown>>(
    path.join(snapshotRoot, 'candidate-coverage.json'),
    'STRICT_PUBLICATION_CANDIDATE_COVERAGE_INVALID',
    true
  );
  verifySelfHash(candidateCoverage, 'receiptHash', 'STRICT_PUBLICATION_CANDIDATE_COVERAGE_INVALID');
  const finalCoverage = readCanonicalJson<FinalCoverageBindingReceiptV1>(
    path.join(snapshotRoot, 'final-coverage.json'),
    'STRICT_PUBLICATION_FINAL_COVERAGE_INVALID',
    true
  );
  verifyFinalCoverage(finalCoverage, candidateCoverage, candidateDataManifest);

  const g4Receipt = readCanonicalJson<Record<string, unknown>>(
    path.join(snapshotRoot, 'g4-receipt.json'),
    'STRICT_PUBLICATION_G4_RECEIPT_INVALID',
    true
  );
  verifyG4Receipt(g4Receipt, finalCoverage, candidateDataManifest);

  const validation = readCanonicalJson<Record<string, unknown>>(
    path.join(snapshotRoot, 'serving-snapshot-validation.json'),
    'STRICT_PUBLICATION_VALIDATION_RECEIPT_INVALID',
    true
  );
  verifyServingValidation(validation, route, finalCoverage, candidateDataManifest);

  const servingManifest = readCanonicalJson<ServingSnapshotManifestV1>(
    path.join(snapshotRoot, 'manifest.json'),
    'STRICT_PUBLICATION_SERVING_MANIFEST_INVALID',
    true
  );
  verifyServingManifest(servingManifest, route, validation, finalCoverage, candidateDataManifest);

  const lineage = readCanonicalJson<Record<string, unknown>>(
    path.join(snapshotRoot, 'lineage.json'),
    'STRICT_PUBLICATION_LINEAGE_INVALID',
    true
  );
  verifyLineage(lineage, route, validation, candidateDataManifest);

  const vector = verifyVectorPublication(dataRoot, dataRootPath, route, candidateDataManifest);
  const databasePath = path.join(dataRootPath, '.asd/alembic.db');
  if (!dataFiles.some((file) => file.relativePath === '.asd/alembic.db')) {
    fail('STRICT_PUBLICATION_DATABASE_MISSING');
  }

  return {
    candidateDataManifest,
    dataFiles,
    dataRoot: dataRootPath,
    databasePath,
    finalCoverage,
    provenance,
    route,
    snapshotRoot,
    state: 'ready',
    vector,
  };
}

/** Observe only the fixed strict marker and canonical route; never open pointed knowledge. */
export function observePublicKnowledgePublication(
  identity: StrictPublicationIdentityInput
): PublicKnowledgePublicationObservation {
  const dataRoot = path.resolve(requireText(identity.dataRoot, 'dataRoot'));
  const publicationRoot = path.join(dataRoot, STRICT_PUBLICATION_ROOT_RELATIVE_PATH);
  const markerPath = path.join(publicationRoot, STRICT_PUBLICATION_MARKER_FILE);
  if (!pathExists(markerPath)) {
    return {
      provenance: legacyProvenance(),
      state: 'legacy',
    };
  }

  assertNoSymlinkTraversal(dataRoot, markerPath);
  const marker = readCanonicalJson<StrictPublicationMarkerV1>(
    markerPath,
    'STRICT_PUBLICATION_MARKER_INVALID',
    true
  );
  verifyMarker(marker, identity);

  const activePath = path.join(publicationRoot, STRICT_PUBLICATION_ACTIVE_FILE);
  if (!pathExists(activePath)) {
    return {
      provenance: strictUnavailableProvenance(),
      state: 'unavailable',
    };
  }
  assertNoSymlinkTraversal(dataRoot, activePath);
  const route = readCanonicalJson<PublicKnowledgeRouteV1>(
    activePath,
    'STRICT_PUBLICATION_ROUTE_INVALID',
    false
  );
  let preparedRoute: PreparedPublicKnowledgeRouteV1;
  try {
    preparedRoute = preparePublicKnowledgeRouteV1(route);
  } catch {
    fail('STRICT_PUBLICATION_ROUTE_INVALID');
  }
  if (readFileSync(activePath, 'utf8') !== preparedRoute.canonicalBytes) {
    fail('STRICT_PUBLICATION_ROUTE_BYTES_MISMATCH');
  }
  if (!SNAPSHOT_ID_PATTERN.test(route.snapshotId)) {
    fail('STRICT_PUBLICATION_SNAPSHOT_ID_INVALID');
  }
  return {
    provenance: readyProvenance(route),
    route,
    state: 'ready',
  };
}

function verifyMarker(
  marker: StrictPublicationMarkerV1,
  identity: StrictPublicationIdentityInput
): void {
  let rebuilt: StrictPublicationMarkerV1;
  try {
    const { schemaVersion: _schemaVersion, markerHash: _markerHash, ...input } = marker;
    rebuilt = createStrictPublicationMarkerV1(input);
  } catch {
    fail('STRICT_PUBLICATION_MARKER_INVALID');
  }
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(marker)) {
    fail('STRICT_PUBLICATION_MARKER_INVALID');
  }
  if (marker.projectIdentityHash !== resolveProjectIdentityHash(identity)) {
    fail('STRICT_PUBLICATION_PROJECT_IDENTITY_MISMATCH');
  }
  const migrationBundleHash = hashCanonicalJson(readAlembicMigrationBundleManifest());
  if (marker.migrationBundleHash !== migrationBundleHash) {
    fail('STRICT_PUBLICATION_MIGRATION_BUNDLE_MISMATCH');
  }
}

function resolveProjectIdentityHash(identity: StrictPublicationIdentityInput): string {
  const scope = asRecord(identity.projectScope);
  const folders = Array.isArray(scope?.folders)
    ? scope.folders.map(asRecord).filter((value): value is Record<string, unknown> => !!value)
    : [];
  const controlRoot = readText(scope?.controlRoot);
  if (controlRoot && folders.length > 0) {
    const repositories = folders.map((folder, index) => ({
      relativeRoot: portableRelativeRoot(
        path.relative(
          path.resolve(controlRoot),
          path.resolve(requireText(folder.path, 'folder.path'))
        )
      ),
      repoId: opaqueId(
        readText(folder.repositoryId) ??
          readText(folder.folderId) ??
          readText(folder.id) ??
          `repo-${index + 1}`
      ),
      sourceRoot: path.resolve(requireText(folder.path, 'folder.path')),
    }));
    return buildProjectScopeManifestV1({
      acceptedScope: {
        projectIdentity: {
          projectId: opaqueId(readText(scope?.projectId) ?? identity.projectId ?? 'project'),
          scopeId: opaqueId(
            readText(scope?.projectScopeId) ?? identity.projectScopeId ?? 'scope-project'
          ),
        },
        projectMode: 'project-scope',
        repositories: repositories.map(({ relativeRoot, repoId }) => ({ relativeRoot, repoId })),
      },
      controlRoot,
      sourceRoots: repositories.map(({ repoId, sourceRoot }) => ({ repoId, sourceRoot })),
    }).manifest.canonicalScopeHash;
  }

  const projectRoot = path.resolve(identity.projectRoot);
  const repoId = opaqueId(path.basename(projectRoot) || 'project');
  return buildProjectScopeManifestV1({
    acceptedScope: {
      projectIdentity: { projectId: repoId, scopeId: `scope-${repoId}` },
      projectMode: 'single-repository',
      repositories: [{ relativeRoot: '.', repoId }],
    },
    controlRoot: projectRoot,
    sourceRoots: [{ repoId, sourceRoot: projectRoot }],
  }).manifest.canonicalScopeHash;
}

function verifyCandidateDataManifest(
  manifest: Record<string, unknown>,
  route: PublicKnowledgeRouteV1
): void {
  verifyExactKeys(
    manifest,
    [
      'schemaVersion',
      'sourceRevisionInitReceiptHash',
      'sourceRootManifestHash',
      'candidateCoverageReceiptHash',
      'activeRecipeIds',
      'readyMemberSetHash',
      'vectorGenerationId',
      'vectorManifestHash',
      'databaseIntegrity',
      'foreignKeyViolationCount',
      'files',
      'manifestHash',
    ],
    'STRICT_PUBLICATION_CANDIDATE_MANIFEST_INVALID'
  );
  verifySelfHash(manifest, 'manifestHash', 'STRICT_PUBLICATION_CANDIDATE_MANIFEST_INVALID');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.databaseIntegrity !== 'ok' ||
    manifest.foreignKeyViolationCount !== 0 ||
    manifest.manifestHash !== `sha256:${route.snapshotId.slice('snapshot-'.length)}` ||
    manifest.vectorGenerationId !== route.vectorGenerationId ||
    manifest.vectorManifestHash !== route.vectorManifestHash ||
    !Array.isArray(manifest.activeRecipeIds) ||
    !manifest.activeRecipeIds.every((value) => typeof value === 'string') ||
    !Array.isArray(manifest.files)
  ) {
    fail('STRICT_PUBLICATION_CANDIDATE_MANIFEST_INVALID');
  }
}

function verifyDataFiles(
  acceptedRoot: string,
  dataRoot: string,
  manifest: Record<string, unknown>
): StrictPublicationDataFile[] {
  const files = (manifest.files as unknown[]).map((value) => {
    const row = asRecord(value);
    if (
      !row ||
      !readText(row.relativePath) ||
      !SHA_PATTERN.test(readText(row.byteHash) ?? '') ||
      !Number.isSafeInteger(row.size) ||
      (row.size as number) < 0
    ) {
      fail('STRICT_PUBLICATION_DATA_FILE_INVALID');
    }
    verifyExactKeys(
      row,
      ['relativePath', 'byteHash', 'size'],
      'STRICT_PUBLICATION_DATA_FILE_INVALID'
    );
    return {
      byteHash: row.byteHash as string,
      relativePath: row.relativePath as string,
      size: row.size as number,
    };
  });
  const sorted = [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  if (
    new Set(files.map((file) => file.relativePath)).size !== files.length ||
    canonicalJsonStringify(files) !== canonicalJsonStringify(sorted)
  ) {
    fail('STRICT_PUBLICATION_DATA_FILE_SET_INVALID');
  }
  for (const file of files) {
    const filePath = confinedChild(
      dataRoot,
      file.relativePath,
      'STRICT_PUBLICATION_DATA_FILE_PATH_INVALID'
    );
    assertRegularFile(acceptedRoot, filePath, 'STRICT_PUBLICATION_DATA_FILE_INVALID');
    const stat = statSync(filePath);
    if (stat.size !== file.size || hashFile(filePath) !== file.byteHash) {
      fail('STRICT_PUBLICATION_DATA_FILE_HASH_MISMATCH');
    }
  }
  return files;
}

function verifyFinalCoverage(
  finalCoverage: FinalCoverageBindingReceiptV1,
  candidateCoverage: Record<string, unknown>,
  candidateDataManifest: Record<string, unknown>
): void {
  let rebuilt: FinalCoverageBindingReceiptV1;
  try {
    rebuilt = createFinalCoverageBindingReceiptV1({
      candidateCoverage: candidateCoverage as never,
      candidateDataManifestHash: candidateDataManifest.manifestHash as string,
      cells: finalCoverage.cells,
      g4ReceiptHash: finalCoverage.g4ReceiptHash,
    });
  } catch {
    fail('STRICT_PUBLICATION_FINAL_COVERAGE_INVALID');
  }
  if (
    canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(finalCoverage) ||
    finalCoverage.cells.some(
      (cell) => cell.finalDisposition === 'failed' || cell.finalDisposition === 'unknown'
    )
  ) {
    fail('STRICT_PUBLICATION_FINAL_COVERAGE_INVALID');
  }
}

function verifyG4Receipt(
  receipt: Record<string, unknown>,
  finalCoverage: FinalCoverageBindingReceiptV1,
  candidateDataManifest: Record<string, unknown>
): void {
  verifyExactKeys(
    receipt,
    ['schemaVersion', 'gate', 'verdict', 'candidateDataManifestHash', 'g4ReceiptHash'],
    'STRICT_PUBLICATION_G4_RECEIPT_INVALID'
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.gate !== 'G4' ||
    receipt.verdict !== 'pass' ||
    receipt.candidateDataManifestHash !== candidateDataManifest.manifestHash ||
    receipt.g4ReceiptHash !== finalCoverage.g4ReceiptHash
  ) {
    fail('STRICT_PUBLICATION_G4_RECEIPT_INVALID');
  }
}

function verifyServingValidation(
  receipt: Record<string, unknown>,
  route: PublicKnowledgeRouteV1,
  finalCoverage: FinalCoverageBindingReceiptV1,
  candidateDataManifest: Record<string, unknown>
): void {
  verifySelfHash(receipt, 'receiptHash', 'STRICT_PUBLICATION_VALIDATION_RECEIPT_INVALID');
  const servingRecipeIds = finalCoverage.cells
    .flatMap((cell) => cell.finalRecipeIds)
    .sort((left, right) => left.localeCompare(right));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.verdict !== 'pass' ||
    receipt.failedPredicate !== null ||
    receipt.sessionId !== route.sessionId ||
    receipt.runId !== route.sessionId ||
    receipt.snapshotId !== route.snapshotId ||
    receipt.candidateDataManifestHash !== candidateDataManifest.manifestHash ||
    receipt.finalCoverageBindingHash !== finalCoverage.receiptHash ||
    receipt.vectorGenerationId !== route.vectorGenerationId ||
    receipt.vectorManifestHash !== route.vectorManifestHash ||
    receipt.certifiedProjectFactsHash !== route.certifiedProjectFactsHash ||
    receipt.sourceRevisionVectorHash !== route.sourceRevisionVectorHash ||
    receipt.analysisFixpointHash !== route.analysisFixpointHash ||
    canonicalJsonStringify(receipt.servingRecipeIds) !== canonicalJsonStringify(servingRecipeIds)
  ) {
    fail('STRICT_PUBLICATION_VALIDATION_RECEIPT_INVALID');
  }
}

function verifyServingManifest(
  manifest: ServingSnapshotManifestV1,
  route: PublicKnowledgeRouteV1,
  validation: Record<string, unknown>,
  finalCoverage: FinalCoverageBindingReceiptV1,
  candidateDataManifest: Record<string, unknown>
): void {
  let rebuilt: ServingSnapshotManifestV1;
  try {
    const { schemaVersion: _schemaVersion, manifestHash: _manifestHash, ...input } = manifest;
    rebuilt = createServingSnapshotManifestV1(input);
  } catch {
    fail('STRICT_PUBLICATION_SERVING_MANIFEST_INVALID');
  }
  if (
    canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(manifest) ||
    manifest.manifestHash !== route.servingSnapshotManifestHash ||
    manifest.snapshotId !== route.snapshotId ||
    manifest.sessionId !== route.sessionId ||
    manifest.candidateDataManifestHash !== candidateDataManifest.manifestHash ||
    manifest.finalCoverageBindingHash !== finalCoverage.receiptHash ||
    manifest.servingSnapshotValidationHash !== validation.receiptHash ||
    manifest.vectorGenerationId !== route.vectorGenerationId ||
    manifest.vectorManifestHash !== route.vectorManifestHash ||
    manifest.certifiedProjectFactsHash !== route.certifiedProjectFactsHash ||
    manifest.sourceRevisionVectorHash !== route.sourceRevisionVectorHash ||
    manifest.analysisFixpointHash !== route.analysisFixpointHash
  ) {
    fail('STRICT_PUBLICATION_SERVING_MANIFEST_INVALID');
  }
}

function verifyLineage(
  lineage: Record<string, unknown>,
  route: PublicKnowledgeRouteV1,
  validation: Record<string, unknown>,
  candidateDataManifest: Record<string, unknown>
): void {
  verifyExactKeys(
    lineage,
    [
      'schemaVersion',
      'sourceRevisionInitReceiptHash',
      'sourceRootManifestHash',
      'readyMemberSetHash',
      'sealedCorpusVerificationHash',
      'vectorGenerationId',
      'vectorManifestHash',
    ],
    'STRICT_PUBLICATION_LINEAGE_INVALID'
  );
  if (
    lineage.schemaVersion !== 1 ||
    lineage.sourceRevisionInitReceiptHash !== candidateDataManifest.sourceRevisionInitReceiptHash ||
    lineage.sourceRootManifestHash !== candidateDataManifest.sourceRootManifestHash ||
    lineage.readyMemberSetHash !== candidateDataManifest.readyMemberSetHash ||
    lineage.sealedCorpusVerificationHash !== validation.sealedCorpusVerificationHash ||
    lineage.vectorGenerationId !== route.vectorGenerationId ||
    lineage.vectorManifestHash !== route.vectorManifestHash
  ) {
    fail('STRICT_PUBLICATION_LINEAGE_INVALID');
  }
}

function verifyVectorPublication(
  acceptedRoot: string,
  dataRoot: string,
  route: PublicKnowledgeRouteV1,
  candidateDataManifest: Record<string, unknown>
): StrictVectorPublication {
  const active = readJson<Record<string, unknown>>(
    path.join(dataRoot, '.asd/context/recipe-vector-active.json'),
    'STRICT_PUBLICATION_VECTOR_ROUTE_INVALID'
  );
  verifyExactKeys(
    active,
    ['generationId', 'manifestHash'],
    'STRICT_PUBLICATION_VECTOR_ROUTE_INVALID'
  );
  if (
    active.generationId !== route.vectorGenerationId ||
    active.manifestHash !== route.vectorManifestHash
  ) {
    fail('STRICT_PUBLICATION_VECTOR_ROUTE_MISMATCH');
  }
  const generationRoot = confinedChild(
    path.join(dataRoot, '.asd/context/recipe-vector-generations'),
    route.vectorGenerationId,
    'STRICT_PUBLICATION_VECTOR_GENERATION_INVALID'
  );
  const manifest = readJson<VectorManifestRecord>(
    path.join(generationRoot, 'manifest.json'),
    'STRICT_PUBLICATION_VECTOR_MANIFEST_INVALID'
  );
  verifyVectorManifest(manifest, route, candidateDataManifest);
  const indexPath = path.join(generationRoot, 'store/.asd/context/index/vector_index.json');
  assertRegularFile(acceptedRoot, indexPath, 'STRICT_PUBLICATION_VECTOR_STORE_INVALID');
  const items = readJson<VectorItemRecord[]>(indexPath, 'STRICT_PUBLICATION_VECTOR_STORE_INVALID');
  verifyVectorItems(items, manifest);
  return {
    dimension: manifest.dimension,
    expectedIds: Object.freeze([...manifest.expectedIds]),
    formatProfile: manifest.formatProfile,
    generationId: manifest.generationId,
    indexPath,
    manifestHash: manifest.manifestHash,
    model: manifest.model,
    normalization: manifest.normalization,
    provider: manifest.provider,
  };
}

function verifyVectorManifest(
  manifest: VectorManifestRecord,
  route: PublicKnowledgeRouteV1,
  candidateDataManifest: Record<string, unknown>
): void {
  const identity = {
    manifestVersion: manifest.manifestVersion,
    projectionSchemaVersion: manifest.projectionSchemaVersion,
    vectorSchemaVersion: manifest.vectorSchemaVersion,
    provider: manifest.provider,
    model: manifest.model,
    dimension: manifest.dimension,
    formatProfile: manifest.formatProfile,
    normalization: manifest.normalization,
    corpusFingerprint: manifest.corpusFingerprint,
    corpusHash: manifest.corpusHash,
  };
  const identityHash = createHash('sha256').update(canonicalJsonStringify(identity)).digest('hex');
  const activeRecipeIds = candidateDataManifest.activeRecipeIds as string[];
  const flattenedExpectedIds = Object.keys(manifest.expectedIdsByRecipe)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((recipeId) => manifest.expectedIdsByRecipe[recipeId] ?? []);
  if (
    manifest.status !== 'ready' ||
    manifest.generationId !== route.vectorGenerationId ||
    manifest.manifestHash !== route.vectorManifestHash ||
    manifest.manifestHash !== identityHash ||
    manifest.dimension <= 0 ||
    !manifest.provider ||
    !manifest.model ||
    !Array.isArray(manifest.expectedIds) ||
    !isRecord(manifest.expectedIdsByRecipe) ||
    canonicalJsonStringify(Object.keys(manifest.expectedIdsByRecipe).sort()) !==
      canonicalJsonStringify([...activeRecipeIds].sort()) ||
    canonicalJsonStringify([...flattenedExpectedIds].sort()) !==
      canonicalJsonStringify([...manifest.expectedIds].sort()) ||
    manifest.documentCount !== manifest.expectedIds.length ||
    manifest.recipeCount !== activeRecipeIds.length ||
    manifest.corpusHash !== manifest.corpusFingerprint ||
    !DIGEST_PATTERN.test(manifest.manifestHash)
  ) {
    fail('STRICT_PUBLICATION_VECTOR_MANIFEST_INVALID');
  }
}

function verifyVectorItems(items: VectorItemRecord[], manifest: VectorManifestRecord): void {
  if (!Array.isArray(items)) {
    fail('STRICT_PUBLICATION_VECTOR_STORE_INVALID');
  }
  const ids = items.map((item) => item.id);
  if (
    new Set(ids).size !== ids.length ||
    canonicalJsonStringify([...ids].sort()) !==
      canonicalJsonStringify([...manifest.expectedIds].sort())
  ) {
    fail('STRICT_PUBLICATION_VECTOR_ID_SET_MISMATCH');
  }
  for (const item of items) {
    const metadata = asRecord(item.metadata);
    if (
      !readText(item.id) ||
      !readText(item.content) ||
      !Array.isArray(item.vector) ||
      item.vector.length !== manifest.dimension ||
      item.vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)) ||
      !metadata ||
      metadata.generationId !== manifest.generationId ||
      metadata.generationManifestHash !== manifest.manifestHash ||
      metadata.generationProvider !== manifest.provider ||
      metadata.generationModel !== manifest.model ||
      metadata.generationDimension !== manifest.dimension ||
      metadata.generationFormatProfile !== manifest.formatProfile ||
      metadata.generationNormalization !== manifest.normalization ||
      metadata.generationCorpusFingerprint !== manifest.corpusFingerprint
    ) {
      fail('STRICT_PUBLICATION_VECTOR_ITEM_INVALID');
    }
  }
}

function readCanonicalJson<T>(
  filePath: string,
  code: StrictPublicationErrorCode,
  newline: boolean
): T {
  const value = readJson<T>(filePath, code);
  // Public route CAS bytes are Core-canonical. The other Main artifacts are deliberately
  // byte-stable JSON records written in their producer field order with one trailing newline;
  // their semantic hashes are verified independently below.
  const expected = newline ? `${JSON.stringify(value)}\n` : canonicalJsonStringify(value);
  if (readFileSync(filePath, 'utf8') !== expected) {
    fail(code);
  }
  return value;
}

function readJson<T>(filePath: string, code: StrictPublicationErrorCode): T {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(code);
    }
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (value === null || typeof value !== 'object') {
      fail(code);
    }
    return value as T;
  } catch {
    fail(code);
  }
}

function verifySelfHash(
  record: Record<string, unknown>,
  key: string,
  code: StrictPublicationErrorCode
): void {
  const claimed = record[key];
  const { [key]: _claimed, ...semantic } = record;
  if (!SHA_PATTERN.test(readText(claimed) ?? '') || claimed !== hashCanonicalJson(semantic)) {
    fail(code);
  }
}

function verifyExactKeys(
  record: Record<string, unknown>,
  keys: string[],
  code: StrictPublicationErrorCode
): void {
  if (
    canonicalJsonStringify(Object.keys(record).sort()) !== canonicalJsonStringify([...keys].sort())
  ) {
    fail(code);
  }
}

function assertRegularDirectory(
  root: string,
  target: string,
  code: StrictPublicationErrorCode
): void {
  assertNoSymlinkTraversal(root, target);
  try {
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(code);
    }
  } catch {
    fail(code);
  }
}

function assertRegularFile(root: string, target: string, code: StrictPublicationErrorCode): void {
  assertNoSymlinkTraversal(root, target);
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(code);
    }
  } catch {
    fail(code);
  }
}

function assertNoSymlinkTraversal(root: string, target: string): void {
  const acceptedRoot = path.resolve(root);
  const acceptedTarget = path.resolve(target);
  if (acceptedTarget !== acceptedRoot && !acceptedTarget.startsWith(`${acceptedRoot}${path.sep}`)) {
    fail('STRICT_PUBLICATION_PATH_OUT_OF_SCOPE');
  }
  let cursor = acceptedRoot;
  try {
    if (lstatSync(cursor).isSymbolicLink()) {
      fail('STRICT_PUBLICATION_SYMLINK_FORBIDDEN');
    }
    for (const segment of path.relative(acceptedRoot, acceptedTarget).split(path.sep)) {
      if (!segment) {
        continue;
      }
      cursor = path.join(cursor, segment);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        fail('STRICT_PUBLICATION_SYMLINK_FORBIDDEN');
      }
    }
  } catch (error: unknown) {
    if (readErrorCode(error) === 'ENOENT') {
      fail('STRICT_PUBLICATION_ARTIFACT_MISSING');
    }
    throw error;
  }
}

function confinedChild(
  root: string,
  relativePath: string,
  code: StrictPublicationErrorCode
): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((segment) => segment === '' || segment === '..')
  ) {
    fail(code);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(code);
  }
  return resolved;
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error: unknown) {
    if (readErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function hashFile(filePath: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(filePath)).digest('hex')}`;
}

function legacyProvenance(): ProjectRuntimePublicationProvenance {
  return {
    mode: 'legacy',
    routeState: 'legacy',
    sessionId: null,
    snapshotId: null,
    vectorGenerationId: null,
    vectorManifestHash: null,
    sourceRevisionVectorHash: null,
    sourceRevisionMatch: 'unavailable',
  };
}

function strictUnavailableProvenance(): ProjectRuntimePublicationProvenance {
  return {
    mode: 'strict-v1',
    routeState: 'unavailable',
    sessionId: null,
    snapshotId: null,
    vectorGenerationId: null,
    vectorManifestHash: null,
    sourceRevisionVectorHash: null,
    sourceRevisionMatch: 'not-checked',
  };
}

function readyProvenance(route: PublicKnowledgeRouteV1): ProjectRuntimePublicationProvenance {
  return {
    mode: 'strict-v1',
    routeState: 'ready',
    sessionId: route.sessionId,
    snapshotId: route.snapshotId,
    vectorGenerationId: route.vectorGenerationId,
    vectorManifestHash: route.vectorManifestHash,
    sourceRevisionVectorHash: route.sourceRevisionVectorHash,
    sourceRevisionMatch: 'not-checked',
  };
}

function portableRelativeRoot(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  if (!normalized || normalized === '.') {
    return '.';
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    fail('STRICT_PUBLICATION_PROJECT_SCOPE_INVALID');
  }
  return normalized;
}

function opaqueId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/\s]+/gu, '-')
    .replace(/[^a-zA-Z0-9_.:-]/gu, '-');
  return normalized || 'project';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function requireText(value: unknown, field: string): string {
  const text = readText(value);
  if (!text) {
    throw new StrictPublicationError('STRICT_PUBLICATION_IDENTITY_INVALID', field);
  }
  return text;
}

function readErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function fail(code: StrictPublicationErrorCode): never {
  throw new StrictPublicationError(code);
}
