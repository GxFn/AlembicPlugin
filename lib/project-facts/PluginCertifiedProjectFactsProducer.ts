import fs from 'node:fs';
import path from 'node:path';
import {
  buildProjectContextRequestMatrixV2,
  buildProjectScopeManifestV1,
  captureCertifiedProjectFactsV2,
  createProjectContextRequestAuditPlansV2,
  FileCertifiedProjectFactsStore,
  hashCanonicalJson,
  NodeProjectContextFoundationHostPorts,
  type ProjectContextDependencyResolutionV1,
  type ProjectContextFoundationFileDescriptor,
  type ProjectContextFoundationHostPorts,
  type ProjectContextFoundationRepositoryInput,
  type ProjectContextInventoryPolicyV1,
  type ProjectContextRequestExecutionResult,
} from '@alembic/core/project-context-foundation';
import { resolveProjectScopeRuntime } from '../shared/project-scope-runtime.js';
import {
  createPluginCertifiedCarrier,
  failPluginStrictBypasses,
  type PluginCertifiedCarrier,
  pluginCertifiedStoreRoot,
} from './PluginCertifiedProjectFactsRuntime.js';

// Keep this producer aligned byte-for-byte with Core's accepted
// pcf-production-source-v1 policy. Plugin adds only nested-repository path
// exclusions derived from the already accepted ProjectScope manifest.
export const PLUGIN_CORE_ALIGNED_SOURCE_POLICY = {
  excludeDirectories: [
    '.build',
    '.git',
    '.swiftpm',
    '.wakeflow-active',
    '.wakeflow-local',
    'DerivedData',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'vendor',
    'xcuserdata',
  ],
  includeExtensions: [
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.dart',
    '.go',
    '.gradle',
    '.h',
    '.hpp',
    '.java',
    '.js',
    '.json',
    '.jsx',
    '.kt',
    '.kts',
    '.m',
    '.md',
    '.mm',
    '.mjs',
    '.pbxproj',
    '.plist',
    '.properties',
    '.py',
    '.rs',
    '.swift',
    '.toml',
    '.ts',
    '.tsx',
    '.xml',
    '.yaml',
    '.yml',
  ],
  version: 'pcf-production-source-v1',
} as const;

export interface PluginCertifiedCaptureResult {
  carrier: PluginCertifiedCarrier;
  repositoryTuples: Array<{ repoId: string; relativeRoot: string; revision: unknown }>;
  storeReceiptHash: string;
}

