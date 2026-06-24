import path from 'node:path';
import {
  buildProjectContextCreationGuide,
  buildProjectContextCreationNextActions,
} from '#recipe-generation/project-context-anchoring.js';
import type { HostProjectAlignment } from '../../runtime/HostProjectAlignment.js';
import type { HostKnowledgeState } from '../../runtime/KnowledgeState.js';
import {
  listPluginToolSurfaceCatalog,
  type PluginToolSurfaceEntry,
} from '../../runtime/mcp/PluginToolSurfaceCatalog.js';

export const ONBOARDING_CONTRACT_VERSION = 1;

const CANONICAL_PROJECT_CONTEXT_TOOLS = ['alembic_recipe_map', 'alembic_graph'] as const;

const KNOWLEDGE_AND_RECIPE_TOOLS = [
  'alembic_recipe_map',
  'alembic_prime',
  'alembic_search',
  'alembic_graph',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
] as const;

const GUARD_AND_VALIDATION_TOOLS = ['alembic_code_guard'] as const;

const BOOTSTRAP_AND_RECOVERY_TOOLS = [
  'alembic_status',
  'alembic_init',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_job',
] as const;

interface DimensionSummary {
  id: string;
  title: string;
  tier: number | null;
}

interface LanguageOverlaySummary {
  confidence: 'full' | 'reduced';
  grounding: string[];
  id: string;
  inspect: string[];
  language: string;
  uncertainty: string | null;
}

export interface OnboardingContract {
  bootstrapState: Record<string, unknown>;
  currentDimensionGuidance: Record<string, unknown>;
  currentDimensionNextActions: Array<Record<string, unknown>>;
  gates: Record<string, unknown>;
  hostAgentContract: Record<string, unknown>;
  initialToolBriefing: Record<string, unknown>;
  progress: Record<string, unknown>;
  repairState: Record<string, unknown>;
  toolCapabilities: Record<string, unknown>;
}

export interface BuildOnboardingContractInput {
  dataRoot?: string;
  diagnosticsOk?: boolean;
  dimensions?: unknown;
  fileCount?: number | null;
  hostProjectAlignment?: HostProjectAlignment;
  knowledge?: HostKnowledgeState;
  moduleCount?: number | null;
  primaryLanguage?: string | null;
  projectRoot: string;
  projectRootTrusted?: boolean;
  projectType?: string | null;
  secondaryLanguages?: string[];
  session?: unknown;
  source?: 'bootstrap' | 'status';
}

export function buildColdStartOnboardingContract(
  input: BuildOnboardingContractInput
): OnboardingContract {
  return buildOnboardingContract({ ...input, source: 'bootstrap' });
}

export function buildStatusOnboardingContract(
  input: BuildOnboardingContractInput
): OnboardingContract {
  return buildOnboardingContract({ ...input, source: 'status' });
}

function buildOnboardingContract(input: BuildOnboardingContractInput): OnboardingContract {
  const dimensions = summarizeDimensions(input.dimensions);
  const toolSurface = listPluginToolSurfaceCatalog();
  const languageProfile = buildLanguageProfile(input);
  const toolCapabilities = buildToolCapabilities(toolSurface);
  const bootstrapState = buildBootstrapState(input, {
    dimensions,
  });
  const progress = buildProgress(dimensions);
  const repairState = buildRepairState(input, bootstrapState);
  const gates = buildGates();
  const hostAgentContract = buildHostAgentContract(input, { languageProfile, toolSurface });
  const currentDimensionGuidance = buildPlanNeutralDimensionGuidance(dimensions);
  const currentDimensionNextActions = buildCurrentDimensionNextActions(input);

  return {
    bootstrapState,
    currentDimensionGuidance,
    currentDimensionNextActions,
    gates,
    hostAgentContract,
    initialToolBriefing: {
      contractVersion: ONBOARDING_CONTRACT_VERSION,
      defaultOrder: [
        'alembic_status',
        'alembic_recipe_map',
        'alembic_graph',
        'alembic_search',
        'alembic_prime',
        'alembic_submit_knowledge',
        'alembic_dimension_complete',
      ],
      rule: 'Use ProjectContext matrix/graph for compact orientation; fall back to raw file reads and repository validation when project context is partial or ambiguous.',
      agentDecisionChecklist: buildAgentDecisionChecklist(),
      blockedConclusionsField: 'repairState.blockedConclusions',
      evidenceFields: [
        'bootstrapState.projectIdentity',
        'bootstrapState.projectContext',
        'toolCapabilities',
        'currentDimensionGuidance.dimensions[].analysisGuide',
        'currentDimensionGuidance.dimensions[].submissionSpec',
        'hostAgentContract.recipeGuidanceFloor',
        'hostAgentContract.submitKnowledgeContract',
      ],
      projectContextCreationGuide: buildProjectContextCreationGuide({
        projectRoot: input.projectRoot,
        stage: input.source === 'status' ? 'submit-knowledge' : 'bootstrap',
      }),
      guidanceField: 'currentDimensionGuidance',
      hostAgentContractField: 'hostAgentContract',
      toolCapabilityField: 'toolCapabilities',
    },
    progress,
    repairState,
    toolCapabilities,
  };
}

