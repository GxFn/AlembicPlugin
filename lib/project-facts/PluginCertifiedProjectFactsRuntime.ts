import path from 'node:path';
import type {
  ProjectContextEnvelope,
  ProjectContextRequestKind,
  ProjectContextResult,
} from '@alembic/core/project-context';
import {
  buildSourceRevisionVectorV1,
  type CertifiedProjectFactsArtifactV1,
  CertifiedProjectFactsConsumerPort,
  FileCertifiedProjectFactsStore,
  hashBytes,
  hashCanonicalJson,
  NodeProjectContextFoundationHostPorts,
  type ProjectContextConsumerProjectionReceiptV2,
  verifyProjectContextConsumerProjectionReceiptV2,
} from '@alembic/core/project-context-foundation';

const PLUGIN_ADAPTER_VERSION = 'alembic-plugin-pcf-adapters-v1';
const DIMENSION_COMPLETION_ENTRYPOINT = 'lib/recipe-pipeline/generate/dimension-completion.js';
const REQUIRED_UPSTREAM_CONSUMERS = [
  'plan',
  'recipe-generation',
  'dependency-graph',
  'module-coverage',
] as const;

export interface PluginCertifiedModule {
  id: string;
  name: string;
  ownedFiles: string[];
  repoId: string;
}

export interface PluginCertifiedFile {
  blobHash: string;
  byteLength: number;
  language: string;
  moduleIds: string[];
  relativePath: string;
  repositoryRelativeRoot: string;
  repoId: string;
}

export interface PluginCertifiedProjection {
  artifactId: string;
  canonicalScopeHash: string;
  consumer: 'plugin-read' | 'dimension-completion';
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  files: PluginCertifiedFile[];
  modules: PluginCertifiedModule[];
  requestKinds: ProjectContextRequestKind[];
  sourceVectorHash: string;
}

export interface PluginStrictCounters {
  cappedModuleProjectionCount: number;
  directProjectContextCallCount: number;
  emptyModuleAxisPassthroughCount: number;
  rawFilesystemFallbackCount: number;
  synthesizedProjectScopeFactCount: number;
}

export interface PluginCertifiedExtension {
  version: 1;
  counters: PluginStrictCounters;
  dimensionCompletionReceipt?: ProjectContextConsumerProjectionReceiptV2;
  knowledgeRescanApplicability: 'applicable';
  moduleAxisHash?: string;
}

export interface PluginCertifiedCarrier {
  artifactId: string;
  baseReadbackUnchanged: true;
  canonicalScopeHash: string;
  certificationBindingHash: string;
  factsContentHash: string;
  receipts: Record<string, ProjectContextConsumerProjectionReceiptV2 | undefined>;
  sourceVectorHash: string;
  plugin?: PluginCertifiedExtension;
  [key: string]: unknown;
}

export interface PluginCertifiedSessionPort {
  id: string;
  projectRoot: string;
  replaceProjectContext(projectContext: Record<string, unknown>): void;
  toSnapshot(): { projectContext: Record<string, unknown> };
}

export interface PluginCertifiedLiveProbe {
  artifactId: string;
  blockingReasons: string[];
  canonicalScopeHash: string;
  certifiedSourceVectorHash: string;
  comparisonStatus: 'matched' | 'mismatched';
  observedSourceVectorHash: string;
  repositories: Array<{ repoId: string; relativeRoot: string }>;
}

export function pluginCertifiedStoreRoot(dataRoot: string): string {
  return path.join(dataRoot, 'context', 'certified-project-facts', 'v2');
}

export function readPluginCertifiedCarrierFromProjectContext(
  projectContext: unknown
): PluginCertifiedCarrier | null {
  if (!projectContext || typeof projectContext !== 'object') {
    return null;
  }
  const carrier = (projectContext as Record<string, unknown>).certifiedProjectFacts;
  if (carrier === undefined) {
    return null;
  }
  assertPluginCertifiedCarrier(carrier);
  return carrier;
}

