import fs from 'node:fs';
import path from 'node:path';
import {
  ProjectContext,
  type AnchorRangeContext,
  type FileFlowContext,
  type ModuleContext,
  type ModuleLayerContext,
  type ProjectContextEnvelope,
  type ProjectContextQueryError,
  type ProjectContextRef,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type ProjectMap,
  type RepoContext,
  type SpaceContext,
} from '@alembic/core/project-context';
import type {
  KnowledgeContextDiagnostic,
  KnowledgeContextDetailRef,
  KnowledgeContextNextAction,
  KnowledgeContextProjectNodeType,
  KnowledgeContextProjectRelationType,
  KnowledgeContextSource,
  ProjectGraphInput,
} from '../contracts/index.js';
import type { ContextIndexNode, ContextIndexSnapshotOptions } from '../layer/index.js';
import type { KnowledgeContextProjectionPayload } from '../layer/KnowledgeContextOutputProjector.js';
import { defaultRefRegistry, stableRefSegment } from '../support/index.js';
import { resolveProjectScopeSourceFolders } from './ProjectScopeFolders.js';

export interface ProjectGraphNode {
  detailRefId?: string;
  id: string;
  label: string;
  nodeType: KnowledgeContextProjectNodeType;
  path?: string;
}

export interface ProjectGraphRelation {
  detailRefId?: string;
  fromId: string;
  fromType?: KnowledgeContextProjectNodeType;
  relationType: KnowledgeContextProjectRelationType;
  toId: string;
  toType?: KnowledgeContextProjectNodeType;
}

export interface ProjectGraphResult {
  payload: KnowledgeContextProjectionPayload;
  projectNodes: ContextIndexNode[];
  snapshot: ContextIndexSnapshotOptions;
}

export interface ProjectGraphProvider {
  resolveProjectGraph(input: ProjectGraphInput): Promise<ProjectGraphResult>;
  resolveProjectRelations(projectRoot?: string): ProjectGraphRelation[];
}

interface GraphBuild {
  detailRefs: KnowledgeContextDetailRef[];
  diagnostics: KnowledgeContextDiagnostic[];
  nodes: ProjectGraphNode[];
  projectContext: ProjectGraphProjectContextTrace;
  projectRef: KnowledgeContextDetailRef;
  relations: ProjectGraphRelation[];
  sources: KnowledgeContextSource[];
}

interface ProjectGraphProjectContextTrace {
  errorCount: number;
  partial: boolean;
  refCount: number;
  requestKinds: ProjectContextRequestKind[];
}

interface FileCandidate {
  extension: string;
  relativePath: string;
}

interface ProjectWalkRoot {
  absolutePath: string;
  relativePrefix: string;
}

const ALLOWED_NODE_TYPES = [
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
] as const satisfies readonly KnowledgeContextProjectNodeType[];

const ALLOWED_RELATION_TYPES = [
  'partOf',
  'dependsOn',
  'imports',
  'exports',
  'definesSymbol',
  'referencesSymbol',
  'calls',
  'calledBy',
  'ownsFile',
  'entrypointFor',
] as const satisfies readonly KnowledgeContextProjectRelationType[];

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

const CODE_OR_CONFIG_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.css',
  '.html',
  '.json',
  '.md',
  '.toml',
  '.yaml',
  '.yml',
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.asd',
  '.git',
  '.turbo',
  '.workspace-active',
  '.workspace-local',
  'coverage',
  'dist',
  'node_modules',
  'runtime',
  'scratch',
  'tmp',
]);

const TOP_LEVEL_MODULE_NAMES = new Set([
  'bin',
  'config',
  'docs',
  'lib',
  'plugins',
  'scripts',
  'skills',
  'src',
  'test',
  'tests',
]);

const MAX_SCANNED_DIRECTORIES = 240;
const MAX_SCANNED_FILES = 420;
const MAX_SCANNED_SYMBOLS = 180;
const MAX_SCANNED_IMPORTS = 260;
const MAX_PACKAGE_DEPENDENCIES = 80;
const MAX_PROJECT_CONTEXT_DETAIL_REFS = 14;

interface ProjectContextGraphFacts {
  anchorRanges: AnchorRangeContext[];
  detailRefs: KnowledgeContextDetailRef[];
  diagnostics: KnowledgeContextDiagnostic[];
  fileFlows: FileFlowContext[];
  files: FileCandidate[];
  maps: ProjectMap[];
  moduleLayers: ModuleLayerContext[];
  modules: ModuleContext[];
  packageInfo?: PackageInfo;
  repos: RepoContext[];
  sources: KnowledgeContextSource[];
  trace: ProjectGraphProjectContextTrace;
}

export class FileSystemProjectGraphProvider implements ProjectGraphProvider {
  async resolveProjectGraph(input: ProjectGraphInput): Promise<ProjectGraphResult> {
    const projectRoot = input.projectRoot ?? process.cwd();
    const build = await this.buildGraph(projectRoot, input);
    const operation = input.operation ?? 'query';
    const selection = selectGraph(build, input);
    const summary = summarizeSelection(operation, selection, build.projectContext);
    const projectNodes = build.nodes.map(toContextIndexNode);
    const snapshot: ContextIndexSnapshotOptions = {
      domainFreshness: {
        project: fs.existsSync(projectRoot)
          ? { state: 'ready', sourceRef: build.projectRef.id }
          : {
              state: 'missing',
              degradedReason: `Project root does not exist: ${projectRoot}`,
              sourceRef: build.projectRef.id,
            },
      },
      projectNodes,
    };

    return {
      payload: {
        detailRefs: build.detailRefs,
        inventory: {
          allowedNodeTypes: [...ALLOWED_NODE_TYPES],
          allowedRelationTypes: [...ALLOWED_RELATION_TYPES],
          nodeCount: build.nodes.length,
          nodeTypes: countBy(build.nodes, (node) => node.nodeType),
          projectContext: build.projectContext,
          relationCount: build.relations.length,
          relationTypes: countBy(build.relations, (relation) => relation.relationType),
        },
        diagnostics: build.diagnostics,
        items: selection.items,
        matrixNodes: selection.matrixNodes,
        nextActions: nextActionsFor(operation, input),
        relations: selection.relations,
        result: selection.result,
        sources: build.sources,
        summary,
      },
      projectNodes,
      snapshot,
    };
  }

  resolveProjectRelations(projectRoot?: string): ProjectGraphRelation[] {
    const root = projectRoot ?? process.cwd();
    const projectRefId = `project:${stableRefSegment(root) || 'project'}`;
    const nodes = new NodeStore(projectRefId);
    const relations = new RelationStore();
    nodes.add({ id: projectRefId, label: path.basename(root) || 'project', nodeType: 'project' });
    const files = walkProject(root);
    addDirectoryAndFileNodes(nodes, relations, projectRefId, files);
    addImportAndSymbolEdges(root, files, nodes, relations);
    return relations.values();
  }

