import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createKnowledgeContextMcpResult,
  type KnowledgeContextDetailRef,
  type KnowledgeContextDiagnostic,
  type KnowledgeContextNextAction,
  type KnowledgeContextStatus,
  type KnowledgeContextToolOutput,
  KnowledgeContextToolOutputSchema,
} from '../contracts/index.js';
import { summarizeFreshnessForTool } from '../evidence/index.js';
import { defaultContextBudgeter } from '../support/index.js';
import type { ContextIndexSnapshot } from './ContextIndexSnapshot.js';
import type { NormalizedKnowledgeContextInput } from './KnowledgeContextInputNormalizer.js';
import type { KnowledgeContextRetrievalPlan } from './RetrievalPlanner.js';

type KnowledgeContextObject = Record<string, unknown>;

export interface KnowledgeContextProjectionPayload {
  detailRefs?: KnowledgeContextDetailRef[];
  inventory?: KnowledgeContextObject;
  items?: KnowledgeContextObject[];
  matrixNodes?: KnowledgeContextObject[];
  nextActions?: KnowledgeContextNextAction[];
  relations?: KnowledgeContextObject[];
  result?: KnowledgeContextObject;
  summary?: string;
}

export interface KnowledgeContextOutputProjectorInput {
  input: NormalizedKnowledgeContextInput;
  payload?: KnowledgeContextProjectionPayload;
  plan: KnowledgeContextRetrievalPlan;
  snapshot: ContextIndexSnapshot;
}

export class KnowledgeContextOutputProjector {
  project(input: KnowledgeContextOutputProjectorInput): KnowledgeContextToolOutput {
    const { input: normalized, payload, plan, snapshot } = input;
    const budget = normalized.budget;
    const items = defaultContextBudgeter.trimArray(
      payload?.items ?? defaultItems(snapshot),
      budget.itemLimit
    );
    const relations = defaultContextBudgeter.trimArray(
      payload?.relations ?? defaultRelations(snapshot),
      budget.relationHopLimit
    );
    const matrixNodes = defaultContextBudgeter.trimArray(
      payload?.matrixNodes ?? snapshot.projectMap.nodes.map((node) => ({ ...node })),
      budget.matrixNodeLimit
    );
    const detailRefs = defaultContextBudgeter.trimArray(
      [...snapshot.detailRefs, ...(payload?.detailRefs ?? [])],
      budget.detailLimit
    );
    const nextActions = defaultContextBudgeter.trimArray(
      payload?.nextActions ?? defaultNextActions(plan),
      budget.nextActionLimit
    );
    const matrixNodesTruncated = matrixNodes.truncated || snapshot.projectMap.truncated;
    const freshnessSummary = summarizeFreshnessForTool(normalized.tool, snapshot.freshness);
    const truncationDiagnostics = createTruncationDiagnostics({
      detailRefsTruncated: detailRefs.truncated,
      itemsTruncated: items.truncated,
      matrixNodesTruncated,
      nextActionsTruncated: nextActions.truncated,
      relationsTruncated: relations.truncated,
    });
    const status = statusWithBudget(freshnessSummary.status, truncationDiagnostics);

    return KnowledgeContextToolOutputSchema.parse({
      ok: status !== 'blocked' && status !== 'failed',
      status,
      tool: normalized.tool,
      operation: normalized.operation,
      summary:
        payload?.summary ??
        `Knowledge context ${plan.route} support layer prepared ${normalized.tool} output.`,
      request: {
        ...(normalized.agentHost === undefined ? {} : { agentHost: normalized.agentHost }),
        ...(normalized.inputSource === undefined ? {} : { inputSource: normalized.inputSource }),
        ...(normalized.intentKind === undefined ? {} : { intentKind: normalized.intentKind }),
        ...(normalized.query === undefined ? {} : { query: normalized.query }),
        budget,
        detailLevel: normalized.detailLevel,
        freshnessPolicy: normalized.freshnessPolicy,
      },
      project: {
        projectId: snapshot.project.projectId,
        ...(snapshot.project.language === undefined ? {} : { language: snapshot.project.language }),
        ...(snapshot.project.projectRoot === undefined
          ? {}
          : { projectRoot: snapshot.project.projectRoot }),
        matrixRef: snapshot.snapshotId,
        freshness: snapshot.freshness,
      },
      interaction: {
        ...(normalized.intentRef === undefined ? {} : { intentRef: normalized.intentRef }),
        ...(normalized.primeRef === undefined ? {} : { primeRef: normalized.primeRef }),
        ...(normalized.recognizedIntent === undefined
          ? {}
          : { recognizedIntent: normalized.recognizedIntent }),
        sourceEvidenceRefs: normalized.sourceEvidenceRefs,
        ...(normalized.workRef === undefined ? {} : { workRef: normalized.workRef }),
      },
      result: {
        route: plan.route,
        retrievalTrace: plan.trace,
        budgetUsed: budget,
        truncated: {
          detailRefs: detailRefs.truncated,
          items: items.truncated,
          matrixNodes: matrixNodesTruncated,
          nextActions: nextActions.truncated,
          relations: relations.truncated,
        },
        ...(payload?.result ?? {}),
        matrixNodes: matrixNodes.items,
      },
      inventory: payload?.inventory ?? {
        derivedView: snapshot.derivedView,
        sourceOfTruth: snapshot.sourceOfTruth,
        knowledgeItemCount: snapshot.knowledgeCatalog.itemCount,
        projectNodeCount: snapshot.projectMap.nodeCount,
        recipeRelationCount: snapshot.recipeRelationIndex.relationCount,
      },
      relations: relations.items,
      items: items.items,
      detailRefs: detailRefs.items,
      sources: snapshot.sources,
      diagnostics: [...freshnessSummary.diagnostics, ...truncationDiagnostics],
      nextActions: nextActions.items,
      meta: {
        contractVersion: 1,
        generatedAt: new Date().toISOString(),
        producer: 'ProjectKnowledgeContextLayer',
      },
    });
  }

