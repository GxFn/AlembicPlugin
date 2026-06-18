import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexPrimeRuntimeContext } from '#codex/runtime/ProjectRuntimeContext.js';
import type { HostDeclaredIntentInput, HostTurnMetaInput } from '#service/task/HostIntentFrame.js';
import {
  buildPrimeKnowledgeMaterial,
  createUnavailablePrimeIntentEpisodeMaterial,
  type PrimeKnowledgeMaterial,
} from '#service/task/PrimeKnowledgeMaterial.js';
import type { PrimeSearchRequest, PrimeSearchResult } from '#service/task/PrimeSearchPipeline.js';
import {
  classifyTaskLifecycleInput,
  decideGuardTrigger,
  normalizeTaskLifecycleFileRefs,
  type TaskLifecycleClassification,
} from '#service/task/TaskLifecyclePolicy.js';
import * as guardHandlers from '../../../runtime/mcp/handlers/guard.js';
import {
  createIdleIntent,
  type McpContext,
  type McpServiceContainer,
} from '../../../runtime/mcp/handlers/types.js';
import {
  type AgentDetailRef,
  type AgentHost,
  type AgentInputSource,
  type AgentIntentKind,
  type AgentPublicToolName,
  type AgentPublicToolResultEnvelope,
  createAgentDetailRef,
  createAgentPublicToolOutput,
  createAgentPublicToolResultEnvelope,
  createPrimePublicPackage,
  PRIME_PUBLIC_TRUST_LAYERS,
  type PrimePublicPackage,
} from '../../../runtime/mcp/public-tools/index.js';

interface AgentPublicBaseArgs {
  activeFile?: string;
  agentHost?: AgentHost;
  hostDeclaredIntent?: HostDeclaredIntentInput;
  hostTurnMeta?: HostTurnMetaInput;
  inputSource?: AgentInputSource;
  intentKind?: AgentIntentKind;
  language?: string;
  projectRoot?: string;
  sourceEvidenceRefs?: string[];
  sourceRefs?: string[];
  userQuery?: string;
  [key: string]: unknown;
}

interface AgentPrimeArgs extends AgentPublicBaseArgs {
  capability?: string;
  domainObjects?: string[];
  integrationBoundary?: string;
  intentRef?: string;
  keywords?: string[];
  labels?: string[];
  lifecycleHint?: string;
  qualityConcerns?: string[];
  query?: string;
  recognizedIntent?: Record<string, unknown>;
  requirementGoal?: string;
  scenario?: string;
  taskAction?: string;
}