  private async buildGraph(projectRoot: string, input: ProjectGraphInput): Promise<GraphBuild> {
    const projectContextFacts = await buildProjectContextGraphFacts(projectRoot, input);
    const packageInfo = projectContextFacts.packageInfo ?? readPackageInfo(projectRoot);
    const projectName = packageInfo.name ?? path.basename(projectRoot) ?? 'project';
    const projectId = `project:${stableRefSegment(projectName) || 'project'}`;
    const projectRef = defaultRefRegistry.createDetailRef({
      domain: 'project',
      id: projectId,
      operation: 'project-graph',
      requiredForCompletion: true,
      summary:
        'Bounded ProjectContext graph derived from package metadata, directory structure, local import/export statements, and ProjectContext producer refs.',
      title: `Project graph: ${projectName}`,
      tool: 'alembic_graph',
      uri: projectRoot,
    });
    const nodes = new NodeStore(projectRef.id);
    const relations = new RelationStore();
    nodes.add({ id: projectId, label: projectName, nodeType: 'project', path: '.' });

    if (packageInfo.name) {
      const packageId = `package:${stableRefSegment(packageInfo.name)}`;
      nodes.add({
        id: packageId,
        label: packageInfo.name,
        nodeType: 'package',
        path: 'package.json',
      });
      relations.add(nodes, packageId, 'partOf', projectId);
      for (const depName of packageInfo.dependencies.slice(0, MAX_PACKAGE_DEPENDENCIES)) {
        const depId = `package:${stableRefSegment(depName)}`;
        nodes.add({ id: depId, label: depName, nodeType: 'package' });
        relations.add(nodes, packageId, 'dependsOn', depId);
      }
      for (const scriptName of packageInfo.scripts.slice(0, 40)) {
        const targetId = `target:script:${stableRefSegment(scriptName)}`;
        nodes.add({
          id: targetId,
          label: `script:${scriptName}`,
          nodeType: 'target',
          path: 'package.json',
        });
        relations.add(nodes, targetId, 'partOf', packageId);
      }
      for (const entryPath of packageInfo.entrypoints) {
        const fileId = fileNodeId(entryPath);
        nodes.add({
          id: fileId,
          label: path.basename(entryPath),
          nodeType: 'file',
          path: entryPath,
        });
        relations.add(nodes, fileId, 'entrypointFor', packageId);
      }
    }

    for (const repoContext of projectContextFacts.repos) {
      addRepoContextNodes(nodes, relations, projectId, repoContext);
    }
    for (const moduleContext of projectContextFacts.modules) {
      addModuleContextNodes(nodes, relations, projectId, moduleContext);
    }
    for (const layerContext of projectContextFacts.moduleLayers) {
      addModuleLayerContextNodes(nodes, relations, layerContext);
    }
    for (const mapContext of projectContextFacts.maps) {
      addProjectMapContextNodes(nodes, relations, projectId, mapContext);
    }

    const files =
      projectContextFacts.files.length > 0 ? projectContextFacts.files : walkProject(projectRoot);
    addDirectoryAndFileNodes(nodes, relations, projectId, files);
    addProjectContextFileFlowEdges(projectContextFacts.fileFlows, nodes, relations);
    addAnchorRangeContextNodes(projectContextFacts.anchorRanges, nodes, relations, projectId);

    return {
      detailRefs: dedupeDetailRefs([projectRef, ...projectContextFacts.detailRefs]).slice(
        0,
        MAX_PROJECT_CONTEXT_DETAIL_REFS
      ),
      diagnostics: projectContextFacts.diagnostics,
      nodes: nodes.values(),
      projectContext: projectContextFacts.trace,
      projectRef,
      relations: relations.values(),
      sources: [
        {
          domain: 'project',
          id: projectRef.id,
          detailRefId: projectRef.id,
          summary:
            'Project graph facts were derived from local project files and package metadata.',
        },
        ...projectContextFacts.sources,
      ],
    };
  }
}