export async function capturePluginCertifiedProjectFacts(input: {
  dataRoot: string;
  projectRoot: string;
  signal?: AbortSignal;
}): Promise<PluginCertifiedCaptureResult> {
  const scope = createPluginScopeBinding(input.projectRoot);
  const inventoryPolicy = inventoryPolicyForScope(scope.repositories, input.dataRoot);
  const hostPorts = new NodeProjectContextFoundationHostPorts(undefined, {
    portableRoots: scope.repositories.map((repository) => ({
      portableId: repository.repoId,
      sourceRoot: repository.sourceRoot,
    })),
  });
  const ports = createPluginFoundationPorts(hostPorts);
  const inventoryRows: Array<{
    files: ProjectContextFoundationFileDescriptor[];
    repository: ProjectContextFoundationRepositoryInput;
  }> = [];
  for (const repository of scope.repositories) {
    inventoryRows.push({
      files: await ports.enumerateEligibleFiles({
        policy: inventoryPolicy,
        repository,
        signal: input.signal,
      }),
      repository,
    });
  }
  const plans = inventoryRows.flatMap(({ files, repository }) =>
    createProjectContextRequestAuditPlansV2({
      eligibleFiles: files,
      projectScopeManifest: scope.manifest,
      repository,
    })
  );
  const requestMatrix = buildProjectContextRequestMatrixV2(scope.manifest, plans);
  const selectedFiles = inventoryRows.flatMap(({ files, repository }) =>
    files.map((file) => ({ repoId: repository.repoId, relativePath: file.relativePath }))
  );
  const artifact = await captureCertifiedProjectFactsV2(
    {
      certification: {
        acceptedConfigHash: hashCanonicalJson({ inventoryPolicy }),
        acceptedRuntimeHash: hashCanonicalJson({
          adapter: 'alembic-plugin',
          foundation: 'strict-v2',
          version: 1,
        }),
        capabilityHash: hashCanonicalJson({
          consumers: [
            'plan',
            'recipe-generation',
            'dependency-graph',
            'module-coverage',
            'dimension-completion',
          ],
        }),
        parserHash: hashCanonicalJson({ authority: 'core-node-project-context-host-ports' }),
        scopeIdentityHash: scope.manifest.canonicalScopeHash,
      },
      detailPolicy: {
        chunkBytes: 4 * 1024 * 1024,
        maxPreviewBytes: 4096,
        maxSelectedFiles: Math.max(1, selectedFiles.length),
        selectedFiles,
      },
      inventoryPolicy,
      legacyEntries: [
        {
          directProjectContextCallCount: 0,
          entryId: 'plugin-plan-legacy-collector',
          entrypoint: 'lib/recipe-pipeline/plan/plan-tool.js',
          rawFilesystemFallbackCount: 0,
          reachability: 'unreachable',
          synthesizedProjectScopeFactCount: 0,
          typedReason: 'loaded strict Plan requests capture and reopen the Foundation artifact',
        },
        {
          directProjectContextCallCount: 0,
          entryId: 'plugin-generation-legacy-collector',
          entrypoint: 'lib/recipe-pipeline/generate/project-context-analysis.js',
          rawFilesystemFallbackCount: 0,
          reachability: 'unreachable',
          synthesizedProjectScopeFactCount: 0,
          typedReason: 'loaded strict generation reopens the persisted Plan carrier',
        },
      ],
      projectMode: scope.manifest.projectMode,
      projectScope: scope,
      projections: {} as never,
      repositories: scope.repositories,
      requestMatrix,
      requestPlans: requestMatrix.plans,
      signal: input.signal,
    },
    ports
  );
  if (artifact.readiness.verdict !== 'passed') {
    const unavailableRequests = artifact.facts.requestOutcomes
      .filter(
        (outcome) =>
          outcome.parserRuntime === 'unavailable' || outcome.queryInitialization === 'unavailable'
      )
      .map((outcome) => ({
        errors: outcome.errors,
        kind: outcome.kind,
        parserRuntime: outcome.parserRuntime,
        queryInitialization: outcome.queryInitialization,
        repoId: outcome.repoId,
        selector: outcome.selector,
      }));
    throw new TypeError(
      `Plugin Foundation capture failed strict readiness: ${artifact.readiness.errors.join(',')}; unavailable=${JSON.stringify(unavailableRequests)}`
    );
  }
  const store = new FileCertifiedProjectFactsStore(pluginCertifiedStoreRoot(input.dataRoot));
  const storeReceipt = await store.put(artifact);
  // One preparation belongs to the persisted carrier for its full consumer lineage.
  // Core creates it only after a verified immutable readback, so consumers can use
  // one public reopen each instead of reopening once to prepare and again to project.
  const preparation = await store.createPreparation(
    artifact.artifactId,
    artifact.certificationBindingHash
  );
  return {
    carrier: createPluginCertifiedCarrier(artifact, preparation),
    repositoryTuples: artifact.manifest.sourceRevisionVector.entries.map((entry) => ({
      repoId: entry.repoId,
      relativeRoot: entry.relativeRoot,
      revision: structuredClone(entry.revision),
    })),
    storeReceiptHash: storeReceipt.receiptHash,
  };
}

function createPluginFoundationPorts(
  hostPorts: NodeProjectContextFoundationHostPorts
): ProjectContextFoundationHostPorts {
  return {
    enumerateEligibleFiles: (input) => hostPorts.enumerateEligibleFiles(input),
    executeRequest: async (input) =>
      conserveDependencyEvidence(await hostPorts.executeRequest(input), {
        repoId: input.repository.repoId,
        requestKind: input.plan.kind,
      }),
    observeRevision: (input) => hostPorts.observeRevision(input),
    readFile: (input) => hostPorts.readFile(input),
    verifySnapshot: (input) => hostPorts.verifySnapshot(input),
  };
}

function conserveDependencyEvidence(
  result: ProjectContextRequestExecutionResult,
  request: {
    repoId: string;
    requestKind: ProjectContextDependencyResolutionV1['requestKind'];
  }
): ProjectContextRequestExecutionResult {
  const byIdentity = new Map<string, ProjectContextDependencyResolutionV1>();
  for (const resolution of result.dependencyResolutions ?? []) {
    byIdentity.set(hashCanonicalJson(resolution), resolution);
  }
  for (const diagnostic of result.errors ?? []) {
    const dependencyName = readExternalDependencyName(diagnostic.message);
    if (!dependencyName) {
      continue;
    }
    const resolution: ProjectContextDependencyResolutionV1 = {
      classification:
        diagnostic.classification === 'confirmed-defect' ? 'confirmed-defect' : 'expected-external',
      dependencyName,
      importerRepoId: request.repoId,
      requestKind: request.requestKind,
      typedReason:
        diagnostic.classification === 'confirmed-defect'
          ? diagnostic.typedReason
          : 'core-host-port-diagnostic-has-no-canonical-ownership-binding',
    };
    byIdentity.set(hashCanonicalJson(resolution), resolution);
  }
  const dependencyResolutions = [...byIdentity.values()].sort(
    (left, right) =>
      left.classification.localeCompare(right.classification) ||
      left.dependencyName.localeCompare(right.dependencyName) ||
      left.importerRepoId.localeCompare(right.importerRepoId)
  );
  if (dependencyResolutions.length === 0) {
    return result;
  }
  const namesFor = (...classifications: ProjectContextDependencyResolutionV1['classification'][]) =>
    [
      ...new Set(
        dependencyResolutions
          .filter((resolution) => classifications.includes(resolution.classification))
          .map((resolution) => resolution.dependencyName)
      ),
    ].sort();
  const internalResolvedDependencyNames = namesFor('internal-resolved');
  const approvedSiblingDependencyNames = namesFor('approved-sibling');
  const remainingExternalDependencyNames = namesFor('expected-external', 'confirmed-defect');
  const originalExternalDependencyNames = [
    ...new Set([
      ...internalResolvedDependencyNames,
      ...approvedSiblingDependencyNames,
      ...remainingExternalDependencyNames,
    ]),
  ].sort();
  return {
    ...result,
    dependencyResolutions,
    dependencyObservationCount: dependencyResolutions.length,
    dependencyGraphReconciliation: {
      approvedSiblingDependencyNames,
      approvedSiblingHotspotCount: approvedSiblingDependencyNames.length,
      internalResolvedDependencyNames,
      internalResolvedHotspotCount: internalResolvedDependencyNames.length,
      originalExternalDependencyNames,
      originalExternalHotspotCount: originalExternalDependencyNames.length,
      remainingExternalDependencyNames,
      remainingExternalHotspotCount: remainingExternalDependencyNames.length,
    },
  };
}