interface StandalonePrimeRequirementFrame {
  capability?: string;
  domainObjects: string[];
  integrationBoundary?: string;
  keywords: string[];
  labels: string[];
  lifecycleHint?: string;
  locatorFacets: string[];
  qualityConcerns: string[];
  requirementGoal?: string;
  scenario?: string;
  searchQuery?: string;
  taskAction?: string;
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
  validationPlan?: Record<string, unknown>;
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

interface WorkRecord {
  agentHost: AgentHost;
  createdAt: string;
  detailRefs: AgentDetailRef[];
  finishRef?: string;
  finishedAt?: string;
  inputSource: AgentInputSource;
  intentRef?: string;
  primeRef?: string;
  sourceEvidenceRefs: string[];
  scopeFiles: string[];
  sourceRefs: string[];
  title: string;
  workRef: string;
}

interface CodeGuardScopeResolution {
  explicitFiles: string[];
  files: string[];
  hasCode: boolean;
  unsupportedScopeFields: string[];
  workRecord?: WorkRecord;
  workRefFiles: string[];
}

interface PrimeHandlerSharedInput {
  args: AgentPrimeArgs;
  detailRefs: AgentDetailRef[];
  intake: ReturnType<typeof buildAgentToolContext>;
  primeRef: string;
}

interface PrimeHandlerReadyInput extends PrimeHandlerSharedInput {
  ctx: McpContext;
  effectiveProjectRoot: string;
  primeSearch: Awaited<ReturnType<typeof runPrimeSearch>>;
}

interface PrimeMaterialProjection {
  primeKnowledgeMaterial: PrimeKnowledgeMaterial;
  retrievalConsumer: PrimeSearchResult['searchMeta']['retrievalConsumer'] | null;
}

type AgentPrimeSkippedReason =
  | 'mechanical-envelope-only'
  | 'no-semantic-intent'
  | 'status-only-turn'
  | 'not-relevant-to-project-knowledge';

interface PipelineLike {
  search(request: PrimeSearchRequest): Promise<PrimeSearchResult | null>;
}

let primeCounter = 0;
let workCounter = 0;

const PRIME_PUBLIC_STRING_MAX_CHARS = 240;
let finishCounter = 0;
let guardCounter = 0;
const WORK_RECORDS = new Map<string, WorkRecord>();

export async function primeHandler(ctx: McpContext, args: AgentPrimeArgs) {
  const intake = buildPrimeToolContext(args);
  const detailRefs = buildBaseDetailRefs('alembic_prime', intake.sourceRefs);
  const primeRef = nextPrimeRef();
  const blockingReason = resolvePrimeBlockingReason(args, intake);
  if (blockingReason) {
    return buildPrimeBlockingOutput({
      args,
      detailRefs,
      intake,
      primeRef,
      blockingReason,
    });
  }

  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  const primeSearch = await runPrimeSearch(ctx, args, intake);
  return buildPrimeReadyOutput({
    args,
    ctx,
    detailRefs,
    effectiveProjectRoot,
    intake,
    primeRef,
    primeSearch,
  });
}

function buildPrimeBlockingOutput(
  input: PrimeHandlerSharedInput & {
    blockingReason: NonNullable<ReturnType<typeof resolvePrimeBlockingReason>>;
  }
) {
  const result = buildPrimeBlockingResult(input);
  const primePackage = buildPrimePublicPackage({
    detailRefs: input.detailRefs,
    intake: input.intake,
    primeKnowledgeMaterial: null,
    primeRef: input.primeRef,
    result,
    searchDegraded: false,
    searchResult: null,
  });
  // GMAP-8: prime is decoupled from the KnowledgeContext middle layer — return its
  // own prime-native output (primePackage + bounded detailRefs/diagnostics/nextActions).
  return createAgentPublicToolOutput(result, {
    primePackage,
    detailRefs: input.detailRefs,
    diagnostics: [
      {
        code: result.reason?.code ?? 'prime-blocked',
        message: result.reason?.message ?? result.summary,
        retryable: result.reason?.retryable ?? false,
        severity: 'warning' as const,
      },
    ],
    nextActions: [
      {
        tool: 'alembic_prime',
        reason: result.reason?.message ?? 'Repair the prime input and call alembic_prime again.',
        required: true,
      },
    ],
  });
}

function buildPrimeBlockingResult(
  input: PrimeHandlerSharedInput & {
    blockingReason: NonNullable<ReturnType<typeof resolvePrimeBlockingReason>>;
  }
) {
  return createAgentPublicToolResultEnvelope({
    actionKind: 'prime',
    agentHost: input.intake.agentHost,
    inputSource: input.intake.inputSource,
    intentKind: input.intake.intentKind,
    reason: {
      kind: 'blocked',
      code: input.blockingReason.code,
      message: input.blockingReason.message,
      retryable: false,
    },
    refs: buildPrimeRefs(input),
    status: 'blocked',
    summary: buildResultSummary(input.blockingReason.message),
    toolName: 'alembic_prime',
  });
}

function buildPrimeRefs(input: PrimeHandlerSharedInput) {
  return {
    detailRefs: input.detailRefs,
    primeRef: { refType: 'prime' as const, id: input.primeRef, toolName: 'alembic_prime' as const },
  };
}

async function buildPrimeReadyOutput(input: PrimeHandlerReadyInput) {
  const projectRuntime = buildCodexPrimeRuntimeContext({
    projectRoot: input.effectiveProjectRoot,
    residentSearch: input.primeSearch.searchResult?.searchMeta.residentSearch ?? null,
  });
  const material = buildPrimeMaterialProjection(
    input.intake,
    input.primeSearch,
    buildStandalonePrimeRequirementFrame(input.args),
    input.args
  );
  const effectiveSearchDegraded =
    input.primeSearch.searchDegraded || material.primeKnowledgeMaterial.status === 'degraded';
  const status = resolvePrimeStatus({
    primeKnowledgeMaterial: material.primeKnowledgeMaterial,
    retrievalConsumer: material.retrievalConsumer,
    searchDegraded: input.primeSearch.searchDegraded,
    searchResult: input.primeSearch.searchResult,
    skippedReason: input.primeSearch.skippedReason,
  });
  const result = buildPrimeReadyResult(input, status);

  bindPrimeSessionIntent(input.ctx, input.primeSearch.searchResult, projectRuntime);
  const primePackage = buildPrimePublicPackage({
    detailRefs: input.detailRefs,
    intake: input.intake,
    primeKnowledgeMaterial: material.primeKnowledgeMaterial,
    primeRef: input.primeRef,
    result,
    searchDegraded: effectiveSearchDegraded,
    searchResult: input.primeSearch.searchResult,
  });
  // GMAP-8: prime returns its own prime-native output (primePackage + bounded
  // detailRefs/diagnostics), assembled from the resident search material — never
  // the KnowledgeContext middle layer, ProjectMatrix, or graph provider.
  return createAgentPublicToolOutput(result, {
    primePackage,
    detailRefs: [...input.detailRefs, ...primeMaterialDetailRefs(material.primeKnowledgeMaterial)],
    diagnostics: buildPrimeReadyDiagnostics(input.primeSearch, effectiveSearchDegraded),
    nextActions: [],
  });
}

// Surface the accepted Recipe/Guard material as agent-facing detail refs so callers
// get direct pointers to primed knowledge without a follow-up tool call.
function primeMaterialDetailRefs(material: PrimeKnowledgeMaterial | null): AgentDetailRef[] {
  if (!material) {
    return [];
  }
  const refs: AgentDetailRef[] = [];
  for (const item of material.acceptedKnowledge) {
    refs.push({
      id: `prime-knowledge:${item.id}`,
      kind: 'source-ref',
      summary: item.summary || item.title || item.id,
      ...(item.evidenceRefs[0] ? { uri: evidenceRefToUri(item.evidenceRefs[0]) } : {}),
      requiredForCompletion: false,
    });
  }
  for (const item of material.acceptedGuards) {
    refs.push({
      id: `prime-guard:${item.id}`,
      kind: 'source-ref',
      summary: item.actionHint || item.title || item.id,
      ...(item.evidenceRefs[0] ? { uri: evidenceRefToUri(item.evidenceRefs[0]) } : {}),
      requiredForCompletion: false,
    });
  }
  return refs;
}

function buildPrimeReadyDiagnostics(
  primeSearch: PrimeHandlerReadyInput['primeSearch'],
  searchDegraded: boolean
): Array<{ code: string; severity: 'info' | 'warning'; message: string; retryable: boolean }> {
  const diagnostics: Array<{
    code: string;
    severity: 'info' | 'warning';
    message: string;
    retryable: boolean;
  }> = [];
  if (searchDegraded) {
    diagnostics.push({
      code: 'prime-search-degraded',
      severity: 'warning',
      message: 'Recipe retrieval was degraded; prime results may be incomplete.',
      retryable: true,
    });
  }
  if (!primeSearch.searchResult?.searchMeta.residentSearch?.residentVector?.available) {
    diagnostics.push({
      code: 'prime-vector-evidence-unavailable',
      severity: 'info',
      message: 'Resident vector/rerank evidence was unavailable or unused.',
      retryable: false,
    });
  }
  return diagnostics;
}

function evidenceRefToUri(
  ref: PrimeKnowledgeMaterial['acceptedKnowledge'][number]['evidenceRefs'][number]
) {
  return ref.line === null ? ref.path : `${ref.path}:${ref.line}`;
}

function _resolveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function _readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildPrimeMaterialProjection(
  intake: ReturnType<typeof buildAgentToolContext>,
  primeSearch: Awaited<ReturnType<typeof runPrimeSearch>>,
  frame: StandalonePrimeRequirementFrame,
  args: AgentPrimeArgs
): PrimeMaterialProjection {
  return {
    primeKnowledgeMaterial: buildPrimeKnowledgeMaterial({
      requirement: {
        userQuery: firstString(args.userQuery, frame.searchQuery) ?? '',
        ...(args.activeFile ? { activeFile: args.activeFile } : {}),
        ...(frame.scenario ? { scenario: frame.scenario } : {}),
        queries: frame.searchQuery ? [frame.searchQuery] : [],
        language: args.language ?? null,
        ...(frame.taskAction ? { taskAction: frame.taskAction } : {}),
        ...(frame.requirementGoal ? { requirementGoal: frame.requirementGoal } : {}),
        keywords: frame.keywords,
        labels: frame.labels,
      },
      intentEpisode: createUnavailablePrimeIntentEpisodeMaterial(
        'agent-public-prime keeps IntentEpisode handoff out of Stage 3 active surface'
      ),
      searchDegraded: primeSearch.searchDegraded,
      searchResult: primeSearch.searchResult,
      sourceRefs: intake.sourceRefs,
      taskAnchorDecision: intake.lifecycle.taskAnchorDecision,
    }),
    retrievalConsumer: primeSearch.searchResult?.searchMeta.retrievalConsumer ?? null,
  };
}

function buildPrimeReadyResult(
  input: PrimeHandlerReadyInput,
  status: Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string }
) {
  return createAgentPublicToolResultEnvelope({
    actionKind: 'prime',
    agentHost: input.intake.agentHost,
    inputSource: input.intake.inputSource,
    intentKind: input.intake.intentKind,
    refs: buildPrimeRefs(input),
    ...(status.reason ? { reason: status.reason } : {}),
    status: status.status,
    summary: buildResultSummary(status.summary),
    toolName: 'alembic_prime',
  });
}

export async function workStartHandler(ctx: McpContext, args: AgentWorkStartArgs) {
  const intake = buildAgentToolContext(args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_work',
    uniqueStrings([
      ...(args.sourceRefs ?? []),
      ...(args.sourceEvidenceRefs ?? []),
      ...(args.workScope?.files ?? []),
    ])
  );
  const status = resolveWorkStartStatus(intake, args);
  if (status.status !== 'ready') {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'work',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: status.reason,
      refs: {
        detailRefs,
      },
      status: status.status,
      summary: buildResultSummary(status.summary),
      toolName: 'alembic_work',
    });
    return createAgentPublicToolOutput(result);
  }

  const workRef = nextWorkRef();
  const title =
    firstString(args.title, args.workScope?.goal, args.userQuery, args.hostDeclaredIntent?.query) ??
    workRef;
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
    inputSource: intake.inputSource,
    ...(args.primeRef ? { primeRef: args.primeRef } : {}),
    sourceEvidenceRefs: uniqueStrings(args.sourceEvidenceRefs ?? []),
    scopeFiles,
    sourceRefs: intake.sourceRefs,
    title,
    workRef,
  };
  rememberWorkRecord(record);
  bindWorkSession(ctx, record);

  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'work',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
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
      workRef: { refType: 'work', id: workRef, toolName: 'alembic_work' },
    },
    status: 'ready',
    summary: buildResultSummary(`Work started for "${title}".`),
    toolName: 'alembic_work',
  });

  return createAgentPublicToolOutput(result, {
    detailRefs,
    localRecord: {
      createdAt: record.createdAt,
      scopeFiles,
      title,
      workRef,
    },
    workRef,
  });
}

