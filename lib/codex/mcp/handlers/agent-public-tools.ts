import type { AlembicResidentServiceResult } from '@alembic/core/daemon';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexPrimeRuntimeContext } from '#codex/runtime/ProjectRuntimeContext.js';
import type {
  ResidentDecisionRegisterRequest,
  ResidentDecisionRegisterResult,
  ResidentDecisionRegisterStatus,
} from '#service/resident/AlembicResidentServiceClient.js';
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
  decideGuardTrigger,
  normalizeTaskLifecycleFileRefs,
  type TaskLifecycleClassification,
} from '#service/task/TaskLifecyclePolicy.js';
import { envelope } from '../envelope.js';
import {
  type AgentDetailRef,
  type AgentHost,
  type AgentInputSource,
  type AgentIntentKind,
  type AgentPublicToolName,
  type AgentPublicToolResultEnvelope,
  createAgentDetailRef,
  createAgentPublicToolResultEnvelope,
} from '../public-tools/index.js';
import * as guardHandlers from './guard.js';
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

interface AgentWorkStartArgs extends AgentPublicBaseArgs {
  intentRef?: string;
  primeRef?: string;
  title?: string;
  workScope?: {
    files?: string[];
    goal?: string;
    summary?: string;
  };
}

interface AgentWorkFinishArgs extends AgentPublicBaseArgs {
  changedFiles?: string[];
  evidenceRefs?: string[];
  intentRef?: string;
  outcome?: 'completed' | 'blocked' | 'abandoned';
  primeRef?: string;
  reason?: string;
  summary?: string;
  workRef?: string;
}

interface AgentCodeGuardArgs extends AgentPublicBaseArgs {
  code?: string;
  filePath?: string;
  files?: string[];
  intentRef?: string;
  language?: string;
  operation?: 'check' | 'review';
  workRef?: string;
}

interface AgentDecisionRecordArgs extends AgentPublicBaseArgs {
  action?: 'create' | 'update' | 'revoke' | 'delete' | 'read' | 'list';
  decisionRef?: string;
  description?: string;
  evidenceRefs?: string[];
  includeDeleted?: boolean;
  intentRef?: string;
  limit?: number;
  rationale?: string;
  sessionId?: string;
  status?: ResidentDecisionRegisterStatus;
  tags?: string[];
  title?: string;
  workRef?: string;
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

interface WorkRecord {
  agentHost: AgentHost;
  createdAt: string;
  detailRefs: AgentDetailRef[];
  finishRef?: string;
  finishedAt?: string;
  hostIntentFrame: HostIntentFrame;
  inputSource: AgentInputSource;
  intentKind: AgentIntentKind;
  intentRef?: string;
  primeRef?: string;
  scopeFiles: string[];
  sourceRefs: string[];
  title: string;
  workRef: string;
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

interface ResidentDecisionRegisterClientLike {
  decisionRegister(
    request: ResidentDecisionRegisterRequest
  ): Promise<AlembicResidentServiceResult<ResidentDecisionRegisterResult>>;
}

let intentCounter = 0;
let primeCounter = 0;
let workCounter = 0;
let finishCounter = 0;
let guardCounter = 0;
const INTENT_RECORDS = new Map<string, IntentRecord>();
const WORK_RECORDS = new Map<string, WorkRecord>();

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
  const retrievalConsumer = searchResult?.searchMeta.retrievalConsumer ?? null;

  const status = resolvePrimeStatus({
    primeKnowledgeMaterial,
    retrievalConsumer,
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
        retrievalConsumer,
        structureFirst: intake.vectorPlan,
        trustReceipt: {
          hostResponse: primeKnowledgeMaterial.hostResponse,
          receiptId: primeKnowledgeMaterial.receiptId,
          status: primeKnowledgeMaterial.status,
          trustPosture: primeKnowledgeMaterial.trustPosture,
        },
      },
      projectRuntime,
      retrievalConsumer,
      result,
      searchMeta: searchResult
        ? { ...searchResult.searchMeta, projectRuntime }
        : { projectRuntime },
    },
    message: formatPrimeMessage(result, primeKnowledgeMaterial),
    meta: { tool: 'alembic_prime' },
  });
}