function buildBootstrapState(
  input: BuildOnboardingContractInput,
  context: { dimensions: DimensionSummary[] }
): Record<string, unknown> {
  const knowledge = input.knowledge;
  const status = resolveBootstrapStatus(input);
  const sessionSummary = summarizeSession(input.session, context.dimensions.length);
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    status,
    source: input.source || 'status',
    projectIdentity: {
      basename: path.basename(input.projectRoot),
      dataRoot: input.dataRoot || null,
      fileCount: input.fileCount ?? knowledge?.snapshots?.latest?.fileCount ?? null,
      moduleCount: input.moduleCount ?? null,
      primaryLanguage: input.primaryLanguage || knowledge?.snapshots?.latest?.primaryLang || null,
      projectRoot: input.projectRoot,
      projectType: input.projectType || null,
      secondaryLanguages: input.secondaryLanguages || [],
      scope: 'codex-host-project',
    },
    runtime: {
      aiProviderRequired: false,
      daemonRequiredForBootstrap: false,
      defaultRoute: 'plugin-owned-codex-facing',
      host: 'codex',
      owner: 'alembic-plugin',
      tool: 'alembic_bootstrap',
    },
    projectContext: buildProjectContextState(input),
    singleWriterLease: buildSingleWriterLeaseVisibility(input),
    session: sessionSummary,
    progress: {
      currentDimensionIds: context.dimensions.map((dimension) => dimension.id),
      dimensionCount: context.dimensions.length,
      stagedBy: 'plan-selection-dimensions',
    },
  };
}

function resolveBootstrapStatus(input: BuildOnboardingContractInput): string {
  if (input.projectRootTrusted === false) {
    return 'wrong_scope';
  }
  if (input.diagnosticsOk === false) {
    return 'degraded';
  }
  const knowledge = input.knowledge;
  if (!knowledge) {
    return input.source === 'bootstrap' ? 'bootstrap_ready' : 'needs_status_check';
  }
  if (!knowledge.initialized) {
    return knowledge.hasKnowledge ? 'needs_init_existing_knowledge' : 'needs_init';
  }
  if (knowledge.jobs?.bootstrapRunning) {
    return 'bootstrap_in_progress';
  }
  if (knowledge.status === 'knowledge_stale' || knowledge.sourceRefs?.status === 'stale') {
    return 'project_context_stale';
  }
  return knowledge.usable ? 'knowledge_ready' : 'initialized_empty';
}

function buildProjectContextState(input: BuildOnboardingContractInput): Record<string, unknown> {
  const sourceRefs = input.knowledge?.sourceRefs;
  const snapshots = input.knowledge?.snapshots;
  const freshness = input.knowledge?.freshness;
  const readiness =
    sourceRefs?.status === 'stale' || freshness?.stale === true
      ? 'graph_stale'
      : snapshots?.status === 'ready' || sourceRefs?.status === 'ready'
        ? 'needs_status_check'
        : 'not_yet_proven';
  return {
    acceptanceRule:
      'ProjectContext matrix/graph output is orientation evidence only; validate current behavior with raw source reads, Guard, and repository tests.',
    firstTool: 'alembic_recipe_map',
    freshnessStatus: freshness?.status || null,
    queryTools: CANONICAL_PROJECT_CONTEXT_TOOLS,
    readiness,
    sourceRefStatus: sourceRefs?.status || null,
    staleRecipeCount: sourceRefs?.staleRecipeCount ?? null,
    unsupportedStates: ['stale', 'pending', 'partial', 'wrong-scope', 'unsupported-language'],
  };
}

function buildSingleWriterLeaseVisibility(
  input: BuildOnboardingContractInput
): Record<string, unknown> {
  const activeBootstrap =
    input.knowledge?.jobs?.active.find((job) => job.kind === 'bootstrap') || null;
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    status: activeBootstrap ? 'held' : 'available',
    publicStatus: activeBootstrap ? 'bootstrap_in_progress' : 'no_active_bootstrap',
    leaseHolder: activeBootstrap
      ? {
          jobId: activeBootstrap.id,
          channelId: activeBootstrap.channelId || null,
          createdByTool: activeBootstrap.createdByTool || null,
          kind: activeBootstrap.kind,
          source: activeBootstrap.source || null,
          status: activeBootstrap.status,
        }
      : null,
    heartbeat: activeBootstrap
      ? {
          lastHeartbeatAt: activeBootstrap.updatedAt || activeBootstrap.createdAt || null,
          staleAfter:
            'Heartbeat visibility is exposed here; hard timeout enforcement belongs to a later lease-enforcement route.',
        }
      : null,
    takeoverRule: activeBootstrap
      ? 'Do not start a second bootstrap writer. Re-check alembic_status and wait, or let a later lease-enforcement slice decide takeover.'
      : 'No active bootstrap writer is visible; alembic_bootstrap may start or resume the Codex-owned bootstrap route.',
    sharedEntrypoints: [
      'Codex host-agent alembic_bootstrap',
      'Plugin job route alembic_job',
      'Alembic daemon job provider',
    ],
    enforcementBoundary:
      'Visibility-only; this field does not implement hard lease gate enforcement.',
  };
}

function buildToolCapabilities(entries: PluginToolSurfaceEntry[]): Record<string, unknown> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    source: 'PluginToolSurfaceCatalog',
    visibleToolNames: entries.map((entry) => entry.name),
    canonicalProjectContext: summarizeToolGroup(CANONICAL_PROJECT_CONTEXT_TOOLS, byName),
    knowledgeAndRecipes: summarizeToolGroup(KNOWLEDGE_AND_RECIPE_TOOLS, byName),
    guardAndValidation: summarizeToolGroup(GUARD_AND_VALIDATION_TOOLS, byName),
    bootstrapAndRecovery: summarizeToolGroup(BOOTSTRAP_AND_RECOVERY_TOOLS, byName),
  };
}

