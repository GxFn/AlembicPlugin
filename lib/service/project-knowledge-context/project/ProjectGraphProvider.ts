import fs from 'node:fs';
import path from 'node:path';
import {
  type AnchorRangeContext,
  type FileFlowContext,
  type FileSymbolContext,
  type ModuleContext,
  type ModuleLayerContext,
  ProjectContext,
  type ProjectContextEnvelope,
  type ProjectContextQueryError,
  type ProjectContextRef,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type ProjectMap,
  type RepoContext,
  type SourceSliceContext,
  type SpaceContext,
} from '@alembic/core/project-context';
import type {
  AlembicGraphOutput,
  AlembicGraphQueryKind,
  AlembicGraphStatus,
  GraphDiagnostic,
  GraphNextAction,
  GraphNodeSummary,
  GraphRelationSummary,
  GraphSourceSliceSummary,
  KnowledgeContextDetailRef,
  KnowledgeContextDiagnostic,
  KnowledgeContextNextAction,
  KnowledgeContextProjectNodeType,
  KnowledgeContextProjectRelationType,
  KnowledgeContextSource,
  ProjectContextRefSummary,
  ProjectContextRegion,
  ProjectContextRegionRequest,
  ProjectGraphInput,
  RegionFocus,
  RegionFocusKind,
  RegionNode,
  RegionNodeKind,
  RegionRelation,
} from '../contracts/index.js';
import {
  ALEMBIC_GRAPH_OUTPUT_CONTRACT_VERSION,
  AlembicGraphOutputSchema,
  ProjectContextRegionSchema,
  ProjectGraphInputSchema,
  REGION_CONTEXT_CONTRACT_VERSION,
} from '../contracts/index.js';
import type { ContextIndexNode, ContextIndexSnapshotOptions } from '../layer/index.js';
import type { KnowledgeContextProjectionPayload } from '../layer/KnowledgeContextOutputProjector.js';
import { defaultRefRegistry, stableRefSegment } from '../support/index.js';

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
  resolveAlembicGraph(input: ProjectGraphInput): Promise<AlembicGraphOutput>;
  resolveProjectContextRegion(request: ProjectContextRegionRequest): Promise<ProjectContextRegion>;
}

interface GraphBuild {
  detailRefs: KnowledgeContextDetailRef[];
  diagnostics: KnowledgeContextDiagnostic[];
  nodes: ProjectGraphNode[];
  projectContext: ProjectGraphProjectContextTrace;
  projectContextRefs: ProjectContextRef[];
  projectName: string;
  projectRef: KnowledgeContextDetailRef;
  relations: ProjectGraphRelation[];
  sourceSlices: GraphSourceSliceSummary[];
  sources: KnowledgeContextSource[];
}

interface ProjectGraphProjectContextTrace {
  errorCount: number;
  explicitFileTraversalFocused: boolean;
  fileFlowTargetCount: number;
  fileFlowTargetLimit: number;
  generatedArtifactSkipCount: number;
  generatedArtifactSkipSamples: string[];
  mapRequestCount: number;
  moduleRequestCount: number;
  partial: boolean;
  refCount: number;
  requestKinds: ProjectContextRequestKind[];
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

const MAX_PROJECT_CONTEXT_DETAIL_REFS = 14;
const PROJECT_CONTEXT_FLOW_SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const GENERATED_ARTIFACT_DIRECTORY_NAMES = new Set([
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'vendor',
]);

const GENERATED_ARTIFACT_FILE_SUFFIXES = [
  '.cjs.map',
  '.cts.map',
  '.d.ts',
  '.d.ts.map',
  '.js.map',
  '.jsx.map',
  '.mjs.map',
  '.mts.map',
];

interface GraphModuleSeed {
  payload: Record<string, unknown>;
  repoName: string;
  scope: { repoId?: string; sourceFolder?: string };
}

interface ProjectContextGraphFacts {
  anchorRanges: AnchorRangeContext[];
  detailRefs: KnowledgeContextDetailRef[];
  diagnostics: KnowledgeContextDiagnostic[];
  fileFlows: FileFlowContext[];
  fileSymbols: FileSymbolContext[];
  maps: ProjectMap[];
  moduleLayers: ModuleLayerContext[];
  modules: ModuleContext[];
  // Raw ProjectContext refs accumulated across every executed request; projected
  // into the Recipe-free AlembicGraphOutput `refs` list.
  projectContextRefs: ProjectContextRef[];
  repos: RepoContext[];
  sourceSliceContexts: SourceSliceContext[];
  sources: KnowledgeContextSource[];
  trace: ProjectGraphProjectContextTrace;
}

export class ProjectContextProjectGraphProvider implements ProjectGraphProvider {
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
        diagnostics: dedupeDiagnostics([...build.diagnostics, ...(selection.diagnostics ?? [])]),
        items: selection.items,
        matrixNodes: selection.matrixNodes,
        nextActions: dedupeNextActions([
          ...nextActionsFor(operation, input),
          ...(selection.nextActions ?? []),
        ]).slice(0, input.budget?.nextActionLimit ?? 5),
        relations: selection.relations,
        result: selection.result,
        sources: build.sources,
        summary,
      },
      projectNodes,
      snapshot,
    };
  }

  // GMAP-1: public alembic_graph path. Projects ProjectContext.execute facts into
  // the Recipe-free AlembicGraphOutput, selected by queryKind. Shares buildGraph
  // with resolveProjectGraph; never routes through the KnowledgeContext middle
  // layer or KnowledgeContextToolOutput envelope.
  async resolveAlembicGraph(input: ProjectGraphInput): Promise<AlembicGraphOutput> {
    const projectRoot = input.projectRoot ?? process.cwd();
    const queryKind = resolveGraphQueryKind(input);
    let build: GraphBuild;
    try {
      build = await this.buildGraph(projectRoot, input);
    } catch (error) {
      return failedAlembicGraphOutput(projectRoot, queryKind, error);
    }
    const selection = selectAlembicGraph(build, input, queryKind);
    return projectAlembicGraphOutput({ build, input, projectRoot, queryKind, selection });
  }

  // GMAP-3: shared ProjectContext region projection consumed by both alembic_graph
  // and alembic_recipe_map (GMAP-4-7). Built directly from the shared ProjectContext
  // graph build — never by invoking the public alembic_graph MCP tool. The region's
  // nodeIds/refs are identical to alembic_graph's, so a ref round-trips between
  // graph (refId) and recipe_map (focus) for free.
  async resolveProjectContextRegion(
    request: ProjectContextRegionRequest
  ): Promise<ProjectContextRegion> {
    const focus = request.focus;
    const projectRoot = request.projectRoot ?? process.cwd();
    // Anchor the shared ProjectContext build on the focus so file/anchor focuses
    // collect the right facts — this never invokes the public alembic_graph tool.
    const build = await this.buildGraph(projectRoot, regionBuildInput(focus, projectRoot));
    const selection = selectRegionFromBuild(build, focus);
    return projectProjectContextRegion({ build, focus, projectRoot, selection });
  }

  private async buildGraph(projectRoot: string, input: ProjectGraphInput): Promise<GraphBuild> {
    const projectContextFacts = await buildProjectContextGraphFacts(projectRoot, input);
    const projectName = projectNameFromProjectContextFacts(projectContextFacts, projectRoot);
    const projectId = `project:${stableRefSegment(projectName) || 'project'}`;
    const projectRef = defaultRefRegistry.createDetailRef({
      domain: 'project',
      id: projectId,
      operation: 'project-graph',
      requiredForCompletion: true,
      summary: 'Bounded project graph projected from ProjectContext.execute public envelopes.',
      title: `Project graph: ${projectName}`,
      tool: 'alembic_graph',
      uri: projectRoot,
    });
    const nodes = new NodeStore(projectRef.id, (nodePath) =>
      includeGeneratedArtifactPath(nodePath, input, projectContextFacts.trace)
    );
    const relations = new RelationStore();
    nodes.add({ id: projectId, label: projectName, nodeType: 'project', path: '.' });

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

    addProjectContextFileFlowEdges(projectContextFacts.fileFlows, nodes, relations);
    addFileSymbolContextNodes(projectContextFacts.fileSymbols, nodes, relations);
    addAnchorRangeContextNodes(projectContextFacts.anchorRanges, nodes, relations, projectId);
    addProjectContextPathOwnershipRelations(projectContextFacts, nodes, relations, projectId);

    return {
      detailRefs: dedupeDetailRefs([projectRef, ...projectContextFacts.detailRefs]).slice(
        0,
        MAX_PROJECT_CONTEXT_DETAIL_REFS
      ),
      diagnostics: projectContextFacts.diagnostics,
      nodes: nodes.values(),
      projectContext: projectContextFacts.trace,
      projectContextRefs: projectContextFacts.projectContextRefs,
      projectName,
      projectRef,
      relations: relations.values(),
      sourceSlices: buildGraphSourceSlices(projectContextFacts),
      sources: [
        {
          domain: 'project',
          id: projectRef.id,
          detailRefId: projectRef.id,
          summary:
            'Project graph facts were projected from ProjectContext.execute outputs; local paths are only request anchors.',
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
    fileSymbols: [],
    maps: [],
    moduleLayers: [],
    modules: [],
    projectContextRefs: [],
    repos: [],
    sourceSliceContexts: [],
    sources: [],
    trace: {
      errorCount: 0,
      explicitFileTraversalFocused: isExplicitFileGraphTraversal(input),
      fileFlowTargetCount: 0,
      fileFlowTargetLimit: graphFileFlowTargetLimit(input),
      generatedArtifactSkipCount: 0,
      generatedArtifactSkipSamples: [],
      mapRequestCount: 0,
      moduleRequestCount: 0,
      partial: false,
      refCount: 0,
      requestKinds: [],
    },
  };

  try {
    await collectGraphRepoContexts(facts, projectRoot, input);
    const moduleSeeds = createGraphModuleSeedsFromRepoContexts(facts.repos, input, facts.trace);
    await collectGraphMapContexts(facts, projectRoot, moduleSeeds, input);
    await collectGraphModuleContexts(facts, projectRoot, moduleSeeds, input);
    await collectGraphFileFlowContexts(facts, projectRoot, input);
    await collectGraphFileSymbolsContexts(facts, projectRoot, input);
    await collectGraphSourceSliceContexts(facts, projectRoot, input);
    await collectGraphAnchorRangeContexts(facts, projectRoot, input);
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
  facts.projectContextRefs = dedupeProjectContextRefs(facts.projectContextRefs);
  facts.trace.requestKinds = uniqueProjectContextKinds(facts.trace.requestKinds);
  return facts;
}

async function collectGraphRepoContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  input: ProjectGraphInput
) {
  const spaceEnvelope = await executeGraphProjectContextRequest('space', projectRoot, {
    activeFile: input.activeFile,
    includeProjectTree: true,
    includeStructuralHotspots: true,
    maxTreeEntries: 80,
    sourceRefs: input.sourceRefs,
  });
  collectGraphEnvelope(facts, spaceEnvelope, 'project-context-space', input);
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
    collectGraphEnvelope(facts, repoEnvelope, 'project-context-repo', input);
    if (isRepoContext(repoEnvelope.data)) {
      facts.repos.push(repoEnvelope.data);
    }
  }
}

async function collectGraphMapContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  moduleSeeds: readonly GraphModuleSeed[],
  input: ProjectGraphInput
) {
  if (!shouldCollectGraphMapContexts(input)) {
    return;
  }
  for (const group of selectGraphMapContextGroups(moduleSeeds, input).slice(
    0,
    graphMapContextGroupLimit(input)
  )) {
    const mapEnvelope = await executeGraphProjectContextRequest(
      'map',
      projectRoot,
      {
        includeCycles: true,
        includeExternalDeps: false,
        includeHotspots: true,
        includeMajorFlows: true,
        moduleSeeds: group.seeds.slice(0, 4).map((seed) => seed.payload),
        repoName: group.repoName,
      },
      group.scope
    );
    facts.trace.mapRequestCount += 1;
    collectGraphEnvelope(facts, mapEnvelope, 'project-context-map', input);
    if (isProjectMapContext(mapEnvelope.data)) {
      facts.maps.push(mapEnvelope.data);
    }
  }
}

async function collectGraphModuleContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  moduleSeeds: readonly GraphModuleSeed[],
  input: ProjectGraphInput
) {
  if (!shouldCollectGraphModuleContexts(input)) {
    return;
  }
  for (const seed of selectGraphModuleContextSeeds(moduleSeeds, input).slice(
    0,
    graphModuleContextSeedLimit(input)
  )) {
    const moduleEnvelope = await executeGraphProjectContextRequest(
      'module',
      projectRoot,
      {
        ...seed.payload,
        includeDependencies: true,
        includePublicSurfaces: true,
      },
      seed.scope
    );
    facts.trace.moduleRequestCount += 1;
    collectGraphEnvelope(facts, moduleEnvelope, 'project-context-module', input);
    if (isModuleContext(moduleEnvelope.data)) {
      facts.modules.push(moduleEnvelope.data);
    }

    const layersEnvelope = await executeGraphProjectContextRequest(
      'module-layers',
      projectRoot,
      {
        ...seed.payload,
        includeBoundaryCrossings: true,
      },
      seed.scope
    );
    facts.trace.moduleRequestCount += 1;
    collectGraphEnvelope(facts, layersEnvelope, 'project-context-module-layers', input);
    if (isModuleLayerContext(layersEnvelope.data)) {
      facts.moduleLayers.push(layersEnvelope.data);
    }
  }
}

