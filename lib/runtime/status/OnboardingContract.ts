import path from 'node:path';
import type { CodexHostProjectAlignment } from '../../runtime/HostProjectAlignment.js';
import type { HostKnowledgeState } from '../../runtime/KnowledgeState.js';
import {
  listPluginToolSurfaceCatalog,
  type PluginToolSurfaceEntry,
} from '../../runtime/mcp/PluginToolSurfaceCatalog.js';

export const CODEX_ONBOARDING_CONTRACT_VERSION = 1;

const CANONICAL_PROJECT_CONTEXT_TOOLS = ['alembic_recipe_map', 'alembic_graph'] as const;

const KNOWLEDGE_AND_RECIPE_TOOLS = [
  'alembic_recipe_map',
  'alembic_prime',
  'alembic_search',
  'alembic_graph',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
] as const;

const GUARD_AND_VALIDATION_TOOLS = ['alembic_code_guard'] as const;

const BOOTSTRAP_AND_RECOVERY_TOOLS = [
  'alembic_status',
  'alembic_mcp_init',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_job',
] as const;

interface DimensionSummary {
  id: string;
  title: string;
}

interface DomainPlaybook {
  domainId: string;
  title: string;
  goal: string;
  keywordHints: string[];
  requiredEvidence: string[];
  toolSequence: string[];
  toolToInformation: Array<{ information: string; tool: string }>;
}

interface DomainQueueEntry {
  dimensionRefs: string[];
  domainId: string;
  nextActionTool: string;
  reason: string;
  requiredEvidence: string[];
  status: string;
  title: string;
  toolSequence: string[];
}

interface LanguageOverlaySummary {
  confidence: 'full' | 'reduced';
  grounding: string[];
  id: string;
  inspect: string[];
  language: string;
  uncertainty: string | null;
}

export interface CodexOnboardingContract {
  bootstrapState: Record<string, unknown>;
  currentDomainNextActions: Array<Record<string, unknown>>;
  currentDomainSop: Record<string, unknown>;
  domainQueue: DomainQueueEntry[];
  gates: Record<string, unknown>;
  initialToolBriefing: Record<string, unknown>;
  progress: Record<string, unknown>;
  repairState: Record<string, unknown>;
  sopPack: Record<string, unknown>;
  toolCapabilities: Record<string, unknown>;
}