function summarizeToolGroup(
  toolNames: readonly string[],
  byName: Map<string, PluginToolSurfaceEntry>
): Array<Record<string, unknown>> {
  return toolNames
    .map((toolName) => byName.get(toolName))
    .filter((entry): entry is PluginToolSurfaceEntry => Boolean(entry))
    .map((entry) => ({
      annotations: {
        readOnlyHint: entry.annotations.readOnlyHint,
        destructiveHint: entry.annotations.destructiveHint,
        idempotentHint: entry.annotations.idempotentHint,
        openWorldHint: entry.annotations.openWorldHint,
      },
      handlerOwner: entry.handlerOwner,
      knowledgeGate: entry.knowledgeGate,
      name: entry.name,
      owner: entry.owner,
      residentRoutePolicy: entry.residentRoutePolicy,
      schema: entry.schema,
      tier: entry.tier,
    }));
}

function buildPlanNeutralDimensionGuidance(dimensions: DimensionSummary[]): Record<string, unknown> {
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    source: 'plan-selection-dimensions',
    currentTier: null,
    dimensionIds: dimensions.map((dimension) => dimension.id),
    dimensions: dimensions.map((dimension) => ({
      dimensionId: dimension.id,
      title: dimension.title,
      tier: dimension.tier,
      analysisGuide: null,
      submissionSpec: null,
    })),
    note:
      'Bootstrap replaces this status-level summary with executionPlan current-tier guidance from the Mission Briefing; no static task-decomposition playbook is used.',
    requiredEvidenceFields: buildRequiredEvidenceFields(),
    invalidConclusions: [
      'do not infer current work from retired static task queues',
      'do not submit Recipes without the current plan dimension analysisGuide/submissionSpec',
    ],
  };
}

function buildHostAgentContract(
  input: BuildOnboardingContractInput,
  context: { languageProfile: Record<string, unknown>; toolSurface: PluginToolSurfaceEntry[] }
): Record<string, unknown> {
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    source: 'host-agent-plan-neutral-quality-contract',
    scopeBrief: buildScopeBrief(input),
    toolCapabilityMatrix: buildToolCapabilityMatrix(context.toolSurface),
    stagedProtocol: [
      'Read bootstrapState and confirm project identity, runtime route, ProjectContext readiness, and current plan tier.',
      'Use currentDimensionGuidance for the executionPlan tier and keep source evidence tied to file paths or symbols.',
      'Before submit, draft against submitKnowledgeContract so the first alembic_submit_knowledge call is already schema-complete and source-grounded.',
      'Complete only the current plan dimensions after session-bound Recipe ids and analysis evidence are recorded.',
    ],
    languageOverlayContract: context.languageProfile,
    recipeGuidanceFloor: buildRecipeGuidanceFloor(),
    projectContextCreationGuide: buildProjectContextCreationGuide({
      projectRoot: input.projectRoot,
      stage: input.source === 'status' ? 'submit-knowledge' : 'bootstrap',
    }),
    recipeOntology: buildRecipeOntologyContract(),
    recipeAuthoringRubric: buildRecipeAuthoringRubric(),
    submitKnowledgeContract: buildSubmitKnowledgeContract(),
    dimensionCompletionContract: buildDimensionCompletionContract(),
    knowledgeResetContract: buildKnowledgeResetContract(),
    recipeCreationSop: [
      'Check ProjectContext matrix/graph orientation first.',
      'Collect exact source facts with file paths, symbols, and relationship evidence from ProjectContext detail refs or raw source reads.',
      'Draft candidates against submitKnowledgeContract before calling alembic_submit_knowledge; do not rely on tool rejection to discover missing fields.',
      'Compare with existing Recipes before submitting a new candidate.',
      'Submit only project-specific, reusable guidance.',
      'Complete the dimension only after candidates, no-op reasons, and validation notes are recorded.',
    ],
    requiredEvidenceFields: buildRequiredEvidenceFields(),
    qualityGates: [
      'No generic advice without project-specific source evidence.',
      'No bare filename claims without symbol or snippet context.',
      'No relationship claim without ProjectContext relation/detail refs or raw source fallback.',
      'No acceptance from ProjectContext output alone; run matching repository validation.',
    ],
    repairPrompts: [
      'If ProjectContext is stale or partial, use raw file reads and state the uncertainty.',
      'If runtime transport closes, repair MCP/plugin transport before using live-output claims.',
      'If scope differs from the host project, stop and resolve project identity.',
    ],
    resumePrompt: {
      bootstrapSessionRefField: 'bootstrapState.session.id',
      resumeTools: ['alembic_status', 'alembic_bootstrap'],
      rule: 'After MCP process restart, read status, compare project identity, then resume from executionPlan/currentDimensionGuidance instead of starting a hidden second bootstrap writer.',
    },
    stopConditions: [
      'project root or data root mismatch',
      'another bootstrap writer holds the lease',
      'ProjectContext stale/partial/wrong-scope used as final proof',
      'language overlay missing without generic fallback uncertainty',
      'Recipe floor cannot be met and no no-op reason is recorded',
      'runtime transport lacks real MCP readback',
    ],
    renderingBudget: {
      currentDimensionGuidance:
        'executionPlan current tier plus matching dimensions[].analysisGuide/submissionSpec only',
      hostAgentContract:
        'plan-neutral quality contract; no retired static playbook or duplicate task decomposition',
    },
    llmParticipationBoundary:
      'This SOP pack is deterministic plugin output. Codex is responsible for judgment; plugin runtime does not perform provider-backed Recipe writing on the default route.',
  };
}