export async function workFinishHandler(ctx: McpContext, args: AgentWorkFinishArgs) {
  const intake = buildAgentToolContext(args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_work',
    uniqueStrings([
      ...(args.sourceRefs ?? []),
      ...(args.sourceEvidenceRefs ?? []),
      ...(args.evidenceRefs ?? []),
    ])
  );
  const record = typeof args.workRef === 'string' ? WORK_RECORDS.get(args.workRef) : undefined;
  if (!args.workRef || !record) {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'work',
      agentHost: intake.agentHost,
      inputSource: intake.inputSource,
      intentKind: intake.intentKind,
      reason: {
        kind: 'blocked',
        code: 'missing-work-ref',
        message: args.workRef
          ? `No active work record exists for workRef ${args.workRef}.`
          : 'alembic_work phase=finish requires a workRef returned by alembic_work phase=start.',
        retryable: false,
      },
      refs: {
        detailRefs,
      },
      status: 'blocked',
      summary: buildResultSummary('Work finish blocked because workRef is missing.'),
      toolName: 'alembic_work',
    });
    return createAgentPublicToolOutput(result);
  }

  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  const changedFiles = normalizeTaskLifecycleFileRefs(args.changedFiles ?? [], {
    projectRoot: effectiveProjectRoot,
  });
  record.scopeFiles = uniqueStrings([...record.scopeFiles, ...changedFiles]);
  const guardDecision = decideGuardTrigger({
    changedFiles,
    taskAnchorExists: true,
    taskScopeFiles: record.scopeFiles,
  });
  const finishRef = nextFinishRef();
  const finishedAt = new Date().toISOString();
  record.finishRef = finishRef;
  record.finishedAt = finishedAt;
  record.sourceEvidenceRefs = uniqueStrings([
    ...record.sourceEvidenceRefs,
    ...(args.sourceEvidenceRefs ?? []),
  ]);
  const outcome = args.outcome ?? 'completed';
  const summary =
    firstString(args.summary, args.reason) ??
    (outcome === 'completed'
      ? `Work ${record.workRef} completed.`
      : `Work ${record.workRef} ${outcome}.`);

  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'work',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
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
      finishRef: { refType: 'finish', id: finishRef, toolName: 'alembic_work' },
      workRef: { refType: 'work', id: record.workRef, toolName: 'alembic_work' },
    },
    status: 'ready',
    summary: buildResultSummary(summary),
    toolName: 'alembic_work',
  });

  return createAgentPublicToolOutput(result, {
    changedFiles,
    detailRefs,
    evidenceRefs: args.evidenceRefs ?? [],
    finishRef,
    guardRecommendation: buildGuardRecommendation(guardDecision, {
      sourceEvidenceRefs: record.sourceEvidenceRefs,
      validationPlan: args.validationPlan,
    }),
    localRecord: {
      finishedAt,
      outcome,
      workRef: record.workRef,
    },
    outcome,
    ...(record.sourceEvidenceRefs.length ? { sourceEvidenceRefs: record.sourceEvidenceRefs } : {}),
    workRef: record.workRef,
  });
}

export async function codeGuardHandler(ctx: McpContext, args: AgentCodeGuardArgs) {
  const intake = buildAgentToolContext(args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_code_guard',
    uniqueStrings([...(args.sourceRefs ?? []), ...(args.sourceEvidenceRefs ?? [])])
  );
  const scope = resolveCodeGuardScope(ctx, args);
  const preflight = buildCodeGuardPreflightOutput({ args, detailRefs, intake, scope });
  if (preflight) {
    return preflight;
  }

  try {
    const guardEnvelope = await executeScopedCodeGuard(ctx, args, scope);
    return buildCodeGuardReadyOutput({ args, detailRefs, guardEnvelope, intake, scope });
  } catch (err: unknown) {
    return buildCodeGuardFailureOutput({ args, detailRefs, err, intake });
  }
}

function resolveCodeGuardScope(
  ctx: McpContext,
  args: AgentCodeGuardArgs
): CodeGuardScopeResolution {
  const hasCode = typeof args.code === 'string' && args.code.trim().length > 0;
  const effectiveProjectRoot = resolveEffectiveProjectRoot(ctx, args);
  const explicitFiles = normalizeTaskLifecycleFileRefs(args.files ?? [], {
    projectRoot: effectiveProjectRoot,
  });
  const workRecord = typeof args.workRef === 'string' ? WORK_RECORDS.get(args.workRef) : undefined;
  const workRefFiles =
    !hasCode && explicitFiles.length === 0 && workRecord
      ? normalizeTaskLifecycleFileRefs(workRecord.scopeFiles, { projectRoot: effectiveProjectRoot })
      : [];
  return {
    explicitFiles,
    files: explicitFiles.length > 0 ? explicitFiles : workRefFiles,
    hasCode,
    unsupportedScopeFields: collectUnsupportedCodeGuardScopeFields(args),
    workRecord,
    workRefFiles,
  };
}

function buildCodeGuardPreflightOutput(input: {
  args: AgentCodeGuardArgs;
  detailRefs: AgentDetailRef[];
  intake: ReturnType<typeof buildAgentToolContext>;
  scope: CodeGuardScopeResolution;
}) {
  const { args, scope } = input;
  if (!scope.hasCode && scope.explicitFiles.length === 0 && args.workRef && !scope.workRecord) {
    return buildMissingWorkRefGuardOutput(input);
  }
  if (
    !scope.hasCode &&
    scope.explicitFiles.length === 0 &&
    scope.workRecord &&
    scope.files.length === 0
  ) {
    return buildEmptyWorkRefGuardOutput(input, scope.workRecord);
  }
  if (!scope.hasCode && scope.files.length === 0) {
    return buildMissingScopeGuardOutput(input);
  }
  return null;
}

function buildMissingWorkRefGuardOutput(input: {
  args: AgentCodeGuardArgs;
  detailRefs: AgentDetailRef[];
  intake: ReturnType<typeof buildAgentToolContext>;
  scope: CodeGuardScopeResolution;
}) {
  const { args, detailRefs, intake, scope } = input;
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'code-guard',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    reason: {
      kind: 'blocked',
      code: 'missing-work-ref',
      message: `No active work record exists for workRef ${args.workRef}; provide explicit files/code or start scoped work first.`,
      retryable: false,
    },
    refs: { detailRefs },
    status: 'blocked',
    summary: buildResultSummary(
      'Code Guard blocked because the requested workRef is not active in this Plugin session.'
    ),
    toolName: 'alembic_code_guard',
  });
  return createAgentPublicToolOutput(result, {
    unsupportedScopeFields: scope.unsupportedScopeFields,
  });
}

function buildEmptyWorkRefGuardOutput(
  input: {
    args: AgentCodeGuardArgs;
    detailRefs: AgentDetailRef[];
    intake: ReturnType<typeof buildAgentToolContext>;
    scope: CodeGuardScopeResolution;
  },
  workRecord: WorkRecord
) {
  const { detailRefs, intake, scope } = input;
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'code-guard',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    reason: {
      kind: 'skip',
      code: 'no-code-scope',
      message:
        'The referenced workRef is active but has no scoped source files; provide files or inline code to run Guard.',
      retryable: false,
    },
    refs: {
      workRef: {
        refType: 'work' as const,
        id: workRecord.workRef,
        toolName: 'alembic_work' as const,
      },
      detailRefs,
    },
    status: 'skipped',
    summary: buildResultSummary(
      'Code Guard skipped because the workRef has no scoped source files.'
    ),
    toolName: 'alembic_code_guard',
  });
  return createAgentPublicToolOutput(result, {
    explicitScope: { files: [], kind: 'workRef', workRef: workRecord.workRef },
    unsupportedScopeFields: scope.unsupportedScopeFields,
  });
}

