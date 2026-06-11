import path from 'node:path';
import type { CodexHostProjectAlignment } from '../HostProjectAlignment.js';
import type { CodexKnowledgeState } from '../KnowledgeState.js';
import {
  listPluginToolSurfaceCatalog,
  type PluginToolSurfaceEntry,
} from '../mcp/PluginToolSurfaceCatalog.js';

export const CODEX_ONBOARDING_CONTRACT_VERSION = 1;

const CANONICAL_SOURCE_GRAPH_TOOLS = [
  'alembic_source_graph_status',
  'alembic_code_explore',
  'alembic_symbol_search',
  'alembic_source_node',
  'alembic_callers',
  'alembic_callees',
  'alembic_code_impact',
  'alembic_validation_plan',
] as const;

const KNOWLEDGE_AND_RECIPE_TOOLS = [
  'alembic_intent',
  'alembic_prime',
  'alembic_search',
  'alembic_knowledge',
  'alembic_structure',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
] as const;

const GUARD_AND_VALIDATION_TOOLS = [
  'alembic_code_guard',
  'alembic_guard',
  'alembic_validation_plan',
] as const;

const BOOTSTRAP_AND_RECOVERY_TOOLS = [
  'alembic_codex_status',
  'alembic_codex_init',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_codex_bootstrap',
  'alembic_codex_rescan',
  'alembic_codex_job',
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
  knowledge?: CodexKnowledgeState;
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
    toolSequence: [
      'alembic_source_graph_status',
      'alembic_code_explore',
      'alembic_symbol_search',
      'alembic_source_node',
    ],
    toolToInformation: [
      {
        tool: 'alembic_source_graph_status',
        information: 'freshness, scope, and whether graph facts can be trusted',
      },
      {
        tool: 'alembic_code_explore',
        information: 'entrypoint files, package-level structure, and owned modules',
      },
      {
        tool: 'alembic_symbol_search',
        information: 'runtime functions, exported bins, and MCP handlers by symbol name',
      },
      {
        tool: 'alembic_source_node',
        information: 'exact source body before any Recipe candidate references it',
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
    toolSequence: [
      'alembic_source_graph_status',
      'alembic_code_explore',
      'alembic_symbol_search',
      'alembic_code_impact',
    ],
    toolToInformation: [
      {
        tool: 'alembic_code_explore',
        information: 'directory and module inventory for the requested scope',
      },
      {
        tool: 'alembic_code_impact',
        information: 'affected owners and files when a boundary changes',
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
    toolSequence: [
      'alembic_source_graph_status',
      'alembic_symbol_search',
      'alembic_callers',
      'alembic_callees',
      'alembic_source_node',
    ],
    toolToInformation: [
      {
        tool: 'alembic_callers',
        information: 'who writes or reads a persistence function',
      },
      {
        tool: 'alembic_callees',
        information: 'which storage helpers a workflow depends on',
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
    toolSequence: [
      'alembic_source_graph_status',
      'alembic_code_explore',
      'alembic_symbol_search',
      'alembic_validation_plan',
    ],
    toolToInformation: [
      {
        tool: 'alembic_validation_plan',
        information: 'advisory check buckets for schema and output contract changes',
      },
      {
        tool: 'alembic_symbol_search',
        information: 'tool declarations, handler owners, and projector symbols',
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
    goal: 'Choose checks that match the actual behavior changed, then separate advisory graph output from acceptance.',
    keywordHints: ['test', 'validation', 'guard', 'safety', 'lint', 'check'],
    toolSequence: [
      'alembic_source_graph_status',
      'alembic_code_impact',
      'alembic_validation_plan',
      'alembic_code_guard',
    ],
    toolToInformation: [
      {
        tool: 'alembic_code_impact',
        information: 'candidate affected runtime paths and likely validation scope',
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
    goal: 'Describe degraded states, repair triggers, and rebuild requirements without hiding transport or graph freshness failures.',
    keywordHints: ['failure', 'error', 'recovery', 'diagnostics', 'degraded', 'stale'],
    toolSequence: [
      'alembic_codex_status',
      'alembic_source_graph_status',
      'alembic_symbol_search',
      'alembic_validation_plan',
    ],
    toolToInformation: [
      {
        tool: 'alembic_codex_status',
        information: 'runtime, initialization, knowledge, and repair state',
      },
      {
        tool: 'alembic_source_graph_status',
        information: 'graph stale, pending, partial, wrong-scope, or ready signals',
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
      'alembic_intent',
      'alembic_prime',
      'alembic_search',
      'alembic_structure',
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
  const currentDomainSop = buildCurrentDomainSop(currentPlaybook || DOMAIN_PLAYBOOKS[0]);
  const toolCapabilities = buildToolCapabilities(listPluginToolSurfaceCatalog());
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
        'alembic_codex_status',
        'alembic_source_graph_status',
        currentPlaybook?.toolSequence[1] || 'alembic_code_explore',
        'alembic_submit_knowledge',
        'alembic_dimension_complete',
      ],
      rule: 'Use source graph tools only after freshness is known; fall back to raw file reads and repository validation when graph facts are stale or partial.',
      sopField: 'currentDomainSop',
      toolCapabilityField: 'toolCapabilities',
    },
    progress,
    repairState,
    sopPack: buildSopPack(),
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
    sourceGraph: buildSourceGraphState(input),
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
  if (input.hostProjectAlignment && !input.hostProjectAlignment.handoffAllowed) {
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
    return 'bootstrap_running';
  }
  if (knowledge.status === 'knowledge_stale' || knowledge.sourceRefs?.status === 'stale') {
    return 'graph_stale';
  }
  return knowledge.usable ? 'knowledge_ready' : 'initialized_empty';
}

function buildSourceGraphState(input: BuildCodexOnboardingContractInput): Record<string, unknown> {
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
      'Source graph output is evidence only after alembic_source_graph_status reports the correct project scope and fresh/ready state.',
    firstTool: 'alembic_source_graph_status',
    freshnessStatus: freshness?.status || null,
    queryTools: CANONICAL_SOURCE_GRAPH_TOOLS.filter(
      (toolName) => toolName !== 'alembic_source_graph_status'
    ),
    readiness,
    sourceRefStatus: sourceRefs?.status || null,
    staleRecipeCount: sourceRefs?.staleRecipeCount ?? null,
    unsupportedStates: ['stale', 'pending', 'partial', 'wrong-scope', 'unsupported-language'],
  };
}

function buildToolCapabilities(entries: PluginToolSurfaceEntry[]): Record<string, unknown> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    source: 'PluginToolSurfaceCatalog',
    visibleToolNames: entries.map((entry) => entry.name),
    canonicalSourceGraph: summarizeToolGroup(CANONICAL_SOURCE_GRAPH_TOOLS, byName),
    knowledgeAndRecipes: summarizeToolGroup(KNOWLEDGE_AND_RECIPE_TOOLS, byName),
    guardAndValidation: summarizeToolGroup(GUARD_AND_VALIDATION_TOOLS, byName),
    bootstrapAndRecovery: summarizeToolGroup(BOOTSTRAP_AND_RECOVERY_TOOLS, byName),
    removedOrBlocked: [
      {
        name: 'alembic_call_context',
        reason:
          'Do not use for current-source relationship evidence in the onboarding SOP; prefer caller/callee/impact source graph tools.',
        replacementTools: ['alembic_callers', 'alembic_callees', 'alembic_code_impact'],
        status: byName.has('alembic_call_context') ? 'visible-legacy-surface' : 'not-visible',
      },
      {
        name: 'alembic_affected_tests',
        reason:
          'Do not use as an acceptance surface in the onboarding SOP; validation planning owns test buckets.',
        replacementTools: ['alembic_validation_plan'],
        status: byName.has('alembic_affected_tests') ? 'fold-into-validation-plan' : 'not-visible',
      },
      {
        name: 'alembic_graph',
        reason: 'Knowledge graph context is useful for Recipes but is not source-code proof.',
        replacementTools: CANONICAL_SOURCE_GRAPH_TOOLS,
        status: byName.has('alembic_graph') ? 'knowledge-only' : 'not-visible',
      },
    ],
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

function buildCurrentDomainSop(playbook: DomainPlaybook): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    domainId: playbook.domainId,
    title: playbook.title,
    goal: playbook.goal,
    stage: 'domain-discovery',
    toolSequence: playbook.toolSequence,
    toolToInformation: playbook.toolToInformation,
    recipeOntologyReminders: [
      'Recipe candidates must describe reusable project guidance, not raw symbol dumps.',
      'Relationship claims require source evidence such as callers, callees, impact, or exact source nodes.',
      'A good Recipe states when to use it, when not to use it, and which validation proves the behavior.',
    ],
    recipeCreationSop: [
      'Check source graph freshness first.',
      'Collect exact source facts with file paths, symbols, and relationship evidence.',
      'Compare with existing Recipes before submitting a new candidate.',
      'Submit only project-specific, reusable guidance.',
      'Complete the dimension only after candidates, no-op reasons, and validation notes are recorded.',
    ],
    requiredEvidence: playbook.requiredEvidence,
    qualityGates: [
      'No generic advice without project-specific source evidence.',
      'No bare filename claims without symbol or snippet context.',
      'No relationship claim without caller, callee, impact, or exact source node evidence.',
      'No acceptance from graph output alone; run matching repository validation.',
    ],
    repairRebuildRules: [
      'If scope is wrong, stop and resolve the project root before using source facts.',
      'If graph freshness is stale, re-check after rebuild or fall back to raw file reads and name the uncertainty.',
      'If transport closes, repair MCP/runtime transport before claiming live Codex usability.',
    ],
    stopConditions: [
      'wrong project root',
      'stale or partial graph used as final proof',
      'missing validation for behavior-changing edits',
      'Recipe candidate lacks source-backed reusable guidance',
    ],
    nextActions: [
      {
        label: 'Check source graph status',
        tool: 'alembic_source_graph_status',
      },
      {
        label: `Collect evidence for ${playbook.title}`,
        tool: playbook.toolSequence[1] || 'alembic_code_explore',
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

function buildSopPack(): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    source: 'wakeflow-ledger/domain-sop-baseline-2026-06-12',
    stagedProtocol: [
      'Read bootstrapState and confirm project identity, runtime route, graph readiness, and current domain.',
      'Run the currentDomainSop tool sequence and keep source evidence tied to file paths or symbols.',
      'Submit knowledge only when the Recipe ontology and quality gates are satisfied.',
      'Complete the domain, then move to the next pending domain in domainQueue.',
    ],
    domainPlaybooks: DOMAIN_PLAYBOOKS.map((playbook) => ({
      domainId: playbook.domainId,
      title: playbook.title,
      goal: playbook.goal,
      requiredEvidence: playbook.requiredEvidence,
      toolSequence: playbook.toolSequence,
    })),
    recipeOntology: {
      candidateKinds: ['rule', 'pattern', 'boundary', 'workflow', 'validation', 'failure-mode'],
      sourceFactKinds: ['file', 'symbol', 'call-chain', 'command-output', 'runtime-json'],
      rejectionReasons: [
        'generic-advice',
        'unsupported-relationship',
        'duplicate-existing-recipe',
        'padding-without-project-signal',
      ],
    },
    submitKnowledgeContract: {
      tool: 'alembic_submit_knowledge',
      requiredBeforeSubmit: [
        'source evidence',
        'specific reusable guidance',
        'when and when-not notes',
        'validation or failure-path guidance',
      ],
    },
    dimensionCompletionContract: {
      tool: 'alembic_dimension_complete',
      requiredBeforeComplete: [
        'submitted candidate ids or explicit no-op reason',
        'current domain evidence summary',
        'residual risks and next domain handoff',
      ],
    },
    knowledgeResetContract: {
      tool: 'alembic_bootstrap',
      rule: 'Host-agent bootstrap resets and rebuilds deterministic analysis state, then waits for Codex to submit Recipes and complete staged domains.',
    },
    repairPrompts: [
      'If graph status is stale, refresh or use raw file reads and state the uncertainty.',
      'If runtime transport closes, repair MCP/plugin transport before using live-output claims.',
      'If scope differs from the host project, stop and resolve project identity.',
    ],
    nextDomainPrompt:
      'After completing the current domain, read domainQueue for the next pending domain and repeat the same status, evidence, submit, and complete loop.',
    llmParticipationBoundary:
      'This SOP pack is deterministic plugin output. Codex is responsible for judgment; plugin runtime does not perform provider-backed Recipe writing on the default route.',
  };
}

function buildGates(): Record<string, unknown> {
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    scope: {
      rule: 'Project root and data root must match the active Codex host project before source facts can be trusted.',
      firstRepairTool: 'alembic_codex_status',
    },
    graphFreshness: {
      rule: 'Run alembic_source_graph_status before source graph query tools.',
      degradedStates: ['stale', 'pending', 'partial', 'wrong-scope', 'unsupported-language'],
    },
    sourceEvidence: {
      rule: 'Recipe candidates require exact source references, not graph labels alone.',
      acceptableRefs: ['file path', 'symbol id', 'source node', 'call relation', 'command output'],
    },
    relationshipEvidence: {
      rule: 'Caller, callee, and impact claims require source graph relation evidence or raw source fallback.',
      preferredTools: ['alembic_callers', 'alembic_callees', 'alembic_code_impact'],
    },
    validation: {
      rule: 'Validation plan is advisory; acceptance still requires repository tests or targeted host checks.',
      preferredTools: ['alembic_validation_plan', 'alembic_code_guard'],
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
      'alembic_source_graph_status',
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
  if (status === 'graph_stale') {
    reasons.push('knowledge source refs or graph freshness are stale');
  }
  if (input.knowledge?.jobs?.bootstrapRunning) {
    reasons.push('bootstrap job is already running');
  }
  return {
    contractVersion: CODEX_ONBOARDING_CONTRACT_VERSION,
    status: reasons.length > 0 ? 'repair-needed' : 'ready',
    reasons,
    rebuildRequired: status === 'graph_stale',
    firstRepairTool:
      status === 'wrong_scope' || status === 'degraded'
        ? 'alembic_codex_status'
        : status === 'graph_stale'
          ? 'alembic_source_graph_status'
          : null,
    safeFallback:
      'Use raw file reads/search plus repository validation when graph status is unavailable or stale.',
    blockedConclusions: [
      'do not claim source graph freshness without alembic_source_graph_status',
      'do not claim live Codex usability without a real MCP/tool readback',
      'do not mark a domain complete without evidence or an explicit no-op reason',
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
