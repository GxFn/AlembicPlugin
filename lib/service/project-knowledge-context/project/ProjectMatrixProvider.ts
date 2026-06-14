import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
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
  sourceGraphRef?: string;
  sourceRefs?: string[];
}

export interface ProjectMatrixProviderResult {
  detailRefs: KnowledgeContextDetailRef[];
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
  resolveMatrix(input: ProjectMatrixResolveInput): ProjectMatrixProviderResult;
  resolveMatrixNodes(projectRoot?: string): ProjectMatrixNode[];
}

interface RawProjectTree {
  detailRefs: KnowledgeContextDetailRef[];
  keyNodes: ProjectMatrixNode[];
  nodes: ProjectMatrixNode[];
  projectName?: string;
  relations: Record<string, unknown>[];
  sources: KnowledgeContextSource[];
  structuralHotspots: Record<string, unknown>[];
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
  resolveMatrix(input: ProjectMatrixResolveInput): ProjectMatrixProviderResult {
    const operation = input.operation ?? 'overview';
    const tree = readProjectTree(input.projectRoot, input.activeFile);
    const catalog = buildKnowledgeCatalog(input.knowledgeEntries ?? [], input.sourceRefs ?? []);
    const sourceGraphStatus = buildSourceGraphStatus(input.sourceGraphRef);
    const selected = selectOperationView(operation, {
      catalog,
      nodeId: input.nodeId,
      nodeType: input.nodeType,
      sourceEvidenceRefs: input.sourceEvidenceRefs ?? [],
      sourceGraphStatus,
      tree,
    });
    const domainFreshness = buildDomainFreshness({
      catalog,
      projectRoot: input.projectRoot,
      projectTree: tree,
      requestedNodeFound: selected.requestedNodeFound,
      sourceEvidenceRefs: input.sourceEvidenceRefs ?? [],
      sourceGraphRef: input.sourceGraphRef,
    });
    const projectName = tree.projectName ?? projectNameFromRoot(input.projectRoot);
    const summary = summarizeOperation(operation, {
      categoryCount: catalog.categories.length,
      nodeCount: selected.matrixNodes.length,
      projectName,
      sourceGraphStatus,
      statusHint: selected.statusHint,
    });

    return {
      detailRefs: [...tree.detailRefs, ...catalog.detailRefs],
      domainFreshness,
      inventory: {
        catalogCategories: catalog.categories.map(({ category, count, representativeRefs }) => ({
          category,
          count,
          representativeRefs,
        })),
        keyNodeCount: tree.keyNodes.length,
        operation,
        projectName,
        projectRoot: input.projectRoot,
        sourceGraphStatus,
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
        sourceGraphStatus,
        sources: selected.sourceSummaries,
        structuralHotspots: tree.structuralHotspots,
      },
      sources: [...tree.sources, ...catalog.sources, sourceGraphStatus.source],
      summary,
    };
  }

  resolveMatrixNodes(projectRoot?: string): ProjectMatrixNode[] {
    return readProjectTree(projectRoot).nodes;
  }
}

interface OperationSelectionInput {
  catalog: KnowledgeCatalog;
  nodeId?: string;
  nodeType?: string;
  sourceEvidenceRefs: string[];
  sourceGraphStatus: SourceGraphStatus;
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

interface SourceGraphStatus {
  ref?: string;
  source: KnowledgeContextSource;
  state: 'ready' | 'partial';
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
      domain: 'sourceGraph',
      ref: input.sourceGraphStatus.ref,
      state: input.sourceGraphStatus.state,
      summary:
        input.sourceGraphStatus.state === 'ready'
          ? 'Caller supplied a source graph ref/status.'
          : 'No source graph ref was supplied; source graph status is partial.',
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
  sourceGraphRef?: string;
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
    sourceGraph:
      input.sourceGraphRef !== undefined
        ? { sourceRef: input.sourceGraphRef, state: 'ready' }
        : {
            degradedReason:
              'No sourceGraphRef was supplied; source graph status is reported as partial.',
            state: 'partial',
          },
  };
}

function buildSourceGraphStatus(sourceGraphRef?: string): SourceGraphStatus {
  if (sourceGraphRef) {
    return {
      ref: sourceGraphRef,
      source: {
        domain: 'sourceGraph',
        id: sourceGraphRef,
        summary: 'Source graph ref supplied by the caller and carried into project matrix output.',
      },
      state: 'ready',
    };
  }
  return {
    source: {
      domain: 'sourceGraph',
      id: 'source-graph:unavailable',
      summary:
        'No source graph ref was supplied; project matrix used bounded filesystem structure.',
    },
    state: 'partial',
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
        'Use project graph for focused internal relationship detail when source graph data exists.',
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
    sourceGraphStatus: SourceGraphStatus;
    statusHint?: string;
  }
): string {
  if (input.statusHint === 'requested-node-not-found') {
    return `Project matrix node was not found in the bounded ${input.projectName ?? 'project'} matrix sample.`;
  }
  const sourceGraphText =
    input.sourceGraphStatus.state === 'ready' ? 'source graph ref present' : 'source graph partial';
  if (operation === 'catalog') {
    return `Project knowledge catalog summary for ${input.projectName ?? 'project'}: ${input.categoryCount} categories, ${sourceGraphText}.`;
  }
  if (operation === 'node') {
    return `Project matrix node summary for ${input.projectName ?? 'project'}: ${input.nodeCount} bounded nodes, ${sourceGraphText}.`;
  }
  return `Project matrix ${operation} for ${input.projectName ?? 'project'}: ${input.nodeCount} bounded nodes, ${input.categoryCount} knowledge categories, ${sourceGraphText}.`;
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