async function buildProjectContextGraphFacts(
  projectRoot: string,
  input: ProjectGraphInput
): Promise<ProjectContextGraphFacts> {
  const facts: ProjectContextGraphFacts = {
    anchorRanges: [],
    detailRefs: [],
    diagnostics: [],
    fileFlows: [],
    files: [],
    maps: [],
    moduleLayers: [],
    modules: [],
    repos: [],
    sources: [],
    trace: {
      errorCount: 0,
      partial: false,
      refCount: 0,
      requestKinds: [],
    },
  };

  try {
    const spaceEnvelope = await executeGraphProjectContextRequest('space', projectRoot, {
      activeFile: input.activeFile,
      includeProjectTree: true,
      includeStructuralHotspots: true,
      maxTreeEntries: 80,
      sourceRefs: input.sourceRefs,
    });
    collectGraphEnvelope(facts, spaceEnvelope, 'project-context-space');
    const folders = isSpaceContext(spaceEnvelope.data)
      ? selectGraphRepoFolders(spaceEnvelope.data, projectRoot)
      : [{ repoId: undefined, repoName: projectNameFromRoot(projectRoot), sourceFolder: '.' }];

    for (const folder of folders.slice(0, 4)) {
      const repoEnvelope = await executeGraphProjectContextRequest(
        'repo',
        projectRoot,
        {
          includeCommands: true,
          includeEntrypoints: true,
          includeMapSummary: false,
          includeTopAreas: true,
          maxFiles: 240,
          repoName: folder.repoName,
          repoRoot: folder.sourceFolder,
        },
        { repoId: folder.repoId, sourceFolder: folder.sourceFolder }
      );
      collectGraphEnvelope(facts, repoEnvelope, 'project-context-repo');
      if (isRepoContext(repoEnvelope.data)) {
        facts.repos.push(repoEnvelope.data);
      }
    }

    facts.packageInfo = packageInfoFromRepoContexts(facts.repos);
    facts.files = walkProject(projectRoot);
    const moduleSeeds = createGraphModuleSeeds(facts.files);

    if (moduleSeeds.length > 0) {
      const mapEnvelope = await executeGraphProjectContextRequest('map', projectRoot, {
        includeCycles: true,
        includeExternalDeps: false,
        includeHotspots: true,
        includeMajorFlows: true,
        moduleSeeds: moduleSeeds.slice(0, 4),
        repoName: facts.packageInfo?.name ?? projectNameFromRoot(projectRoot),
      });
      collectGraphEnvelope(facts, mapEnvelope, 'project-context-map');
      if (isProjectMapContext(mapEnvelope.data)) {
        facts.maps.push(mapEnvelope.data);
      }
    }

    for (const seed of moduleSeeds.slice(0, 4)) {
      const moduleEnvelope = await executeGraphProjectContextRequest('module', projectRoot, {
        ...seed,
        includeDependencies: true,
        includePublicSurfaces: true,
      });
      collectGraphEnvelope(facts, moduleEnvelope, 'project-context-module');
      if (isModuleContext(moduleEnvelope.data)) {
        facts.modules.push(moduleEnvelope.data);
      }

      const layersEnvelope = await executeGraphProjectContextRequest('module-layers', projectRoot, {
        ...seed,
        includeBoundaryCrossings: true,
      });
      collectGraphEnvelope(facts, layersEnvelope, 'project-context-module-layers');
      if (isModuleLayerContext(layersEnvelope.data)) {
        facts.moduleLayers.push(layersEnvelope.data);
      }
    }

    const sourceFiles = facts.files
      .filter((file) => SOURCE_EXTENSIONS.has(file.extension))
      .slice(0, 90);
    for (const file of sourceFiles) {
      const flowEnvelope = await executeGraphProjectContextRequest('file-flow', projectRoot, {
        filePath: file.relativePath,
      });
      collectGraphEnvelope(facts, flowEnvelope, 'project-context-file-flow');
      if (isFileFlowContext(flowEnvelope.data)) {
        facts.fileFlows.push(flowEnvelope.data);
      }
    }

    const anchorFilePath = selectAnchorRangeFilePath(input, facts.files);
    if (anchorFilePath) {
      const anchorEnvelope = await executeGraphProjectContextRequest('anchor-range', projectRoot, {
        afterLines: 8,
        beforeLines: 8,
        filePath: anchorFilePath,
        includeContainingRefs: true,
        includeRelatedRefs: true,
        includeRelations: true,
        includeSourceSlices: true,
        includeSymbols: true,
        line: 1,
        relationHops: 1,
      });
      collectGraphEnvelope(facts, anchorEnvelope, 'project-context-anchor-range');
      if (isAnchorRangeContext(anchorEnvelope.data)) {
        facts.anchorRanges.push(anchorEnvelope.data);
      }
    }
  } catch (error) {
    facts.diagnostics.push({
      code: 'project-context-execution-failed',
      domain: 'project',
      message: `ProjectContext graph projection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      retryable: true,
      severity: 'warning',
    });
    facts.trace.errorCount += 1;
    facts.trace.partial = true;
  }

  facts.detailRefs = dedupeDetailRefs(facts.detailRefs);
  facts.diagnostics = dedupeDiagnostics(facts.diagnostics);
  facts.sources = dedupeSources(facts.sources);
  facts.trace.requestKinds = uniqueProjectContextKinds(facts.trace.requestKinds);
  return facts;
}

async function executeGraphProjectContextRequest(
  kind: ProjectContextRequestKind,
  projectRoot: string,
  payload: Record<string, unknown>,
  scope: { repoId?: string; sourceFolder?: string } = {}
): Promise<ProjectContextEnvelope<ProjectContextResult>> {
  return ProjectContext.execute({
    kind,
    payload,
    project: { projectRoot, source: 'alembic-plugin-mcp' },
    scope: {
      projectRoot,
      ...(scope.repoId === undefined ? {} : { repoId: scope.repoId }),
      ...(scope.sourceFolder === undefined ? {} : { sourceFolder: scope.sourceFolder }),
    },
  });
}

function collectGraphEnvelope(
  facts: ProjectContextGraphFacts,
  envelope: ProjectContextEnvelope<ProjectContextResult>,
  operation: string
) {
  facts.trace.requestKinds.push(envelope.queryLevel);
  facts.trace.errorCount += envelope.errors?.length ?? 0;
  facts.trace.partial = facts.trace.partial || Boolean(envelope.errors?.length);
  facts.trace.refCount += envelope.refs.length;
  facts.detailRefs.push(
    ...envelope.refs.map((ref) =>
      detailRefFromProjectContextRef(ref, 'alembic_graph', operation)
    )
  );
  facts.sources.push(
    ...envelope.refs.slice(0, 12).map((ref) => sourceFromProjectContextRef(ref, operation))
  );
  facts.diagnostics.push(
    ...(envelope.errors
      ?.filter((error) => error.severity === 'error')
      .map(projectContextErrorToDiagnostic) ?? [])
  );
}

function addRepoContextNodes(
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string,
  repo: RepoContext
) {
  const packageName = repo.localPackages[0]?.name ?? repo.repo.name;
  const packageId = `package:${stableRefSegment(packageName)}`;
  nodes.add({ id: packageId, label: packageName, nodeType: 'package', path: 'package.json' });
  relations.add(nodes, packageId, 'partOf', projectId);

  for (const command of repo.commands.slice(0, 40)) {
    const targetId = `target:script:${stableRefSegment(command.name)}`;
    nodes.add({ id: targetId, label: `script:${command.name}`, nodeType: 'target', path: 'package.json' });
    relations.add(nodes, targetId, 'partOf', packageId);
  }
  for (const target of repo.targets.slice(0, 40)) {
    const targetId = `target:${stableRefSegment(target.name)}`;
    nodes.add({ id: targetId, label: target.name, nodeType: 'target', path: 'package.json' });
    relations.add(nodes, targetId, 'partOf', packageId);
  }
  for (const entrypoint of repo.entrypoints) {
    for (const ref of entrypoint.refs) {
      const filePath = ref.scope.filePath;
      if (!filePath) {
        continue;
      }
      const fileId = fileNodeId(filePath);
      nodes.add({ id: fileId, label: path.posix.basename(filePath), nodeType: 'file', path: filePath });
      relations.add(nodes, fileId, 'entrypointFor', packageId);
    }
  }
  for (const area of [...repo.sourceRoots, ...repo.topAreas]) {
    const areaPath = normalizeRelativePath(area.path);
    if (!areaPath || areaPath === '.') {
      continue;
    }
    const moduleId = `module:${stableRefSegment(areaPath)}`;
    nodes.add({ id: moduleId, label: path.posix.basename(areaPath), nodeType: 'module', path: areaPath });
    relations.add(nodes, moduleId, 'partOf', projectId);
  }
}

function addModuleContextNodes(
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string,
  context: ModuleContext
) {
  const modulePath = normalizeRelativePath(
    context.module.ref?.scope.filePath ?? context.module.name
  );
  const moduleId = `module:${stableRefSegment(modulePath || context.module.name)}`;
  nodes.add({
    id: moduleId,
    label: context.module.name,
    nodeType: 'module',
    path: modulePath || undefined,
  });
  relations.add(nodes, moduleId, 'partOf', projectId);
  for (const file of context.ownedFiles) {
    const fileId = fileNodeId(file.filePath);
    nodes.add({ id: fileId, label: path.posix.basename(file.filePath), nodeType: 'file', path: file.filePath });
    relations.add(nodes, moduleId, 'ownsFile', fileId);
  }
  for (const symbol of context.publicSurfaces) {
    addSymbolNode(nodes, relations, symbol.filePath, symbol.name);
  }
  for (const relation of [...context.inflow, ...context.outflow]) {
    addProjectContextRelation(nodes, relations, relation);
  }
}

function addModuleLayerContextNodes(
  nodes: NodeStore,
  relations: RelationStore,
  context: ModuleLayerContext
) {
  const modulePath = normalizeRelativePath(
    context.module.ref?.scope.filePath ?? context.module.name
  );
  const moduleId = `module:${stableRefSegment(modulePath || context.module.name)}`;
  for (const group of context.fileGroups) {
    const groupId = `directory:${stableRefSegment(group.ref?.scope.filePath ?? `${context.module.name}/${group.name}`)}`;
    nodes.add({
      id: groupId,
      label: group.name,
      nodeType: 'directory',
      path: group.ref?.scope.filePath,
    });
    relations.add(nodes, groupId, 'partOf', moduleId);
    for (const file of group.files) {
      const fileId = fileNodeId(file.filePath);
      nodes.add({ id: fileId, label: path.posix.basename(file.filePath), nodeType: 'file', path: file.filePath });
      relations.add(nodes, groupId, 'ownsFile', fileId);
    }
  }
  for (const relation of context.boundaryCrossings) {
    addProjectContextRelation(nodes, relations, relation);
  }
}

function addProjectMapContextNodes(
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string,
  map: ProjectMap
) {
  for (const moduleRecord of map.modules) {
    const modulePath = normalizeRelativePath(
      moduleRecord.ref?.scope.filePath ?? moduleRecord.name
    );
    const moduleId = `module:${stableRefSegment(modulePath || moduleRecord.name)}`;
    nodes.add({
      id: moduleId,
      label: moduleRecord.name,
      nodeType: 'module',
      path: modulePath || undefined,
    });
    relations.add(nodes, moduleId, 'partOf', projectId);
  }
  for (const layer of map.layers) {
    const layerPath = normalizeRelativePath(layer.ref?.scope.filePath ?? layer.name);
    const layerId = `directory:${stableRefSegment(layerPath || layer.id)}`;
    nodes.add({
      id: layerId,
      label: layer.name,
      nodeType: 'directory',
      path: layerPath || undefined,
    });
    relations.add(nodes, layerId, 'partOf', projectId);
  }
}

function addProjectContextFileFlowEdges(
  flows: readonly FileFlowContext[],
  nodes: NodeStore,
  relations: RelationStore
) {
  for (const flow of flows) {
    const sourceFileId = fileNodeId(flow.file.filePath);
    nodes.add({
      id: sourceFileId,
      label: path.posix.basename(flow.file.filePath),
      nodeType: 'file',
      path: flow.file.filePath,
    });
    for (const importRelation of flow.imports) {
      const targetPath = importRelation.to?.filePath ?? importRelation.targetRef?.scope.filePath;
      if (!targetPath) {
        continue;
      }
      const targetFileId = fileNodeId(targetPath);
      nodes.add({
        id: targetFileId,
        label: path.posix.basename(targetPath),
        nodeType: 'file',
        path: targetPath,
      });
      relations.add(nodes, sourceFileId, 'imports', targetFileId);
    }
    for (const symbol of flow.exports) {
      addSymbolNode(nodes, relations, symbol.filePath, symbol.name);
    }
    for (const relation of [...flow.callees, ...flow.outflow]) {
      addProjectContextRelation(nodes, relations, relation);
    }
  }
}

function addAnchorRangeContextNodes(
  anchors: readonly AnchorRangeContext[],
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string
) {
  for (const anchor of anchors) {
    const fileId = fileNodeId(anchor.file.filePath);
    nodes.add({
      id: fileId,
      label: path.posix.basename(anchor.file.filePath),
      nodeType: 'file',
      path: anchor.file.filePath,
    });
    relations.add(nodes, fileId, 'partOf', projectId);
    for (const symbol of anchor.symbols) {
      addSymbolNode(nodes, relations, symbol.filePath, symbol.name);
    }
    for (const relation of anchor.relationSites) {
      addProjectContextRelation(nodes, relations, relation);
    }
  }
}

function addProjectContextRelation(
  nodes: NodeStore,
  relations: RelationStore,
  relation: {
    from?: { filePath?: string; symbol?: string; label?: string };
    kind: string;
    to?: { filePath?: string; symbol?: string; label?: string };
    filePath?: string;
  }
) {
  const relationType = projectContextRelationType(relation.kind);
  if (!relationType) {
    return;
  }
  const fromId = endpointNodeId(relation.from, relation.filePath);
  const toId = endpointNodeId(relation.to, relation.filePath);
  if (!fromId || !toId || fromId === toId) {
    return;
  }
  addEndpointNode(nodes, fromId, relation.from, relation.filePath);
  addEndpointNode(nodes, toId, relation.to, relation.filePath);
  relations.add(nodes, fromId, relationType, toId);
}

function addSymbolNode(
  nodes: NodeStore,
  relations: RelationStore,
  filePath: string,
  symbolName: string
) {
  const fileId = fileNodeId(filePath);
  const symbolId = `symbol:${stableRefSegment(`${filePath}#${symbolName}`)}`;
  nodes.add({ id: fileId, label: path.posix.basename(filePath), nodeType: 'file', path: filePath });
  nodes.add({ id: symbolId, label: symbolName, nodeType: 'symbol', path: filePath });
  relations.add(nodes, fileId, 'definesSymbol', symbolId);
  relations.add(nodes, fileId, 'exports', symbolId);
}

function addEndpointNode(
  nodes: NodeStore,
  id: string,
  endpoint: { filePath?: string; symbol?: string; label?: string } | undefined,
  fallbackFilePath?: string
) {
  if (id.startsWith('symbol:')) {
    nodes.add({
      id,
      label: endpoint?.symbol ?? endpoint?.label ?? id.replace(/^symbol:/, ''),
      nodeType: 'symbol',
      path: endpoint?.filePath ?? fallbackFilePath,
    });
    return;
  }
  const filePath = endpoint?.filePath ?? fallbackFilePath ?? id.replace(/^file:/, '');
  nodes.add({ id, label: path.posix.basename(filePath), nodeType: 'file', path: filePath });
}

function endpointNodeId(
  endpoint: { filePath?: string; symbol?: string; label?: string } | undefined,
  fallbackFilePath?: string
): string | undefined {
  const filePath = endpoint?.filePath ?? fallbackFilePath;
  if (endpoint?.symbol && filePath) {
    return `symbol:${stableRefSegment(`${filePath}#${endpoint.symbol}`)}`;
  }
  return filePath ? fileNodeId(filePath) : undefined;
}

function projectContextRelationType(
  kind: string
): KnowledgeContextProjectRelationType | undefined {
  if (isAllowedRelationType(kind)) {
    return kind;
  }
  if (kind === 'import') {
    return 'imports';
  }
  if (kind === 'export') {
    return 'exports';
  }
  return undefined;
}

function packageInfoFromRepoContexts(repos: readonly RepoContext[]): PackageInfo | undefined {
  if (repos.length === 0) {
    return undefined;
  }
  const localPackage = repos.flatMap((repo) => repo.localPackages)[0];
  return {
    dependencies: [],
    entrypoints: uniqueStrings(
      repos.flatMap((repo) =>
        repo.entrypoints.flatMap((entrypoint) =>
          entrypoint.refs.map((ref) => ref.scope.filePath).filter(isNonEmptyString)
        )
      )
    ),
    name: localPackage?.name ?? repos[0]?.repo.name,
    scripts: uniqueStrings(repos.flatMap((repo) => repo.commands.map((command) => command.name))),
  };
}

function createGraphModuleSeeds(files: readonly FileCandidate[]): Record<string, unknown>[] {
  const candidates = new Map<string, string[]>();
  for (const file of files.filter((item) => SOURCE_EXTENSIONS.has(item.extension))) {
    const topLevel = file.relativePath.split('/')[0];
    if (!TOP_LEVEL_MODULE_NAMES.has(topLevel)) {
      continue;
    }
    const existing = candidates.get(topLevel) ?? [];
    if (existing.length < 40) {
      existing.push(file.relativePath);
    }
    candidates.set(topLevel, existing);
  }
  return [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
    .map(([modulePath, ownedFiles]) => ({
      moduleName: path.posix.basename(modulePath),
      modulePath,
      ownedFiles,
    }));
}

function selectAnchorRangeFilePath(
  input: ProjectGraphInput,
  files: readonly FileCandidate[]
): string | undefined {
  if (input.activeFile) {
    return normalizeRelativePath(input.activeFile);
  }
  if (input.nodeId) {
    const file = files.find((candidate) => fileNodeId(candidate.relativePath) === input.nodeId);
    return file?.relativePath;
  }
  return undefined;
}

function selectGraphRepoFolders(space: SpaceContext, projectRoot: string) {
  if (space.sourceFolders.length === 0) {
    return [{ repoId: undefined, repoName: projectNameFromRoot(projectRoot), sourceFolder: '.' }];
  }
  return space.sourceFolders.map((folder) => ({
    repoId: folder.repositoryId ?? folder.id,
    repoName: folder.displayName ?? folder.repositoryId ?? folder.id,
    sourceFolder: normalizeRelativePath(folder.path || '.'),
  }));
}

function detailRefFromProjectContextRef(
  ref: ProjectContextRef,
  tool: 'alembic_graph',
  operation: string
): KnowledgeContextDetailRef {
  const relPath = ref.scope.filePath ?? ref.scope.sourceFolder ?? '.';
  return defaultRefRegistry.createDetailRef({
    domain: ref.kind === 'file' || ref.kind === 'path' || ref.kind === 'source-slice' ? 'document' : 'project',
    id: ref.id,
    operation,
    summary: `${ref.kind} ProjectContext ref ${ref.label ?? ref.id}.`,
    title: ref.label ?? ref.id,
    tool,
    uri: path.join(ref.scope.projectRoot, relPath),
  });
}

function sourceFromProjectContextRef(
  ref: ProjectContextRef,
  operation: string
): KnowledgeContextSource {
  return {
    domain: ref.kind === 'file' || ref.kind === 'path' || ref.kind === 'source-slice' ? 'document' : 'project',
    id: ref.id,
    summary: `${operation} ProjectContext ref ${ref.label ?? ref.id}.`,
    title: ref.label,
  };
}

function projectContextErrorToDiagnostic(error: ProjectContextQueryError): KnowledgeContextDiagnostic {
  return {
    code: `project-context-${error.code}`,
    domain: 'project',
    message: error.path ? `${error.message} (${error.path})` : error.message,
    retryable: error.retryable,
    severity: error.severity === 'error' ? 'warning' : error.severity,
  };
}

function isSpaceContext(value: ProjectContextResult): value is SpaceContext {
  return isRecord(value) && isRecord(value.space) && Array.isArray(value.sourceFolders);
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return isRecord(value) && isRecord(value.repo) && Array.isArray(value.entrypoints);
}

function isProjectMapContext(value: ProjectContextResult): value is ProjectMap {
  return isRecord(value) && Array.isArray(value.modules) && isRecord(value.dependencySummary);
}

function isModuleContext(value: ProjectContextResult): value is ModuleContext {
  return isRecord(value) && isRecord(value.module) && Array.isArray(value.ownedFiles);
}

function isModuleLayerContext(value: ProjectContextResult): value is ModuleLayerContext {
  return isRecord(value) && isRecord(value.module) && Array.isArray(value.fileGroups);
}

function isFileFlowContext(value: ProjectContextResult): value is FileFlowContext {
  return isRecord(value) && isRecord(value.file) && Array.isArray(value.imports);
}

function isAnchorRangeContext(value: ProjectContextResult): value is AnchorRangeContext {
  return isRecord(value) && isRecord(value.file) && isRecord(value.anchor);
}

class NodeStore {
  private readonly nodes = new Map<string, ProjectGraphNode>();

  constructor(private readonly detailRefId: string) {}

  add(node: Omit<ProjectGraphNode, 'detailRefId'>) {
    if (!isAllowedNodeType(node.nodeType) || this.nodes.has(node.id)) {
      return;
    }
    this.nodes.set(node.id, { ...node, detailRefId: this.detailRefId });
  }

  get(id: string): ProjectGraphNode | undefined {
    return this.nodes.get(id);
  }

  values(): ProjectGraphNode[] {
    return [...this.nodes.values()];
  }
}

class RelationStore {
  private readonly relations = new Map<string, ProjectGraphRelation>();

  add(
    nodes: NodeStore,
    fromId: string,
    relationType: KnowledgeContextProjectRelationType,
    toId: string
  ) {
    if (!isAllowedRelationType(relationType)) {
      return;
    }
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) {
      return;
    }
    const key = `${fromId}\u0000${relationType}\u0000${toId}`;
    if (!this.relations.has(key)) {
      this.relations.set(key, {
        detailRefId: from.detailRefId ?? to.detailRefId,
        fromId,
        fromType: from.nodeType,
        relationType,
        toId,
        toType: to.nodeType,
      });
    }
  }

  values(): ProjectGraphRelation[] {
    return [...this.relations.values()];
  }
}

interface PackageInfo {
  dependencies: string[];
  entrypoints: string[];
  name?: string;
  scripts: string[];
}

function readPackageInfo(projectRoot: string): PackageInfo {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { dependencies: [], entrypoints: [], scripts: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    const dependencies = [
      ...Object.keys(readRecord(parsed.dependencies)),
      ...Object.keys(readRecord(parsed.devDependencies)),
      ...Object.keys(readRecord(parsed.peerDependencies)),
      ...Object.keys(readRecord(parsed.optionalDependencies)),
    ].sort();
    return {
      dependencies,
      entrypoints: readEntrypoints(parsed),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      scripts: Object.keys(readRecord(parsed.scripts)).sort(),
    };
  } catch {
    return { dependencies: [], entrypoints: [], scripts: [] };
  }
}

function readEntrypoints(packageJson: Record<string, unknown>): string[] {
  const entrypoints = new Set<string>();
  for (const field of ['main', 'module', 'types', 'typings', 'bin']) {
    const value = packageJson[field];
    if (typeof value === 'string') {
      entrypoints.add(normalizeRelativePath(value));
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const item of Object.values(value)) {
        if (typeof item === 'string') {
          entrypoints.add(normalizeRelativePath(item));
        }
      }
    }
  }
  return [...entrypoints].filter((entry) => entry.length > 0);
}

function walkProject(projectRoot: string): FileCandidate[] {
  const files: FileCandidate[] = [];
  const roots = resolveProjectWalkRoots(projectRoot);
  let directoryCount = 0;
  for (const root of roots) {
    const stack = ['.'];
    while (stack.length > 0 && directoryCount < MAX_SCANNED_DIRECTORIES) {
      const relativeDirectory = stack.pop() ?? '.';
      const absoluteDirectory =
        relativeDirectory === '.'
          ? root.absolutePath
          : path.join(root.absolutePath, relativeDirectory);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
      } catch {
        continue;
      }
      directoryCount += 1;
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
            stack.push(normalizeRelativePath(path.join(relativeDirectory, entry.name)));
          }
          continue;
        }
        if (!entry.isFile() || files.length >= MAX_SCANNED_FILES) {
          continue;
        }
        const relativePath = normalizeWalkedPath(
          root.relativePrefix,
          relativeDirectory,
          entry.name
        );
        const extension = path.extname(entry.name);
        if (CODE_OR_CONFIG_EXTENSIONS.has(extension)) {
          files.push({ extension, relativePath });
        }
      }
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function resolveProjectWalkRoots(projectRoot: string): ProjectWalkRoot[] {
  const folders = resolveProjectScopeSourceFolders(projectRoot);
  if (folders.length === 0) {
    return [{ absolutePath: projectRoot, relativePrefix: '' }];
  }
  return folders.map((folder) => ({
    absolutePath: folder.absolutePath,
    relativePrefix: folder.relativePath,
  }));
}

function normalizeWalkedPath(prefix: string, relativeDirectory: string, fileName: string): string {
  return normalizeRelativePath(
    [prefix, relativeDirectory === '.' ? '' : relativeDirectory, fileName]
      .filter((segment) => segment.length > 0)
      .join('/')
  );
}

function addDirectoryAndFileNodes(
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string,
  files: FileCandidate[]
) {
  const directories = new Set<string>();
  for (const file of files) {
    const topLevel = file.relativePath.split('/')[0];
    if (TOP_LEVEL_MODULE_NAMES.has(topLevel)) {
      const moduleId = `module:${stableRefSegment(topLevel)}`;
      nodes.add({ id: moduleId, label: topLevel, nodeType: 'module', path: topLevel });
      relations.add(nodes, moduleId, 'partOf', projectId);
    }

    const directoryPath = path.posix.dirname(file.relativePath);
    if (directoryPath !== '.') {
      const segments = directoryPath.split('/');
      for (let index = 0; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index + 1).join('/'));
      }
    }
  }

  for (const directoryPath of [...directories].sort()) {
    const directoryId = directoryNodeId(directoryPath);
    nodes.add({
      id: directoryId,
      label: path.posix.basename(directoryPath),
      nodeType: 'directory',
      path: directoryPath,
    });
    const parentPath = path.posix.dirname(directoryPath);
    const parentId = parentPath === '.' ? projectId : directoryNodeId(parentPath);
    relations.add(nodes, directoryId, 'partOf', parentId);
  }

  for (const file of files) {
    const fileId = fileNodeId(file.relativePath);
    nodes.add({
      id: fileId,
      label: path.posix.basename(file.relativePath),
      nodeType: 'file',
      path: file.relativePath,
    });
    const directoryPath = path.posix.dirname(file.relativePath);
    const parentId = directoryPath === '.' ? projectId : directoryNodeId(directoryPath);
    relations.add(nodes, fileId, 'partOf', parentId);
    relations.add(nodes, parentId, 'ownsFile', fileId);
    const topLevel = file.relativePath.split('/')[0];
    if (TOP_LEVEL_MODULE_NAMES.has(topLevel)) {
      relations.add(nodes, `module:${stableRefSegment(topLevel)}`, 'ownsFile', fileId);
    }
  }
}

function addImportAndSymbolEdges(
  projectRoot: string,
  files: FileCandidate[],
  nodes: NodeStore,
  relations: RelationStore
) {
  const fileSet = new Set(files.map((file) => file.relativePath));
  let symbolCount = 0;
  let importCount = 0;
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(file.extension)) {
      continue;
    }
    const absolutePath = path.join(projectRoot, file.relativePath);
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf8').slice(0, 80_000);
    } catch {
      continue;
    }
    const sourceFileId = fileNodeId(file.relativePath);
    for (const exportName of extractExportedSymbols(content)) {
      if (symbolCount >= MAX_SCANNED_SYMBOLS) {
        break;
      }
      const symbolId = `symbol:${stableRefSegment(`${file.relativePath}#${exportName}`)}`;
      nodes.add({ id: symbolId, label: exportName, nodeType: 'symbol', path: file.relativePath });
      relations.add(nodes, sourceFileId, 'definesSymbol', symbolId);
      relations.add(nodes, sourceFileId, 'exports', symbolId);
      symbolCount += 1;
    }
    for (const specifier of extractImportSpecifiers(content)) {
      if (importCount >= MAX_SCANNED_IMPORTS) {
        break;
      }
      const resolved = resolveRelativeImport(file.relativePath, specifier, fileSet);
      if (!resolved) {
        continue;
      }
      relations.add(nodes, sourceFileId, 'imports', fileNodeId(resolved));
      importCount += 1;
    }
  }
}

function extractExportedSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const namedDeclaration =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = namedDeclaration.exec(content))) {
    symbols.add(match[1]);
  }
  const namedList = /\bexport\s*\{([^}]+)\}/g;
  while ((match = namedList.exec(content))) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        symbols.add(name);
      }
    }
  }
  return [...symbols].sort();
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:[^'"]+\s+from\s*)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort();
}

function resolveRelativeImport(
  sourceRelativePath: string,
  specifier: string,
  fileSet: Set<string>
): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const sourceDirectory = path.posix.dirname(sourceRelativePath);
  const base = normalizeRelativePath(
    path.posix.normalize(path.posix.join(sourceDirectory, specifier))
  );
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

interface GraphSelection {
  items: Record<string, unknown>[];
  matrixNodes: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  result: Record<string, unknown>;
}

function selectGraph(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  const operation = input.operation ?? 'query';
  switch (operation) {
    case 'stats':
      return selectStats(build, input);
    case 'path':
      return selectPath(build, input);
    case 'impact':
      return selectNeighborhood(build, input, 'impact');
    case 'neighborhood':
      return selectNeighborhood(build, input, 'neighborhood');
    default:
      return selectQuery(build, input);
  }
}

function selectQuery(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  if (isLowInformationGraphQuery(input) && !hasFocusedGraphQuery(input)) {
    return selectProjectOrientation(build, input);
  }
  const filteredRelations = filterRelations(build.relations, input);
  const itemLimit = input.budget?.itemLimit ?? 20;
  const relationLimit = input.budget?.relationHopLimit ?? 2;
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  const nodeMatches = build.nodes
    .map((node) => {
      if (input.nodeId && node.id !== input.nodeId) {
        return null;
      }
      if (input.nodeType && node.nodeType !== input.nodeType) {
        return null;
      }
      if (queryTerms.length === 0) {
        return { matchScore: 1, node, queryMatchedTerms: [] };
      }
      const text = `${node.id} ${node.label} ${node.path ?? ''}`.toLowerCase();
      const queryMatchedTerms = queryTerms.filter((term) => text.includes(term));
      if (queryMatchedTerms.length === 0) {
        return null;
      }
      return { matchScore: queryMatchedTerms.length, node, queryMatchedTerms };
    })
    .filter(
      (
        entry
      ): entry is { matchScore: number; node: ProjectGraphNode; queryMatchedTerms: string[] } =>
        entry !== null
    )
    .sort((a, b) => b.matchScore - a.matchScore || a.node.id.localeCompare(b.node.id));
  const nodeIds = new Set(nodeMatches.map((entry) => entry.node.id));
  const relations = filteredRelations
    .filter((relation) => {
      if (input.nodeId) {
        return relation.fromId === input.nodeId || relation.toId === input.nodeId;
      }
      return nodeIds.has(relation.fromId) || nodeIds.has(relation.toId);
    })
    .slice(0, Math.max(relationLimit * 20, 20));
  const items = nodeMatches.slice(0, itemLimit).map((entry) => ({
    ...projectNodeToOutput(entry.node),
    ...(entry.queryMatchedTerms.length > 0 ? { queryMatchedTerms: entry.queryMatchedTerms } : {}),
  }));
  return {
    items,
    matrixNodes: items,
    relations: relations.map(projectRelationToOutput),
    result: {
      graphKind: 'project-internal',
      projectContextPartial:
        build.projectContext.partial || (input.query !== undefined && items.length === 0),
      noMatchReason:
        input.query !== undefined && items.length === 0
          ? 'No bounded project graph nodes matched the focused query terms.'
          : undefined,
      operation: 'query',
      queryMatchMode: queryTerms.length > 0 ? 'term-overlap' : 'unfiltered',
      queryMatchedNodeCount: nodeMatches.length,
      sourceOfTruth: false,
    },
  };
}

function selectProjectOrientation(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  const itemLimit = input.budget?.itemLimit ?? 12;
  const relationLimit = input.budget?.relationHopLimit ?? 2;
  const preferredTypes = new Set<KnowledgeContextProjectNodeType>([
    'project',
    'package',
    'target',
    'module',
  ]);
  const preferredNodes = build.nodes
    .filter((node) => preferredTypes.has(node.nodeType))
    .sort((a, b) => orientationNodeWeight(a) - orientationNodeWeight(b) || a.id.localeCompare(b.id))
    .slice(0, itemLimit);
  const nodeIds = new Set(preferredNodes.map((node) => node.id));
  const relations = build.relations
    .filter((relation) => {
      if (!(nodeIds.has(relation.fromId) || nodeIds.has(relation.toId))) {
        return false;
      }
      return ['dependsOn', 'entrypointFor', 'ownsFile', 'partOf'].includes(relation.relationType);
    })
    .slice(0, Math.max(relationLimit * 12, 12));
  const items = preferredNodes.map(projectNodeToOutput);
  return {
    items,
    matrixNodes: items,
    relations: relations.map(projectRelationToOutput),
    result: {
      graphKind: 'project-internal',
      lowInformationIntent: true,
      operation: 'query',
      orientation: true,
      queryMatchMode: 'project-orientation',
      queryMatchedNodeCount: preferredNodes.length,
      projectContextRefRequiredForImpact: true,
      sourceOfTruth: false,
    },
  };
}

function orientationNodeWeight(node: ProjectGraphNode): number {
  switch (node.nodeType) {
    case 'project':
      return 0;
    case 'package':
      return node.path === 'package.json' ? 1 : 4;
    case 'target':
      return 2;
    case 'module':
      return 3;
    default:
      return 9;
  }
}

function selectStats(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  const relationLimit = input.budget?.relationHopLimit ?? 10;
  const items = build.nodes.slice(0, 20).map(projectNodeToOutput);
  return {
    items,
    matrixNodes: items,
    relations: build.relations.slice(0, relationLimit).map(projectRelationToOutput),
    result: {
      graphKind: 'project-internal',
      nodeCount: build.nodes.length,
      nodeTypes: countBy(build.nodes, (node) => node.nodeType),
      operation: 'stats',
      relationCount: build.relations.length,
      relationTypes: countBy(build.relations, (relation) => relation.relationType),
      sourceOfTruth: false,
    },
  };
}

function selectNeighborhood(
  build: GraphBuild,
  input: ProjectGraphInput,
  operation: 'impact' | 'neighborhood'
): GraphSelection {
  const nodeId = input.nodeId;
  if (!nodeId) {
    return missingNodeSelection(operation);
  }
  const maxDepth = input.maxDepth ?? 2;
  const traversed = traverse(
    build,
    nodeId,
    input.direction ?? 'both',
    maxDepth,
    input.relationType
  );
  const itemLimit = input.budget?.itemLimit ?? 20;
  const items = build.nodes
    .filter((node) => traversed.nodeIds.has(node.id))
    .slice(0, itemLimit)
    .map(projectNodeToOutput);
  return {
    items,
    matrixNodes: items,
    relations: traversed.relations.map(projectRelationToOutput),
    result: {
      depthReached: traversed.depthReached,
      graphKind: 'project-internal',
      nodeId,
      operation,
      sourceOfTruth: false,
      visitedNodeCount: traversed.nodeIds.size,
    },
  };
}

function selectPath(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  if (!input.fromId || !input.toId) {
    return {
      items: [],
      matrixNodes: [],
      relations: [],
      result: {
        found: false,
        graphKind: 'project-internal',
        missing: input.fromId ? 'toId' : 'fromId',
        operation: 'path',
        sourceOfTruth: false,
      },
    };
  }
  const pathResult = findPath(
    build,
    input.fromId,
    input.toId,
    input.maxDepth ?? 2,
    input.relationType
  );
  const nodeIds = new Set<string>();
  for (const relation of pathResult.path) {
    nodeIds.add(relation.fromId);
    nodeIds.add(relation.toId);
  }
  const items = build.nodes.filter((node) => nodeIds.has(node.id)).map(projectNodeToOutput);
  return {
    items,
    matrixNodes: items,
    relations: pathResult.path.map(projectRelationToOutput),
    result: {
      depth: pathResult.depth,
      found: pathResult.found,
      fromId: input.fromId,
      graphKind: 'project-internal',
      operation: 'path',
      sourceOfTruth: false,
      toId: input.toId,
    },
  };
}

function missingNodeSelection(operation: 'impact' | 'neighborhood'): GraphSelection {
  return {
    items: [],
    matrixNodes: [],
    relations: [],
    result: {
      graphKind: 'project-internal',
      impactUnavailableReason:
        'A concrete ProjectContext nodeId, detailRefId, file, symbol, or relation anchor is required before alembic_graph can make impact or neighborhood claims.',
      missing: 'nodeId',
      operation,
      projectContextRefRequiredForImpact: true,
      sourceOfTruth: false,
    },
  };
}

function filterRelations(
  relations: ProjectGraphRelation[],
  input: ProjectGraphInput
): ProjectGraphRelation[] {
  return relations.filter((relation) => {
    if (input.relationType && relation.relationType !== input.relationType) {
      return false;
    }
    if (input.direction === 'out' && input.nodeId && relation.fromId !== input.nodeId) {
      return false;
    }
    if (input.direction === 'in' && input.nodeId && relation.toId !== input.nodeId) {
      return false;
    }
    return true;
  });
}

function traverse(
  build: GraphBuild,
  startId: string,
  direction: 'out' | 'in' | 'both',
  maxDepth: number,
  relationType?: KnowledgeContextProjectRelationType
) {
  const relationLimit = 80;
  const visited = new Set([startId]);
  const queue: Array<{ depth: number; id: string }> = [{ depth: 0, id: startId }];
  const collected: ProjectGraphRelation[] = [];
  let depthReached = 0;
  while (queue.length > 0 && collected.length < relationLimit) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) {
      continue;
    }
    const nextRelations = build.relations.filter((relation) => {
      if (relationType && relation.relationType !== relationType) {
        return false;
      }
      return (
        (direction !== 'in' && relation.fromId === current.id) ||
        (direction !== 'out' && relation.toId === current.id)
      );
    });
    for (const relation of nextRelations) {
      collected.push(relation);
      const nextId = relation.fromId === current.id ? relation.toId : relation.fromId;
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ depth: current.depth + 1, id: nextId });
        depthReached = Math.max(depthReached, current.depth + 1);
      }
    }
  }
  return { depthReached, nodeIds: visited, relations: collected };
}

function findPath(
  build: GraphBuild,
  fromId: string,
  toId: string,
  maxDepth: number,
  relationType?: KnowledgeContextProjectRelationType
) {
  const queue: Array<{ id: string; path: ProjectGraphRelation[] }> = [{ id: fromId, path: [] }];
  const visited = new Set([fromId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.path.length >= maxDepth) {
      continue;
    }
    for (const relation of build.relations) {
      if (relationType && relation.relationType !== relationType) {
        continue;
      }
      if (relation.fromId !== current.id) {
        continue;
      }
      const nextPath = [...current.path, relation];
      if (relation.toId === toId) {
        return { depth: nextPath.length, found: true, path: nextPath };
      }
      if (!visited.has(relation.toId)) {
        visited.add(relation.toId);
        queue.push({ id: relation.toId, path: nextPath });
      }
    }
  }
  return { depth: -1, found: false, path: [] as ProjectGraphRelation[] };
}

function summarizeSelection(
  operation: string,
  selection: GraphSelection,
  projectContext: ProjectGraphProjectContextTrace
): string {
  const projectContextText =
    projectContext.partial || projectContext.errorCount > 0
      ? 'ProjectContext partial'
      : 'ProjectContext ready';
  return `alembic_graph ${operation} returned ${selection.items.length} project graph items and ${selection.relations.length} project graph relations (${projectContextText}).`;
}

function nextActionsFor(operation: string, input: ProjectGraphInput): KnowledgeContextNextAction[] {
  const actions: KnowledgeContextNextAction[] = [];
  if ((operation === 'impact' || operation === 'neighborhood') && !input.nodeId) {
    actions.push({
      tool: 'alembic_graph',
      operation: 'query',
      reason:
        'First query or inspect a concrete ProjectContext nodeId/detailRef; impact and neighborhood output is withheld without that anchor.',
      required: true,
    });
  }
  if (isLowInformationGraphQuery(input) && !hasFocusedGraphQuery(input)) {
    actions.push({
      tool: 'alembic_project_matrix',
      operation: 'overview',
      reason:
        'Use the project matrix overview to choose a module, entrypoint, file, symbol, or detailRef before asking for graph impact.',
      required: false,
    });
  }
  if (operation !== 'stats') {
    actions.push({
      tool: 'alembic_graph',
      operation: 'stats',
      reason:
        'Use stats to inspect available project node and relation types before a broader traversal.',
      required: false,
    });
  }
  return actions.slice(0, input.budget?.nextActionLimit ?? 5);
}

function projectNodeToOutput(node: ProjectGraphNode): Record<string, unknown> {
  return {
    detailRefId: node.detailRefId,
    id: node.id,
    label: node.label,
    nodeType: node.nodeType,
    ...(node.path === undefined ? {} : { path: node.path }),
  };
}

function projectRelationToOutput(relation: ProjectGraphRelation): Record<string, unknown> {
  return {
    detailRefId: relation.detailRefId,
    fromId: relation.fromId,
    fromType: relation.fromType,
    relationType: relation.relationType,
    toId: relation.toId,
    toType: relation.toType,
  };
}

function toContextIndexNode(node: ProjectGraphNode): ContextIndexNode {
  return {
    detailRefId: node.detailRefId,
    id: node.id,
    label: node.label,
    type: node.nodeType,
  };
}

function countBy<T>(values: T[], keyOf: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function tokenizeGraphQuery(query: string): string[] {
  return Array.from(
    new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [])
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && !GENERIC_GRAPH_QUERY_TERMS.has(term))
    )
  ).slice(0, 40);
}

const GENERIC_GRAPH_QUERY_TERMS = new Set(['alembic', 'graph', 'project', 'source']);

const LOW_INFORMATION_GRAPH_TERMS = new Set([
  'begin',
  'do',
  'help',
  'here',
  'how',
  'i',
  'me',
  'next',
  'now',
  'please',
  'should',
  'start',
  'started',
  'steps',
  'where',
  'what',
]);

const LOW_INFORMATION_GRAPH_QUERY_PATTERNS = [
  /^\s*where\s+do\s+i\s+start\s*[?.!]*\s*$/u,
  /^\s*(how|where)\s+(should\s+i\s+)?(start|begin|get\s+started)\s*[?.!]*\s*$/u,
  /^\s*(what\s+now|next\s+steps?|help)\s*[?.!]*\s*$/u,
  /^\s*(从哪里|哪里|怎么|如何)(开始|下手|继续)\s*[?？。!！]*\s*$/u,
];

function isLowInformationGraphQuery(input: ProjectGraphInput): boolean {
  const queryText = input.query?.toLowerCase().trim();
  if (!queryText) {
    return false;
  }
  if (LOW_INFORMATION_GRAPH_QUERY_PATTERNS.some((pattern) => pattern.test(queryText))) {
    return true;
  }
  const terms = queryText.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const meaningfulTerms = terms.filter(
    (term) => term.length >= 2 && !LOW_INFORMATION_GRAPH_TERMS.has(term)
  );
  return meaningfulTerms.length === 0 && queryText.length <= 100;
}

function hasFocusedGraphQuery(input: ProjectGraphInput): boolean {
  return Boolean(
    input.nodeId ||
      input.nodeType ||
      input.fromId ||
      input.toId ||
      input.relationType ||
      input.activeFile ||
      (input.sourceRefs?.length ?? 0) > 0 ||
      (input.sourceEvidenceRefs?.length ?? 0) > 0
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectNameFromRoot(projectRoot?: string): string {
  if (!projectRoot) {
    return 'Unknown project';
  }
  return path.basename(projectRoot) || projectRoot;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dedupeDetailRefs(refs: KnowledgeContextDetailRef[]): KnowledgeContextDetailRef[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

function dedupeSources(sources: KnowledgeContextSource[]): KnowledgeContextSource[] {
  return [...new Map(sources.map((source) => [source.id, source])).values()];
}

function dedupeDiagnostics(
  diagnostics: KnowledgeContextDiagnostic[]
): KnowledgeContextDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [`${diagnostic.code}\u0000${diagnostic.message}`, diagnostic])
    ).values(),
  ];
}

function uniqueProjectContextKinds(
  values: ProjectContextRequestKind[]
): ProjectContextRequestKind[] {
  return [...new Set(values)].sort();
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function directoryNodeId(relativePath: string): string {
  return `directory:${stableRefSegment(relativePath)}`;
}

function fileNodeId(relativePath: string): string {
  return `file:${stableRefSegment(relativePath)}`;
}

function isAllowedNodeType(value: string): value is KnowledgeContextProjectNodeType {
  return (ALLOWED_NODE_TYPES as readonly string[]).includes(value);
}

function isAllowedRelationType(value: string): value is KnowledgeContextProjectRelationType {
  return (ALLOWED_RELATION_TYPES as readonly string[]).includes(value);
}

export const defaultProjectGraphProvider = new FileSystemProjectGraphProvider();