function buildRequiredEvidenceFields(): string[] {
  return [
    'repo-relative file path',
    'line citation',
    'module attribution',
    'sourceRefs',
    'ProjectContext relation/detail refs when making caller/callee/impact claims',
    'validation command or explicit no-op reason',
  ];
}

function buildRecipeOntologyContract(): Record<string, unknown> {
  return {
    candidateKinds: ['rule', 'pattern', 'boundary', 'workflow', 'validation', 'failure-mode'],
    sourceFactKinds: ['file', 'symbol', 'call-chain', 'command-output', 'runtime-json'],
    notRecipe: [
      'generic language advice',
      'raw directory inventory without future action guidance',
      'tool output pasted without reusable project rule',
      'relationship claim without source or graph proof',
    ],
    rejectionReasons: [
      'generic-advice',
      'unsupported-relationship',
      'duplicate-existing-recipe',
      'padding-without-project-signal',
    ],
  };
}

function buildRecipeAuthoringRubric(): Record<string, unknown> {
  return {
    sourceGroundedSpecificity:
      'Recipe text must name this project boundary, exact source refs, and concrete when/when-not clauses.',
    relationshipProof:
      'Caller, callee, impact, dependency, and ownership claims require graph refs or explicit raw-read fallback notes.',
    futureActionability:
      'A future Codex agent must be able to choose files, tools, validation, and stop conditions from the Recipe alone.',
    validationGuidance:
      'Every behavior-changing Recipe names the repository command, probe, or host check that validates it.',
    failureAndEdgeCases:
      'Failure modes, degraded states, and recovery paths are part of the candidate, not optional prose.',
    dimensionCoverage:
      'A dimension is complete only after strong candidates or explicit no-op reasons cover the staged plan dimension.',
    duplicateAndShallowRejection:
      'Duplicate titles, shallow restatements, and candidates without project-specific evidence are rejected.',
  };
}

function buildSubmitKnowledgeContract(): Record<string, unknown> {
  return {
    tool: 'alembic_submit_knowledge',
    contract: 'V3',
    purpose:
      'Prepare valid candidates before the first submit call; rejection remains a safety net, not the normal instruction path.',
    exactFields: [
      'title',
      'description',
      'trigger',
      'language',
      'kind',
      'category',
      'knowledgeType',
      'content',
      'content.markdown',
      'content.rationale',
      'sourceRefs',
      'reasoning.sources',
      'reasoning.whyStandard',
      'reasoning.confidence',
      'doClause',
      'dontClause',
      'whenClause',
      'coreCode',
      'headers',
      'usageGuide',
      'dimensionId',
    ],
    fieldFloors: {
      title: 'Project-local title, <=20 chars when possible, no generic project-name prefix.',
      description: 'Concise project-specific summary, <=80 chars.',
      trigger: '@kebab-case unique trigger.',
      category: 'Use one of View/Service/Tool/Model/Network/Storage/UI/Utility.',
      contentMarkdown:
        '>=200 chars; include project-specific context, a code block when code behavior is claimed, and source labels.',
      coreCode:
        '3-8 syntactically complete lines copied or tightly adapted from cited source when code behavior is claimed.',
      usageGuide: 'Markdown with ### When to Use / Key Points / When Not to Use sections.',
      reasoningSources: 'Non-empty repo-relative paths with line ranges matching sourceRefs.',
      confidence: '>=0.85 for normal submit; otherwise narrow the candidate or keep analyzing.',
    },
    sourceRefCardinality: {
      universalRuleOrPattern:
        '>=3 distinct in-scope repo-relative file refs unless scope is explicitly narrow or file-local.',
      fact: 'At least one exact source ref; use more when the fact spans entrypoint, consumer, and validation.',
      relationshipClaim:
        'Requires caller/callee/impact/source-node evidence or an explicit raw-read fallback note.',
    },
    requiredBeforeSubmit: [
      'source evidence',
      'content.markdown >= 200 chars',
      'standard category',
      'specific reusable guidance',
      'when and when-not notes',
      '3-8 line coreCode matching cited source when code behavior is claimed',
      'validation or failure-path guidance',
    ],
    sourceRefRequirements: [
      'full repo-relative paths',
      'line citations for source facts',
      'matching snippet or coreCode evidence',
      'graph refs for relationship claims',
    ],
    relationshipGrounding: {
      status: 'additive-warning-plus-session-hard-gate',
      relationshipClaimFields: [
        'relationshipClaim',
        'requiresGraphEvidence',
        'relationshipEvidenceRequired',
        'relations',
        'relationships',
      ],
      acceptedGraphEvidenceFields: ['sourceGraphRefs', 'graphRefs', 'reasoning.graphRefs'],
      warningBoundary:
        'Normal submit responses return relationshipGrounding.needs-evidence for unbound relationship claims; session-bound production submissions remain hard-gated by the Recipe evidence gate.',
      nextTools: ['alembic_recipe_map', 'alembic_graph'],
    },
    failureCodes: [
      'missing-source-ref',
      'snippet-mismatch',
      'generic-content',
      'duplicate-candidate',
      'unsupported-relationship',
    ],
  };
}

