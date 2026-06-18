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

export interface PrimeUsefulSlice {
  evidenceRefs: PrimeEvidenceRef[];
  regionClass?: string;
  score?: number;
  sourceRefsBridge?: string;
  text: string;
}

export interface PrimeAcceptedKnowledgeTrustEvidence {
  kind: 'recipe-locator' | 'recipe-semantic-region';
  source: 'prime-injection-package';
  summary: string;
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
  matchedRegionClasses: string[];
  trustEvidence: PrimeAcceptedKnowledgeTrustEvidence;
  usefulSlices: PrimeUsefulSlice[];
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
  code: 'low-information-intent' | 'search-degraded' | 'trusted-material-evidence-missing';
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
  const rawRelatedKnowledge = input.searchResult?.relatedKnowledge ?? [];
  const rawGuardRules = input.searchResult?.guardRules ?? [];
  const selectedKnowledgeByItemId = buildSelectedKnowledgeByItemId(input.searchResult);
  const trustedKnowledgeCandidates = [
    ...rawRelatedKnowledge.map((item) => ({
      item,
      selectedKnowledge: findSelectedKnowledgeForItem(selectedKnowledgeByItemId, item),
    })),
    ...buildSelectedKnowledgeOnlyCandidates(input.searchResult, rawRelatedKnowledge),
  ];
  const trustedKnowledge = trustedKnowledgeCandidates.flatMap(({ item, selectedKnowledge }) =>
    hasTrustedRecipeEvidence(item, selectedKnowledge)
      ? [projectAcceptedKnowledge(item, selectedKnowledge)]
      : []
  );
  const trustedMaterialGate = assessPrimeTrustedMaterialGate(input, {
    guardRuleCount: rawGuardRules.length,
    trustedKnowledgeCount: trustedKnowledge.length,
  });
  const trustedMaterialBlocked = !searchDegraded && trustedMaterialGate.blockTrustedMaterial;
  const effectiveDegraded = searchDegraded || trustedMaterialBlocked;
  const guardRules = effectiveDegraded ? [] : rawGuardRules;
  const acceptedKnowledge = effectiveDegraded ? [] : trustedKnowledge;
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

function assessPrimeTrustedMaterialGate(
  input: PrimeKnowledgeMaterialInput,
  trustedMaterial: {
    guardRuleCount: number;
    trustedKnowledgeCount: number;
  }
): {
  blockTrustedMaterial: boolean;
  degradedReason?: PrimeKnowledgeMaterialDegradedReason;
} {
  if (hasLowInformationPrimeIntent(input) && !hasPrimeCallerContext(input)) {
    return {
      blockTrustedMaterial: true,
      degradedReason: {
        code: 'low-information-intent',
        message:
          'Prime withheld retrieved Recipe and Guard candidates because the request lacked a direct code-development requirement frame with task action, requirement goal, and locator facets.',
      },
    };
  }
  const hasKnowledgeCandidates =
    (input.searchResult?.relatedKnowledge.length ?? 0) > 0 ||
    countPrimeSelectedKnowledge(input.searchResult) > 0;
  const hasTrustedMaterial =
    trustedMaterial.trustedKnowledgeCount > 0 || trustedMaterial.guardRuleCount > 0;
  if (hasKnowledgeCandidates && !hasTrustedMaterial) {
    return {
      blockTrustedMaterial: true,
      degradedReason: {
        code: 'trusted-material-evidence-missing',
        message: buildTrustedMaterialEvidenceMissingMessage(input.searchResult),
      },
    };
  }
  return { blockTrustedMaterial: false };
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
  const hasDirectRequirementFrame = Boolean(
    declared?.action?.trim() &&
      (declared?.goal?.trim() || declared?.query?.trim()) &&
      ((declared?.keywords?.length ?? 0) > 0 ||
        (declared?.labels?.length ?? 0) > 0 ||
        declared?.scenario?.trim() ||
        declared?.module?.trim())
  );
  return hasDirectRequirementFrame;
}

function buildPrimeTrustPosture(input: PrimeTrustPostureInput): PrimeTrustPosture {
  const primePackage = input.searchResult?.searchMeta.primeInjectionPackage;
  const packageStatus = primePackage?.injection.status;
  const packageNeedsVerification = isPrimePackageVerificationStatus(packageStatus);
  const hasAcceptedMaterial = input.acceptedKnowledge.length > 0 || input.acceptedGuards.length > 0;
  const packageUnavailable = isPrimePackageUnavailableStatus(packageStatus) && !hasAcceptedMaterial;

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
    reason: `Use this Recipe or pattern as project knowledge; accepted through ${item.trustEvidence.summary}.`,
    evidenceRefs: item.evidenceRefs,
  }));
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
      continue;
    }
    if (!hasSelectedKnowledgeTrustEvidence(item)) {
      items.push(untrustedSelectedKnowledgeVerificationItem(item));
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

function untrustedSelectedKnowledgeVerificationItem(
  item: Record<string, unknown>
): PrimeTrustPostureItem {
  const itemId = recordString(item, 'itemId') ?? 'unknown';
  return {
    id: `selected-knowledge-untrusted:${itemId}`,
    title: recordString(item, 'trigger') ?? recordString(item, 'title') ?? itemId,
    source: 'prime-injection-package',
    reason:
      'This selectedKnowledge item lacks Recipe locator or semantic-region evidence, so it must remain a verification hint.',
    status: recordString(item, 'injectionStatus') ?? 'selected',
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
  if (!isPrimePackageUnavailableStatus(packageStatus)) {
    return false;
  }
  return !selectedKnowledgeRecords(searchResult).some(hasSelectedKnowledgeTrustEvidence);
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

function buildSelectedKnowledgeByItemId(
  searchResult: PrimeSearchResult | null
): Map<string, Record<string, unknown>> {
  const selectedById = new Map<string, Record<string, unknown>>();
  for (const item of searchResult?.searchMeta.primeInjectionPackage?.selectedKnowledge ?? []) {
    if (!isRecord(item)) {
      continue;
    }
    for (const itemId of selectedKnowledgeLookupKeys(item)) {
      const existing = selectedById.get(itemId);
      if (
        !existing ||
        (!hasSelectedKnowledgeTrustEvidence(existing) && hasSelectedKnowledgeTrustEvidence(item))
      ) {
        selectedById.set(itemId, item);
      }
    }
  }
  for (const item of residentRegionSelectedKnowledgeRecords(searchResult)) {
    for (const itemId of selectedKnowledgeLookupKeys(item)) {
      const existing = selectedById.get(itemId);
      if (!existing || !hasSelectedKnowledgeTrustEvidence(existing)) {
        selectedById.set(itemId, item);
      }
    }
  }
  return selectedById;
}

function selectedKnowledgeRecords(
  searchResult: PrimeSearchResult | null
): Record<string, unknown>[] {
  return [
    ...(searchResult?.searchMeta.primeInjectionPackage?.selectedKnowledge ?? []).filter(isRecord),
    ...residentRegionSelectedKnowledgeRecords(searchResult),
  ];
}

function residentRegionSelectedKnowledgeRecords(
  searchResult: PrimeSearchResult | null
): Record<string, unknown>[] {
  const regionRetrieval = searchResult?.searchMeta.primeInjectionPackage?.residentRegionRetrieval;
  if (!isRecord(regionRetrieval)) {
    return [];
  }
  if (recordString(regionRetrieval, 'route') !== 'resident-vector-recipe-semantic-region') {
    return [];
  }
  if (recordBoolean(regionRetrieval, 'used') === false) {
    return [];
  }
  return recordArray(regionRetrieval.selectedRecipes).flatMap(projectResidentRegionSelectedRecipe);
}

function projectResidentRegionSelectedRecipe(
  recipe: Record<string, unknown>
): Record<string, unknown>[] {
  const recipeId =
    recordString(recipe, 'recipeId') ??
    recordString(recipe, 'itemId') ??
    recordString(recipe, 'knowledgeId') ??
    recordString(recipe, 'id');
  const matchedRegionClasses = collectMatchedRegionClasses(recipe);
  if (!recipeId || matchedRegionClasses.length === 0) {
    return [];
  }
  const matchedRegions = recordArray(recipe.matchedRegions);
  const sourceRefs = uniqueStrings([
    ...recordStringArray(recipe.sourceRefs),
    ...matchedRegions.flatMap((region) => recordStringArray(region.sourceRefs)),
  ]);
  return [
    {
      evidenceRefs: [`residentRegionRetrieval:${recipeId}`],
      injectionStatus: 'selected',
      itemId: recipeId,
      kind: recordString(recipe, 'kind') ?? 'pattern',
      matchedRegionClasses,
      matchedRegions,
      recipeId,
      ...(recordNumber(recipe, 'score') !== undefined
        ? { score: recordNumber(recipe, 'score') }
        : {}),
      sourceRefs,
      ...(recordString(recipe, 'title') ? { title: recordString(recipe, 'title') } : {}),
      ...(recordString(recipe, 'trigger') ? { trigger: recordString(recipe, 'trigger') } : {}),
      whySelected: uniqueStrings([
        ...recordStringArray(recipe.whySelected),
        'resident-region-retrieval',
      ]),
    },
  ];
}

function buildSelectedKnowledgeOnlyCandidates(
  searchResult: PrimeSearchResult | null,
  relatedKnowledge: SlimSearchResult[]
): Array<{ item: SlimSearchResult; selectedKnowledge: Record<string, unknown> }> {
  if (!searchResult?.searchMeta.primeInjectionPackage) {
    return [];
  }
  const candidates: Array<{ item: SlimSearchResult; selectedKnowledge: Record<string, unknown> }> =
    [];
  const relatedKeys = new Set(relatedKnowledge.flatMap(slimSearchResultLookupKeys));
  for (const selectedKnowledge of selectedKnowledgeRecords(searchResult)) {
    if (!hasSelectedKnowledgeTrustEvidence(selectedKnowledge)) {
      continue;
    }
    if (selectedKnowledgeLookupKeys(selectedKnowledge).some((key) => relatedKeys.has(key))) {
      continue;
    }
    const item = projectSelectedKnowledgeSearchResult(selectedKnowledge);
    if (item) {
      candidates.push({ item, selectedKnowledge });
    }
  }
  return candidates;
}

function projectSelectedKnowledgeSearchResult(
  selectedKnowledge: Record<string, unknown>
): SlimSearchResult | null {
  const id = primarySelectedKnowledgeId(selectedKnowledge);
  if (!id) {
    return null;
  }
  const title =
    recordString(selectedKnowledge, 'title') ?? recordString(selectedKnowledge, 'trigger') ?? id;
  const trigger = recordString(selectedKnowledge, 'trigger') ?? title;
  const description =
    collectUsefulSlices(selectedKnowledge)[0]?.text ??
    recordString(selectedKnowledge, 'description') ??
    recordString(selectedKnowledge, 'summary') ??
    recordString(selectedKnowledge, 'actionHint') ??
    trigger;
  return {
    id,
    kind: recordString(selectedKnowledge, 'kind') ?? 'pattern',
    language: recordString(selectedKnowledge, 'language') ?? '',
    score: selectedKnowledgeScore(selectedKnowledge),
    title,
    trigger,
    description,
    ...(recordString(selectedKnowledge, 'actionHint')
      ? { actionHint: recordString(selectedKnowledge, 'actionHint') }
      : {}),
    sourceRefs: collectSelectedKnowledgeSourceRefs(selectedKnowledge),
  };
}

function primarySelectedKnowledgeId(selectedKnowledge: Record<string, unknown>): string | null {
  const regionRecipeIds = recordArray(selectedKnowledge.matchedRegions).flatMap((region) => [
    recordString(region, 'recipeId'),
    recordString(region, 'itemId'),
    recordString(region, 'knowledgeId'),
  ]);
  const preferred = [
    recordString(selectedKnowledge, 'itemId'),
    recordString(selectedKnowledge, 'id'),
    recordString(selectedKnowledge, 'recipeId'),
    recordString(selectedKnowledge, 'knowledgeId'),
    recordString(selectedKnowledge, 'entryId'),
    recordString(selectedKnowledge, 'ref'),
    ...regionRecipeIds,
  ];
  const expanded = expandKnowledgeLookupKeys(preferred);
  return (
    expanded.find((value) => !/^(knowledge|recipe|recipe-region|source-ref)[:/]/i.test(value)) ??
    expanded[0] ??
    null
  );
}

function selectedKnowledgeScore(selectedKnowledge: Record<string, unknown>): number {
  const direct = recordNumber(selectedKnowledge, 'score');
  if (direct !== undefined) {
    return direct;
  }
  const regionScores = recordArray(selectedKnowledge.matchedRegions)
    .map((region) => recordNumber(region, 'score'))
    .filter((score): score is number => score !== undefined);
  return regionScores.length > 0 ? Math.max(...regionScores) : 0;
}

function collectSelectedKnowledgeSourceRefs(selectedKnowledge: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...recordStringArray(selectedKnowledge.sourceRefs),
    ...recordArray(selectedKnowledge.matchedRegions).flatMap((region) =>
      recordStringArray(region.sourceRefs)
    ),
  ]);
}

function findSelectedKnowledgeForItem(
  selectedById: Map<string, Record<string, unknown>>,
  item: SlimSearchResult
): Record<string, unknown> | undefined {
  for (const itemId of slimSearchResultLookupKeys(item)) {
    const selected = selectedById.get(itemId);
    if (selected) {
      return selected;
    }
  }
  return undefined;
}

function selectedKnowledgeLookupKeys(item: Record<string, unknown>): string[] {
  const regionRecipeIds = recordArray(item.matchedRegions).flatMap((region) => [
    recordString(region, 'recipeId'),
    recordString(region, 'itemId'),
    recordString(region, 'knowledgeId'),
  ]);
  return expandKnowledgeLookupKeys([
    recordString(item, 'itemId'),
    recordString(item, 'id'),
    recordString(item, 'recipeId'),
    recordString(item, 'knowledgeId'),
    recordString(item, 'entryId'),
    recordString(item, 'ref'),
    ...regionRecipeIds,
  ]);
}

function slimSearchResultLookupKeys(item: SlimSearchResult): string[] {
  return expandKnowledgeLookupKeys([item.id, ...(item.sourceRefs ?? [])]);
}

function expandKnowledgeLookupKeys(values: Array<string | undefined>): string[] {
  const expanded: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    expanded.push(normalized);
    const prefixedMatch = /^(knowledge|recipe|recipe-region|source-ref)[:/](.+)$/i.exec(normalized);
    if (prefixedMatch?.[2]) {
      expanded.push(prefixedMatch[2]);
    }
    const evidenceRefMatch = /^knowledge[:/](.+?)(?::\d+)?$/i.exec(normalized);
    if (evidenceRefMatch?.[1]) {
      expanded.push(evidenceRefMatch[1]);
    }
  }
  return uniqueStrings(expanded);
}