export interface BuildCodexOnboardingContractInput {
  dataRoot?: string;
  diagnosticsOk?: boolean;
  dimensions?: unknown;
  fileCount?: number | null;
  hostProjectAlignment?: CodexHostProjectAlignment;
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

const DOMAIN_PLAYBOOKS: DomainPlaybook[] = [
  {
    domainId: 'D1-runtime-entrypoints',
    title: 'Runtime And Entrypoints',
    goal: 'Identify real commands, package exports, runtime entrypoints, and host-owned execution paths before describing behavior.',
    keywordHints: ['runtime', 'entry', 'cli', 'daemon', 'mcp', 'bootstrap', 'server'],
    toolSequence: ['alembic_recipe_map', 'alembic_graph', 'alembic_search'],
    toolToInformation: [
      {
        tool: 'alembic_recipe_map',
        information:
          'ProjectContext orientation, key modules, entrypoints, detail refs, and partial notes',
      },
      {
        tool: 'alembic_graph',
        information: 'ProjectContext-backed entrypoint, package, file, symbol, and relation hints',
      },
      {
        tool: 'alembic_search',
        information: 'prior Recipes and decisions relevant to runtime entrypoint conventions',
      },
    ],
    requiredEvidence: [
      'entrypoint file path and exported symbol',
      'caller or command that reaches the entrypoint',
      'validation command that exercises the runtime path',
    ],
  },
  {
    domainId: 'D2-source-structure-ownership',
    title: 'Source Structure And Ownership',
    goal: 'Map owned modules, boundaries, and cross-package imports without moving responsibility between repositories.',
    keywordHints: ['architecture', 'module', 'package', 'ownership', 'boundary', 'dependency'],
    toolSequence: ['alembic_recipe_map', 'alembic_graph', 'alembic_search'],
    toolToInformation: [
      {
        tool: 'alembic_recipe_map',
        information: 'directory and module inventory for the requested scope',
      },
      {
        tool: 'alembic_graph',
        information: 'bounded dependency, import/export, entrypoint, and ownership relations',
      },
    ],
    requiredEvidence: [
      'module owner and repository boundary',
      'import path or package export that proves the boundary',
      'consumer that would break if ownership is changed',
    ],
  },
  {
    domainId: 'D3-state-persistence',
    title: 'State And Persistence',
    goal: 'Trace data roots, persisted files, sessions, job state, and recovery markers before writing lifecycle guidance.',
    keywordHints: ['state', 'persistence', 'session', 'job', 'database', 'storage'],
    toolSequence: ['alembic_recipe_map', 'alembic_graph', 'alembic_search'],
    toolToInformation: [
      {
        tool: 'alembic_graph',
        information:
          'ProjectContext file/module/function relation hints for state readers and writers',
      },
      {
        tool: 'alembic_search',
        information: 'existing project rules or decisions about persisted state',
      },
    ],
    requiredEvidence: [
      'state file, database table, or session field name',
      'writer and reader call chain',
      'recovery or cleanup behavior for stale state',
    ],
  },
  {
    domainId: 'D4-tool-contracts-output',
    title: 'Tool Contracts And Outputs',
    goal: 'Confirm MCP schemas, clean output fields, and host-facing tool semantics before changing tool guidance.',
    keywordHints: ['tool', 'mcp', 'schema', 'output', 'contract', 'structuredcontent'],
    toolSequence: ['alembic_recipe_map', 'alembic_graph', 'alembic_code_guard'],
    toolToInformation: [
      {
        tool: 'alembic_recipe_map',
        information: 'tool declaration, handler-owner, and output-contract orientation',
      },
      {
        tool: 'alembic_graph',
        information: 'bounded schema/handler/projector relation detail',
      },
    ],
    requiredEvidence: [
      'tool name, input schema, and output field contract',
      'handler owner and runtime route',
      'test or probe that reads the structured output',
    ],
  },
  {
    domainId: 'D5-validation-safety',
    title: 'Validation And Safety',
    goal: 'Choose checks that match the actual behavior changed, then separate ProjectContext orientation from acceptance.',
    keywordHints: ['test', 'validation', 'guard', 'safety', 'lint', 'check'],
    toolSequence: ['alembic_recipe_map', 'alembic_graph', 'alembic_code_guard'],
    toolToInformation: [
      {
        tool: 'alembic_graph',
        information: 'candidate affected modules, entrypoints, and relation hints',
      },
      {
        tool: 'alembic_code_guard',
        information: 'Recipe/Guard review after meaningful edits with explicit files',
      },
    ],
    requiredEvidence: [
      'command output or host probe result',
      'why the validation matches the changed behavior',
      'explicit residual risk when a recommended check cannot run',
    ],
  },
  {
    domainId: 'D6-failure-recovery',
    title: 'Failure And Recovery',
    goal: 'Describe degraded states, repair triggers, and rebuild requirements without hiding transport or ProjectContext partial-state failures.',
    keywordHints: ['failure', 'error', 'recovery', 'diagnostics', 'degraded', 'stale'],
    toolSequence: ['alembic_status', 'alembic_recipe_map', 'alembic_graph'],
    toolToInformation: [
      {
        tool: 'alembic_status',
        information: 'runtime, initialization, knowledge, and repair state',
      },
      {
        tool: 'alembic_recipe_map',
        information: 'ProjectContext freshness, partial notes, and current project orientation',
      },
    ],
    requiredEvidence: [
      'failure state or error code',
      'first repair action and owner',
      'stop condition that prevents false acceptance',
    ],
  },
  {
    domainId: 'D7-project-conventions',
    title: 'Project Conventions',
    goal: 'Turn repeated, source-backed project rules into Recipes only after evidence and boundary checks are present.',
    keywordHints: ['convention', 'standard', 'style', 'recipe', 'rule', 'pattern'],
    toolSequence: [
      'alembic_prime',
      'alembic_search',
      'alembic_submit_knowledge',
      'alembic_dimension_complete',
    ],
    toolToInformation: [
      {
        tool: 'alembic_prime',
        information: 'existing Recipes and prior project guidance before adding candidates',
      },
      {
        tool: 'alembic_submit_knowledge',
        information: 'submit only source-grounded, reusable Recipe candidates',
      },
    ],
    requiredEvidence: [
      'specific source facts or commands behind the convention',
      'when and when-not guidance',
      'validation and edge-case notes',
    ],
  },
];

export function buildCodexColdStartOnboardingContract(
  input: BuildCodexOnboardingContractInput
): CodexOnboardingContract {
  return buildCodexOnboardingContract({ ...input, source: 'bootstrap' });
}

export function buildCodexStatusOnboardingContract(
  input: BuildCodexOnboardingContractInput
): CodexOnboardingContract {
  return buildCodexOnboardingContract({ ...input, source: 'status' });
}

function buildCodexOnboardingContract(
  input: BuildCodexOnboardingContractInput
): CodexOnboardingContract {
  const dimensions = summarizeDimensions(input.dimensions);
  const domainQueue = buildDomainQueue(dimensions);
  const currentDomain = domainQueue[0] || buildDomainQueue([])[0];
  const currentPlaybook = DOMAIN_PLAYBOOKS.find(
    (playbook) => playbook.domainId === currentDomain?.domainId
  );
  const toolSurface = listPluginToolSurfaceCatalog();
  const languageProfile = buildLanguageProfile(input);
  const currentDomainSop = buildCurrentDomainSop(currentPlaybook || DOMAIN_PLAYBOOKS[0], {
    languageProfile,
  });
  const toolCapabilities = buildToolCapabilities(toolSurface);
  const bootstrapState = buildBootstrapState(input, {
    currentDomainId: currentDomain?.domainId || DOMAIN_PLAYBOOKS[0].domainId,
    dimensions,
  });
  const progress = buildProgress(domainQueue, dimensions);
  const repairState = buildRepairState(input, bootstrapState);
  const currentDomainNextActions = buildCurrentDomainNextActions(currentDomainSop);
  const gates = buildGates();

  return {
    bootstrapState,
    currentDomainNextActions,
    currentDomainSop,
    domainQueue,
    gates,
    initialToolBriefing: {
      contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
      defaultOrder: [
        'alembic_status',
        'alembic_recipe_map',
        currentPlaybook?.toolSequence[1] || 'alembic_graph',
        'alembic_submit_knowledge',
        'alembic_dimension_complete',
      ],
      rule: 'Use ProjectContext matrix/graph for compact orientation; fall back to raw file reads and repository validation when project context is partial or ambiguous.',
      agentDecisionChecklist: buildAgentDecisionChecklist(currentDomainSop),
      blockedConclusionsField: 'repairState.blockedConclusions',
      evidenceFields: [
        'bootstrapState.projectIdentity',
        'bootstrapState.projectContext',
        'toolCapabilities',
        'currentDomainSop.requiredEvidence',
        'currentDomainSop.recipeGuidanceFloor',
      ],
      sopField: 'currentDomainSop',
      toolCapabilityField: 'toolCapabilities',
    },
    progress,
    repairState,
    sopPack: buildSopPack(input, { languageProfile, toolSurface }),
    toolCapabilities,
  };
}

function buildBootstrapState(
  input: BuildCodexOnboardingContractInput,
  context: { currentDomainId: string; dimensions: DimensionSummary[] }
): Record<string, unknown> {
  const knowledge = input.knowledge;
  const status = resolveBootstrapStatus(input);
  const sessionSummary = summarizeSession(input.session, context.dimensions.length);
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
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
      currentDomainId: context.currentDomainId,
      dimensionCount: context.dimensions.length,
      stagedDomainCount: DOMAIN_PLAYBOOKS.length,
    },
  };
}

