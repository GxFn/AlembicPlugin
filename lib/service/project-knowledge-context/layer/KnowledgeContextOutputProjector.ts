import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createKnowledgeContextMcpResult,
  type KnowledgeContextDetailRef,
  type KnowledgeContextDiagnostic,
  type KnowledgeContextNextAction,
  type KnowledgeContextSource,
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
const MAX_PUBLIC_SUMMARY_CHARS = 2000;
const MAX_DETAIL_REF_SUMMARY_CHARS = 600;
const MAX_OPTIONAL_TITLE_CHARS = 1200;
const TEXT_BUDGET_KEYS = new Set([
  'body',
  'content',
  'contentPreview',
  'description',
  'message',
  'reason',
  'summary',
  'text',
  'title',
]);
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 800;
// MCP structuredContent stays ref-based: caller budgets narrow worksets, these caps protect schema/readability.
const OUTPUT_ARRAY_LIMITS = {
  detailRefs: 200,
  diagnostics: 200,
  items: 500,
  matrixNodes: 200,
  nextActions: 20,
  relations: 500,
  sources: 200,
} as const;

export interface KnowledgeContextProjectionPayload {
  detailRefs?: KnowledgeContextDetailRef[];
  diagnostics?: KnowledgeContextDiagnostic[];
  inventory?: KnowledgeContextObject;
  interaction?: KnowledgeContextObject;
  items?: KnowledgeContextObject[];
  matrixNodes?: KnowledgeContextObject[];
  nextActions?: KnowledgeContextNextAction[];
  relations?: KnowledgeContextObject[];
  result?: KnowledgeContextObject;
  sources?: KnowledgeContextSource[];
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
    const { input: normalized, plan, snapshot } = input;
    const budget = normalized.budget;
    const parts = prepareProjectionParts(input);
    const freshnessSummary = summarizeFreshnessForTool(normalized.tool, snapshot.freshness);
    const baseTruncationDiagnostics = createTruncationDiagnostics(parts.truncated);
    const diagnostics = budgetDiagnostics(
      [
        ...freshnessSummary.diagnostics,
        ...baseTruncationDiagnostics,
        ...(input.payload?.diagnostics ?? []),
      ],
      OUTPUT_ARRAY_LIMITS.diagnostics
    );
    const truncated = { ...parts.truncated, diagnostics: diagnostics.truncated };
    const status = statusWithBudget(
      freshnessSummary.status,
      diagnostics.value.filter(isBudgetTruncationDiagnostic)
    );