function readExternalDependencyName(message: string): string | null {
  const marker = 'map external dependency is not owned by module seeds:';
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const dependencyName = message.slice(markerIndex + marker.length).trim();
  return dependencyName || null;
}

function createPluginScopeBinding(projectRoot: string) {
  const nativeScope = resolveProjectScopeRuntime(projectRoot);
  if (!nativeScope) {
    failPluginStrictBypasses({
      bypasses: ['synthetic-project-scope'],
      entrypoint:
        'lib/project-facts/PluginCertifiedProjectFactsProducer.js#createPluginScopeBinding',
      message: `Loaded strict Plugin capture requires an accepted native ProjectScope: ${projectRoot}`,
    });
  }

  const controlRoot = fs.realpathSync.native(nativeScope.descriptor.controlRoot.path);
  const repositories = nativeScope.descriptor.folders
    .map((folder) => {
      if (!folder.repositoryId) {
        throw new TypeError(
          `Native ProjectScope folder lacks repositoryId: ${folder.displayName}.`
        );
      }
      const sourceRoot = fs.realpathSync.native(folder.path);
      const relativeRoot = portableRelativeRoot(path.relative(controlRoot, sourceRoot));
      if (relativeRoot.startsWith('../')) {
        throw new TypeError(`Native ProjectScope folder escapes controlRoot: ${folder.path}.`);
      }
      return { repoId: folder.repositoryId, relativeRoot, sourceRoot };
    })
    .sort(
      (left, right) =>
        left.relativeRoot.localeCompare(right.relativeRoot) ||
        left.repoId.localeCompare(right.repoId)
    );
  if (repositories.length === 0) {
    throw new TypeError('Native ProjectScope has no accepted source repositories.');
  }
  return buildProjectScopeManifestV1({
    acceptedScope: {
      projectIdentity: {
        projectId: nativeScope.descriptor.projectId,
        scopeId: nativeScope.descriptor.projectScopeId,
      },
      projectMode: 'plugin-native-project-scope',
      repositories: repositories.map(({ repoId, relativeRoot }) => ({ repoId, relativeRoot })),
    },
    controlRoot,
    sourceRoots: repositories.map(({ repoId, sourceRoot }) => ({ repoId, sourceRoot })),
  });
}

function inventoryPolicyForScope(
  repositories: readonly { relativeRoot: string; sourceRoot: string }[],
  dataRoot: string
): ProjectContextInventoryPolicyV1 {
  const excludeRelativePaths = [
    ...new Set([
      ...repositories.flatMap((parent) =>
        repositories.flatMap((child) => {
          if (parent === child) {
            return [];
          }
          if (parent.relativeRoot === '.') {
            return child.relativeRoot === '.' ? [] : [child.relativeRoot];
          }
          const prefix = `${parent.relativeRoot}/`;
          return child.relativeRoot.startsWith(prefix)
            ? [child.relativeRoot.slice(prefix.length)]
            : [];
        })
      ),
      ...repositories.flatMap((repository) => {
        const relativeDataRoot = portableRelativeRoot(
          path.relative(repository.sourceRoot, path.resolve(dataRoot))
        );
        return relativeDataRoot === '.' || relativeDataRoot.startsWith('../')
          ? []
          : [relativeDataRoot];
      }),
    ]),
  ].sort();
  return {
    excludeDirectories: [...PLUGIN_CORE_ALIGNED_SOURCE_POLICY.excludeDirectories],
    includeExtensions: [...PLUGIN_CORE_ALIGNED_SOURCE_POLICY.includeExtensions],
    version: PLUGIN_CORE_ALIGNED_SOURCE_POLICY.version,
    ...(excludeRelativePaths.length ? { excludeRelativePaths } : {}),
  };
}

function portableRelativeRoot(value: string): string {
  const portable = value.split(path.sep).join('/');
  return portable && portable !== '' ? portable : '.';
}
