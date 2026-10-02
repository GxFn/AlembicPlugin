import fs from 'node:fs';
import path from 'node:path';
import {
  type CodeGraphProjectContextRuntime,
  type ProjectContextContract,
  withCodeGraphProjectContextSession,
} from '@alembic/core/project-context';
import {
  buildProjectContextRequestMatrixV2,
  buildProjectScopeManifestV1,
  captureCertifiedProjectFactsV2,
  createProjectContextRequestAuditPlansV2,
  FileCertifiedProjectFactsStore,
  hashCanonicalJson,
  NodeProjectContextFoundationHostPorts,
  type ProjectContextFoundationFileDescriptor,
  type ProjectContextFoundationRepositoryInput,
  type ProjectContextInventoryPolicyV1,
} from '@alembic/core/project-context-foundation';
import { resolveProjectScopeRuntime } from '../shared/project-scope-runtime.js';
import {
  createPluginCertifiedCarrier,
  failPluginStrictBypasses,
  PLUGIN_PRIVATE_INPUT_POLICY_VERSION,
  type PluginCertifiedCarrier,
  pluginCertifiedPrivateDirectories,
  pluginCertifiedStoreRoot,
} from './PluginCertifiedProjectFactsRuntime.js';

// 基础扩展名与目录名沿用Core的pcf-production-source-v1；宿主私有路径和多仓边界
// 在inventoryPolicyForScope中补齐，并以独立版本绑定目录发现/Git状态的新语义。
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
  input.signal?.throwIfAborted();
  // 先验证真实来源目录；SDK 私有目录创建不能把缺失 sourceRoot 变成合法范围。
  const scope = createPluginScopeBinding(input.projectRoot);
  // 固定私有目录在捕获前创建；产物写入不得新增已被捕获的祖先目录项。
  const privateDirectories = pluginCertifiedPrivateDirectories(path.resolve(input.dataRoot)).map(
    (directory) => {
      fs.mkdirSync(directory, { recursive: true });
      return fs.realpathSync.native(directory);
    }
  );
  return withCodeGraphProjectContextSession(
    { dataRoot: input.dataRoot, privateDirectories, signal: input.signal },
    (projectContext, runtime) =>
      capturePluginFactsInSession(input, scope, projectContext, runtime, privateDirectories)
  );
}

async function capturePluginFactsInSession(
  input: Parameters<typeof capturePluginCertifiedProjectFacts>[0],
  scope: ReturnType<typeof createPluginScopeBinding>,
  projectContext: ProjectContextContract,
  runtime: CodeGraphProjectContextRuntime,
  privateDirectories: readonly string[]
): Promise<PluginCertifiedCaptureResult> {
  const inventoryPolicy = inventoryPolicyForScope(scope.repositories, [
    input.dataRoot,
    runtime.runtimeRoot,
    ...privateDirectories,
  ]);
  // 依赖观测与决议的配平由 Core 的端口自己完成（没有归属目录时按名字归类并出决议），
  // 宿主不再包一层去补造决议。
  const ports = new NodeProjectContextFoundationHostPorts(projectContext, {
    privateDirectories,
    portableRoots: scope.repositories.map((repository) => ({
      portableId: repository.repoId,
      sourceRoot: repository.sourceRoot,
    })),
  });
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
        parserHash: runtime.engineHash,
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
  input.signal?.throwIfAborted();
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
  privateRoots: readonly string[]
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
      // 固定 runtime 父目录参与策略；随机会话目录不进入可复核 hash。
      ...repositories.flatMap((repository) =>
        privateRoots.flatMap((privateRoot) => {
          const relativePrivateRoot = portableRelativeRoot(
            path.relative(repository.sourceRoot, fs.realpathSync.native(privateRoot))
          );
          return relativePrivateRoot === '.' ||
            relativePrivateRoot === '..' ||
            relativePrivateRoot.startsWith('../')
            ? []
            : [relativePrivateRoot];
        })
      ),
    ]),
  ].sort();
  return {
    excludeDirectories: [...PLUGIN_CORE_ALIGNED_SOURCE_POLICY.excludeDirectories],
    includeExtensions: [...PLUGIN_CORE_ALIGNED_SOURCE_POLICY.includeExtensions],
    version: PLUGIN_PRIVATE_INPUT_POLICY_VERSION,
    ...(excludeRelativePaths.length ? { excludeRelativePaths } : {}),
  };
}

function portableRelativeRoot(value: string): string {
  const portable = value.split(path.sep).join('/');
  return portable && portable !== '' ? portable : '.';
}