function buildMissingScopeGuardOutput(input: {
  args: AgentCodeGuardArgs;
  detailRefs: AgentDetailRef[];
  intake: ReturnType<typeof buildAgentToolContext>;
  scope: CodeGuardScopeResolution;
}) {
  const { args, detailRefs, intake, scope } = input;
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'code-guard',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    reason: {
      kind: 'blocked',
      code: 'missing-guard-scope',
      message: buildMissingGuardScopeMessage(scope.unsupportedScopeFields),
      retryable: false,
    },
    refs: {
      ...buildWorkRefEntry(args.workRef),
      detailRefs,
    },
    status: 'blocked',
    summary: buildResultSummary('Code Guard blocked because no explicit scope was provided.'),
    toolName: 'alembic_code_guard',
  });
  return createAgentPublicToolOutput(result, {
    unsupportedScopeFields: scope.unsupportedScopeFields,
  });
}

async function executeScopedCodeGuard(
  ctx: McpContext,
  args: AgentCodeGuardArgs,
  scope: CodeGuardScopeResolution
) {
  if (scope.hasCode) {
    return guardHandlers.guardCheck(ctx, {
      code: args.code,
      filePath: args.filePath,
      language: args.language,
    });
  }
  return guardHandlers.guardReview(ctx, { files: scope.files });
}

function buildCodeGuardReadyOutput(input: {
  args: AgentCodeGuardArgs;
  detailRefs: AgentDetailRef[];
  guardEnvelope: unknown;
  intake: ReturnType<typeof buildAgentToolContext>;
  scope: CodeGuardScopeResolution;
}) {
  const { args, detailRefs, guardEnvelope, intake, scope } = input;
  const guardResultRef = nextGuardResultRef();
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'code-guard',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
      ...buildWorkRefEntry(args.workRef),
      detailRefs,
      guardResultRef: {
        refType: 'guard-result',
        id: guardResultRef,
        toolName: 'alembic_code_guard',
      },
    },
    status: 'ready',
    summary: buildResultSummary(
      scope.hasCode
        ? 'Code Guard checked explicit inline code.'
        : `Code Guard checked ${scope.files.length} explicit file(s).`
    ),
    toolName: 'alembic_code_guard',
  });
  return createAgentPublicToolOutput(result, {
    detailRefs,
    explicitScope: buildCodeGuardExplicitScope(args, scope),
    guard: projectGuardBusinessPayload(guardEnvelope),
    guardResultRef,
    unsupportedScopeFields: scope.unsupportedScopeFields,
  });
}

function buildCodeGuardFailureOutput(input: {
  args: AgentCodeGuardArgs;
  detailRefs: AgentDetailRef[];
  err: unknown;
  intake: ReturnType<typeof buildAgentToolContext>;
}) {
  const { detailRefs, err, intake } = input;
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
    summary: buildResultSummary('Scoped Code Guard failed before producing results.'),
    toolName: 'alembic_code_guard',
  });
  return createAgentPublicToolOutput(result);
}

function buildCodeGuardExplicitScope(args: AgentCodeGuardArgs, scope: CodeGuardScopeResolution) {
  if (scope.hasCode) {
    return { kind: 'code', filePath: args.filePath ?? null };
  }
  return {
    files: scope.files,
    kind: scope.explicitFiles.length > 0 ? 'files' : 'workRef',
    ...(scope.explicitFiles.length === 0 && scope.workRecord
      ? { workRef: scope.workRecord.workRef }
      : {}),
  };
}

/**
 * Build the slim agent-tool context (PDR-1d). The intent-paradigm intake
 * (the legacy intent-frame extraction / vector-plan layer) is removed; tools now derive
 * agentHost/inputSource/sourceRefs from their structured args and reuse the Core
 * lifecycle classifier directly.
 */
function buildAgentToolContext(args: AgentPublicBaseArgs) {
  const rawUserQuery = firstString(args.userQuery);
  const lifecycle = classifyTaskLifecycleInput({
    operation: 'prime',
    rawUserQuery,
    userQuery: rawUserQuery,
  });
  const sourceRefs = uniqueStrings([
    ...(args.sourceRefs ?? []),
    ...(args.sourceEvidenceRefs ?? []),
    ...(args.hostDeclaredIntent?.sourceRefs ?? []),
  ]);
  return {
    agentHost: args.agentHost ?? ('codex' as const),
    inputSource: resolveAgentInputSource(args.inputSource, lifecycle.inputSource),
    intentKind: args.intentKind,
    lifecycle,
    sourceRefs,
  };
}

function buildPrimeToolContext(args: AgentPrimeArgs): ReturnType<typeof buildAgentToolContext> {
  const frame = buildStandalonePrimeRequirementFrame(args);
  const rawUserQuery = firstString(args.userQuery);
  const lifecycle = classifyTaskLifecycleInput({
    operation: 'prime',
    rawUserQuery,
    userQuery: frame.searchQuery ?? rawUserQuery,
  });
  const sourceRefs = uniqueStrings([
    ...(args.sourceRefs ?? []),
    ...(args.sourceEvidenceRefs ?? []),
  ]);
  return {
    agentHost: args.agentHost ?? ('codex' as const),
    inputSource: resolveAgentInputSource(args.inputSource, lifecycle.inputSource),
    intentKind: args.intentKind,
    lifecycle,
    sourceRefs,
  };
}

function buildStandalonePrimeRequirementFrame(
  args: AgentPrimeArgs
): StandalonePrimeRequirementFrame {
  const taskAction = normalizePrimeTaskAction(args.taskAction);
  const requirementGoal = firstString(args.requirementGoal);
  const scenario = firstString(args.scenario);
  const capability = firstString(args.capability);
  const domainObjects = stringList(args.domainObjects);
  const integrationBoundary = firstString(args.integrationBoundary);
  const lifecycleHint = firstString(args.lifecycleHint);
  const qualityConcerns = stringList(args.qualityConcerns);
  const labels = stringList(args.labels);
  const keywords = stringList(args.keywords);
  const locatorFacets = uniqueStrings([
    ...(scenario ? [scenario] : []),
    ...(capability ? [capability] : []),
    ...domainObjects,
    ...(integrationBoundary ? [integrationBoundary] : []),
    ...qualityConcerns,
  ]);
  const queryParts = uniqueStrings([
    ...(requirementGoal ? [requirementGoal] : []),
    ...(taskAction ? [taskAction] : []),
    ...locatorFacets,
    ...(lifecycleHint ? [lifecycleHint] : []),
    ...keywords,
    ...labels,
  ]);
  return {
    ...(capability ? { capability } : {}),
    domainObjects,
    ...(integrationBoundary ? { integrationBoundary } : {}),
    keywords,
    labels,
    ...(lifecycleHint ? { lifecycleHint } : {}),
    locatorFacets,
    qualityConcerns,
    ...(requirementGoal ? { requirementGoal } : {}),
    ...(scenario ? { scenario } : {}),
    ...(queryParts.length > 0 ? { searchQuery: queryParts.join(' ') } : {}),
    ...(taskAction ? { taskAction } : {}),
  };
}

function hasAnyStandalonePrimeSignal(frame: StandalonePrimeRequirementFrame): boolean {
  return Boolean(
    frame.taskAction ||
      frame.requirementGoal ||
      frame.locatorFacets.length > 0 ||
      frame.lifecycleHint ||
      frame.keywords.length > 0 ||
      frame.labels.length > 0
  );
}

function hasRequiredStandalonePrimeFrame(frame: StandalonePrimeRequirementFrame): boolean {
  return Boolean(frame.taskAction && frame.requirementGoal && frame.locatorFacets.length > 0);
}

