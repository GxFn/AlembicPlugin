/**
 * MCP Handler — alembic_task (Intent Lifecycle + Signal Collection)
 *
 * 5 Operations:
 *   prime            — Load knowledge context + initialize intent
 *   create           — Create in-memory task anchor (generates ID)
 *   close            — Complete task + persist intent chain + conditionally recommend Guard
 *   fail             — Abandon task + persist intent chain
 *   record_decision  — Blocked legacy alias; use durable alembic_decision_record
 *
 * Architecture: Zero DB. Pure memory (IntentState) + SignalBus → JSONL signals.
 * Confirmed decisions are not stored here; they must go through the Alembic
 * resident Decision Register via the public alembic_decision_record tool.
 */

import type { AlembicResidentServiceResult } from '@alembic/core/daemon';
import type { SignalBus } from '@alembic/core/events';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexPrimeRuntimeContext } from '#codex/runtime/ProjectRuntimeContext.js';
import { GitDiffScanner } from '#service/evolution/git-diff-checkpoint/GitDiffScanner.js';
import type { ResidentIntentEpisodeClient } from '#service/resident/AlembicResidentCapabilityClients.js';
import type {
  ResidentIntentEpisodeRecord,
  ResidentIntentEpisodeStartRequest,
  ResidentIntentEvidenceSummary,
  ResidentPrimeInjectionPackageSummary,
} from '#service/resident/AlembicResidentServiceClient.js';
import type {
  HostDeclaredIntentInput,
  HostIntentFrame,
  HostTurnMetaInput,
  NormalizedHostIntentInput,
} from '#service/task/HostIntentFrame.js';
import {
  buildHostIntentFrame,
  buildResidentIntentHandoff,
  prepareHostIntentInput,
} from '#service/task/HostIntentFrame.js';
import type { ExtractedIntent } from '#service/task/IntentExtractor.js';
import { extract as extractIntent } from '#service/task/IntentExtractor.js';
import {
  buildPrimeKnowledgeMaterial,
  formatPrimeTrustPostureMessage,
} from '#service/task/PrimeKnowledgeMaterial.js';
import type { PrimeSearchResult, SlimSearchResult } from '#service/task/PrimeSearchPipeline.js';
import type {
  GuardTriggerDecision,
  TaskAnchorDecision,
} from '#service/task/TaskLifecyclePolicy.js';
import {
  classifyTaskLifecycleInput,
  decideGuardTrigger,
  normalizeTaskLifecycleFileRefs,
} from '#service/task/TaskLifecyclePolicy.js';
import { envelope } from '../../../runtime/mcp/envelope.js';
import type {
  IntentChainRecord,
  IntentState,
  McpContext,
  McpServiceContainer,
} from '../../../runtime/mcp/handlers/types.js';
import { createIdleIntent } from '../../../runtime/mcp/handlers/types.js';

// ─── Local Types ──────────────────────────────────────────

interface TaskArgs {
  operation?: string;
  id?: string;
  title?: string;
  description?: string;
  reason?: string;
  rationale?: string;
  tags?: string[];
  userQuery?: string;
  activeFile?: string;
  language?: string;
  hostDeclaredIntent?: HostDeclaredIntentInput;
  hostTurnMeta?: HostTurnMetaInput;
  changedFiles?: unknown;
  sourceRefs?: unknown;
  [key: string]: unknown;
}

interface EnvelopeResult {
  success: boolean;
  errorCode?: string | null;
  data?: unknown;
  message?: string;
  meta?: Record<string, unknown>;
}

type PrimeKnowledgeMaterialStatus = 'delivered' | 'empty' | 'degraded';
type PrimeTrustLayer =
  | 'trusted-to-obey'
  | 'trusted-to-use'
  | 'context-only'
  | 'requires-verification'
  | 'not-available-or-degraded';

interface PrimeEvidenceRef {
  path: string;
  line: number | null;
}

interface AcceptedPrimeKnowledge {
  id: string;
  kind: string;
  title: string;
  trigger: string;
  actionHint?: string;
  summary: string;
  score: number;
  evidenceRefs: PrimeEvidenceRef[];
}

interface AcceptedPrimeGuard {
  id: string;
  title: string;
  trigger: string;
  actionHint?: string;
  score: number;
  evidenceRefs: PrimeEvidenceRef[];
}

interface PrimeHostResponseInstruction {
  action: 'shout_prime_knowledge_receipt';
  receiptId: string;
  status: PrimeKnowledgeMaterialStatus;
  timing: 'immediate_after_prime';
  required: true;
  requiredBeforeNextAction: true;
  visibility: 'developer_visible';
  reason: string;
}

interface PrimeTrustPostureItem {
  id: string;
  title: string;
  source:
    | 'accepted-guard'
    | 'accepted-knowledge'
    | 'evidence-ref'
    | 'host-intent'
    | 'intent-evidence'
    | 'prime-injection-package'
    | 'prime-status'
    | 'search-context';
  reason: string;
  status?: string;
  evidenceRefs?: PrimeEvidenceRef[];
}

interface PrimeReceiptChecklistLayer {
  layer: PrimeTrustLayer;
  label: string;
  summary: string;
  items: PrimeTrustPostureItem[];
  requiredInVisibleReceipt: boolean;
  visibleReceiptDirective: string;
}

interface PrimeTrustPosture {
  status: PrimeKnowledgeMaterialStatus;
  receiptChecklist: PrimeReceiptChecklistLayer[];
  antiEmptyReceipt: {
    required: true;
    forbiddenGenericReceipts: string[];
    instruction: string;
  };
}

interface PrimeKnowledgeMaterial {
  status: PrimeKnowledgeMaterialStatus;
  receiptId: string;
  intent: {
    userQuery: string;
    activeFile?: string;
    language?: string;
    module?: string;
    scenario: string;
    queries: string[];
    hostIntentFrame?: HostIntentFrame;
  };
  acceptedKnowledge: AcceptedPrimeKnowledge[];
  acceptedGuards: AcceptedPrimeGuard[];
  trustPosture: PrimeTrustPosture;
  shoutInstruction: string;
  hostResponse: PrimeHostResponseInstruction;
  nextActions: Array<{
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    required: boolean;
    skipped?: boolean;
    taskAnchorDecision?: TaskAnchorDecision;
  }>;
  intentEpisode?: PrimeIntentEpisodeMaterial;
  intentEvidence?: ResidentIntentEvidenceSummary;
  primeInjectionPackage?: ResidentPrimeInjectionPackageSummary;
}

interface PrimeIntentEpisodeRecordSummary {
  episodeId: string;
  query?: string;
  sessionKey: string | null;
  sourceRefs: string[];
  status: string;
}

interface PrimeIntentEpisodeMaterial {
  available: boolean;
  current: PrimeIntentEpisodeRecordSummary | null;
  degraded: boolean;
  latest: PrimeIntentEpisodeRecordSummary | null;
  recent: PrimeIntentEpisodeRecordSummary[];
  read: {
    latest: ResidentCallSummary;
    recent: ResidentCallSummary;
  };
  reason: string | null;
  requestFields: string[];
  sessionSource:
    | 'host-conversation-hash'
    | 'host-session-hash'
    | 'host-thread-hash'
    | 'mcp-session';
  start: ResidentCallSummary;
}

interface ResidentCallSummary {
  ok: boolean;
  owner?: string;
  reason?: string;
  retryable?: boolean;
  route?: string;
}

