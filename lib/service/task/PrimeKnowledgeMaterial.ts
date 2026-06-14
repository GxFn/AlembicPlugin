import type {
  ResidentIntentEvidenceSummary,
  ResidentPrimeInjectionPackageSummary,
  ResidentPrimeRetrievalConsumerSummary,
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

export interface PrimeKnowledgeMaterialDegradedReason {
  code: 'low-information-intent' | 'search-degraded';
  message: string;
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
  degradedReason?: PrimeKnowledgeMaterialDegradedReason;
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
  retrievalConsumer?: ResidentPrimeRetrievalConsumerSummary;
}

interface PrimeKnowledgeMaterialInput {
  extracted: ExtractedIntent;
  hostIntentFrame: HostIntentFrame;
  hostIntentInput: NormalizedHostIntentInput;
  intentEpisode: PrimeIntentEpisodeMaterial;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  sourceRefs?: string[];
  taskAnchorDecision: TaskAnchorDecision;
}

interface PrimeTrustPostureInput {
  acceptedGuards: AcceptedPrimeGuard[];
  acceptedKnowledge: AcceptedPrimeKnowledge[];
  degradedReason?: PrimeKnowledgeMaterialDegradedReason;
  intent: PrimeKnowledgeMaterial['intent'];
  searchResult: PrimeSearchResult | null;
  status: PrimeKnowledgeMaterialStatus;
}

let primeReceiptCounter = 0;

const PRIME_RECEIPT_ORDER =
  'This receipt must be the next developer-visible response after the prime tool result, before any further tool call, code reading, edit, Guard check, or final summary.';

const LOW_INFORMATION_PRIME_TERMS = new Set([
  'begin',
  'do',
  'help',
  'here',
  'how',
  'i',
  'me',
  'next',
  'now',
  'please',
  'should',
  'start',
  'started',
  'steps',
  'where',
  'what',
]);

const LOW_INFORMATION_PRIME_QUERY_PATTERNS = [
  /^\s*where\s+do\s+i\s+start\s*[?.!]*\s*$/u,
  /^\s*(how|where)\s+(should\s+i\s+)?(start|begin|get\s+started)\s*[?.!]*\s*$/u,
  /^\s*(what\s+now|next\s+steps?|help)\s*[?.!]*\s*$/u,
  /^\s*(从哪里|哪里|怎么|如何)(开始|下手|继续)\s*[?？。!！]*\s*$/u,
];

export function buildPrimeKnowledgeMaterial(
  input: PrimeKnowledgeMaterialInput
): PrimeKnowledgeMaterial {
  const searchDegraded = input.searchDegraded || isPrimeSearchResultDegraded(input.searchResult);
  const trustedMaterialGate = assessPrimeTrustedMaterialGate(input);
  const trustedMaterialBlocked = !searchDegraded && trustedMaterialGate.blockTrustedMaterial;
  const effectiveDegraded = searchDegraded || trustedMaterialBlocked;
  const relatedKnowledge = effectiveDegraded ? [] : (input.searchResult?.relatedKnowledge ?? []);
  const guardRules = effectiveDegraded ? [] : (input.searchResult?.guardRules ?? []);
  const acceptedKnowledge = relatedKnowledge.map(projectAcceptedKnowledge);
  const acceptedGuards = guardRules.map(projectAcceptedGuard);
  const hasDeliveredKnowledge = acceptedKnowledge.length > 0 || acceptedGuards.length > 0;
  const status: PrimeKnowledgeMaterialStatus = effectiveDegraded
    ? 'degraded'
    : hasDeliveredKnowledge
      ? 'delivered'
      : 'empty';
  const degradedReason: PrimeKnowledgeMaterialDegradedReason | undefined = searchDegraded
    ? {
        code: 'search-degraded',
        message:
          'Prime search degraded before accepted Recipe or Guard material could be selected.',
      }
    : trustedMaterialGate.degradedReason;
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
    degradedReason,
    intent,
    searchResult: input.searchResult,
    status,
  });

  return {
    status,
    ...(degradedReason ? { degradedReason } : {}),
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
    ...(input.searchResult?.searchMeta.retrievalConsumer
      ? { retrievalConsumer: input.searchResult.searchMeta.retrievalConsumer }
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

function assessPrimeTrustedMaterialGate(input: PrimeKnowledgeMaterialInput): {
  blockTrustedMaterial: boolean;
  degradedReason?: PrimeKnowledgeMaterialDegradedReason;
} {
  if (!hasLowInformationPrimeIntent(input) || hasPrimeCallerContext(input)) {
    return { blockTrustedMaterial: false };
  }
  return {
    blockTrustedMaterial: true,
    degradedReason: {
      code: 'low-information-intent',
      message:
        'Prime withheld retrieved Recipe and Guard candidates because the request lacked activeFile, sourceRefs, keywords, module, or concrete host intent anchors.',
    },
  };
}

function hasLowInformationPrimeIntent(input: PrimeKnowledgeMaterialInput): boolean {
  const queryText = [
    input.hostIntentInput.userQuery,
    input.hostIntentFrame.recognizedIntentDraft.query,
    input.extracted.raw.userQuery,
    ...input.extracted.queries,
  ]
    .join(' ')
    .toLowerCase()
    .trim();
  if (!queryText) {
    return true;
  }
  if (LOW_INFORMATION_PRIME_QUERY_PATTERNS.some((pattern) => pattern.test(queryText))) {
    return true;
  }
  const terms = queryText.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const meaningfulTerms = terms.filter(
    (term) => term.length >= 2 && !LOW_INFORMATION_PRIME_TERMS.has(term)
  );
  return meaningfulTerms.length === 0 && queryText.length <= 100;
}

function hasPrimeCallerContext(input: PrimeKnowledgeMaterialInput): boolean {
  const declared = input.hostIntentFrame.hostDeclaredIntent;
  return Boolean(
    input.hostIntentInput.activeFile ||
      input.hostIntentFrame.extracted.module ||
      input.extracted.module ||
      declared?.module ||
      (declared?.keywords?.length ?? 0) > 0 ||
      (declared?.labels?.length ?? 0) > 0 ||
      (declared?.sourceRefs?.length ?? 0) > 0 ||
      input.hostIntentFrame.recognizedIntentDraft.sourceRefs.length > 0 ||
      (input.sourceRefs?.length ?? 0) > 0
  );
}

function buildPrimeTrustPosture(input: PrimeTrustPostureInput): PrimeTrustPosture {
  const primePackage = input.searchResult?.searchMeta.primeInjectionPackage;
  const packageStatus = primePackage?.injection.status;
  const packageNeedsVerification = isPrimePackageVerificationStatus(packageStatus);
  const packageUnavailable = isPrimePackageUnavailableStatus(packageStatus);

  return {
    status: input.status,
    receiptChecklist: [
      buildPrimeTrustChecklistLayer('trusted-to-obey', buildTrustedToObey(input.acceptedGuards)),
      buildPrimeTrustChecklistLayer(
        'trusted-to-use',
        buildTrustedToUse(input, packageNeedsVerification, packageUnavailable)
      ),
      buildPrimeTrustChecklistLayer('context-only', buildPrimeContextOnlyItems(input)),
      buildPrimeTrustChecklistLayer(
        'requires-verification',
        buildRequiresVerificationItems(input, packageNeedsVerification)
      ),
      buildPrimeTrustChecklistLayer(
        'not-available-or-degraded',
        buildNotAvailableOrDegradedItems(input, packageUnavailable)
      ),
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

function buildTrustedToObey(acceptedGuards: AcceptedPrimeGuard[]): PrimeTrustPostureItem[] {
  return acceptedGuards.map((guard) => ({
    id: `guard:${guard.id}`,
    title: guard.trigger || guard.title,
    source: 'accepted-guard',
    reason: 'Follow this Guard or rule as an accepted constraint before acting.',
    evidenceRefs: guard.evidenceRefs,
  }));
}

function buildTrustedToUse(
  input: PrimeTrustPostureInput,
  packageNeedsVerification: boolean,
  packageUnavailable: boolean
): PrimeTrustPostureItem[] {
  if (input.status !== 'delivered' || packageNeedsVerification || packageUnavailable) {
    return [];
  }
  const trustedToUse: PrimeTrustPostureItem[] = input.acceptedKnowledge.map((item) => ({
    id: `knowledge:${item.id}`,
    title: item.trigger || item.title,
    source: 'accepted-knowledge',
    reason:
      'Use this Recipe or pattern as project knowledge while preserving its evidence for later checks.',
    evidenceRefs: item.evidenceRefs,
  }));
  const primePackage = input.searchResult?.searchMeta.primeInjectionPackage;
  if (primePackage?.injection.status !== 'ready') {
    return trustedToUse;
  }
  const acceptedKnowledgeIds = new Set(input.acceptedKnowledge.map((item) => item.id));
  for (const item of primePackage.selectedKnowledge ?? []) {
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
      status: recordString(item, 'injectionStatus') ?? primePackage.injection.status,
      evidenceRefs: extractEvidenceRefs(recordStringArray(item.sourceRefs)),
    });
  }
  return trustedToUse;
}

function buildPrimeContextOnlyItems(input: PrimeTrustPostureInput): PrimeTrustPostureItem[] {
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
  const intentEvidence = input.searchResult?.searchMeta.intentEvidence;
  if (intentEvidence) {
    contextOnly.push({
      id: 'resident-intent-evidence',
      title: 'Resident intent evidence summary',
      source: 'intent-evidence',
      reason:
        'Use ranking, relation, and anchor evidence as context for why material was selected, not as a rule to obey.',
      status: intentEvidence.degraded ? 'degraded' : 'available',
    });
  }
  return contextOnly;
}

function buildRequiresVerificationItems(
  input: PrimeTrustPostureInput,
  packageNeedsVerification: boolean
): PrimeTrustPostureItem[] {
  return [
    ...acceptedMaterialVerificationItems(input),
    ...primePackageVerificationItems(input, packageNeedsVerification),
    ...degradedSearchCandidateItems(input),
  ];
}

function acceptedMaterialVerificationItems(input: PrimeTrustPostureInput): PrimeTrustPostureItem[] {
  const acceptedEvidenceRefs = uniquePrimeEvidenceRefs(
    [...input.acceptedKnowledge, ...input.acceptedGuards].flatMap((item) => item.evidenceRefs)
  );
  return acceptedEvidenceRefs.length > 0
    ? [
        {
          id: 'accepted-material-evidence',
          title: 'Accepted material evidenceRefs',
          source: 'evidence-ref',
          reason:
            'Keep evidenceRefs as verification inputs for later code reading or user-requested citations; do not dump paths in the receipt by default.',
          evidenceRefs: acceptedEvidenceRefs,
        },
      ]
    : [];
}

function primePackageVerificationItems(
  input: PrimeTrustPostureInput,
  packageNeedsVerification: boolean
): PrimeTrustPostureItem[] {
  const primePackage = input.searchResult?.searchMeta.primeInjectionPackage;
  const packageStatus = primePackage?.injection.status;
  const packageTraceRefs = extractEvidenceRefs(primePackage?.trace.sourceRefs ?? []);
  const items: PrimeTrustPostureItem[] =
    packageTraceRefs.length > 0
      ? [
          {
            id: 'prime-package-source-refs',
            title: 'Prime package sourceRefs',
            source: 'prime-injection-package',
            reason:
              'Treat sourceRefs from the injection package as verification anchors, not as automatically verified facts.',
            evidenceRefs: packageTraceRefs,
            status: packageStatus,
          },
        ]
      : [];
  if (packageNeedsVerification) {
    items.push({
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
    if (injectionStatus === 'candidate') {
      items.push(candidateKnowledgeVerificationItem(item));
    }
  }
  return items;
}

function candidateKnowledgeVerificationItem(item: Record<string, unknown>): PrimeTrustPostureItem {
  const itemId = recordString(item, 'itemId') ?? 'unknown';
  return {
    id: `candidate-knowledge:${itemId}`,
    title: recordString(item, 'trigger') ?? recordString(item, 'title') ?? itemId,
    source: 'prime-injection-package',
    reason:
      'This selectedKnowledge item is only a candidate and must be presented as requiring verification.',
    status: 'candidate',
    evidenceRefs: extractEvidenceRefs(recordStringArray(item.sourceRefs)),
  };
}

function degradedSearchCandidateItems(input: PrimeTrustPostureInput): PrimeTrustPostureItem[] {
  if (input.status !== 'degraded') {
    return [];
  }
  return (input.searchResult?.relatedKnowledge.slice(0, 3) ?? []).map((item) => ({
    id: `weak-search-candidate:${item.id}`,
    title: item.trigger || item.title,
    source: 'accepted-knowledge',
    reason:
      'Prime search was degraded, so this candidate is only a weak retrieval hint and must not be used as trusted project knowledge.',
    status: 'degraded',
    evidenceRefs: extractEvidenceRefs(item.sourceRefs),
  }));
}

function buildNotAvailableOrDegradedItems(
  input: PrimeTrustPostureInput,
  packageUnavailable: boolean
): PrimeTrustPostureItem[] {
  const items: PrimeTrustPostureItem[] = [];
  if (input.status === 'empty' || input.status === 'degraded') {
    items.push({
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
    if (input.degradedReason) {
      items.push({
        id: `prime-degraded:${input.degradedReason.code}`,
        title: `Prime degraded: ${input.degradedReason.code}`,
        source: 'prime-status',
        reason: input.degradedReason.message,
        status: input.degradedReason.code,
      });
    }
  }
  const packageStatus = input.searchResult?.searchMeta.primeInjectionPackage?.injection.status;
  if (packageUnavailable) {
    items.push({
      id: `prime-package-unavailable:${packageStatus}`,
      title: `Prime injection package status: ${packageStatus}`,
      source: 'prime-injection-package',
      reason:
        'The resident injection package did not provide trusted project knowledge for the receipt.',
      status: packageStatus,
    });
  }
  return items;
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

function isPrimeSearchResultDegraded(searchResult: PrimeSearchResult | null): boolean {
  if (!searchResult) {
    return false;
  }
  const retrievalConsumer = searchResult.searchMeta.retrievalConsumer;
  if (retrievalConsumer && retrievalConsumer.producerContract.available === false) {
    return true;
  }
  const packageStatus = searchResult.searchMeta.primeInjectionPackage?.injection.status;
  return isPrimePackageUnavailableStatus(packageStatus);
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
          inputSource: 'host-declared-intent',
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
        inputSource: 'host-declared-intent',
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