export async function workStartHandler(ctx: McpContext, args: AgentWorkStartArgs) {
  const intake = buildIntentIntake(ctx, args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_work_start',
    uniqueStrings([...(args.sourceRefs ?? []), ...(args.workScope?.files ?? [])])
  );
  const status = resolveWorkStartStatus(intake, args);
  if (status.status !== 'ready') {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'work-start',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: status.reason,
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
        detailRefs,
      },
      status: status.status,
      summary: buildResultSummary(status.summary, args.outputBudget),
      toolName: 'alembic_work_start',
    });
    return envelope({
      success: result.status === 'skipped',
      data: { result },
      message: result.summary.compact,
      meta: { tool: 'alembic_work_start' },
    });
  }

  const workRef = nextWorkRef();
  const title =
    firstString(
      args.title,
      args.workScope?.goal,
      intake.hostIntentFrame.recognizedIntentDraft.query
    ) ?? workRef;
  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  const scopeFiles = normalizeTaskLifecycleFileRefs(
    [
      ...(args.workScope?.files ?? []),
      ...(args.sourceRefs ?? []),
      ...(args.activeFile ? [args.activeFile] : []),
    ],
    { projectRoot: effectiveProjectRoot }
  );
  const record: WorkRecord = {
    agentHost: intake.agentHost,
    createdAt: new Date().toISOString(),
    detailRefs,
    hostIntentFrame: intake.hostIntentFrame,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    ...(args.intentRef ? { intentRef: args.intentRef } : {}),
    ...(args.primeRef ? { primeRef: args.primeRef } : {}),
    scopeFiles,
    sourceRefs: intake.sourceRefs,
    title,
    workRef,
  };
  rememberWorkRecord(record);
  bindWorkSession(ctx, record, intake);

  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'work-start',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
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
      ...(args.primeRef
        ? {
            primeRef: {
              refType: 'prime' as const,
              id: args.primeRef,
              toolName: 'alembic_prime' as const,
            },
          }
        : {}),
      detailRefs,
      workRef: { refType: 'work', id: workRef, toolName: 'alembic_work_start' },
    },
    status: 'ready',
    summary: buildResultSummary(`Work started for "${title}".`, args.outputBudget),
    toolName: 'alembic_work_start',
  });

  return envelope({
    success: true,
    data: {
      detailRefs,
      localRecord: {
        createdAt: record.createdAt,
        scopeFiles,
        title,
        workRef,
      },
      result,
      workRef,
    },
    message: `Work ready: ${workRef} ${title}`.trim(),
    meta: { tool: 'alembic_work_start' },
  });
}