function countPrimeSelectedKnowledge(searchResult: PrimeSearchResult | null): number {
  const injection = searchResult?.searchMeta.primeInjectionPackage?.injection;
  const declaredSelectedCount = isRecord(injection)
    ? recordNumber(injection, 'selectedCount')
    : undefined;
  return declaredSelectedCount ?? selectedKnowledgeRecords(searchResult).length;
}

function buildTrustedMaterialEvidenceMissingMessage(
  searchResult: PrimeSearchResult | null
): string {
  const selectedCount = countPrimeSelectedKnowledge(searchResult);
  const selectedRecords = selectedKnowledgeRecords(searchResult);
  if (selectedCount > 0 || selectedRecords.length > 0) {
    const missingFields =
      selectedRecords.length === 0
        ? ['selectedKnowledge[]']
        : selectedRecordsMissingTrustFields(selectedRecords);
    const missingSuffix =
      missingFields.length > 0
        ? ` Missing resident producer fields for Alembic/AlembicCore follow-up: ${missingFields.join(', ')}.`
        : ' The resident records had trust-looking fields, but Plugin projection could not turn them into accepted public material; check selectedKnowledge ids against relatedKnowledge ids.';
    return `Prime received resident selectedKnowledge selectedCount=${selectedCount} but withheld trusted material because selected entries lacked direct Recipe locator or semantic-region evidence.${missingSuffix} SourceRefs alone remain verification anchors, not trusted-to-use Recipe evidence.`;
  }
  return 'Prime withheld retrieved Recipe candidates because none carried direct Recipe locator or semantic-region evidence from the resident prime injection package.';
}

