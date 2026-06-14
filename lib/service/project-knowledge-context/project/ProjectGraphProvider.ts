import fs from 'node:fs';
import path from 'node:path';
import type {
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
  resolveProjectGraph(input: ProjectGraphInput): ProjectGraphResult;
  resolveProjectRelations(projectRoot?: string): ProjectGraphRelation[];
}

interface GraphBuild {
  detailRefs: KnowledgeContextDetailRef[];
  nodes: ProjectGraphNode[];
  projectRef: KnowledgeContextDetailRef;
  relations: ProjectGraphRelation[];
  sources: KnowledgeContextSource[];
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
  'source-graph-node',
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

export class FileSystemProjectGraphProvider implements ProjectGraphProvider {
  resolveProjectGraph(input: ProjectGraphInput): ProjectGraphResult {
    const projectRoot = input.projectRoot ?? process.cwd();
    const build = this.buildGraph(projectRoot, input.sourceGraphRef);
    const operation = input.operation ?? 'query';
    const selection = selectGraph(build, input);
    const summary = summarizeSelection(operation, selection, input.sourceGraphRef);
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
        sourceGraph: input.sourceGraphRef
          ? { state: 'ready', sourceRef: input.sourceGraphRef }
          : {
              state: 'partial',
              degradedReason:
                'No sourceGraphRef was supplied; alembic_graph returned a bounded project/source scan instead of resident source graph facts.',
            },
      },
      projectNodes,
      sourceGraphSupported: Boolean(input.sourceGraphRef),
    };

    return {
      payload: {
        detailRefs: build.detailRefs,
        inventory: {
          allowedNodeTypes: [...ALLOWED_NODE_TYPES],
          allowedRelationTypes: [...ALLOWED_RELATION_TYPES],
          nodeCount: build.nodes.length,
          nodeTypes: countBy(build.nodes, (node) => node.nodeType),
          relationCount: build.relations.length,
          relationTypes: countBy(build.relations, (relation) => relation.relationType),
          sourceGraphStatus: input.sourceGraphRef ? 'linked' : 'not-supplied',
        },
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
    return this.buildGraph(projectRoot ?? process.cwd()).relations;
  }

  private buildGraph(projectRoot: string, sourceGraphRef?: string): GraphBuild {
    const packageInfo = readPackageInfo(projectRoot);
    const projectName = packageInfo.name ?? path.basename(projectRoot) ?? 'project';
    const projectId = `project:${stableRefSegment(projectName) || 'project'}`;
    const projectRef = defaultRefRegistry.createDetailRef({
      domain: 'project',
      id: projectId,
      operation: 'project-graph',
      requiredForCompletion: true,
      summary:
        'Bounded project graph derived from package metadata, directory structure, local import/export statements, and optional sourceGraphRef.',
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

    const files = walkProject(projectRoot);
    addDirectoryAndFileNodes(nodes, relations, projectId, files);
    addImportAndSymbolEdges(projectRoot, files, nodes, relations);

    if (sourceGraphRef) {
      const sourceGraphId = `source-graph-node:${stableRefSegment(sourceGraphRef)}`;
      nodes.add({ id: sourceGraphId, label: sourceGraphRef, nodeType: 'source-graph-node' });
      relations.add(nodes, sourceGraphId, 'partOf', projectId);
    }

    return {
      detailRefs: [projectRef],
      nodes: nodes.values(),
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
        ...(sourceGraphRef
          ? [
              {
                domain: 'sourceGraph' as const,
                id: sourceGraphRef,
                summary: 'Caller supplied a sourceGraphRef for resident/source-graph freshness.',
              },
            ]
          : []),
      ],
    };
  }
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
      insufficientSourceGraph:
        !input.sourceGraphRef && input.query !== undefined && items.length === 0,
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
      sourceGraphRequiredForImpact: !input.sourceGraphRef,
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
        'A concrete nodeId or sourceGraphRef is required before alembic_graph can make impact or neighborhood claims.',
      missing: 'nodeId',
      operation,
      sourceGraphRequiredForImpact: true,
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
  sourceGraphRef?: string
): string {
  const freshnessText = sourceGraphRef ? 'sourceGraphRef linked' : 'sourceGraph freshness partial';
  return `alembic_graph ${operation} returned ${selection.items.length} project graph items and ${selection.relations.length} project graph relations (${freshnessText}).`;
}

function nextActionsFor(operation: string, input: ProjectGraphInput): KnowledgeContextNextAction[] {
  const actions: KnowledgeContextNextAction[] = [];
  if ((operation === 'impact' || operation === 'neighborhood') && !input.nodeId) {
    actions.push({
      tool: 'alembic_graph',
      operation: 'query',
      reason:
        'First query or inspect a concrete project nodeId/sourceGraphRef; impact and neighborhood output is withheld without that anchor.',
      required: true,
    });
  }
  if (isLowInformationGraphQuery(input) && !hasFocusedGraphQuery(input)) {
    actions.push({
      tool: 'alembic_project_matrix',
      operation: 'overview',
      reason:
        'Use the project matrix overview to choose a module, entrypoint, or sourceGraphRef before asking for graph impact.',
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
  if (!input.sourceGraphRef) {
    actions.push({
      tool: 'alembic_graph',
      operation: input.nodeId ? 'neighborhood' : 'query',
      reason:
        'Supply sourceGraphRef when resident source graph evidence is available; without it, output remains a bounded project/source scan.',
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
      input.sourceGraphRef ||
      (input.sourceRefs?.length ?? 0) > 0 ||
      (input.sourceEvidenceRefs?.length ?? 0) > 0
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
