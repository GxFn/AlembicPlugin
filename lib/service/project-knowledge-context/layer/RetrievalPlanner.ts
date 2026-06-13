import type { KnowledgeContextSourceDomain, KnowledgeContextToolName } from '../contracts/index.js';
import type { KnowledgeContextBudgetLimits } from '../support/index.js';
import type { ContextIndexSnapshot } from './ContextIndexSnapshot.js';
import type { NormalizedKnowledgeContextInput } from './KnowledgeContextInputNormalizer.js';

export type KnowledgeContextRetrievalRoute =
  | 'matrix-first'
  | 'search-first'
  | 'graph-first'
  | 'prime-orchestrated';

export interface KnowledgeContextRetrievalTrace {
  candidatePoolSize: number;
  degradedReasons: string[];
  domains: KnowledgeContextSourceDomain[];
  finalItemLimit: number;
  matrixNodeLimit: number;
  query?: string;
  relationHopLimit: number;
  truncatedByBudget: string[];
  usesVector: boolean;
}

export interface KnowledgeContextRetrievalPlan {
  operation: string;
  recommendedDetailRefId?: string;
  route: KnowledgeContextRetrievalRoute;
  tool: KnowledgeContextToolName;
  trace: KnowledgeContextRetrievalTrace;
}

export class RetrievalPlanner {
  plan(
    input: NormalizedKnowledgeContextInput,
    snapshot: ContextIndexSnapshot
  ): KnowledgeContextRetrievalPlan {
    const route = selectRoute(input);
    const domains = domainsForRoute(route);
    const degradedReasons = domains
      .map((domain) => snapshot.freshness[domain])
      .filter((entry) => entry.state !== 'ready')
      .map((entry) => `${entry.domain}:${entry.state}`);
    const budget = input.budget;
    const candidatePoolSize = estimateCandidatePoolSize(route, snapshot);
    const truncatedByBudget = computeBudgetTruncation(route, snapshot, budget, candidatePoolSize);
    const recommendedDetailRefId = snapshot.detailRefs[0]?.id;

    return {
      tool: input.tool,
      operation: input.operation,
      route,
      ...(recommendedDetailRefId === undefined ? {} : { recommendedDetailRefId }),
      trace: {
        domains,
        usesVector:
          (route === 'search-first' || route === 'prime-orchestrated') &&
          snapshot.freshness.vector.state !== 'unavailable',
        candidatePoolSize,
        finalItemLimit: budget.itemLimit,
        relationHopLimit: budget.relationHopLimit,
        matrixNodeLimit: budget.matrixNodeLimit,
        truncatedByBudget,
        degradedReasons,
        ...(input.query === undefined ? {} : { query: input.query }),
      },
    };
  }
}

function selectRoute(input: NormalizedKnowledgeContextInput): KnowledgeContextRetrievalRoute {
  if (input.tool === 'alembic_project_matrix') {
    return 'matrix-first';
  }
  if (input.tool === 'alembic_search') {
    return 'search-first';
  }
  if (input.tool === 'alembic_graph') {
    return 'graph-first';
  }
  if (input.operation === 'matrix-first' || input.operation === 'search-first') {
    return input.operation;
  }
  return 'prime-orchestrated';
}

function domainsForRoute(route: KnowledgeContextRetrievalRoute): KnowledgeContextSourceDomain[] {
  switch (route) {
    case 'matrix-first':
      return ['project', 'knowledge', 'recipeRelation', 'sourceGraph', 'document'];
    case 'search-first':
      return ['knowledge', 'recipeRelation', 'vector', 'document'];
    case 'graph-first':
      return ['project', 'sourceGraph'];
    case 'prime-orchestrated':
      return [
        'project',
        'knowledge',
        'recipeRelation',
        'vector',
        'sourceGraph',
        'document',
        'runtime',
      ];
  }
}

function estimateCandidatePoolSize(
  route: KnowledgeContextRetrievalRoute,
  snapshot: ContextIndexSnapshot
): number {
  switch (route) {
    case 'matrix-first':
      return snapshot.projectMap.nodeCount + snapshot.knowledgeCatalog.itemCount;
    case 'search-first':
      return snapshot.knowledgeCatalog.itemCount + snapshot.recipeRelationIndex.relationCount;
    case 'graph-first':
      return snapshot.projectMap.nodeCount + snapshot.recipeRelationIndex.relationCount;
    case 'prime-orchestrated':
      return (
        snapshot.projectMap.nodeCount +
        snapshot.knowledgeCatalog.itemCount +
        snapshot.recipeRelationIndex.relationCount +
        snapshot.vector.candidateCount
      );
  }
}

function computeBudgetTruncation(
  route: KnowledgeContextRetrievalRoute,
  snapshot: ContextIndexSnapshot,
  budget: KnowledgeContextBudgetLimits,
  candidatePoolSize: number
): string[] {
  const reasons: string[] = [];
  if (candidatePoolSize > budget.itemLimit) {
    reasons.push('items');
  }
  if (
    (route === 'matrix-first' || route === 'prime-orchestrated') &&
    snapshot.projectMap.truncated
  ) {
    reasons.push('matrixNodes');
  }
  if (snapshot.recipeRelationIndex.relationCount > budget.relationHopLimit) {
    reasons.push('relationHops');
  }
  return reasons;
}

export const defaultRetrievalPlanner = new RetrievalPlanner();