function selectedRecordsMissingTrustFields(records: Record<string, unknown>[]): string[] {
  const missing = new Set<string>();
  if (records.every((record) => selectedKnowledgeLookupKeys(record).length === 0)) {
    missing.add('selectedKnowledge[].itemId|recipeId|knowledgeId');
  }
  if (records.every((record) => collectMatchedRegionClasses(record).length === 0)) {
    missing.add('selectedKnowledge[].matchedRegionClasses|matchedRegions');
  }
  if (records.every((record) => !hasRecipeLocatorSignal(null, record))) {
    missing.add('selectedKnowledge[].evidenceRefs|whySelected recipe locator signal');
  }
  return [...missing];
}

function hasTrustedRecipeEvidence(
  item: SlimSearchResult,
  selectedKnowledge: Record<string, unknown> | undefined
): boolean {
  return Boolean(resolveAcceptedKnowledgeTrustEvidence(item, selectedKnowledge));
}

function hasSelectedKnowledgeTrustEvidence(item: Record<string, unknown>): boolean {
  return Boolean(resolveAcceptedKnowledgeTrustEvidence(null, item));
}

function resolveAcceptedKnowledgeTrustEvidence(
  item: SlimSearchResult | null,
  selectedKnowledge: Record<string, unknown> | undefined
): PrimeAcceptedKnowledgeTrustEvidence | null {
  const matchedRegionClasses = collectMatchedRegionClasses(selectedKnowledge);
  if (matchedRegionClasses.length > 0) {
    return {
      kind: 'recipe-semantic-region',
      source: 'prime-injection-package',
      summary: `resident Recipe semantic-region evidence (${matchedRegionClasses.join(', ')})`,
    };
  }
  if (hasRecipeLocatorSignal(item, selectedKnowledge)) {
    return {
      kind: 'recipe-locator',
      source: 'prime-injection-package',
      summary: 'resident Recipe locator evidence',
    };
  }
  return null;
}

