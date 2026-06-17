import type { AlembicResidentServiceResult } from '@alembic/core/daemon';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildCodexPrimeRuntimeContext } from '#codex/runtime/ProjectRuntimeContext.js';
import {
  type defaultProjectGraphProvider,
  defaultProjectKnowledgeContextLayer,
  defaultProjectMatrixProvider,
  type KnowledgeContextDetailRef,
  type KnowledgeContextDiagnostic,
  type KnowledgeContextNextAction,
  type KnowledgeContextProjectionPayload,
  type KnowledgeContextSource,
  type KnowledgeContextToolOutput,
  type ProjectMatrixKnowledgeEntry,
} from '#service/project-knowledge-context/index.js';
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
  type PrimeKnowledgeMaterial,
} from '#service/task/PrimeKnowledgeMaterial.js';
import type { PrimeSearchResult } from '#service/task/PrimeSearchPipeline.js';
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
  intake: ReturnType<typeof buildIntentIntake>;
  primeRef: string;
}

interface PrimeHandlerReadyInput extends PrimeHandlerSharedInput {
  ctx: McpContext;
  effectiveProjectRoot: string;
  primeSearch: Awaited<ReturnType<typeof runPrimeSearch>>;
  record: IntentRecord | null;
}

interface PrimeMaterialProjection {
  primeKnowledgeMaterial: PrimeKnowledgeMaterial;
  retrievalConsumer: PrimeSearchResult['searchMeta']['retrievalConsumer'] | null;
}

interface PrimeKnowledgeContextProjection {
  output: KnowledgeContextToolOutput;
  projectGraphIncluded: boolean;
  projectMatrixSummary: string;
}

type PrimeProjectGraphResult = Awaited<
  ReturnType<typeof defaultProjectGraphProvider.resolveProjectGraph>
>;
type PrimeProjectMatrixResult = Awaited<
  ReturnType<typeof defaultProjectMatrixProvider.resolveMatrix>
>;

interface AgentVectorPlan {
  keywordQueries: string[];
  language: string | null;
  module: string | null;
  queries: string[];
  retrievalOrder: string[];
  route: 'structure-first-recipe-retrieval';
  scenario: string;
  vectorUseKind: AgentVectorUseKind;
}

type AgentConfidenceBand = 'high' | 'medium' | 'low' | 'degraded';
type AgentDecisionNeed = 'none' | 'record-if-confirmed' | 'required-before-work';
type AgentGuardNeed = 'none' | 'recommend-if-code-changed' | 'explicit-scope-required';
type AgentKnowledgeNeed = 'none' | 'optional' | 'recommended' | 'required';
type AgentObjectKind =
  | 'automation-card'
  | 'code'
  | 'docs'
  | 'mcp-tool'
  | 'project-identity'
  | 'runtime-service'
  | 'source-ref'
  | 'unknown'
  | 'workspace-plan';
type AgentPersistenceKind = 'ephemeral' | 'session-local';
type AgentPrimeNeed = 'none' | 'optional' | 'recommended' | 'required';
type AgentPrimeSkippedReason =
  | 'mechanical-envelope-only'
  | 'no-semantic-intent'
  | 'status-only-turn'
  | 'not-relevant-to-project-knowledge';
type AgentScopeKind = 'file' | 'module' | 'none' | 'project' | 'source-ref';
type AgentProjectContextNeed = 'none' | 'optional' | 'recommended' | 'required';
type AgentVectorUseKind = 'none' | 'semantic-expand' | 'hybrid-rerank';
type AgentWorkNeed = 'none' | 'maybe-start' | 'start-required';

interface AgentIntentPersistence {
  consumable: boolean;
  kind: AgentPersistenceKind;
  localRecordCreated: boolean;
  reason: string;
}

