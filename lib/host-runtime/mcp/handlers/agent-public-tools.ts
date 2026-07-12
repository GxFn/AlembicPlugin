import { resolveHostRuntimeContext } from '#host-runtime/context/RuntimeContext.js';
import type { HostDeclaredIntentInput, HostTurnMetaInput } from '#service/task/host-turn-meta.js';
import {
  buildPrimeKnowledgeMaterial,
  type PrimeKnowledgeMaterial,
} from '#service/task/PrimeKnowledgeMaterial.js';
import type { PrimeSearchRequest, PrimeSearchResult } from '#service/task/PrimeSearchPipeline.js';
import {
  classifyTaskLifecycleInput,
  decideGuardTrigger,
  normalizeTaskLifecycleFileRefs,
  type TaskLifecycleClassification,
} from '#service/task/TaskLifecyclePolicy.js';
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
  type PrimePublicPackage,
} from '../public-tools/index.js';
import * as guardHandlers from './guard.js';
import {
  type McpContext,
  type McpServiceContainer,
  requireRequestProjectRuntime,
} from './types.js';

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

interface AgentPrimeArgs {
  context?: string;
  language?: string;
  projectRoot?: string;
  query?: string;
}

interface StandalonePrimeRequirementFrame {
  searchQuery?: string;
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
  /** prime→guard step1（observe-only）：本会话 alembic_prime 返回的 primeRef */
  primeRef?: string;
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

interface PrimeToolContext {
  agentHost: AgentHost;
  inputSource: AgentInputSource;
  sourceRefs: string[];
}

interface PrimeHandlerSharedInput {
  args: AgentPrimeArgs;
  detailRefs: AgentDetailRef[];
  intake: PrimeToolContext;
  primeRef: string;
}

interface PrimeHandlerReadyInput extends PrimeHandlerSharedInput {
  ctx: McpContext;
  effectiveProjectRoot: string;
  primeSearch: Awaited<ReturnType<typeof runPrimeSearch>>;
}

interface PrimeMaterialProjection {
  primeKnowledgeMaterial: PrimeKnowledgeMaterial;
}

interface PipelineLike {
  search(request: PrimeSearchRequest): Promise<PrimeSearchResult | null>;
}

let primeCounter = 0;
let workCounter = 0;

const PRIME_PUBLIC_STRING_MAX_CHARS = 240;
let finishCounter = 0;
let guardCounter = 0;
const WORK_RECORDS = new Map<string, WorkRecord>();

/**
 * prime→guard 闭环 step1（2026-07-06，observe-only）：按 primeRef 留存本次
 * prime 交付的知识摘要（id/title/sources），供 guard 观测"交付知识与被检文件
 * 的重叠度"。进程态、FIFO 上限 50——与 WORK_RECORDS 同款会话内闭环模型。
 */
interface PrimeDeliveryRecord {
  createdAt: string;
  feedbackRuleIds: Set<string>;
  guards: Array<{ id: string; title: string; sources: string[] }>;
  knowledge: Array<{ id: string; title: string; sources: string[] }>;
  primeRef: string;
}
const PRIME_RECORDS = new Map<string, PrimeDeliveryRecord>();
const PRIME_RECORDS_CAP = 50;

function rememberPrimeDelivery(record: PrimeDeliveryRecord): void {
  PRIME_RECORDS.set(record.primeRef, record);
  while (PRIME_RECORDS.size > PRIME_RECORDS_CAP) {
    const oldest = PRIME_RECORDS.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    PRIME_RECORDS.delete(oldest);
  }
}

export async function primeHandler(ctx: McpContext, args: AgentPrimeArgs) {
  const intake = buildPrimeToolContext(args);
  const detailRefs = buildBaseDetailRefs('alembic_prime', intake.sourceRefs);
  const primeRef = nextPrimeRef();
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

function buildPrimeRefs(input: PrimeHandlerSharedInput) {
  return {
    detailRefs: input.detailRefs,
    primeRef: { refType: 'prime' as const, id: input.primeRef, toolName: 'alembic_prime' as const },
  };
}

async function buildPrimeReadyOutput(input: PrimeHandlerReadyInput) {
  const material = buildPrimeMaterialProjection(
    input.intake,
    input.primeSearch,
    buildStandalonePrimeRequirementFrame(input.args),
    input.args
  );
  const baseSearchDegraded =
    input.primeSearch.searchDegraded || material.primeKnowledgeMaterial.status === 'degraded';
  const status = resolvePrimeStatus({
    primeKnowledgeMaterial: material.primeKnowledgeMaterial,
    searchDegraded: input.primeSearch.searchDegraded,
    searchResult: input.primeSearch.searchResult,
  });
  const result = buildPrimeReadyResult(input, status);

  const primePackage = buildPrimePublicPackage({
    detailRefs: input.detailRefs,
    primeKnowledgeMaterial: material.primeKnowledgeMaterial,
    primeRef: input.primeRef,
    result,
    searchDegraded: baseSearchDegraded,
    searchResult: input.primeSearch.searchResult,
  });
  // prime→guard step1：留存交付知识摘要供 guard 观测重叠（observe-only）。
  rememberPrimeDelivery({
    createdAt: new Date().toISOString(),
    feedbackRuleIds: new Set(),
    guards: material.primeKnowledgeMaterial.acceptedGuards.map((item) => ({
      id: item.id,
      title: item.title ?? item.id,
      sources: (item.evidenceRefs ?? []).map((ref) => ref.path).filter(Boolean),
    })),
    knowledge: material.primeKnowledgeMaterial.acceptedKnowledge.map((item) => ({
      id: item.id,
      title: item.title ?? item.id,
      sources: (item.evidenceRefs ?? []).map((ref) => ref.path).filter(Boolean),
    })),
    primeRef: input.primeRef,
  });
  // Prime returns its own query-native output with bounded detail refs.
  return createAgentPublicToolOutput(result, {
    primePackage,
    detailRefs: [...input.detailRefs, ...primeMaterialDetailRefs(material.primeKnowledgeMaterial)],
    diagnostics: [
      ...buildPrimeReadyDiagnostics(
        input.primeSearch,
        baseSearchDegraded,
        input.primeSearch.regionEvidence
      ),
    ],
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
  searchDegraded: boolean,
  regionEvidence: Record<string, unknown>[]
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
  if (!hasSemanticRegionVectorEvidence(regionEvidence)) {
    diagnostics.push({
      code: 'prime-vector-evidence-unavailable',
      severity: 'info',
      message:
        'The local Recipe semantic-region vector lane was unavailable or unused; PrimeSearchPipeline lexical/FWS evidence remains independently reported.',
      retryable: false,
    });
  }
  return diagnostics;
}

function hasSemanticRegionVectorEvidence(regionEvidence: Record<string, unknown>[]): boolean {
  return regionEvidence.some((evidence) => {
    if (Array.isArray(evidence.matchedRegionClasses) && evidence.matchedRegionClasses.length > 0) {
      return true;
    }
    return (
      Array.isArray(evidence.whySelected) &&
      evidence.whySelected.some((reason) => reason === 'local-region-vector')
    );
  });
}

function evidenceRefToUri(
  ref: PrimeKnowledgeMaterial['acceptedKnowledge'][number]['evidenceRefs'][number]
) {
  if (ref.line === null) {
    return ref.path;
  }
  // P2 行级 locator（2026-07-06）：refs 表存 path:start-end，带区间尾时输出完整
  // 区间，宿主可一跳直达证据行段（此前恒截成 :start 单行、常见形态是误导性的 :1）。
  return ref.endLine ? `${ref.path}:${ref.line}-${ref.endLine}` : `${ref.path}:${ref.line}`;
}

function _resolveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function _readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildPrimeMaterialProjection(
  intake: PrimeToolContext,
  primeSearch: Awaited<ReturnType<typeof runPrimeSearch>>,
  frame: StandalonePrimeRequirementFrame,
  args: AgentPrimeArgs
): PrimeMaterialProjection {
  return {
    primeKnowledgeMaterial: buildPrimeKnowledgeMaterial({
      requirement: {
        userQuery: frame.searchQuery ?? '',
        queries: frame.searchQuery ? [frame.searchQuery] : [],
        language: args.language ?? null,
      },
      searchDegraded: primeSearch.searchDegraded,
      searchResult: primeSearch.searchResult,
      sourceRefs: intake.sourceRefs,
      regionEvidence: primeSearch.regionEvidence,
    }),
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

  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'work',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
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
    return buildCodeGuardReadyOutput({ args, ctx, detailRefs, guardEnvelope, intake, scope });
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
  const explicitFiles = normalizeCodeGuardFileRefs(args.files ?? [], effectiveProjectRoot);
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

function normalizeCodeGuardFileRefs(files: string[], projectRoot: string): string[] {
  const normalized = files
    .map((raw) => {
      const lifecycleRef = normalizeTaskLifecycleFileRefs([raw], { projectRoot })[0];
      if (lifecycleRef) {
        return lifecycleRef;
      }
      const explicitPath = raw
        .trim()
        .replace(/^file:\/\//, '')
        .replace(/:(?:L|line-?|#L)?\d+(?:[:,-]\d+)?$/i, '');
      return explicitPath &&
        !explicitPath.includes('\0') &&
        !explicitPath.startsWith('knowledge:') &&
        !explicitPath.startsWith('host:')
        ? explicitPath
        : null;
    })
    .filter((file): file is string => Boolean(file));
  return [...new Set(normalized)];
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
  ctx: McpContext;
  detailRefs: AgentDetailRef[];
  guardEnvelope: unknown;
  intake: ReturnType<typeof buildAgentToolContext>;
  scope: CodeGuardScopeResolution;
}) {
  const { args, ctx, detailRefs, guardEnvelope, intake, scope } = input;
  const guardResultRef = nextGuardResultRef();
  const guard = projectGuardBusinessPayload(guardEnvelope);
  const guardResult = isRecord(guard.guardResult) ? guard.guardResult : {};
  const guardRecord = guard as Record<string, unknown>;
  const guardSummary = typeof guardRecord.summary === 'string' ? guardRecord.summary : '';
  const verdict = guardResult.verdict;
  const baseStatus =
    verdict === 'blocked' ? 'blocked' : verdict === 'incomplete' ? 'degraded' : 'ready';
  // prime→guard step1（2026-07-06，observe-only）：primeRef 显式传入或从 workRef
  // 记录继承，命中本会话 PRIME_RECORDS 时报告"prime 交付知识与被检文件的重叠"。
  // 纯观测面：不改变守门判定，不新增硬门；未命中/无 primeRef 时字段缺席。
  const effectivePrimeRef = args.primeRef ?? scope.workRecord?.primeRef;
  const primeAlignment = effectivePrimeRef
    ? buildGuardPrimeAlignment(effectivePrimeRef, scope.files, guardResult)
    : null;
  const status = baseStatus;
  // 采纳信号回流（2026-07-06 闭环审查落地）：observed 且有真实重叠 = "prime 交付的
  // 知识用在了对的文件上"——递增 stats.primeAdoptions（observe-first，decay/排序
  // 消费另行调参）。失败静默：回流是观测面副作用，绝不破坏 guard 主链。
  recordPrimeAdoptionSignals(ctx, primeAlignment);
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'code-guard',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    refs: {
      ...buildWorkRefEntry(args.workRef),
      detailRefs,
      guardResultRef: {
        refType: 'guard-result',
        id: guardResultRef,
        toolName: 'alembic_code_guard',
      },
    },
    ...(status === 'degraded'
      ? {
          reason: {
            kind: 'degraded' as const,
            code: 'guard-coverage-incomplete' as const,
            message: 'Code Guard could not complete every requested file check.',
            retryable: true,
          },
        }
      : {}),
    ...(status === 'blocked'
      ? {
          reason: {
            kind: 'blocked' as const,
            code: 'guard-scope-invalid' as const,
            message: 'Code Guard rejected one or more requested paths outside the project root.',
            retryable: false,
          },
        }
      : {}),
    status,
    summary: buildResultSummary(
      guardSummary
        ? guardSummary
        : scope.hasCode
          ? 'Code Guard checked explicit inline code.'
          : `Code Guard checked ${scope.files.length} explicit file(s).`
    ),
    toolName: 'alembic_code_guard',
  });
  return createAgentPublicToolOutput(result, {
    detailRefs,
    explicitScope: buildCodeGuardExplicitScope(args, scope),
    guard,
    guardResultRef,
    ...(primeAlignment ? { primeAlignment } : {}),
    unsupportedScopeFields: scope.unsupportedScopeFields,
  });
}

/**
 * prime→guard step1 观测面：primeRef 命中本会话交付记录时，统计交付知识的
 * sources（workspace 相对，去行号）与被检文件（绝对路径）的后缀重叠。
 * 未命中记录 → status: 'prime-ref-unknown'（跨会话/进程重启后的诚实降级）。
 */
function recordPrimeAdoptionSignals(
  ctx: McpContext,
  primeAlignment: Record<string, unknown> | null
): void {
  if (!primeAlignment || primeAlignment.status !== 'observed') {
    return;
  }
  const feedbackGuardIds = Array.isArray(primeAlignment.feedbackGuardIds)
    ? (primeAlignment.feedbackGuardIds as string[])
    : [];
  if (feedbackGuardIds.length === 0) {
    return;
  }
  try {
    const repo = ctx.container.get('knowledgeRepository') as {
      incrementPrimeAdoptionsSync?(id: string, count: number): void;
    } | null;
    if (!repo || typeof repo.incrementPrimeAdoptionsSync !== 'function') {
      return;
    }
    for (const guardId of feedbackGuardIds) {
      repo.incrementPrimeAdoptionsSync(guardId, 1);
    }
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/AgentPublicTools] prime adoption signal degraded: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

function buildGuardPrimeAlignment(
  primeRef: string,
  checkedFiles: string[],
  guardResult: Record<string, unknown>
): Record<string, unknown> {
  const record = PRIME_RECORDS.get(primeRef);
  if (!record) {
    return {
      primeRef,
      status: 'prime-ref-unknown',
      note: 'No prime delivery record in this MCP session (expired, capped, or from another session).',
    };
  }
  const overlapped: Array<{ id: string; title: string; matchedFiles: string[] }> = [];
  for (const knowledge of record.knowledge) {
    const matchedFiles = checkedFiles.filter((file) =>
      knowledge.sources.some((source) => {
        const bare = source.split(':')[0];
        return bare.length > 0 && file.replaceAll('\\', '/').endsWith(bare);
      })
    );
    if (matchedFiles.length > 0) {
      overlapped.push({ id: knowledge.id, title: knowledge.title, matchedFiles });
    }
  }
  const overlappedGuards = matchPrimeDeliveryItems(record.guards, checkedFiles);
  const coverage = isRecord(guardResult.coverage) ? guardResult.coverage : {};
  const coverageComplete = coverage.completeness === 'complete';
  const deliveredGuardIds = new Set(record.guards.map((guard) => guard.id));
  // 当前公开 Guard 结果只提供“已装载规则摘要”和“适用 Recipe 清单”，两者都不
  // 是规则已被宿主实际使用/应用的 receipt。没有显式 used/applied 证据时必须保留
  // 空集；违规证据在 violatedGuardIds 中独立回流，不能借 loaded/applicable 冒充。
  const appliedGuardIds: string[] = [];
  const violatedGuardIds = coverageComplete
    ? collectViolatedGuardIds(guardResult).filter((id) => deliveredGuardIds.has(id))
    : [];
  const feedbackGuardIds = uniqueStrings([...appliedGuardIds, ...violatedGuardIds]).filter(
    (id) => !record.feedbackRuleIds.has(id)
  );
  for (const id of feedbackGuardIds) {
    record.feedbackRuleIds.add(id);
  }
  return {
    primeRef,
    status: 'observed',
    deliveredKnowledgeCount: record.knowledge.length,
    deliveredGuardCount: record.guards.length,
    overlappedKnowledgeCount: overlapped.length,
    overlappedKnowledge: overlapped.slice(0, 5),
    overlappedGuardIds: overlappedGuards.map((guard) => guard.id).slice(0, 20),
    appliedGuardIds,
    violatedGuardIds,
    feedbackGuardIds,
    feedbackRecorded: feedbackGuardIds.length > 0,
    coverageComplete,
  };
}

function matchPrimeDeliveryItems(
  items: Array<{ id: string; title: string; sources: string[] }>,
  checkedFiles: string[]
): Array<{ id: string; title: string; matchedFiles: string[] }> {
  return items.flatMap((item) => {
    const matchedFiles = checkedFiles.filter((file) =>
      item.sources.some((source) => {
        const bare = source.split(':')[0];
        return bare.length > 0 && file.replaceAll('\\', '/').endsWith(bare);
      })
    );
    return matchedFiles.length > 0 ? [{ id: item.id, title: item.title, matchedFiles }] : [];
  });
}

function collectViolatedGuardIds(guardResult: Record<string, unknown>): string[] {
  const violations = [
    ...(Array.isArray(guardResult.violations) ? guardResult.violations : []),
    ...(Array.isArray(guardResult.crossFileViolations) ? guardResult.crossFileViolations : []),
    ...(Array.isArray(guardResult.files) ? guardResult.files : []).flatMap((file) => {
      const record = isRecord(file) ? file : {};
      return Array.isArray(record.violations) ? record.violations : [];
    }),
  ];
  return uniqueStrings(
    violations
      .filter(isRecord)
      .map((violation) => firstString(violation.ruleId))
      .filter((id): id is string => Boolean(id))
  );
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
// DH-7 / RC-1: default the calling-host-agent family from the runtime-resolved pluginHost
// (same source as status.runtimeIdentity.pluginHost) — codex runtime → 'codex', cc runtime →
// 'claude-code' — replacing the hardcoded 'codex'. This only READS the already-resolved value
// (host selection stays in L3; no host-name branch here); pluginHost is always one of AGENT_HOSTS.
function resolveDefaultAgentHost(): AgentHost {
  return resolveHostRuntimeContext().pluginHost as AgentHost;
}

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
    agentHost: args.agentHost ?? resolveDefaultAgentHost(),
    inputSource: resolveAgentInputSource(args.inputSource, lifecycle.inputSource),
    lifecycle,
    sourceRefs,
  };
}

function buildPrimeToolContext(_args: AgentPrimeArgs): PrimeToolContext {
  return {
    agentHost: resolveDefaultAgentHost(),
    inputSource: 'user-message',
    sourceRefs: [],
  };
}

function buildStandalonePrimeRequirementFrame(
  args: AgentPrimeArgs
): StandalonePrimeRequirementFrame {
  const query = firstString(args.query);
  const context = firstString(args.context);
  const queryParts = uniqueStrings([...(query ? [query] : []), ...(context ? [context] : [])]);
  return {
    ...(queryParts.length > 0 ? { searchQuery: queryParts.join(' ') } : {}),
  };
}

async function runPrimeSearch(
  ctx: McpContext,
  args: AgentPrimeArgs,
  _intake: PrimeToolContext
): Promise<{
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  regionEvidence: Record<string, unknown>[];
}> {
  const pipeline = getPipeline(ctx.container);
  if (!pipeline) {
    return { searchDegraded: true, searchResult: null, regionEvidence: [] };
  }
  try {
    const frame = buildStandalonePrimeRequirementFrame(args);
    const searchResult = await pipeline.search({
      query: frame.searchQuery ?? '',
      ...(frame.searchQuery ? { queries: [frame.searchQuery] } : {}),
      language: args.language ?? null,
    });
    return {
      searchDegraded: false,
      searchResult,
      regionEvidence: [],
    };
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/AgentPublicTools] alembic_prime search degraded: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { searchDegraded: true, searchResult: null, regionEvidence: [] };
  }
}

function resolvePrimeStatus(input: {
  primeKnowledgeMaterial: Pick<
    PrimeKnowledgeMaterial,
    'acceptedGuards' | 'acceptedKnowledge' | 'degradedReason' | 'status'
  >;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
}): Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string } {
  if (input.searchDegraded) {
    return {
      reason: {
        kind: 'degraded',
        code: 'optional-service-unavailable',
        message:
          'Prime search degraded because the local PrimeSearchPipeline retrieval lane failed or was unavailable.',
        retryable: true,
      },
      status: 'degraded',
      summary: 'Prime local search was unavailable.',
    };
  }
  if (input.primeKnowledgeMaterial.status === 'degraded') {
    const reason = input.primeKnowledgeMaterial.degradedReason;
    return {
      reason: {
        kind: 'degraded',
        code: 'knowledge-empty',
        message: reason?.message ?? 'Prime local search was unavailable.',
        retryable: true,
      },
      status: 'degraded',
      summary: 'Prime local search was unavailable.',
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
      status: 'ready',
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

// prime→guard step1（2026-07-06）：primeRef 以 observe-only 身份从非公开清单开闸
// （primeAlignment 观测面），其余三个 scope 字段维持非公开边界。
const UNSUPPORTED_CODE_GUARD_SCOPE_FIELDS = [
  'diffRef',
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
      uri: 'lib/host-runtime/mcp/public-tools/contract.ts',
    }),
    createAgentDetailRef({
      id: `${toolName}-handler`,
      kind: 'file',
      requiredForCompletion: true,
      summary: `${toolName} active MCP handler implementation`,
      uri: 'lib/host-runtime/mcp/handlers/agent-public-tools.ts',
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
  primeKnowledgeMaterial: PrimeKnowledgeMaterial | null;
  primeRef: string;
  result: AgentPublicToolResultEnvelope;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
}): PrimePublicPackage {
  // Keep visible prime output compact; full Recipe and Guard material stays
  // available through the material projection and detail refs.
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
          ...(item.actionHint
            ? {
                actionHint:
                  item.actionHint.length > 500
                    ? `${item.actionHint.slice(0, 497)}…`
                    : item.actionHint,
              }
            : {}),
          evidenceRefCount: item.evidenceRefs.length,
          id: item.id,
          kind: item.kind,
          matchedRegionClasses: item.matchedRegionClasses,
          score: item.score,
          title: item.title,
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
    },
    kind: 'PrimePublicPackage',
    primeRef: input.primeRef,
    reason: input.result.reason,
    refs: input.result.refs,
    status: input.result.status,
    projectContextGuidance: buildPrimeProjectContextGuidance(input),
    summary: input.result.summary,
  });
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
      ...(focus && !query ? { focus } : {}),
      tool: 'alembic_search',
    },
    {
      ...(query ? { query } : {}),
      ...(focus ? { focus } : {}),
      tool: 'alembic_recipe_map',
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
    recommendedTools: ['alembic_search', 'alembic_recipe_map', 'alembic_graph'],
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

function buildResultSummary(compact: string): string {
  const visible = compact.trim() || 'Agent public tool result is ready.';
  return visible.length > 2000 ? visible.slice(0, 2000) : visible;
}

function resolveEffectiveProjectRoot(ctx: McpContext, args: { projectRoot?: string }): string {
  return typeof args.projectRoot === 'string' && args.projectRoot.trim()
    ? args.projectRoot.trim()
    : requireRequestProjectRuntime(ctx).identity.projectRoot;
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