function hasRecipeLocatorSignal(
  item: SlimSearchResult | null,
  selectedKnowledge: Record<string, unknown> | undefined
): boolean {
  const signals = [
    ...recordStringArray(selectedKnowledge?.evidenceRefs),
    ...recordStringArray(selectedKnowledge?.whySelected),
    ...recordStringArray(selectedKnowledge?.sourceRefs),
    ...(item ? (item.sourceRefs ?? []) : []),
  ];
  return signals.some((signal) =>
    /recipe[-_:]?(locator|trigger|title|id|exact|semantic-region)|trigger[-_:]?match|title[-_:]?match|exact[-_:]?recipe/i.test(
      signal
    )
  );
}

function collectMatchedRegionClasses(
  selectedKnowledge: Record<string, unknown> | undefined
): string[] {
  if (!selectedKnowledge) {
    return [];
  }
  return uniqueStrings([
    ...recordStringArray(selectedKnowledge.matchedRegionClasses),
    ...recordStringArray(selectedKnowledge.regionClasses),
    ...recordArray(selectedKnowledge.matchedRegions).flatMap((region) =>
      recordString(region, 'regionClass') ? [recordString(region, 'regionClass') as string] : []
    ),
  ]).slice(0, 8);
}

function collectUsefulSlices(
  selectedKnowledge: Record<string, unknown> | undefined
): PrimeUsefulSlice[] {
  const matchedRegions = recordArray(selectedKnowledge?.matchedRegions);
  return matchedRegions
    .flatMap((region): PrimeUsefulSlice[] => {
      const text = compactSliceText(
        recordString(region, 'snippet') ?? recordString(region, 'text')
      );
      if (!text) {
        return [];
      }
      const score = recordNumber(region, 'score');
      const evidenceRefs = extractEvidenceRefs(recordStringArray(region.sourceRefs));
      return [
        {
          evidenceRefs,
          ...(recordString(region, 'regionClass')
            ? { regionClass: recordString(region, 'regionClass') }
            : {}),
          ...(score !== undefined ? { score } : {}),
          ...(recordString(region, 'sourceRefsBridge')
            ? { sourceRefsBridge: recordString(region, 'sourceRefsBridge') }
            : {}),
          text,
        },
      ];
    })
    .slice(0, 4);
}

