import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ProjectContext,
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
  KnowledgeContextSource,
  KnowledgeContextSourceDomain,
} from '../contracts/index.js';
import type { KnowledgeContextDomainFreshness } from '../evidence/index.js';
import { defaultRefRegistry, stableRefSegment } from '../support/index.js';
import { resolveProjectScopeSourceFolders } from './ProjectScopeFolders.js';

export interface ProjectMatrixNode {
  childCount?: number;
  detailRefId?: string;
  depth?: number;
  id: string;
  label: string;
  parentId?: string;
  path?: string;
  summary?: string;
  type: string;
}

export interface ProjectMatrixKnowledgeEntry {
  category?: string;
  description?: string;
  id: string;
  kind?: string;
  language?: string;
  title?: string;
}

export interface ProjectMatrixResolveInput {
  activeFile?: string;
  knowledgeEntries?: ProjectMatrixKnowledgeEntry[];
  nodeId?: string;
  nodeType?: string;
  operation?: string;
  projectRoot?: string;
  sourceEvidenceRefs?: string[];
  sourceRefs?: string[];
}

export interface ProjectMatrixProviderResult {
  detailRefs: KnowledgeContextDetailRef[];
  diagnostics: KnowledgeContextDiagnostic[];
  domainFreshness: Partial<
    Record<KnowledgeContextSourceDomain, Partial<KnowledgeContextDomainFreshness>>
  >;
  inventory: Record<string, unknown>;
  items: Record<string, unknown>[];
  knowledgeItemCount: number;
  matrixNodes: Record<string, unknown>[];
  nextActions: KnowledgeContextNextAction[];
  projectNodes: ProjectMatrixNode[];
  recipeRelationCount: number;
  relations: Record<string, unknown>[];
  result: Record<string, unknown>;
  sources: KnowledgeContextSource[];
  summary: string;
}

export interface ProjectMatrixProvider {
  resolveMatrix(input: ProjectMatrixResolveInput): Promise<ProjectMatrixProviderResult>;
  resolveMatrixNodes(projectRoot?: string): ProjectMatrixNode[];
}

interface RawProjectTree {
  detailRefs: KnowledgeContextDetailRef[];
  diagnostics?: KnowledgeContextDiagnostic[];
  keyNodes: ProjectMatrixNode[];
  nodes: ProjectMatrixNode[];
  projectName?: string;
  projectContext?: ProjectMatrixProjectContextTrace;
  relations: Record<string, unknown>[];
  sources: KnowledgeContextSource[];
  structuralHotspots: Record<string, unknown>[];
}

interface ProjectMatrixProjectContextTrace {
  errorCount: number;
  partial: boolean;
  requestKinds: ProjectContextRequestKind[];
  refCount: number;
  repoCount: number;
}

interface KnowledgeCatalog {
  categories: Array<{
    category: string;
    count: number;
    kinds: string[];
    representativeRefs: string[];
    titles: string[];
  }>;
  detailRefs: KnowledgeContextDetailRef[];
  itemCount: number;
  items: Record<string, unknown>[];
  sources: KnowledgeContextSource[];
}

interface ProjectTreeTopLevelEntry {
  absolutePath: string;
  isDirectory: boolean;
  name: string;
}

const EXCLUDED_TOP_LEVEL_NAMES = new Set([
  '.DS_Store',
  '.git',
  '.workspace-active',
  '.workspace-local',
  '.tmp',
  '.localized',
  'coverage',
  'dist',
  'node_modules',
  'scratch',
  'tmp',
]);

const IMPORTANT_TOP_LEVEL_NAMES = new Set([
  'AGENTS.md',
  'README.md',
  'README_CN.md',
  'README.zh-CN.md',
  'bin',
  'config',
  'docs',
  'lib',
  'package.json',
  'packages',
  'plugins',
  'scripts',
  'skills',
  'src',
  'templates',
  'test',
  'tests',
  'tsconfig.json',
  'vitest.config.ts',
]);

const MAX_TOP_LEVEL_NODES = 28;
const MAX_CHILDREN_PER_DIRECTORY = 8;
const MAX_KEY_NODES = 12;
const MAX_HOTSPOTS = 10;
const MAX_KNOWLEDGE_CATEGORIES = 12;
const MAX_REPRESENTATIVE_REFS = 6;
const COARSE_KNOWLEDGE_CATEGORIES = new Set(['general', 'service', 'uncategorized', 'utility']);

export class FileSystemProjectMatrixProvider implements ProjectMatrixProvider {
  async resolveMatrix(input: ProjectMatrixResolveInput): Promise<ProjectMatrixProviderResult> {
    const operation = input.operation ?? 'overview';
    const tree = await readProjectContextProjectTree(input);
    const catalog = buildKnowledgeCatalog(input.knowledgeEntries ?? [], input.sourceRefs ?? []);
    const selected = selectOperationView(operation, {
      catalog,
      nodeId: input.nodeId,
      nodeType: input.nodeType,
      sourceEvidenceRefs: input.sourceEvidenceRefs ?? [],
      tree,
    });
    const domainFreshness = buildDomainFreshness({
      catalog,
      projectRoot: input.projectRoot,
      projectTree: tree,
      requestedNodeFound: selected.requestedNodeFound,
      sourceEvidenceRefs: input.sourceEvidenceRefs ?? [],
    });
    const projectName = tree.projectName ?? projectNameFromRoot(input.projectRoot);
    const summary = summarizeOperation(operation, {
      categoryCount: catalog.categories.length,
      nodeCount: selected.matrixNodes.length,
      projectName,
      statusHint: selected.statusHint,
    });

    return {
      detailRefs: [...tree.detailRefs, ...catalog.detailRefs],
      diagnostics: [...(tree.diagnostics ?? [])],
      domainFreshness,
      inventory: {
        catalogCategories: catalog.categories.map(({ category, count, representativeRefs }) => ({
          category,
          count,
          representativeRefs,
        })),
        keyNodeCount: tree.keyNodes.length,
        operation,
        projectContext: tree.projectContext,
        projectName,
        projectRoot: input.projectRoot,
        structuralHotspots: tree.structuralHotspots,
      },
      items: selected.items,
      knowledgeItemCount: catalog.itemCount,
      matrixNodes: selected.matrixNodes,
      nextActions: buildNextActions(selected),
      projectNodes: tree.nodes,
      recipeRelationCount: input.sourceEvidenceRefs?.length ?? 0,
      relations: selected.relations,
      result: {
        catalog: {
          categories: catalog.categories,
          itemCount: catalog.itemCount,
        },
        keyNodes: tree.keyNodes,
        layers: selected.layers,
        operation,
        projectName,
        requestedNode: selected.requestedNode,
        projectContext: tree.projectContext,
        sources: selected.sourceSummaries,
        structuralHotspots: tree.structuralHotspots,
      },
      sources: [...tree.sources, ...catalog.sources],
      summary,
    };
  }