function buildDimensionCompletionContract(): Record<string, unknown> {
  return {
    tool: 'alembic_dimension_complete',
    sessionField:
      'Use sessionId: bootstrapState.session.id. Do not send bootstrapSessionRef to alembic_dimension_complete; bootstrapSessionRef is accepted by alembic_submit_knowledge only.',
    requiredBeforeComplete: [
      'session-bound Recipe ids returned by alembic_submit_knowledge',
      'current dimension evidence summary tied to submitted sourceRefs',
      'residual risks and next dimension handoff notes',
    ],
    requiredFields: [
      'sessionId',
      'dimensionId',
      'submittedRecipeIds',
      'referencedFiles',
      'keyFindings',
      'analysisText',
      'candidateCount',
    ],
    optionalFields: [
      'unitId',
      'analysisUnitIds',
      'skippedAnalysisUnitIds',
      'rejectedAnalysisUnitIds',
      'remainingAnalysisUnitIds',
      'deviationReason',
      'crossDimensionHints',
    ],
    floors: {
      keyFindings: '3-5 concrete findings',
      analysisText: '>=500 chars and source-backed',
      referencedFiles: 'non-empty and overlapping submitted candidates',
      submittedRecipeIds:
        'non-empty ids returned by this bootstrap session; never invent ids from titles',
    },
    checkpointRule:
      'Do not write progress/checkpoint completion when candidate ids, file overlap, findings, source refs, or quality pass are missing.',
    firstCallExample: {
      sessionId: 'bootstrapState.session.id',
      dimensionId: 'current dimension id',
      submittedRecipeIds: ['ids returned by alembic_submit_knowledge'],
      referencedFiles: ['repo-relative files used by submitted Recipe sourceRefs'],
      keyFindings: ['3-5 source-backed findings'],
      analysisText: '>=500 chars with headings, source summary, and code block where useful',
      candidateCount: 'number of submitted Recipe ids',
    },
  };
}

function buildKnowledgeResetContract(): Record<string, unknown> {
  return {
    tool: 'alembic_bootstrap',
    scopes: [
      'host-agent bootstrap session state',
      'generated candidates for the active bootstrap session',
      'ProjectContext freshness and partial markers produced by the bootstrap route',
      'staged dimension progress for Codex-owned cold start',
    ],
    backupByDefault: true,
    backupRef:
      'Every destructive reset must return a restoreRef or explain why no persisted state existed.',
    restoreRefSemantics:
      'restoreRef identifies the pre-reset knowledge/session snapshot and is safe to pass back to a recovery route.',
    ghostAwarePaths:
      'Use workspace/dataRoot from scopeBrief; Ghost mode writes Alembic data outside the source tree and must not mutate user source files.',
    idempotentRerun:
      'Repeating bootstrap with the same project and no new evidence resumes or replaces only Codex-owned bootstrap artifacts.',
    rule: 'Host-agent bootstrap resets and rebuilds deterministic analysis state, then waits for Codex to submit Recipes and complete staged dimensions.',
  };
}

function buildScopeBrief(input: BuildOnboardingContractInput): Record<string, unknown> {
  const storageMode =
    input.dataRoot && input.dataRoot !== input.projectRoot
      ? 'ghost-or-external-data-root'
      : 'project-root';
  return {
    selectedProject: {
      basename: path.basename(input.projectRoot),
      projectRoot: input.projectRoot,
      dataRoot: input.dataRoot || input.projectRoot,
      storageMode,
      projectType: input.projectType || null,
    },
    sourceRoot: input.projectRoot,
    languageStats: {
      primaryLanguage: input.primaryLanguage || null,
      secondaryLanguages: input.secondaryLanguages || [],
      source: input.primaryLanguage ? 'bootstrap-language-profile' : 'unavailable',
    },
    hardStops: [
      'wrong project root or data root',
      'untrusted Codex project root resolution',
      'host project handoff mismatch',
      'another bootstrap writer holds the lease',
      'stale or partial ProjectContext used as final proof',
    ],
  };
}

function buildToolCapabilityMatrix(
  entries: PluginToolSurfaceEntry[]
): Array<Record<string, unknown>> {
  const blockedForSop = new Set(['alembic_call_context', 'alembic_knowledge', 'alembic_structure']);
  return entries
    .filter((entry) => !blockedForSop.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      provides: describeToolProvides(entry.name),
      requiredInput: entry.schema,
      outputTrustLevel: describeToolTrust(entry),
      evidenceRefs: describeToolEvidenceRefs(entry.name),
      invalidConclusions: describeToolInvalidConclusions(entry.name),
      handlerOwner: entry.handlerOwner,
      knowledgeGate: entry.knowledgeGate,
      residentRoutePolicy: entry.residentRoutePolicy,
    }));
}

