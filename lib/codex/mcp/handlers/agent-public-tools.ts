import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexPrimeRuntimeContext } from '#codex/runtime/ProjectRuntimeContext.js';
import {
  buildHostIntentFrame,
  type HostDeclaredIntentInput,
  type HostIntentFrame,
  type HostTurnMetaInput,
  type NormalizedHostIntentInput,
  prepareHostIntentInput,
} from '#service/task/HostIntentFrame.js';
import { type ExtractedIntent, extract as extractIntent } from '#service/task/IntentExtractor.js';
import {
  buildPrimeKnowledgeMaterial,
  createUnavailablePrimeIntentEpisodeMaterial,
  formatPrimeTrustPostureMessage,
} from '#service/task/PrimeKnowledgeMaterial.js';
import type { PrimeSearchResult } from '#service/task/PrimeSearchPipeline.js';
import {
  classifyTaskLifecycleInput,
  type TaskLifecycleClassification,
} from '#service/task/TaskLifecyclePolicy.js';
import { envelope } from '../envelope.js';
import {
  type AgentDetailRef,
  type AgentHost,
  type AgentInputSource,
  type AgentIntentKind,
  type AgentPublicToolResultEnvelope,
  createAgentDetailRef,
  createAgentPublicToolResultEnvelope,
} from '../public-tools/index.js';
import { createIdleIntent, type McpContext, type McpServiceContainer } from './types.js';

interface AgentPublicBaseArgs {
  activeFile?: string;
  agentHost?: AgentHost;
  hostDeclaredIntent?: HostDeclaredIntentInput;
  hostTurnMeta?: HostTurnMetaInput;
  inputSource?: AgentInputSource;
  intentKind?: AgentIntentKind;
  language?: string;
  outputBudget?: {
    maxChars?: number;
    mode?: 'compact' | 'standard' | 'detailed';
  };
  projectRoot?: string;
  sourceRefs?: string[];
  userQuery?: string;
  [key: string]: unknown;
}

interface AgentPrimeArgs extends AgentPublicBaseArgs {
  intentRef?: string;
  query?: string;
  recognizedIntent?: Record<string, unknown>;
}

interface IntentRecord {
  createdAt: string;
  detailRefs: AgentDetailRef[];
  extracted: ExtractedIntent;
  hostIntentFrame: HostIntentFrame;
  hostIntentInput: NormalizedHostIntentInput;
  inputSource: AgentInputSource;
  intentKind: AgentIntentKind;
  intentRef: string;
  lifecycle: TaskLifecycleClassification;
  sourceRefs: string[];
  vectorPlan: AgentVectorPlan;
}

interface AgentVectorPlan {
  keywordQueries: string[];
  language: string | null;
  module: string | null;
  queries: string[];
  retrievalOrder: string[];
  route: 'structure-first-recipe-retrieval';
  scenario: string;
}

interface PipelineLike {
  search(
    intent: ExtractedIntent,
    options?: { hostIntentFrame?: HostIntentFrame; projectRoot?: string }
  ): Promise<PrimeSearchResult | null>;
}

let intentCounter = 0;
let primeCounter = 0;
const INTENT_RECORDS = new Map<string, IntentRecord>();

export async function intentHandler(ctx: McpContext, args: AgentPublicBaseArgs) {
  const intake = buildIntentIntake(ctx, args);
  const status = resolveIntentStatus(intake.lifecycle, intake.hostIntentFrame);
  const detailRefs = buildBaseDetailRefs('alembic_intent', intake.sourceRefs);
  const intentRef = nextIntentRef();
  const vectorPlan = buildVectorPlan(intake.extracted);
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'intent',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
      detailRefs,
      intentRef: { refType: 'intent', id: intentRef, toolName: 'alembic_intent' },
    },
    ...(status.reason ? { reason: status.reason } : {}),
    status: status.status,
    summary: buildResultSummary(status.summary, args.outputBudget),
    toolName: 'alembic_intent',
  });

  const record: IntentRecord = {
    createdAt: new Date().toISOString(),
    detailRefs,
    extracted: intake.extracted,
    hostIntentFrame: intake.hostIntentFrame,
    hostIntentInput: intake.hostIntentInput,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    intentRef,
    lifecycle: intake.lifecycle,
    sourceRefs: intake.sourceRefs,
    vectorPlan,
  };
  rememberIntentRecord(record);

  return envelope({
    success: result.status !== 'failed',
    data: {
      detailRefs,
      intentRef,
      localRecord: {
        createdAt: record.createdAt,
        intentRef,
        status: result.status,
      },
      recognizedIntent: intake.hostIntentFrame.recognizedIntentDraft,
      result,
      sourcePolicy: buildSourcePolicy(intake),
      vectorPlan,
    },
    message: formatIntentMessage(result, intake.hostIntentFrame),
    meta: { tool: 'alembic_intent' },
  });
}