export async function workFinishHandler(ctx: McpContext, args: AgentWorkFinishArgs) {
  const intake = buildIntentIntake(ctx, args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_work_finish',
    uniqueStrings([...(args.sourceRefs ?? []), ...(args.evidenceRefs ?? [])])
  );
  const record = typeof args.workRef === 'string' ? WORK_RECORDS.get(args.workRef) : undefined;
  if (!args.workRef || !record) {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'work-finish',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: {
        kind: 'blocked',
        code: 'missing-work-ref',
        message: args.workRef
          ? `No active work record exists for workRef ${args.workRef}.`
          : 'alembic_work_finish requires a workRef returned by alembic_work_start.',
        retryable: false,
      },
      refs: { detailRefs },
      status: 'blocked',
      summary: buildResultSummary(
        'Work finish blocked because workRef is missing.',
        args.outputBudget
      ),
      toolName: 'alembic_work_finish',
    });
    return envelope({
      success: false,
      data: { result },
      message: result.reason?.message ?? result.summary.compact,
      meta: { tool: 'alembic_work_finish' },
    });
  }

  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  const changedFiles = normalizeTaskLifecycleFileRefs(args.changedFiles ?? [], {
    projectRoot: effectiveProjectRoot,
  });
  const guardDecision = decideGuardTrigger({
    changedFiles,
    taskAnchorExists: true,
    taskScopeFiles: uniqueStrings([...record.scopeFiles, ...changedFiles]),
  });
  const finishRef = nextFinishRef();
  const finishedAt = new Date().toISOString();
  record.finishRef = finishRef;
  record.finishedAt = finishedAt;
  const outcome = args.outcome ?? 'completed';
  const summary =
    firstString(args.summary, args.reason) ??
    (outcome === 'completed'
      ? `Work ${record.workRef} completed.`
      : `Work ${record.workRef} ${outcome}.`);

  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'work-finish',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
      ...(record.intentRef
        ? {
            intentRef: {
              refType: 'intent' as const,
              id: record.intentRef,
              toolName: 'alembic_intent' as const,
            },
          }
        : {}),
      ...(record.primeRef
        ? {
            primeRef: {
              refType: 'prime' as const,
              id: record.primeRef,
              toolName: 'alembic_prime' as const,
            },
          }
        : {}),
      detailRefs,
      finishRef: { refType: 'finish', id: finishRef, toolName: 'alembic_work_finish' },
      workRef: { refType: 'work', id: record.workRef, toolName: 'alembic_work_start' },
    },
    status: 'ready',
    summary: buildResultSummary(summary, args.outputBudget),
    toolName: 'alembic_work_finish',
  });

  return envelope({
    success: true,
    data: {
      changedFiles,
      detailRefs,
      evidenceRefs: args.evidenceRefs ?? [],
      finishRef,
      guardRecommendation: buildGuardRecommendation(guardDecision),
      localRecord: {
        finishedAt,
        outcome,
        workRef: record.workRef,
      },
      outcome,
      result,
      workRef: record.workRef,
    },
    message: [
      `Work finished: ${record.workRef}`,
      formatGuardRecommendationMessage(guardDecision),
    ].join('\n'),
    meta: { tool: 'alembic_work_finish' },
  });
}

export async function codeGuardHandler(ctx: McpContext, args: AgentCodeGuardArgs) {
  const intake = buildIntentIntake(ctx, args);
  const detailRefs = buildBaseDetailRefs('alembic_code_guard', args.sourceRefs ?? []);
  const hasCode = typeof args.code === 'string' && args.code.trim().length > 0;
  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  const files = normalizeTaskLifecycleFileRefs(args.files ?? [], {
    projectRoot: effectiveProjectRoot,
  });
  if (!hasCode && files.length === 0) {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: {
        kind: 'blocked',
        code: 'missing-guard-scope',
        message:
          'alembic_code_guard requires explicit files or inline code; it will not fall back to no-args whole-diff review.',
        retryable: false,
      },
      refs: {
        ...(args.workRef
          ? {
              workRef: {
                refType: 'work' as const,
                id: args.workRef,
                toolName: 'alembic_work_start' as const,
              },
            }
          : {}),
        detailRefs,
      },
      status: 'blocked',
      summary: buildResultSummary(
        'Code Guard blocked because no explicit scope was provided.',
        args.outputBudget
      ),
      toolName: 'alembic_code_guard',
    });
    return envelope({
      success: false,
      data: { result },
      message: result.reason?.message ?? result.summary.compact,
      meta: { tool: 'alembic_code_guard' },
    });
  }

  try {
    const guardEnvelope = hasCode
      ? await guardHandlers.guardCheck(ctx, {
          code: args.code,
          filePath: args.filePath,
          language: args.language,
        })
      : await guardHandlers.guardReview(ctx, { files });
    const guardResultRef = nextGuardResultRef();
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
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
        ...(args.workRef
          ? {
              workRef: {
                refType: 'work' as const,
                id: args.workRef,
                toolName: 'alembic_work_start' as const,
              },
            }
          : {}),
        detailRefs,
        guardResultRef: {
          refType: 'guard-result',
          id: guardResultRef,
          toolName: 'alembic_code_guard',
        },
      },
      status: 'ready',
      summary: buildResultSummary(
        hasCode
          ? 'Code Guard checked explicit inline code.'
          : `Code Guard checked ${files.length} explicit file(s).`,
        args.outputBudget
      ),
      toolName: 'alembic_code_guard',
    });
    return envelope({
      success: true,
      data: {
        detailRefs,
        explicitScope: hasCode
          ? { kind: 'code', filePath: args.filePath ?? null }
          : { files, kind: 'files' },
        guard: guardEnvelope,
        guardResultRef,
        result,
      },
      message: result.summary.compact,
      meta: { tool: 'alembic_code_guard' },
    });
  } catch (err: unknown) {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: {
        kind: 'failure',
        code: 'handler-error',
        message: `Scoped Code Guard failed: ${err instanceof Error ? err.message : String(err)}.`,
        retryable: true,
      },
      refs: { detailRefs },
      status: 'failed',
      summary: buildResultSummary(
        'Scoped Code Guard failed before producing results.',
        args.outputBudget
      ),
      toolName: 'alembic_code_guard',
    });
    return envelope({
      success: false,
      data: { result },
      message: result.reason?.message ?? result.summary.compact,
      meta: { tool: 'alembic_code_guard' },
    });
  }
}