function describeToolProvides(toolName: string): string {
  if (toolName.endsWith('_status')) {
    return 'runtime, scope, freshness, and repair state';
  }
  if (
    CANONICAL_PROJECT_CONTEXT_TOOLS.includes(
      toolName as (typeof CANONICAL_PROJECT_CONTEXT_TOOLS)[number]
    )
  ) {
    return 'ProjectContext orientation, project nodes, relation hints, detail refs, and partial notes';
  }
  if (
    KNOWLEDGE_AND_RECIPE_TOOLS.includes(toolName as (typeof KNOWLEDGE_AND_RECIPE_TOOLS)[number])
  ) {
    if (toolName === 'alembic_recipe_map') {
      return 'compact project navigation matrix with detail refs and next actions';
    }
    if (toolName === 'alembic_graph') {
      return 'bounded project-internal graph relations, not Recipe coverage semantics';
    }
    if (toolName === 'alembic_search') {
      return 'compact search/get/expand project knowledge context with detail refs';
    }
    return 'Recipe and project knowledge workflow state';
  }
  if (
    GUARD_AND_VALIDATION_TOOLS.includes(toolName as (typeof GUARD_AND_VALIDATION_TOOLS)[number])
  ) {
    return 'advisory validation or Guard review evidence';
  }
  if (
    BOOTSTRAP_AND_RECOVERY_TOOLS.includes(toolName as (typeof BOOTSTRAP_AND_RECOVERY_TOOLS)[number])
  ) {
    return 'bootstrap, recovery, and Codex plugin lifecycle state';
  }
  return 'Codex-visible Alembic tool output';
}

function describeToolTrust(entry: PluginToolSurfaceEntry): string {
  if (entry.name === 'alembic_status') {
    return 'authoritative for tool choice and readiness, not a substitute for repository validation';
  }
  if (
    CANONICAL_PROJECT_CONTEXT_TOOLS.includes(
      entry.name as (typeof CANONICAL_PROJECT_CONTEXT_TOOLS)[number]
    )
  ) {
    return 'orientation evidence only; validate behavior with raw source reads, Guard, and repository checks';
  }
  if (entry.name === 'alembic_graph') {
    return 'read-only project graph evidence, not source freshness or Recipe coverage proof';
  }
  if (entry.name === 'alembic_code_guard') {
    return 'Guard evidence for scoped files or code, not whole-goal acceptance';
  }
  return entry.annotations.readOnlyHint
    ? 'read-only evidence'
    : 'write result requires follow-up readback';
}

function describeToolEvidenceRefs(toolName: string): string[] {
  if (
    CANONICAL_PROJECT_CONTEXT_TOOLS.includes(
      toolName as (typeof CANONICAL_PROJECT_CONTEXT_TOOLS)[number]
    )
  ) {
    return ['detailRefs', 'sourceEvidenceRefs'];
  }
  if (toolName === 'alembic_submit_knowledge') {
    return ['candidate ids', 'sourceRefs', 'Recipe refs'];
  }
  if (toolName === 'alembic_dimension_complete') {
    return ['dimension id', 'verified candidate ids', 'progress checkpoint'];
  }
  if (toolName === 'alembic_code_guard') {
    return ['guard result ref', 'scoped files'];
  }
  return ['tool structured output'];
}

function describeToolInvalidConclusions(toolName: string): string[] {
  if (
    CANONICAL_PROJECT_CONTEXT_TOOLS.includes(
      toolName as (typeof CANONICAL_PROJECT_CONTEXT_TOOLS)[number]
    )
  ) {
    return ['current behavior is proven without raw source reads or validation'];
  }
  if (toolName === 'alembic_submit_knowledge') {
    return ['dimension is complete'];
  }
  if (toolName === 'alembic_dimension_complete') {
    return ['whole project cold start is accepted by the controller'];
  }
  return ['controller acceptance or user-visible completion'];
}

function buildLanguageProfile(input: BuildOnboardingContractInput): Record<string, unknown> {
  const languages = normalizeLanguages(input.primaryLanguage, input.secondaryLanguages || []);
  const overlays =
    languages.length > 0 ? languages.map(buildLanguageOverlay) : [buildGenericOverlay(null)];
  const fallbackLanguages = overlays
    .filter((overlay) => overlay.id === 'generic-fallback')
    .map((overlay) => overlay.language);
  return {
    source: 'host-agent-language-overlay-contract',
    selectedLanguages: languages,
    selectedOverlays: overlays,
    genericFallbackUsed: fallbackLanguages.length > 0,
    fallbackLanguages,
    uncertaintyMarked:
      fallbackLanguages.length > 0 || languages.length === 0 || input.primaryLanguage === null,
    selectionRule:
      'Select overlays from project language stats; compose multiple overlays and mark generic fallback uncertainty when no exact overlay exists.',
    runtimeLlmGeneration: false,
  };
}

function normalizeLanguages(
  primaryLanguage?: string | null,
  secondaryLanguages: string[] = []
): string[] {
  const seen = new Set<string>();
  return [primaryLanguage || '', ...secondaryLanguages]
    .map((language) => language.trim())
    .filter((language) => language.length > 0)
    .map(normalizeLanguageName)
    .filter((language) => {
      if (seen.has(language)) {
        return false;
      }
      seen.add(language);
      return true;
    });
}

function normalizeLanguageName(language: string): string {
  const value = language.toLowerCase();
  if (['ts', 'tsx', 'typescript', 'javascript', 'js', 'jsx', 'node'].includes(value)) {
    return 'typescript-node';
  }
  if (value.includes('swift')) {
    return 'swift';
  }
  if (value.includes('python') || value === 'py') {
    return 'python';
  }
  if (value === 'go' || value === 'golang') {
    return 'go';
  }
  if (value === 'rust' || value === 'rs') {
    return 'rust';
  }
  if (['java', 'kotlin', 'scala', 'jvm'].includes(value)) {
    return 'jvm';
  }
  return value;
}