    return KnowledgeContextToolOutputSchema.parse({
      ok: status !== 'blocked' && status !== 'failed',
      status,
      tool: normalized.tool,
      toolName: normalized.tool,
      operation: normalized.operation,
      summary: parts.summaryText,
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
      interaction: parts.interaction.value,
      result: {
        route: plan.route,
        retrievalTrace: plan.trace,
        budgetUsed: budget,
        ...parts.payloadResult.value,
        truncated,
        matrixNodes: parts.matrixNodes.value,
      },
      inventory: parts.inventory.value,
      relations: parts.relations.value,
      items: parts.items.value,
      detailRefs: parts.detailRefs.value,
      sources: parts.sources.value,
      diagnostics: diagnostics.value,
      nextActions: parts.nextActions.value,
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

interface ProjectionParts {
  detailRefs: TextBudgetResult<KnowledgeContextDetailRef[]>;
  inventory: TextBudgetResult<KnowledgeContextObject>;
  interaction: TextBudgetResult<KnowledgeContextObject>;
  items: TextBudgetResult<KnowledgeContextObject[]>;
  matrixNodes: TextBudgetResult<KnowledgeContextObject[]>;
  nextActions: TextBudgetResult<KnowledgeContextNextAction[]>;
  payloadResult: TextBudgetResult<KnowledgeContextObject>;
  relations: TextBudgetResult<KnowledgeContextObject[]>;
  sources: TextBudgetResult<KnowledgeContextSource[]>;
  summaryText: string;
  truncated: ProjectionTruncationState;
}

type ProjectionTruncationKey =
  | 'content'
  | 'detailRefs'
  | 'diagnostics'
  | 'items'
  | 'matrixNodes'
  | 'nextActions'
  | 'relations'
  | 'sources';

type ProjectionTruncationState = Record<ProjectionTruncationKey, boolean>;

function prepareProjectionParts(input: KnowledgeContextOutputProjectorInput): ProjectionParts {
  const { input: normalized, payload, plan, snapshot } = input;
  const budget = normalized.budget;
  const contentCharLimit = budget.contentCharLimit;
  const itemSlice = defaultContextBudgeter.trimArray(
    payload?.items ?? defaultItems(snapshot),
    outputArrayLimit(budget.itemLimit, OUTPUT_ARRAY_LIMITS.items)
  );
  const relationSlice = defaultContextBudgeter.trimArray(
    payload?.relations ?? defaultRelations(snapshot),
    outputArrayLimit(budget.relationHopLimit, OUTPUT_ARRAY_LIMITS.relations)
  );
  const matrixNodeSlice = defaultContextBudgeter.trimArray(
    payload?.matrixNodes ?? snapshot.projectMap.nodes.map((node) => ({ ...node })),
    outputArrayLimit(budget.matrixNodeLimit, OUTPUT_ARRAY_LIMITS.matrixNodes)
  );
  const detailRefSlice = defaultContextBudgeter.trimArray(
    [...snapshot.detailRefs, ...(payload?.detailRefs ?? [])],
    outputArrayLimit(budget.detailLimit, OUTPUT_ARRAY_LIMITS.detailRefs)
  );
  const nextActionSlice = defaultContextBudgeter.trimArray(
    payload?.nextActions ?? defaultNextActions(plan),
    outputArrayLimit(budget.nextActionLimit, OUTPUT_ARRAY_LIMITS.nextActions)
  );
  const sourceSlice = defaultContextBudgeter.trimArray(
    payload?.sources ?? snapshot.sources,
    OUTPUT_ARRAY_LIMITS.sources
  );
  const summary = defaultContextBudgeter.trimText(
    payload?.summary ??
      `Knowledge context ${plan.route} support layer prepared ${normalized.tool} output.`,
    Math.min(contentCharLimit, MAX_PUBLIC_SUMMARY_CHARS)
  );
  const projected = {
    detailRefs: budgetDetailRefs(detailRefSlice.items, contentCharLimit),
    inventory: budgetTextObject(payload?.inventory ?? defaultInventory(snapshot), contentCharLimit),
    interaction: budgetTextObject(buildInteraction(normalized, payload), contentCharLimit),
    items: budgetTextObjectArray(itemSlice.items, contentCharLimit),
    matrixNodes: budgetTextObjectArray(matrixNodeSlice.items, contentCharLimit),
    nextActions: budgetNextActions(nextActionSlice.items, contentCharLimit),
    payloadResult: budgetTextObject(payload?.result ?? {}, contentCharLimit),
    relations: budgetTextObjectArray(relationSlice.items, contentCharLimit),
    sources: budgetSources(sourceSlice.items, contentCharLimit),
  };
  const contentTruncated =
    summary.truncated || Object.values(projected).some((part) => part.truncated);

  return {
    ...projected,
    summaryText: summary.text,
    truncated: {
      content: contentTruncated,
      detailRefs: detailRefSlice.truncated,
      diagnostics: false,
      items: itemSlice.truncated,
      matrixNodes: matrixNodeSlice.truncated || snapshot.projectMap.truncated,
      nextActions: nextActionSlice.truncated,
      relations: relationSlice.truncated,
      sources: sourceSlice.truncated,
    },
  };
}

function buildInteraction(
  normalized: NormalizedKnowledgeContextInput,
  payload?: KnowledgeContextProjectionPayload
): KnowledgeContextObject {
  return {
    ...(payload?.interaction ?? {}),
    ...(normalized.intentRef === undefined ? {} : { intentRef: normalized.intentRef }),
    ...(normalized.primeRef === undefined ? {} : { primeRef: normalized.primeRef }),
    ...(normalized.recognizedIntent === undefined
      ? {}
      : { recognizedIntent: normalized.recognizedIntent }),
    sourceEvidenceRefs: normalized.sourceEvidenceRefs,
    ...(normalized.workRef === undefined ? {} : { workRef: normalized.workRef }),
  };
}

function defaultInventory(snapshot: ContextIndexSnapshot): KnowledgeContextObject {
  return {
    derivedView: snapshot.derivedView,
    sourceOfTruth: snapshot.sourceOfTruth,
    knowledgeItemCount: snapshot.knowledgeCatalog.itemCount,
    projectNodeCount: snapshot.projectMap.nodeCount,
    recipeRelationCount: snapshot.recipeRelationIndex.relationCount,
  };
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

function createTruncationDiagnostics(
  input: ProjectionTruncationState
): KnowledgeContextDiagnostic[] {
  return Object.entries(input)
    .filter(([, truncated]) => truncated)
    .map(([code]) => createTruncationDiagnostic(code as ProjectionTruncationKey));
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

function createTruncationDiagnostic(code: ProjectionTruncationKey): KnowledgeContextDiagnostic {
  const suffix = truncationCodeSuffix(code);
  return {
    code: `budget-truncated-${suffix}`,
    severity: 'info',
    message: truncationMessage(code),
    retryable: false,
  };
}

function isBudgetTruncationDiagnostic(diagnostic: KnowledgeContextDiagnostic): boolean {
  return diagnostic.code.startsWith('budget-truncated-');
}

interface TextBudgetResult<T> {
  truncated: boolean;
  value: T;
}

function outputArrayLimit(requestedLimit: number, schemaLimit: number): number {
  return Math.min(requestedLimit, schemaLimit);
}

function budgetDiagnostics(
  diagnostics: readonly KnowledgeContextDiagnostic[],
  limit: number
): TextBudgetResult<KnowledgeContextDiagnostic[]> {
  const value = diagnostics.map((diagnostic) => budgetDiagnostic(diagnostic));
  if (value.length <= limit) {
    return { value, truncated: false };
  }
  const marker = createTruncationDiagnostic('diagnostics');
  return {
    value: [...value.slice(0, Math.max(0, limit - 1)), marker],
    truncated: true,
  };
}

function budgetDiagnostic(diagnostic: KnowledgeContextDiagnostic): KnowledgeContextDiagnostic {
  const message = defaultContextBudgeter.trimText(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARS);
  return {
    ...diagnostic,
    message: message.text,
  };
}

function truncationCodeSuffix(code: ProjectionTruncationKey): string {
  switch (code) {
    case 'detailRefs':
      return 'detail-refs';
    case 'matrixNodes':
      return 'matrix-nodes';
    case 'nextActions':
      return 'next-actions';
    default:
      return code;
  }
}

function truncationMessage(code: ProjectionTruncationKey): string {
  if (code === 'content') {
    return 'Knowledge context text/content was trimmed by the requested budget.';
  }
  if (code === 'diagnostics') {
    return 'Knowledge context diagnostics were capped before MCP schema validation; narrow the request or inspect detail refs for deeper errors.';
  }
  return `Knowledge context ${truncationCodeSuffix(
    code
  )} were capped by schema and caller budget before MCP schema validation.`;
}

function budgetDetailRefs(
  refs: readonly KnowledgeContextDetailRef[],
  limit: number
): TextBudgetResult<KnowledgeContextDetailRef[]> {
  let truncated = false;
  const value = refs.map((ref) => {
    const summary = defaultContextBudgeter.trimText(
      ref.summary,
      Math.min(limit, MAX_DETAIL_REF_SUMMARY_CHARS)
    );
    const title =
      ref.title === undefined
        ? undefined
        : defaultContextBudgeter.trimText(ref.title, Math.min(limit, MAX_OPTIONAL_TITLE_CHARS));
    truncated = truncated || summary.truncated || (title?.truncated ?? false);
    return {
      ...ref,
      summary: summary.text,
      ...(title === undefined ? {} : { title: title.text }),
    };
  });
  return { value, truncated };
}

function budgetSources(
  sources: readonly KnowledgeContextSource[],
  limit: number
): TextBudgetResult<KnowledgeContextSource[]> {
  let truncated = false;
  const value = sources.map((source) => {
    const summary =
      source.summary === undefined
        ? undefined
        : defaultContextBudgeter.trimText(
            source.summary,
            Math.min(limit, MAX_DETAIL_REF_SUMMARY_CHARS)
          );
    const title =
      source.title === undefined
        ? undefined
        : defaultContextBudgeter.trimText(source.title, Math.min(limit, MAX_OPTIONAL_TITLE_CHARS));
    truncated = truncated || (summary?.truncated ?? false) || (title?.truncated ?? false);
    return {
      ...source,
      ...(summary === undefined ? {} : { summary: summary.text }),
      ...(title === undefined ? {} : { title: title.text }),
    };
  });
  return { value, truncated };
}

function budgetNextActions(
  nextActions: readonly KnowledgeContextNextAction[],
  limit: number
): TextBudgetResult<KnowledgeContextNextAction[]> {
  let truncated = false;
  const value = nextActions.map((action) => {
    const reason = defaultContextBudgeter.trimText(
      action.reason,
      Math.min(limit, MAX_DETAIL_REF_SUMMARY_CHARS)
    );
    truncated = truncated || reason.truncated;
    return {
      ...action,
      reason: reason.text,
    };
  });
  return { value, truncated };
}

function budgetTextObjectArray<T extends KnowledgeContextObject>(
  objects: readonly T[],
  limit: number
): TextBudgetResult<T[]> {
  let truncated = false;
  const value = objects.map((object) => {
    const budgeted = budgetTextObject(object, limit);
    truncated = truncated || budgeted.truncated;
    return budgeted.value;
  });
  return { value, truncated };
}

function budgetTextObject<T extends KnowledgeContextObject>(
  object: T,
  limit: number
): TextBudgetResult<T> {
  let truncated = false;
  const entries = Object.entries(object).map(([key, value]) => {
    const budgeted = budgetTextValue(key, value, limit);
    truncated = truncated || budgeted.truncated;
    return [key, budgeted.value] as const;
  });
  return { value: Object.fromEntries(entries) as T, truncated };
}

function budgetTextValue(
  key: string | undefined,
  value: unknown,
  limit: number
): TextBudgetResult<unknown> {
  if (typeof value === 'string') {
    if (key === undefined || !TEXT_BUDGET_KEYS.has(key)) {
      return { value, truncated: false };
    }
    const text = defaultContextBudgeter.trimText(value, limit);
    return { value: text.text, truncated: text.truncated };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const items = value.map((item) => {
      const budgeted = budgetTextValue(key, item, limit);
      truncated = truncated || budgeted.truncated;
      return budgeted.value;
    });
    return { value: items, truncated };
  }
  if (isPlainObject(value)) {
    return budgetTextObject(value, limit);
  }
  return { value, truncated: false };
}

function isPlainObject(value: unknown): value is KnowledgeContextObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const defaultKnowledgeContextOutputProjector = new KnowledgeContextOutputProjector();