export async function decisionRecordHandler(ctx: McpContext, args: AgentDecisionRecordArgs) {
  const intake = buildIntentIntake(ctx, args);
  const sourceRefs = uniqueStrings([...(args.sourceRefs ?? []), ...(args.evidenceRefs ?? [])]);
  const detailRefs = buildBaseDetailRefs('alembic_decision_record', sourceRefs);
  const action = args.action ?? 'create';
  const scopeBlocker = resolveDecisionScopeBlocker(action, args);
  if (scopeBlocker) {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'decision-record',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: {
        kind: 'blocked',
        code: 'decision-scope-unconfirmed',
        message: scopeBlocker,
        retryable: false,
      },
      refs: { detailRefs },
      status: 'blocked',
      summary: buildResultSummary(
        'Decision record blocked because decision scope is incomplete.',
        args.outputBudget
      ),
      toolName: 'alembic_decision_record',
    });
    return envelope({
      success: false,
      data: { result },
      message: result.reason?.message ?? result.summary.compact,
      meta: { tool: 'alembic_decision_record' },
    });
  }

  const client = resolveResidentDecisionRegisterClient(ctx.container);
  if (!client) {
    const result = buildDecisionRecordBlockedResult({
      args,
      detailRefs,
      intake,
      message:
        'Decision Register durable persistence is not available in AlembicPlugin; residentDecisionRegisterClient is not registered.',
      reasonCode: 'decision-register-unavailable',
      retryable: false,
      summary: 'Decision durable route unavailable; no local fake record was written.',
    });
    return envelope({
      success: false,
      data: {
        durablePersistence: {
          action,
          available: false,
          requiredRoute: 'Alembic durable Decision Register route',
        },
        requestedDecision: buildRequestedDecision(action, args),
        result,
      },
      message: result.reason?.message ?? result.summary.compact,
      meta: { tool: 'alembic_decision_record' },
    });
  }

  const residentRequest = buildDecisionRegisterRequest({
    action,
    args,
    detailRefs,
    sessionId: ctx.session?.id,
    sourceRefs,
  });
  const residentResult = await client.decisionRegister(residentRequest);
  if (!residentResult.ok) {
    const reasonCode = decisionRegisterBlockedCode(residentResult);
    const result = buildDecisionRecordBlockedResult({
      args,
      detailRefs,
      intake,
      message:
        residentResult.message ||
        (reasonCode === 'decision-register-capability-mismatch'
          ? 'Decision Register route is available but its capability contract is missing or mismatched.'
          : 'Decision Register durable route is unavailable.'),
      reasonCode,
      retryable: residentResult.retryable ?? true,
      summary:
        reasonCode === 'decision-register-capability-mismatch'
          ? 'Decision Register capability mismatch; no local fake record was written.'
          : 'Decision durable route unavailable; no local fake record was written.',
    });
    return envelope({
      success: false,
      data: {
        durablePersistence: {
          action,
          available: false,
          reason: residentResult.reason,
          requiredRoute: 'Alembic durable Decision Register route',
          route: residentResult.status?.route ?? null,
          owner: residentResult.status?.owner ?? null,
          telemetry: residentResult.telemetry ?? null,
        },
        requestedDecision: buildRequestedDecision(action, args),
        result,
      },
      message: result.reason?.message ?? result.summary.compact,
      meta: { tool: 'alembic_decision_record' },
    });
  }

  const decisionId = resolveDecisionId(residentResult.value, args);
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'decision-record',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: buildDecisionRecordRefs(args, detailRefs, decisionId),
    status: 'ready',
    summary: buildResultSummary(
      formatDecisionRecordSuccessSummary(action, residentResult.value, decisionId),
      args.outputBudget
    ),
    toolName: 'alembic_decision_record',
  });

  return envelope({
    success: true,
    data: {
      count: residentResult.value.count ?? null,
      decision: residentResult.value.decision,
      decisionRef: decisionId,
      decisions: residentResult.value.decisions ?? [],
      durablePersistence: {
        action,
        available: true,
        capability: residentResult.value.capability,
        owner: residentResult.status?.owner ?? null,
        route: residentResult.status?.route ?? null,
      },
      result,
    },
    message: result.summary.compact,
    meta: { tool: 'alembic_decision_record' },
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
  retrievalConsumer: PrimeSearchResult['searchMeta']['retrievalConsumer'] | null;
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
  if (input.retrievalConsumer && !input.retrievalConsumer.producerContract.available) {
    const isResidentUnavailable =
      input.retrievalConsumer.producerContract.reasonCode === 'resident-search-unavailable';
    const missingFields = input.retrievalConsumer.producerContract.missingFields.join(', ');
    return {
      reason: {
        kind: 'degraded',
        code: isResidentUnavailable ? 'resident-unavailable' : 'optional-service-unavailable',
        message: isResidentUnavailable
          ? 'Prime search could not read the Alembic resident retrieval metadata contract.'
          : `Prime search used a resident response without Stage 1A retrieval metadata: ${missingFields}.`,
        retryable: true,
      },
      status: 'degraded',
      summary: isResidentUnavailable
        ? 'Prime retrieval metadata is unavailable because the resident route was unavailable.'
        : 'Prime retrieval metadata is degraded because the resident Stage 1A contract is incomplete.',
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

function resolveWorkStartStatus(
  intake: ReturnType<typeof buildIntentIntake>,
  args: AgentWorkStartArgs
): Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string } {
  const hasWorkScope = Boolean(
    firstString(
      args.title,
      args.workScope?.goal,
      args.workScope?.summary,
      intake.hostIntentFrame.recognizedIntentDraft.query
    ) || (args.workScope?.files?.length ?? 0) > 0
  );
  if (!hasWorkScope) {
    return {
      reason: {
        kind: 'skip',
        code: 'no-work-scope',
        message: 'No concrete work scope was available for alembic_work_start.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Work start skipped because no concrete scope was available.',
    };
  }
  if (
    intake.lifecycle.taskAnchorDecision.action === 'skip' &&
    intake.lifecycle.taskAnchorDecision.reasonCode === 'automation-envelope-no-anchor' &&
    intake.sourceRefs.length === 0
  ) {
    return {
      reason: {
        kind: 'skip',
        code: 'mechanical-envelope-only',
        message:
          'Raw automation envelope work start requires curated hostDeclaredIntent and sourceRefs.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Work start skipped for raw automation envelope input.',
    };
  }
  if (
    intake.lifecycle.taskAnchorDecision.action === 'skip' &&
    intake.lifecycle.taskAnchorDecision.reasonCode === 'status-only-no-anchor'
  ) {
    return {
      reason: {
        kind: 'skip',
        code: 'status-only-turn',
        message: 'Status-only turns do not start tracked work.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Work start skipped for status-only input.',
    };
  }
  return {
    status: 'ready',
    summary: 'Work start can create a Plugin-owned workRef.',
  };
}

function buildGuardRecommendation(decision: ReturnType<typeof decideGuardTrigger>) {
  if (decision.action === 'run') {
    return {
      action: 'run',
      input: { files: decision.taskScopedFiles },
      reasonCode: decision.reasonCode,
      taskScopedFiles: decision.taskScopedFiles,
      tool: 'alembic_code_guard',
    };
  }
  return {
    action: 'skip',
    reason: `Guard skipped by Codex-aware lifecycle policy: ${decision.reasonCode}.`,
    reasonCode: decision.reasonCode,
    taskScopedFiles: decision.taskScopedFiles,
    tool: 'alembic_code_guard',
  };
}

function formatGuardRecommendationMessage(decision: ReturnType<typeof decideGuardTrigger>): string {
  if (decision.action === 'run') {
    return `Guard recommended: call alembic_code_guard with files=${JSON.stringify(decision.taskScopedFiles)}.`;
  }
  return `Guard skipped: ${decision.reasonCode}.`;
}

function resolveDecisionScopeBlocker(
  action: NonNullable<AgentDecisionRecordArgs['action']>,
  args: AgentDecisionRecordArgs
): string | null {
  if (action !== 'create' && action !== 'list' && !args.decisionRef?.trim()) {
    return `${action} requires an existing decisionRef.`;
  }
  if (action === 'create' && !firstString(args.title, args.description)) {
    return 'create requires a decision title or description.';
  }
  if (action === 'update' && !hasDecisionUpdatePayload(args)) {
    return 'update requires at least one decision field, tag, evidenceRef, intentRef, or workRef.';
  }
  return null;
}

function buildDecisionRecordBlockedResult(input: {
  args: AgentDecisionRecordArgs;
  detailRefs: AgentDetailRef[];
  intake: ReturnType<typeof buildIntentIntake>;
  message: string;
  reasonCode: 'decision-register-capability-mismatch' | 'decision-register-unavailable';
  retryable: boolean;
  summary: string;
}) {
  return createAgentPublicToolResultEnvelope({
    actionKind: 'decision-record',
    agentHost: input.intake.agentHost,
    inputSource: input.intake.inputSource,
    intentKind: input.intake.intentKind,
    reason: {
      kind: 'blocked',
      code: input.reasonCode,
      message: input.message,
      retryable: input.retryable,
    },
    refs: buildDecisionRecordRefs(input.args, input.detailRefs, null),
    status: 'blocked',
    summary: buildResultSummary(input.summary, input.args.outputBudget),
    toolName: 'alembic_decision_record',
  });
}

function buildDecisionRecordRefs(
  args: AgentDecisionRecordArgs,
  detailRefs: AgentDetailRef[],
  decisionId: string | null
) {
  return {
    ...(args.intentRef
      ? {
          intentRef: {
            refType: 'intent' as const,
            id: args.intentRef,
            toolName: 'alembic_intent' as const,
          },
        }
      : {}),
    ...(args.workRef
      ? {
          workRef: {
            refType: 'work' as const,
            id: args.workRef,
            toolName: 'alembic_work_start' as const,
          },
        }
      : {}),
    ...(decisionId
      ? {
          decisionRef: {
            refType: 'decision' as const,
            id: decisionId,
            toolName: 'alembic_decision_record' as const,
          },
        }
      : {}),
    detailRefs,
  };
}

function resolveResidentDecisionRegisterClient(
  container: McpServiceContainer
): ResidentDecisionRegisterClientLike | null {
  const splitClient = tryGetContainerService(container, 'residentDecisionRegisterClient');
  if (isResidentDecisionRegisterClientLike(splitClient)) {
    return splitClient;
  }
  const facadeClient = tryGetContainerService(container, 'residentServiceClient');
  if (isResidentDecisionRegisterClientLike(facadeClient)) {
    return facadeClient;
  }
  return null;
}

function tryGetContainerService(container: McpServiceContainer, name: string): unknown {
  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function isResidentDecisionRegisterClientLike(
  value: unknown
): value is ResidentDecisionRegisterClientLike {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as ResidentDecisionRegisterClientLike).decisionRegister === 'function'
  );
}

function buildDecisionRegisterRequest(input: {
  action: NonNullable<AgentDecisionRecordArgs['action']>;
  args: AgentDecisionRecordArgs;
  detailRefs: AgentDetailRef[];
  sessionId?: string;
  sourceRefs: string[];
}): ResidentDecisionRegisterRequest {
  const body = buildDecisionRegisterRequestBody(input);
  return {
    action: input.action,
    ...(input.action !== 'create' && input.action !== 'list'
      ? { decisionId: firstString(input.args.decisionRef) }
      : {}),
    ...(body ? { body } : {}),
    ...(typeof input.args.includeDeleted === 'boolean'
      ? { includeDeleted: input.args.includeDeleted }
      : {}),
    ...(typeof input.args.limit === 'number' && Number.isFinite(input.args.limit)
      ? { limit: input.args.limit }
      : {}),
    ...(typeof input.args.projectRoot === 'string' && input.args.projectRoot.trim()
      ? { projectRoot: input.args.projectRoot.trim() }
      : {}),
    ...(firstString(input.args.sessionId, input.sessionId)
      ? { sessionId: firstString(input.args.sessionId, input.sessionId) }
      : {}),
    ...(input.args.status ? { status: input.args.status } : {}),
  };
}

function buildDecisionRegisterRequestBody(input: {
  action: NonNullable<AgentDecisionRecordArgs['action']>;
  args: AgentDecisionRecordArgs;
  detailRefs: AgentDetailRef[];
  sessionId?: string;
  sourceRefs: string[];
}): Record<string, unknown> | undefined {
  if (input.action === 'list' || input.action === 'read') {
    return undefined;
  }
  const detailRefUris = input.detailRefs.map((ref) => ref.uri ?? ref.id);
  const description = firstString(input.args.description, input.args.title);
  const title = truncateDecisionTitle(firstString(input.args.title, description));
  const base = compactRecord({
    ...(input.action === 'create' ? { createdBy: 'codex-host-agent' } : {}),
    ...(input.action !== 'create' ? { updatedBy: 'codex-host-agent' } : {}),
    decision: input.args.description ?? (input.action === 'create' ? title : undefined),
    description,
    detailRefs: detailRefUris.length > 0 ? detailRefUris : undefined,
    intentRef: firstString(input.args.intentRef),
    metadata: {
      agentHost: input.args.agentHost ?? 'codex',
      inputSource: input.args.inputSource ?? 'user-message',
      intentKind: input.args.intentKind ?? null,
      sourceRefsCount: input.sourceRefs.length,
    },
    rationale: firstString(input.args.rationale),
    sourceRefs: input.sourceRefs.length > 0 ? input.sourceRefs : undefined,
    tags: input.args.tags?.length ? uniqueStrings(input.args.tags) : undefined,
    title,
    turnId: firstString(input.args.hostTurnMeta?.turnId, input.args.hostTurnMeta?.messageId),
    workRef: firstString(input.args.workRef),
  });
  if (input.action === 'revoke' || input.action === 'delete') {
    return compactRecord({
      reason: firstString(input.args.rationale, input.args.description),
      updatedBy: 'codex-host-agent',
    });
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function buildRequestedDecision(
  action: NonNullable<AgentDecisionRecordArgs['action']>,
  args: AgentDecisionRecordArgs
) {
  return {
    action,
    decisionRef: args.decisionRef ?? null,
    description: args.description ?? null,
    evidenceRefs: args.evidenceRefs ?? [],
    rationale: args.rationale ?? null,
    tags: args.tags ?? [],
    title: args.title ?? null,
  };
}

function decisionRegisterBlockedCode(
  result: Extract<AlembicResidentServiceResult<ResidentDecisionRegisterResult>, { ok: false }>
): 'decision-register-capability-mismatch' | 'decision-register-unavailable' {
  return result.reason === 'capability-unavailable'
    ? 'decision-register-capability-mismatch'
    : 'decision-register-unavailable';
}

function resolveDecisionId(
  result: ResidentDecisionRegisterResult,
  args: AgentDecisionRecordArgs
): string | null {
  const decisionId = isRecord(result.decision)
    ? firstString(result.decision.decisionId, result.decision.id)
    : null;
  return decisionId ?? firstString(args.decisionRef) ?? null;
}

function formatDecisionRecordSuccessSummary(
  action: NonNullable<AgentDecisionRecordArgs['action']>,
  result: ResidentDecisionRegisterResult,
  decisionId: string | null
): string {
  if (action === 'list') {
    return `Decision Register listed ${result.count ?? result.decisions?.length ?? 0} decision(s).`;
  }
  if (action === 'read') {
    return `Decision Register read decision ${decisionId ?? 'unknown'}.`;
  }
  return `Decision Register ${action} completed for decision ${decisionId ?? 'unknown'}.`;
}

function hasDecisionUpdatePayload(args: AgentDecisionRecordArgs): boolean {
  return Boolean(
    firstString(args.title, args.description, args.rationale, args.intentRef, args.workRef) ||
      (args.tags?.length ?? 0) > 0 ||
      (args.evidenceRefs?.length ?? 0) > 0 ||
      (args.sourceRefs?.length ?? 0) > 0
  );
}

function truncateDecisionTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > 240 ? value.slice(0, 240) : value;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

function bindWorkSession(
  ctx: McpContext,
  record: WorkRecord,
  intake: ReturnType<typeof buildIntentIntake>
): void {
  if (!ctx.session) {
    return;
  }
  const intent = ctx.session.intent.phase === 'idle' ? createIdleIntent() : ctx.session.intent;
  intent.phase = 'active';
  intent.taskId = record.workRef;
  intent.taskTitle = record.title;
  intent.primeQuery = intake.hostIntentInput.userQuery;
  intent.primeActiveFile = intake.hostIntentInput.activeFile;
  intent.primeLanguage = intake.extracted.language;
  intent.primeModule = intake.extracted.module;
  intent.primeScenario = intake.extracted.scenario;
  intent.hostIntentFrame = intake.hostIntentFrame;
  intent.primeAt = Date.now();
  for (const file of record.scopeFiles) {
    intent.mentionedFiles.push(file);
  }
  intent.toolCalls.push({
    args_summary: record.title,
    timestamp: Date.now(),
    tool: 'alembic_work_start',
  });
  ctx.session.intent = intent;
}

function rememberWorkRecord(record: WorkRecord): void {
  WORK_RECORDS.set(record.workRef, record);
  if (WORK_RECORDS.size <= 100) {
    return;
  }
  const oldest = [...WORK_RECORDS.entries()].sort(
    (left, right) => new Date(left[1].createdAt).getTime() - new Date(right[1].createdAt).getTime()
  )[0]?.[0];
  if (oldest) {
    WORK_RECORDS.delete(oldest);
  }
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

function buildBaseDetailRefs(toolName: AgentPublicToolName, sourceRefs: string[]) {
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

function nextWorkRef(): string {
  workCounter++;
  return `work-public-${Date.now().toString(36)}-${workCounter}`;
}

function nextFinishRef(): string {
  finishCounter++;
  return `finish-public-${Date.now().toString(36)}-${finishCounter}`;
}

function nextGuardResultRef(): string {
  guardCounter++;
  return `guard-public-${Date.now().toString(36)}-${guardCounter}`;
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