function buildLanguageOverlay(language: string): LanguageOverlaySummary {
  switch (language) {
    case 'typescript-node':
      return {
        id: 'typescript-node',
        language,
        confidence: 'full',
        inspect: ['package.json', 'tsconfig.json', 'exports/bin maps', 'Vitest or Jest config'],
        grounding: ['TypeScript Handbook', 'Node.js ESM documentation', 'npm exports'],
        uncertainty: null,
      };
    case 'swift':
      return {
        id: 'swift',
        language,
        confidence: 'full',
        inspect: ['Package.swift or Xcode targets', 'access control', 'XCTest layout'],
        grounding: ['Swift API Design Guidelines', 'Swift Package Manager documentation'],
        uncertainty: null,
      };
    case 'python':
      return {
        id: 'python',
        language,
        confidence: 'full',
        inspect: ['pyproject.toml', 'package layout', 'pytest or unittest config'],
        grounding: ['Python packaging guide', 'PEP 8 as fallback after project config'],
        uncertainty: null,
      };
    case 'go':
    case 'rust':
    case 'jvm':
      return {
        id: `${language}-compact`,
        language,
        confidence: 'reduced',
        inspect: ['package or module manifest', 'test layout', 'public API boundary'],
        grounding: ['official language tooling and package documentation'],
        uncertainty: 'Compact overlay is available; mark unsupported areas explicitly.',
      };
    default:
      return buildGenericOverlay(language);
  }
}

function buildGenericOverlay(language: string | null): LanguageOverlaySummary {
  return {
    id: 'generic-fallback',
    language: language || 'unknown',
    confidence: 'reduced',
    inspect: ['project manifests', 'entrypoint files', 'test configuration', 'style/lint config'],
    grounding: ['project-local configuration first', 'official language docs only as fallback'],
    uncertainty:
      'No exact language overlay is available; mark confidence limits and unsupported parse areas in Recipes.',
  };
}

function buildRecipeGuidanceFloor(): Record<string, unknown> {
  return {
    source:
      'AlembicCore DimensionSop, PRE_SUBMIT_CHECKLIST, SHARED_SUBMIT_CHECKLIST, and MissionBriefingBuilder submission spec',
    candidateCounts: {
      minimumPerDimension: 3,
      targetPerDimension: 5,
      oneOrTwoIsFailing: true,
      noPadding: true,
    },
    fileReferences: {
      crossModuleClaimFloor: '>=3 distinct in-scope file refs when applicable',
      citationFormat: 'full repo-relative path plus line citation',
      bareFilenameForbidden: true,
      moduleAttributionRequired: true,
    },
    projectContextAnchoring: {
      requiredBeforeRecipeCreation: true,
      firstTools: ['alembic_recipe_map', 'alembic_graph'],
      compareTools: ['alembic_search', 'alembic_prime'],
      rule: 'Use ProjectContext refs and Recipe mounts before authoring; relationship claims need graph/detail refs or an explicit raw-read fallback.',
    },
    candidateContent: {
      allowedCategories: [
        'View',
        'Service',
        'Tool',
        'Model',
        'Network',
        'Storage',
        'UI',
        'Utility',
      ],
      categoryOtherValuesWarn: true,
      descriptionMaximumChars: 80,
      titleMaximumChars: 20,
      markdownMinimumChars: 200,
      coreCodeLines: '3-8 syntactically complete lines when code skeleton is needed',
      coreCodeMustMatchSourceRefs: true,
      requiresDoDontWhenClauses: true,
      confidenceFloorBeforeSubmit: 0.85,
      requiredFieldsBeforeFirstSubmit: [
        'title',
        'description',
        'trigger',
        'language',
        'kind',
        'category',
        'knowledgeType',
        'doClause',
        'dontClause',
        'whenClause',
        'coreCode',
        'headers',
        'usageGuide',
        'content.markdown',
        'content.rationale',
        'reasoning.whyStandard',
        'reasoning.sources',
        'reasoning.confidence',
        'sourceRefs',
      ],
    },
    dedup: {
      crossDimensionTitleDuplicatesRejected: true,
      duplicateExistingRecipeRejected: true,
    },
    dimensionComplete: {
      referencedFiles: 'required',
      keyFindings: '3-5 concrete findings',
      analysisText: '>=500 chars with source-backed detail',
    },
  };
}

function buildAgentDecisionChecklist(): Array<Record<string, unknown>> {
  return [
    {
      when: 'bootstrapState.status is wrong_scope, degraded, or project_root_unresolved',
      nextTool: 'alembic_status',
      blockedConclusions: ['do not use ProjectContext facts', 'do not submit Recipes'],
    },
    {
      when: 'bootstrapState.status is bootstrap_in_progress',
      nextTool: 'alembic_status',
      blockedConclusions: ['do not start a second bootstrap writer'],
    },
    {
      when: 'projectContext readiness is not proven',
      nextTool: 'alembic_recipe_map',
      blockedConclusions: ['do not claim ProjectContext completeness'],
    },
    {
      when: 'current plan dimension needs source evidence',
      nextTool: 'alembic_graph',
      blockedConclusions: ['do not submit generic or source-free Recipes'],
    },
  ];
}