interface PipelineLike {
  search(
    intent: ExtractedIntent,
    options?: {
      hostIntentFrame?: HostIntentFrame;
      projectRoot?: string;
      sourceRefs?: string[];
      standalonePrime?: true;
      standalonePrimeRequirement?: Record<string, unknown>;
    }
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

const PRIME_PUBLIC_STRING_MAX_CHARS = 240;
let finishCounter = 0;
let guardCounter = 0;
const INTENT_RECORDS = new Map<string, IntentRecord>();
const WORK_RECORDS = new Map<string, WorkRecord>();

export async function intentHandler(ctx: McpContext, args: AgentPublicBaseArgs) {
  const intake = buildIntentIntake(ctx, args);
  const status = resolveIntentStatus(intake.lifecycle, intake.hostIntentFrame, intake.intentKind);
  const detailRefs = buildBaseDetailRefs('alembic_intent', intake.sourceRefs);
  const persistence = resolveIntentPersistence(intake, status);
  const vectorPlan = buildVectorPlan(intake.extracted, {
    vectorUseKind: resolveVectorUseKind(intake, persistence),
  });
  const intentRef = persistence.consumable ? nextIntentRef() : null;
  const result = createAgentPublicToolResultEnvelope({
    actionKind: 'intent',
    agentHost: intake.agentHost,
    inputSource: intake.inputSource,
    intentKind: intake.intentKind,
    refs: {
      detailRefs,
      ...(intentRef
        ? {
            intentRef: {
              refType: 'intent' as const,
              id: intentRef,
              toolName: 'alembic_intent' as const,
            },
          }
        : {}),
    },
    ...(status.reason ? { reason: status.reason } : {}),
    status: status.status,
    summary: buildResultSummary(status.summary),
    toolName: 'alembic_intent',
  });

  const record = intentRef
    ? {
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
      }
    : null;
  if (record) {
    rememberIntentRecord(record);
  }

  return createAgentPublicToolOutput(result, {
    detailRefs,
    ...(intentRef ? { intentRef } : {}),
    ...(record
      ? {
          localRecord: {
            createdAt: record.createdAt,
            intentRef,
            status: result.status,
          },
        }
      : {}),
    intentClassification: buildIntentClassification(intake, persistence, vectorPlan),
    intentPersistence: buildIntentPersistenceReceipt(persistence),
    retrievalPlan: buildIntentRetrievalPlan(vectorPlan),
    recognizedIntent: intake.hostIntentFrame.recognizedIntentDraft,
    toolPlan: buildIntentToolPlan(intake, persistence),
  });
}

export async function primeHandler(ctx: McpContext, args: AgentPrimeArgs) {
  const intake = buildPrimeRequirementIntake(ctx, args);
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
  const primeSearch = await runPrimeSearch(ctx, args, intake, effectiveProjectRoot);
  return buildPrimeReadyOutput({
    args,
    ctx,
    detailRefs,
    effectiveProjectRoot,
    intake,
    primeRef,
    primeSearch,
    record: null,
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
  const knowledgeContext = buildPrimeBlockingKnowledgeContext(input, result, primePackage);
  return createAgentPublicToolOutput(result, {
    ...primeKnowledgeContextPublicFields(knowledgeContext),
    primePackage,
  });
}

function buildPrimeBlockingKnowledgeContext(
  input: PrimeHandlerSharedInput,
  result: AgentPublicToolResultEnvelope,
  primePackage: PrimePublicPackage
): KnowledgeContextToolOutput {
  return defaultProjectKnowledgeContextLayer.resolvePrimeContext(
    buildPrimeKnowledgeContextInput({
      args: input.args,
      effectiveProjectRoot: resolveString(input.args.projectRoot),
      intake: input.intake,
      primeRef: input.primeRef,
    }),
    {
      payload: {
        detailRefs: input.detailRefs.map(agentDetailRefToKnowledgeContextRef),
        diagnostics: [
          {
            code: result.reason?.code ?? 'prime-blocked',
            domain: 'runtime',
            message: result.reason?.message ?? result.summary,
            retryable: result.reason?.retryable ?? false,
            severity: 'warning',
          },
        ],
        inventory: {
          acceptedGuards: 0,
          acceptedKnowledge: 0,
          detailRefs: input.detailRefs.length,
          projectGraphIncluded: false,
        },
        interaction: {
          ...defaultProjectKnowledgeContextLayer.resolveInteractionState(
            buildPrimeKnowledgeContextInput({
              args: input.args,
              effectiveProjectRoot: resolveString(input.args.projectRoot),
              intake: input.intake,
              primeRef: input.primeRef,
            })
          ),
        },
        nextActions: [
          {
            tool: 'alembic_prime',
            reason:
              result.reason?.message ?? 'Repair the prime input and call alembic_prime again.',
            required: true,
          },
        ],
        result: {
          primePackage,
          reason: result.reason,
        },
        summary: result.summary,
      },
      snapshot: {
        domainFreshness: {
          runtime: {
            degradedReason: result.reason?.message ?? result.summary,
            state: 'unavailable',
          },
        },
      },
    }
  );
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
  const material = buildPrimeMaterialProjection(input.intake, input.primeSearch);
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

  bindPrimeSessionIntent(input.ctx, input.intake, input.primeSearch.searchResult, projectRuntime);
  const primePackage = buildPrimePublicPackage({
    detailRefs: input.detailRefs,
    intake: input.intake,
    primeKnowledgeMaterial: material.primeKnowledgeMaterial,
    primeRef: input.primeRef,
    result,
    searchDegraded: effectiveSearchDegraded,
    searchResult: input.primeSearch.searchResult,
  });
  const knowledgeContext = (
    await buildPrimeReadyKnowledgeContext({
      ...input,
      material,
      primePackage,
      status,
    })
  ).output;

  return createAgentPublicToolOutput(result, {
    ...primeKnowledgeContextPublicFields(knowledgeContext),
    primePackage,
  });
}

function primeKnowledgeContextPublicFields(output: KnowledgeContextToolOutput) {
  const { meta: _meta, ...publicFields } = output;
  return sanitizePrimeKnowledgeContextPublicFields(publicFields);
}

function sanitizePrimeKnowledgeContextPublicFields(value: Record<string, unknown>) {
  const sanitized = scrubPrimeRelationSurface(value);
  return isRecord(sanitized) ? sanitized : {};
}

function scrubPrimeRelationSurface(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => scrubPrimeRelationSurface(item))
      .filter((item) => item !== 'recipeRelation');
  }
  if (!isRecord(value)) {
    if (typeof value === 'string') {
      return value.replace(/\brecipeRelation\b/g, 'knowledge');
    }
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      key === 'recipeRelation' ||
      key === 'recipeRelationCount' ||
      key === 'relationChainCount' ||
      key === 'relationHopLimit'
    ) {
      continue;
    }
    output[key] = scrubPrimeRelationSurface(fieldValue);
  }
  return output;
}

async function buildPrimeReadyKnowledgeContext(
  input: PrimeHandlerReadyInput & {
    material: PrimeMaterialProjection;
    primePackage: PrimePublicPackage;
    status: Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string };
  }
): Promise<PrimeKnowledgeContextProjection> {
  const primeContextInput = buildPrimeKnowledgeContextInput({
    args: input.args,
    effectiveProjectRoot: input.effectiveProjectRoot,
    intake: input.intake,
    primeRef: input.primeRef,
    record: input.record,
  });
  const interaction =
    defaultProjectKnowledgeContextLayer.resolveInteractionState(primeContextInput);
  const projectMatrix = await resolvePrimeReadyProjectMatrix(input);
  const projectGraph = await resolvePrimeReadyProjectGraph(input);
  const vectorCandidateCount = countPrimeVectorCandidates(input.primeSearch.searchResult);
  const effectiveSearchDegraded =
    input.primeSearch.searchDegraded || input.material.primeKnowledgeMaterial.status === 'degraded';
  const payload = buildPrimeKnowledgeContextPayload({
    graphPayload: projectGraph?.payload ?? null,
    interaction: { ...interaction },
    material: input.material.primeKnowledgeMaterial,
    matrixSummary: projectMatrix.summary,
    primePackage: input.primePackage,
    projectGraphIncluded: projectGraph !== null,
    projectMatrix,
    searchDegraded: effectiveSearchDegraded,
    searchResult: input.primeSearch.searchResult,
    status: input.status,
  });
  const output = defaultProjectKnowledgeContextLayer.resolvePrimeContext(primeContextInput, {
    payload,
    snapshot: {
      domainFreshness: buildPrimeReadyDomainFreshness({
        material: input.material.primeKnowledgeMaterial,
        projectGraph,
        projectMatrix,
        searchDegraded: effectiveSearchDegraded,
        vectorCandidateCount,
      }),
      knowledgeItemCount:
        input.material.primeKnowledgeMaterial.acceptedKnowledge.length +
        input.material.primeKnowledgeMaterial.acceptedGuards.length,
      projectNodes: projectGraph?.projectNodes ?? projectMatrix.projectNodes,
      vectorCandidateCount,
    },
  });
  return {
    output,
    projectGraphIncluded: projectGraph !== null,
    projectMatrixSummary: projectMatrix.summary,
  };
}

