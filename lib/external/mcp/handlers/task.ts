/**
 * MCP Handler — alembic_task (Intent Lifecycle + Signal Collection)
 *
 * 5 Operations:
 *   prime            — Load knowledge context + initialize intent
 *   create           — Create in-memory task anchor (generates ID)
 *   close            — Complete task + persist intent chain + trigger Guard
 *   fail             — Abandon task + persist intent chain
 *   record_decision  — Record user preference signal
 *
 * Architecture: Zero DB. Pure memory (IntentState) + SignalBus → JSONL signals.
 */

import type { AlembicResidentServiceResult } from '@alembic/core/daemon';
import type { SignalBus } from '@alembic/core/events';
import type {
  AlembicResidentServiceClient,
  ResidentIntentEpisodeRecord,
  ResidentIntentEpisodeStartRequest,
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
import type { PrimeSearchResult, SlimSearchResult } from '#service/task/PrimeSearchPipeline.js';
import { envelope } from '../envelope.js';
import type {
  DecisionRecord,
  IntentChainRecord,
  IntentState,
  McpContext,
  McpServiceContainer,
} from './types.js';
import { createIdleIntent } from './types.js';

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
  shoutInstruction: string;
  hostResponse: PrimeHostResponseInstruction;
  nextActions: Array<{
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    required: boolean;
  }>;
  intentEpisode?: PrimeIntentEpisodeMaterial;
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
    '📋 TASK RULES (MANDATORY):',
    '🔑 YOU are the task operator — user speaks naturally, you translate to task operations.',
    '• MUST prime on EVERY message BEFORE anything else',
    '• MUST create task for non-trivial work (≥2 files OR ≥10 lines)',
    '• MUST close when done with meaningful reason',
    '• When user agrees/disagrees → record_decision immediately',
    '• NEVER tell user to run task commands',
  ].join('\n'),
  translationHint: [
    'User Says → You Run:',
    '"fix bug"/"implement" → create→code→close',
    '"continue" → resume in-progress→close',
    '"pause"/"abandon" → fail(id, reason)',
    '"agreed"/"disagree" → record_decision',
    'Quick question → No task. Just answer.',
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

  // ─── Enrichment: multi-query search via PrimeSearchPipeline ───
  const pipeline = _getPipeline(ctx.container);
  let searchResult: PrimeSearchResult | null = null;
  let searchDegraded = false;
  if (pipeline && extracted.queries[0]?.trim()) {
    try {
      searchResult = await pipeline.search(extracted, { hostIntentFrame });
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
  const primeKnowledgeMaterial = _buildPrimeKnowledgeMaterial({
    hostIntentInput,
    extracted,
    hostIntentFrame,
    searchResult,
    searchDegraded,
    intentEpisode,
  });

  const lines: string[] = [];
  if (primeKnowledgeMaterial.status === 'degraded') {
    lines.push('Prime knowledge search degraded; no project knowledge was delivered.');
    lines.push(
      '📣 Codex must immediately shout in the first person that it did not receive usable project knowledge because prime degraded before any further tool call, code reading, edit, Guard check, or final summary. Do not make Alembic prime the speaker or subject.'
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
    lines.push(
      '📣 Codex must immediately shout a short knowledge receipt before any further tool call, code reading, edit, Guard check, or final summary. Speak as Codex or I, not as Alembic prime: summarize the accepted constraints, patterns, and guardrails; keep evidenceRefs in the payload for later verification instead of listing paths by default.'
    );
  } else {
    lines.push('No matching recipes found.');
    lines.push(
      '📣 Codex must immediately shout in the first person that it did not receive usable project knowledge before any further tool call, code reading, edit, Guard check, or final summary. Do not make Alembic prime the speaker or subject.'
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
      searchMeta: searchResult?.searchMeta ?? null,
      intentEpisode,
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

  return {
    status,
    receiptId,
    intent,
    acceptedKnowledge,
    acceptedGuards,
    shoutInstruction: _buildPrimeShoutInstruction(status),
    hostResponse: _buildPrimeHostResponseInstruction(status, receiptId),
    nextActions: _buildPrimeKnowledgeNextActions(),
    intentEpisode: input.intentEpisode,
  };
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

function _buildPrimeShoutInstruction(status: PrimeKnowledgeMaterialStatus): string {
  if (status === 'delivered') {
    return [
      'Immediately after this prime tool result, before any further tool call, code reading, edit, Guard check, or final summary, shout a short, active knowledge receipt to the developer in your own words.',
      'Use Codex/first-person as the speaker: say what I accepted or what Codex received; do not make "Alembic prime", prime, or any tool/process the grammatical subject of the visible receipt.',
      'Make it feel like a real shout: lead with the accepted Recipe and Guard constraints, name the useful patterns or guardrails, and say how they will shape your next judgment.',
      'Use trigger, actionHint, title, and summary to make the shout readable; do not list evidenceRefs paths or line numbers by default, and do not call out missing line numbers.',
      'Keep evidenceRefs for your later code reading, verification, or user-requested citations.',
      'Then continue the user task based on the accepted knowledge.',
    ].join(' ');
  }
  if (status === 'empty') {
    return [
      'Immediately after this prime tool result, before any further tool call, code reading, edit, Guard check, or final summary, shout a clear receipt in the first person that I did not receive matching Recipe or Guard knowledge for this request.',
      'Do not make "Alembic prime", prime, or any tool/process the grammatical subject of the visible receipt.',
      'Do not claim project-specific knowledge was accepted.',
      'Then continue with normal code reading and verification.',
    ].join(' ');
  }
  return [
    'Immediately after this prime tool result, before any further tool call, code reading, edit, Guard check, or final summary, shout a clear receipt in the first person that I did not receive usable project knowledge because prime degraded.',
    'Do not make "Alembic prime", prime, or any tool/process the grammatical subject of the visible receipt.',
    'Do not pretend Recipe or Guard knowledge was accepted.',
    'Continue only with explicit code reading and verification.',
  ].join(' ');
}

function _buildPrimeHostResponseInstruction(
  status: PrimeKnowledgeMaterialStatus,
  receiptId: string
): PrimeHostResponseInstruction {
  // hostResponse 是给 Codex 宿主的可见回复动作，不是 MCP 工具调用，避免误触发不存在的 codex_host_response tool。
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
        ? `As Codex, tell the developer which Recipe/Guard knowledge you accepted before acting on it; do not make Alembic prime the recipient or speaker. ${_primeReceiptOrder}`
        : `As Codex, tell the developer whether you received no knowledge or degraded knowledge before continuing; do not make Alembic prime the recipient or speaker. ${_primeReceiptOrder}`,
  };
}

function _buildPrimeKnowledgeNextActions(): PrimeKnowledgeMaterial['nextActions'] {
  return [
    {
      tool: 'alembic_task',
      args: {
        operation: 'create',
        title: '<short task title>',
      },
      required: false,
      reason:
        'For non-trivial implementation work, create a task anchor after the prime knowledge receipt shout.',
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
  lines.push(
    '⚠️ REQUIRED: You MUST call alembic_guard (no args) NOW to review changed files for compliance violations.'
  );

  return envelope({
    success: true,
    data: {
      closed: { id, reason, closedAt: Date.now() },
      nextAction: {
        tool: 'alembic_guard',
        args: {},
        required: true,
        reason: 'Post-close compliance review — check diff for violations before moving on.',
      },
    },
    message: lines.join('\n'),
    meta: { tool: 'alembic_task' },
  });
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

  const decisionId = `dec-${Date.now().toString(36)}`;
  const decision: DecisionRecord = {
    id: decisionId,
    title: args.title,
    description: args.description,
    rationale: args.rationale,
    tags: args.tags,
    recordedAt: Date.now(),
  };

  // Push to current intent's decisions
  const intent = ctx.session?.intent;
  if (intent && intent.phase === 'active') {
    intent.decisions.push(decision);
  }

  return envelope({
    success: true,
    data: { decision: { id: decisionId, title: args.title } },
    message: `📌 Decision recorded: ${args.title}`,
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

  const client = _getResidentServiceClient(ctx.container);
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
  const client = _getResidentServiceClient(ctx.container);
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

function _getResidentServiceClient(
  container: McpServiceContainer
): AlembicResidentServiceClient | null {
  try {
    return container.get('residentServiceClient') as AlembicResidentServiceClient | null;
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
    options?: { hostIntentFrame?: HostIntentFrame }
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