export function assertPluginCertifiedCarrier(
  value: unknown
): asserts value is PluginCertifiedCarrier {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Certified project facts carrier is missing.');
  }
  const carrier = value as PluginCertifiedCarrier;
  if (carrier.baseReadbackUnchanged !== true) {
    throw new TypeError('Certified project facts carrier is missing its base readback proof.');
  }
  for (const identity of [
    carrier.artifactId,
    carrier.sourceVectorHash,
    carrier.factsContentHash,
    carrier.certificationBindingHash,
    carrier.canonicalScopeHash,
  ]) {
    if (typeof identity !== 'string' || !identity) {
      throw new TypeError('Certified project facts carrier has a partial binding.');
    }
  }
  if (!carrier.receipts || typeof carrier.receipts !== 'object') {
    throw new TypeError('Certified project facts carrier receipt ledger is missing.');
  }
  for (const consumer of REQUIRED_UPSTREAM_CONSUMERS) {
    const receipt = carrier.receipts[consumer];
    if (!receipt) {
      throw new TypeError(`Certified project facts carrier is missing ${consumer} receipt.`);
    }
    assertReceiptBinding(carrier, receipt, consumer);
  }
  if (carrier.plugin) {
    assertPluginExtension(carrier, carrier.plugin);
  }
}

export async function openPluginCertifiedProjection(input: {
  carrier: PluginCertifiedCarrier;
  dataRoot: string;
}): Promise<PluginCertifiedProjection> {
  assertPluginCertifiedCarrier(input.carrier);
  const artifact = await new FileCertifiedProjectFactsStore(
    pluginCertifiedStoreRoot(input.dataRoot)
  ).open(input.carrier.artifactId as never, input.carrier.certificationBindingHash as never);
  assertArtifactBinding(input.carrier, artifact);
  const projection = projectPluginCertifiedFacts(artifact, 'plugin-read');
  assertFullModuleAxis(projection);
  return projection;
}

export async function observePluginCertifiedLiveProbe(input: {
  carrier: PluginCertifiedCarrier;
  controlRoot: string;
  dataRoot: string;
}): Promise<PluginCertifiedLiveProbe> {
  assertPluginCertifiedCarrier(input.carrier);
  const artifact = await new FileCertifiedProjectFactsStore(
    pluginCertifiedStoreRoot(input.dataRoot)
  ).open(input.carrier.artifactId as never, input.carrier.certificationBindingHash as never);
  assertArtifactBinding(input.carrier, artifact);
  const scope = artifact.manifest.projectScopeManifest;
  if (!scope) {
    throw new TypeError('Certified live probe is missing its ProjectScope manifest.');
  }
  const ports = new NodeProjectContextFoundationHostPorts(undefined, {
    portableRoots: scope.repositories.map((repository) => ({
      portableId: repository.repoId,
      sourceRoot: path.resolve(input.controlRoot, repository.relativeRoot),
    })),
  });
  const entries = [];
  const blockingReasons: string[] = [];
  for (const repository of scope.repositories) {
    const sourceRoot = path.resolve(input.controlRoot, repository.relativeRoot);
    const runtimeRepository = { ...repository, sourceRoot };
    const [observation, descriptors] = await Promise.all([
      ports.observeRevision({ repository: runtimeRepository }),
      ports.enumerateEligibleFiles({
        repository: runtimeRepository,
        policy: artifact.facts.inventory.includeExcludePolicy,
      }),
    ]);
    const files = [];
    for (const descriptor of descriptors) {
      const content = await ports.readFile({
        repository: runtimeRepository,
        relativePath: descriptor.relativePath,
      });
      files.push({
        repoId: repository.repoId,
        relativePath: descriptor.relativePath,
        language: descriptor.language.trim() || 'unknown',
        mode: descriptor.mode,
        sizeBytes: content.byteLength,
        blobSha256: hashBytes(content),
        ownerModuleIds: [...(descriptor.ownerModuleIds ?? [])].sort(),
        ...(descriptor.ownersV2 ? { ownersV2: structuredClone(descriptor.ownersV2) } : {}),
      });
    }
    const eligibleInventoryHash = hashCanonicalJson(files);
    const workingTreeContentHash = hashCanonicalJson(
      files.map((file) => [file.relativePath, file.mode, file.blobSha256])
    );
    const expected = artifact.manifest.sourceRevisionVector.entries.find(
      (entry) => entry.repoId === repository.repoId
    );
    const revision =
      observation.kind === 'git' && observation.dirty === false
        ? {
            kind: 'git-clean' as const,
            commitId: observation.commitId ?? '',
            treeId: observation.treeId ?? '',
          }
        : observation.kind === 'git'
          ? {
              kind: 'git-dirty' as const,
              commitId: observation.commitId,
              treeId: observation.treeId,
              workingTreeContentHash,
            }
          : { kind: 'content' as const, workingTreeContentHash };
    entries.push({
      scopeId: repository.scopeId,
      repoId: repository.repoId,
      relativeRoot: repository.relativeRoot,
      revision,
      eligibleInventoryHash,
      includeExcludePolicyHash: artifact.facts.inventory.includeExcludePolicyHash,
    });
    if (!expected || hashCanonicalJson(expected) !== hashCanonicalJson(entries.at(-1))) {
      blockingReasons.push(`repository-drift:${repository.repoId}`);
    }
  }
  const observed = buildSourceRevisionVectorV1(entries);
  if (observed.sourceVectorHash !== artifact.sourceVectorHash) {
    blockingReasons.push('source-vector-mismatch');
  }
  return {
    artifactId: artifact.artifactId,
    blockingReasons: [...new Set(blockingReasons)].sort(),
    canonicalScopeHash: scope.canonicalScopeHash,
    certifiedSourceVectorHash: artifact.sourceVectorHash,
    comparisonStatus:
      observed.sourceVectorHash === artifact.sourceVectorHash ? 'matched' : 'mismatched',
    observedSourceVectorHash: observed.sourceVectorHash,
    repositories: scope.repositories.map(({ repoId, relativeRoot }) => ({ repoId, relativeRoot })),
  };
}

