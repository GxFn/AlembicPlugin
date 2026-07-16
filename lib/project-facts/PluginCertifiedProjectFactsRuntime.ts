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
  type CertifiedProjectFactsPreparationReceiptV1,
  FileCertifiedProjectFactsStore,
  hashBytes,
  hashCanonicalJson,
  NodeProjectContextFoundationHostPorts,
  type ProjectContextConsumerProjectionReceiptV2,
  verifyProjectContextConsumerProjectionReceiptV2,
} from '@alembic/core/project-context-foundation';

const PLUGIN_ADAPTER_VERSION = 'alembic-plugin-pcf-adapters-v1';
export const PLUGIN_CERTIFIED_MODE = 'strict-v1' as const;
const DIMENSION_COMPLETION_ENTRYPOINT = 'lib/recipe-pipeline/generate/dimension-completion.js';
const REQUIRED_UPSTREAM_CONSUMERS = [
  'plan',
  'recipe-generation',
  'dependency-graph',
  'module-coverage',
] as const;
const PLUGIN_CERTIFIED_CONSUMERS = [
  ...REQUIRED_UPSTREAM_CONSUMERS,
  'dimension-completion',
] as const;

export const PLUGIN_CERTIFIED_ENTRYPOINTS = {
  plan: 'lib/recipe-pipeline/plan/plan-tool.js',
  'recipe-generation': 'lib/recipe-pipeline/generate/project-context-analysis.js',
  'dependency-graph': 'lib/host-runtime/mcp/handlers/structure.js',
  'module-coverage': 'lib/service/module/ModuleService.js',
  'dimension-completion': DIMENSION_COMPLETION_ENTRYPOINT,
} as const;

export type PluginCertifiedConsumer = (typeof PLUGIN_CERTIFIED_CONSUMERS)[number];

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
  consumer: 'plugin-read' | PluginCertifiedConsumer;
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
  instrumentation: PluginStrictInstrumentationEvent[];
  knowledgeRescanApplicability: 'applicable';
  moduleAxisHash?: string;
}

export type PluginStrictInstrumentationEvent =
  | {
      consumer: PluginCertifiedConsumer;
      entrypoint: string;
      kind: 'consumer-reopen';
      receiptHash: string;
    }
  | {
      emittedModuleCount: number;
      expectedOwnerModuleCount: number;
      kind: 'module-projection';
    }
  | {
      counter: keyof PluginStrictCounters;
      entrypoint: string;
      kind: 'strict-bypass';
    };

export interface PluginCertifiedCarrier {
  artifactId: string;
  baseReadbackUnchanged: true;
  canonicalScopeHash: string;
  certificationBindingHash: string;
  factsContentHash: string;
  preparationId: `prep-v1:${string}`;
  preparationReceiptHash: string;
  receipts: Partial<Record<PluginCertifiedConsumer, ProjectContextConsumerProjectionReceiptV2>>;
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
  receiptHash: string;
  repositories: Array<{ repoId: string; relativeRoot: string }>;
}

export function pluginCertifiedStoreRoot(dataRoot: string): string {
  return path.join(dataRoot, 'context', 'certified-project-facts', 'v2');
}

export function createPluginCertifiedCarrier(
  artifact: CertifiedProjectFactsArtifactV1,
  preparation: CertifiedProjectFactsPreparationReceiptV1
): PluginCertifiedCarrier {
  const scope = artifact.manifest.projectScopeManifest;
  if (!scope) {
    throw new TypeError('Plugin Foundation capture is missing its ProjectScope manifest.');
  }
  if (
    preparation.artifactId !== artifact.artifactId ||
    preparation.certificationBindingHash !== artifact.certificationBindingHash
  ) {
    throw new TypeError('Plugin Foundation preparation is stale for the captured artifact.');
  }
  const instrumentation: PluginStrictInstrumentationEvent[] = [];
  const carrier: PluginCertifiedCarrier = {
    artifactId: artifact.artifactId,
    baseReadbackUnchanged: true,
    canonicalScopeHash: scope.canonicalScopeHash,
    certificationBindingHash: artifact.certificationBindingHash,
    factsContentHash: artifact.factsContentHash,
    preparationId: preparation.preparationId,
    preparationReceiptHash: preparation.receiptHash,
    plugin: {
      version: 1,
      counters: summarizePluginStrictInstrumentation(instrumentation),
      instrumentation,
      knowledgeRescanApplicability: 'applicable',
    },
    receipts: {},
    sourceVectorHash: artifact.sourceVectorHash,
  };
  assertPluginCertifiedCarrier(carrier);
  return carrier;
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
    carrier.preparationId,
    carrier.preparationReceiptHash,
  ]) {
    if (typeof identity !== 'string' || !identity) {
      throw new TypeError('Certified project facts carrier has a partial binding.');
    }
  }
  if (!/^prep-v1:[0-9a-f-]{36}$/i.test(carrier.preparationId)) {
    throw new TypeError('Certified project facts carrier has an invalid preparation binding.');
  }
  if (!carrier.receipts || typeof carrier.receipts !== 'object') {
    throw new TypeError('Certified project facts carrier receipt ledger is missing.');
  }
  for (const consumer of PLUGIN_CERTIFIED_CONSUMERS) {
    const receipt = carrier.receipts[consumer];
    if (receipt) {
      assertReceiptBinding(carrier, receipt, consumer);
    }
  }
  if (carrier.plugin) {
    assertPluginExtension(carrier, carrier.plugin);
  }
}