function shouldCollectGraphMapContexts(input: ProjectGraphInput): boolean {
  return !isExplicitFileGraphTraversal(input);
}

function shouldCollectGraphModuleContexts(input: ProjectGraphInput): boolean {
  return !isExplicitFileGraphTraversal(input);
}

function graphMapContextGroupLimit(input: ProjectGraphInput): number {
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  if (isProjectContextWeightedGraphQuery(input.query, queryTerms)) {
    return 1;
  }
  return 3;
}

function graphModuleContextSeedLimit(input: ProjectGraphInput): number {
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  if (isProjectContextWeightedGraphQuery(input.query, queryTerms)) {
    return 2;
  }
  return 4;
}

function selectGraphModuleContextSeeds(
  moduleSeeds: readonly GraphModuleSeed[],
  input: ProjectGraphInput
): readonly GraphModuleSeed[] {
  const explicitPath = explicitProjectGraphPath(input);
  if (!explicitPath) {
    const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
    if (queryTerms.length > 0) {
      return moduleSeeds.filter((seed) => scoreGraphModuleSeed(seed, input) > 0);
    }
    return moduleSeeds;
  }
  return moduleSeeds.filter((seed) =>
    ownsPathByKey(normalizeRelativePath(String(seed.payload.modulePath ?? '')), explicitPath)
  );
}

async function collectGraphFileFlowContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  input: ProjectGraphInput
) {
  const sourceFiles = selectProjectContextFileFlowTargets(facts, input).slice(
    0,
    graphFileFlowTargetLimit(input)
  );
  facts.trace.fileFlowTargetCount = sourceFiles.length;
  for (const file of sourceFiles) {
    const flowEnvelope = await executeGraphProjectContextRequest(
      'file-flow',
      projectRoot,
      {
        filePath: file.filePath,
      },
      file.scope
    );
    collectGraphEnvelope(facts, flowEnvelope, 'project-context-file-flow', input);
    if (isFileFlowContext(flowEnvelope.data)) {
      facts.fileFlows.push(flowEnvelope.data);
    }
  }
}

async function collectGraphAnchorRangeContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  input: ProjectGraphInput
) {
  const anchorFilePath = selectAnchorRangeFilePath(facts, input);
  if (!anchorFilePath) {
    return;
  }

  const anchorEnvelope = await executeGraphProjectContextRequest('anchor-range', projectRoot, {
    afterLines: input.radius?.afterLines ?? 8,
    beforeLines: input.radius?.beforeLines ?? 8,
    filePath: anchorFilePath,
    includeContainingRefs: true,
    includeRelatedRefs: true,
    includeRelations: true,
    includeSourceSlices: true,
    includeSymbols: true,
    line: input.line ?? 1,
    relationHops: input.radius?.relationHops ?? 1,
  });
  collectGraphEnvelope(facts, anchorEnvelope, 'project-context-anchor-range', input);
  if (isAnchorRangeContext(anchorEnvelope.data)) {
    facts.anchorRanges.push(anchorEnvelope.data);
  }
}

// GMAP-1 coverage: file-symbols / source-slice are first-class ProjectContext
// requests, not only reachable through anchor-range. They are anchor-driven and
// bounded to the explicitly requested file so overview queryKinds stay cheap.
async function collectGraphFileSymbolsContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  input: ProjectGraphInput
) {
  const filePath = selectAnchorRangeFilePath(facts, input);
  if (!filePath) {
    return;
  }
  const symbolsEnvelope = await executeGraphProjectContextRequest('file-symbols', projectRoot, {
    filePath,
  });
  collectGraphEnvelope(facts, symbolsEnvelope, 'project-context-file-symbols', input);
  if (isFileSymbolContext(symbolsEnvelope.data)) {
    facts.fileSymbols.push(symbolsEnvelope.data);
  }
}

async function collectGraphSourceSliceContexts(
  facts: ProjectContextGraphFacts,
  projectRoot: string,
  input: ProjectGraphInput
) {
  const filePath = selectAnchorRangeFilePath(facts, input);
  if (!filePath) {
    return;
  }
  // ProjectContext source-slice requires an explicit range and validates it
  // strictly against the file length (unlike anchor-range, which clamps). Default
  // to a zero-width window at the requested line (or the file head) so the slice
  // is always valid; an explicit radius opts into a wider window.
  const line = input.line ?? 1;
  const startLine = Math.max(1, line - (input.radius?.beforeLines ?? 0));
  const endLine = line + (input.radius?.afterLines ?? 0);
  const sliceEnvelope = await executeGraphProjectContextRequest('source-slice', projectRoot, {
    endLine,
    filePath,
    includeText: true,
    range: { endLine, startLine },
    startLine,
  });
  collectGraphEnvelope(facts, sliceEnvelope, 'project-context-source-slice', input);
  if (isSourceSliceContext(sliceEnvelope.data)) {
    facts.sourceSliceContexts.push(sliceEnvelope.data);
  }
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
  operation: string,
  input: ProjectGraphInput
) {
  const refs = envelope.refs.filter((ref) => includeProjectContextRef(ref, input, facts.trace));
  const errors = (envelope.errors ?? []).filter((error) =>
    includeProjectContextError(error, input, facts.trace)
  );
  facts.trace.requestKinds.push(envelope.queryLevel);
  facts.trace.errorCount += errors.length;
  facts.trace.partial = facts.trace.partial || errors.length > 0;
  facts.trace.refCount += refs.length;
  facts.projectContextRefs.push(...refs);
  facts.detailRefs.push(
    ...refs.map((ref) => detailRefFromProjectContextRef(ref, 'alembic_graph', operation))
  );
  facts.sources.push(
    ...refs.slice(0, 12).map((ref) => sourceFromProjectContextRef(ref, operation))
  );
  facts.diagnostics.push(...errors.map(projectContextErrorToDiagnostic));
}

function includeProjectContextRef(
  ref: ProjectContextRef,
  input: ProjectGraphInput,
  trace: ProjectGraphProjectContextTrace
): boolean {
  const refPath = ref.scope.filePath ?? ref.scope.sourceFolder;
  return includeGeneratedArtifactPath(refPath, input, trace);
}

function includeProjectContextError(
  error: ProjectContextQueryError,
  input: ProjectGraphInput,
  trace: ProjectGraphProjectContextTrace
): boolean {
  if (!includeGeneratedArtifactPath(error.path, input, trace)) {
    return false;
  }
  return !shouldSuppressDefaultProjectContextError(error, input);
}

function includeGeneratedArtifactPath(
  filePath: string | undefined,
  input: ProjectGraphInput,
  trace: ProjectGraphProjectContextTrace
): boolean {
  if (includeProjectGraphPath(filePath, input)) {
    return true;
  }
  recordGeneratedArtifactSkip(trace, filePath);
  return false;
}