export async function emitPluginDimensionCompletionReceipt(input: {
  carrier: PluginCertifiedCarrier;
  dataRoot: string;
  runId: string;
}): Promise<PluginCertifiedProjection> {
  assertPluginCertifiedCarrier(input.carrier);
  const store = new FileCertifiedProjectFactsStore(pluginCertifiedStoreRoot(input.dataRoot));
  const artifact = await store.open(
    input.carrier.artifactId as never,
    input.carrier.certificationBindingHash as never
  );
  assertArtifactBinding(input.carrier, artifact);
  const preparation = await store.createPreparation(
    artifact.artifactId,
    artifact.certificationBindingHash
  );
  const projected = await new CertifiedProjectFactsConsumerPort(store).reopenWithAdapter({
    adapter: {
      adapterVersion: PLUGIN_ADAPTER_VERSION,
      entrypoint: DIMENSION_COMPLETION_ENTRYPOINT,
      loadEvidenceHash: hashCanonicalJson({
        adapterVersion: PLUGIN_ADAPTER_VERSION,
        entrypoint: DIMENSION_COMPLETION_ENTRYPOINT,
        loaded: true,
      }),
      payloadSchemaHash: hashCanonicalJson({ consumer: 'dimension-completion', version: 1 }),
      project: (sealed) =>
        projectPluginCertifiedFacts(
          sealed as CertifiedProjectFactsArtifactV1,
          'dimension-completion'
        ),
    },
    consumer: 'dimension-completion',
    expectedCertificationBindingHash: artifact.certificationBindingHash,
    preparationId: preparation.preparationId,
    runId: opaqueRunId(input.runId),
  });
  const projection = projected.payload as unknown as PluginCertifiedProjection;
  assertFullModuleAxis(projection);
  assertReceiptBinding(input.carrier, projected.receipt, 'dimension-completion');
  await store.completeRunLease({
    expectedCertificationBindingHash: artifact.certificationBindingHash,
    preparationId: preparation.preparationId,
    runId: opaqueRunId(input.runId),
  });
  input.carrier.plugin = {
    version: 1,
    counters: zeroPluginStrictCounters(),
    dimensionCompletionReceipt: projected.receipt,
    knowledgeRescanApplicability: 'applicable',
    moduleAxisHash: hashCanonicalJson(projection.modules),
  };
  assertPluginCertifiedCarrier(input.carrier);
  return projection;
}