export async function openPluginCertifiedProjection(input: {
  carrier: PluginCertifiedCarrier;
  dataRoot: string;
}): Promise<PluginCertifiedProjection> {
  return (await openPluginCertifiedFacts(input)).projection;
}

export async function openPluginCertifiedFacts(input: {
  carrier: PluginCertifiedCarrier;
  dataRoot: string;
}): Promise<{
  artifact: CertifiedProjectFactsArtifactV1;
  projection: PluginCertifiedProjection;
}> {
  assertPluginCertifiedCarrier(input.carrier);
  const artifact = await new FileCertifiedProjectFactsStore(
    pluginCertifiedStoreRoot(input.dataRoot)
  ).open(input.carrier.artifactId as never, input.carrier.certificationBindingHash as never);
  assertArtifactBinding(input.carrier, artifact);
  const projection = projectPluginCertifiedFacts(artifact, 'plugin-read');
  assertFullModuleAxis(projection);
  return { artifact, projection };
}

export async function observePluginCertifiedLiveProbe(input: {
  artifact?: CertifiedProjectFactsArtifactV1;
  carrier: PluginCertifiedCarrier;
  controlRoot: string;
  dataRoot: string;
}): Promise<PluginCertifiedLiveProbe> {
  assertPluginCertifiedCarrier(input.carrier);
  const artifact =
    input.artifact ??
    (await new FileCertifiedProjectFactsStore(pluginCertifiedStoreRoot(input.dataRoot)).open(
      input.carrier.artifactId as never,
      input.carrier.certificationBindingHash as never
    ));
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
  const rows = await Promise.all(
    scope.repositories.map(async (repository) => {
      const sourceRoot = path.resolve(input.controlRoot, repository.relativeRoot);
      const runtimeRepository = { ...repository, sourceRoot };
      const [observation, descriptors] = await Promise.all([
        ports.observeRevision({ repository: runtimeRepository }),
        ports.enumerateEligibleFiles({
          repository: runtimeRepository,
          policy: artifact.facts.inventory.includeExcludePolicy,
        }),
      ]);
      const files = await mapWithConcurrency(descriptors, 32, async (descriptor) => {
        const content = await ports.readFile({
          repository: runtimeRepository,
          relativePath: descriptor.relativePath,
        });
        return {
          repoId: repository.repoId,
          relativePath: descriptor.relativePath,
          language: descriptor.language.trim() || 'unknown',
          mode: descriptor.mode,
          sizeBytes: content.byteLength,
          blobSha256: hashBytes(content),
          ownerModuleIds: [...(descriptor.ownerModuleIds ?? [])].sort(),
          ...(descriptor.ownersV2 ? { ownersV2: structuredClone(descriptor.ownersV2) } : {}),
        };
      });
      const eligibleInventoryHash = hashCanonicalJson(files);
      const workingTreeContentHash = hashCanonicalJson(
        files.map((file) => [file.relativePath, file.mode, file.blobSha256])
      );
      const expected = artifact.manifest.sourceRevisionVector.entries.find(
        (candidate) => candidate.repoId === repository.repoId
      );
      const expectedRevision = expected?.revision;
      const revision =
        observation.kind === 'git' &&
        observation.dirty === false &&
        expectedRevision?.kind === 'git-dirty' &&
        expectedRevision.commitId === observation.commitId &&
        expectedRevision.treeId === observation.treeId &&
        expectedRevision.workingTreeContentHash === workingTreeContentHash
          ? // Core promotes a clean Git observation to content-bound dirty when
            // eligible ignored files are outside the declared Git tree. A live
            // probe must preserve that revision protocol instead of collapsing
            // the same bytes back to git-clean and reporting false drift.
            structuredClone(expectedRevision)
          : observation.kind === 'git' && observation.dirty === false
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
      const entry = {
        scopeId: repository.scopeId,
        repoId: repository.repoId,
        relativeRoot: repository.relativeRoot,
        revision,
        eligibleInventoryHash,
        includeExcludePolicyHash: artifact.facts.inventory.includeExcludePolicyHash,
      };
      return {
        blockingReasons:
          expected && hashCanonicalJson(expected) === hashCanonicalJson(entry)
            ? []
            : [`repository-drift:${repository.repoId}`],
        entry,
      };
    })
  );
  const entries = rows.map(({ entry }) => entry);
  const blockingReasons = rows.flatMap(({ blockingReasons: reasons }) => reasons);
  const observed = buildSourceRevisionVectorV1(entries);
  if (observed.sourceVectorHash !== artifact.sourceVectorHash) {
    blockingReasons.push('source-vector-mismatch');
  }
  const repositories = scope.repositories.map(({ repoId, relativeRoot }) => ({
    repoId,
    relativeRoot,
  }));
  const receiptHash = hashCanonicalJson({
    artifactId: artifact.artifactId,
    canonicalScopeHash: scope.canonicalScopeHash,
    observedSourceVectorHash: observed.sourceVectorHash,
    repositories,
  });
  return {
    artifactId: artifact.artifactId,
    blockingReasons: [...new Set(blockingReasons)].sort(),
    canonicalScopeHash: scope.canonicalScopeHash,
    certifiedSourceVectorHash: artifact.sourceVectorHash,
    comparisonStatus:
      observed.sourceVectorHash === artifact.sourceVectorHash ? 'matched' : 'mismatched',
    observedSourceVectorHash: observed.sourceVectorHash,
    receiptHash,
    repositories,
  };
}