function normalizePrimeTaskAction(value: unknown): string | undefined {
  const action = firstString(value)
    ?.toLowerCase()
    .replace(/[_\s]+/g, '-');
  switch (action) {
    case 'implement':
    case 'implementation':
    case 'build':
    case 'add':
      return 'implement';
    case 'fix':
    case 'repair':
      return 'fix';
    case 'refactor':
      return 'refactor';
    case 'test':
    case 'test-writing':
    case 'write-tests':
    case 'add-tests':
      return 'test-writing';
    case 'test-repair':
    case 'fix-tests':
    case 'repair-tests':
      return 'test-repair';
    case 'code-edit':
    case 'edit-code':
    case 'remove':
    case 'delete':
      return 'code-edit';
    case 'code-review':
    case 'review':
      return 'code-review';
    default:
      return undefined;
  }
}

function resolvePrimeBlockingReason(
  args: AgentPrimeArgs,
  intake: ReturnType<typeof buildAgentToolContext>
): {
  code: 'missing-required-intent' | 'missing-referenced-docs' | 'obsolete-prime-intent-input';
  message: string;
} | null {
  const obsoleteFields = obsoletePrimeInputFields(args);
  if (obsoleteFields.length > 0) {
    return {
      code: 'obsolete-prime-intent-input',
      message: `alembic_prime no longer accepts ${obsoleteFields.join(', ')} as prime input; call it with taskAction, requirementGoal, and at least one locator facet.`,
    };
  }

  const frame = buildStandalonePrimeRequirementFrame(args);
  if (
    intake.lifecycle.primeDecision.action === 'skip' &&
    !isTrustedStandaloneCodePrimeFrame(frame)
  ) {
    return null;
  }

  if (!hasRequiredStandalonePrimeFrame(frame)) {
    return {
      code: 'missing-required-intent',
      message:
        'alembic_prime requires standalone code-development input: taskAction, requirementGoal, and at least one locator facet (capability, scenario, domainObjects, integrationBoundary, or qualityConcerns).',
    };
  }

  if (intake.inputSource === 'automation-envelope' && intake.sourceRefs.length === 0) {
    return {
      code: 'missing-referenced-docs',
      message:
        'Automation-envelope prime requires a curated direct code-development frame plus explicit sourceRefs so the host can verify referenced dispatch/plan evidence.',
    };
  }
  return null;
}

function obsoletePrimeInputFields(args: AgentPrimeArgs): string[] {
  const fields: string[] = [];
  if (firstString(args.intentRef)) {
    fields.push('intentRef');
  }
  if (args.recognizedIntent && typeof args.recognizedIntent === 'object') {
    fields.push('recognizedIntent');
  }
  if (firstString(args.query)) {
    fields.push('query');
  }
  if (
    args.hostDeclaredIntent &&
    !hasAnyStandalonePrimeSignal(buildStandalonePrimeRequirementFrame(args))
  ) {
    fields.push('hostDeclaredIntent');
  }
  return fields;
}

async function runPrimeSearch(
  ctx: McpContext,
  args: AgentPrimeArgs,
  intake: ReturnType<typeof buildAgentToolContext>
): Promise<{
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  skippedReason: AgentPrimeSkippedReason | null;
}> {
  const skippedReason = resolvePrimeSkipBeforeRetrieval(args, intake);
  if (skippedReason) {
    return {
      searchDegraded: false,
      searchResult: null,
      skippedReason,
    };
  }
  const pipeline = getPipeline(ctx.container);
  if (!pipeline) {
    return { searchDegraded: true, searchResult: null, skippedReason: null };
  }
  try {
    // PDR-1d: prime retrieval = structured query → unified vector search (route-agnostic,
    // same engine as alembic_search). Local Recipe semantic-region evidence is wired in PDR-2.
    const frame = buildStandalonePrimeRequirementFrame(args);
    const searchResult = await pipeline.search({
      query: frame.searchQuery ?? '',
      ...(frame.searchQuery ? { queries: [frame.searchQuery] } : {}),
      ...(frame.scenario ? { scenario: frame.scenario } : {}),
      language: args.language ?? null,
    });
    return { searchDegraded: false, searchResult, skippedReason: null };
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/AgentPublicTools] alembic_prime search degraded: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { searchDegraded: true, searchResult: null, skippedReason: null };
  }
}

function resolvePrimeSkipBeforeRetrieval(
  args: AgentPrimeArgs,
  intake: ReturnType<typeof buildAgentToolContext>
): AgentPrimeSkippedReason | null {
  const frame = buildStandalonePrimeRequirementFrame(args);
  const trustedStandaloneFrame = isTrustedStandaloneCodePrimeFrame(frame);
  if (args.intentKind && isExplicitNonCodePrimeIntentKind(args.intentKind)) {
    return args.intentKind === 'status-only'
      ? 'status-only-turn'
      : 'not-relevant-to-project-knowledge';
  }
  if (isStandalonePrimeMechanicalEnvelopeFrame(frame)) {
    return 'mechanical-envelope-only';
  }
  if (isLowInformationStandalonePrimeFrame(frame)) {
    return 'not-relevant-to-project-knowledge';
  }
  if (intake.lifecycle.primeDecision.action === 'skip' && !trustedStandaloneFrame) {
    return mapPrimeSkipReason(intake.lifecycle.primeDecision.reasonCode);
  }
  if (hasRequiredStandalonePrimeFrame(frame) && isStandalonePrimeNonCodeFrame(frame)) {
    return 'not-relevant-to-project-knowledge';
  }
  return null;
}

function isTrustedStandaloneCodePrimeFrame(frame: StandalonePrimeRequirementFrame): boolean {
  return hasRequiredStandalonePrimeFrame(frame) && !isStandalonePrimeNonCodeFrame(frame);
}

function isExplicitNonCodePrimeIntentKind(intentKind: AgentIntentKind): boolean {
  return (
    intentKind === 'read-only-analysis' ||
    intentKind === 'status-only' ||
    intentKind === 'design-or-planning' ||
    intentKind === 'mechanical-envelope' ||
    intentKind === 'unknown'
  );
}

function isStandalonePrimeNonCodeFrame(frame: StandalonePrimeRequirementFrame): boolean {
  const frameText = standalonePrimeSemanticText(frame);
  if (!frameText) {
    return false;
  }
  if (
    /\b(without|no)\s+code\s+changes?\b|\bread[-\s]?only\s+(plan|planning|discussion)\b/i.test(
      frameText
    )
  ) {
    return true;
  }
  const hasCodeWorkMarker =
    /\b(implement|fix|repair|refactor|test|tests|code|handler|schema|runtime|api|mcp|plugin|route|service|pipeline|contract|projection|validation|regression|bug)\b|实现|修复|重构|测试|代码|接口|处理器|模式|运行时/u.test(
      frameText
    );
  if (hasCodeWorkMarker) {
    return false;
  }
  return (
    /\b(where|which)\b.{0,80}\b(file|module|class|handler|route|located|location|live|entrypoint)\b/i.test(
      frameText
    ) ||
    /\b(project\s+navigation|module\s+location|file\s+location|where\s+to\s+find)\b/i.test(
      frameText
    ) ||
    /在哪里|在哪个文件|位置|入口在哪/u.test(frameText) ||
    /^(what\s+is|explain|tell\s+me\s+about|overview\s+of)\b/i.test(frameText) ||
    /\b(general\s+knowledge|background\s+knowledge|concept\s+overview)\b/i.test(frameText) ||
    /是什么|解释一下|介绍一下/u.test(frameText) ||
    /\b(design|planning|plan|proposal|options?|tradeoffs?|roadmap)\b.{0,80}\b(discussion|options?|proposal|plan|tradeoffs?)\b/i.test(
      frameText
    )
  );
}

function isStandalonePrimeMechanicalEnvelopeFrame(frame: StandalonePrimeRequirementFrame): boolean {
  const frameText = standalonePrimeSemanticText(frame);
  return /<\s*codex_delegation\b|<\s*input\b|<\/\s*codex_delegation\s*>|currentWindow\s*:|taskId\s*:|stateRoot\s*:|dispatchGroup\s*:/iu.test(
    frameText
  );
}