function resolveBootstrapStatus(input: BuildCodexOnboardingContractInput): string {
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

function buildProjectContextState(
  input: BuildCodexOnboardingContractInput
): Record<string, unknown> {
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
  input: BuildCodexOnboardingContractInput
): Record<string, unknown> {
  const activeBootstrap =
    input.knowledge?.jobs?.active.find((job) => job.kind === 'bootstrap') || null;
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
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
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
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

function buildDomainQueue(dimensions: DimensionSummary[]): DomainQueueEntry[] {
  return DOMAIN_PLAYBOOKS.map((playbook, index) => {
    const dimensionRefs = dimensions
      .filter((dimension) => dimensionMatchesPlaybook(dimension, playbook))
      .map((dimension) => dimension.id);
    return {
      domainId: playbook.domainId,
      title: playbook.title,
      status: index === 0 ? 'current' : 'pending',
      reason:
        index === 0
          ? 'Start with runtime entrypoints so later Recipe claims have a real execution path.'
          : 'Pending until the previous domain has source-backed Recipe candidates or a documented no-op.',
      dimensionRefs,
      nextActionTool: playbook.toolSequence[0],
      requiredEvidence: playbook.requiredEvidence,
      toolSequence: playbook.toolSequence,
    };
  });
}

function dimensionMatchesPlaybook(dimension: DimensionSummary, playbook: DomainPlaybook): boolean {
  const text = `${dimension.id} ${dimension.title}`.toLowerCase();
  return playbook.keywordHints.some((hint) => text.includes(hint));
}

function buildCurrentDomainSop(
  playbook: DomainPlaybook,
  context: { languageProfile: Record<string, unknown> }
): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    domainId: playbook.domainId,
    title: playbook.title,
    goal: playbook.goal,
    stage: 'domain-discovery',
    toolSequence: playbook.toolSequence,
    toolToInformation: playbook.toolToInformation,
    languageProfile: context.languageProfile,
    sectionBoundaries: {
      maxCurrentDomainSteps: 8,
      maxOverlayCount: 3,
      renderedFrom: 'domain-sop-baseline-2026-06-12 plus current bootstrap state',
      runtimeLlmGeneration: false,
    },
    recipeGuidanceFloor: buildRecipeGuidanceFloor(),
    candidateVariety: {
      minimumPerDimension: 3,
      targetPerDimension: 5,
      requiredKinds: ['fact', 'rule', 'pattern'],
      noPaddingRule:
        'Submit fewer only when evidence is genuinely absent; never pad weak candidates to satisfy numeric targets.',
    },
    recipeOntologyReminders: [
      'Recipe candidates must describe reusable project guidance, not raw symbol dumps.',
      'Submit-ready candidates must already satisfy the submit_knowledge schema floor: content.markdown >= 200 chars, standard category, concrete sourceRefs, reasoning.sources, and a 3-8 line copyable coreCode when code behavior is claimed.',
      'Relationship claims require ProjectContext detail refs or raw source evidence, with uncertainty named when context is partial.',
      'A good Recipe states when to use it, when not to use it, and which validation proves the behavior.',
    ],
    recipeCreationSop: [
      'Check ProjectContext matrix/graph orientation first.',
      'Collect exact source facts with file paths, symbols, and relationship evidence from ProjectContext detail refs or raw source reads.',
      'Draft candidates against submitKnowledgeContract before calling alembic_submit_knowledge; do not rely on tool rejection to discover missing fields.',
      'Compare with existing Recipes before submitting a new candidate.',
      'Submit only project-specific, reusable guidance.',
      'Complete the dimension only after candidates, no-op reasons, and validation notes are recorded.',
    ],
    requiredEvidence: playbook.requiredEvidence,
    requiredEvidenceFields: [
      'repo-relative file path',
      'line citation',
      'module attribution',
      'sourceRefs',
      'ProjectContext relation/detail refs when making caller/callee/impact claims',
      'validation command or explicit no-op reason',
    ],
    rejectionExamples: buildDomainRejectionExamples(playbook.domainId),
    qualityGates: [
      'No generic advice without project-specific source evidence.',
      'No bare filename claims without symbol or snippet context.',
      'No relationship claim without ProjectContext relation/detail refs or raw source fallback.',
      'No acceptance from ProjectContext output alone; run matching repository validation.',
    ],
    repairRebuildRules: [
      'If scope is wrong, stop and resolve the project root before using source facts.',
      'If ProjectContext is partial or stale, use matrix/graph partial notes, fall back to raw file reads, and name the uncertainty.',
      'If transport closes, repair MCP/runtime transport before claiming live Codex usability.',
    ],
    stopConditions: [
      'wrong project root',
      'partial ProjectContext used as final proof',
      'missing validation for behavior-changing edits',
      'Recipe candidate lacks source-backed reusable guidance',
    ],
    completionRules: [
      'Every claim cites repo-relative file paths and line numbers or names a raw-read fallback.',
      'Every relationship claim cites ProjectContext relation/detail refs or explicitly marks context uncertainty.',
      'Every candidate includes content.markdown >= 200 chars, description <= 80 chars, a standard category, sourceRefs matching coreCode, and reasoning.sources before the first submit attempt.',
      'Dimension completion records referencedFiles, 3-5 keyFindings, and analysisText >= 500 chars.',
      'Cross-domain duplicates are rejected before submission.',
    ],
    nextActions: [
      {
        label: 'Read ProjectContext matrix',
        tool: 'alembic_recipe_map',
      },
      {
        label: `Collect evidence for ${playbook.title}`,
        tool: playbook.toolSequence[1] || 'alembic_graph',
      },
      {
        label: 'Submit source-grounded Recipe candidates',
        tool: 'alembic_submit_knowledge',
      },
      {
        label: 'Complete the staged domain only after evidence is recorded',
        tool: 'alembic_dimension_complete',
      },
    ],
    llmBoundary:
      'The plugin returns deterministic SOP guidance; Codex may reason over it, but the runtime does not call a server-side LLM on this route.',
  };
}