export async function emitPluginDimensionCompletionReceipt(input: {
  carrier: PluginCertifiedCarrier;
  dataRoot: string;
  runId: string;
}): Promise<PluginCertifiedProjection> {
  for (const consumer of REQUIRED_UPSTREAM_CONSUMERS) {
    if (!input.carrier.receipts[consumer]) {
      throw new TypeError(
        `Dimension completion requires the persisted ${consumer} projection receipt.`
      );
    }
  }
  return (
    await reopenPluginCertifiedConsumer({
      carrier: input.carrier,
      consumer: 'dimension-completion',
      dataRoot: input.dataRoot,
      entrypoint: DIMENSION_COMPLETION_ENTRYPOINT,
      runId: input.runId,
    })
  ).projection;
}

export async function reopenPluginCertifiedConsumer(input: {
  carrier: PluginCertifiedCarrier;
  consumer: PluginCertifiedConsumer;
  dataRoot: string;
  entrypoint: string;
  runId: string;
}): Promise<{
  artifact: CertifiedProjectFactsArtifactV1;
  projection: PluginCertifiedProjection;
  receipt: ProjectContextConsumerProjectionReceiptV2;
}> {
  assertPluginCertifiedCarrier(input.carrier);
  if (input.entrypoint !== PLUGIN_CERTIFIED_ENTRYPOINTS[input.consumer]) {
    throw new TypeError(
      `Certified ${input.consumer} adapter must reopen at its actual Plugin entrypoint.`
    );
  }
  const store = new FileCertifiedProjectFactsStore(pluginCertifiedStoreRoot(input.dataRoot));
  const preparationId = input.carrier.preparationId;
  const runId = lineageRunId(input.carrier);
  const invocationId = opaqueRunId(input.runId);
  let reopenedArtifact: CertifiedProjectFactsArtifactV1 | undefined;
  const projected = await new CertifiedProjectFactsConsumerPort(store).reopenWithAdapter({
    adapter: {
      adapterVersion: PLUGIN_ADAPTER_VERSION,
      entrypoint: input.entrypoint,
      loadEvidenceHash: hashCanonicalJson({
        adapterVersion: PLUGIN_ADAPTER_VERSION,
        consumer: input.consumer,
        entrypoint: input.entrypoint,
        invocationId,
        loaded: true,
      }),
      payloadSchemaHash: hashCanonicalJson({ consumer: input.consumer, version: 1 }),
      project: (sealed) => {
        const artifact = sealed as CertifiedProjectFactsArtifactV1;
        reopenedArtifact = artifact;
        return projectPluginCertifiedFacts(artifact, input.consumer);
      },
    },
    consumer: input.consumer,
    expectedCertificationBindingHash: input.carrier.certificationBindingHash as never,
    preparationId,
    runId,
  });
  if (!reopenedArtifact) {
    throw new TypeError(`Certified ${input.consumer} adapter did not receive the sealed artifact.`);
  }
  const artifact = reopenedArtifact;
  assertArtifactBinding(input.carrier, artifact);
  const projection = projected.payload as unknown as PluginCertifiedProjection;
  assertFullModuleAxis(projection);
  assertReceiptBinding(input.carrier, projected.receipt, input.consumer);
  await store.completeRunLease({
    expectedCertificationBindingHash: artifact.certificationBindingHash,
    preparationId,
    runId,
  });
  input.carrier.receipts[input.consumer] = projected.receipt;
  const extension = input.carrier.plugin ?? {
    version: 1 as const,
    counters: summarizePluginStrictInstrumentation([]),
    instrumentation: [],
    knowledgeRescanApplicability: 'applicable' as const,
  };
  extension.instrumentation = extension.instrumentation.filter(
    (event) =>
      !(event.kind === 'consumer-reopen' && event.consumer === input.consumer) &&
      event.kind !== 'module-projection'
  );
  extension.instrumentation.push(
    {
      consumer: input.consumer,
      entrypoint: input.entrypoint,
      kind: 'consumer-reopen',
      receiptHash: projected.receipt.receiptHash,
    },
    {
      emittedModuleCount: projection.modules.length,
      expectedOwnerModuleCount: expectedOwnerModuleCount(projection.files),
      kind: 'module-projection',
    }
  );
  extension.counters = summarizePluginStrictInstrumentation(extension.instrumentation);
  extension.moduleAxisHash = hashCanonicalJson(projection.modules);
  if (input.consumer === 'dimension-completion') {
    extension.dimensionCompletionReceipt = projected.receipt;
  }
  input.carrier.plugin = extension;
  assertPluginCertifiedCarrier(input.carrier);
  return { artifact, projection, receipt: projected.receipt };
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
    left.canonicalScopeHash === right.canonicalScopeHash &&
    left.preparationId === right.preparationId &&
    left.preparationReceiptHash === right.preparationReceiptHash
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
    moduleIds: file.ownerModuleIds.map((moduleId) => qualifyModuleId(file.repoId, moduleId)).sort(),
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
    !Array.isArray(extension.instrumentation) ||
    hashCanonicalJson(extension.counters) !==
      hashCanonicalJson(summarizePluginStrictInstrumentation(extension.instrumentation))
  ) {
    throw new TypeError('Plugin strict certified counters do not match observed instrumentation.');
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
      continue;
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
      name: localModuleId(id)
        .replace(/^module:/, '')
        .replace(/^repo:/, ''),
      ownedFiles: [...row.files].sort(),
      repoId: row.repoId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function qualifyModuleId(repoId: string, moduleId: string): string {
  return `${repoId}::${moduleId}`;
}

function localModuleId(qualifiedModuleId: string): string {
  const separator = qualifiedModuleId.indexOf('::');
  return separator < 0 ? qualifiedModuleId : qualifiedModuleId.slice(separator + 2);
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

function lineageRunId(carrier: PluginCertifiedCarrier): string {
  return opaqueRunId(`plugin-lineage-${carrier.preparationId}`);
}

export function summarizePluginStrictInstrumentation(
  events: readonly PluginStrictInstrumentationEvent[]
): PluginStrictCounters {
  const counters: PluginStrictCounters = {
    cappedModuleProjectionCount: 0,
    directProjectContextCallCount: 0,
    emptyModuleAxisPassthroughCount: 0,
    rawFilesystemFallbackCount: 0,
    synthesizedProjectScopeFactCount: 0,
  };
  for (const event of events) {
    if (event.kind === 'strict-bypass') {
      counters[event.counter] += 1;
    } else if (event.kind === 'module-projection') {
      if (event.emittedModuleCount < event.expectedOwnerModuleCount) {
        counters.cappedModuleProjectionCount += 1;
      }
      if (event.expectedOwnerModuleCount > 0 && event.emittedModuleCount === 0) {
        counters.emptyModuleAxisPassthroughCount += 1;
      }
    }
  }
  return counters;
}

function expectedOwnerModuleCount(files: readonly PluginCertifiedFile[]): number {
  return new Set(files.flatMap((file) => file.moduleIds)).size;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}