function compactSliceText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 420 ? `${normalized.slice(0, 417)}...` : normalized;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function recordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
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

function projectAcceptedKnowledge(
  item: SlimSearchResult,
  selectedKnowledge: Record<string, unknown> | undefined
): AcceptedPrimeKnowledge {
  const trustEvidence =
    resolveAcceptedKnowledgeTrustEvidence(item, selectedKnowledge) ??
    ({
      kind: 'recipe-locator',
      source: 'prime-injection-package',
      summary: 'resident Recipe locator evidence',
    } satisfies PrimeAcceptedKnowledgeTrustEvidence);
  const usefulSlices = collectUsefulSlices(selectedKnowledge);
  const evidenceRefs = uniquePrimeEvidenceRefs([
    ...extractEvidenceRefs(item.sourceRefs),
    ...usefulSlices.flatMap((slice) => slice.evidenceRefs),
  ]);
  return {
    id: item.id,
    kind: item.kind || 'pattern',
    title: item.title,
    trigger: item.trigger,
    ...(item.actionHint ? { actionHint: item.actionHint } : {}),
    summary: summarizePrimeItem(item),
    score: item.score,
    evidenceRefs,
    matchedRegionClasses: collectMatchedRegionClasses(selectedKnowledge),
    trustEvidence,
    usefulSlices,
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
        tool: 'alembic_work',
        args: {
          phase: 'start',
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
      tool: 'alembic_work',
      args: {
        phase: 'start',
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