function resolvePrimeReadyProjectMatrix(
  input: PrimeHandlerReadyInput & {
    material: PrimeMaterialProjection;
  }
): Promise<PrimeProjectMatrixResult> {
  const acceptedKnowledgeEntries = input.material.primeKnowledgeMaterial.acceptedKnowledge.map(
    primeKnowledgeToMatrixEntry
  );
  return defaultProjectMatrixProvider.resolveMatrix({
    activeFile: input.intake.hostIntentInput.activeFile,
    knowledgeEntries: acceptedKnowledgeEntries,
    operation: 'overview',
    projectRoot: input.effectiveProjectRoot,
    sourceEvidenceRefs: input.args.sourceEvidenceRefs,
    sourceRefs: input.args.sourceRefs,
  });
}

function resolvePrimeReadyProjectGraph(
  input: PrimeHandlerReadyInput
): Promise<PrimeProjectGraphResult | null> {
  void input;
  return Promise.resolve(null);
}

function countPrimeVectorCandidates(searchResult: PrimeSearchResult | null): number {
  return searchResult?.searchMeta.residentSearch?.vectorUsed
    ? searchResult.searchMeta.resultCount
    : 0;
}

function buildPrimeReadyDomainFreshness(input: {
  material: PrimeKnowledgeMaterial;
  projectGraph: PrimeProjectGraphResult | null;
  projectMatrix: PrimeProjectMatrixResult;
  searchDegraded: boolean;
  vectorCandidateCount: number;
}) {
  const projectDomainFreshness = { ...input.projectMatrix.domainFreshness };
  delete (projectDomainFreshness as Record<string, unknown>).recipeRelation;
  return {
    ...projectDomainFreshness,
    knowledge: primeKnowledgeFreshness(input.material, input.searchDegraded),
    vector: {
      state: input.vectorCandidateCount > 0 ? ('ready' as const) : ('partial' as const),
      degradedReason:
        input.vectorCandidateCount > 0
          ? undefined
          : 'Vector/rerank evidence was unavailable or unused for this prime retrieval.',
    },
  };
}

function primeKnowledgeFreshness(material: PrimeKnowledgeMaterial, searchDegraded: boolean) {
  const hasAcceptedMaterial =
    material.acceptedKnowledge.length > 0 || material.acceptedGuards.length > 0;
  return {
    state: hasAcceptedMaterial
      ? ('ready' as const)
      : searchDegraded
        ? ('stale' as const)
        : ('partial' as const),
    degradedReason: hasAcceptedMaterial
      ? undefined
      : searchDegraded
        ? 'Prime search degraded before accepted knowledge could be selected.'
        : 'Prime search returned no accepted Recipe or Guard material.',
  };
}