function isLowInformationStandalonePrimeFrame(frame: StandalonePrimeRequirementFrame): boolean {
  const frameText = standalonePrimeSemanticText(frame);
  if (!frameText) {
    return true;
  }
  if (
    /^(help|what\s+now|next\s+steps?|where\s+do\s+i\s+start|how\s+do\s+i\s+start|continue|继续|帮我|下一步|从哪里开始|哪里开始|怎么开始)[?？。!！\s]*$/iu.test(
      frameText
    )
  ) {
    return true;
  }
  const tokens =
    frameText
      .toLowerCase()
      .match(/[a-z0-9_]+|[\p{Script=Han}]+/gu)
      ?.filter((token) => {
        if (LOW_INFORMATION_STANDALONE_PRIME_TOKENS.has(token)) {
          return false;
        }
        return token.length > 1 || /[\p{Script=Han}]/u.test(token);
      }) ?? [];
  const hasConcreteCodeLocator =
    /\b(api|route|handler|schema|zod|runtime|mcp|plugin|service|pipeline|contract|projection|validation|regression|test|tests|file|module|class|function|method)\b|接口|路由|处理器|模式|运行时|服务|管线|契约|投影|验证|测试|文件|模块|函数/u.test(
      frameText
    );
  return tokens.length < 3 && !hasConcreteCodeLocator;
}