export function persistPluginCertifiedCarrier(input: {
  carrier: PluginCertifiedCarrier;
  projectRoot: string;
  session: PluginCertifiedSessionPort;
}): string {
  assertPluginCertifiedCarrier(input.carrier);
  if (path.resolve(input.session.projectRoot) !== path.resolve(input.projectRoot)) {
    throw new TypeError(
      'Certified project facts cannot move to a different Generate session root.'
    );
  }
  const snapshot = input.session.toSnapshot();
  const previous = readPluginCertifiedCarrierFromProjectContext(snapshot.projectContext);
  if (!previous || !samePluginCertifiedBinding(previous, input.carrier)) {
    throw new TypeError('Generate session has a stale certified project facts binding.');
  }
  input.session.replaceProjectContext({
    ...snapshot.projectContext,
    certifiedProjectFacts: structuredClone(input.carrier),
  });
  const persisted = readPluginCertifiedCarrierFromProjectContext(
    input.session.toSnapshot().projectContext
  );
  if (!persisted || hashCanonicalJson(persisted) !== hashCanonicalJson(input.carrier)) {
    throw new TypeError('Generate session did not persist the Plugin certified facts update.');
  }
  return input.session.id;
}

export function samePluginCertifiedBinding(
  left: PluginCertifiedCarrier,
  right: PluginCertifiedCarrier
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.sourceVectorHash === right.sourceVectorHash &&
    left.factsContentHash === right.factsContentHash &&
    left.certificationBindingHash === right.certificationBindingHash &&
    left.canonicalScopeHash === right.canonicalScopeHash
  );
}

export function projectPluginCertifiedFacts(
  artifact: CertifiedProjectFactsArtifactV1,
  consumer: PluginCertifiedProjection['consumer']
): PluginCertifiedProjection {
  const scope = artifact.manifest.projectScopeManifest;
  if (!scope) {
    throw new TypeError('Certified projection is missing its ProjectScope manifest.');
  }
  const relativeRoots = new Map(
    scope.repositories.map((repository) => [repository.repoId, repository.relativeRoot])
  );
  const files: PluginCertifiedFile[] = artifact.facts.inventory.files.map((file) => ({
    blobHash: file.blobSha256,
    byteLength: file.sizeBytes,
    language: file.language,
    moduleIds: [...file.ownerModuleIds].sort(),
    relativePath: file.relativePath,
    repositoryRelativeRoot: requireRepositoryRoot(relativeRoots, file.repoId),
    repoId: file.repoId,
  }));
  const modules = buildCertifiedModules(files);
  const envelopes = artifact.facts.requestOutcomes
    .filter(
      (outcome) => outcome.applicability === 'applicable' && outcome.terminalStatus === 'completed'
    )
    .map((outcome) => {
      if (!isProjectContextEnvelope(outcome.output)) {
        throw new TypeError(`Certified ${outcome.kind} outcome is not a ProjectContext envelope.`);
      }
      return outcome.output as unknown as ProjectContextEnvelope<ProjectContextResult>;
    });
  return {
    artifactId: artifact.artifactId,
    canonicalScopeHash: scope.canonicalScopeHash,
    consumer,
    envelopes,
    files,
    modules,
    requestKinds: [...new Set(artifact.facts.requestOutcomes.map((row) => row.kind))].sort(),
    sourceVectorHash: artifact.sourceVectorHash,
  };
}

export function assertExactRepositoryTuples(input: {
  artifact: CertifiedProjectFactsArtifactV1;
  observed: Array<{ repoId: string; relativeRoot: string; revision: unknown }>;
}): void {
  const expected = input.artifact.manifest.sourceRevisionVector.entries.map((entry) => ({
    repoId: entry.repoId,
    relativeRoot: entry.relativeRoot,
    revision: entry.revision,
  }));
  if (hashCanonicalJson(expected) !== hashCanonicalJson(input.observed)) {
    throw new TypeError('Live repository tuples do not match the certified scope receipt.');
  }
}