function buildPrimeKnowledgeContextInput(input: {
  args: AgentPrimeArgs;
  effectiveProjectRoot?: string;
  intake: ReturnType<typeof buildIntentIntake>;
  primeRef: string;
  record?: IntentRecord | null;
}) {
  const frame = buildStandalonePrimeRequirementFrame(input.args);
  const query = resolveString(input.intake.hostIntentFrame.recognizedIntentDraft.query);
  const language = resolveString(input.intake.extracted.language);
  const hostDeclaredIntent = sanitizePrimeHostDeclaredIntent(
    input.intake.hostIntentFrame.hostDeclaredIntent
  );
  return {
    activeFile: input.intake.hostIntentInput.activeFile,
    agentHost: input.intake.agentHost,
    budget: {
      contentCharLimit: 1200,
      detailLimit: 12,
      itemLimit: 8,
      matrixNodeLimit: 10,
      nextActionLimit: 5,
      relationHopLimit: 2,
    },
    ...(hostDeclaredIntent === undefined ? {} : { hostDeclaredIntent }),
    inputSource: input.intake.inputSource,
    intentKind: input.intake.intentKind,
    ...(language === undefined ? {} : { language }),
    operation: 'auto',
    primeRef: input.primeRef,
    projectRoot: input.effectiveProjectRoot,
    ...(query === undefined ? {} : { query }),
    ...(frame.taskAction ? { taskAction: frame.taskAction } : {}),
    ...(frame.requirementGoal ? { requirementGoal: frame.requirementGoal } : {}),
    ...(frame.scenario ? { scenario: frame.scenario } : {}),
    ...(frame.capability ? { capability: frame.capability } : {}),
    ...(frame.domainObjects.length > 0 ? { domainObjects: frame.domainObjects } : {}),
    ...(frame.integrationBoundary ? { integrationBoundary: frame.integrationBoundary } : {}),
    ...(frame.lifecycleHint ? { lifecycleHint: frame.lifecycleHint } : {}),
    ...(frame.qualityConcerns.length > 0 ? { qualityConcerns: frame.qualityConcerns } : {}),
    ...(frame.keywords.length > 0 ? { keywords: frame.keywords } : {}),
    ...(frame.labels.length > 0 ? { labels: frame.labels } : {}),
    sourceEvidenceRefs: input.args.sourceEvidenceRefs,
    sourceRefs: input.intake.sourceRefs,
    tool: 'alembic_prime' as const,
  };
}

function sanitizePrimeHostDeclaredIntent(
  value: HostDeclaredIntentInput | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const query = resolveString(value.query);
  const action = resolveString(value.action);
  const target = resolveString(value.target);
  const confidence = readFiniteNumber(value.confidence);
  const sourceRefs = Array.isArray(value.sourceRefs)
    ? value.sourceRefs.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  if (
    query === undefined &&
    action === undefined &&
    target === undefined &&
    confidence === undefined
  ) {
    return undefined;
  }
  return {
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(query === undefined ? {} : { query }),
    ...(sourceRefs.length === 0 ? {} : { sourceRefs }),
  };
}

function buildPrimeKnowledgeContextPayload(input: {
  graphPayload: KnowledgeContextProjectionPayload | null;
  interaction: Record<string, unknown>;
  material: PrimeKnowledgeMaterial;
  matrixSummary: string;
  primePackage: PrimePublicPackage;
  projectGraphIncluded: boolean;
  projectMatrix: PrimeProjectMatrixResult;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  status: Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string };
}): KnowledgeContextProjectionPayload {
  const acceptedRefs = [
    ...input.material.acceptedKnowledge.map(acceptedKnowledgeToDetailRef),
    ...input.material.acceptedGuards.map(acceptedGuardToDetailRef),
  ];
  const graphDetailRefs = input.projectGraphIncluded ? (input.graphPayload?.detailRefs ?? []) : [];
  const detailRefs = [
    ...acceptedRefs,
    ...input.projectMatrix.detailRefs.slice(0, 6),
    ...graphDetailRefs.slice(0, 4),
  ];
  const graphNextActions = input.projectGraphIncluded
    ? (input.graphPayload?.nextActions ?? [])
    : [];

  return {
    detailRefs,
    diagnostics: buildPrimeKnowledgeContextDiagnostics(input),
    interaction: input.interaction,
    inventory: {
      acceptedGuardCount: input.material.acceptedGuards.length,
      acceptedKnowledgeCount: input.material.acceptedKnowledge.length,
      detailRefCount: detailRefs.length,
      graphDetailRefCount: graphDetailRefs.length,
      projectGraphIncluded: input.projectGraphIncluded,
      searchDegraded: input.searchDegraded,
      trustReceiptStatus: input.material.status,
    },
    items: [
      ...input.material.acceptedKnowledge.map((item) => ({
        id: item.id,
        kind: item.kind,
        matchedRegionClasses: item.matchedRegionClasses,
        score: item.score,
        summary: item.summary,
        title: item.title,
        trustEvidence: item.trustEvidence,
        trustLayer: 'trusted-to-use',
        usefulSlices: item.usefulSlices.map((slice) => ({
          ...(slice.regionClass ? { regionClass: slice.regionClass } : {}),
          text: slice.text,
        })),
      })),
      ...input.material.acceptedGuards.map((item) => ({
        id: item.id,
        kind: 'guard',
        score: item.score,
        summary: item.actionHint ?? item.title,
        title: item.title,
        trustLayer: 'trusted-to-obey',
      })),
    ],
    matrixNodes: input.projectMatrix.matrixNodes.slice(0, 10),
    nextActions: [
      ...primeMaterialNextActions(input.material),
      ...input.projectMatrix.nextActions.slice(0, 2),
      ...graphNextActions.slice(0, 1),
    ],
    relations: input.projectGraphIncluded ? (input.graphPayload?.relations ?? []).slice(0, 4) : [],
    result: {
      acceptedGuards: input.primePackage.compactPackage.acceptedGuards,
      acceptedKnowledge: input.primePackage.compactPackage.acceptedKnowledge,
      contextOnlyEvidence: {
        projectMatrixSummary: input.matrixSummary,
        projectGraphIncluded: input.projectGraphIncluded,
        projectContextRoute: input.searchResult?.searchMeta.residentSearch?.route ?? null,
      },
      primePackage: input.primePackage,
      retrieval: {
        residentSearchAttempted: input.searchResult?.searchMeta.residentSearch?.attempted ?? false,
        searchDegraded: input.searchDegraded,
      },
      trustReceipt: input.primePackage.trustReceipt,
    },
    sources: [
      ...acceptedRefs.map(detailRefToSource),
      ...input.projectMatrix.sources.slice(0, 6),
      ...(input.projectGraphIncluded ? (input.graphPayload?.sources ?? []).slice(0, 4) : []),
    ],
    summary: buildPrimeKnowledgeContextSummary(input),
  };
}

