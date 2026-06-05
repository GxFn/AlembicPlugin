import type {
  ResidentIntentEvidenceSummary,
  ResidentPrimeInjectionPackageSummary,
} from '#service/resident/AlembicResidentServiceClient.js';
import type { HostIntentFrame, NormalizedHostIntentInput } from '#service/task/HostIntentFrame.js';
import type { ExtractedIntent } from '#service/task/IntentExtractor.js';
import type { PrimeSearchResult, SlimSearchResult } from '#service/task/PrimeSearchPipeline.js';
import type { TaskAnchorDecision } from '#service/task/TaskLifecyclePolicy.js';

export type PrimeKnowledgeMaterialStatus = 'delivered' | 'empty' | 'degraded';
export type PrimeTrustLayer =
  | 'trusted-to-obey'
  | 'trusted-to-use'
  | 'context-only'
  | 'requires-verification'
  | 'not-available-or-degraded';

export interface PrimeEvidenceRef {
  path: string;
  line: number | null;
}

export interface AcceptedPrimeKnowledge {
  id: string;
  kind: string;
  title: string;
  trigger: string;
  actionHint?: string;
  summary: string;
  score: number;
  evidenceRefs: PrimeEvidenceRef[];
}

export interface AcceptedPrimeGuard {
  id: string;
  title: string;
  trigger: string;
  actionHint?: string;
  score: number;
  evidenceRefs: PrimeEvidenceRef[];
}

export interface PrimeHostResponseInstruction {
  action: 'shout_prime_knowledge_receipt';
  receiptId: string;
  status: PrimeKnowledgeMaterialStatus;
  timing: 'immediate_after_prime';
  required: true;
  requiredBeforeNextAction: true;
  visibility: 'developer_visible';
  reason: string;
}