function standalonePrimeSemanticText(frame: StandalonePrimeRequirementFrame): string {
  return [
    frame.requirementGoal,
    frame.scenario,
    frame.capability,
    ...frame.domainObjects,
    frame.integrationBoundary,
    frame.lifecycleHint,
    ...frame.qualityConcerns,
    ...frame.keywords,
    ...frame.labels,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOW_INFORMATION_STANDALONE_PRIME_TOKENS = new Set([
  'begin',
  'continue',
  'do',
  'help',
  'how',
  'me',
  'next',
  'now',
  'please',
  'start',
  'steps',
  'what',
  'where',
  '帮我',
  '从哪里开始',
  '继续',
  '哪里开始',
  '下一步',
  '怎么开始',
]);

function resolvePrimeStatus(input: {
  primeKnowledgeMaterial: Pick<
    PrimeKnowledgeMaterial,
    'acceptedGuards' | 'acceptedKnowledge' | 'degradedReason' | 'status'
  >;
  retrievalConsumer: PrimeSearchResult['searchMeta']['retrievalConsumer'] | null;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  skippedReason: AgentPrimeSkippedReason | null;
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
  if (input.primeKnowledgeMaterial.status === 'degraded') {
    const reason = input.primeKnowledgeMaterial.degradedReason;
    return {
      reason: {
        kind: 'degraded',
        code: 'knowledge-empty',
        message:
          reason?.message ??
          'Prime withheld retrieved Recipe or Guard candidates before marking them trusted.',
        retryable: true,
      },
      status: 'degraded',
      summary:
        reason?.code === 'low-information-intent'
          ? 'Prime withheld retrieved knowledge because the request lacked concrete anchors.'
          : 'Prime degraded before delivering trusted Recipe or Guard knowledge.',
    };
  }
  const acceptedKnowledgeCount = input.primeKnowledgeMaterial.acceptedKnowledge.length;
  const acceptedGuardCount = input.primeKnowledgeMaterial.acceptedGuards.length;
  if (acceptedKnowledgeCount > 0 || acceptedGuardCount > 0) {
    return {
      status: 'ready',
      summary: `Prime delivered ${acceptedKnowledgeCount} accepted Recipe/pattern item(s) and ${acceptedGuardCount} accepted Guard/rule item(s).`,
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
  intake: ReturnType<typeof buildAgentToolContext>,
  args: AgentWorkStartArgs
): Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string } {
  if (intake.inputSource === 'automation-envelope' && intake.sourceRefs.length === 0) {
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
  const hasExplicitWorkScope = Boolean(
    firstString(args.title, args.workScope?.goal, args.workScope?.summary) ||
      (args.workScope?.files?.length ?? 0) > 0 ||
      Boolean(args.activeFile)
  );
  const hasPolicyWorkScope = Boolean(
    intake.lifecycle.taskAnchorDecision.action === 'create' &&
      (firstString(args.userQuery, args.hostDeclaredIntent?.query)?.trim().length ?? 0) > 0
  );
  const hasWorkScope = hasExplicitWorkScope || hasPolicyWorkScope;
  if (!hasWorkScope) {
    return {
      reason: {
        kind: 'skip',
        code: 'no-work-scope',
        message: 'No concrete work scope was available for alembic_work phase=start.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Work start skipped because no concrete scope was available.',
    };
  }
  return {
    status: 'ready',
    summary: 'Work start can create a Plugin-owned workRef.',
  };
}

function buildGuardRecommendation(
  decision: ReturnType<typeof decideGuardTrigger>,
  evidence?: {
    sourceEvidenceRefs?: string[];
    validationPlan?: Record<string, unknown>;
  }
) {
  const validationPlan = projectValidationPlanAdvisory(evidence?.validationPlan);
  const guardEvidence = compactRecord({
    ...(evidence?.sourceEvidenceRefs?.length
      ? { sourceEvidenceRefs: uniqueStrings(evidence.sourceEvidenceRefs).slice(0, 40) }
      : {}),
    ...(validationPlan ? { validationPlan } : {}),
  });
  if (decision.action === 'run') {
    return {
      action: 'run',
      input: { files: decision.taskScopedFiles },
      reasonCode: decision.reasonCode,
      ...guardEvidence,
      taskScopedFiles: decision.taskScopedFiles,
      tool: 'alembic_code_guard',
    };
  }
  return {
    action: 'skip',
    reason: `Guard skipped by Codex-aware lifecycle policy: ${decision.reasonCode}.`,
    reasonCode: decision.reasonCode,
    ...guardEvidence,
    taskScopedFiles: decision.taskScopedFiles,
    tool: 'alembic_code_guard',
  };
}

function projectValidationPlanAdvisory(value: unknown):
  | {
      acceptanceBoundary?: string;
      advisoryOnly: true;
      buckets: Record<'manualReview' | 'mustRun' | 'recommended' | 'unknown', ValidationBucket>;
    }
  | undefined {
  const source = asValidationPlanSource(value);
  if (!source) {
    return undefined;
  }
  const buckets = {
    manualReview: projectValidationBucket(source.manualReview),
    mustRun: projectValidationBucket(source.mustRun),
    recommended: projectValidationBucket(source.recommended),
    unknown: projectValidationBucket(source.unknown),
  };
  return {
    ...(firstString(source.acceptanceBoundary)
      ? { acceptanceBoundary: firstString(source.acceptanceBoundary) }
      : {}),
    advisoryOnly: true,
    buckets,
  };
}

interface ValidationBucket {
  commands: string[];
  count: number;
  diagnosticCodes: string[];
  files: string[];
}

function projectValidationBucket(value: unknown): ValidationBucket {
  const recommendations = Array.isArray(value) ? value.filter(isRecord) : [];
  return {
    commands: uniqueStrings(recommendations.flatMap((item) => validationCommandRefs(item))).slice(
      0,
      20
    ),
    count: Math.min(recommendations.length, 1000),
    diagnosticCodes: uniqueStrings(
      recommendations.flatMap((item) => validationDiagnosticRefs(item))
    ).slice(0, 20),
    files: uniqueStrings(recommendations.flatMap((item) => validationFileRefs(item))).slice(0, 40),
  };
}

function asValidationPlanSource(value: unknown): Record<string, unknown> | null {
  const record = isRecord(value) ? value : {};
  if (isRecord(record.validationPlan)) {
    return record.validationPlan;
  }
  if (
    Array.isArray(record.mustRun) ||
    Array.isArray(record.recommended) ||
    Array.isArray(record.manualReview) ||
    Array.isArray(record.unknown)
  ) {
    return record;
  }
  return null;
}

function validationCommandRefs(item: Record<string, unknown>): string[] {
  return [firstString(item.command)].filter((entry): entry is string => Boolean(entry));
}

function validationDiagnosticRefs(item: Record<string, unknown>): string[] {
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter(isRecord) : [];
  return [
    firstString(item.diagnosticCode),
    ...evidence.map((entry) => firstString(entry.diagnosticCode)),
  ].filter((entry): entry is string => Boolean(entry));
}

function validationFileRefs(item: Record<string, unknown>): string[] {
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter(isRecord) : [];
  return [
    firstString(item.filePath),
    ...evidence.map((entry) => firstString(entry.filePath)),
  ].filter((entry): entry is string => Boolean(entry));
}

function projectGuardBusinessPayload(guardEnvelope: unknown) {
  if (!guardEnvelope || typeof guardEnvelope !== 'object') {
    return { guardResult: guardEnvelope };
  }
  const record = guardEnvelope as {
    data?: unknown;
    errorCode?: unknown;
    message?: unknown;
    success?: unknown;
  };
  return {
    ok: record.success !== false,
    ...(typeof record.errorCode === 'string' && record.errorCode
      ? { guardErrorCode: record.errorCode }
      : {}),
    ...(typeof record.message === 'string' && record.message ? { summary: record.message } : {}),
    guardResult: record.data ?? guardEnvelope,
  };
}

const UNSUPPORTED_CODE_GUARD_SCOPE_FIELDS = [
  'diffRef',
  'primeRef',
  'acceptedGuards',
  'applicableRecipe',
] as const;

function collectUnsupportedCodeGuardScopeFields(args: AgentCodeGuardArgs): string[] {
  return UNSUPPORTED_CODE_GUARD_SCOPE_FIELDS.filter((field) => {
    const value = args[field];
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== undefined && value !== null && value !== '';
  });
}

function buildMissingGuardScopeMessage(unsupportedScopeFields: string[]): string {
  const base =
    'alembic_code_guard requires explicit files, inline code, or an active workRef with scoped files; it will not fall back to no-args whole-diff review.';
  if (unsupportedScopeFields.length === 0) {
    return base;
  }
  return `${base} Unsupported scope fields were ignored by the public contract: ${unsupportedScopeFields.join(', ')}.`;
}

function buildWorkRefEntry(workRef: unknown) {
  const id = firstString(workRef);
  if (!id) {
    return {};
  }
  return {
    workRef: {
      refType: 'work' as const,
      id,
      toolName: 'alembic_work' as const,
    },
  };
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
  searchResult: PrimeSearchResult | null,
  projectRuntime: Record<string, unknown>
): void {
  if (!ctx.session) {
    return;
  }
  const freshIntent = createIdleIntent();
  freshIntent.phase = 'active';
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

function bindWorkSession(ctx: McpContext, record: WorkRecord): void {
  if (!ctx.session) {
    return;
  }
  const intent = ctx.session.intent.phase === 'idle' ? createIdleIntent() : ctx.session.intent;
  intent.phase = 'active';
  intent.taskId = record.workRef;
  intent.taskTitle = record.title;
  intent.primeAt = Date.now();
  for (const file of record.scopeFiles) {
    intent.mentionedFiles.push(file);
  }
  intent.toolCalls.push({
    args_summary: record.title,
    timestamp: Date.now(),
    tool: 'alembic_work',
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

function buildBaseDetailRefs(toolName: AgentPublicToolName, sourceRefs: string[]) {
  const refs = [
    createAgentDetailRef({
      id: 'agent-public-contract',
      kind: 'contract',
      requiredForCompletion: true,
      summary: 'Agent-facing public tool clean output contract',
      uri: 'lib/runtime/mcp/public-tools/contract.ts',
    }),
    createAgentDetailRef({
      id: `${toolName}-handler`,
      kind: 'file',
      requiredForCompletion: true,
      summary: `${toolName} active MCP handler implementation`,
      uri: 'lib/runtime/mcp/handlers/agent-public-tools.ts',
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

function buildPrimePublicPackage(input: {
  detailRefs: AgentDetailRef[];
  intake: ReturnType<typeof buildAgentToolContext>;
  primeKnowledgeMaterial: PrimeKnowledgeMaterial | null;
  primeRef: string;
  result: AgentPublicToolResultEnvelope;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
}): PrimePublicPackage {
  const producerBoundary = buildPrimeProducerBoundary(input.searchResult);

  // Keep visible prime output compact; full Recipe and Guard material stays
  // available through the trust material and detail refs.
  return createPrimePublicPackage({
    compactPackage: {
      acceptedGuards: (input.primeKnowledgeMaterial?.acceptedGuards ?? [])
        .slice(0, 8)
        .map((item) => ({
          evidenceRefCount: item.evidenceRefs.length,
          id: item.id,
          score: item.score,
          title: item.title,
          trigger: item.trigger,
        })),
      acceptedKnowledge: (input.primeKnowledgeMaterial?.acceptedKnowledge ?? [])
        .slice(0, 8)
        .map((item) => ({
          ...(item.actionHint ? { actionHint: item.actionHint } : {}),
          evidenceRefCount: item.evidenceRefs.length,
          id: item.id,
          kind: item.kind,
          matchedRegionClasses: item.matchedRegionClasses,
          score: item.score,
          title: item.title,
          trustEvidence: item.trustEvidence,
          trigger: item.trigger,
          usefulSlices: item.usefulSlices.map((slice) => ({
            evidenceRefCount: slice.evidenceRefs.length,
            ...(slice.regionClass ? { regionClass: slice.regionClass } : {}),
            ...(slice.score !== undefined ? { score: slice.score } : {}),
            ...(slice.sourceRefsBridge ? { sourceRefsBridge: slice.sourceRefsBridge } : {}),
            text: slice.text,
          })),
        })),
      counts: {
        acceptedGuards: input.primeKnowledgeMaterial?.acceptedGuards.length ?? 0,
        acceptedKnowledge: input.primeKnowledgeMaterial?.acceptedKnowledge.length ?? 0,
        detailRefs: input.detailRefs.length,
        omittedFromCompact: Math.max(
          0,
          (input.primeKnowledgeMaterial?.acceptedGuards.length ?? 0) +
            (input.primeKnowledgeMaterial?.acceptedKnowledge.length ?? 0) -
            16
        ),
      },
      detailRefsMode: 'ref-based',
      evidenceDelivery: 'detailRefs-and-primeKnowledgeMaterial',
      primeInjectionPackage: producerBoundary,
    },
    feedbackDigest: buildPrimeFeedbackDigest(input.searchResult),
    kind: 'PrimePublicPackage',
    primeRef: input.primeRef,
    reason: input.result.reason,
    refs: input.result.refs,
    status: input.result.status,
    projectContextGuidance: buildPrimeProjectContextGuidance(input),
    summary: input.result.summary,
    trustPosture: buildPrimeTrustPostureProjection(input.primeKnowledgeMaterial, input.result),
    trustReceipt: {
      hostResponse: input.primeKnowledgeMaterial
        ? sanitizePrimeHostResponse(input.primeKnowledgeMaterial.hostResponse)
        : null,
      receiptId: input.primeKnowledgeMaterial?.receiptId ?? input.primeRef,
      status: input.primeKnowledgeMaterial?.status ?? primeTrustStatusFromResult(input.result),
    },
  });
}

function sanitizePrimeHostResponse(
  response: PrimeKnowledgeMaterial['hostResponse']
): Record<string, unknown> {
  return {
    ...response,
    reason: hostNeutralPrimeText(response.reason),
  };
}

function hostNeutralPrimeText(text: string): string {
  return text
    .replace(/\bAs Codex\b/g, 'As the host agent')
    .replace(/\bCodex\b/g, 'host agent')
    .replace(/\bClaude Code\b/g, 'host agent')
    .replace(/\bClaude\b/g, 'host agent');
}

function buildPrimeProjectContextGuidance(input: {
  primeKnowledgeMaterial: PrimeKnowledgeMaterial | null;
  result: AgentPublicToolResultEnvelope;
}) {
  const projectContextRefs = input.result.refs.detailRefs
    .filter((ref) => ['file', 'runtime-json', 'schema', 'source-ref'].includes(ref.kind))
    .map((ref) => ref.id)
    .slice(0, 40);
  const sourceEvidenceRefs = input.result.refs.detailRefs
    .filter((ref) => ref.kind === 'source-ref')
    .map((ref) => ref.id)
    .slice(0, 40);
  const activeFile = input.primeKnowledgeMaterial?.intent.activeFile;
  const query = compactPrimePublicString(
    firstString(
      input.primeKnowledgeMaterial?.intent.queries[0],
      input.primeKnowledgeMaterial?.intent.userQuery
    )
  );
  const focus = compactPrimePublicString(activeFile);
  const recommendedQueries = [
    {
      ...(query ? { query } : {}),
      ...(focus ? { focus } : {}),
      tool: 'alembic_project_matrix',
    },
    ...(focus
      ? [
          {
            focus,
            tool: 'alembic_graph',
          },
        ]
      : []),
  ].slice(0, 8);
  return {
    boundary:
      'ProjectContext guidance is compact project orientation only; it does not backfill Recipe provenance or replace raw source reads, Guard, repository tests, controller acceptance, or Test-window validation.',
    recommendedQueries,
    recommendedTools: ['alembic_project_matrix', 'alembic_graph'],
    projectContextRefs,
    sourceEvidenceRefs,
    status: projectContextRefs.length > 0 ? ('ready-evidence' as const) : ('recommended' as const),
  };
}

function compactPrimePublicString(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= PRIME_PUBLIC_STRING_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, PRIME_PUBLIC_STRING_MAX_CHARS - 3)}...`;
}

function buildPrimeFeedbackDigest(searchResult: PrimeSearchResult | null) {
  const consumer = searchResult?.searchMeta.retrievalConsumer;
  if (!consumer) {
    return null;
  }
  return {
    decisionRefCount: consumer.retrievalQuality?.decisionRefCount ?? null,
    feedbackSignalCount: consumer.retrievalQuality?.feedbackSignalCount ?? null,
    observeOnly: consumer.feedback?.observeOnly ?? null,
    sourceRefCoverage: consumer.retrievalQuality?.sourceRefCoverage ?? null,
    supportedSignals: consumer.feedback?.supportedSignals ?? [],
  };
}

function buildPrimeTrustPostureProjection(
  primeKnowledgeMaterial: PrimeKnowledgeMaterial | null,
  result: AgentPublicToolResultEnvelope
) {
  const status = primeKnowledgeMaterial?.status ?? primeTrustStatusFromResult(result);
  const checklist = primeKnowledgeMaterial
    ? primeKnowledgeMaterial.trustPosture.receiptChecklist.map((layer) => ({
        itemCount: layer.items.length,
        label: layer.label,
        layer: layer.layer,
        requiredInVisibleReceipt: layer.requiredInVisibleReceipt,
        visibleReceiptDirective: layer.visibleReceiptDirective,
      }))
    : PRIME_PUBLIC_TRUST_LAYERS.map((layer) => ({
        itemCount: layer === 'not-available-or-degraded' ? 1 : 0,
        label: primeTrustLayerLabelForPublicPackage(layer),
        layer,
        requiredInVisibleReceipt: layer === 'not-available-or-degraded',
        visibleReceiptDirective:
          layer === 'not-available-or-degraded'
            ? `In the visible receipt, say no usable project knowledge was delivered because prime ${result.status}.`
            : primeTrustLayerDirectiveForPublicPackage(layer),
      }));

  return {
    antiEmptyReceiptRequired:
      primeKnowledgeMaterial?.trustPosture.antiEmptyReceipt.required ?? true,
    noTrustedClaimRequired: result.status !== 'ready' || status !== 'delivered',
    receiptChecklist: checklist,
    status,
  };
}

function primeTrustStatusFromResult(
  result: AgentPublicToolResultEnvelope
): 'blocked' | 'degraded' | 'skipped' {
  if (result.status === 'blocked') {
    return 'blocked';
  }
  if (result.status === 'skipped') {
    return 'skipped';
  }
  return 'degraded';
}

function buildPrimeProducerBoundary(searchResult: PrimeSearchResult | null) {
  const residentPackage = searchResult?.searchMeta.primeInjectionPackage;
  const producerContract = searchResult?.searchMeta.retrievalConsumer?.producerContract;
  const residentSearch = searchResult?.searchMeta.residentSearch;
  const missingProducerFields = producerContract?.missingFields ?? [];
  const producerOnlyFields: PrimePublicPackage['compactPackage']['primeInjectionPackage']['producerOnlyFields'] =
    [
      'decisionRegister',
      'feedback',
      'intent',
      'search',
      'vector',
      'residentRegionRetrieval',
      'selectedKnowledge',
      'omitted',
      'trace',
      'retrievalQuality',
    ];

  // PrimeInjectionPackage 的 lexical/vector/trace 等生产语义属于
  // Alembic resident producer；Plugin 只透传 compact metadata，不能在消费侧补造。
  return {
    availability:
      producerContract && !producerContract.available
        ? ('producer-contract-missing' as const)
        : residentPackage
          ? ('resident-provided' as const)
          : residentSearch && residentSearch.available === false
            ? ('resident-unavailable' as const)
            : searchResult
              ? ('not-produced' as const)
              : ('not-run' as const),
    missingProducerFields,
    omittedCount: residentPackage?.injection.omittedCount ?? null,
    pluginSynthesized: false as const,
    producer: 'alembic-resident-service' as const,
    producerBoundary:
      'PrimeInjectionPackage lexical/vector/residentRegionRetrieval/selectedKnowledge/omitted/trace fields are produced by Alembic resident search metadata; AlembicPlugin only passes through the compact resident projection and never synthesizes producer-only fields.',
    producerOnlyFields,
    selectedCount: residentPackage?.injection.selectedCount ?? null,
    status: residentPackage?.injection.status ?? null,
  };
}

function primeTrustLayerLabelForPublicPackage(layer: (typeof PRIME_PUBLIC_TRUST_LAYERS)[number]) {
  switch (layer) {
    case 'trusted-to-obey':
      return 'Guard and rule constraints Codex must obey';
    case 'trusted-to-use':
      return 'Recipe or pattern knowledge Codex may use';
    case 'context-only':
      return 'Host intent, query, and evidence context only';
    case 'requires-verification':
      return 'Source refs, candidates, and evidence that require verification';
    case 'not-available-or-degraded':
      return 'Missing, blocked, or degraded project knowledge';
  }
}

function primeTrustLayerDirectiveForPublicPackage(
  layer: (typeof PRIME_PUBLIC_TRUST_LAYERS)[number]
) {
  switch (layer) {
    case 'trusted-to-obey':
      return 'No trusted-to-obey constraints were delivered in this prime result.';
    case 'trusted-to-use':
      return 'No trusted-to-use Recipe knowledge was delivered in this prime result.';
    case 'context-only':
      return 'Host intent and query data are only context when prime is not ready.';
    case 'requires-verification':
      return 'Source refs and evidence refs still require verification before use.';
    case 'not-available-or-degraded':
      return 'Say no usable project knowledge was delivered.';
  }
}

function buildResultSummary(compact: string): string {
  const visible = compact.trim() || 'Agent public tool result is ready.';
  return visible.length > 2000 ? visible.slice(0, 2000) : visible;
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
    case 'non-code-development-turn':
      return 'not-relevant-to-project-knowledge';
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
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