function primeKnowledgeToMatrixEntry(
  item: PrimeKnowledgeMaterial['acceptedKnowledge'][number]
): ProjectMatrixKnowledgeEntry {
  return {
    id: item.id,
    kind: item.kind,
    language: undefined,
    title: item.title,
    description: item.summary,
  };
}

function acceptedKnowledgeToDetailRef(
  item: PrimeKnowledgeMaterial['acceptedKnowledge'][number]
): KnowledgeContextDetailRef {
  return {
    domain: 'knowledge',
    id: `prime-knowledge:${item.id}`,
    operation: 'prime-accepted-knowledge',
    requiredForCompletion: false,
    summary: item.summary || item.title,
    title: item.title,
    tool: 'alembic_prime',
    uri: item.evidenceRefs[0] ? evidenceRefToUri(item.evidenceRefs[0]) : undefined,
  };
}

function acceptedGuardToDetailRef(
  item: PrimeKnowledgeMaterial['acceptedGuards'][number]
): KnowledgeContextDetailRef {
  return {
    domain: 'knowledge',
    id: `prime-guard:${item.id}`,
    operation: 'prime-accepted-guard',
    requiredForCompletion: false,
    summary: item.actionHint || item.title,
    title: item.title,
    tool: 'alembic_prime',
    uri: item.evidenceRefs[0] ? evidenceRefToUri(item.evidenceRefs[0]) : undefined,
  };
}

function agentDetailRefToKnowledgeContextRef(ref: AgentDetailRef): KnowledgeContextDetailRef {
  return {
    domain: agentDetailRefDomain(ref.kind),
    id: ref.id,
    requiredForCompletion: ref.requiredForCompletion,
    summary: ref.summary,
    tool: 'alembic_prime',
    uri: ref.uri,
  };
}

function agentDetailRefDomain(kind: AgentDetailRef['kind']): KnowledgeContextDetailRef['domain'] {
  if (kind === 'source-ref' || kind === 'file' || kind === 'report' || kind === 'test-output') {
    return 'document';
  }
  if (kind === 'contract' || kind === 'schema' || kind === 'runtime-json' || kind === 'log') {
    return 'runtime';
  }
  return 'knowledge';
}

function detailRefToSource(ref: KnowledgeContextDetailRef): KnowledgeContextSource {
  return {
    confidence: ref.domain === 'knowledge' ? 0.85 : 0.7,
    detailRefId: ref.id,
    domain: ref.domain,
    id: ref.ref ?? ref.id,
    summary: ref.summary,
    title: ref.title,
  };
}

function primeMaterialNextActions(material: PrimeKnowledgeMaterial): KnowledgeContextNextAction[] {
  return material.nextActions.slice(0, 3).map((action) => ({
    tool: action.tool === 'alembic_code_guard' ? 'alembic_prime' : 'alembic_search',
    operation: action.tool,
    reason: action.reason,
    required: action.required,
  }));
}

function buildPrimeKnowledgeContextDiagnostics(input: {
  material: PrimeKnowledgeMaterial;
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
}): KnowledgeContextDiagnostic[] {
  const diagnostics: KnowledgeContextDiagnostic[] = [];
  if (input.searchDegraded) {
    diagnostics.push({
      code: 'prime-search-degraded',
      domain: 'knowledge',
      message: 'Prime search degraded before full Recipe retrieval material could be selected.',
      retryable: true,
      severity: 'warning',
    });
  }
  if (input.material.status === 'empty') {
    diagnostics.push({
      code: 'prime-accepted-knowledge-empty',
      domain: 'knowledge',
      message: 'Prime completed without accepted Recipe or Guard material.',
      retryable: false,
      severity: 'info',
    });
  }
  if (!input.searchResult?.searchMeta.residentSearch?.residentVector?.available) {
    diagnostics.push({
      code: 'prime-vector-evidence-unavailable',
      domain: 'vector',
      message: 'Resident vector/rerank evidence was unavailable or unused.',
      retryable: false,
      severity: 'info',
    });
  }
  return diagnostics;
}

function buildPrimeKnowledgeContextSummary(input: {
  material: PrimeKnowledgeMaterial;
  projectGraphIncluded: boolean;
  searchDegraded: boolean;
}): string {
  const acceptedKnowledgeCount = input.material.acceptedKnowledge.length;
  const acceptedGuardCount = input.material.acceptedGuards.length;
  const graphPhrase = input.projectGraphIncluded
    ? 'project graph detail refs available'
    : 'project graph omitted';
  const degradedPhrase = input.searchDegraded ? ' with degraded search evidence' : '';
  return `Prime prepared compact task context${degradedPhrase}: ${acceptedKnowledgeCount} accepted knowledge item(s), ${acceptedGuardCount} guard item(s), ${graphPhrase}.`;
}

function evidenceRefToUri(
  ref: PrimeKnowledgeMaterial['acceptedKnowledge'][number]['evidenceRefs'][number]
) {
  return ref.line === null ? ref.path : `${ref.path}:${ref.line}`;
}

function resolveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildPrimeMaterialProjection(
  intake: ReturnType<typeof buildIntentIntake>,
  primeSearch: Awaited<ReturnType<typeof runPrimeSearch>>
): PrimeMaterialProjection {
  return {
    primeKnowledgeMaterial: buildPrimeKnowledgeMaterial({
      extracted: intake.extracted,
      hostIntentFrame: intake.hostIntentFrame,
      hostIntentInput: intake.hostIntentInput,
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
  const intake = buildIntentIntake(ctx, args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_work_start',
    uniqueStrings([
      ...(args.sourceRefs ?? []),
      ...(args.sourceEvidenceRefs ?? []),
      ...(args.workScope?.files ?? []),
    ])
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
      summary: buildResultSummary(status.summary),
      toolName: 'alembic_work_start',
    });
    return createAgentPublicToolOutput(result);
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
    sourceEvidenceRefs: uniqueStrings(args.sourceEvidenceRefs ?? []),
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
    summary: buildResultSummary(`Work started for "${title}".`),
    toolName: 'alembic_work_start',
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
  const intake = buildIntentIntake(ctx, args);
  const detailRefs = buildBaseDetailRefs(
    'alembic_work_finish',
    uniqueStrings([
      ...(args.sourceRefs ?? []),
      ...(args.sourceEvidenceRefs ?? []),
      ...(args.evidenceRefs ?? []),
    ])
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
      refs: {
        detailRefs,
      },
      status: 'blocked',
      summary: buildResultSummary('Work finish blocked because workRef is missing.'),
      toolName: 'alembic_work_finish',
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
    summary: buildResultSummary(summary),
    toolName: 'alembic_work_finish',
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
  const intake = buildIntentIntake(ctx, args);
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
  intake: ReturnType<typeof buildIntentIntake>;
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
  intake: ReturnType<typeof buildIntentIntake>;
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
    intake: ReturnType<typeof buildIntentIntake>;
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
        toolName: 'alembic_work_start' as const,
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
  intake: ReturnType<typeof buildIntentIntake>;
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
  intake: ReturnType<typeof buildIntentIntake>;
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
      ...buildIntentRefEntry(args.intentRef),
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
  intake: ReturnType<typeof buildIntentIntake>;
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

export async function decisionRecordHandler(ctx: McpContext, args: AgentDecisionRecordArgs) {
  const intake = buildIntentIntake(ctx, args);
  const sourceRefs = uniqueStrings([
    ...(args.sourceRefs ?? []),
    ...(args.sourceEvidenceRefs ?? []),
    ...(args.evidenceRefs ?? []),
  ]);
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
      refs: {
        detailRefs,
      },
      status: 'blocked',
      summary: buildResultSummary('Decision record blocked because decision scope is incomplete.'),
      toolName: 'alembic_decision_record',
    });
    return createAgentPublicToolOutput(result);
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
    return createAgentPublicToolOutput(result, {
      durablePersistence: {
        action,
        available: false,
        requiredRoute: 'Alembic durable Decision Register route',
      },
      requestedDecision: buildRequestedDecision(action, args),
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
    return createAgentPublicToolOutput(result, {
      durablePersistence: {
        action,
        available: false,
        reason: residentResult.reason,
        requiredRoute: 'Alembic durable Decision Register route',
      },
      requestedDecision: buildRequestedDecision(action, args),
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
      formatDecisionRecordSuccessSummary(action, residentResult.value, decisionId)
    ),
    toolName: 'alembic_decision_record',
  });

  return createAgentPublicToolOutput(result, {
    count: residentResult.value.count ?? null,
    decision: residentResult.value.decision,
    decisionRef: decisionId,
    decisions: residentResult.value.decisions ?? [],
    durablePersistence: {
      action,
      available: true,
      capability: residentResult.value.capability,
    },
  });
}

function buildIntentIntake(ctx: McpContext, args: AgentPublicBaseArgs) {
  const hostDeclaredIntent = mergeRecognizedIntent(args);
  const rawUserQuery = firstString(args.userQuery);
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
    ...(args.sourceEvidenceRefs ?? []),
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

function buildPrimeRequirementIntake(
  ctx: McpContext,
  args: AgentPrimeArgs
): ReturnType<typeof buildIntentIntake> {
  const standaloneFrame = buildStandalonePrimeRequirementFrame(args);
  const hostDeclaredIntent = hasAnyStandalonePrimeSignal(standaloneFrame)
    ? primeFrameToHostDeclaredIntent(standaloneFrame)
    : undefined;
  const rawUserQuery = firstString(args.userQuery);
  const effectiveUserQuery = standaloneFrame.searchQuery ?? rawUserQuery;
  const hostIntentInput = prepareHostIntentInput({
    activeFile: args.activeFile,
    hostDeclaredIntent,
    hostTurnMeta: args.hostTurnMeta,
    language: args.language,
    requestHostTurnMeta: ctx.hostTurnMeta,
    userQuery: effectiveUserQuery,
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
    ...(args.sourceEvidenceRefs ?? []),
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

function primeFrameToHostDeclaredIntent(
  frame: StandalonePrimeRequirementFrame
): HostDeclaredIntentInput | undefined {
  if (!hasAnyStandalonePrimeSignal(frame)) {
    return undefined;
  }
  const keywords = uniqueStrings([
    ...frame.locatorFacets,
    ...(frame.lifecycleHint ? [frame.lifecycleHint] : []),
    ...frame.keywords,
    ...frame.labels,
  ]).slice(0, 12);
  return {
    ...(frame.searchQuery ? { query: frame.searchQuery } : {}),
    ...(frame.requirementGoal ? { goal: frame.requirementGoal } : {}),
    ...(frame.taskAction ? { action: frame.taskAction } : {}),
    ...(frame.scenario ? { scenario: frame.scenario.slice(0, 80) } : {}),
    ...(frame.capability ? { module: frame.capability.slice(0, 160) } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
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
  hostIntentFrame: HostIntentFrame,
  intentKind: AgentIntentKind
): Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'> & { summary: string } {
  const draft = hostIntentFrame.recognizedIntentDraft;
  if (lifecycle.inputSource === 'automation-envelope' || intentKind === 'mechanical-envelope') {
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
  if (intentKind === 'status-only' || lifecycle.intentKind === 'status-report') {
    return {
      reason: {
        kind: 'skip',
        code: 'status-only-turn',
        message: 'Status-only turns do not create a consumable intent record.',
        retryable: false,
      },
      status: 'skipped',
      summary: 'Skipped status-only turn; no local intent record was created.',
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
  intake: ReturnType<typeof buildIntentIntake>
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
  intake: ReturnType<typeof buildIntentIntake>,
  effectiveProjectRoot: string
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
    const searchResult = await pipeline.search(intake.extracted, {
      hostIntentFrame: intake.hostIntentFrame,
      projectRoot: effectiveProjectRoot,
      sourceRefs: intake.sourceRefs,
      standalonePrime: true,
      standalonePrimeRequirement: buildStandalonePrimeRequirementFrame(args) as unknown as Record<
        string,
        unknown
      >,
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
  intake: ReturnType<typeof buildIntentIntake>
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
  intake: ReturnType<typeof buildIntentIntake>,
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
      intake.hostIntentFrame.recognizedIntentDraft.query.trim().length > 0
  );
  const hasWorkScope = hasExplicitWorkScope || hasPolicyWorkScope;
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
    summary: buildResultSummary(input.summary),
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

function buildIntentRefEntry(intentRef: unknown) {
  const id = firstString(intentRef);
  if (!id) {
    return {};
  }
  return {
    intentRef: {
      refType: 'intent' as const,
      id,
      toolName: 'alembic_intent' as const,
    },
  };
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
      toolName: 'alembic_work_start' as const,
    },
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
    sourceEvidenceRefs: input.args.sourceEvidenceRefs?.length
      ? uniqueStrings(input.args.sourceEvidenceRefs)
      : undefined,
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

function resolveIntentPersistence(
  intake: ReturnType<typeof buildIntentIntake>,
  status: Pick<AgentPublicToolResultEnvelope, 'status' | 'reason'>
): AgentIntentPersistence {
  const draft = intake.hostIntentFrame.recognizedIntentDraft;
  if (!isConsumableIntentKind(intake.intentKind)) {
    return {
      consumable: false,
      kind: 'ephemeral',
      localRecordCreated: false,
      reason: `intentKind.${intake.intentKind}.notConsumable`,
    };
  }
  if (!draft.query.trim()) {
    return {
      consumable: false,
      kind: 'ephemeral',
      localRecordCreated: false,
      reason: 'recognizedIntent.queryMissing',
    };
  }
  if (status.status === 'skipped' || status.status === 'blocked' || status.status === 'failed') {
    return {
      consumable: false,
      kind: 'ephemeral',
      localRecordCreated: false,
      reason: status.reason?.code ?? status.status,
    };
  }
  return {
    consumable: true,
    kind: 'session-local',
    localRecordCreated: true,
    reason:
      status.status === 'degraded'
        ? 'semanticIntent.degradedButConsumable'
        : 'semanticIntent.ready',
  };
}

function isConsumableIntentKind(intentKind: AgentIntentKind): boolean {
  return !['mechanical-envelope', 'status-only', 'unknown'].includes(intentKind);
}

function buildVectorPlan(
  extracted: ExtractedIntent,
  options: { vectorUseKind?: AgentVectorUseKind } = {}
): AgentVectorPlan {
  return {
    keywordQueries: extracted.keywordQueries.slice(0, 4),
    language: extracted.language,
    module: extracted.module,
    queries: extracted.queries.slice(0, 5),
    retrievalOrder: [
      'structure hints from activeFile/module',
      'auto lexical/FWS queries',
      'semantic resident search when available',
      'keyword synonym expansion',
      'quality-filtered Recipe/Guard split',
    ],
    route: 'structure-first-recipe-retrieval',
    scenario: extracted.scenario,
    vectorUseKind: options.vectorUseKind ?? 'semantic-expand',
  };
}

function buildIntentClassification(
  intake: ReturnType<typeof buildIntentIntake>,
  persistence: AgentIntentPersistence,
  vectorPlan: AgentVectorPlan
) {
  return {
    actionKind: intake.hostIntentFrame.recognizedIntentDraft.action || 'unknown',
    confidenceBand: resolveConfidenceBand(intake.hostIntentFrame.recognizedIntentDraft.confidence),
    objectKind: resolveObjectKind(intake),
    scopeKind: resolveScopeKind(intake),
  };
}

function buildIntentPersistenceReceipt(persistence: AgentIntentPersistence) {
  return {
    consumable: persistence.consumable,
    created: persistence.localRecordCreated,
    kind: persistence.kind,
  };
}

function buildIntentRetrievalPlan(vectorPlan: AgentVectorPlan) {
  return {
    route: 'structure-first' as const,
    vectorUseKind: vectorPlan.vectorUseKind,
  };
}

function buildIntentToolPlan(
  intake: ReturnType<typeof buildIntentIntake>,
  persistence: AgentIntentPersistence
) {
  const primeNeed = resolvePrimeNeed(intake, persistence);
  return {
    decisionNeed: resolveDecisionNeed(intake),
    guardNeed: resolveGuardNeed(intake),
    knowledgeNeed: resolveKnowledgeNeed(primeNeed),
    primeNeed,
    projectContextNeed: resolveProjectContextNeed(intake, persistence),
    projectContextPlan: buildProjectContextPlan(intake, persistence),
    workNeed: resolveWorkNeed(intake),
  };
}

function resolveVectorUseKind(
  intake: ReturnType<typeof buildIntentIntake>,
  persistence: AgentIntentPersistence
): AgentVectorUseKind {
  if (!persistence.consumable) {
    return 'none';
  }
  if (intake.lifecycle.primeDecision.action === 'run') {
    return 'hybrid-rerank';
  }
  return 'semantic-expand';
}

function resolveConfidenceBand(confidence: number): AgentConfidenceBand {
  if (confidence >= 0.8) {
    return 'high';
  }
  if (confidence >= 0.55) {
    return 'medium';
  }
  if (confidence >= 0.3) {
    return 'low';
  }
  return 'degraded';
}

function resolveObjectKind(intake: ReturnType<typeof buildIntentIntake>): AgentObjectKind {
  if (intake.inputSource === 'automation-envelope') {
    return 'automation-card';
  }
  const target = intake.hostIntentFrame.recognizedIntentDraft.target?.toLowerCase() ?? '';
  if (target.includes('mcp')) {
    return 'mcp-tool';
  }
  if (target.includes('runtime')) {
    return 'runtime-service';
  }
  if (intake.hostIntentInput.activeFile) {
    return 'code';
  }
  if (intake.sourceRefs.length > 0) {
    return 'source-ref';
  }
  if (target.includes('doc') || target.includes('plan')) {
    return 'docs';
  }
  return 'unknown';
}

function resolveScopeKind(intake: ReturnType<typeof buildIntentIntake>): AgentScopeKind {
  if (intake.sourceRefs.length > 0) {
    return 'source-ref';
  }
  if (intake.hostIntentInput.activeFile) {
    return 'file';
  }
  if (intake.extracted.module) {
    return 'module';
  }
  return 'none';
}

function resolvePrimeNeed(
  intake: ReturnType<typeof buildIntentIntake>,
  persistence: AgentIntentPersistence
): AgentPrimeNeed {
  if (!persistence.consumable) {
    return 'none';
  }
  if (intake.lifecycle.primeDecision.action === 'run') {
    return 'recommended';
  }
  if (intake.intentKind === 'read-only-analysis' || intake.intentKind === 'review-task') {
    return 'optional';
  }
  return 'none';
}

function resolveKnowledgeNeed(primeNeed: AgentPrimeNeed): AgentKnowledgeNeed {
  return primeNeed;
}

function resolveProjectContextNeed(
  intake: ReturnType<typeof buildIntentIntake>,
  persistence: AgentIntentPersistence
): AgentProjectContextNeed {
  if (!persistence.consumable) {
    return 'none';
  }
  if (
    intake.intentKind === 'implementation-task' ||
    intake.intentKind === 'fix-task' ||
    intake.intentKind === 'refactor-task' ||
    intake.intentKind === 'review-task'
  ) {
    return 'recommended';
  }
  if (
    intake.intentKind === 'read-only-analysis' &&
    (intake.hostIntentInput.activeFile || intake.extracted.module)
  ) {
    return 'optional';
  }
  return 'none';
}

function buildProjectContextPlan(
  intake: ReturnType<typeof buildIntentIntake>,
  persistence: AgentIntentPersistence
) {
  const need = resolveProjectContextNeed(intake, persistence);
  if (need === 'none') {
    return {
      action: 'skip' as const,
      reasonCode: 'no-project-context-needed',
      tools: [],
    };
  }
  const changedFileLikely =
    intake.intentKind === 'implementation-task' ||
    intake.intentKind === 'fix-task' ||
    intake.intentKind === 'refactor-task';
  return {
    action: changedFileLikely ? ('graph-after-work' as const) : ('graph-before-work' as const),
    reasonCode: changedFileLikely
      ? 'project-context-graph-after-changes'
      : 'project-context-graph-before-source-claim',
    tools: changedFileLikely
      ? ['alembic_project_matrix', 'alembic_graph', 'alembic_code_guard']
      : ['alembic_project_matrix', 'alembic_graph'],
  };
}

function resolveDecisionNeed(intake: ReturnType<typeof buildIntentIntake>): AgentDecisionNeed {
  if (intake.intentKind === 'decision') {
    return 'required-before-work';
  }
  if (
    intake.intentKind === 'implementation-task' ||
    intake.intentKind === 'fix-task' ||
    intake.intentKind === 'refactor-task'
  ) {
    return 'record-if-confirmed';
  }
  return 'none';
}

function resolveWorkNeed(intake: ReturnType<typeof buildIntentIntake>): AgentWorkNeed {
  if (intake.lifecycle.taskAnchorDecision.action === 'create') {
    return intake.intentKind === 'implementation-task' ? 'start-required' : 'maybe-start';
  }
  return 'none';
}

function resolveGuardNeed(intake: ReturnType<typeof buildIntentIntake>): AgentGuardNeed {
  if (intake.intentKind === 'fix-task' || intake.intentKind === 'refactor-task') {
    return 'recommend-if-code-changed';
  }
  if (intake.intentKind === 'implementation-task') {
    return 'explicit-scope-required';
  }
  return 'none';
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
  intake: ReturnType<typeof buildIntentIntake>;
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
  intake: ReturnType<typeof buildIntentIntake>;
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
  const activeFile = input.intake.hostIntentInput.activeFile;
  const query = compactPrimePublicString(
    firstString(
      input.intake.extracted.queries[0],
      input.intake.hostIntentFrame.recognizedIntentDraft.query
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