// ─── In-memory task ID counter ───────────────────────────

let _taskCounter = 0;
let _primeReceiptCounter = 0;

const _primeReceiptOrder =
  'This receipt must be the next developer-visible response after the prime tool result, before any further tool call, code reading, edit, Guard check, or final summary.';

function _generateTaskId(): string {
  _taskCounter++;
  return `alembic-${Date.now().toString(36)}-${_taskCounter}`;
}

function _generatePrimeReceiptId(): string {
  _primeReceiptCounter++;
  return `prime-${Date.now().toString(36)}-${_primeReceiptCounter}`;
}

// ─── Task Rules Reminder ─────────────────────────────────

const _taskRules = {
  reminder: [
    '📋 LEGACY TASK COMPATIBILITY RULES:',
    '🔑 Prefer agent-facing public tools when they are available; this task surface is retained for older Codex sessions.',
    '• For project knowledge, use alembic_intent and alembic_prime as the primary path.',
    '• For implementation/fix/refactor/review work, use alembic_work_start and alembic_work_finish.',
    '• For code checks, use alembic_code_guard with explicit files or inline code.',
    '• For confirmed durable decisions, use alembic_decision_record.',
    '• Legacy record_decision direct calls are blocked and do not write Plugin-local decisions.',
    '• Do not ask the user to choose compatibility task operations.',
  ].join('\n'),
  translationHint: [
    'Compatibility mapping:',
    'semantic task → alembic_intent → alembic_prime',
    'concrete work → alembic_work_start → code → alembic_work_finish',
    'guard recommendation → alembic_code_guard with explicit scope',
    'confirmed decision → alembic_decision_record',
    'record decision → blocked; call alembic_decision_record for durable Decision Register writes',
    'pause/abandon is the only lifecycle case that may still need legacy fail metadata.',
  ].join('\n'),
};

/**
 * Unified entry point
 */
export async function taskHandler(ctx: McpContext, args: TaskArgs) {
  // Normalize taskId → id (schema accepts both for convenience)
  if (!args.id && typeof args.taskId === 'string') {
    args.id = args.taskId;
  }

  let result: EnvelopeResult;

  switch (args.operation) {
    case 'prime':
      return _prime(ctx, args);
    case 'create':
      result = await _create(ctx, args);
      break;
    case 'close':
      result = await _close(ctx, args);
      break;
    case 'fail':
      result = await _fail(ctx, args);
      break;
    case 'record_decision':
      result = await _recordDecision(ctx, args);
      break;
    default:
      return envelope({
        success: false,
        message: `Unknown operation: ${args.operation}. Valid: prime, create, close, fail, record_decision.`,
        meta: { tool: 'alembic_task' },
      });
  }

  return result;
}

// ═══ prime ═══════════════════════════════════════════════