function buildSopPack(
  input: BuildCodexOnboardingContractInput,
  context: { languageProfile: Record<string, unknown>; toolSurface: PluginToolSurfaceEntry[] }
): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    source: 'wakeflow-ledger/domain-sop-baseline-2026-06-12',
    scopeBrief: buildScopeBrief(input),
    toolCapabilityMatrix: buildToolCapabilityMatrix(context.toolSurface),
    stagedProtocol: [
      'Read bootstrapState and confirm project identity, runtime route, ProjectContext readiness, and current domain.',
      'Run the currentDomainSop tool sequence and keep source evidence tied to file paths or symbols.',
      'Before submit, draft against submitKnowledgeContract so the first alembic_submit_knowledge call is already schema-complete and source-grounded.',
      'Complete the domain, then move to the next pending domain in domainQueue.',
    ],
    domainPlaybooks: buildDomainPlaybookContracts(),
    languageOverlayContract: context.languageProfile,
    recipeGuidanceFloor: buildRecipeGuidanceFloor(),
    recipeOntology: buildRecipeOntologyContract(),
    recipeAuthoringRubric: buildRecipeAuthoringRubric(),
    submitKnowledgeContract: buildSubmitKnowledgeContract(),
    dimensionCompletionContract: buildDimensionCompletionContract(),
    knowledgeResetContract: buildKnowledgeResetContract(),
    repairPrompts: [
      'If ProjectContext is stale or partial, use raw file reads and state the uncertainty.',
      'If runtime transport closes, repair MCP/plugin transport before using live-output claims.',
      'If scope differs from the host project, stop and resolve project identity.',
    ],
    nextDomainPrompt:
      'After the current domain passes dimension completion, read domainQueue for the next pending domain and repeat the same status, evidence, submit, and complete loop; skip only after controller/user decision records the block.',
    resumePrompt: {
      bootstrapSessionRefField: 'bootstrapState.session.id',
      resumeTools: ['alembic_status', 'alembic_bootstrap'],
      rule: 'After MCP process restart, read status, compare project identity, then resume the current domain from progress.currentDomainId instead of starting a hidden second bootstrap writer.',
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
      currentDomainSop: 'compact current domain plus selected language overlays only',
      sopPack: 'sectioned machine-readable fields; no giant free-form briefing',
      domainPlaybooks: 'stable seven-domain summaries with per-domain detail rendered on demand',
    },
    llmParticipationBoundary:
      'This SOP pack is deterministic plugin output. Codex is responsible for judgment; plugin runtime does not perform provider-backed Recipe writing on the default route.',
  };
}