export async function primeHandler(ctx: McpContext, args: AgentPrimeArgs) {
  const record =
    typeof args.intentRef === 'string' ? (INTENT_RECORDS.get(args.intentRef) ?? null) : null;
  const intake = record ? intakeFromRecord(record, ctx, args) : buildIntentIntake(ctx, args);
  const blockingReason = resolvePrimeBlockingReason(args, record, intake);
  if (blockingReason) {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'prime',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: {
        kind: 'blocked',
        code: blockingReason.code,
        message: blockingReason.message,
        retryable: false,
      },
      refs: {
        ...(args.intentRef
          ? {
              intentRef: {
                refType: 'intent' as const,
                id: args.intentRef,
                toolName: 'alembic_intent' as const,
              },
            }
          : {}),
        detailRefs: buildBaseDetailRefs('alembic_prime', intake.sourceRefs),
      },
      status: 'blocked',
      summary: buildResultSummary(blockingReason.message, args.outputBudget),
      toolName: 'alembic_prime',
    });
    return envelope({
      success: false,
      data: { result },
      message: blockingReason.message,
      meta: { tool: 'alembic_prime' },
    });
  }

  const lifecycle = intake.lifecycle;
  const detailRefs = buildBaseDetailRefs('alembic_prime', intake.sourceRefs);
  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  let searchResult: PrimeSearchResult | null = null;
  let searchDegraded = false;
  let skippedReason:
    | 'mechanical-envelope-only'
    | 'no-semantic-intent'
    | 'status-only-turn'
    | 'not-relevant-to-project-knowledge'
    | null = null;

  if (lifecycle.primeDecision.action === 'skip') {
    skippedReason = mapPrimeSkipReason(lifecycle.primeDecision.reasonCode);
  } else {
    const pipeline = getPipeline(ctx.container);
    if (!pipeline) {
      searchDegraded = true;
    } else {
      try {
        searchResult = await pipeline.search(intake.extracted, {
          hostIntentFrame: intake.hostIntentFrame,
          projectRoot: effectiveProjectRoot,
        });
      } catch (err: unknown) {
        searchDegraded = true;
        process.stderr.write(
          `[MCP/AgentPublicTools] alembic_prime search degraded: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  const projectRuntime = buildCodexPrimeRuntimeContext({
    projectRoot: effectiveProjectRoot,
    residentSearch: searchResult?.searchMeta.residentSearch ?? null,
  });
  const primeKnowledgeMaterial = buildPrimeKnowledgeMaterial({
    extracted: intake.extracted,
    hostIntentFrame: intake.hostIntentFrame,
    hostIntentInput: intake.hostIntentInput,
    intentEpisode: createUnavailablePrimeIntentEpisodeMaterial(
      'agent-public-prime keeps IntentEpisode handoff out of Stage 3 active surface'
    ),
    searchDegraded,
    searchResult,
    taskAnchorDecision: lifecycle.taskAnchorDecision,
  });

  const status = resolvePrimeStatus({
    primeKnowledgeMaterial,
    searchDegraded,
    searchResult,
    skippedReason,
  });
  const primeRef = nextPrimeRef();
  const intentRef = record?.intentRef ?? args.intentRef;
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'prime',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
      ...(intentRef
        ? {
            intentRef: {
              refType: 'intent' as const,
              id: intentRef,
              toolName: 'alembic_intent' as const,
            },
          }
        : {}),
      detailRefs,
      primeRef: { refType: 'prime', id: primeRef, toolName: 'alembic_prime' },
    },
    ...(status.reason ? { reason: status.reason } : {}),
    status: status.status,
    summary: buildResultSummary(status.summary, args.outputBudget),
    toolName: 'alembic_prime',
  });

  bindPrimeSessionIntent(ctx, intake, searchResult, projectRuntime);

  return envelope({
    success: result.status !== 'failed' && result.status !== 'blocked',
    data: {
      detailRefs,
      knowledge: searchResult
        ? {
            guardRules: searchResult.guardRules,
            relatedKnowledge: searchResult.relatedKnowledge,
          }
        : null,
      primeKnowledgeMaterial,
      primePackage: {
        primeRef,
        structureFirst: intake.vectorPlan,
        trustReceipt: {
          hostResponse: primeKnowledgeMaterial.hostResponse,
          receiptId: primeKnowledgeMaterial.receiptId,
          status: primeKnowledgeMaterial.status,
          trustPosture: primeKnowledgeMaterial.trustPosture,
        },
      },
      projectRuntime,
      result,
      searchMeta: searchResult
        ? { ...searchResult.searchMeta, projectRuntime }
        : { projectRuntime },
    },
    message: formatPrimeMessage(result, primeKnowledgeMaterial),
    meta: { tool: 'alembic_prime' },
  });
}

function buildIntentIntake(ctx: McpContext, args: AgentPublicBaseArgs) {
  const hostDeclaredIntent = mergeRecognizedIntent(args);
  const rawUserQuery = firstString(args.userQuery, (args as AgentPrimeArgs).query);
  const hostIntentInput = prepareHostIntentInput({
    activeFile: args.activeFile,
    hostDeclaredIntent,
    hostTurnMeta: args.hostTurnMeta,
    language: args.language,
    requestHostTurnMeta: ctx.hostTurnMeta,
    userQuery: rawUserQuery,
  });
  const extracted = extractIntent(
    hostIntentInput.userQuery,
    hostIntentInput.activeFile,
    hostIntentInput.language
  );
  const hostIntentFrame = buildHostIntentFrame(hostIntentInput, extracted);
  const lifecycle = classifyTaskLifecycleInput({
    hostIntentFrame,
    operation: 'prime',
    rawUserQuery,
    userQuery: hostIntentInput.userQuery,
  });
  const sourceRefs = uniqueStrings([
    ...(args.sourceRefs ?? []),
    ...(hostIntentFrame.recognizedIntentDraft.sourceRefs ?? []),
    ...(hostIntentFrame.hostDeclaredIntent?.sourceRefs ?? []),
  ]);
  const inputSource = resolveAgentInputSource(args.inputSource, lifecycle.inputSource);
  const intentKind = args.intentKind ?? mapLifecycleIntentKind(lifecycle, hostIntentFrame);
  return {
    agentHost: args.agentHost ?? ('codex' as const),
    extracted,
    hostIntentFrame,
    hostIntentInput,
    inputSource,
    intentKind,
    lifecycle,
    sourceRefs,
    vectorPlan: buildVectorPlan(extracted),
  };
}

function intakeFromRecord(record: IntentRecord, ctx: McpContext, args: AgentPrimeArgs) {
  return {
    agentHost: args.agentHost ?? ('codex' as const),
    extracted: record.extracted,
    hostIntentFrame: record.hostIntentFrame,
    hostIntentInput: record.hostIntentInput,
    inputSource: args.inputSource ?? record.inputSource,
    intentKind: args.intentKind ?? record.intentKind,
    lifecycle: record.lifecycle,
    sourceRefs: uniqueStrings([...(record.sourceRefs ?? []), ...(args.sourceRefs ?? [])]),
    vectorPlan: record.vectorPlan,
    projectRoot: resolveEffectiveProjectRoot(ctx, args),
  };
}

function mergeRecognizedIntent(args: AgentPublicBaseArgs): HostDeclaredIntentInput | undefined {
  const recognized = (args as AgentPrimeArgs).recognizedIntent;
  const base = args.hostDeclaredIntent;
  if (!recognized || typeof recognized !== 'object' || Array.isArray(recognized)) {
    return base;
  }
  const record = recognized as Record<string, unknown>;
  const merged: HostDeclaredIntentInput = {
    ...(base ?? {}),
    ...(typeof record.query === 'string' ? { query: record.query } : {}),
    ...(typeof record.action === 'string' ? { action: record.action } : {}),
    ...(typeof record.language === 'string' ? { language: record.language } : {}),
    ...(typeof record.target === 'string' ? { module: record.target } : {}),
  };
  if (Object.keys(merged).length === 0) {
    return base;
  }
  return merged;
}

function resolveIntentStatus(
  lifecycle: TaskLifecycleClassification,
  hostIntentFrame: HostIntentFrame
): Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string } {
  const draft = hostIntentFrame.recognizedIntentDraft;
  if (lifecycle.inputSource === 'automation-envelope') {
    return {
      reason: {
        kind: 'skip',
        code: 'mechanical-envelope-only',
        message:
          'Raw automation envelope detected without enough curated host intent for public intent intake.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Skipped raw automation envelope; provide hostDeclaredIntent and sourceRefs.',
    };
  }
  if (!draft.query.trim()) {
    return {
      reason: {
        kind: 'skip',
        code: 'no-semantic-intent',
        message: 'No semantic intent query was available after host intake normalization.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Skipped intent intake because no semantic query was available.',
    };
  }
  if (draft.status !== 'recognized') {
    return {
      reason: {
        kind: 'degraded',
        code: 'low-confidence-intent',
        message: `Intent recognized with degraded confidence: ${draft.degradedReasons.join('; ') || draft.status}.`,
        retryable: true,
      },
      status: 'degraded',
      summary: `Intent captured with degraded confidence for "${draft.query}".`,
    };
  }
  return {
    status: 'ready',
    summary: `Intent captured for "${draft.query}".`,
  };
}

function resolvePrimeBlockingReason(
  args: AgentPrimeArgs,
  record: IntentRecord | null,
  intake: ReturnType<typeof buildIntentIntake>
): {
  code: 'missing-required-intent' | 'missing-referenced-docs';
  message: string;
} | null {
  const hasFallbackIntent = Boolean(
    intake.hostIntentFrame.recognizedIntentDraft.query.trim() ||
      args.recognizedIntent ||
      args.hostDeclaredIntent
  );
  if (!args.intentRef && !hasFallbackIntent) {
    return {
      code: 'missing-required-intent',
      message: 'alembic_prime requires an intentRef or an explicit recognizedIntent fallback.',
    };
  }
  if (args.intentRef && !record && !hasFallbackIntent) {
    return {
      code: 'missing-required-intent',
      message: `No local intent record exists for intentRef ${args.intentRef}.`,
    };
  }
  if (intake.inputSource === 'automation-envelope' && intake.sourceRefs.length === 0) {
    return {
      code: 'missing-referenced-docs',
      message:
        'Automation-envelope prime requires explicit sourceRefs so the host can verify referenced dispatch/plan evidence.',
    };
  }
  return null;
}

function resolvePrimeStatus(input: {
  primeKnowledgeMaterial: { status: string };
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  skippedReason:
    | 'mechanical-envelope-only'
    | 'no-semantic-intent'
    | 'status-only-turn'
    | 'not-relevant-to-project-knowledge'
    | null;
}): Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string } {
  if (input.skippedReason) {
    return {
      reason: {
        kind: 'skip',
        code: input.skippedReason,
        message: `Prime skipped by intent lifecycle policy: ${input.skippedReason}.`,
        retryable: false,
      },
      status: 'skipped',
      summary: `Prime skipped: ${input.skippedReason}.`,
    };
  }
  if (input.searchDegraded) {
    return {
      reason: {
        kind: 'degraded',
        code: 'resident-unavailable',
        message:
          'Prime search degraded because the search pipeline or resident route was unavailable.',
        retryable: true,
      },
      status: 'degraded',
      summary: 'Prime degraded before delivering trusted Recipe or Guard knowledge.',
    };
  }
  const relatedCount = input.searchResult?.relatedKnowledge.length ?? 0;
  const guardCount = input.searchResult?.guardRules.length ?? 0;
  if (relatedCount === 0 && guardCount === 0) {
    return {
      reason: {
        kind: 'degraded',
        code: 'knowledge-empty',
        message:
          'Prime completed structure-first retrieval but found no matching Recipe or Guard knowledge.',
        retryable: true,
      },
      status: 'degraded',
      summary: 'Prime found no matching Recipe or Guard knowledge.',
    };
  }
  return {
    status: 'ready',
    summary: `Prime delivered ${relatedCount} Recipe/pattern item(s) and ${guardCount} Guard/rule item(s).`,
  };
}

function bindPrimeSessionIntent(
  ctx: McpContext,
  intake: ReturnType<typeof buildIntentIntake>,
  searchResult: PrimeSearchResult | null,
  projectRuntime: Record<string, unknown>
): void {
  if (!ctx.session) {
    return;
  }
  const freshIntent = createIdleIntent();
  freshIntent.phase = 'active';
  freshIntent.primeQuery = intake.hostIntentInput.userQuery;
  freshIntent.primeActiveFile = intake.hostIntentInput.activeFile;
  freshIntent.primeLanguage = intake.extracted.language;
  freshIntent.primeModule = intake.extracted.module;
  freshIntent.primeScenario = intake.extracted.scenario;
  freshIntent.hostIntentFrame = intake.hostIntentFrame;
  freshIntent.primeAt = Date.now();
  if (searchResult) {
    freshIntent.primeRecipeIds = [...searchResult.relatedKnowledge, ...searchResult.guardRules]
      .map((item) => item.id)
      .filter(Boolean);
    freshIntent.searchMeta = {
      filteredCount: searchResult.searchMeta.filteredCount,
      projectRuntime,
      queries: searchResult.searchMeta.queries,
      resultCount: searchResult.searchMeta.resultCount,
      ...(searchResult.searchMeta.intentEvidence
        ? { intentEvidence: searchResult.searchMeta.intentEvidence }
        : {}),
      ...(searchResult.searchMeta.primeInjectionPackage
        ? { primeInjectionPackage: searchResult.searchMeta.primeInjectionPackage }
        : {}),
      ...(searchResult.searchMeta.residentSearch
        ? {
            residentSearch: searchResult.searchMeta.residentSearch as unknown as Record<
              string,
              unknown
            >,
          }
        : {}),
    };
  }
  ctx.session.intent = freshIntent;
}

function buildVectorPlan(extracted: ExtractedIntent): AgentVectorPlan {
  return {
    keywordQueries: extracted.keywordQueries.slice(0, 4),
    language: extracted.language,
    module: extracted.module,
    queries: extracted.queries.slice(0, 5),
    retrievalOrder: [
      'structure hints from activeFile/module',
      'auto BM25/FWS queries',
      'semantic resident search when available',
      'keyword synonym expansion',
      'quality-filtered Recipe/Guard split',
    ],
    route: 'structure-first-recipe-retrieval',
    scenario: extracted.scenario,
  };
}

function buildBaseDetailRefs(toolName: 'alembic_intent' | 'alembic_prime', sourceRefs: string[]) {
  const refs = [
    createAgentDetailRef({
      id: 'agent-public-contract',
      kind: 'contract',
      requiredForCompletion: true,
      summary: 'Agent-facing public tool result envelope contract',
      uri: 'lib/codex/mcp/public-tools/contract.ts',
    }),
    createAgentDetailRef({
      id: `${toolName}-handler`,
      kind: 'file',
      requiredForCompletion: true,
      summary: `${toolName} active MCP handler implementation`,
      uri: 'lib/codex/mcp/handlers/agent-public-tools.ts',
    }),
    createAgentDetailRef({
      id: `${toolName}-schema`,
      kind: 'schema',
      requiredForCompletion: true,
      summary: `${toolName} active Zod MCP input schema`,
      uri: 'lib/shared/schemas/mcp-tools.ts',
    }),
  ];
  for (const [index, sourceRef] of sourceRefs.slice(0, 8).entries()) {
    refs.push(
      createAgentDetailRef({
        id: `${toolName}-source-ref-${index + 1}`,
        kind: 'source-ref',
        requiredForCompletion: false,
        summary: `Host supplied sourceRef ${index + 1}`,
        uri: sourceRef,
      })
    );
  }
  return refs;
}

function buildSourcePolicy(intake: ReturnType<typeof buildIntentIntake>) {
  return {
    automationEnvelope:
      intake.inputSource === 'automation-envelope'
        ? {
            requiredSourceRefsForPrime: true,
            sourceRefsCount: intake.sourceRefs.length,
          }
        : null,
    hostTurnMetaRedacted: Boolean(intake.hostIntentFrame.hostTurnMeta),
    rawThreadIdsPersisted: false,
  };
}

function buildResultSummary(
  compact: string,
  outputBudget: AgentPublicBaseArgs['outputBudget'] | undefined
) {
  const maxChars = Math.max(1, Math.min(outputBudget?.maxChars ?? 1600, 2000));
  const truncated = compact.length > maxChars;
  const visible = truncated ? compact.slice(0, Math.max(0, maxChars - 1)) : compact;
  return {
    compact: visible,
    outputBudget: {
      maxChars,
      mode: outputBudget?.mode ?? ('compact' as const),
      truncated,
      usedChars: visible.length,
    },
  };
}

function formatIntentMessage(
  result: AgentPublicToolResultEnvelope,
  hostIntentFrame: HostIntentFrame
): string {
  const draft = hostIntentFrame.recognizedIntentDraft;
  if (result.status === 'ready') {
    return `Intent ready: ${draft.action || 'intent'} ${draft.query}`.trim();
  }
  return `${result.status}: ${result.reason?.message ?? draft.degradedReasons.join('; ')}`;
}

function formatPrimeMessage(
  result: AgentPublicToolResultEnvelope,
  primeKnowledgeMaterial: { trustPosture: Parameters<typeof formatPrimeTrustPostureMessage>[0] }
): string {
  return [
    result.summary.compact,
    formatPrimeTrustPostureMessage(primeKnowledgeMaterial.trustPosture),
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveEffectiveProjectRoot(ctx: McpContext, args: AgentPublicBaseArgs): string {
  return typeof args.projectRoot === 'string' && args.projectRoot.trim()
    ? args.projectRoot.trim()
    : resolveProjectRoot(ctx.container);
}

function resolveAgentInputSource(
  explicit: AgentInputSource | undefined,
  lifecycleSource: TaskLifecycleClassification['inputSource']
): AgentInputSource {
  if (explicit) {
    return explicit;
  }
  switch (lifecycleSource) {
    case 'automation-envelope':
      return 'automation-envelope';
    case 'direct-thread-follow-up':
      return 'host-turn-metadata';
    case 'system-or-tool-continuation':
      return 'tool-result';
    case 'status-or-readonly':
      return 'user-message';
    case 'user-intent':
      return 'user-message';
    case 'unknown':
      return 'user-message';
  }
}

function mapLifecycleIntentKind(
  lifecycle: TaskLifecycleClassification,
  hostIntentFrame: HostIntentFrame
): AgentIntentKind {
  const action = hostIntentFrame.recognizedIntentDraft.action.toLowerCase();
  if (action === 'fix') {
    return 'fix-task';
  }
  if (action === 'refactor') {
    return 'refactor-task';
  }
  switch (lifecycle.intentKind) {
    case 'automation-control':
      return 'mechanical-envelope';
    case 'code-change-task':
    case 'explicit-task-anchor':
      return 'implementation-task';
    case 'design-discussion':
      return 'design-or-planning';
    case 'knowledge-query':
    case 'read-only-analysis':
      return 'read-only-analysis';
    case 'status-report':
      return 'status-only';
    case 'unknown':
      return 'unknown';
  }
}

function mapPrimeSkipReason(
  reasonCode: TaskLifecycleClassification['primeDecision']['reasonCode']
):
  | 'mechanical-envelope-only'
  | 'no-semantic-intent'
  | 'status-only-turn'
  | 'not-relevant-to-project-knowledge' {
  switch (reasonCode) {
    case 'automation-envelope-needs-context':
      return 'mechanical-envelope-only';
    case 'no-semantic-query':
      return 'no-semantic-intent';
    case 'status-only':
      return 'status-only-turn';
    case 'uninitialized-project':
    case 'knowledge-ready-code-task':
    case 'knowledge-ready-user-query':
      return 'not-relevant-to-project-knowledge';
  }
}

function getPipeline(container: McpServiceContainer): PipelineLike | null {
  try {
    return (container.get('primeSearchPipeline') as PipelineLike | null) ?? null;
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/AgentPublicTools] primeSearchPipeline unavailable: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

function nextIntentRef(): string {
  intentCounter++;
  return `intent-${Date.now().toString(36)}-${intentCounter}`;
}

function nextPrimeRef(): string {
  primeCounter++;
  return `prime-public-${Date.now().toString(36)}-${primeCounter}`;
}

function rememberIntentRecord(record: IntentRecord): void {
  INTENT_RECORDS.set(record.intentRef, record);
  if (INTENT_RECORDS.size <= 100) {
    return;
  }
  const oldest = [...INTENT_RECORDS.entries()].sort(
    (left, right) => new Date(left[1].createdAt).getTime() - new Date(right[1].createdAt).getTime()
  )[0]?.[0];
  if (oldest) {
    INTENT_RECORDS.delete(oldest);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}