async function _prime(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;

  // If there is an active intent, persist it as abandoned before starting fresh
  if (intent && intent.phase === 'active') {
    await _persistIntentChain(ctx, intent, 'abandoned', 'New prime received', intent.taskId);
  }

  // ─── Intake: merge Codex host hints with deterministic intent signals ───
  const hostIntentInput = prepareHostIntentInput({
    userQuery: args.userQuery,
    activeFile: args.activeFile,
    language: args.language,
    hostDeclaredIntent: args.hostDeclaredIntent,
    hostTurnMeta: args.hostTurnMeta,
    requestHostTurnMeta: ctx.hostTurnMeta,
  });
  const extracted = extractIntent(
    hostIntentInput.userQuery,
    hostIntentInput.activeFile,
    hostIntentInput.language
  );
  const hostIntentFrame = buildHostIntentFrame(hostIntentInput, extracted);
  const projectRoot =
    typeof args.projectRoot === 'string' && args.projectRoot.trim()
      ? args.projectRoot.trim()
      : undefined;
  const effectiveProjectRoot = projectRoot ?? resolveProjectRoot(ctx.container);
  const lifecycleClassification = classifyTaskLifecycleInput({
    hostIntentFrame,
    operation: 'prime',
    rawUserQuery: typeof args.userQuery === 'string' ? args.userQuery : undefined,
    userQuery: hostIntentInput.userQuery,
  });

  // ─── Enrichment: multi-query search via PrimeSearchPipeline ───
  const pipeline = _getPipeline(ctx.container);
  let searchResult: PrimeSearchResult | null = null;
  let searchDegraded = false;
  if (lifecycleClassification.primeDecision.action === 'skip') {
    process.stderr.write(
      `[MCP/Task] prime: lifecycle policy skipped search (${lifecycleClassification.primeDecision.reasonCode})\n`
    );
  } else if (pipeline && extracted.queries[0]?.trim()) {
    try {
      searchResult = await pipeline.search(extracted, {
        hostIntentFrame,
        projectRoot: effectiveProjectRoot,
      });
      if (!searchResult) {
        process.stderr.write('[MCP/Task] prime: pipeline.search returned null (all filtered)\n');
      }
    } catch (err: unknown) {
      searchDegraded = true;
      process.stderr.write(
        `[MCP/Task] prime search error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`
      );
    }
  } else if (!pipeline) {
    searchDegraded = true;
    process.stderr.write('[MCP/Task] prime: pipeline is null, skipping search\n');
  } else {
    process.stderr.write(
      `[MCP/Task] prime: queries empty, skipping search. queries=${JSON.stringify(extracted.queries)}\n`
    );
  }
  const projectRuntime = buildCodexPrimeRuntimeContext({
    projectRoot: effectiveProjectRoot,
    residentSearch: searchResult?.searchMeta.residentSearch ?? null,
  });

  // ─── Lifecycle: initialize IntentState ───
  const freshIntent = createIdleIntent();
  freshIntent.phase = 'active';
  freshIntent.primeQuery = hostIntentInput.userQuery;
  freshIntent.primeActiveFile = hostIntentInput.activeFile;
  freshIntent.primeLanguage = extracted.language;
  freshIntent.primeModule = extracted.module;
  freshIntent.primeScenario = extracted.scenario;
  freshIntent.hostIntentFrame = hostIntentFrame;
  freshIntent.primeAt = Date.now();

  if (searchResult) {
    freshIntent.primeRecipeIds = [...searchResult.relatedKnowledge, ...searchResult.guardRules]
      .map((r) => r.id)
      .filter(Boolean);
    freshIntent.searchMeta = {
      queries: searchResult.searchMeta.queries,
      resultCount: searchResult.searchMeta.resultCount,
      filteredCount: searchResult.searchMeta.filteredCount,
      ...(searchResult.searchMeta.intentEvidence
        ? { intentEvidence: searchResult.searchMeta.intentEvidence }
        : {}),
      ...(searchResult.searchMeta.primeInjectionPackage
        ? { primeInjectionPackage: searchResult.searchMeta.primeInjectionPackage }
        : {}),
      projectRuntime: projectRuntime as unknown as Record<string, unknown>,
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

  const intentEpisode = await _handoffIntentEpisode(ctx, {
    extracted,
    hostIntentFrame,
    hostIntentInput,
    intent: freshIntent,
  });
  if (intentEpisode.current?.episodeId) {
    freshIntent.intentEpisode = {
      episodeId: intentEpisode.current.episodeId,
      sessionKey: intentEpisode.current.sessionKey,
      startAvailable: intentEpisode.available,
    };
  }

  // Bind intent to session
  if (ctx.session) {
    ctx.session.intent = freshIntent;
  }

  // ─── Build response ───
  const relatedCount = searchResult?.relatedKnowledge.length ?? 0;
  const ruleCount = searchResult?.guardRules.length ?? 0;
  const primeKnowledgeMaterial = buildPrimeKnowledgeMaterial({
    hostIntentInput,
    extracted,
    hostIntentFrame,
    searchResult,
    searchDegraded,
    intentEpisode,
    taskAnchorDecision: lifecycleClassification.taskAnchorDecision,
  });

  const lines: string[] = [];
  if (lifecycleClassification.primeDecision.action === 'skip') {
    lines.push(
      `Prime search skipped by Codex task lifecycle policy: ${lifecycleClassification.primeDecision.reasonCode}.`
    );
    lines.push(formatPrimeTrustPostureMessage(primeKnowledgeMaterial.trustPosture));
    lines.push(
      '📣 Codex must say no project knowledge was searched because the lifecycle policy skipped prime for this turn; continue only within the visible task boundary and do not claim accepted project knowledge.'
    );
  } else if (primeKnowledgeMaterial.status === 'degraded') {
    lines.push('Prime knowledge search degraded; no project knowledge was delivered.');
    lines.push(formatPrimeTrustPostureMessage(primeKnowledgeMaterial.trustPosture));
    lines.push(
      '📣 Codex must immediately shout in the first person that it did not receive usable project knowledge because prime degraded before any further tool call, code reading, edit, Guard check, or final summary. Say the trust posture is not-available-or-degraded, and do not claim trusted-to-use or trusted-to-obey project knowledge. Do not make Alembic prime the speaker or subject.'
    );
  } else if (relatedCount > 0 || ruleCount > 0) {
    lines.push(`📋 Found ${relatedCount} recipe(s), ${ruleCount} guard rule(s).`);
    for (const r of searchResult?.relatedKnowledge ?? []) {
      const hint = r.actionHint ? ` — ${r.actionHint}` : '';
      lines.push(`  • ${r.trigger || r.title}${hint}`);
    }
    for (const r of searchResult?.guardRules ?? []) {
      lines.push(`  • [rule] ${r.trigger || r.title}`);
    }
    lines.push(formatPrimeTrustPostureMessage(primeKnowledgeMaterial.trustPosture));
    lines.push(
      '📣 Codex must immediately shout a short knowledge receipt before any further tool call, code reading, edit, Guard check, or final summary. Speak as Codex or I, not as Alembic prime: summarize trusted-to-obey Guard constraints, trusted-to-use Recipe or pattern knowledge, context-only host intent or evidence hints, and requires-verification source refs or candidates; keep evidenceRefs in the payload for later verification instead of listing paths by default.'
    );
  } else {
    lines.push('No matching recipes found.');
    lines.push(formatPrimeTrustPostureMessage(primeKnowledgeMaterial.trustPosture));
    lines.push(
      '📣 Codex must immediately shout in the first person that it did not receive usable project knowledge before any further tool call, code reading, edit, Guard check, or final summary. Say the trust posture is not-available-or-degraded, and do not claim trusted-to-use or trusted-to-obey project knowledge. Do not make Alembic prime the speaker or subject.'
    );
  }

  return envelope({
    success: true,
    data: {
      primeKnowledgeMaterial,
      knowledge: searchResult
        ? {
            relatedKnowledge: searchResult.relatedKnowledge,
            guardRules: searchResult.guardRules,
          }
        : null,
      searchMeta: searchResult
        ? { ...searchResult.searchMeta, projectRuntime }
        : { projectRuntime },
      projectRuntime,
      intentEpisode,
      lifecyclePolicy: lifecycleClassification,
      _taskRules,
    },
    message: lines.join('\n'),
    meta: { tool: 'alembic_task' },
  });
}

function _buildPrimeKnowledgeMaterial(input: {
  hostIntentInput: NormalizedHostIntentInput;
  extracted: ExtractedIntent;
  hostIntentFrame: HostIntentFrame;
  searchResult: PrimeSearchResult | null;
  searchDegraded: boolean;
  intentEpisode: PrimeIntentEpisodeMaterial;
  taskAnchorDecision: TaskAnchorDecision;
}): PrimeKnowledgeMaterial {
  const relatedKnowledge = input.searchResult?.relatedKnowledge ?? [];
  const guardRules = input.searchResult?.guardRules ?? [];
  const acceptedKnowledge = relatedKnowledge.map(_projectAcceptedKnowledge);
  const acceptedGuards = guardRules.map(_projectAcceptedGuard);
  const hasDeliveredKnowledge = acceptedKnowledge.length > 0 || acceptedGuards.length > 0;
  const status: PrimeKnowledgeMaterialStatus = input.searchDegraded
    ? 'degraded'
    : hasDeliveredKnowledge
      ? 'delivered'
      : 'empty';
  const receiptId = _generatePrimeReceiptId();
  const intent: PrimeKnowledgeMaterial['intent'] = {
    userQuery: input.hostIntentInput.userQuery,
    scenario: input.searchResult?.searchMeta.scenario ?? input.extracted.scenario,
    queries: input.searchResult?.searchMeta.queries ?? input.extracted.queries,
    hostIntentFrame: input.hostIntentFrame,
  };
  if (input.hostIntentInput.activeFile) {
    intent.activeFile = _redactVisiblePath(input.hostIntentInput.activeFile);
  }
  const language = input.searchResult?.searchMeta.language ?? input.extracted.language;
  if (language) {
    intent.language = language;
  }
  const moduleName = input.searchResult?.searchMeta.module ?? input.extracted.module;
  if (moduleName) {
    intent.module = moduleName;
  }
  const trustPosture = _buildPrimeTrustPosture({
    acceptedGuards,
    acceptedKnowledge,
    intent,
    searchResult: input.searchResult,
    status,
  });

  return {
    status,
    receiptId,
    intent,
    acceptedKnowledge,
    acceptedGuards,
    trustPosture,
    shoutInstruction: _buildPrimeShoutInstruction(status, trustPosture),
    hostResponse: _buildPrimeHostResponseInstruction(status, receiptId, trustPosture),
    nextActions: _buildPrimeKnowledgeNextActions(input.taskAnchorDecision),
    intentEpisode: input.intentEpisode,
    ...(input.searchResult?.searchMeta.intentEvidence
      ? { intentEvidence: input.searchResult.searchMeta.intentEvidence }
      : {}),
    ...(input.searchResult?.searchMeta.primeInjectionPackage
      ? { primeInjectionPackage: input.searchResult.searchMeta.primeInjectionPackage }
      : {}),
  };
}

function _buildPrimeTrustPosture(input: {
  acceptedGuards: AcceptedPrimeGuard[];
  acceptedKnowledge: AcceptedPrimeKnowledge[];
  intent: PrimeKnowledgeMaterial['intent'];
  searchResult: PrimeSearchResult | null;
  status: PrimeKnowledgeMaterialStatus;
}): PrimeTrustPosture {
  const primePackage = input.searchResult?.searchMeta.primeInjectionPackage;
  const packageStatus = primePackage?.injection.status;
  const packageNeedsVerification = _isPrimePackageVerificationStatus(packageStatus);
  const packageUnavailable = _isPrimePackageUnavailableStatus(packageStatus);
  const acceptedKnowledgeIds = new Set(input.acceptedKnowledge.map((item) => item.id));

  const trustedToObey = input.acceptedGuards.map((guard) => ({
    id: `guard:${guard.id}`,
    title: guard.trigger || guard.title,
    source: 'accepted-guard' as const,
    reason: 'Follow this Guard or rule as an accepted constraint before acting.',
    evidenceRefs: guard.evidenceRefs,
  }));

  const trustedToUse: PrimeTrustPostureItem[] =
    packageNeedsVerification || packageUnavailable
      ? []
      : input.acceptedKnowledge.map((item) => ({
          id: `knowledge:${item.id}`,
          title: item.trigger || item.title,
          source: 'accepted-knowledge' as const,
          reason:
            'Use this Recipe or pattern as project knowledge while preserving its evidence for later checks.',
          evidenceRefs: item.evidenceRefs,
        }));
  if (packageStatus === 'ready') {
    for (const item of primePackage?.selectedKnowledge ?? []) {
      const itemId = _recordString(item, 'itemId');
      if (!itemId || acceptedKnowledgeIds.has(itemId)) {
        continue;
      }
      trustedToUse.push({
        id: `prime-package-selected:${itemId}`,
        title: _recordString(item, 'trigger') ?? _recordString(item, 'title') ?? itemId,
        source: 'prime-injection-package',
        reason:
          'Use this resident-selected knowledge because the prime injection package marked it ready.',
        status: _recordString(item, 'injectionStatus') ?? packageStatus,
        evidenceRefs: _extractEvidenceRefs(_recordStringArray(item.sourceRefs)),
      });
    }
  }

  const contextOnly: PrimeTrustPostureItem[] = [
    {
      id: 'prime-query-context',
      title: 'Prime query, scenario, and generated search queries',
      source: 'search-context',
      reason:
        'Use the query and scenario to steer search and receipt wording; do not present them as verified project facts.',
    },
  ];
  if (input.intent.hostIntentFrame) {
    contextOnly.push({
      id: 'host-intent-frame',
      title: 'Codex host intent frame',
      source: 'host-intent',
      reason:
        'Treat host-declared intent and host turn metadata as navigation hints, not trusted project knowledge.',
      status: input.intent.hostIntentFrame.degraded
        ? 'degraded'
        : input.intent.hostIntentFrame.source,
    });
  }
  if (input.searchResult?.searchMeta.intentEvidence) {
    contextOnly.push({
      id: 'resident-intent-evidence',
      title: 'Resident intent evidence summary',
      source: 'intent-evidence',
      reason:
        'Use ranking, relation, and anchor evidence as context for why material was selected, not as a rule to obey.',
      status: input.searchResult.searchMeta.intentEvidence.degraded ? 'degraded' : 'available',
    });
  }

  const requiresVerification: PrimeTrustPostureItem[] = [];
  const acceptedEvidenceRefs = _uniquePrimeEvidenceRefs(
    [...input.acceptedKnowledge, ...input.acceptedGuards].flatMap((item) => item.evidenceRefs)
  );
  if (acceptedEvidenceRefs.length > 0) {
    requiresVerification.push({
      id: 'accepted-material-evidence',
      title: 'Accepted material evidenceRefs',
      source: 'evidence-ref',
      reason:
        'Keep evidenceRefs as verification inputs for later code reading or user-requested citations; do not dump paths in the receipt by default.',
      evidenceRefs: acceptedEvidenceRefs,
    });
  }
  const packageTraceRefs = _extractEvidenceRefs(primePackage?.trace.sourceRefs ?? []);
  if (packageTraceRefs.length > 0) {
    requiresVerification.push({
      id: 'prime-package-source-refs',
      title: 'Prime package sourceRefs',
      source: 'prime-injection-package',
      reason:
        'Treat sourceRefs from the injection package as verification anchors, not as automatically verified facts.',
      evidenceRefs: packageTraceRefs,
      status: packageStatus,
    });
  }
  if (packageNeedsVerification) {
    requiresVerification.push({
      id: `prime-package-status:${packageStatus}`,
      title: `Prime injection package status: ${packageStatus}`,
      source: 'prime-injection-package',
      reason:
        'Candidate or needs-confirmation knowledge must be named as requiring verification before it is acted on as trusted project knowledge.',
      status: packageStatus,
    });
  }
  for (const item of primePackage?.selectedKnowledge ?? []) {
    const injectionStatus = _recordString(item, 'injectionStatus');
    if (injectionStatus !== 'candidate') {
      continue;
    }
    const itemId = _recordString(item, 'itemId') ?? 'unknown';
    requiresVerification.push({
      id: `candidate-knowledge:${itemId}`,
      title: _recordString(item, 'trigger') ?? _recordString(item, 'title') ?? itemId,
      source: 'prime-injection-package',
      reason:
        'This selectedKnowledge item is only a candidate and must be presented as requiring verification.',
      status: injectionStatus,
      evidenceRefs: _extractEvidenceRefs(_recordStringArray(item.sourceRefs)),
    });
  }

  const notAvailableOrDegraded: PrimeTrustPostureItem[] = [];
  if (input.status === 'empty' || input.status === 'degraded') {
    notAvailableOrDegraded.push({
      id: `prime-status:${input.status}`,
      title:
        input.status === 'degraded'
          ? 'Prime knowledge search degraded'
          : 'No matching Recipe or Guard knowledge delivered',
      source: 'prime-status',
      reason:
        input.status === 'degraded'
          ? 'Do not claim usable project knowledge was received; continue only with explicit code reading and verification.'
          : 'Do not claim project-specific knowledge was accepted; continue with normal code reading and verification.',
      status: input.status,
    });
  }
  if (packageUnavailable) {
    notAvailableOrDegraded.push({
      id: `prime-package-unavailable:${packageStatus}`,
      title: `Prime injection package status: ${packageStatus}`,
      source: 'prime-injection-package',
      reason:
        'The resident injection package did not provide trusted project knowledge for the receipt.',
      status: packageStatus,
    });
  }

  return {
    status: input.status,
    receiptChecklist: [
      _buildPrimeTrustChecklistLayer('trusted-to-obey', trustedToObey),
      _buildPrimeTrustChecklistLayer('trusted-to-use', trustedToUse),
      _buildPrimeTrustChecklistLayer('context-only', contextOnly),
      _buildPrimeTrustChecklistLayer('requires-verification', requiresVerification),
      _buildPrimeTrustChecklistLayer('not-available-or-degraded', notAvailableOrDegraded),
    ],
    antiEmptyReceipt: {
      required: true,
      forbiddenGenericReceipts: [
        'received knowledge',
        'I received project knowledge',
        '收到了知识',
      ],
      instruction:
        'The developer-visible receipt must name the trust layers that are present; a generic received/accepted slogan is not sufficient.',
    },
  };
}

function _buildPrimeTrustChecklistLayer(
  layer: PrimeTrustLayer,
  items: PrimeTrustPostureItem[]
): PrimeReceiptChecklistLayer {
  return {
    layer,
    label: _primeTrustLayerLabel(layer),
    summary: items.length > 0 ? `${items.length} item(s) require receipt handling.` : 'No items.',
    items,
    requiredInVisibleReceipt: items.length > 0,
    visibleReceiptDirective: _primeTrustLayerDirective(layer),
  };
}

function _primeTrustLayerLabel(layer: PrimeTrustLayer): string {
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
      return 'Missing or degraded project knowledge';
  }
}

function _primeTrustLayerDirective(layer: PrimeTrustLayer): string {
  switch (layer) {
    case 'trusted-to-obey':
      return 'In the visible receipt, say which Guard or rule constraints I will obey.';
    case 'trusted-to-use':
      return 'In the visible receipt, say which Recipe or pattern knowledge I can use as project guidance.';
    case 'context-only':
      return 'In the visible receipt, name host intent, queries, and evidence summaries only as context or hints.';
    case 'requires-verification':
      return 'In the visible receipt, say candidate knowledge, source refs, and evidence refs require later verification.';
    case 'not-available-or-degraded':
      return 'In the visible receipt, say no usable project knowledge was delivered when this layer has items.';
  }
}

function _formatPrimeTrustPostureMessage(posture: PrimeTrustPosture): string {
  const counts = posture.receiptChecklist
    .map((entry) => `${entry.layer}=${entry.items.length}`)
    .join(', ');
  return `Trust posture checklist: ${counts}. A visible receipt must name the obey/use/context/verify/degraded boundaries and cannot be a generic received-knowledge slogan.`;
}

function _isPrimePackageVerificationStatus(status: string | undefined): boolean {
  return status === 'candidate' || status === 'needs-confirmation';
}

function _isPrimePackageUnavailableStatus(status: string | undefined): boolean {
  return status === 'degraded' || status === 'empty';
}

function _recordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function _recordStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function _uniquePrimeEvidenceRefs(refs: PrimeEvidenceRef[]): PrimeEvidenceRef[] {
  const seen = new Set<string>();
  const unique: PrimeEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.path}\0${ref.line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function _projectAcceptedKnowledge(item: SlimSearchResult): AcceptedPrimeKnowledge {
  return {
    id: item.id,
    kind: item.kind || 'pattern',
    title: item.title,
    trigger: item.trigger,
    ...(item.actionHint ? { actionHint: item.actionHint } : {}),
    summary: _summarizePrimeItem(item),
    score: item.score,
    evidenceRefs: _extractEvidenceRefs(item.sourceRefs),
  };
}

function _projectAcceptedGuard(item: SlimSearchResult): AcceptedPrimeGuard {
  return {
    id: item.id,
    title: item.title,
    trigger: item.trigger,
    ...(item.actionHint ? { actionHint: item.actionHint } : {}),
    score: item.score,
    evidenceRefs: _extractEvidenceRefs(item.sourceRefs),
  };
}

function _summarizePrimeItem(item: SlimSearchResult): string {
  return item.description || item.actionHint || item.trigger || item.title;
}

function _extractEvidenceRefs(sourceRefs?: string[]): PrimeEvidenceRef[] {
  if (!sourceRefs?.length) {
    return [];
  }
  const refs: PrimeEvidenceRef[] = [];
  const seen = new Set<string>();
  for (const rawRef of sourceRefs) {
    const ref = rawRef.trim();
    if (!ref) {
      continue;
    }
    const evidence = _parseEvidenceRef(ref);
    const key = `${evidence.path}\0${evidence.line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    refs.push(evidence);
    seen.add(key);
  }
  return refs;
}

function _parseEvidenceRef(ref: string): PrimeEvidenceRef {
  const match = ref.match(/^(.*?)(?::(?:L|line-?|#L)?(\d+))(?:[:,-]\d+)?$/i);
  if (!match?.[1] || !match[2]) {
    return { path: ref, line: null };
  }
  const line = Number.parseInt(match[2], 10);
  return {
    path: match[1],
    line: Number.isFinite(line) && line > 0 ? line : null,
  };
}

function _buildPrimeShoutInstruction(
  status: PrimeKnowledgeMaterialStatus,
  trustPosture: PrimeTrustPosture
): string {
  const trustChecklist = _formatPrimeTrustPostureMessage(trustPosture);
  if (status === 'delivered') {
    return [
      'Immediately after this prime tool result, before any further tool call, code reading, edit, Guard check, or final summary, shout a short, active knowledge receipt to the developer in your own words.',
      'Use Codex/first-person as the speaker: say what I accepted or what Codex received; do not make "Alembic prime", prime, or any tool/process the grammatical subject of the visible receipt.',
      'Make it feel like a real shout: lead with the accepted trusted-to-obey Guard constraints and trusted-to-use Recipe or pattern knowledge, then name any context-only host intent or evidence hints and any requires-verification source refs or candidates.',
      trustChecklist,
      'Do not collapse the receipt into an empty "I received knowledge" slogan.',
      'Use trigger, actionHint, title, and summary to make the shout readable; do not list evidenceRefs paths or line numbers by default, and do not call out missing line numbers.',
      'Keep evidenceRefs for your later code reading, verification, or user-requested citations.',
      'Then continue the user task based on the accepted knowledge.',
    ].join(' ');
  }
  if (status === 'empty') {
    return [
      'Immediately after this prime tool result, before any further tool call, code reading, edit, Guard check, or final summary, shout a clear receipt in the first person that I did not receive matching Recipe or Guard knowledge for this request.',
      'Do not make "Alembic prime", prime, or any tool/process the grammatical subject of the visible receipt.',
      trustChecklist,
      'Say the trust posture is not-available-or-degraded and that there is no trusted-to-obey or trusted-to-use project knowledge from prime.',
      'Do not claim project-specific knowledge was accepted.',
      'Then continue with normal code reading and verification.',
    ].join(' ');
  }
  return [
    'Immediately after this prime tool result, before any further tool call, code reading, edit, Guard check, or final summary, shout a clear receipt in the first person that I did not receive usable project knowledge because prime degraded.',
    'Do not make "Alembic prime", prime, or any tool/process the grammatical subject of the visible receipt.',
    trustChecklist,
    'Say the trust posture is not-available-or-degraded and that there is no trusted-to-obey or trusted-to-use project knowledge from prime.',
    'Do not pretend Recipe or Guard knowledge was accepted.',
    'Continue only with explicit code reading and verification.',
  ].join(' ');
}

function _buildPrimeHostResponseInstruction(
  status: PrimeKnowledgeMaterialStatus,
  receiptId: string,
  trustPosture: PrimeTrustPosture
): PrimeHostResponseInstruction {
  // hostResponse 是给 Codex 宿主的可见回复动作，不是 MCP 工具调用，避免误触发不存在的 codex_host_response tool。
  const trustChecklist = _formatPrimeTrustPostureMessage(trustPosture);
  return {
    action: 'shout_prime_knowledge_receipt',
    receiptId,
    status,
    timing: 'immediate_after_prime',
    required: true,
    requiredBeforeNextAction: true,
    visibility: 'developer_visible',
    reason:
      status === 'delivered'
        ? `As Codex, tell the developer the prime trust posture before acting: trusted-to-obey Guard constraints, trusted-to-use Recipe or pattern knowledge, context-only host intent or evidence hints, and requires-verification source refs or candidates. ${trustChecklist} do not make Alembic prime the recipient or speaker. ${_primeReceiptOrder}`
        : `As Codex, tell the developer the prime trust posture is not-available-or-degraded before continuing; do not claim trusted-to-obey or trusted-to-use project knowledge. ${trustChecklist} do not make Alembic prime the recipient or speaker. ${_primeReceiptOrder}`,
  };
}

function _buildPrimeKnowledgeNextActions(
  taskAnchorDecision: TaskAnchorDecision
): PrimeKnowledgeMaterial['nextActions'] {
  if (taskAnchorDecision.action === 'skip') {
    return [
      {
        tool: 'alembic_task',
        args: {
          operation: 'create',
          title: '<short task title>',
        },
        required: false,
        skipped: true,
        reason: `Task anchor skipped by Codex-aware lifecycle policy: ${taskAnchorDecision.reasonCode}.`,
        taskAnchorDecision,
      },
    ];
  }
  return [
    {
      tool: 'alembic_task',
      args: {
        operation: 'create',
        title: '<short task title>',
      },
      required: false,
      reason: `Create a task anchor after the prime knowledge receipt only for real implementation work (${taskAnchorDecision.reasonCode}).`,
      taskAnchorDecision,
    },
  ];
}

// ═══ create ═════════════════════════════════════════════

async function _create(ctx: McpContext, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'alembic_task' },
    });
  }

  const taskId = _generateTaskId();
  const intent = ctx.session?.intent;

  // Bind task ID to current intent
  if (intent && intent.phase === 'active') {
    intent.taskId = taskId;
    intent.taskTitle = args.title;
  }

  return envelope({
    success: true,
    data: { id: taskId, title: args.title },
    message: `📌 Created: ${taskId} — ${args.title}`,
    meta: { tool: 'alembic_task' },
  });
}

// ═══ close ══════════════════════════════════════════════

async function _close(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;
  // Resolve id: explicit arg > session intent > fail
  const id = args.id || (intent?.taskId ?? '');
  if (!id) {
    return envelope({
      success: false,
      message: 'id is required (pass id or ensure a task was created in this session)',
      meta: { tool: 'alembic_task' },
    });
  }

  const reason = args.reason || 'Completed';
  const projectRoot = _resolveTaskProjectRoot(ctx, args);
  const detectedChangedFiles = await _detectTaskLifecycleChangedFiles(projectRoot);
  const changedFiles = _uniqueStrings([
    ...detectedChangedFiles,
    ...normalizeTaskLifecycleFileRefs(args.changedFiles, { projectRoot }),
  ]);
  const taskScopeFiles = _collectTaskScopeFiles(args, intent, projectRoot);
  const guardDecision = decideGuardTrigger({
    changedFiles,
    taskAnchorExists: true,
    taskScopeFiles,
  });
  const lifecyclePolicy = {
    ...classifyTaskLifecycleInput({
      hostIntentFrame: intent?.hostIntentFrame,
      operation: 'close',
      rawUserQuery: typeof args.userQuery === 'string' ? args.userQuery : undefined,
      taskId: id,
      title: intent?.taskTitle,
      userQuery: reason,
    }),
    guardDecision,
  };

  // Persist intent chain via SignalBus
  if (intent && intent.phase === 'active') {
    await _persistIntentChain(ctx, intent, 'completed', reason, id);
  }

  // Reset intent to idle
  if (ctx.session) {
    ctx.session.intent = createIdleIntent();
  }

  const lines = [`✅ Closed: ${id} — ${reason}`];
  lines.push('');
  lines.push(_formatGuardDecisionMessage(guardDecision));

  return envelope({
    success: true,
    data: {
      closed: { id, reason, closedAt: Date.now() },
      guardDecision,
      lifecyclePolicy,
      nextAction: _buildGuardNextAction(guardDecision),
    },
    message: lines.join('\n'),
    meta: { tool: 'alembic_task' },
  });
}

function _buildGuardNextAction(guardDecision: GuardTriggerDecision): Record<string, unknown> {
  if (guardDecision.action === 'run') {
    return {
      tool: 'alembic_guard',
      args: {
        files: guardDecision.taskScopedFiles,
      },
      required: true,
      reason:
        'Post-close task-scoped compliance review — check only files changed by this task before moving on.',
    };
  }
  return {
    tool: 'alembic_guard',
    args: {},
    required: false,
    skipped: true,
    reason: `Post-close Guard skipped by Codex-aware lifecycle policy: ${guardDecision.reasonCode}.`,
  };
}

function _formatGuardDecisionMessage(guardDecision: GuardTriggerDecision): string {
  if (guardDecision.action === 'run') {
    return `⚠️ REQUIRED: Call alembic_guard with files=${JSON.stringify(guardDecision.taskScopedFiles)} before moving on.`;
  }
  return `Guard skipped by Codex-aware lifecycle policy: ${guardDecision.reasonCode}.`;
}

function _resolveTaskProjectRoot(ctx: McpContext, args: TaskArgs): string {
  return typeof args.projectRoot === 'string' && args.projectRoot.trim()
    ? args.projectRoot.trim()
    : resolveProjectRoot(ctx.container);
}

async function _detectTaskLifecycleChangedFiles(projectRoot: string): Promise<string[]> {
  try {
    const scan = await new GitDiffScanner({ projectRoot }).scanOnce();
    return normalizeTaskLifecycleFileRefs(
      scan.events.map((event) => event.path),
      { projectRoot }
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Task] close guard diff scan unavailable: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return [];
  }
}

function _collectTaskScopeFiles(
  args: TaskArgs,
  intent: IntentState | undefined,
  projectRoot: string
): string[] {
  const frame = intent?.hostIntentFrame;
  return _uniqueStrings([
    ...normalizeTaskLifecycleFileRefs(args.changedFiles, { projectRoot }),
    ...normalizeTaskLifecycleFileRefs(args.sourceRefs, { projectRoot }),
    ...normalizeTaskLifecycleFileRefs(args.activeFile, { projectRoot }),
    ...normalizeTaskLifecycleFileRefs(intent?.primeActiveFile, { projectRoot }),
    ...normalizeTaskLifecycleFileRefs(intent?.mentionedFiles, { projectRoot }),
    ...normalizeTaskLifecycleFileRefs(frame?.recognizedIntentDraft.sourceRefs, { projectRoot }),
    ...normalizeTaskLifecycleFileRefs(frame?.hostDeclaredIntent?.sourceRefs, { projectRoot }),
  ]);
}

// ═══ fail ═══════════════════════════════════════════════

async function _fail(ctx: McpContext, args: TaskArgs) {
  const intent = ctx.session?.intent;
  // Resolve id: explicit arg > session intent > fail
  const id = args.id || (intent?.taskId ?? '');
  if (!id) {
    return envelope({
      success: false,
      message: 'id is required (pass id or ensure a task was created in this session)',
      meta: { tool: 'alembic_task' },
    });
  }

  const reason = args.reason || 'Agent execution failed';

  // Persist intent chain via SignalBus
  if (intent && intent.phase === 'active') {
    await _persistIntentChain(ctx, intent, 'failed', reason, id);
  }

  // Reset intent to idle
  if (ctx.session) {
    ctx.session.intent = createIdleIntent();
  }

  return envelope({
    success: true,
    data: {
      failed: { id, reason, failedAt: Date.now() },
    },
    message: `❌ Failed: ${id} — ${reason}`,
    meta: { tool: 'alembic_task' },
  });
}

// ═══ record_decision ════════════════════════════════════

async function _recordDecision(ctx: McpContext, args: TaskArgs) {
  if (!args.title) {
    return envelope({
      success: false,
      message: 'title is required',
      meta: { tool: 'alembic_task' },
    });
  }
  if (!args.description) {
    return envelope({
      success: false,
      message: 'description is required',
      meta: { tool: 'alembic_task' },
    });
  }

  process.stderr.write(
    '[MCP/Task] record_decision blocked: legacy local decision persistence is disabled; use alembic_decision_record with a resident Decision Register route.\n'
  );

  return envelope({
    success: false,
    errorCode: 'legacy-record-decision-disabled',
    data: {
      legacyCompatibility: {
        operation: 'record_decision',
        status: 'blocked',
        writesLocalDecision: false,
        replacementTool: 'alembic_decision_record',
      },
      durablePersistence: {
        available: false,
        requiredRoute: 'Alembic durable Decision Register route',
        reason: 'legacy-record-decision-disabled',
      },
    },
    message:
      'Legacy alembic_task record_decision is disabled. Use alembic_decision_record so confirmed decisions go to the Alembic durable Decision Register; no Plugin-local fake decision was written.',
    meta: { tool: 'alembic_task' },
  });
}

// ═══ Intent Chain Persistence (via SignalBus) ═══════════

async function _persistIntentChain(
  ctx: McpContext,
  intent: IntentState,
  outcome: 'completed' | 'failed' | 'abandoned',
  reason?: string,
  taskId?: string
) {
  const now = Date.now();
  const chain: IntentChainRecord = {
    sessionId: ctx.session?.id || 'unknown',
    taskId: intent.taskId,
    outcome,

    primeQuery: intent.primeQuery,
    primeActiveFile: intent.primeActiveFile,
    primeRecipeIds: intent.primeRecipeIds,
    primeAt: intent.primeAt || now,
    primeLanguage: intent.primeLanguage ?? null,
    primeModule: intent.primeModule ?? null,
    primeScenario: intent.primeScenario ?? 'search',

    searchMeta: intent.searchMeta,

    toolCalls: intent.toolCalls,
    searchQueries: intent.searchQueries,
    mentionedFiles: intent.mentionedFiles,
    decisions: intent.decisions,

    driftEvents: intent.driftEvents,
    driftScore: _computeDriftScore(intent),

    closeReason: outcome === 'completed' ? reason : undefined,
    failReason: outcome !== 'completed' ? reason : undefined,
    startedAt: intent.primeAt || now,
    endedAt: now,
    duration: now - (intent.primeAt || now),
  };

  // Emit via SignalBus — subscribers handle JSONL persistence
  try {
    const signalBus = ctx.container.get('signalBus') as SignalBus;
    signalBus.send('intent', 'TaskHandler', _computeDriftScore(intent), {
      target: intent.taskId ?? null,
      metadata: { chain },
    });
  } catch {
    // signalBus unavailable — silent failure, non-blocking
  }

  await _updateIntentEpisodeOutcome(ctx, intent, outcome, reason, taskId);
}

async function _handoffIntentEpisode(
  ctx: McpContext,
  input: {
    extracted: ExtractedIntent;
    hostIntentFrame: HostIntentFrame;
    hostIntentInput: NormalizedHostIntentInput;
    intent: IntentState;
  }
): Promise<PrimeIntentEpisodeMaterial> {
  const episodeSession = _resolveEpisodeSession(ctx, input.hostIntentFrame);
  const request = _buildIntentEpisodeStartRequest(input, episodeSession.sessionId);
  const requestFields = Object.keys(request).sort();
  const unavailable: PrimeIntentEpisodeMaterial = {
    available: false,
    current: null,
    degraded: true,
    latest: null,
    recent: [],
    read: {
      latest: { ok: false, reason: 'residentServiceClient unavailable' },
      recent: { ok: false, reason: 'residentServiceClient unavailable' },
    },
    reason: 'residentServiceClient unavailable',
    requestFields,
    sessionSource: episodeSession.source,
    start: { ok: false, reason: 'residentServiceClient unavailable' },
  };

  const client = _getResidentIntentEpisodeClient(ctx.container);
  if (!client) {
    return unavailable;
  }

  try {
    const latestResult = await client.latestIntentEpisode({ sessionId: episodeSession.sessionId });
    const recentResult = await client.recentIntentEpisodes({
      limit: 3,
      sessionId: episodeSession.sessionId,
    });
    const startResult = await client.startIntentEpisode(request);

    const latest = latestResult.ok ? _projectIntentEpisodeRecord(latestResult.value.episode) : null;
    const recent = recentResult.ok
      ? (recentResult.value.episodes ?? [])
          .map(_projectIntentEpisodeRecord)
          .filter((episode): episode is PrimeIntentEpisodeRecordSummary => episode !== null)
      : [];
    const current = startResult.ok ? _projectIntentEpisodeRecord(startResult.value.episode) : null;
    const reason = startResult.ok
      ? null
      : startResult.reason || startResult.message || 'IntentEpisode start unavailable';

    if (!startResult.ok) {
      process.stderr.write(`[MCP/Task] intent episode start degraded: ${reason}\n`);
    }

    return {
      available: startResult.ok,
      current,
      degraded: !startResult.ok,
      latest,
      recent,
      read: {
        latest: _summarizeResidentCall(latestResult),
        recent: _summarizeResidentCall(recentResult),
      },
      reason,
      requestFields,
      sessionSource: episodeSession.source,
      start: _summarizeResidentCall(startResult),
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[MCP/Task] intent episode handoff error: ${reason}\n`);
    return {
      ...unavailable,
      reason,
      read: {
        latest: { ok: false, reason },
        recent: { ok: false, reason },
      },
      start: { ok: false, reason },
    };
  }
}

function _buildIntentEpisodeStartRequest(
  input: {
    extracted: ExtractedIntent;
    hostIntentFrame: HostIntentFrame;
    hostIntentInput: NormalizedHostIntentInput;
    intent: IntentState;
  },
  sessionId: string
): ResidentIntentEpisodeStartRequest {
  const frame = input.hostIntentFrame;
  const draft = frame.recognizedIntentDraft;
  const sourceRefs = _collectEpisodeSourceRefs(frame, input.intent);
  const handoff = buildResidentIntentHandoff({
    hostIntentFrame: frame,
    language: input.extracted.language,
    sourceRefs,
    userQuery: input.hostIntentInput.userQuery,
  });
  const hostIntent: Record<string, unknown> = {
    applied: true,
    confidence: frame.confidence,
    degraded: frame.degraded,
    degradedReason: frame.degradedReasons.join('; ') || undefined,
    recognizedIntentDraft: {
      action: draft.action,
      confidence: draft.confidence,
      constraints: draft.constraints,
      degraded: draft.degraded,
      degradedReasons: draft.degradedReasons,
      language: draft.language,
      query: draft.query,
      source: draft.source,
      sourceRefs: _uniqueStrings([...(draft.sourceRefs ?? []), ...sourceRefs]),
      status: draft.status,
      target: draft.target,
    },
    scenario: input.extracted.scenario,
    searchIntent: input.extracted.scenario,
    sourceRefs,
    sources: _uniqueStrings([
      frame.source,
      ...(frame.hostDeclaredIntent ? ['hostDeclaredIntent'] : []),
      ...(frame.hostTurnMeta ? ['hostTurnMeta'] : []),
    ]),
  };
  if (handoff?.intentContext && _isRecord(handoff.intentContext)) {
    Object.assign(hostIntent, handoff.intentContext);
  }
  if (frame.hostDeclaredIntent) {
    hostIntent.hostDeclaredIntent = frame.hostDeclaredIntent;
  }
  if (frame.hostTurnMeta) {
    hostIntent.hostTurnMeta = frame.hostTurnMeta;
  }

  return _stripUndefined({
    activeFile: input.hostIntentInput.activeFile,
    hostIntent: _stripUndefined(hostIntent),
    language: draft.language ?? input.extracted.language ?? undefined,
    module: draft.target ?? input.extracted.module ?? undefined,
    query: draft.query || input.hostIntentInput.userQuery || input.extracted.queries[0],
    scenario: input.extracted.scenario,
    searchMeta: _projectEpisodeSearchMeta(input.intent.searchMeta, frame, sourceRefs),
    sessionId,
    sourceRefs,
    turnId: frame.hostTurnMeta?.turnId ?? frame.hostTurnMeta?.messageId,
  }) as ResidentIntentEpisodeStartRequest;
}

function _resolveEpisodeSession(
  ctx: McpContext,
  hostIntentFrame: HostIntentFrame
): {
  sessionId: string;
  source: PrimeIntentEpisodeMaterial['sessionSource'];
} {
  const turnMeta = hostIntentFrame.hostTurnMeta;
  if (turnMeta?.threadIdHash) {
    return { sessionId: `thread:${turnMeta.threadIdHash}`, source: 'host-thread-hash' };
  }
  if (turnMeta?.conversationIdHash) {
    return {
      sessionId: `conversation:${turnMeta.conversationIdHash}`,
      source: 'host-conversation-hash',
    };
  }
  if (turnMeta?.sessionIdHash) {
    return { sessionId: `host-session:${turnMeta.sessionIdHash}`, source: 'host-session-hash' };
  }
  return { sessionId: ctx.session?.id || 'mcp-session', source: 'mcp-session' };
}

function _projectEpisodeSearchMeta(
  searchMeta: IntentState['searchMeta'],
  hostIntentFrame: HostIntentFrame,
  sourceRefs: string[]
): Record<string, unknown> {
  const residentSearch = _isRecord(searchMeta?.residentSearch)
    ? searchMeta.residentSearch
    : undefined;
  const residentSearchMeta = _isRecord(residentSearch?.searchMeta)
    ? residentSearch.searchMeta
    : undefined;
  return _stripUndefined({
    filteredCount: searchMeta?.filteredCount,
    hostIntentApplied:
      residentSearchMeta?.hostIntentApplied ?? residentSearch?.hostIntentApplied ?? true,
    hostIntentConfidence:
      residentSearchMeta?.hostIntentConfidence ??
      residentSearch?.hostIntentConfidence ??
      hostIntentFrame.confidence,
    hostIntentDegraded:
      residentSearchMeta?.hostIntentDegraded ??
      residentSearch?.hostIntentDegraded ??
      hostIntentFrame.degraded,
    hostIntentDegradedReason:
      residentSearchMeta?.hostIntentDegradedReason ??
      residentSearch?.hostIntentDegradedReason ??
      (hostIntentFrame.degradedReasons.length > 0
        ? hostIntentFrame.degradedReasons.join('; ')
        : undefined),
    hostIntentSourceRefs:
      residentSearchMeta?.hostIntentSourceRefs ??
      residentSearch?.hostIntentSourceRefs ??
      sourceRefs,
    ...(searchMeta?.intentEvidence ? { intentEvidence: searchMeta.intentEvidence } : {}),
    ...(searchMeta?.primeInjectionPackage
      ? { primeInjectionPackage: searchMeta.primeInjectionPackage }
      : {}),
    queries: searchMeta?.queries,
    resultCount: searchMeta?.resultCount,
  });
}

async function _updateIntentEpisodeOutcome(
  ctx: McpContext,
  intent: IntentState,
  outcome: 'completed' | 'failed' | 'abandoned',
  reason?: string,
  taskId?: string
): Promise<void> {
  const episodeId = intent.intentEpisode?.episodeId;
  if (!episodeId) {
    return;
  }
  const client = _getResidentIntentEpisodeClient(ctx.container);
  if (!client) {
    return;
  }
  const status =
    outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'abandoned';
  try {
    const result = await client.updateIntentEpisodeOutcome(episodeId, {
      reason,
      searchMeta: intent.hostIntentFrame
        ? _projectEpisodeSearchMeta(
            intent.searchMeta,
            intent.hostIntentFrame,
            _collectEpisodeSourceRefs(intent.hostIntentFrame, intent)
          )
        : undefined,
      status,
      taskId: taskId ?? intent.taskId,
    });
    if (!result.ok) {
      process.stderr.write(
        `[MCP/Task] intent episode outcome degraded: ${result.reason || result.message}\n`
      );
    }
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Task] intent episode outcome error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

function _getResidentIntentEpisodeClient(
  container: McpServiceContainer
): ResidentIntentEpisodeClient | null {
  try {
    return container.get('residentIntentEpisodeClient') as ResidentIntentEpisodeClient | null;
  } catch {
    // Older in-process containers still expose a compatibility facade while the
    // Codex-facing route split rolls through the package.
  }
  try {
    return container.get('residentServiceClient') as ResidentIntentEpisodeClient | null;
  } catch {
    return null;
  }
}

function _projectIntentEpisodeRecord(
  record: ResidentIntentEpisodeRecord | null | undefined
): PrimeIntentEpisodeRecordSummary | null {
  if (!record?.episodeId) {
    return null;
  }
  return {
    episodeId: record.episodeId,
    ...(record.query ? { query: record.query } : {}),
    sessionKey: record.sessionKey ?? null,
    sourceRefs: _stringArray(record.sourceRefs).slice(0, 12),
    status: record.status,
  };
}

function _summarizeResidentCall<TValue>(
  result: AlembicResidentServiceResult<TValue>
): ResidentCallSummary {
  if (result.ok) {
    return {
      ok: true,
      owner: result.status?.owner,
      route: result.status?.route,
    };
  }
  return {
    ok: false,
    owner: result.status?.owner,
    reason: result.reason || result.message,
    retryable: result.retryable,
    route: result.status?.route,
  };
}

function _collectEpisodeSourceRefs(frame: HostIntentFrame, intent: IntentState): string[] {
  return _uniqueStrings([
    ...(frame.recognizedIntentDraft.sourceRefs ?? []),
    ...(frame.hostDeclaredIntent?.sourceRefs ?? []),
    ...(intent.primeRecipeIds ?? []).map((id) => `knowledge:${id}`),
  ]).slice(0, 24);
}

function _stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function _stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function _uniqueStrings(values: string[]): string[] {
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

function _isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function _redactVisiblePath(value: string): string {
  if (!value.startsWith('/')) {
    return value;
  }
  const normalized = value.replace(/\\/g, '/');
  const basename = normalized.split('/').filter(Boolean).pop() || 'file';
  return `[absolute-path]/${basename}`;
}

function _computeDriftScore(intent: IntentState): number {
  if (intent.driftEvents.length === 0) {
    return 0;
  }
  const sum = intent.driftEvents.reduce((acc, d) => acc + (1 - d.primeOverlap), 0);
  return sum / intent.driftEvents.length;
}

// ═══ PrimeSearchPipeline accessor ═══════════════════════

interface PipelineLike {
  search(
    intent: ExtractedIntent,
    options?: { hostIntentFrame?: HostIntentFrame; projectRoot?: string }
  ): Promise<PrimeSearchResult | null>;
}

function _getPipeline(container: McpServiceContainer): PipelineLike | null {
  try {
    const p = container.get('primeSearchPipeline') as PipelineLike | null;
    if (!p) {
      process.stderr.write('[MCP/Task] _getPipeline: container returned null/undefined\n');
    }
    return p;
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Task] _getPipeline failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}