function buildDomainPlaybookContracts(): Array<Record<string, unknown>> {
  return DOMAIN_PLAYBOOKS.map((playbook) => ({
    domainId: playbook.domainId,
    title: playbook.title,
    goal: playbook.goal,
    candidateVariety: {
      minimumPerDimension: 3,
      targetPerDimension: 5,
      requiredKinds: ['fact', 'rule', 'pattern'],
    },
    requiredEvidenceFields: [
      'sourceRefs',
      'repo-relative file path',
      'line citation',
      'module attribution',
      'validation or no-op reason',
    ],
    requiredEvidence: playbook.requiredEvidence,
    rejectionExamples: buildDomainRejectionExamples(playbook.domainId),
    completionRules: buildDomainCompletionRules(playbook.domainId),
    toolSequence: playbook.toolSequence,
  }));
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
      'A dimension is complete only after strong candidates or explicit no-op reasons cover the staged domain.',
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
      'current domain evidence summary tied to submitted sourceRefs',
      'residual risks and next domain handoff notes',
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
      'staged domain progress for Codex-owned cold start',
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
    rule: 'Host-agent bootstrap resets and rebuilds deterministic analysis state, then waits for Codex to submit Recipes and complete staged domains.',
  };
}

function buildScopeBrief(input: BuildCodexOnboardingContractInput): Record<string, unknown> {
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
  const blockedForSop = new Set([
    'alembic_call_context',
    'alembic_knowledge',
    'alembic_structure',
    'alembic_panorama',
  ]);
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
    return ['domain is complete'];
  }
  if (toolName === 'alembic_dimension_complete') {
    return ['whole project cold start is accepted by the controller'];
  }
  return ['controller acceptance or user-visible completion'];
}