function assertPluginExtension(
  carrier: PluginCertifiedCarrier,
  extension: PluginCertifiedExtension
): void {
  if (
    extension.version !== 1 ||
    extension.knowledgeRescanApplicability !== 'applicable' ||
    !extension.counters ||
    Object.values(extension.counters).some((count) => count !== 0)
  ) {
    throw new TypeError('Plugin strict certified counters must remain zero.');
  }
  if (extension.dimensionCompletionReceipt) {
    assertReceiptBinding(carrier, extension.dimensionCompletionReceipt, 'dimension-completion');
    if (extension.dimensionCompletionReceipt.entrypoint !== DIMENSION_COMPLETION_ENTRYPOINT) {
      throw new TypeError(
        'Dimension completion receipt is not bound to the actual Plugin entrypoint.'
      );
    }
  }
}

function assertReceiptBinding(
  carrier: PluginCertifiedCarrier,
  receipt: ProjectContextConsumerProjectionReceiptV2,
  consumer: string
): void {
  verifyProjectContextConsumerProjectionReceiptV2(receipt);
  if (
    receipt.consumer !== consumer ||
    receipt.artifactId !== carrier.artifactId ||
    receipt.sourceVectorHash !== carrier.sourceVectorHash ||
    receipt.factsContentHash !== carrier.factsContentHash ||
    receipt.certificationBindingHash !== carrier.certificationBindingHash
  ) {
    throw new TypeError(`Certified project facts carrier has a stale ${consumer} binding.`);
  }
}

function assertArtifactBinding(
  carrier: PluginCertifiedCarrier,
  artifact: CertifiedProjectFactsArtifactV1
): void {
  if (
    artifact.artifactId !== carrier.artifactId ||
    artifact.sourceVectorHash !== carrier.sourceVectorHash ||
    artifact.factsContentHash !== carrier.factsContentHash ||
    artifact.certificationBindingHash !== carrier.certificationBindingHash ||
    artifact.manifest.projectScopeManifest?.canonicalScopeHash !== carrier.canonicalScopeHash
  ) {
    throw new TypeError('Certified artifact does not match the persisted Plugin carrier binding.');
  }
}

function buildCertifiedModules(files: readonly PluginCertifiedFile[]): PluginCertifiedModule[] {
  const rows = new Map<string, { files: Set<string>; repoId: string }>();
  for (const file of files) {
    if (file.moduleIds.length === 0) {
      throw new TypeError(
        `Certified source ${file.repoId}/${file.relativePath} has no module owner.`
      );
    }
    for (const moduleId of file.moduleIds) {
      const existing = rows.get(moduleId);
      if (existing && existing.repoId !== file.repoId) {
        throw new TypeError(`Certified module id is ambiguous across repositories: ${moduleId}.`);
      }
      const row = existing ?? { files: new Set<string>(), repoId: file.repoId };
      row.files.add(qualifiedPath(file));
      rows.set(moduleId, row);
    }
  }
  return [...rows.entries()]
    .map(([id, row]) => ({
      id,
      name: id.replace(/^module:/, '').replace(/^repo:/, ''),
      ownedFiles: [...row.files].sort(),
      repoId: row.repoId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function assertFullModuleAxis(projection: PluginCertifiedProjection): void {
  const expected = new Set(projection.files.flatMap((file) => file.moduleIds));
  if (expected.size === 0 || projection.modules.length !== expected.size) {
    throw new TypeError('Certified Plugin projection has an empty or capped module axis.');
  }
}

function qualifiedPath(file: PluginCertifiedFile): string {
  return file.repositoryRelativeRoot === '.'
    ? file.relativePath
    : path.posix.join(file.repositoryRelativeRoot, file.relativePath);
}

function requireRepositoryRoot(relativeRoots: Map<string, string>, repoId: string): string {
  const root = relativeRoots.get(repoId);
  if (root === undefined) {
    throw new TypeError(`Certified inventory repository is absent from ProjectScope: ${repoId}.`);
  }
  return root;
}

function isProjectContextEnvelope(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'queryLevel' in value && 'data' in value);
}

function opaqueRunId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]/g, '-');
  if (!normalized) {
    throw new TypeError('Certified consumer run id is missing.');
  }
  return normalized;
}

function zeroPluginStrictCounters(): PluginStrictCounters {
  return {
    cappedModuleProjectionCount: 0,
    directProjectContextCallCount: 0,
    emptyModuleAxisPassthroughCount: 0,
    rawFilesystemFallbackCount: 0,
    synthesizedProjectScopeFactCount: 0,
  };
}