function addRepoContextNodes(
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string,
  repo: RepoContext
) {
  const packageName = packageNameFromRepoContext(repo);
  const packageId = packageNodeId(packageName);
  const packagePath = repoPackagePath(repo);
  nodes.add({ id: packageId, label: packageName, nodeType: 'package', path: packagePath });
  relations.add(nodes, packageId, 'partOf', projectId);

  for (const command of repo.commands.slice(0, 40)) {
    const targetId = `target:script:${stableRefSegment(command.name)}`;
    nodes.add({
      id: targetId,
      label: `script:${command.name}`,
      nodeType: 'target',
      path: 'package.json',
    });
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
      nodes.add({
        id: fileId,
        label: path.posix.basename(filePath),
        nodeType: 'file',
        path: filePath,
      });
      relations.add(nodes, fileId, 'entrypointFor', packageId);
    }
  }
  for (const area of [...repo.sourceRoots, ...repo.topAreas]) {
    const areaPath = normalizeRelativePath(area.path);
    if (!areaPath || areaPath === '.') {
      continue;
    }
    const moduleId = `module:${stableRefSegment(areaPath)}`;
    nodes.add({
      id: moduleId,
      label: path.posix.basename(areaPath),
      nodeType: 'module',
      path: areaPath,
    });
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
    nodes.add({
      id: fileId,
      label: path.posix.basename(file.filePath),
      nodeType: 'file',
      path: file.filePath,
    });
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
      nodes.add({
        id: fileId,
        label: path.posix.basename(file.filePath),
        nodeType: 'file',
        path: file.filePath,
      });
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
    const modulePath = normalizeRelativePath(moduleRecord.ref?.scope.filePath ?? moduleRecord.name);
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

interface ProjectGraphPackageOwner {
  id: string;
  label: string;
  packagePath: string;
  path: string;
}

interface ProjectGraphPathOwner {
  id: string;
  path: string;
}

interface ProjectContextFilePathCollector {
  add(filePath: string | undefined): void;
  addRef(ref: ProjectContextRef | undefined): void;
  addRelation(relation: ProjectContextRelationFilePathLike): void;
  values(): string[];
}

interface ProjectContextRelationFilePathLike {
  filePath?: string;
  from?: { filePath?: string };
  to?: { filePath?: string };
  fromRef?: ProjectContextRef;
  toRef?: ProjectContextRef;
  ref?: ProjectContextRef;
  sourceRef?: ProjectContextRef;
  targetRef?: ProjectContextRef;
}

function addProjectContextPathOwnershipRelations(
  facts: ProjectContextGraphFacts,
  nodes: NodeStore,
  relations: RelationStore,
  projectId: string
) {
  const packageOwners = createPackageOwnerRecords(facts.repos);
  const moduleOwners = createModuleOwnerRecords(nodes);
  for (const filePath of collectProjectContextFilePaths(facts)) {
    addKnownProjectContextFileOwnership({
      filePath,
      moduleOwners,
      nodes,
      packageOwners,
      projectId,
      relations,
    });
  }
}

function addKnownProjectContextFileOwnership(input: {
  filePath: string;
  moduleOwners: readonly ProjectGraphPathOwner[];
  nodes: NodeStore;
  packageOwners: readonly ProjectGraphPackageOwner[];
  projectId: string;
  relations: RelationStore;
}) {
  const filePath = normalizeRelativePath(input.filePath);
  if (!isOwnableProjectContextFilePath(filePath)) {
    return;
  }
  const fileId = fileNodeId(filePath);
  input.nodes.add({
    id: fileId,
    label: path.posix.basename(filePath),
    nodeType: 'file',
    path: filePath,
  });

  const directoryPath = path.posix.dirname(filePath);
  if (directoryPath && directoryPath !== '.') {
    const directoryId = directoryNodeId(directoryPath);
    addDirectoryChain(input.nodes, input.relations, directoryPath, input.projectId);
    input.relations.add(input.nodes, directoryId, 'ownsFile', fileId);
    input.relations.add(input.nodes, fileId, 'partOf', directoryId);
  }

  const packageOwner = selectBestPathOwner(input.packageOwners, filePath);
  if (packageOwner) {
    input.nodes.add({
      id: packageOwner.id,
      label: packageOwner.label,
      nodeType: 'package',
      path: packageOwner.packagePath,
    });
    input.relations.add(input.nodes, packageOwner.id, 'ownsFile', fileId);
    input.relations.add(input.nodes, fileId, 'partOf', packageOwner.id);
  }

  const moduleOwner = selectBestPathOwner(input.moduleOwners, filePath);
  if (moduleOwner) {
    input.relations.add(input.nodes, moduleOwner.id, 'ownsFile', fileId);
  }

  input.relations.add(input.nodes, fileId, 'partOf', input.projectId);
}

function addDirectoryChain(
  nodes: NodeStore,
  relations: RelationStore,
  directoryPath: string,
  projectId: string
) {
  let currentPath = normalizeRelativePath(directoryPath);
  while (currentPath && currentPath !== '.') {
    const currentId = directoryNodeId(currentPath);
    nodes.add({
      id: currentId,
      label: path.posix.basename(currentPath),
      nodeType: 'directory',
      path: currentPath,
    });

    const parentPath = path.posix.dirname(currentPath);
    if (!parentPath || parentPath === '.' || parentPath === currentPath) {
      relations.add(nodes, currentId, 'partOf', projectId);
      return;
    }

    const parentId = directoryNodeId(parentPath);
    nodes.add({
      id: parentId,
      label: path.posix.basename(parentPath),
      nodeType: 'directory',
      path: parentPath,
    });
    relations.add(nodes, currentId, 'partOf', parentId);
    currentPath = parentPath;
  }
}

function createPackageOwnerRecords(repos: readonly RepoContext[]): ProjectGraphPackageOwner[] {
  return repos.map((repo) => {
    const label = packageNameFromRepoContext(repo);
    return {
      id: packageNodeId(label),
      label,
      packagePath: repoPackagePath(repo),
      path: normalizeRelativePath(repo.repo.root || '.'),
    };
  });
}

function createModuleOwnerRecords(nodes: NodeStore): ProjectGraphPathOwner[] {
  return nodes
    .values()
    .filter(
      (node): node is ProjectGraphNode & { path: string } =>
        node.nodeType === 'module' &&
        typeof node.path === 'string' &&
        !path.posix.extname(node.path)
    )
    .map((node) => ({ id: node.id, path: normalizeRelativePath(node.path) }));
}

function collectProjectContextFilePaths(facts: ProjectContextGraphFacts): string[] {
  const collector = createProjectContextFilePathCollector();
  collectRepoFilePaths(facts.repos, collector);
  collectMapFilePaths(facts.maps, collector);
  collectModuleFilePaths(facts.modules, collector);
  collectModuleLayerFilePaths(facts.moduleLayers, collector);
  collectFileFlowFilePaths(facts.fileFlows, collector);
  collectAnchorRangeFilePaths(facts.anchorRanges, collector);
  return collector.values();
}

function createProjectContextFilePathCollector(): ProjectContextFilePathCollector {
  const paths = new Set<string>();
  return {
    add(filePath) {
      const normalized = normalizeRelativePath(filePath ?? '');
      if (isOwnableProjectContextFilePath(normalized)) {
        paths.add(normalized);
      }
    },
    addRef(ref) {
      if (ref?.scope.filePath) {
        this.add(ref.scope.filePath);
      }
    },
    addRelation(relation) {
      this.add(relation.filePath);
      this.add(relation.from?.filePath);
      this.add(relation.to?.filePath);
      this.addRef(relation.fromRef);
      this.addRef(relation.toRef);
      this.addRef(relation.ref);
      this.addRef(relation.sourceRef);
      this.addRef(relation.targetRef);
    },
    values() {
      return [...paths].sort();
    },
  };
}

function collectRepoFilePaths(
  repos: readonly RepoContext[],
  collector: ProjectContextFilePathCollector
) {
  for (const repo of repos) {
    for (const localPackage of repo.localPackages) {
      collector.add(localPackage.path);
      collector.addRef(localPackage.ref);
    }
    for (const target of repo.targets) {
      for (const ref of target.refs) {
        collector.addRef(ref);
      }
    }
    for (const buildSystem of repo.buildSystems) {
      for (const ref of buildSystem.configRefs) {
        collector.addRef(ref);
      }
    }
    for (const packageSystem of repo.packageSystems) {
      for (const ref of packageSystem.manifestRefs) {
        collector.addRef(ref);
      }
    }
    for (const entrypoint of repo.entrypoints) {
      for (const ref of entrypoint.refs) {
        collector.addRef(ref);
      }
    }
    for (const configFile of repo.configFiles) {
      collector.add(configFile.path);
      collector.addRef(configFile.ref);
    }
  }
}

function collectMapFilePaths(
  maps: readonly ProjectMap[],
  collector: ProjectContextFilePathCollector
) {
  for (const mapContext of maps) {
    for (const cycle of mapContext.cycles) {
      for (const ref of cycle.refs) {
        collector.addRef(ref);
      }
    }
    for (const hotspot of mapContext.hotspots) {
      collector.addRef(hotspot.ref);
    }
    for (const flow of mapContext.majorFlows) {
      for (const ref of flow.refs) {
        collector.addRef(ref);
      }
    }
  }
}

function collectModuleFilePaths(
  modules: readonly ModuleContext[],
  collector: ProjectContextFilePathCollector
) {
  for (const context of modules) {
    for (const file of context.ownedFiles) {
      collector.add(file.filePath);
      collector.addRef(file.ref);
    }
    for (const symbol of context.publicSurfaces) {
      collector.add(symbol.filePath);
      collector.addRef(symbol.ref);
    }
    for (const relation of [...context.inflow, ...context.outflow]) {
      collector.addRelation(relation);
    }
  }
}

function collectModuleLayerFilePaths(
  moduleLayers: readonly ModuleLayerContext[],
  collector: ProjectContextFilePathCollector
) {
  for (const context of moduleLayers) {
    for (const group of context.fileGroups) {
      collector.addRef(group.ref);
      for (const file of group.files) {
        collector.add(file.filePath);
        collector.addRef(file.ref);
      }
    }
    for (const relation of context.boundaryCrossings) {
      collector.addRelation(relation);
    }
  }
}

function collectFileFlowFilePaths(
  fileFlows: readonly FileFlowContext[],
  collector: ProjectContextFilePathCollector
) {
  for (const flow of fileFlows) {
    collector.add(flow.file.filePath);
    collector.addRef(flow.file.ref);
    for (const relation of [
      ...flow.imports,
      ...flow.callers,
      ...flow.callees,
      ...flow.inflow,
      ...flow.outflow,
    ]) {
      collector.addRelation(relation);
    }
    for (const symbol of flow.exports) {
      collector.add(symbol.filePath);
      collector.addRef(symbol.ref);
    }
  }
}

function collectAnchorRangeFilePaths(
  anchors: readonly AnchorRangeContext[],
  collector: ProjectContextFilePathCollector
) {
  for (const anchor of anchors) {
    collector.add(anchor.file.filePath);
    collector.addRef(anchor.file.ref);
    collector.add(anchor.anchor.filePath);
    collector.addRef(anchor.anchor.ref);
    for (const symbol of anchor.symbols) {
      collector.add(symbol.filePath);
      collector.addRef(symbol.ref);
    }
    for (const relation of anchor.relationSites) {
      collector.addRelation(relation);
    }
    for (const ref of [...anchor.relatedRefs, ...anchor.containingRefs, ...anchor.sourceSlices]) {
      collector.addRef(ref);
    }
  }
}

function selectBestPathOwner<T extends ProjectGraphPathOwner>(
  owners: readonly T[],
  filePath: string
): T | undefined {
  return owners
    .filter((owner) => ownsPath(owner.path, filePath))
    .sort(
      (left, right) => right.path.length - left.path.length || left.id.localeCompare(right.id)
    )[0];
}

function ownsPath(ownerPath: string, filePath: string): boolean {
  if (ownerPath === '.' || ownerPath.length === 0) {
    return true;
  }
  return filePath === ownerPath || filePath.startsWith(`${ownerPath}/`);
}

function ownsPathByKey(ownerPath: string, filePath: string): boolean {
  return ownsPath(graphPathKey(ownerPath), graphPathKey(filePath));
}

function isOwnableProjectContextFilePath(filePath: string): boolean {
  return (
    filePath.length > 0 && filePath !== '.' && !filePath.includes('..') && !filePath.endsWith('/')
  );
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

function projectContextRelationType(kind: string): KnowledgeContextProjectRelationType | undefined {
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

function packageNameFromRepoContext(repo: RepoContext): string {
  return repo.localPackages[0]?.name ?? repo.repo.name;
}

function packageNodeId(packageName: string): string {
  return `package:${stableRefSegment(packageName)}`;
}

function repoPackagePath(repo: RepoContext): string {
  const packagePath = repo.localPackages[0]?.path ?? 'package.json';
  return projectPathFromRepoPath(repo, packagePath);
}

function projectNameFromProjectContextFacts(
  facts: ProjectContextGraphFacts,
  projectRoot: string
): string {
  return (
    facts.repos.flatMap((repo) => repo.localPackages)[0]?.name ??
    facts.repos[0]?.repo.name ??
    projectNameFromRoot(projectRoot)
  );
}

function createGraphModuleSeedsFromRepoContexts(
  repos: readonly RepoContext[],
  input: ProjectGraphInput,
  trace: ProjectGraphProjectContextTrace
): GraphModuleSeed[] {
  const seeds = new Map<string, GraphModuleSeed>();
  for (const repo of repos) {
    const repoName = repo.localPackages[0]?.name ?? repo.repo.name;
    const scope = scopeFromRepoContext(repo);
    const candidatePaths = [
      ...repo.sourceRoots.map((item) => ({
        path: projectPathFromRepoPath(repo, item.path),
        ref: item.ref,
      })),
      ...repo.topAreas.map((item) => ({
        path: projectPathFromRepoPath(repo, item.path),
        ref: item.ref,
      })),
      ...repo.entrypoints.flatMap((entrypoint) =>
        entrypoint.refs.flatMap((ref) => {
          const filePath = ref.scope.filePath;
          return isNonEmptyString(filePath)
            ? [
                {
                  path: path.posix.dirname(normalizeRelativePath(filePath)),
                  ref,
                },
              ]
            : [];
        })
      ),
    ];
    for (const candidate of candidatePaths) {
      const modulePath = normalizeModulePath(candidate.path);
      if (!modulePath) {
        continue;
      }
      if (!includeGraphModuleSeedPath(modulePath, scope, input, trace)) {
        continue;
      }
      const key = `${scopeKey(scope)}\u0000${modulePath}`;
      if (!seeds.has(key)) {
        seeds.set(key, {
          payload: {
            moduleName: path.posix.basename(modulePath),
            modulePath,
            ...(candidate.ref === undefined ? {} : { ref: candidate.ref }),
          },
          repoName,
          scope,
        });
      }
    }
  }
  return [...seeds.values()].sort(
    (left, right) =>
      scoreGraphModuleSeed(right, input) - scoreGraphModuleSeed(left, input) ||
      String(left.payload.modulePath).localeCompare(String(right.payload.modulePath))
  );
}

function includeGraphModuleSeedPath(
  modulePath: string,
  scope: { repoId?: string; sourceFolder?: string },
  input: ProjectGraphInput,
  trace: ProjectGraphProjectContextTrace
): boolean {
  if (
    isGeneratedArtifactProjectPath(modulePath) &&
    !isExplicitProjectGraphPathRequest(modulePath, input)
  ) {
    recordGeneratedArtifactSkip(trace, modulePath);
    return false;
  }
  if (shouldSkipDefaultGraphExplorationPath(modulePath, input)) {
    return false;
  }
  if (
    isRepositoryRootModuleSeed(modulePath, scope) &&
    !isExplicitProjectGraphPathRequest(modulePath, input)
  ) {
    return false;
  }
  return true;
}

function isRepositoryRootModuleSeed(
  modulePath: string,
  scope: { repoId?: string; sourceFolder?: string }
): boolean {
  const normalized = normalizeRelativePath(modulePath);
  const sourceFolder = normalizeRelativePath(scope.sourceFolder ?? '');
  if (!sourceFolder || sourceFolder === '.') {
    return normalized === '.';
  }
  return normalized === sourceFolder;
}

function scoreGraphModuleSeed(seed: GraphModuleSeed, input: ProjectGraphInput): number {
  const modulePath = normalizeRelativePath(String(seed.payload.modulePath ?? ''));
  const moduleName = String(seed.payload.moduleName ?? path.posix.basename(modulePath));
  const refLabel = isRecord(seed.payload.ref)
    ? String(seed.payload.ref.label ?? seed.payload.ref.id ?? '')
    : '';
  const searchText = `${modulePath} ${moduleName} ${refLabel}`.toLowerCase();
  const compactText = compactGraphQueryText(searchText);
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  let score = 0;

  for (const term of queryTerms) {
    score += scoreGraphModuleSeedTerm(term, searchText, compactText);
  }

  if (isProjectContextWeightedGraphQuery(input.query, queryTerms)) {
    if (searchText.includes('project-context') || compactText.includes('projectcontext')) {
      score += 24;
    }
    if (searchText.includes('source-slice') || searchText.includes('file-flow')) {
      score += 10;
    }
  }

  const explicitPath = [input.activeFile, filePathFromGraphNodeId(input.nodeId)]
    .map((value) => normalizeRelativePath(value ?? ''))
    .find((value) => value.length > 0);
  if (explicitPath && ownsPath(modulePath, explicitPath)) {
    score += 100;
  }

  const segments = modulePath
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.includes('src')) {
    score += 8;
  }
  if (segments.includes('lib')) {
    score += 6;
  }
  if (segments.some((segment) => segment === 'test' || segment === 'tests')) {
    score -= 8;
  }
  if (segments.includes('bin') || segments.includes('scripts')) {
    score -= 8;
  }

  return score;
}

function scoreGraphModuleSeedTerm(term: string, searchText: string, compactText: string): number {
  const pathSegments = searchText
    .split(/[^-\p{L}\p{N}_]+/u)
    .flatMap((segment) => [segment, compactGraphQueryText(segment)])
    .filter((segment) => segment.length > 0);
  if (WEAK_GRAPH_MODULE_SEED_TERMS.has(term)) {
    return pathSegments.includes(term) || pathSegments.includes(compactGraphQueryText(term))
      ? 0.5
      : 0;
  }

  let score = 0;
  for (const variant of graphQueryTermVariants(term)) {
    if (searchText.includes(variant)) {
      score = Math.max(score, 1);
    }
    if (compactText.includes(compactGraphQueryText(variant))) {
      score = Math.max(score, 1.5);
    }
  }
  return score;
}

const WEAK_GRAPH_MODULE_SEED_TERMS = new Set(['map', 'module', 'repo', 'repository', 'space']);

function selectGraphMapContextGroups(
  seeds: readonly GraphModuleSeed[],
  input: ProjectGraphInput
): Array<{
  repoName: string;
  scope: { repoId?: string; sourceFolder?: string };
  seeds: GraphModuleSeed[];
}> {
  const explicitPath = explicitProjectGraphPath(input);
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  const groups = new Map<
    string,
    {
      repoName: string;
      scope: { repoId?: string; sourceFolder?: string };
      seeds: GraphModuleSeed[];
    }
  >();
  for (const seed of seeds) {
    const key = scopeKey(seed.scope);
    const group = groups.get(key) ?? { repoName: seed.repoName, scope: seed.scope, seeds: [] };
    group.seeds.push(seed);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => {
      if (explicitPath) {
        return group.seeds.some((seed) =>
          ownsPath(normalizeRelativePath(String(seed.payload.modulePath ?? '')), explicitPath)
        );
      }
      return queryTerms.length === 0 || graphModuleSeedGroupScore(group, input) > 0;
    })
    .sort(
      (left, right) =>
        graphModuleSeedGroupScore(right, input) - graphModuleSeedGroupScore(left, input) ||
        left.repoName.localeCompare(right.repoName)
    );
}

function graphModuleSeedGroupScore(
  group: { seeds: readonly GraphModuleSeed[] },
  input: ProjectGraphInput
): number {
  return Math.max(0, ...group.seeds.map((seed) => scoreGraphModuleSeed(seed, input)));
}

function selectProjectContextFileFlowTargets(
  facts: ProjectContextGraphFacts,
  input: ProjectGraphInput
): Array<{ filePath: string; scope: { repoId?: string; sourceFolder?: string } }> {
  const targets = new Map<
    string,
    { filePath: string; scope: { repoId?: string; sourceFolder?: string } }
  >();
  const add = (
    filePath: string | undefined,
    scope: { repoId?: string; sourceFolder?: string } = {},
    options: { explicit?: boolean } = {}
  ) => {
    const normalized = normalizeRelativePath(filePath ?? '');
    if (!normalized || normalized === '.' || !isProjectContextFlowSourcePath(normalized)) {
      return;
    }
    if (!options.explicit && isGeneratedArtifactProjectPath(normalized)) {
      recordGeneratedArtifactSkip(facts.trace, normalized);
      return;
    }
    if (!options.explicit && shouldSkipDefaultGraphExplorationPath(normalized, input)) {
      return;
    }
    if (!options.explicit && !shouldIncludeDefaultFileFlowTarget(normalized, input)) {
      return;
    }
    // Project graph node ids are stable, lower-cased ids. Keep the first real
    // ProjectContext path casing and avoid issuing both `AlembicCore/...` and
    // `alembiccore/...` explicit file requests for the same source file.
    targets.set(`${scopeKey(scope)}\u0000${graphPathKey(normalized)}`, {
      filePath: normalized,
      scope,
    });
  };

  add(input.activeFile, {}, { explicit: true });
  add(canonicalExplicitGraphFilePath(facts, input), {}, { explicit: true });
  for (const repo of facts.repos) {
    for (const entrypoint of repo.entrypoints) {
      for (const ref of entrypoint.refs) {
        add(ref.scope.filePath, scopeFromProjectContextRef(ref));
      }
    }
  }
  for (const context of facts.modules) {
    for (const file of context.ownedFiles) {
      add(file.filePath, scopeFromProjectContextFile(file));
    }
  }
  for (const context of facts.moduleLayers) {
    for (const group of context.fileGroups) {
      for (const file of group.files) {
        add(file.filePath, scopeFromProjectContextFile(file));
      }
    }
  }
  for (const context of facts.anchorRanges) {
    add(context.file.filePath, scopeFromProjectContextFile(context.file));
  }

  return [...targets.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function selectAnchorRangeFilePath(
  facts: ProjectContextGraphFacts,
  input: ProjectGraphInput
): string | undefined {
  if (input.activeFile) {
    return normalizeRelativePath(input.activeFile);
  }
  if (input.nodeId) {
    return canonicalExplicitGraphFilePath(facts, input);
  }
  return undefined;
}

function explicitProjectGraphPath(input: ProjectGraphInput): string | undefined {
  return [input.activeFile, filePathFromGraphNodeId(input.nodeId)]
    .map((value) => normalizeRelativePath(value ?? ''))
    .find((value) => value.length > 0);
}

function isExplicitFileGraphTraversal(input: ProjectGraphInput): boolean {
  const operation = input.operation ?? 'query';
  return (
    (operation === 'impact' || operation === 'neighborhood') &&
    explicitProjectGraphPath(input) !== undefined
  );
}

function canonicalExplicitGraphFilePath(
  facts: ProjectContextGraphFacts,
  input: ProjectGraphInput
): string | undefined {
  const requested = explicitProjectGraphPath(input);
  if (!requested) {
    return undefined;
  }
  const requestedKey = graphPathKey(requested);
  return (
    collectProjectContextFilePaths(facts).find(
      (filePath) => graphPathKey(filePath) === requestedKey
    ) ?? requested
  );
}

function graphFileFlowTargetLimit(input: ProjectGraphInput): number {
  if (isExplicitFileGraphTraversal(input)) {
    return 4;
  }

  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  if (isProjectContextWeightedGraphQuery(input.query, queryTerms)) {
    const itemLimit = input.budget?.itemLimit;
    const relationHopLimit = input.budget?.relationHopLimit;
    if (itemLimit !== undefined || relationHopLimit !== undefined) {
      return Math.min(16, Math.max(6, (itemLimit ?? 6) * Math.max(1, relationHopLimit ?? 1) * 2));
    }
    return 12;
  }

  return 60;
}

function shouldSkipDefaultGraphExplorationPath(
  filePath: string,
  input: ProjectGraphInput
): boolean {
  if (isExplicitProjectGraphPathRequest(filePath, input)) {
    return false;
  }

  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  const segments = filePath
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? '';
  const asksForTests = queryTerms.some(
    (term) => term === 'test' || term === 'tests' || term.startsWith('fixture')
  );
  const asksForScripts = queryTerms.some((term) =>
    ['bin', 'cli', 'command', 'script', 'scripts'].includes(term)
  );

  if (
    !asksForTests &&
    segments.some((segment) =>
      ['__tests__', 'fixture', 'fixtures', 'test', 'tests'].includes(segment)
    )
  ) {
    return true;
  }
  if (!asksForScripts && segments.some((segment) => segment === 'bin' || segment === 'scripts')) {
    return true;
  }

  return (
    /(?:^|[.-])config\.[cm]?[jt]sx?$/.test(basename) ||
    ['package.json', 'tsconfig.json', 'workspace.config.json'].includes(basename)
  );
}

function shouldIncludeDefaultFileFlowTarget(filePath: string, input: ProjectGraphInput): boolean {
  if (isExplicitProjectGraphPathRequest(filePath, input)) {
    return true;
  }

  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  if (queryTerms.length === 0) {
    return false;
  }

  const searchText = filePath.toLowerCase();
  const compactText = compactGraphQueryText(searchText);
  if (isProjectContextWeightedGraphQuery(input.query, queryTerms)) {
    if (
      !isProjectContextRuntimeCorePath(filePath) &&
      !queryExplicitlyAsksForRepoPath(filePath, queryTerms)
    ) {
      return false;
    }
    return (
      searchText.includes('project-context') ||
      compactText.includes('projectcontext') ||
      searchText.includes('source-slice') ||
      searchText.includes('file-symbol') ||
      searchText.includes('file-flow')
    );
  }

  return queryTerms.some((term) => scoreGraphModuleSeedTerm(term, searchText, compactText) > 0);
}

function shouldSuppressDefaultProjectContextError(
  error: ProjectContextQueryError,
  input: ProjectGraphInput
): boolean {
  const errorPath = normalizeRelativePath(error.path ?? '');
  if (!errorPath || isExplicitProjectGraphPathRequest(errorPath, input)) {
    return false;
  }
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  if (!isProjectContextWeightedGraphQuery(input.query, queryTerms)) {
    return false;
  }
  const message = error.message.toLowerCase();
  // Broad ProjectContext semantic graph queries use map/module/file-flow as
  // orientation probes. Parser warnings for files the caller did not explicitly
  // anchor are not useful graph failures; focused file requests still surface
  // the underlying ProjectContext error unchanged.
  return message.includes('file-flow') || message.includes('file-symbols');
}

function isProjectContextRuntimeCorePath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return (
    normalized === 'alembiccore/src/project-context.ts' ||
    normalized.startsWith('alembiccore/src/domain/project-context/') ||
    normalized.startsWith('alembiccore/src/service/project-context/')
  );
}

function queryExplicitlyAsksForRepoPath(filePath: string, queryTerms: readonly string[]): boolean {
  const pathSegments = normalizeRelativePath(filePath)
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0);
  return pathSegments.some(
    (segment) => queryTerms.includes(segment) || queryTerms.includes(compactGraphQueryText(segment))
  );
}

function scopeFromRepoContext(repo: RepoContext): { repoId?: string; sourceFolder?: string } {
  return compactScope({
    repoId: repo.repo.ref?.scope.repoId ?? repo.repo.id,
    sourceFolder:
      repo.repo.ref?.scope.sourceFolder ?? (repo.repo.root === '.' ? undefined : repo.repo.root),
  });
}

function scopeFromProjectContextRef(ref: ProjectContextRef): {
  repoId?: string;
  sourceFolder?: string;
} {
  return compactScope({
    repoId: ref.scope.repoId,
    sourceFolder: ref.scope.sourceFolder,
  });
}

function scopeFromProjectContextFile(file: { repoId?: string; ref?: ProjectContextRef }) {
  return compactScope({
    repoId: file.ref?.scope.repoId ?? file.repoId,
    sourceFolder: file.ref?.scope.sourceFolder,
  });
}

function compactScope(scope: { repoId?: string; sourceFolder?: string }): {
  repoId?: string;
  sourceFolder?: string;
} {
  return {
    ...(scope.repoId === undefined ? {} : { repoId: scope.repoId }),
    ...(scope.sourceFolder === undefined || scope.sourceFolder === '.'
      ? {}
      : { sourceFolder: scope.sourceFolder }),
  };
}

function scopeKey(scope: { repoId?: string; sourceFolder?: string }): string {
  return `${scope.repoId ?? ''}\u0000${scope.sourceFolder ?? ''}`;
}

function projectPathFromRepoPath(repo: RepoContext, repoRelativePath: string): string {
  const normalized = normalizeRelativePath(repoRelativePath);
  if (repo.repo.root === '.' || repo.repo.root.length === 0) {
    return normalized;
  }
  if (normalized === repo.repo.root || normalized.startsWith(`${repo.repo.root}/`)) {
    return normalized;
  }
  return normalizeRelativePath(path.posix.join(repo.repo.root, normalized));
}

function normalizeModulePath(value: string | undefined): string | undefined {
  const normalized = normalizeRelativePath(value ?? '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.includes('..') ||
    path.posix.extname(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function isProjectContextFlowSourcePath(filePath: string): boolean {
  return PROJECT_CONTEXT_FLOW_SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function includeProjectGraphPath(filePath: string | undefined, input: ProjectGraphInput): boolean {
  const normalized = normalizeRelativePath(filePath ?? '');
  if (!normalized || normalized === '.') {
    return true;
  }
  return (
    !isGeneratedArtifactProjectPath(normalized) ||
    isExplicitProjectGraphPathRequest(normalized, input)
  );
}

function isExplicitProjectGraphPathRequest(filePath: string, input: ProjectGraphInput): boolean {
  const requestedPaths = [input.activeFile, filePathFromGraphNodeId(input.nodeId)]
    .map((value) => normalizeRelativePath(value ?? ''))
    .filter((value) => value.length > 0);
  const normalized = normalizeRelativePath(filePath);
  return requestedPaths.some(
    (requestedPath) =>
      requestedPath === normalized ||
      requestedPath.startsWith(`${normalized}/`) ||
      normalized.startsWith(`${requestedPath}/`)
  );
}

function isGeneratedArtifactProjectPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => GENERATED_ARTIFACT_DIRECTORY_NAMES.has(segment))) {
    return true;
  }
  return GENERATED_ARTIFACT_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function recordGeneratedArtifactSkip(
  trace: ProjectGraphProjectContextTrace,
  filePath: string | undefined
) {
  const normalized = normalizeRelativePath(filePath ?? '');
  if (!normalized || normalized === '.') {
    return;
  }
  trace.generatedArtifactSkipCount += 1;
  if (
    trace.generatedArtifactSkipSamples.length < 12 &&
    !trace.generatedArtifactSkipSamples.includes(normalized)
  ) {
    trace.generatedArtifactSkipSamples.push(normalized);
  }
}

function filePathFromGraphNodeId(nodeId: string | undefined): string | undefined {
  if (!nodeId?.startsWith('file:')) {
    return undefined;
  }
  return normalizeRelativePath(nodeId.slice('file:'.length));
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
    domain:
      ref.kind === 'file' || ref.kind === 'path' || ref.kind === 'source-slice'
        ? 'document'
        : 'project',
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
    domain:
      ref.kind === 'file' || ref.kind === 'path' || ref.kind === 'source-slice'
        ? 'document'
        : 'project',
    id: ref.id,
    summary: `${operation} ProjectContext ref ${ref.label ?? ref.id}.`,
    title: ref.label,
  };
}

function projectContextErrorToDiagnostic(
  error: ProjectContextQueryError
): KnowledgeContextDiagnostic {
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

function isFileSymbolContext(value: ProjectContextResult): value is FileSymbolContext {
  return (
    isRecord(value) &&
    isRecord(value.file) &&
    Array.isArray(value.symbols) &&
    isRecord(value.naming)
  );
}

function isSourceSliceContext(value: ProjectContextResult): value is SourceSliceContext {
  return (
    isRecord(value) && isRecord(value.file) && isRecord(value.range) && !isRecord(value.anchor)
  );
}

class NodeStore {
  private readonly nodes = new Map<string, ProjectGraphNode>();

  constructor(
    private readonly detailRefId: string,
    private readonly includePath: (nodePath: string | undefined) => boolean = () => true
  ) {}

  add(node: Omit<ProjectGraphNode, 'detailRefId'>) {
    if (!isAllowedNodeType(node.nodeType) || this.nodes.has(node.id)) {
      return;
    }
    if (!this.includePath(node.path)) {
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

interface GraphSelection {
  diagnostics?: KnowledgeContextDiagnostic[];
  items: Record<string, unknown>[];
  matrixNodes: Record<string, unknown>[];
  nextActions?: KnowledgeContextNextAction[];
  relations: Record<string, unknown>[];
  result: Record<string, unknown>;
}

interface GraphQueryNodeMatch {
  matchScore: number;
  node: ProjectGraphNode;
  queryMatchedTerms: string[];
  rankingSignals: string[];
}

function selectGraph(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  const resolvedInput = resolveGraphInputIds(build, input);
  const operation = input.operation ?? 'query';
  switch (operation) {
    case 'stats':
      return selectStats(build, resolvedInput);
    case 'path':
      return selectPath(build, resolvedInput);
    case 'impact':
      return selectNeighborhood(build, resolvedInput, 'impact');
    case 'neighborhood':
      return selectNeighborhood(build, resolvedInput, 'neighborhood');
    default:
      return selectQuery(build, resolvedInput);
  }
}

function resolveGraphInputIds(build: GraphBuild, input: ProjectGraphInput): ProjectGraphInput {
  return {
    ...input,
    ...(input.fromId ? { fromId: resolveGraphNodeId(build, input.fromId) ?? input.fromId } : {}),
    ...(input.nodeId ? { nodeId: resolveGraphNodeId(build, input.nodeId) ?? input.nodeId } : {}),
    ...(input.toId ? { toId: resolveGraphNodeId(build, input.toId) ?? input.toId } : {}),
  };
}

function resolveGraphNodeId(build: GraphBuild, nodeId: string | undefined): string | undefined {
  if (!nodeId) {
    return undefined;
  }
  if (build.nodes.some((node) => node.id === nodeId)) {
    return nodeId;
  }

  const filePath = filePathFromGraphNodeId(nodeId);
  if (filePath) {
    const canonicalFileId = fileNodeId(filePath);
    if (build.nodes.some((node) => node.id === canonicalFileId)) {
      return canonicalFileId;
    }
    const pathKey = graphPathKey(filePath);
    const pathMatch = build.nodes.find(
      (node) => node.nodeType === 'file' && node.path && graphPathKey(node.path) === pathKey
    );
    if (pathMatch) {
      return pathMatch.id;
    }
  }

  const normalizedNodeId = nodeId.toLowerCase();
  return build.nodes.find((node) => node.id.toLowerCase() === normalizedNodeId)?.id;
}

function selectQuery(build: GraphBuild, input: ProjectGraphInput): GraphSelection {
  if (isLowInformationGraphQuery(input) && !hasFocusedGraphQuery(input)) {
    return selectProjectOrientation(build, input);
  }
  const filteredRelations = filterRelations(build.relations, input);
  const itemLimit = input.budget?.itemLimit ?? 20;
  const relationLimit = input.budget?.relationHopLimit ?? 2;
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  const projectContextWeightedQuery = isProjectContextWeightedGraphQuery(input.query, queryTerms);
  const nodeMatches = selectQueryNodeMatches(
    build.nodes,
    input,
    queryTerms,
    projectContextWeightedQuery
  );
  const relations = selectQueryRelations(filteredRelations, input, nodeMatches, relationLimit);
  const items = nodeMatches.slice(0, itemLimit).map((entry) => ({
    ...projectNodeToOutput(entry.node),
    queryMatchScore: Number(entry.matchScore.toFixed(2)),
    ...(entry.queryMatchedTerms.length > 0 ? { queryMatchedTerms: entry.queryMatchedTerms } : {}),
    ...(entry.rankingSignals.length > 0 ? { rankingSignals: entry.rankingSignals } : {}),
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
      queryMatchMode:
        queryTerms.length > 0
          ? projectContextWeightedQuery
            ? 'project-context-weighted'
            : 'term-overlap'
          : 'unfiltered',
      queryMatchedNodeCount: nodeMatches.length,
      sourceOfTruth: false,
    },
  };
}

function selectQueryNodeMatches(
  nodes: readonly ProjectGraphNode[],
  input: ProjectGraphInput,
  queryTerms: readonly string[],
  projectContextWeightedQuery: boolean
): GraphQueryNodeMatch[] {
  return nodes
    .map((node) => matchGraphQueryNode(node, input, queryTerms, projectContextWeightedQuery))
    .filter((entry): entry is GraphQueryNodeMatch => entry !== null)
    .sort((a, b) => b.matchScore - a.matchScore || a.node.id.localeCompare(b.node.id));
}

function matchGraphQueryNode(
  node: ProjectGraphNode,
  input: ProjectGraphInput,
  queryTerms: readonly string[],
  projectContextWeightedQuery: boolean
): GraphQueryNodeMatch | null {
  if (input.nodeId && node.id !== input.nodeId) {
    return null;
  }
  if (input.nodeType && node.nodeType !== input.nodeType) {
    return null;
  }
  if (queryTerms.length === 0) {
    return { matchScore: 1, node, queryMatchedTerms: [], rankingSignals: [] };
  }
  return scoreGraphQueryNode(node, queryTerms, projectContextWeightedQuery);
}

function selectQueryRelations(
  relations: readonly ProjectGraphRelation[],
  input: ProjectGraphInput,
  nodeMatches: readonly GraphQueryNodeMatch[],
  relationLimit: number
): ProjectGraphRelation[] {
  const nodeIds = new Set(nodeMatches.map((entry) => entry.node.id));
  return relations
    .filter((relation) => queryRelationMatches(relation, input, nodeIds))
    .slice(0, Math.max(relationLimit * 20, 20));
}

function queryRelationMatches(
  relation: ProjectGraphRelation,
  input: ProjectGraphInput,
  nodeIds: ReadonlySet<string>
): boolean {
  if (input.nodeId) {
    return relation.fromId === input.nodeId || relation.toId === input.nodeId;
  }
  return nodeIds.has(relation.fromId) || nodeIds.has(relation.toId);
}

function scoreGraphQueryNode(
  node: ProjectGraphNode,
  queryTerms: readonly string[],
  projectContextWeightedQuery: boolean
): GraphQueryNodeMatch | null {
  const searchText = graphQuerySearchText(node);
  const compactText = compactGraphQueryText(searchText);
  const pathSegments = graphQueryPathSegments(node);
  const queryMatchedTerms: string[] = [];
  const rankingSignals: string[] = [];
  let matchScore = 0;

  for (const term of queryTerms) {
    const termScore = scoreGraphQueryTerm(term, searchText, compactText, pathSegments);
    if (termScore <= 0) {
      continue;
    }
    queryMatchedTerms.push(term);
    matchScore += termScore;
  }

  if (queryMatchedTerms.length === 0) {
    return null;
  }

  if (projectContextWeightedQuery) {
    const projectContextBoost = projectContextSemanticNodeBoost(node);
    if (projectContextBoost > 0) {
      matchScore += projectContextBoost;
      rankingSignals.push('project-context-semantic-node');
    }

    const repositoryPenalty = genericRepositoryPathPenalty(node);
    if (repositoryPenalty > 0) {
      matchScore -= repositoryPenalty;
      rankingSignals.push('generic-repository-path-penalty');
    }
  }

  return { matchScore, node, queryMatchedTerms, rankingSignals };
}

function scoreGraphQueryTerm(
  term: string,
  searchText: string,
  compactText: string,
  pathSegments: readonly string[]
): number {
  const variants = graphQueryTermVariants(term);
  const weakTerm = WEAK_GRAPH_QUERY_TERMS.has(term);
  let score = 0;

  for (const variant of variants) {
    if (searchText.includes(variant)) {
      score = Math.max(score, weakTerm ? 0.45 : 1);
    }
    if (compactText.includes(compactGraphQueryText(variant))) {
      score = Math.max(score, weakTerm ? 0.55 : 1.2);
    }
    if (pathSegments.includes(variant) || pathSegments.includes(compactGraphQueryText(variant))) {
      score = Math.max(score, weakTerm ? 0.75 : 1.5);
    }
  }

  return score;
}

function projectContextSemanticNodeBoost(node: ProjectGraphNode): number {
  const searchText = graphQuerySearchText(node);
  const compactText = compactGraphQueryText(searchText);
  let boost = 0;

  if (searchText.includes('project-context') || compactText.includes('projectcontext')) {
    boost += 6;
  }
  if (compactText.includes('projectcontextcontracts') || compactText.includes('requestkind')) {
    boost += 4;
  }
  if (
    compactText.includes('sourceslice') ||
    compactText.includes('filesymbol') ||
    compactText.includes('fileflow') ||
    searchText.includes('module-layers')
  ) {
    boost += 3;
  }
  if (searchText.includes('/mcp/') || searchText.includes('/runtime/mcp/handlers/')) {
    boost += 2;
  }
  if (node.nodeType === 'file' || node.nodeType === 'symbol') {
    boost += 1;
  }

  return boost;
}

function genericRepositoryPathPenalty(node: ProjectGraphNode): number {
  const searchText = graphQuerySearchText(node);
  let penalty = 0;

  if (searchText.includes('/vendor/')) {
    penalty += 4;
  }
  if (searchText.includes('/repository/') || searchText.includes('repository')) {
    penalty += 3;
  }
  if (node.nodeType === 'directory' && penalty > 0) {
    penalty += 1;
  }

  return penalty;
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
  const startNode = build.nodes.find((node) => node.id === nodeId);
  if (!startNode) {
    return unavailableNodeSelection(operation, nodeId);
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
  const relationUnavailable = traversed.relations.length === 0;
  return {
    diagnostics: relationUnavailable
      ? [relationUnavailableDiagnostic(operation, nodeId, input.relationType)]
      : undefined,
    items,
    matrixNodes: items,
    nextActions: relationUnavailable
      ? [
          {
            tool: 'alembic_graph',
            operation: 'query',
            reason:
              'Query the file path, module, or package node to inspect available ProjectContext refs before retrying a narrower relation traversal.',
            required: false,
          },
        ]
      : undefined,
    relations: traversed.relations.map(projectRelationToOutput),
    result: {
      depthReached: traversed.depthReached,
      graphKind: 'project-internal',
      nodeId,
      operation,
      projectContextPartial: build.projectContext.partial || relationUnavailable,
      relationUnavailableReason: relationUnavailable
        ? `No ${input.relationType ?? 'requested'} ProjectContext graph relations were available for ${nodeId}.`
        : undefined,
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
    diagnostics: [
      {
        code: 'project-graph-anchor-required',
        domain: 'project',
        message:
          'alembic_graph impact/neighborhood requires a concrete ProjectContext nodeId, detailRefId, file, symbol, or relation anchor.',
        retryable: false,
        severity: 'info',
      },
    ],
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

function unavailableNodeSelection(
  operation: 'impact' | 'neighborhood',
  nodeId: string
): GraphSelection {
  return {
    diagnostics: [
      {
        code: 'project-graph-anchor-unavailable',
        domain: 'project',
        message: `No ProjectContext graph node matched ${nodeId}; query by file path or inspect graph stats before traversal.`,
        retryable: false,
        severity: 'warning',
      },
    ],
    items: [],
    matrixNodes: [],
    nextActions: [
      {
        tool: 'alembic_graph',
        operation: 'query',
        reason:
          'Find a concrete ProjectContext nodeId for the file, module, package, or symbol before asking for impact or neighborhood.',
        required: true,
      },
    ],
    relations: [],
    result: {
      graphKind: 'project-internal',
      impactUnavailableReason: `No ProjectContext graph node matched ${nodeId}.`,
      missing: 'nodeId',
      nodeId,
      operation,
      projectContextPartial: true,
      projectContextRefRequiredForImpact: true,
      sourceOfTruth: false,
    },
  };
}

function relationUnavailableDiagnostic(
  operation: 'impact' | 'neighborhood',
  nodeId: string,
  relationType?: KnowledgeContextProjectRelationType
): KnowledgeContextDiagnostic {
  return {
    code: 'project-graph-relation-unavailable',
    domain: 'project',
    message: `alembic_graph ${operation} found node ${nodeId}, but no ${relationType ?? 'requested'} ProjectContext relations were available for the traversal.`,
    retryable: false,
    severity: 'info',
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

function graphQuerySearchText(node: ProjectGraphNode): string {
  return `${node.id} ${node.label} ${node.path ?? ''}`.toLowerCase();
}

function compactGraphQueryText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function graphQueryPathSegments(node: ProjectGraphNode): string[] {
  const values = [node.id, node.label, node.path ?? ''];
  return Array.from(
    new Set(
      values.flatMap((value) =>
        value
          .toLowerCase()
          .split(/[^-\p{L}\p{N}_]+/u)
          .flatMap((segment) => [segment, compactGraphQueryText(segment)])
          .filter((segment) => segment.length > 0)
      )
    )
  );
}

function graphQueryTermVariants(term: string): string[] {
  const variants = new Set([term, term.replace(/_/g, '-'), term.replace(/-/g, '_')]);
  const compact = compactGraphQueryText(term);
  if (compact) {
    variants.add(compact);
  }
  if (term.endsWith('s') && term.length > 3) {
    const singular = term.slice(0, -1);
    variants.add(singular);
    variants.add(compactGraphQueryText(singular));
  }
  return [...variants].filter((variant) => variant.length > 0);
}

function isProjectContextWeightedGraphQuery(
  query: string | undefined,
  queryTerms: readonly string[]
): boolean {
  const text = compactGraphQueryText(query ?? '');
  return PROJECT_CONTEXT_WEIGHTED_QUERY_TERMS.some(
    (term) => queryTerms.includes(term) || text.includes(compactGraphQueryText(term))
  );
}

const GENERIC_GRAPH_QUERY_TERMS = new Set(['alembic', 'graph', 'project', 'source']);

const WEAK_GRAPH_QUERY_TERMS = new Set(['repo', 'repository', 'source']);

const PROJECT_CONTEXT_WEIGHTED_QUERY_TERMS = [
  'project-context',
  'projectcontext',
  'request-kind',
  'request-kinds',
  'source-slice',
  'file-symbol',
  'file-symbols',
  'file-flow',
  'module-layer',
  'module-layers',
  'repo',
  'space',
];

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

function projectNameFromRoot(projectRoot?: string): string {
  if (!projectRoot) {
    return 'Unknown project';
  }
  return path.basename(projectRoot) || projectRoot;
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

function dedupeNextActions(actions: KnowledgeContextNextAction[]): KnowledgeContextNextAction[] {
  return [
    ...new Map(
      actions.map((action) => [
        `${action.tool}\u0000${action.operation ?? ''}\u0000${action.reason}`,
        action,
      ])
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

function graphPathKey(value: string): string {
  return normalizeRelativePath(value).toLowerCase();
}

function fileNodeId(relativePath: string): string {
  return `file:${stableRefSegment(relativePath)}`;
}

function directoryNodeId(relativePath: string): string {
  return `directory:${stableRefSegment(relativePath)}`;
}

function isAllowedNodeType(value: string): value is KnowledgeContextProjectNodeType {
  return (ALLOWED_NODE_TYPES as readonly string[]).includes(value);
}

function isAllowedRelationType(value: string): value is KnowledgeContextProjectRelationType {
  return (ALLOWED_RELATION_TYPES as readonly string[]).includes(value);
}

// ═══════════════════════════════════════════════════════════
// GMAP-1 — queryKind selection + AlembicGraphOutput projection
// ═══════════════════════════════════════════════════════════

/**
 * Normalize the public queryKind. Legacy `operation` is only honored here as a
 * stale-input fallback; it never reaches a second behavior branch. Default is the
 * project architecture map.
 */
function resolveGraphQueryKind(input: ProjectGraphInput): AlembicGraphQueryKind {
  if (input.queryKind) {
    return input.queryKind;
  }
  switch (input.operation) {
    case 'impact':
      return 'impact';
    case 'path':
      return 'path';
    case 'neighborhood':
      return 'neighborhood';
    case 'stats':
      return 'stats';
    default:
      return 'map';
  }
}

function selectAlembicGraph(
  build: GraphBuild,
  input: ProjectGraphInput,
  queryKind: AlembicGraphQueryKind
): GraphSelection {
  const resolvedInput = resolveGraphInputIds(build, input);
  switch (queryKind) {
    case 'stats':
      return selectStats(build, resolvedInput);
    case 'path':
      return selectPath(build, resolvedInput);
    case 'impact':
      return selectNeighborhood(build, resolvedInput, 'impact');
    case 'neighborhood':
      return selectNeighborhood(build, resolvedInput, 'neighborhood');
    case 'space':
    case 'repo':
    case 'map':
      return selectProjectOverview(build, resolvedInput, queryKind);
    case 'module':
    case 'module-layers':
      return selectModuleView(build, resolvedInput, queryKind);
    case 'file-flow':
    case 'file-symbols':
    case 'source-slice':
    case 'anchor-range':
      return selectFileView(build, resolvedInput, queryKind);
    default:
      return selectQuery(build, resolvedInput);
  }
}

function selectProjectOverview(
  build: GraphBuild,
  input: ProjectGraphInput,
  queryKind: AlembicGraphQueryKind
): GraphSelection {
  if (input.query && !isLowInformationGraphQuery(input)) {
    return selectQuery(build, input);
  }
  // GMAP-3: structural overview is sourced from the shared ProjectContext region
  // projection (the same projection alembic_recipe_map consumes).
  const region = selectRegionFromBuild(build, regionFocusForQueryKind(queryKind, input));
  return regionSelectionToGraphSelection(region, queryKind, build, { orientation: true });
}

function selectModuleView(
  build: GraphBuild,
  input: ProjectGraphInput,
  queryKind: AlembicGraphQueryKind
): GraphSelection {
  const queryTerms = input.query ? tokenizeGraphQuery(input.query) : [];
  if (queryTerms.length === 0) {
    // GMAP-3: non-query module structure is sourced from the shared region.
    const region = selectRegionFromBuild(build, regionFocusForQueryKind(queryKind, input));
    return regionSelectionToGraphSelection(region, queryKind, build);
  }
  const focusTypes = new Set<KnowledgeContextProjectNodeType>(['module', 'directory', 'file']);
  const anchorPath = explicitProjectGraphPath(input);
  const itemLimit = input.budget?.itemLimit ?? 20;
  let candidateNodes = build.nodes.filter((node) => focusTypes.has(node.nodeType));
  if (anchorPath) {
    candidateNodes = candidateNodes.filter(
      (node) =>
        node.path && (ownsPathByKey(node.path, anchorPath) || ownsPathByKey(anchorPath, node.path))
    );
  }
  if (queryTerms.length > 0) {
    candidateNodes = candidateNodes
      .map((node) => scoreGraphQueryNode(node, queryTerms, false))
      .filter((match): match is GraphQueryNodeMatch => match !== null)
      .sort((a, b) => b.matchScore - a.matchScore || a.node.id.localeCompare(b.node.id))
      .map((match) => match.node);
  }
  const nodes = candidateNodes.slice(0, itemLimit);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const relations = build.relations
    .filter((relation) => nodeIds.has(relation.fromId) || nodeIds.has(relation.toId))
    .filter((relation) =>
      ['partOf', 'ownsFile', 'dependsOn', 'imports'].includes(relation.relationType)
    )
    .slice(0, Math.max((input.budget?.relationHopLimit ?? 2) * 16, 16));
  const items = nodes.map(projectNodeToOutput);
  return {
    items,
    matrixNodes: items,
    relations: relations.map(projectRelationToOutput),
    result: {
      graphKind: 'project-internal',
      projectContextPartial: build.projectContext.partial,
      queryKind,
      queryMatchedNodeCount: nodes.length,
      sourceOfTruth: false,
    },
  };
}

function selectFileView(
  build: GraphBuild,
  input: ProjectGraphInput,
  queryKind: AlembicGraphQueryKind
): GraphSelection {
  const anchorPath = explicitProjectGraphPath(input);
  if (!anchorPath) {
    return fileAnchorRequiredSelection(queryKind);
  }
  // GMAP-3: share the region anchor resolver so graph and recipe_map land on the
  // same file node / ref for the same anchor.
  const refId = input.refId ?? input.nodeId;
  const anchorNode = resolveRegionFileAnchor(build, {
    kind: 'file',
    filePath: anchorPath,
    ...(refId ? { refId } : {}),
  });
  if (!anchorNode) {
    return fileAnchorUnavailableSelection(queryKind, anchorPath);
  }
  const anchorId = anchorNode.id;
  const relationTypes = fileViewRelationTypes(queryKind);
  const itemLimit = input.budget?.itemLimit ?? 20;
  const relations = build.relations
    .filter(
      (relation) =>
        (relation.fromId === anchorId || relation.toId === anchorId) &&
        (relationTypes === null || relationTypes.has(relation.relationType))
    )
    .slice(0, Math.max((input.budget?.relationHopLimit ?? 2) * 16, 16));
  const neighborIds = new Set<string>([anchorId]);
  for (const relation of relations) {
    neighborIds.add(relation.fromId);
    neighborIds.add(relation.toId);
  }
  const nodes = build.nodes
    .filter((node) => neighborIds.has(node.id))
    .slice(0, itemLimit)
    .map(projectNodeToOutput);
  return {
    items: nodes,
    matrixNodes: nodes,
    relations: relations.map(projectRelationToOutput),
    result: {
      anchorPath,
      graphKind: 'project-internal',
      projectContextPartial: build.projectContext.partial,
      queryKind,
      sourceOfTruth: false,
    },
  };
}

function fileViewRelationTypes(
  queryKind: AlembicGraphQueryKind
): Set<KnowledgeContextProjectRelationType> | null {
  switch (queryKind) {
    case 'file-flow':
      return new Set<KnowledgeContextProjectRelationType>([
        'imports',
        'exports',
        'calls',
        'calledBy',
        'referencesSymbol',
      ]);
    case 'file-symbols':
      return new Set<KnowledgeContextProjectRelationType>(['definesSymbol', 'exports']);
    case 'source-slice':
      return new Set<KnowledgeContextProjectRelationType>(['partOf', 'ownsFile']);
    default:
      return null;
  }
}

function fileAnchorRequiredSelection(queryKind: AlembicGraphQueryKind): GraphSelection {
  return {
    diagnostics: [
      {
        code: 'project-graph-file-anchor-required',
        domain: 'project',
        message: `alembic_graph ${queryKind} requires a filePath, refId, or activeFile ProjectContext anchor.`,
        retryable: false,
        severity: 'info',
      },
    ],
    items: [],
    matrixNodes: [],
    relations: [],
    result: {
      graphKind: 'project-internal',
      missing: 'filePath',
      queryKind,
      sourceOfTruth: false,
    },
  };
}

function fileAnchorUnavailableSelection(
  queryKind: AlembicGraphQueryKind,
  anchorPath: string
): GraphSelection {
  return {
    diagnostics: [
      {
        code: 'project-graph-file-anchor-unavailable',
        domain: 'project',
        message: `No ProjectContext file node matched ${anchorPath}; run queryKind=map or repo to locate a real file before a file-scoped query.`,
        retryable: false,
        severity: 'warning',
      },
    ],
    items: [],
    matrixNodes: [],
    relations: [],
    result: {
      anchorPath,
      graphKind: 'project-internal',
      missing: 'filePath',
      projectContextPartial: true,
      queryKind,
      sourceOfTruth: false,
    },
  };
}

function projectAlembicGraphOutput(args: {
  build: GraphBuild;
  input: ProjectGraphInput;
  projectRoot: string;
  queryKind: AlembicGraphQueryKind;
  selection: GraphSelection;
}): AlembicGraphOutput {
  const { build, input, projectRoot, queryKind, selection } = args;
  const itemLimit = input.budget?.itemLimit ?? 20;
  const refLimit = input.budget?.detailLimit ?? 20;
  const relationLimit = Math.max((input.budget?.relationHopLimit ?? 2) * 20, 20);

  const nodes = selection.items.slice(0, itemLimit).map(graphNodeSummaryFromItem);
  const relations = selection.relations.slice(0, relationLimit).map(graphRelationSummaryFromItem);
  const refs = build.projectContextRefs.slice(0, refLimit).map(projectContextRefSummary);
  const slices = sliceOutputForQueryKind(queryKind, build, input);
  const diagnostics = dedupeGraphDiagnostics([
    ...build.diagnostics.map(graphDiagnosticFromKnowledge),
    ...(selection.diagnostics ?? []).map(graphDiagnosticFromKnowledge),
    ...resultSignalGraphDiagnostics(selection),
  ]).slice(0, 200);
  const status = deriveGraphStatus(build, selection);
  const nextActions = deriveGraphNextActions(queryKind, selection, input);
  const truncated =
    build.nodes.length > nodes.length ||
    build.projectContextRefs.length > refs.length ||
    selection.relations.length > relations.length;
  const summary = summarizeAlembicGraph(queryKind, nodes.length, relations.length, status);

  return AlembicGraphOutputSchema.parse({
    ok: status !== 'failed',
    status,
    tool: 'alembic_graph',
    toolName: 'alembic_graph',
    queryKind,
    summary,
    project: {
      projectRoot,
      displayName: build.projectName,
      projectId: `project:${stableRefSegment(build.projectName) || 'project'}`,
    },
    nodes,
    relations,
    refs,
    ...(slices.length > 0 ? { slices } : {}),
    diagnostics,
    nextActions,
    limits: { truncated, itemLimit, refLimit, relationLimit },
    meta: {
      contractVersion: ALEMBIC_GRAPH_OUTPUT_CONTRACT_VERSION,
      outputSchema: 'AlembicGraphOutput',
      producer: 'ProjectContextProjectGraphProvider',
    },
  });
}

function graphNodeSummaryFromItem(item: Record<string, unknown>): GraphNodeSummary {
  return {
    id: String(item.id),
    nodeType: item.nodeType as GraphNodeSummary['nodeType'],
    label: String(item.label),
    ...(typeof item.path === 'string' ? { path: item.path } : {}),
    ...(typeof item.detailRefId === 'string' ? { refId: item.detailRefId } : {}),
    ...(typeof item.queryMatchScore === 'number' ? { queryMatchScore: item.queryMatchScore } : {}),
    ...(Array.isArray(item.queryMatchedTerms)
      ? { queryMatchedTerms: item.queryMatchedTerms as string[] }
      : {}),
    ...(Array.isArray(item.rankingSignals)
      ? { rankingSignals: item.rankingSignals as string[] }
      : {}),
  };
}

function graphRelationSummaryFromItem(item: Record<string, unknown>): GraphRelationSummary {
  return {
    fromId: String(item.fromId),
    toId: String(item.toId),
    relationType: item.relationType as GraphRelationSummary['relationType'],
    ...(typeof item.fromType === 'string'
      ? { fromType: item.fromType as GraphRelationSummary['fromType'] }
      : {}),
    ...(typeof item.toType === 'string'
      ? { toType: item.toType as GraphRelationSummary['toType'] }
      : {}),
    ...(typeof item.detailRefId === 'string' ? { refId: item.detailRefId } : {}),
  };
}

function projectContextRefSummary(ref: ProjectContextRef): ProjectContextRefSummary {
  return {
    id: ref.id,
    kind: ref.kind,
    ...(ref.label === undefined ? {} : { label: ref.label }),
    ...(ref.scope.filePath === undefined ? {} : { filePath: ref.scope.filePath }),
    ...(ref.scope.range === undefined ? {} : { range: toGraphSourceRange(ref.scope.range) }),
    ...(ref.parentRef === undefined ? {} : { parentRef: ref.parentRef }),
  };
}

function graphDiagnosticFromKnowledge(diagnostic: KnowledgeContextDiagnostic): GraphDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    retryable: diagnostic.retryable ?? false,
    ...(diagnostic.detailRefId === undefined ? {} : { refId: diagnostic.detailRefId }),
  };
}

function resultSignalGraphDiagnostics(selection: GraphSelection): GraphDiagnostic[] {
  const result = selection.result;
  const noMatchReason = typeof result.noMatchReason === 'string' ? result.noMatchReason : undefined;
  if (noMatchReason && selection.items.length === 0) {
    return [
      {
        code: 'project-graph-no-match',
        message: noMatchReason,
        retryable: false,
        severity: 'info',
      },
    ];
  }
  return [];
}

function deriveGraphStatus(build: GraphBuild, selection: GraphSelection): AlembicGraphStatus {
  const result = selection.result;
  const partial =
    build.projectContext.partial ||
    result.projectContextPartial === true ||
    result.projectContextRefRequiredForImpact === true ||
    typeof result.missing === 'string' ||
    typeof result.noMatchReason === 'string' ||
    typeof result.impactUnavailableReason === 'string' ||
    typeof result.relationUnavailableReason === 'string';
  if (partial) {
    return 'partial';
  }
  if (build.projectContext.errorCount > 0) {
    return 'degraded';
  }
  return 'ready';
}

function deriveGraphNextActions(
  queryKind: AlembicGraphQueryKind,
  selection: GraphSelection,
  input: ProjectGraphInput
): GraphNextAction[] {
  const actions: GraphNextAction[] = [];
  const result = selection.result;
  const missing = typeof result.missing === 'string' ? result.missing : undefined;
  if (missing === 'nodeId' || result.projectContextRefRequiredForImpact === true) {
    actions.push({
      tool: 'alembic_graph',
      queryKind: 'map',
      reason:
        'Locate a concrete ProjectContext node/ref via queryKind=map or repo before impact or neighborhood.',
      required: true,
    });
  }
  if (missing === 'filePath') {
    actions.push({
      tool: 'alembic_graph',
      queryKind: 'map',
      reason:
        'Locate a file via queryKind=map or repo, then re-run the file-scoped query with filePath.',
      required: true,
    });
  }
  if (missing === 'fromId' || missing === 'toId') {
    actions.push({
      tool: 'alembic_graph',
      queryKind: 'map',
      reason: 'Resolve both endpoint refs (fromRefId/toRefId) via queryKind=map before path.',
      required: true,
    });
  }
  if (queryKind !== 'stats') {
    actions.push({
      tool: 'alembic_graph',
      queryKind: 'stats',
      reason:
        'Inspect available project node and relation types with queryKind=stats before a broader traversal.',
      required: false,
    });
  }
  return dedupeGraphNextActions(actions).slice(0, input.budget?.nextActionLimit ?? 5);
}

function summarizeAlembicGraph(
  queryKind: AlembicGraphQueryKind,
  nodeCount: number,
  relationCount: number,
  status: AlembicGraphStatus
): string {
  return `alembic_graph ${queryKind} returned ${nodeCount} project graph nodes and ${relationCount} relations (ProjectContext ${status}).`;
}

function sliceOutputForQueryKind(
  queryKind: AlembicGraphQueryKind,
  build: GraphBuild,
  input: ProjectGraphInput
): GraphSourceSliceSummary[] {
  if (queryKind !== 'source-slice' && queryKind !== 'anchor-range') {
    return [];
  }
  return build.sourceSlices.slice(0, input.budget?.itemLimit ?? 40);
}

function failedAlembicGraphOutput(
  projectRoot: string,
  queryKind: AlembicGraphQueryKind,
  error: unknown
): AlembicGraphOutput {
  return AlembicGraphOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_graph',
    toolName: 'alembic_graph',
    queryKind,
    summary: `alembic_graph ${queryKind} failed before ProjectContext facts could be projected.`,
    project: { projectRoot },
    nodes: [],
    relations: [],
    refs: [],
    diagnostics: [
      {
        code: 'project-graph-execution-failed',
        message: `ProjectContext graph projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: true,
        severity: 'error',
      },
    ],
    nextActions: [],
    limits: { truncated: false, itemLimit: 0, refLimit: 0, relationLimit: 0 },
    meta: {
      contractVersion: ALEMBIC_GRAPH_OUTPUT_CONTRACT_VERSION,
      outputSchema: 'AlembicGraphOutput',
      producer: 'ProjectContextProjectGraphProvider',
    },
  });
}

function dedupeGraphDiagnostics(diagnostics: GraphDiagnostic[]): GraphDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [`${diagnostic.code}\u0000${diagnostic.message}`, diagnostic])
    ).values(),
  ];
}

function dedupeGraphNextActions(actions: GraphNextAction[]): GraphNextAction[] {
  return [
    ...new Map(
      actions.map((action) => [`${action.queryKind ?? ''}\u0000${action.reason}`, action])
    ).values(),
  ];
}

function toGraphSourceRange(range: {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}): GraphSourceSliceSummary['range'] {
  return {
    startLine: range.startLine,
    endLine: range.endLine,
    ...(range.startColumn === undefined ? {} : { startColumn: range.startColumn }),
    ...(range.endColumn === undefined ? {} : { endColumn: range.endColumn }),
  };
}

function addFileSymbolContextNodes(
  fileSymbols: readonly FileSymbolContext[],
  nodes: NodeStore,
  relations: RelationStore
) {
  for (const context of fileSymbols) {
    const fileId = fileNodeId(context.file.filePath);
    nodes.add({
      id: fileId,
      label: path.posix.basename(context.file.filePath),
      nodeType: 'file',
      path: context.file.filePath,
    });
    for (const symbol of context.symbols) {
      addSymbolNode(nodes, relations, symbol.filePath, symbol.name);
    }
  }
}

function buildGraphSourceSlices(facts: ProjectContextGraphFacts): GraphSourceSliceSummary[] {
  const slices = new Map<string, GraphSourceSliceSummary>();
  const addSlice = (slice: GraphSourceSliceSummary) => {
    const key = `${slice.filePath}\u0000${slice.range.startLine}\u0000${slice.range.endLine}`;
    if (!slices.has(key)) {
      slices.set(key, slice);
    }
  };
  for (const context of facts.sourceSliceContexts) {
    const filePath = normalizeRelativePath(context.file.filePath);
    if (!filePath) {
      continue;
    }
    addSlice({
      filePath,
      range: toGraphSourceRange(context.range),
      ...(context.text === undefined ? {} : { text: boundedSliceText(context.text) }),
    });
  }
  for (const anchor of facts.anchorRanges) {
    for (const ref of anchor.sourceSlices) {
      const filePath = normalizeRelativePath(ref.scope.filePath ?? '');
      if (!filePath || !ref.scope.range) {
        continue;
      }
      addSlice({
        refId: ref.id,
        filePath,
        range: toGraphSourceRange(ref.scope.range),
      });
    }
  }
  return [...slices.values()];
}

function boundedSliceText(text: string): string {
  const MAX_SLICE_CHARS = 2000;
  return text.length > MAX_SLICE_CHARS ? `${text.slice(0, MAX_SLICE_CHARS)}…` : text;
}

function dedupeProjectContextRefs(refs: ProjectContextRef[]): ProjectContextRef[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

// ═══════════════════════════════════════════════════════════
// GMAP-3 — shared ProjectContext region projection
// ═══════════════════════════════════════════════════════════

interface RegionSelection {
  rootNode: ProjectGraphNode;
  breadcrumb: ProjectGraphNode[];
  nodes: ProjectGraphNode[];
  relations: ProjectGraphRelation[];
  diagnostics: KnowledgeContextDiagnostic[];
  truncated: boolean;
}

const REGION_NODE_LIMIT = 40;
const REGION_RELATION_LIMIT = 60;

function regionFocusFromInput(input: ProjectGraphInput): RegionFocus {
  const focus: RegionFocus = { kind: regionFocusKindFromInput(input) };
  const refId = input.refId ?? input.nodeId;
  if (refId) {
    focus.refId = refId;
  }
  const filePath =
    input.filePath ?? input.activeFile ?? filePathFromGraphNodeId(input.nodeId) ?? undefined;
  if (filePath) {
    focus.filePath = normalizeRelativePath(filePath);
  }
  if (input.line !== undefined) {
    focus.line = input.line;
  }
  return focus;
}

function regionFocusKindFromInput(input: ProjectGraphInput): RegionFocusKind {
  if (input.queryKind) {
    return regionFocusKindFromQueryKind(input.queryKind);
  }
  if (input.operation) {
    return regionFocusKindFromQueryKind(resolveGraphQueryKind(input));
  }
  if (input.filePath || input.activeFile || filePathFromGraphNodeId(input.nodeId)) {
    return 'file';
  }
  if (input.refId || input.nodeId) {
    return 'module';
  }
  return 'space';
}

function regionFocusKindFromQueryKind(queryKind: AlembicGraphQueryKind): RegionFocusKind {
  switch (queryKind) {
    case 'space':
      return 'space';
    case 'repo':
      return 'repo';
    case 'module':
    case 'module-layers':
      return 'module';
    case 'file-flow':
    case 'file-symbols':
    case 'source-slice':
      return 'file';
    case 'anchor-range':
      return 'anchor';
    default:
      // map + derived traversals fall back to the broad map focus.
      return 'map';
  }
}

// Map a focus-shaped region request onto a ProjectGraph build input so the shared
// ProjectContext build anchors on the focus file/ref and collects the right facts.
function regionBuildInput(focus: RegionFocus, projectRoot: string): ProjectGraphInput {
  return ProjectGraphInputSchema.parse({
    projectRoot,
    queryKind: queryKindForRegionFocus(focus.kind),
    ...(focus.filePath ? { activeFile: focus.filePath, filePath: focus.filePath } : {}),
    ...(focus.refId ? { refId: focus.refId, nodeId: focus.refId } : {}),
    ...(focus.line === undefined ? {} : { line: focus.line }),
  });
}

function queryKindForRegionFocus(kind: RegionFocusKind): AlembicGraphQueryKind {
  switch (kind) {
    case 'space':
      return 'space';
    case 'repo':
      return 'repo';
    case 'module':
      return 'module';
    case 'file':
    case 'symbol':
      return 'file-symbols';
    case 'anchor':
      return 'anchor-range';
    default:
      return 'map';
  }
}

function selectRegionFromBuild(build: GraphBuild, focus: RegionFocus): RegionSelection {
  const parentMap = buildRegionParentMap(build);
  switch (focus.kind) {
    case 'module':
      return moduleRegion(build, focus, parentMap);
    case 'file':
    case 'anchor':
    case 'symbol':
      return fileRegion(build, focus, parentMap);
    default:
      return overviewRegion(build, focus, parentMap);
  }
}

function overviewRegion(
  build: GraphBuild,
  focus: RegionFocus,
  parentMap: Map<string, string>
): RegionSelection {
  const rootNode = regionProjectRootNode(build);
  const preferred = overviewRegionPreferredTypes(focus.kind);
  const candidates = build.nodes
    .filter((node) => preferred.has(node.nodeType))
    .sort(
      (a, b) => orientationNodeWeight(a) - orientationNodeWeight(b) || a.id.localeCompare(b.id)
    );
  const nodes = candidates.slice(0, REGION_NODE_LIMIT);
  return {
    rootNode,
    breadcrumb: regionBreadcrumb(build, rootNode, parentMap),
    nodes,
    relations: regionRelationsForNodes(build, nodes, [
      'dependsOn',
      'entrypointFor',
      'ownsFile',
      'partOf',
    ]),
    diagnostics: [],
    truncated: candidates.length > nodes.length,
  };
}

function overviewRegionPreferredTypes(kind: RegionFocusKind): Set<KnowledgeContextProjectNodeType> {
  switch (kind) {
    case 'space':
      return new Set<KnowledgeContextProjectNodeType>(['project', 'package']);
    case 'repo':
      return new Set<KnowledgeContextProjectNodeType>(['project', 'package', 'target', 'file']);
    default:
      return new Set<KnowledgeContextProjectNodeType>([
        'project',
        'package',
        'target',
        'module',
        'directory',
      ]);
  }
}

function moduleRegion(
  build: GraphBuild,
  focus: RegionFocus,
  parentMap: Map<string, string>
): RegionSelection {
  const focusTypes = new Set<KnowledgeContextProjectNodeType>(['module', 'directory', 'file']);
  const anchorPath = focus.filePath;
  let candidates = build.nodes.filter((node) => focusTypes.has(node.nodeType));
  let rootNode = regionProjectRootNode(build);
  if (anchorPath) {
    candidates = candidates.filter(
      (node) =>
        node.path && (ownsPathByKey(node.path, anchorPath) || ownsPathByKey(anchorPath, node.path))
    );
    const owningModule = candidates
      .filter(
        (node) => node.nodeType === 'module' && node.path && ownsPathByKey(node.path, anchorPath)
      )
      .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
    if (owningModule) {
      rootNode = owningModule;
    }
  }
  const nodes = candidates.slice(0, REGION_NODE_LIMIT);
  return {
    rootNode,
    breadcrumb: regionBreadcrumb(build, rootNode, parentMap),
    nodes,
    relations: regionRelationsForNodes(build, nodes, [
      'partOf',
      'ownsFile',
      'dependsOn',
      'imports',
    ]),
    diagnostics: [],
    truncated: candidates.length > nodes.length,
  };
}

function fileRegion(
  build: GraphBuild,
  focus: RegionFocus,
  parentMap: Map<string, string>
): RegionSelection {
  const anchorNode = resolveRegionFileAnchor(build, focus);
  const projectRoot = regionProjectRootNode(build);
  if (!focus.filePath && !focus.refId) {
    return {
      rootNode: projectRoot,
      breadcrumb: [projectRoot],
      nodes: [],
      relations: [],
      diagnostics: [
        {
          code: 'project-context-region-anchor-required',
          domain: 'project',
          message: `ProjectContext region focus '${focus.kind}' requires a filePath or refId anchor.`,
          retryable: false,
          severity: 'info',
        },
      ],
      truncated: false,
    };
  }
  if (!anchorNode) {
    return {
      rootNode: projectRoot,
      breadcrumb: [projectRoot],
      nodes: [],
      relations: [],
      diagnostics: [
        {
          code: 'project-context-region-anchor-unavailable',
          domain: 'project',
          message: `No ProjectContext node matched region focus '${focus.kind}' anchor ${
            focus.filePath ?? focus.refId
          }.`,
          retryable: false,
          severity: 'warning',
        },
      ],
      truncated: true,
    };
  }
  const relations = build.relations
    .filter((relation) => relation.fromId === anchorNode.id || relation.toId === anchorNode.id)
    .slice(0, REGION_RELATION_LIMIT);
  const neighborIds = new Set<string>([anchorNode.id]);
  for (const relation of relations) {
    neighborIds.add(relation.fromId);
    neighborIds.add(relation.toId);
  }
  const nodes = build.nodes.filter((node) => neighborIds.has(node.id)).slice(0, REGION_NODE_LIMIT);
  return {
    rootNode: anchorNode,
    breadcrumb: regionBreadcrumb(build, anchorNode, parentMap),
    nodes,
    relations,
    diagnostics: [],
    truncated: neighborIds.size > nodes.length,
  };
}

function resolveRegionFileAnchor(build: GraphBuild, focus: RegionFocus): ProjectGraphNode | null {
  if (focus.refId) {
    const byNode = resolveGraphNodeId(build, focus.refId);
    if (byNode) {
      return build.nodes.find((node) => node.id === byNode) ?? null;
    }
    const ref = build.projectContextRefs.find((candidate) => candidate.id === focus.refId);
    const refPath = ref?.scope.filePath;
    if (refPath) {
      const fileId = resolveGraphNodeId(build, fileNodeId(normalizeRelativePath(refPath)));
      if (fileId) {
        return build.nodes.find((node) => node.id === fileId) ?? null;
      }
    }
  }
  if (focus.filePath) {
    const fileId =
      resolveGraphNodeId(build, fileNodeId(focus.filePath)) ?? fileNodeId(focus.filePath);
    return build.nodes.find((node) => node.id === fileId) ?? null;
  }
  return null;
}

function regionProjectRootNode(build: GraphBuild): ProjectGraphNode {
  return (
    build.nodes.find((node) => node.nodeType === 'project') ?? {
      id: `project:${stableRefSegment(build.projectName) || 'project'}`,
      label: build.projectName,
      nodeType: 'project',
      path: '.',
    }
  );
}

function regionRelationsForNodes(
  build: GraphBuild,
  nodes: readonly ProjectGraphNode[],
  relationTypes: readonly KnowledgeContextProjectRelationType[]
): ProjectGraphRelation[] {
  const allowed = new Set<string>(relationTypes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return build.relations
    .filter(
      (relation) =>
        allowed.has(relation.relationType) &&
        (nodeIds.has(relation.fromId) || nodeIds.has(relation.toId))
    )
    .slice(0, REGION_RELATION_LIMIT);
}

// Breadcrumb is the ancestry chain from the project root down to (and including)
// the focus root, derived from `partOf` ownership relations.
function buildRegionParentMap(build: GraphBuild): Map<string, string> {
  const nodeById = new Map(build.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string>();
  for (const relation of build.relations) {
    if (relation.relationType !== 'partOf') {
      continue;
    }
    const child = relation.fromId;
    const parent = relation.toId;
    if (child === parent) {
      continue;
    }
    const existing = parents.get(child);
    if (!existing) {
      parents.set(child, parent);
      continue;
    }
    // Prefer the most specific (longest-path) parent.
    const existingLen = nodeById.get(existing)?.path?.length ?? 0;
    const candidateLen = nodeById.get(parent)?.path?.length ?? 0;
    if (candidateLen > existingLen) {
      parents.set(child, parent);
    }
  }
  return parents;
}

function regionBreadcrumb(
  build: GraphBuild,
  rootNode: ProjectGraphNode,
  parentMap: Map<string, string>
): ProjectGraphNode[] {
  const nodeById = new Map(build.nodes.map((node) => [node.id, node]));
  const ancestors: ProjectGraphNode[] = [];
  const seen = new Set<string>([rootNode.id]);
  let current = parentMap.get(rootNode.id);
  while (current && !seen.has(current) && ancestors.length < 39) {
    seen.add(current);
    const node = nodeById.get(current);
    if (node) {
      ancestors.push(node);
    }
    current = parentMap.get(current);
  }
  return [...ancestors.reverse(), rootNode];
}

function projectProjectContextRegion(args: {
  build: GraphBuild;
  focus: RegionFocus;
  projectRoot: string;
  selection: RegionSelection;
}): ProjectContextRegion {
  const { build, focus, projectRoot, selection } = args;
  const childCounts = buildRegionChildCounts(build);
  const refLimit = 80;
  return ProjectContextRegionSchema.parse({
    project: {
      projectRoot,
      projectId: `project:${stableRefSegment(build.projectName) || 'project'}`,
      displayName: build.projectName,
    },
    focus,
    rootNode: regionNodeFromGraphNode(selection.rootNode, childCounts),
    breadcrumb: selection.breadcrumb.map((node) => regionNodeFromGraphNode(node, childCounts)),
    nodes: selection.nodes.map((node) => regionNodeFromGraphNode(node, childCounts)),
    relations: selection.relations.map(regionRelationFromGraphRelation),
    refs: build.projectContextRefs.slice(0, refLimit).map(projectContextRefSummary),
    diagnostics: dedupeGraphDiagnostics(selection.diagnostics.map(graphDiagnosticFromKnowledge)),
    truncated: selection.truncated,
    meta: {
      contractVersion: REGION_CONTEXT_CONTRACT_VERSION,
      outputSchema: 'ProjectContextRegion',
      producer: 'ProjectContextProjectGraphProvider',
    },
  });
}

function buildRegionChildCounts(build: GraphBuild): Map<string, number> {
  const parentMap = buildRegionParentMap(build);
  const counts = new Map<string, number>();
  for (const parent of parentMap.values()) {
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

function regionNodeFromGraphNode(
  node: ProjectGraphNode,
  childCounts: Map<string, number>
): RegionNode {
  const childCount = childCounts.get(node.id);
  return {
    nodeId: node.id,
    kind: regionKindFromNodeType(node.nodeType),
    label: node.label,
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.detailRefId === undefined ? {} : { projectContextRef: node.detailRefId }),
    ...(childCount === undefined ? {} : { childCount }),
  };
}

function regionRelationFromGraphRelation(relation: ProjectGraphRelation): RegionRelation {
  return {
    fromId: relation.fromId,
    toId: relation.toId,
    relationType: relation.relationType,
    ...(relation.fromType === undefined
      ? {}
      : { fromKind: regionKindFromNodeType(relation.fromType) }),
    ...(relation.toType === undefined ? {} : { toKind: regionKindFromNodeType(relation.toType) }),
    ...(relation.detailRefId === undefined ? {} : { refId: relation.detailRefId }),
  };
}

function regionKindFromNodeType(nodeType: KnowledgeContextProjectNodeType): RegionNodeKind {
  switch (nodeType) {
    case 'project':
      return 'space';
    case 'package':
    case 'target':
      return 'repo';
    case 'module':
      return 'module';
    case 'directory':
      return 'module-layer';
    case 'file':
      return 'file';
    case 'symbol':
      return 'symbol';
    default:
      return 'file';
  }
}

// Bridge the shared (typed) region selection into the loose GraphSelection that
// alembic_graph projects from. This is how graph "consumes" the shared region
// projection for structural queryKinds without diverging from recipe_map.
function regionFocusForQueryKind(
  queryKind: AlembicGraphQueryKind,
  input: ProjectGraphInput
): RegionFocus {
  const focus = regionFocusFromInput(input);
  focus.kind = regionFocusKindFromQueryKind(queryKind);
  return focus;
}

function regionSelectionToGraphSelection(
  region: RegionSelection,
  queryKind: AlembicGraphQueryKind,
  build: GraphBuild,
  extraResult: Record<string, unknown> = {}
): GraphSelection {
  const items = region.nodes.map(projectNodeToOutput);
  return {
    ...(region.diagnostics.length > 0 ? { diagnostics: region.diagnostics } : {}),
    items,
    matrixNodes: items,
    relations: region.relations.map(projectRelationToOutput),
    result: {
      graphKind: 'project-internal',
      projectContextPartial: build.projectContext.partial || region.truncated,
      queryKind,
      queryMatchedNodeCount: region.nodes.length,
      sourceOfTruth: false,
      ...extraResult,
    },
  };
}

export const defaultProjectGraphProvider = new ProjectContextProjectGraphProvider();
