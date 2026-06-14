import { resolveSearchWorkspaceIdentity } from '@alembic/core/search';
import type {
  KnowledgeContextDetailRef,
  KnowledgeContextSource,
  KnowledgeContextSourceDomain,
} from '../contracts/index.js';
import {
  createKnowledgeContextFreshnessByDomain,
  type KnowledgeContextDomainFreshness,
  type KnowledgeContextFreshnessByDomain,
} from '../evidence/index.js';
import { defaultContextBudgeter, defaultRefRegistry, stableRefSegment } from '../support/index.js';
import type { NormalizedKnowledgeContextInput } from './KnowledgeContextInputNormalizer.js';

export interface ContextIndexNode {
  detailRefId?: string;
  id: string;
  label: string;
  type: string;
}

export interface ContextIndexSnapshot {
  createdAt: string;
  derivedView: true;
  detailRefs: KnowledgeContextDetailRef[];
  freshness: KnowledgeContextFreshnessByDomain;
  kind: 'ContextIndexSnapshot';
  knowledgeCatalog: {
    itemCount: number;
    kinds: string[];
    representativeRefs: string[];
  };
  project: {
    language?: string;
    projectId: string;
    projectRoot?: string;
  };
  projectMap: {
    nodeCount: number;
    nodes: ContextIndexNode[];
    truncated: boolean;
  };
  rebuildable: true;
  recipeRelationIndex: {
    relationCount: number;
    representativeRefs: string[];
  };
  snapshotId: string;
  sourceGraph: {
    sourceGraphRef?: string;
    supported: boolean;
  };
  sourceOfTruth: false;
  sources: KnowledgeContextSource[];
  vector: {
    available: boolean;
    candidateCount: number;
  };
}

export interface ContextIndexSnapshotOptions {
  domainFreshness?: Partial<
    Record<KnowledgeContextSourceDomain, Partial<KnowledgeContextDomainFreshness>>
  >;
  knowledgeItemCount?: number;
  projectNodes?: ContextIndexNode[];
  recipeRelationCount?: number;
  sourceGraphSupported?: boolean;
  vectorCandidateCount?: number;
}

interface ResolvedProjectIdentity {
  projectId: string;
  projectRoot?: string;
}

export function createContextIndexSnapshot(
  input: NormalizedKnowledgeContextInput,
  options: ContextIndexSnapshotOptions = {}
): ContextIndexSnapshot {
  const createdAt = new Date().toISOString();
  const freshness = createKnowledgeContextFreshnessByDomain(options.domainFreshness, createdAt);
  const projectIdentity = resolveProjectIdentity(input);
  const snapshotId = `snapshot:${stableRefSegment(projectIdentity.projectId)}:${input.tool}:${input.operation}`;
  const snapshotRef = defaultRefRegistry.createDetailRef({
    budget: {
      detailLimit: input.budget.detailLimit,
      itemLimit: input.budget.itemLimit,
      matrixNodeLimit: input.budget.matrixNodeLimit,
    },
    domain: 'project',
    freshness: {
      observedAt: createdAt,
      policy: input.freshnessPolicy.policy,
      snapshotRef: snapshotId,
    },
    id: snapshotId,
    operation: 'context-index-snapshot',
    requiredForCompletion: true,
    summary:
      'ContextIndexSnapshot is a rebuildable derived view of project, knowledge, recipeRelation, sourceGraph, vector, document, and runtime domains.',
    tool: input.tool,
  });
  const defaultNodes = createDefaultProjectNodes(input, projectIdentity, snapshotRef.id);
  const budgetedNodes = defaultContextBudgeter.trimArray(
    options.projectNodes ?? defaultNodes,
    input.budget.matrixNodeLimit
  );

  return {
    kind: 'ContextIndexSnapshot',
    createdAt,
    derivedView: true,
    sourceOfTruth: false,
    rebuildable: true,
    snapshotId,
    project: {
      projectId: projectIdentity.projectId,
      ...(projectIdentity.projectRoot === undefined
        ? {}
        : { projectRoot: projectIdentity.projectRoot }),
      ...(input.language === undefined ? {} : { language: input.language }),
    },
    projectMap: {
      nodeCount: (options.projectNodes ?? defaultNodes).length,
      nodes: budgetedNodes.items,
      truncated: budgetedNodes.truncated,
    },
    knowledgeCatalog: {
      itemCount: options.knowledgeItemCount ?? 0,
      kinds: [],
      representativeRefs: input.sourceRefs.slice(0, input.budget.detailLimit),
    },
    recipeRelationIndex: {
      relationCount: options.recipeRelationCount ?? 0,
      representativeRefs: input.sourceEvidenceRefs.slice(0, input.budget.detailLimit),
    },
    sourceGraph: {
      supported: options.sourceGraphSupported ?? input.sourceGraphRef !== undefined,
      ...(input.sourceGraphRef === undefined ? {} : { sourceGraphRef: input.sourceGraphRef }),
    },
    vector: {
      available: (options.vectorCandidateCount ?? 0) > 0,
      candidateCount: options.vectorCandidateCount ?? 0,
    },
    freshness,
    detailRefs: [snapshotRef],
    sources: createSnapshotSources(input),
  };
}

export function isContextIndexSnapshotSourceOfTruth(snapshot: ContextIndexSnapshot): false {
  return snapshot.sourceOfTruth;
}

function resolveProjectIdentity(input: NormalizedKnowledgeContextInput): ResolvedProjectIdentity {
  const workspace = resolveSearchWorkspaceIdentity({ projectRoot: input.projectRoot });
  const projectRoot = workspace?.projectRoot ?? input.projectRoot;
  const projectId =
    workspace?.projectId ??
    (projectRoot === undefined ? 'project:unknown' : `project:${stableRefSegment(projectRoot)}`);

  return {
    projectId,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
}

function createDefaultProjectNodes(
  input: NormalizedKnowledgeContextInput,
  projectIdentity: ResolvedProjectIdentity,
  detailRefId: string
): ContextIndexNode[] {
  const nodes: ContextIndexNode[] = [
    {
      detailRefId,
      id: projectIdentity.projectId,
      label: projectIdentity.projectRoot ?? 'Unknown project',
      type: 'project',
    },
  ];
  if (input.activeFile !== undefined) {
    nodes.push({
      detailRefId,
      id: `file:${input.activeFile}`,
      label: input.activeFile,
      type: 'file',
    });
  }
  return nodes;
}

function createSnapshotSources(input: NormalizedKnowledgeContextInput): KnowledgeContextSource[] {
  const sources: KnowledgeContextSource[] = input.sourceRefs.map((sourceRef) => ({
    domain: 'knowledge',
    id: sourceRef,
    summary: 'Input source ref carried into the rebuildable context snapshot.',
  }));
  if (input.sourceGraphRef !== undefined) {
    sources.push({
      domain: 'sourceGraph',
      id: input.sourceGraphRef,
      summary: 'Source graph ref carried into the rebuildable context snapshot.',
    });
  }
  return sources;
}