function buildGates(): Record<string, unknown> {
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    scope: {
      rule: 'Project root and data root must match the active Codex host project before source facts can be trusted.',
      firstRepairTool: 'alembic_status',
    },
    projectContext: {
      rule: 'Use alembic_recipe_map and alembic_graph for compact ProjectContext orientation before broad raw exploration.',
      degradedStates: ['stale', 'pending', 'partial', 'wrong-scope', 'unsupported-language'],
    },
    sourceEvidence: {
      rule: 'Recipe candidates require exact source references, not ProjectContext labels alone.',
      acceptableRefs: [
        'file path',
        'symbol id',
        'ProjectContext detail ref',
        'relation hint',
        'command output',
      ],
    },
    relationshipEvidence: {
      rule: 'Caller, callee, and impact claims require ProjectContext relation/detail evidence or raw source fallback.',
      preferredTools: ['alembic_recipe_map', 'alembic_graph'],
    },
    validation: {
      rule: 'ProjectContext orientation is advisory; acceptance still requires Guard, repository tests, or targeted host checks.',
      preferredTools: ['alembic_code_guard'],
    },
    runtimeTransport: {
      rule: 'Live Codex usability requires a real MCP/tool readback, not only a unit test.',
      knownFailureClass: 'transport-closed',
    },
  };
}

function buildProgress(dimensions: DimensionSummary[]): Record<string, unknown> {
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    stage: 'plan-dimensions-ready',
    currentDimensionIds: dimensions.map((dimension) => dimension.id),
    completedDimensionIds: [],
    pendingDimensionIds: dimensions.map((dimension) => dimension.id),
    dimensionCount: dimensions.length,
    nextRequiredTools: [
      'alembic_recipe_map',
      'alembic_graph',
      'alembic_submit_knowledge',
      'alembic_dimension_complete',
    ],
  };
}

function buildRepairState(
  input: BuildOnboardingContractInput,
  bootstrapState: Record<string, unknown>
): Record<string, unknown> {
  const status = typeof bootstrapState.status === 'string' ? bootstrapState.status : 'unknown';
  const reasons: string[] = [];
  if (status === 'wrong_scope') {
    reasons.push('project scope or host handoff is not trusted');
  }
  if (status === 'degraded') {
    reasons.push('runtime diagnostics are not healthy');
  }
  if (status === 'project_context_stale') {
    reasons.push('knowledge source refs or ProjectContext freshness are stale');
  }
  if (status === 'bootstrap_in_progress') {
    reasons.push('single-writer bootstrap lease is already held');
  }
  if (input.knowledge?.jobs?.bootstrapRunning) {
    reasons.push('bootstrap job is already running');
  }
  const waiting = status === 'bootstrap_in_progress';
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    status: waiting ? 'waiting' : reasons.length > 0 ? 'repair-needed' : 'ready',
    reasons,
    rebuildRequired: status === 'project_context_stale',
    firstRepairTool:
      status === 'wrong_scope' || status === 'degraded'
        ? 'alembic_status'
        : status === 'project_context_stale'
          ? 'alembic_recipe_map'
          : waiting
            ? 'alembic_status'
            : null,
    safeFallback:
      'Use raw file reads/search plus repository validation when ProjectContext is unavailable or stale.',
    blockedConclusions: [
      'do not claim ProjectContext completeness without matrix/graph evidence',
      'do not claim live Codex usability without a real MCP/tool readback',
      'do not mark a dimension complete without evidence or an explicit no-op reason',
      'do not start a second bootstrap writer while bootstrap_in_progress is visible',
    ],
  };
}

function buildCurrentDimensionNextActions(
  input: BuildOnboardingContractInput
): Array<Record<string, unknown>> {
  const stage = input.source === 'status' ? 'submit-knowledge' : 'bootstrap';
  const actions = [
    ...buildProjectContextCreationNextActions({
      projectRoot: input.projectRoot,
      stage,
    }).map((action) => ({
      ...action,
      label:
        action.tool === 'alembic_submit_knowledge'
          ? 'Submit source-grounded Recipe candidates for current plan dimensions'
          : 'Collect ProjectContext evidence for current plan dimensions',
    })),
    {
      label: 'Complete only after current dimension evidence and session-bound Recipe ids exist',
      tool: 'alembic_dimension_complete',
    },
  ];
  return actions.map((action, index) => ({
    ...action,
    order: index + 1,
    required: index < 2,
  }));
}

function summarizeDimensions(value: unknown): DimensionSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => summarizeDimension(item, index));
}

function summarizeDimension(value: unknown, index: number): DimensionSummary {
  const record = isRecord(value) ? value : {};
  const id =
    readString(record.id) ||
    readString(record.dimensionId) ||
    readString(record.key) ||
    `dimension-${index + 1}`;
  const title = readString(record.title) || readString(record.name) || id;
  const tier =
    typeof record.tier === 'number' && Number.isFinite(record.tier) ? record.tier : null;
  return { id, tier, title };
}

function summarizeSession(value: unknown, dimensionCount: number): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  return {
    id: readString(record.id) || readString(record.sessionId) || null,
    dimensionCount,
    active: Boolean(readString(record.id) || readString(record.sessionId)),
    source: 'host-agent-bootstrap',
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