function buildLanguageProfile(input: BuildCodexOnboardingContractInput): Record<string, unknown> {
  const languages = normalizeLanguages(input.primaryLanguage, input.secondaryLanguages || []);
  const overlays =
    languages.length > 0 ? languages.map(buildLanguageOverlay) : [buildGenericOverlay(null)];
  const fallbackLanguages = overlays
    .filter((overlay) => overlay.id === 'generic-fallback')
    .map((overlay) => overlay.language);
  return {
    source: 'domain-sop-baseline-2026-06-12',
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

function buildDomainRejectionExamples(domainId: string): string[] {
  const shared = [
    'generic advice that would fit any repository',
    'claim without repo-relative file and line evidence',
    'relationship claim without caller/callee/impact proof or raw-read fallback note',
  ];
  const specific: Record<string, string[]> = {
    'D1-runtime-entrypoints': ['entrypoint list copied from README without the real start chain'],
    'D2-source-structure-ownership': ['directory listing restated as architecture'],
    'D3-state-persistence': ['persistence lifecycle without writer and reader evidence'],
    'D4-tool-contracts-output': ['schema inventory without output projector or consumer evidence'],
    'D5-validation-safety': ['test-pyramid theory without this repository command names'],
    'D6-failure-recovery': ['recovery step that bypasses fail-closed project scope checks'],
    'D7-project-conventions': [
      'public style-guide content without project config or source precedent',
    ],
  };
  return [...(specific[domainId] || []), ...shared];
}

function buildDomainCompletionRules(domainId: string): string[] {
  const shared = [
    'minimum 3 / target 5 candidates per active dimension unless no-op is justified',
    'each candidate carries sourceRefs and module attribution',
    'dimension_complete includes referencedFiles, keyFindings, analysisText, and residual risk',
  ];
  const specific: Record<string, string[]> = {
    'D1-runtime-entrypoints': [
      'externally reachable start paths are documented with invocation proof',
    ],
    'D2-source-structure-ownership': [
      'top-level module ownership and dependency direction are evidenced',
    ],
    'D3-state-persistence': [
      'durable state families have owner, writer, reader, and change procedure',
    ],
    'D4-tool-contracts-output': [
      'public tool/route families have schema, projector, and change procedure',
    ],
    'D5-validation-safety': ['major change areas name exact checks and failure meaning'],
    'D6-failure-recovery': ['stable failure states map to meaning, recovery, and evidence surface'],
    'D7-project-conventions': [
      'enforced and practiced conventions are separated with config or examples',
    ],
  };
  return [...(specific[domainId] || []), ...shared];
}

function buildAgentDecisionChecklist(
  currentDomainSop: Record<string, unknown>
): Array<Record<string, unknown>> {
  const toolSequence = Array.isArray(currentDomainSop.toolSequence)
    ? currentDomainSop.toolSequence
    : [];
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
      when: 'current domain needs source evidence',
      nextTool: toolSequence[1] || 'alembic_graph',
      blockedConclusions: ['do not submit generic or source-free Recipes'],
    },
  ];
}

function buildGates(): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
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

function buildProgress(
  domainQueue: DomainQueueEntry[],
  dimensions: DimensionSummary[]
): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    stage: 'current-domain-ready',
    currentDomainId: domainQueue[0]?.domainId || DOMAIN_PLAYBOOKS[0].domainId,
    completedDomainIds: [],
    pendingDomainIds: domainQueue.map((domain) => domain.domainId),
    dimensionCount: dimensions.length,
    nextRequiredTools: [
      'alembic_recipe_map',
      'alembic_submit_knowledge',
      'alembic_dimension_complete',
    ],
  };
}

function buildRepairState(
  input: BuildCodexOnboardingContractInput,
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
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
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
      'do not mark a domain complete without evidence or an explicit no-op reason',
      'do not start a second bootstrap writer while bootstrap_in_progress is visible',
    ],
  };
}

function buildCurrentDomainNextActions(
  currentDomainSop: Record<string, unknown>
): Array<Record<string, unknown>> {
  const actions = Array.isArray(currentDomainSop.nextActions) ? currentDomainSop.nextActions : [];
  return actions
    .filter((action): action is Record<string, unknown> => isRecord(action))
    .map((action, index) => ({
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
  return { id, title };
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