export interface PrimeTrustPostureItem {
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

export interface PrimeReceiptChecklistLayer {
  layer: PrimeTrustLayer;
  label: string;
  summary: string;
  items: PrimeTrustPostureItem[];
  requiredInVisibleReceipt: boolean;
  visibleReceiptDirective: string;
}

export interface PrimeTrustPosture {
  status: PrimeKnowledgeMaterialStatus;
  receiptChecklist: PrimeReceiptChecklistLayer[];
  antiEmptyReceipt: {
    required: true;
    forbiddenGenericReceipts: string[];
    instruction: string;
  };
}

export interface PrimeIntentEpisodeRecordSummary {
  episodeId: string;
  query?: string;
  sessionKey: string | null;
  sourceRefs: string[];
  status: string;
}

export interface ResidentCallSummary {
  ok: boolean;
  owner?: string;
  reason?: string;
  retryable?: boolean;
  route?: string;
}

export interface PrimeIntentEpisodeMaterial {
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

export interface PrimeKnowledgeMaterial {
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

interface PrimeKnowledgeMaterialInput {
  extracted: ExtractedIntent;
  hostIntentFrame: HostIntentFrame;
  hostIntentInput: NormalizedHostIntentInput;
  intentEpisode: PrimeIntentEpisodeMaterial;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  taskAnchorDecision: TaskAnchorDecision;
}

let primeReceiptCounter = 0;

const PRIME_RECEIPT_ORDER =
  'This receipt must be the next developer-visible response after the prime tool result, before any further tool call, code reading, edit, Guard check, or final summary.';

export function buildPrimeKnowledgeMaterial(
  input: PrimeKnowledgeMaterialInput
): PrimeKnowledgeMaterial {
  const relatedKnowledge = input.searchResult?.relatedKnowledge ?? [];
  const guardRules = input.searchResult?.guardRules ?? [];
  const acceptedKnowledge = relatedKnowledge.map(projectAcceptedKnowledge);
  const acceptedGuards = guardRules.map(projectAcceptedGuard);
  const hasDeliveredKnowledge = acceptedKnowledge.length > 0 || acceptedGuards.length > 0;
  const status: PrimeKnowledgeMaterialStatus = input.searchDegraded
    ? 'degraded'
    : hasDeliveredKnowledge
      ? 'delivered'
      : 'empty';
  const receiptId = generatePrimeReceiptId();
  const intent: PrimeKnowledgeMaterial['intent'] = {
    userQuery: input.hostIntentInput.userQuery,
    scenario: input.searchResult?.searchMeta.scenario ?? input.extracted.scenario,
    queries: input.searchResult?.searchMeta.queries ?? input.extracted.queries,
    hostIntentFrame: input.hostIntentFrame,
  };
  if (input.hostIntentInput.activeFile) {
    intent.activeFile = redactVisiblePath(input.hostIntentInput.activeFile);
  }
  const language = input.searchResult?.searchMeta.language ?? input.extracted.language;
  if (language) {
    intent.language = language;
  }
  const moduleName = input.searchResult?.searchMeta.module ?? input.extracted.module;
  if (moduleName) {
    intent.module = moduleName;
  }
  const trustPosture = buildPrimeTrustPosture({
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
    shoutInstruction: buildPrimeShoutInstruction(status, trustPosture),
    hostResponse: buildPrimeHostResponseInstruction(status, receiptId, trustPosture),
    nextActions: buildPrimeKnowledgeNextActions(input.taskAnchorDecision),
    intentEpisode: input.intentEpisode,
    ...(input.searchResult?.searchMeta.intentEvidence
      ? { intentEvidence: input.searchResult.searchMeta.intentEvidence }
      : {}),
    ...(input.searchResult?.searchMeta.primeInjectionPackage
      ? { primeInjectionPackage: input.searchResult.searchMeta.primeInjectionPackage }
      : {}),
  };
}

export function formatPrimeTrustPostureMessage(posture: PrimeTrustPosture): string {
  const counts = posture.receiptChecklist
    .map((entry) => `${entry.layer}=${entry.items.length}`)
    .join(', ');
  return `Trust posture checklist: ${counts}. A visible receipt must name the obey/use/context/verify/degraded boundaries and cannot be a generic received-knowledge slogan.`;
}

export function createUnavailablePrimeIntentEpisodeMaterial(
  reason: string,
  sessionSource: PrimeIntentEpisodeMaterial['sessionSource'] = 'mcp-session'
): PrimeIntentEpisodeMaterial {
  return {
    available: false,
    current: null,
    degraded: true,
    latest: null,
    recent: [],
    read: {
      latest: { ok: false, reason },
      recent: { ok: false, reason },
    },
    reason,
    requestFields: [],
    sessionSource,
    start: { ok: false, reason },
  };
}

function generatePrimeReceiptId(): string {
  primeReceiptCounter++;
  return `prime-${Date.now().toString(36)}-${primeReceiptCounter}`;
}

function buildPrimeTrustPosture(input: {
  acceptedGuards: AcceptedPrimeGuard[];
  acceptedKnowledge: AcceptedPrimeKnowledge[];
  intent: PrimeKnowledgeMaterial['intent'];
  searchResult: PrimeSearchResult | null;
  status: PrimeKnowledgeMaterialStatus;
}): PrimeTrustPosture {
  const primePackage = input.searchResult?.searchMeta.primeInjectionPackage;
  const packageStatus = primePackage?.injection.status;
  const packageNeedsVerification = isPrimePackageVerificationStatus(packageStatus);
  const packageUnavailable = isPrimePackageUnavailableStatus(packageStatus);
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
      const itemId = recordString(item, 'itemId');
      if (!itemId || acceptedKnowledgeIds.has(itemId)) {
        continue;
      }
      trustedToUse.push({
        id: `prime-package-selected:${itemId}`,
        title: recordString(item, 'trigger') ?? recordString(item, 'title') ?? itemId,
        source: 'prime-injection-package',
        reason:
          'Use this resident-selected knowledge because the prime injection package marked it ready.',
        status: recordString(item, 'injectionStatus') ?? packageStatus,
        evidenceRefs: extractEvidenceRefs(recordStringArray(item.sourceRefs)),
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
  const acceptedEvidenceRefs = uniquePrimeEvidenceRefs(
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
  const packageTraceRefs = extractEvidenceRefs(primePackage?.trace.sourceRefs ?? []);
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
    const injectionStatus = recordString(item, 'injectionStatus');
    if (injectionStatus !== 'candidate') {
      continue;
    }
    const itemId = recordString(item, 'itemId') ?? 'unknown';
    requiresVerification.push({
      id: `candidate-knowledge:${itemId}`,
      title: recordString(item, 'trigger') ?? recordString(item, 'title') ?? itemId,
      source: 'prime-injection-package',
      reason:
        'This selectedKnowledge item is only a candidate and must be presented as requiring verification.',
      status: injectionStatus,
      evidenceRefs: extractEvidenceRefs(recordStringArray(item.sourceRefs)),
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
      buildPrimeTrustChecklistLayer('trusted-to-obey', trustedToObey),
      buildPrimeTrustChecklistLayer('trusted-to-use', trustedToUse),
      buildPrimeTrustChecklistLayer('context-only', contextOnly),
      buildPrimeTrustChecklistLayer('requires-verification', requiresVerification),
      buildPrimeTrustChecklistLayer('not-available-or-degraded', notAvailableOrDegraded),
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

function buildPrimeTrustChecklistLayer(
  layer: PrimeTrustLayer,
  items: PrimeTrustPostureItem[]
): PrimeReceiptChecklistLayer {
  return {
    layer,
    label: primeTrustLayerLabel(layer),
    summary: items.length > 0 ? `${items.length} item(s) require receipt handling.` : 'No items.',
    items,
    requiredInVisibleReceipt: items.length > 0,
    visibleReceiptDirective: primeTrustLayerDirective(layer),
  };
}

function primeTrustLayerLabel(layer: PrimeTrustLayer): string {
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

function primeTrustLayerDirective(layer: PrimeTrustLayer): string {
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

function isPrimePackageVerificationStatus(status: string | undefined): boolean {
  return status === 'candidate' || status === 'needs-confirmation';
}

function isPrimePackageUnavailableStatus(status: string | undefined): boolean {
  return status === 'degraded' || status === 'empty';
}

function recordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function uniquePrimeEvidenceRefs(refs: PrimeEvidenceRef[]): PrimeEvidenceRef[] {
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

function projectAcceptedKnowledge(item: SlimSearchResult): AcceptedPrimeKnowledge {
  return {
    id: item.id,
    kind: item.kind || 'pattern',
    title: item.title,
    trigger: item.trigger,
    ...(item.actionHint ? { actionHint: item.actionHint } : {}),
    summary: summarizePrimeItem(item),
    score: item.score,
    evidenceRefs: extractEvidenceRefs(item.sourceRefs),
  };
}

function projectAcceptedGuard(item: SlimSearchResult): AcceptedPrimeGuard {
  return {
    id: item.id,
    title: item.title,
    trigger: item.trigger,
    ...(item.actionHint ? { actionHint: item.actionHint } : {}),
    score: item.score,
    evidenceRefs: extractEvidenceRefs(item.sourceRefs),
  };
}

function summarizePrimeItem(item: SlimSearchResult): string {
  return item.description || item.actionHint || item.trigger || item.title;
}

function extractEvidenceRefs(sourceRefs?: string[]): PrimeEvidenceRef[] {
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
    const evidence = parseEvidenceRef(ref);
    const key = `${evidence.path}\0${evidence.line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    refs.push(evidence);
    seen.add(key);
  }
  return refs;
}

function parseEvidenceRef(ref: string): PrimeEvidenceRef {
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

function buildPrimeShoutInstruction(
  status: PrimeKnowledgeMaterialStatus,
  trustPosture: PrimeTrustPosture
): string {
  const trustChecklist = formatPrimeTrustPostureMessage(trustPosture);
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

function buildPrimeHostResponseInstruction(
  status: PrimeKnowledgeMaterialStatus,
  receiptId: string,
  trustPosture: PrimeTrustPosture
): PrimeHostResponseInstruction {
  const trustChecklist = formatPrimeTrustPostureMessage(trustPosture);
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
        ? `As Codex, tell the developer the prime trust posture before acting: trusted-to-obey Guard constraints, trusted-to-use Recipe or pattern knowledge, context-only host intent or evidence hints, and requires-verification source refs or candidates. ${trustChecklist} do not make Alembic prime the recipient or speaker. ${PRIME_RECEIPT_ORDER}`
        : `As Codex, tell the developer the prime trust posture is not-available-or-degraded before continuing; do not claim trusted-to-obey or trusted-to-use project knowledge. ${trustChecklist} do not make Alembic prime the recipient or speaker. ${PRIME_RECEIPT_ORDER}`,
  };
}

function buildPrimeKnowledgeNextActions(
  taskAnchorDecision: TaskAnchorDecision
): PrimeKnowledgeMaterial['nextActions'] {
  if (taskAnchorDecision.action === 'skip') {
    return [
      {
        tool: 'alembic_work_start',
        args: {
          inputSource: 'legacy-compatibility',
          title: '<short task title>',
        },
        required: false,
        skipped: true,
        reason: `Work anchor skipped by Codex-aware lifecycle policy: ${taskAnchorDecision.reasonCode}.`,
        taskAnchorDecision,
      },
    ];
  }
  return [
    {
      tool: 'alembic_work_start',
      args: {
        inputSource: 'legacy-compatibility',
        title: '<short task title>',
      },
      required: false,
      reason: `Create a workRef after the prime knowledge receipt only for real implementation work (${taskAnchorDecision.reasonCode}).`,
      taskAnchorDecision,
    },
  ];
}

function redactVisiblePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return `[absolute-path]/${parts[parts.length - 1] ?? 'file'}`;
  }
  if (parts.length <= 3) {
    return normalized;
  }
  return parts.slice(-3).join('/');
}