  resolveMatrixNodes(projectRoot?: string): ProjectMatrixNode[] {
    return readProjectTree(projectRoot).nodes;
  }
}

async function readProjectContextProjectTree(
  input: ProjectMatrixResolveInput
): Promise<RawProjectTree> {
  if (!input.projectRoot) {
    return {
      ...readProjectTree(input.projectRoot, input.activeFile),
      diagnostics: [projectContextDiagnostic('project-context-missing-root')],
      projectContext: {
        errorCount: 1,
        partial: true,
        refCount: 0,
        repoCount: 0,
        requestKinds: [],
      },
    };
  }

  const observedAt = new Date().toISOString();
  try {
    const spaceEnvelope = await executeMatrixProjectContextRequest('space', input.projectRoot, {
      activeFile: input.activeFile,
      includeProjectTree: true,
      includeStructuralHotspots: true,
      maxTreeEntries: MAX_TOP_LEVEL_NODES,
      sourceRefs: input.sourceRefs,
    });
    const trace: ProjectMatrixProjectContextTrace = {
      errorCount: spaceEnvelope.errors?.length ?? 0,
      partial: Boolean(spaceEnvelope.errors?.length),
      refCount: spaceEnvelope.refs.length,
      repoCount: 0,
      requestKinds: ['space'],
    };
    const tree = isSpaceContext(spaceEnvelope.data)
      ? projectTreeFromSpaceContext(spaceEnvelope, observedAt)
      : readProjectTree(input.projectRoot, input.activeFile);
    collectProjectContextErrors(tree, spaceEnvelope);

    const folders = isSpaceContext(spaceEnvelope.data)
      ? selectProjectContextRepoFolders(spaceEnvelope.data, input.projectRoot)
      : [{ repoId: undefined, repoName: projectNameFromRoot(input.projectRoot), sourceFolder: '.' }];

    for (const folder of folders.slice(0, 6)) {
      const repoEnvelope = await executeMatrixProjectContextRequest(
        'repo',
        input.projectRoot,
        {
          includeCommands: true,
          includeEntrypoints: true,
          includeMapSummary: false,
          includeTopAreas: true,
          maxFiles: 180,
          repoName: folder.repoName,
          repoRoot: folder.sourceFolder,
        },
        {
          repoId: folder.repoId,
          sourceFolder: folder.sourceFolder,
        }
      );
      trace.requestKinds.push('repo');
      trace.errorCount += repoEnvelope.errors?.length ?? 0;
      trace.refCount += repoEnvelope.refs.length;
      trace.repoCount += 1;
      trace.partial = trace.partial || Boolean(repoEnvelope.errors?.length);
      collectProjectContextErrors(tree, repoEnvelope);
      if (!isRepoContext(repoEnvelope.data)) {
        continue;
      }
      addRepoContextToProjectTree(tree, repoEnvelope, observedAt);

      const moduleSeeds = createMatrixModuleSeeds(repoEnvelope.data);
      if (moduleSeeds.length > 0) {
        const mapEnvelope = await executeMatrixProjectContextRequest(
          'map',
          input.projectRoot,
          {
            includeCycles: true,
            includeExternalDeps: false,
            includeHotspots: true,
            includeMajorFlows: true,
            moduleSeeds,
            repoName: repoEnvelope.data.repo.name,
          },
          {
            repoId: folder.repoId,
            sourceFolder: folder.sourceFolder,
          }
        );
        trace.requestKinds.push('map');
        trace.errorCount += mapEnvelope.errors?.length ?? 0;
        trace.refCount += mapEnvelope.refs.length;
        trace.partial = trace.partial || Boolean(mapEnvelope.errors?.length);
        collectProjectContextErrors(tree, mapEnvelope);
        if (isProjectMapContext(mapEnvelope.data)) {
          addProjectMapToProjectTree(tree, mapEnvelope, observedAt);
        }
      }
    }

    tree.projectContext = {
      ...trace,
      requestKinds: uniqueProjectContextKinds(trace.requestKinds),
    };
    tree.detailRefs = dedupeDetailRefs(tree.detailRefs);
    tree.nodes = dedupeMatrixNodes(tree.nodes);
    tree.keyNodes = tree.nodes
      .filter((node) => node.type === 'project' || node.type === 'module' || node.type === 'package')
      .slice(0, MAX_KEY_NODES);
    tree.relations = dedupeRelationObjects(tree.relations);
    tree.sources = dedupeSources(tree.sources);
    tree.structuralHotspots = buildStructuralHotspots(tree.nodes);
    tree.diagnostics = dedupeDiagnostics(tree.diagnostics ?? []);
    return tree;
  } catch (error) {
    return {
      ...readProjectTree(input.projectRoot, input.activeFile),
      diagnostics: [
        {
          code: 'project-context-execution-failed',
          domain: 'project',
          message: `ProjectContext projection failed before matrix output: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable: true,
          severity: 'warning',
        },
      ],
      projectContext: {
        errorCount: 1,
        partial: true,
        refCount: 0,
        repoCount: 0,
        requestKinds: [],
      },
    };
  }
}

async function executeMatrixProjectContextRequest(
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

function projectTreeFromSpaceContext(
  envelope: ProjectContextEnvelope<ProjectContextResult>,
  observedAt: string
): RawProjectTree {
  const space = envelope.data as SpaceContext;
  const projectRoot = envelope.project.projectRoot;
  const projectName = space.space.displayName ?? envelope.project.displayName ?? projectNameFromRoot(projectRoot);
  const rootRef = envelope.refs.find((ref) => ref.kind === 'space') ?? space.nextRefs[0];
  const rootDetailRef = rootRef
    ? detailRefFromProjectContextRef(rootRef, 'alembic_project_matrix', 'project-context-space', observedAt)
    : defaultRefRegistry.createDetailRef({
        domain: 'project',
        freshness: { observedAt, policy: 'preferFresh' },
        id: projectRoot,
        operation: 'project-context-space',
        requiredForCompletion: true,
        summary: 'ProjectContext space query identified the project root.',
        title: projectName,
        tool: 'alembic_project_matrix',
        uri: projectRoot,
      });
  const rootNode: ProjectMatrixNode = {
    detailRefId: rootDetailRef.id,
    id: createMatrixNodeId('project', projectRoot),
    label: projectName,
    path: '.',
    summary: 'ProjectContext space root.',
    type: 'project',
  };
  const tree: RawProjectTree = {
    detailRefs: [rootDetailRef, ...envelope.refs.map((ref) => detailRefFromProjectContextRef(ref, 'alembic_project_matrix', 'project-context-space-ref', observedAt))],
    diagnostics: [],
    keyNodes: [rootNode],
    nodes: [rootNode],
    projectName,
    relations: [],
    sources: [sourceFromDetailRef(rootDetailRef, 'ProjectContext space root.')],
    structuralHotspots: [],
  };

  for (const folder of space.sourceFolders) {
    const relPath = normalizeProjectContextPath(folder.path);
    const folderRef = folder.repoRef ?? space.repos.find((repo) => repo.id === folder.repositoryId)?.ref;
    const detailRef = folderRef
      ? detailRefFromProjectContextRef(folderRef, 'alembic_project_matrix', 'project-context-source-folder', observedAt)
      : createProjectDetailRef(projectRoot, relPath, 'package', observedAt);
    const node: ProjectMatrixNode = {
      childCount: folder.missing ? 0 : undefined,
      detailRefId: detailRef.id,
      id: createMatrixNodeId('package', relPath),
      label: folder.displayName ?? (path.basename(relPath) || projectName),
      parentId: rootNode.id,
      path: relPath,
      summary: folder.missing
        ? 'ProjectContext source folder is missing.'
        : 'ProjectContext source folder.',
      type: 'package',
    };
    addMatrixNode(tree, node, rootNode, folder.missing ? 'missing' : 'partOf');
    tree.detailRefs.push(detailRef);
    tree.sources.push(sourceFromDetailRef(detailRef, node.summary));
  }

  for (const pathSummary of space.projectTree?.roots ?? []) {
    const relPath = normalizeProjectContextPath(pathSummary.path);
    if (relPath === '.') {
      continue;
    }
    const detailRef = pathSummary.ref
      ? detailRefFromProjectContextRef(pathSummary.ref, 'alembic_project_matrix', 'project-context-tree-root', observedAt)
      : createProjectDetailRef(projectRoot, relPath, 'directory', observedAt);
    addMatrixNode(
      tree,
      {
        detailRefId: detailRef.id,
        id: createMatrixNodeId('directory', relPath),
        label: path.basename(relPath) || relPath,
        parentId: rootNode.id,
        path: relPath,
        summary: pathSummary.role ?? 'ProjectContext project tree root.',
        type: 'directory',
      },
      rootNode
    );
    tree.detailRefs.push(detailRef);
  }

  return tree;
}

function addRepoContextToProjectTree(
  tree: RawProjectTree,
  envelope: ProjectContextEnvelope<ProjectContextResult>,
  observedAt: string
) {
  const repo = envelope.data as RepoContext;
  const repoPath = normalizeProjectContextPath(repo.repo.ref?.scope.sourceFolder ?? repo.repo.root ?? '.');
  const repoDetailRef = repo.repo.ref
    ? detailRefFromProjectContextRef(repo.repo.ref, 'alembic_project_matrix', 'project-context-repo', observedAt)
    : createProjectDetailRef(envelope.project.projectRoot, repoPath, 'package', observedAt);
  const repoNode: ProjectMatrixNode = {
    detailRefId: repoDetailRef.id,
    id: createMatrixNodeId('package', repoPath),
    label: repo.repo.name,
    path: repoPath,
    summary: 'ProjectContext repo boundary.',
    type: 'package',
  };
  const rootNode = tree.nodes.find((node) => node.type === 'project') ?? tree.nodes[0];
  addMatrixNode(tree, repoNode, rootNode);
  tree.detailRefs.push(repoDetailRef);

  for (const ref of envelope.refs) {
    tree.detailRefs.push(
      detailRefFromProjectContextRef(ref, 'alembic_project_matrix', 'project-context-repo-ref', observedAt)
    );
  }

  for (const item of repo.localPackages) {
    const relPath = normalizeProjectContextPath(item.path ?? item.ref?.scope.filePath ?? repoPath);
    const detailRef = item.ref
      ? detailRefFromProjectContextRef(item.ref, 'alembic_project_matrix', 'project-context-package', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'package', observedAt);
    addMatrixNode(
      tree,
      {
        detailRefId: detailRef.id,
        id: createMatrixNodeId('package', `${repoPath}:${item.name}:${relPath}`),
        label: item.name,
        parentId: repoNode.id,
        path: relPath,
        summary: 'ProjectContext local package.',
        type: 'package',
      },
      repoNode
    );
    tree.detailRefs.push(detailRef);
  }

  for (const item of [...repo.sourceRoots, ...repo.topAreas]) {
    const relPath = normalizeProjectContextPath(item.path);
    const detailRef = item.ref
      ? detailRefFromProjectContextRef(item.ref, 'alembic_project_matrix', 'project-context-area', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'module', observedAt);
    addMatrixNode(
      tree,
      {
        detailRefId: detailRef.id,
        id: createMatrixNodeId('module', `${repoPath}:${relPath}`),
        label: path.basename(relPath) || relPath,
        parentId: repoNode.id,
        path: relPath,
        summary: item.role ?? 'ProjectContext source area.',
        type: 'module',
      },
      repoNode
    );
    tree.detailRefs.push(detailRef);
  }

  for (const item of repo.entrypoints) {
    const ref = item.refs[0];
    const relPath = normalizeProjectContextPath(ref?.scope.filePath ?? item.name);
    const detailRef = ref
      ? detailRefFromProjectContextRef(ref, 'alembic_project_matrix', 'project-context-entrypoint', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'file', observedAt);
    const node = {
      detailRefId: detailRef.id,
      id: createMatrixNodeId('file', `${repoPath}:entrypoint:${relPath}`),
      label: item.name,
      parentId: repoNode.id,
      path: relPath,
      summary: `${item.kind} entrypoint from ProjectContext repo facts.`,
      type: 'file',
    };
    addMatrixNode(tree, node, repoNode, 'entrypointFor');
    tree.detailRefs.push(detailRef);
  }

  for (const item of [...repo.commands, ...repo.targets.map((target) => ({ command: target.kind ?? 'target', name: target.name, sourceRef: target.refs[0] }))]) {
    const relPath = normalizeProjectContextPath(item.sourceRef?.scope.filePath ?? 'package.json');
    const detailRef = item.sourceRef
      ? detailRefFromProjectContextRef(item.sourceRef, 'alembic_project_matrix', 'project-context-command', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'target', observedAt);
    addMatrixNode(
      tree,
      {
        detailRefId: detailRef.id,
        id: createMatrixNodeId('target', `${repoPath}:${item.name}`),
        label: item.name,
        parentId: repoNode.id,
        path: relPath,
        summary: 'ProjectContext command or target.',
        type: 'target',
      },
      repoNode
    );
    tree.detailRefs.push(detailRef);
  }

  for (const item of repo.configFiles) {
    const relPath = normalizeProjectContextPath(item.path);
    const detailRef = item.ref
      ? detailRefFromProjectContextRef(item.ref, 'alembic_project_matrix', 'project-context-config', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'file', observedAt);
    addMatrixNode(
      tree,
      {
        detailRefId: detailRef.id,
        id: createMatrixNodeId('file', `${repoPath}:config:${relPath}`),
        label: path.basename(relPath),
        parentId: repoNode.id,
        path: relPath,
        summary: `${item.kind} configuration file from ProjectContext.`,
        type: 'file',
      },
      repoNode
    );
    tree.detailRefs.push(detailRef);
  }
}

function addProjectMapToProjectTree(
  tree: RawProjectTree,
  envelope: ProjectContextEnvelope<ProjectContextResult>,
  observedAt: string
) {
  const map = envelope.data as ProjectMap;
  for (const ref of envelope.refs) {
    tree.detailRefs.push(
      detailRefFromProjectContextRef(ref, 'alembic_project_matrix', 'project-context-map-ref', observedAt)
    );
  }
  for (const moduleRecord of map.modules) {
    const relPath = normalizeProjectContextPath(moduleRecord.ref?.scope.filePath ?? moduleRecord.name);
    const detailRef = moduleRecord.ref
      ? detailRefFromProjectContextRef(moduleRecord.ref, 'alembic_project_matrix', 'project-context-map-module', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'module', observedAt);
    addMatrixNode(tree, {
      detailRefId: detailRef.id,
      id: createMatrixNodeId('module', moduleRecord.id),
      label: moduleRecord.name,
      path: relPath,
      summary: moduleRecord.role ?? 'ProjectContext map module.',
      type: 'module',
    });
    tree.detailRefs.push(detailRef);
  }
  for (const layer of map.layers) {
    const relPath = normalizeProjectContextPath(layer.ref?.scope.filePath ?? layer.name);
    const detailRef = layer.ref
      ? detailRefFromProjectContextRef(layer.ref, 'alembic_project_matrix', 'project-context-map-layer', observedAt)
      : createProjectDetailRef(envelope.project.projectRoot, relPath, 'module', observedAt);
    addMatrixNode(tree, {
      detailRefId: detailRef.id,
      id: createMatrixNodeId('module', layer.id),
      label: layer.name,
      path: relPath,
      summary: 'ProjectContext module layer.',
      type: 'module',
    });
    tree.detailRefs.push(detailRef);
  }
}

function collectProjectContextErrors(
  tree: RawProjectTree,
  envelope: ProjectContextEnvelope<ProjectContextResult>
) {
  const diagnostics = envelope.errors?.map(projectContextErrorToDiagnostic) ?? [];
  tree.diagnostics = [...(tree.diagnostics ?? []), ...diagnostics];
}

function selectProjectContextRepoFolders(space: SpaceContext, projectRoot: string) {
  const folders = space.sourceFolders.length > 0 ? space.sourceFolders : [];
  if (folders.length === 0) {
    return [{ repoId: undefined, repoName: projectNameFromRoot(projectRoot), sourceFolder: '.' }];
  }
  return folders.map((folder) => ({
    repoId: folder.repositoryId ?? folder.id,
    repoName: folder.displayName ?? folder.repositoryId ?? folder.id,
    sourceFolder: normalizeProjectContextPath(folder.path),
  }));
}

function createMatrixModuleSeeds(repo: RepoContext): Record<string, unknown>[] {
  const roots = [...repo.sourceRoots, ...repo.topAreas]
    .map((item) => normalizeProjectContextPath(item.path))
    .filter((item) => item !== '.' && item.length > 0);
  const uniqueRoots = uniqueStrings(roots).slice(0, 4);
  return uniqueRoots.map((modulePath) => ({
    moduleName: path.basename(modulePath) || modulePath,
    modulePath,
  }));
}

function addMatrixNode(
  tree: RawProjectTree,
  node: ProjectMatrixNode,
  parent?: ProjectMatrixNode,
  relationType = 'partOf'
) {
  if (!tree.nodes.some((item) => item.id === node.id)) {
    tree.nodes.push(node);
  }
  if (parent) {
    tree.relations.push({
      fromId: node.id,
      relationType,
      summary: `${node.label} belongs to ${parent.label}.`,
      toId: parent.id,
    });
  }
}

function detailRefFromProjectContextRef(
  ref: ProjectContextRef,
  tool: 'alembic_project_matrix',
  operation: string,
  observedAt: string
): KnowledgeContextDetailRef {
  const relPath = ref.scope.filePath ?? ref.scope.sourceFolder ?? '.';
  const title = ref.label ?? ref.id;
  return defaultRefRegistry.createDetailRef({
    domain: projectContextRefDomain(ref),
    freshness: { observedAt, policy: 'preferFresh' },
    id: ref.id,
    operation,
    summary: `${ref.kind} ProjectContext ref ${title}.`,
    title,
    tool,
    uri: path.join(ref.scope.projectRoot, relPath),
  });
}

function sourceFromDetailRef(
  ref: KnowledgeContextDetailRef,
  summary?: string
): KnowledgeContextSource {
  return {
    detailRefId: ref.id,
    domain: ref.domain,
    id: ref.ref ?? ref.id,
    summary: summary ?? ref.summary,
    title: ref.title,
  };
}

function projectContextRefDomain(ref: ProjectContextRef): KnowledgeContextSourceDomain {
  if (ref.kind === 'file' || ref.kind === 'path' || ref.kind === 'source-slice') {
    return 'document';
  }
  return 'project';
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

function projectContextDiagnostic(code: string): KnowledgeContextDiagnostic {
  return {
    code,
    domain: 'project',
    message: 'ProjectContext could not run because projectRoot was not available.',
    retryable: true,
    severity: 'warning',
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

function normalizeProjectContextPath(value: string | undefined): string {
  if (!value || value === '') {
    return '.';
  }
  return toPosixPath(value).replace(/^\.\//, '') || '.';
}

function uniqueProjectContextKinds(
  values: ProjectContextRequestKind[]
): ProjectContextRequestKind[] {
  return [...new Set(values)].sort();
}

function dedupeMatrixNodes(nodes: ProjectMatrixNode[]): ProjectMatrixNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function dedupeRelationObjects(relations: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    ...new Map(
      relations.map((relation) => [
        `${String(relation.fromId)}\u0000${String(relation.relationType)}\u0000${String(relation.toId)}`,
        relation,
      ])
    ).values(),
  ];
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

interface OperationSelectionInput {
  catalog: KnowledgeCatalog;
  nodeId?: string;
  nodeType?: string;
  sourceEvidenceRefs: string[];
  tree: RawProjectTree;
}

interface OperationSelection {
  items: Record<string, unknown>[];
  layers: Record<string, unknown>[];
  matrixNodes: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  requestedNode?: ProjectMatrixNode;
  requestedNodeFound: boolean;
  sourceSummaries: Record<string, unknown>[];
  statusHint?: string;
}

function readProjectTree(projectRoot?: string, activeFile?: string): RawProjectTree {
  const now = new Date().toISOString();
  const rootExists =
    projectRoot !== undefined && existsSync(projectRoot) && isDirectory(projectRoot);
  const projectName = rootExists ? readProjectName(projectRoot) : projectNameFromRoot(projectRoot);
  const rootDetailRef = defaultRefRegistry.createDetailRef({
    domain: 'project',
    freshness: { observedAt: now, policy: 'preferFresh' },
    id: projectRoot ?? 'unknown-project',
    operation: 'project-matrix-root',
    requiredForCompletion: true,
    summary: rootExists
      ? 'Project root sampled for a compact project matrix.'
      : 'Project root was not available; matrix data is partial.',
    title: projectName,
    uri: projectRoot,
    tool: 'alembic_project_matrix',
  });
  const rootNode: ProjectMatrixNode = {
    detailRefId: rootDetailRef.id,
    id: createMatrixNodeId('project', projectRoot ?? 'unknown-project'),
    label: projectName,
    path: '.',
    summary: rootExists ? 'Project root.' : 'Unknown or unavailable project root.',
    type: 'project',
  };

  if (!rootExists || projectRoot === undefined) {
    return createUnavailableProjectTree(rootDetailRef, rootNode, projectName);
  }

  const { detailRefs, nodes, relations } = collectProjectTreeParts({
    activeFile,
    observedAt: now,
    projectRoot,
    rootDetailRef,
    rootNode,
  });
  const keyNodes = nodes
    .filter((node) => node.type === 'project' || node.type === 'module' || node.type === 'package')
    .slice(0, MAX_KEY_NODES);

  return {
    detailRefs: dedupeDetailRefs(detailRefs),
    keyNodes,
    nodes,
    projectName,
    relations,
    sources: buildProjectTreeSources(rootDetailRef, rootNode, projectName, detailRefs),
    structuralHotspots: buildStructuralHotspots(nodes),
  };
}

function createUnavailableProjectTree(
  rootDetailRef: KnowledgeContextDetailRef,
  rootNode: ProjectMatrixNode,
  projectName: string
): RawProjectTree {
  return {
    detailRefs: [rootDetailRef],
    keyNodes: [rootNode],
    nodes: [rootNode],
    projectName,
    relations: [],
    sources: [
      {
        detailRefId: rootDetailRef.id,
        domain: 'project',
        id: rootNode.id,
        summary: rootNode.summary,
        title: rootNode.label,
      },
    ],
    structuralHotspots: [],
  };
}

function collectProjectTreeParts(input: {
  activeFile?: string;
  observedAt: string;
  projectRoot: string;
  rootDetailRef: KnowledgeContextDetailRef;
  rootNode: ProjectMatrixNode;
}): {
  detailRefs: KnowledgeContextDetailRef[];
  nodes: ProjectMatrixNode[];
  relations: Record<string, unknown>[];
} {
  const { activeFile, observedAt, projectRoot, rootDetailRef, rootNode } = input;
  const nodes = [rootNode];
  const relations: Record<string, unknown>[] = [];
  const detailRefs = [rootDetailRef];
  const entries = readProjectTreeTopLevelEntries(projectRoot).slice(0, MAX_TOP_LEVEL_NODES);

  for (const entry of entries) {
    const relPath = entry.name;
    const childCount = entry.isDirectory ? countVisibleChildren(entry.absolutePath) : undefined;
    const type = classifyNodeType(relPath, entry.isDirectory);
    const detailRef = createProjectDetailRef(projectRoot, relPath, type, observedAt);
    detailRefs.push(detailRef);
    const node: ProjectMatrixNode = {
      childCount,
      depth: 1,
      detailRefId: detailRef.id,
      id: createMatrixNodeId(type, relPath),
      label: relPath,
      parentId: rootNode.id,
      path: relPath,
      summary: summarizeProjectNode(relPath, type, childCount),
      type,
    };
    nodes.push(node);
    relations.push(createPartOfRelation(node, rootNode));

    if (entry.isDirectory) {
      const childNodes = readDirectoryChildren(projectRoot, relPath, node.id, observedAt);
      for (const childNode of childNodes) {
        nodes.push(childNode);
        relations.push(createPartOfRelation(childNode, node));
      }
      detailRefs.push(
        ...childNodes
          .filter((childNode) => childNode.detailRefId !== undefined)
          .map((childNode) =>
            createProjectDetailRef(
              projectRoot,
              childNode.path ?? childNode.label,
              childNode.type,
              observedAt
            )
          )
      );
    }
  }

  const activeFileNode = createActiveFileNode(projectRoot, activeFile, rootNode.id, observedAt);
  if (activeFileNode) {
    nodes.push(activeFileNode.node);
    relations.push(createPartOfRelation(activeFileNode.node, rootNode));
    detailRefs.push(activeFileNode.detailRef);
  }

  return {
    detailRefs,
    nodes,
    relations,
  };
}

function readProjectTreeTopLevelEntries(projectRoot: string): ProjectTreeTopLevelEntry[] {
  const scopeFolders = resolveProjectScopeSourceFolders(projectRoot);
  if (scopeFolders.length > 0) {
    return scopeFolders.map((folder) => ({
      absolutePath: folder.absolutePath,
      isDirectory: true,
      name: folder.relativePath,
    }));
  }

  return readSortedEntries(projectRoot)
    .filter(isVisibleProjectEntry)
    .filter((entry) => IMPORTANT_TOP_LEVEL_NAMES.has(entry.name) || entry.isDirectory())
    .map((entry) => ({
      absolutePath: path.join(projectRoot, entry.name),
      isDirectory: entry.isDirectory(),
      name: entry.name,
    }));
}

function buildProjectTreeSources(
  rootDetailRef: KnowledgeContextDetailRef,
  rootNode: ProjectMatrixNode,
  projectName: string,
  detailRefs: KnowledgeContextDetailRef[]
): KnowledgeContextSource[] {
  return [
    {
      detailRefId: rootDetailRef.id,
      domain: 'project',
      id: rootNode.id,
      summary: 'Filesystem-derived project matrix. It is a bounded sample, not a full file list.',
      title: projectName,
    },
    ...detailRefs
      .filter((ref) => ref.domain === 'document')
      .slice(0, 4)
      .map((ref) => ({
        detailRefId: ref.id,
        domain: 'document' as const,
        id: ref.id,
        summary: ref.summary,
        title: ref.title,
      })),
  ];
}

function readDirectoryChildren(
  projectRoot: string,
  relDir: string,
  parentId: string,
  observedAt: string
): ProjectMatrixNode[] {
  const absDir = path.join(projectRoot, relDir);
  return readSortedEntries(absDir)
    .filter(isVisibleProjectEntry)
    .slice(0, MAX_CHILDREN_PER_DIRECTORY)
    .map((entry) => {
      const relPath = path.join(relDir, entry.name);
      const normalizedRelPath = toPosixPath(relPath);
      const type = classifyNodeType(normalizedRelPath, entry.isDirectory());
      const detailRef = createProjectDetailRef(projectRoot, normalizedRelPath, type, observedAt);
      const childCount = entry.isDirectory()
        ? countVisibleChildren(path.join(projectRoot, relPath))
        : undefined;
      return {
        childCount,
        depth: 2,
        detailRefId: detailRef.id,
        id: createMatrixNodeId(type, normalizedRelPath),
        label: entry.name,
        parentId,
        path: normalizedRelPath,
        summary: summarizeProjectNode(normalizedRelPath, type, childCount),
        type,
      };
    });
}

function createActiveFileNode(
  projectRoot: string,
  activeFile: string | undefined,
  parentId: string,
  observedAt: string
): { detailRef: KnowledgeContextDetailRef; node: ProjectMatrixNode } | null {
  if (!activeFile) {
    return null;
  }
  const relPath = path.isAbsolute(activeFile)
    ? toPosixPath(path.relative(projectRoot, activeFile))
    : toPosixPath(activeFile);
  if (!relPath || relPath.startsWith('..')) {
    return null;
  }
  const detailRef = createProjectDetailRef(projectRoot, relPath, 'file', observedAt);
  return {
    detailRef,
    node: {
      depth: 1,
      detailRefId: detailRef.id,
      id: createMatrixNodeId('file', relPath),
      label: path.basename(relPath),
      parentId,
      path: relPath,
      summary: 'Active file carried into the project matrix.',
      type: 'file',
    },
  };
}

function buildKnowledgeCatalog(
  entries: ProjectMatrixKnowledgeEntry[],
  sourceRefs: string[]
): KnowledgeCatalog {
  const now = new Date().toISOString();
  const groups = new Map<string, ProjectMatrixKnowledgeEntry[]>();
  for (const entry of entries) {
    const category = normalizeKnowledgeCatalogCategory(entry);
    groups.set(category, [...(groups.get(category) ?? []), entry]);
  }
  for (const sourceRef of sourceRefs) {
    if (entries.some((entry) => entry.id === sourceRef)) {
      continue;
    }
    const sourceEntry = {
      category: 'input-source-ref',
      id: sourceRef,
      title: sourceRef,
    };
    groups.set(sourceEntry.category, [...(groups.get(sourceEntry.category) ?? []), sourceEntry]);
  }

  const categories = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_KNOWLEDGE_CATEGORIES)
    .map(([category, categoryEntries]) => {
      const representative = categoryEntries.slice(0, MAX_REPRESENTATIVE_REFS);
      return {
        category,
        count: categoryEntries.length,
        kinds: uniqueStrings(categoryEntries.map((entry) => entry.kind).filter(isNonEmptyString)),
        representativeRefs: representative.map((entry) => createKnowledgeRef(entry.id)),
        titles: representative.map((entry) => entry.title ?? entry.id),
      };
    });

  const representativeEntries = entries.slice(0, MAX_KNOWLEDGE_CATEGORIES);
  const detailRefs = representativeEntries.map((entry) =>
    defaultRefRegistry.createDetailRef({
      domain: 'knowledge',
      freshness: { observedAt: now, policy: 'preferFresh' },
      id: createKnowledgeRef(entry.id),
      operation: 'knowledge-catalog-ref',
      summary: summarizeKnowledgeEntry(entry),
      title: entry.title ?? entry.id,
      tool: 'alembic_project_matrix',
    })
  );

  return {
    categories,
    detailRefs,
    itemCount: entries.length || sourceRefs.length,
    items: categories.map((category) => ({
      kind: 'knowledge-category',
      ...category,
    })),
    sources: [
      ...representativeEntries.slice(0, MAX_REPRESENTATIVE_REFS).map((entry) => ({
        detailRefId: detailRefs.find((ref) => ref.id.includes(stableRefSegment(entry.id)))?.id,
        domain: 'knowledge' as const,
        id: createKnowledgeRef(entry.id),
        summary: summarizeKnowledgeEntry(entry),
        title: entry.title ?? entry.id,
      })),
      ...sourceRefs.slice(0, MAX_REPRESENTATIVE_REFS).map((sourceRef) => ({
        domain: 'knowledge' as const,
        id: sourceRef,
        summary: 'Input source ref carried into the project matrix knowledge catalog.',
      })),
    ],
  };
}

function selectOperationView(
  operation: string,
  input: OperationSelectionInput
): OperationSelection {
  const baseSources = [
    {
      domain: 'project',
      state: 'derived',
      summary: 'Project hierarchy is sampled from top-level and key child directories.',
    },
    {
      domain: 'knowledge',
      itemCount: input.catalog.itemCount,
      summary:
        input.catalog.itemCount > 0
          ? 'Knowledge catalog categories are summarized from representative Recipe metadata.'
          : 'Knowledge catalog metadata was not available; output remains partial.',
    },
    {
      domain: 'projectContext',
      partial: input.tree.projectContext?.partial ?? false,
      refCount: input.tree.projectContext?.refCount ?? 0,
      summary:
        input.tree.projectContext && input.tree.projectContext.refCount > 0
          ? 'ProjectContext producer refs are available for bounded project orientation.'
          : 'ProjectContext refs are partial; matrix falls back to bounded project structure.',
    },
  ];
  const layers = buildLayers(input.tree.nodes, input.catalog);

  if (operation === 'catalog') {
    return {
      items: input.catalog.items,
      layers: [],
      matrixNodes: toMatrixObjects(input.tree.keyNodes),
      relations: [],
      requestedNodeFound: true,
      sourceSummaries: baseSources,
    };
  }

  if (operation === 'sources') {
    return {
      items: [],
      layers: [],
      matrixNodes: toMatrixObjects(input.tree.keyNodes),
      relations: [],
      requestedNodeFound: true,
      sourceSummaries: [
        ...baseSources,
        ...input.sourceEvidenceRefs.map((ref) => ({
          domain: 'recipeRelation',
          ref,
          state: 'provided',
        })),
      ],
    };
  }

  if (operation === 'layers') {
    return {
      items: [],
      layers,
      matrixNodes: toMatrixObjects(input.tree.keyNodes),
      relations: [],
      requestedNodeFound: true,
      sourceSummaries: baseSources,
    };
  }

  if (operation === 'relations') {
    return {
      items: [],
      layers: [],
      matrixNodes: toMatrixObjects(input.tree.keyNodes),
      relations: input.tree.relations,
      requestedNodeFound: true,
      sourceSummaries: baseSources,
    };
  }

  if (operation === 'node') {
    const requestedNode = findRequestedNode(input.tree.nodes, input.nodeId, input.nodeType);
    if (!requestedNode) {
      return {
        items: [],
        layers: [],
        matrixNodes: toMatrixObjects(input.tree.keyNodes.slice(0, 4)),
        relations: [],
        requestedNodeFound: false,
        sourceSummaries: baseSources,
        statusHint: 'requested-node-not-found',
      };
    }
    const directNodes = input.tree.nodes.filter(
      (node) => node.id === requestedNode.id || node.parentId === requestedNode.id
    );
    const parentRelations = input.tree.relations.filter(
      (relation) =>
        relation.fromId === requestedNode.id ||
        relation.toId === requestedNode.id ||
        directNodes.some((node) => relation.fromId === node.id || relation.toId === node.id)
    );
    return {
      items: [],
      layers: [],
      matrixNodes: toMatrixObjects(directNodes),
      relations: parentRelations,
      requestedNode,
      requestedNodeFound: true,
      sourceSummaries: baseSources,
    };
  }

  return {
    items: input.catalog.items,
    layers,
    matrixNodes: toMatrixObjects(input.tree.nodes),
    relations: input.tree.relations.slice(0, 80),
    requestedNodeFound: true,
    sourceSummaries: baseSources,
  };
}

function buildDomainFreshness(input: {
  catalog: KnowledgeCatalog;
  projectRoot?: string;
  projectTree: RawProjectTree;
  requestedNodeFound: boolean;
  sourceEvidenceRefs: string[];
}): Partial<Record<KnowledgeContextSourceDomain, Partial<KnowledgeContextDomainFreshness>>> {
  return {
    document: input.projectTree.sources.some((source) => source.domain === 'document')
      ? { state: 'ready' }
      : {
          degradedReason: 'No README/package document source was available for the project matrix.',
          state: 'partial',
        },
    knowledge:
      input.catalog.itemCount > 0
        ? { state: 'ready' }
        : {
            degradedReason:
              'Knowledge catalog metadata was unavailable or empty; matrix returned project structure only.',
            state: 'partial',
          },
    project:
      input.projectRoot !== undefined &&
      existsSync(input.projectRoot) &&
      input.projectTree.nodes.length > 1 &&
      input.requestedNodeFound
        ? { state: 'ready' }
        : {
            degradedReason:
              input.projectRoot === undefined || !existsSync(input.projectRoot)
                ? 'Project root was not supplied or resolvable.'
                : 'Requested project matrix node was not available in the bounded matrix sample.',
            state:
              input.projectRoot === undefined || !existsSync(input.projectRoot)
                ? 'missing'
                : 'partial',
          },
    recipeRelation:
      input.sourceEvidenceRefs.length > 0
        ? { state: 'ready' }
        : {
            degradedReason:
              'No recipe relation/source evidence refs were supplied; relation summary is partial.',
            state: 'partial',
          },
  };
}

function buildLayers(
  nodes: ProjectMatrixNode[],
  catalog: KnowledgeCatalog
): Record<string, unknown>[] {
  const byType = new Map<string, ProjectMatrixNode[]>();
  for (const node of nodes) {
    byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
  }
  const structuralLayers = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, layerNodes]) => ({
      count: layerNodes.length,
      representativeNodeIds: layerNodes.slice(0, MAX_REPRESENTATIVE_REFS).map((node) => node.id),
      type,
    }));
  return [
    ...structuralLayers,
    {
      count: catalog.itemCount,
      representativeCategories: catalog.categories
        .slice(0, MAX_REPRESENTATIVE_REFS)
        .map((category) => category.category),
      type: 'knowledge-catalog',
    },
  ];
}

function buildNextActions(selection: OperationSelection): KnowledgeContextNextAction[] {
  const firstNode = selection.matrixNodes.find((node) => typeof node.id === 'string');
  return [
    ...(firstNode
      ? [
          {
            detailRefId:
              typeof firstNode.detailRefId === 'string' ? firstNode.detailRefId : undefined,
            operation: 'node',
            reason: 'Expand one matrix node when the caller needs local hierarchy detail.',
            refId: String(firstNode.id),
            required: false,
            tool: 'alembic_project_matrix' as const,
          },
        ]
      : []),
    {
      operation: 'search',
      reason: 'Use Recipe search for detailed knowledge items referenced by the catalog.',
      required: false,
      tool: 'alembic_search',
    },
    {
      operation: 'neighborhood',
      reason:
        'Use project graph for focused ProjectContext-backed relationship detail.',
      required: false,
      tool: 'alembic_graph',
    },
  ];
}

function toMatrixObjects(nodes: ProjectMatrixNode[]): Record<string, unknown>[] {
  return nodes.map((node) => ({ ...node }));
}

function buildStructuralHotspots(nodes: ProjectMatrixNode[]): Record<string, unknown>[] {
  return nodes
    .filter((node) => node.depth === 1 && node.childCount !== undefined)
    .sort((a, b) => (b.childCount ?? 0) - (a.childCount ?? 0))
    .slice(0, MAX_HOTSPOTS)
    .map((node) => ({
      childCount: node.childCount,
      nodeId: node.id,
      path: node.path,
      type: node.type,
    }));
}

function findRequestedNode(
  nodes: ProjectMatrixNode[],
  nodeId?: string,
  nodeType?: string
): ProjectMatrixNode | undefined {
  if (nodeId) {
    return nodes.find((node) => node.id === nodeId || node.detailRefId === nodeId);
  }
  if (nodeType) {
    return nodes.find((node) => node.type === nodeType);
  }
  return nodes[0];
}

function summarizeOperation(
  operation: string,
  input: {
    categoryCount: number;
    nodeCount: number;
    projectName?: string;
    statusHint?: string;
  }
): string {
  if (input.statusHint === 'requested-node-not-found') {
    return `Project matrix node was not found in the bounded ${input.projectName ?? 'project'} matrix sample.`;
  }
  const projectContextText = 'ProjectContext orientation with bounded refs';
  if (operation === 'catalog') {
    return `Project knowledge catalog summary for ${input.projectName ?? 'project'}: ${input.categoryCount} categories, ${projectContextText}.`;
  }
  if (operation === 'node') {
    return `Project matrix node summary for ${input.projectName ?? 'project'}: ${input.nodeCount} bounded nodes, ${projectContextText}.`;
  }
  return `Project matrix ${operation} for ${input.projectName ?? 'project'}: ${input.nodeCount} bounded nodes, ${input.categoryCount} knowledge categories, ${projectContextText}.`;
}

function readSortedEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

function isVisibleProjectEntry(entry: { name: string }): boolean {
  return !EXCLUDED_TOP_LEVEL_NAMES.has(entry.name) && !isLowValueProjectEntryName(entry.name);
}

function isLowValueProjectEntryName(name: string): boolean {
  return (
    name.startsWith('.') || name.endsWith('~') || name.endsWith('.swp') || name.endsWith('.tmp')
  );
}

function readProjectName(projectRoot: string): string {
  const packagePath = path.join(projectRoot, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        return parsed.name.trim();
      }
    } catch {
      // Fall back to folder name below.
    }
  }
  return projectNameFromRoot(projectRoot);
}

function projectNameFromRoot(projectRoot?: string): string {
  if (!projectRoot) {
    return 'Unknown project';
  }
  return path.basename(projectRoot) || projectRoot;
}

function countVisibleChildren(dir: string): number {
  return readSortedEntries(dir).filter(isVisibleProjectEntry).length;
}

function createPartOfRelation(
  child: ProjectMatrixNode,
  parent: ProjectMatrixNode
): Record<string, unknown> {
  return {
    fromId: child.id,
    relationType: child.type === 'file' ? 'ownsFile' : 'partOf',
    summary: `${child.label} belongs to ${parent.label}.`,
    toId: parent.id,
  };
}

function createProjectDetailRef(
  projectRoot: string,
  relPath: string,
  type: string,
  observedAt: string
): KnowledgeContextDetailRef {
  const domain = type === 'file' && isDocumentLikePath(relPath) ? 'document' : 'project';
  return defaultRefRegistry.createDetailRef({
    domain,
    freshness: { observedAt, policy: 'preferFresh' },
    id: `${type}:${relPath}`,
    operation: 'project-matrix-node',
    summary: summarizeProjectNode(relPath, type),
    title: relPath,
    uri: path.join(projectRoot, relPath),
    tool: 'alembic_project_matrix',
  });
}

function summarizeProjectNode(relPath: string, type: string, childCount?: number): string {
  const childText = childCount === undefined ? '' : ` with ${childCount} visible children`;
  return `${type} node ${relPath}${childText}.`;
}

function classifyNodeType(relPath: string, directory: boolean): string {
  if (!directory) {
    return 'file';
  }
  const first = relPath.split('/')[0] ?? relPath;
  if (first === 'packages' || first === 'plugins') {
    return relPath === first ? 'package' : 'module';
  }
  if (first === 'lib' || first === 'src') {
    return relPath === first ? 'module' : 'directory';
  }
  if (first === 'test' || first === 'tests') {
    return 'target';
  }
  if (first === 'skills' || first === 'scripts' || first === 'bin') {
    return 'module';
  }
  return 'directory';
}

function isDocumentLikePath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return base.startsWith('readme') || base === 'agents.md' || base.endsWith('.md');
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function createMatrixNodeId(type: string, value: string): string {
  return `matrix:${type}:${stableRefSegment(toPosixPath(value))}`.slice(0, 240);
}

function createKnowledgeRef(id: string): string {
  return id.startsWith('knowledge:') || id.startsWith('recipe:')
    ? id.slice(0, 240)
    : `knowledge:${stableRefSegment(id)}`.slice(0, 240);
}

function summarizeKnowledgeEntry(entry: ProjectMatrixKnowledgeEntry): string {
  const title = entry.title ?? entry.id;
  const category = entry.category ?? entry.kind ?? 'uncategorized';
  const description = entry.description ? `: ${entry.description.slice(0, 160)}` : '';
  return `Knowledge catalog representative ${title} (${category})${description}.`;
}

function normalizePublicLabel(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 120) : 'uncategorized';
}

function normalizeKnowledgeCatalogCategory(entry: ProjectMatrixKnowledgeEntry): string {
  const original = normalizePublicLabel(entry.category ?? entry.kind ?? 'uncategorized');
  if (!COARSE_KNOWLEDGE_CATEGORIES.has(original.toLowerCase())) {
    return original;
  }
  const text = [entry.title, entry.description, entry.id, entry.kind, entry.language]
    .filter(isNonEmptyString)
    .join(' ')
    .toLowerCase();
  if (/\b(wakeflow|dispatch|controller|target|task[- ]?package|delivery)\b/.test(text)) {
    return 'Wakeflow';
  }
  if (/\b(source[- ]?graph|symbol|caller|callee|impact|validation[- ]?plan)\b/.test(text)) {
    return 'Source Graph';
  }
  if (/\b(mcp|tool|structuredcontent|catalog|public[- ]?surface)\b/.test(text)) {
    return 'MCP';
  }
  if (/\b(runtime|daemon|resident|session|project[- ]?scope|bootstrap)\b/.test(text)) {
    return 'Runtime';
  }
  if (/\b(boundary|scope|repo|repository|workspace|root)\b/.test(text)) {
    return 'Boundary';
  }
  if (/\b(skill|agents\.md|readme|docs?|documentation)\b/.test(text)) {
    return 'Docs/Skills';
  }
  if (/\b(recipe|knowledge|guard|decision|prime|search)\b/.test(text)) {
    return 'Knowledge';
  }
  return original;
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

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function dedupeDetailRefs(refs: KnowledgeContextDetailRef[]): KnowledgeContextDetailRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.id)) {
      return false;
    }
    seen.add(ref.id);
    return true;
  });
}

export const defaultProjectMatrixProvider = new FileSystemProjectMatrixProvider();