  projectMcpResult(input: KnowledgeContextOutputProjectorInput): CallToolResult {
    return createKnowledgeContextMcpResult(this.project(input));
  }
}

function defaultItems(snapshot: ContextIndexSnapshot): KnowledgeContextObject[] {
  return snapshot.knowledgeCatalog.representativeRefs.map((ref) => ({
    id: ref,
    kind: 'knowledge-ref',
  }));
}

function defaultRelations(snapshot: ContextIndexSnapshot): KnowledgeContextObject[] {
  return snapshot.recipeRelationIndex.representativeRefs.map((ref) => ({
    id: ref,
    relationType: 'recipeRelation',
  }));
}

function defaultNextActions(plan: KnowledgeContextRetrievalPlan): KnowledgeContextNextAction[] {
  if (plan.recommendedDetailRefId === undefined) {
    return [];
  }
  return [
    {
      tool: 'alembic_search',
      operation: 'expand',
      reason: `Expand ${plan.route} detail refs within the caller budget.`,
      detailRefId: plan.recommendedDetailRefId,
      required: false,
    },
  ];
}

function createTruncationDiagnostics(input: {
  detailRefsTruncated: boolean;
  itemsTruncated: boolean;
  matrixNodesTruncated: boolean;
  nextActionsTruncated: boolean;
  relationsTruncated: boolean;
}): KnowledgeContextDiagnostic[] {
  return Object.entries(input)
    .filter(([, truncated]) => truncated)
    .map(([code]) => ({
      code: `budget-truncated-${code}`,
      severity: 'info',
      message: `Knowledge context ${code} was trimmed by the requested budget.`,
      retryable: false,
    }));
}

function statusWithBudget(
  status: KnowledgeContextStatus,
  diagnostics: readonly KnowledgeContextDiagnostic[]
): KnowledgeContextStatus {
  if (status !== 'ready') {
    return status;
  }
  return diagnostics.length > 0 ? 'partial' : status;
}

export const defaultKnowledgeContextOutputProjector = new KnowledgeContextOutputProjector();
