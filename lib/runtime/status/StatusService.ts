import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceSettingsStore } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import type { DaemonStatus } from '../../daemon/DaemonSupervisor.js';
import { DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import { buildCodexRuntimeDiagnostics } from '../../runtime/diagnostics/Diagnostics.js';
import {
  buildCodexEnhancementRouteChoice,
  type CodexEnhancementRouteChoice,
} from '../../runtime/EnhancementRoute.js';
import {
  buildCodexHostProjectAlignment,
  type CodexHostProjectAlignment,
} from '../../runtime/HostProjectAlignment.js';
import { type CodexKnowledgeState, inspectCodexKnowledge } from '../../runtime/KnowledgeState.js';
import { buildCodexModuleBoundaryStatus } from '../../runtime/ModuleBoundary.js';
import {
  buildCodexProjectRootRequiredActions,
  buildCodexProjectRootRequiredMessage,
  type CodexProjectRootResolution,
  getCodexInitMarkerPath,
  readCodexInitMarker,
  resolveCodexProjectRoot,
} from '../../runtime/ProjectRootResolver.js';
import { buildCodexProjectRuntimeContext } from '../../runtime/runtime/ProjectRuntimeContext.js';
import {
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from '../../runtime/runtime/RuntimeContext.js';
import { buildCodexStatusOnboardingContract } from '../../runtime/status/OnboardingContract.js';
import { AlembicResidentServiceClient } from '../../service/resident/AlembicResidentServiceClient.js';

export interface CodexDaemonStatusProvider {
  status(projectRoot: string): Promise<DaemonStatus>;
}

export interface CodexRecommendedAction {
  arguments: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}

export interface CodexStatusServiceOptions {
  autoInit?: Record<string, unknown>;
  projectRootResolution?: CodexProjectRootResolution;
  runtime?: CodexRuntimeContext;
  supervisor?: CodexDaemonStatusProvider;
}

export interface CodexStatusData {
  autoInit: {
    attempted: boolean;
    enabled: boolean;
    lastAttemptedAt: unknown;
    lastError: unknown;
    markerExists: boolean;
    ok: boolean;
    requestedTool: unknown;
    route: unknown;
    skippedReason: unknown;
  };
  daemon: Pick<CodexDaemonSummary, 'message' | 'pidAlive' | 'projectId' | 'ready' | 'status'> & {
    implemented: boolean;
    pidExists: boolean;
    stateExists: boolean;
  };
  initialized: boolean;
  knowledge: {
    bootstrapRunning: boolean;
    databaseEntryCount: number | null;
    freshness: Record<string, unknown>;
    hasKnowledge: boolean;
    initialized: boolean;
    jobs: Record<string, unknown>;
    recipeCount: number | null;
    skillCount: number | null;
    status: string | null;
    usable: boolean;
  };
  nextActions: string[];
  ok: boolean;
  onboarding: Record<string, unknown>;
  project: {
    dataRootSource: string;
    expectedProjectId: string | null;
    handoffAllowed: boolean | null;
    hostConnectionState: string | null;
    projectId: string | null;
    registered: boolean;
    root: string;
    trusted: boolean;
    trust: string | null;
  };
  workspace: {
    candidatesExists: boolean;
    configExists: boolean;
    dataRootSource: string;
    databaseExists: boolean;
    ghost: boolean;
    knowledgeExists: boolean;
    mode: string;
    recipesExists: boolean;
    runtimeExists: boolean;
    secretsExists: boolean;
    settingsExists: boolean;
    skillsExists: boolean;
    wikiExists: boolean;
    workspaceExists: boolean;
  };
}

interface CodexStatusOnboardingInput {
  daemonStatus: DaemonStatus;
  diagnostics: Record<string, unknown>;
  enhancementRoute?: CodexEnhancementRouteChoice;
  hostProjectAlignment?: CodexHostProjectAlignment;
  knowledge: CodexKnowledgeState;
  projectRootResolution?: CodexProjectRootResolution;
  workspace?: {
    ghost: boolean;
    mode: string;
    registered: boolean;
  };
}

export async function buildCodexStatus(
  projectRootInput: string,
  options: CodexStatusServiceOptions = {}
): Promise<CodexStatusData> {
  const projectRoot = resolve(projectRootInput);
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const settingsStore = new WorkspaceSettingsStore(resolver);
  const facts = resolver.toFacts();
  const supervisor = options.supervisor || new DaemonSupervisor();
  const daemonStatus = await supervisor.status(projectRoot);
  const knowledge = inspectCodexKnowledge(projectRoot);
  const runtime = options.runtime || resolveCodexRuntimeContext();
  const residentClient = new AlembicResidentServiceClient({ projectRoot });
  const residentService = await residentClient.probe({ daemonStatus });
  const projectScopeIdentity = await residentClient.resolveProjectScopeIdentity({ daemonStatus });
  const enhancementRoute = buildCodexEnhancementRouteChoice({
    daemonStatus,
    runtime,
    requirement: 'status',
  });
  const hostProjectAlignment = buildCodexHostProjectAlignment({
    daemonStatus,
    enhancementRoute,
    projectScopeIdentity,
    projectRoot,
  });
  const projectRootResolution =
    options.projectRootResolution || resolveCodexProjectRoot({ projectRoot: projectRootInput });
  const projectRuntime = buildCodexProjectRuntimeContext({
    daemonStatus,
    enhancementRoute,
    hostProjectAlignment,
    projectRoot,
    projectRootResolution,
    projectScopeIdentity,
    requiredServices: ['project-identity'],
    runtime,
  });
  const moduleBoundary = buildCodexModuleBoundaryStatus({
    enhancementRoute,
    hostProjectAlignment,
  });
  const autoInit = buildCodexAutoInitStatus(projectRoot, knowledge, projectRootResolution, {
    runtimeState: options.autoInit,
  });
  const diagnostics = buildCodexRuntimeDiagnostics(daemonStatus, runtime, {
    autoInit,
    enhancementRoute,
    hostProjectAlignment,
    moduleBoundary,
    projectRootResolution,
    projectRuntime,
    projectScopeIdentity,
    residentService,
  });
  const onboarding = buildCodexStatusOnboarding({
    daemonStatus,
    diagnostics,
    enhancementRoute,
    hostProjectAlignment,
    knowledge,
    projectRootResolution,
    workspace: {
      ghost: facts.ghost,
      mode: facts.mode,
      registered: facts.registered,
    },
  });
  const daemonStatePath = join(resolver.runtimeDir, 'daemon.json');
  const daemonPidPath = join(resolver.runtimeDir, 'daemon.pid');

  return {
    ok: knowledge.initialized,
    initialized: knowledge.initialized,
    project: {
      root: projectRoot,
      trusted: projectRootResolution.trust === 'trusted',
      trust: projectRootResolution.trust,
      registered: facts.registered,
      projectId: facts.projectId,
      expectedProjectId: facts.expectedProjectId,
      dataRootSource: facts.dataRootSource,
      hostConnectionState: hostProjectAlignment.connectionState,
      handoffAllowed: hostProjectAlignment.handoffAllowed,
    },
    workspace: {
      mode: facts.mode,
      ghost: facts.ghost,
      dataRootSource: facts.dataRootSource,
      workspaceExists: facts.workspaceExists,
      runtimeExists: existsSync(resolver.runtimeDir),
      configExists: existsSync(resolver.configPath),
      databaseExists: existsSync(resolver.databasePath),
      knowledgeExists: existsSync(resolver.knowledgeDir),
      recipesExists: existsSync(resolver.recipesDir),
      candidatesExists: existsSync(resolver.candidatesDir),
      skillsExists: existsSync(resolver.skillsDir),
      wikiExists: existsSync(resolver.wikiDir),
      settingsExists: existsSync(settingsStore.settingsPath),
      secretsExists: existsSync(settingsStore.secretsPath),
    },
    daemon: {
      ...summarizeCompactCodexDaemonStatus(daemonStatus),
      implemented: true,
      stateExists: existsSync(daemonStatePath),
      pidExists: existsSync(daemonPidPath),
    },
    knowledge: summarizeCodexKnowledgeState(knowledge),
    autoInit: summarizeCodexAutoInitStatus(autoInit),
    onboarding: summarizeCodexOnboarding(onboarding),
    nextActions: buildCodexActionLabels(onboarding.nextActions),
  };
}

function buildCodexAutoInitStatus(
  projectRoot: string,
  knowledge: CodexKnowledgeState,
  projectRootResolution: CodexProjectRootResolution,
  options: { runtimeState?: Record<string, unknown> } = {}
): Record<string, unknown> {
  let markerPath: string | null = null;
  let markerExists = false;
  let marker = null;
  try {
    markerPath = getCodexInitMarkerPath(projectRoot);
    marker = readCodexInitMarker(projectRoot);
    markerExists = Boolean(marker);
  } catch {
    markerPath = null;
  }
  const runtimeState = options.runtimeState || {};
  const skippedReason =
    projectRootResolution.trust !== 'trusted'
      ? buildCodexProjectRootRequiredMessage(projectRootResolution)
      : knowledge.initialized
        ? 'workspace already initialized'
        : 'waiting for explicit init or an init-on-demand tool call';
  return {
    enabled: true,
    attempted: Boolean(runtimeState.attempted) || markerExists,
    ok: runtimeState.ok === true || markerExists,
    skippedReason,
    route: runtimeState.route || marker?.route || null,
    requestedTool: runtimeState.requestedTool || marker?.requestedTool || null,
    lastError: runtimeState.lastError || null,
    lastAttemptedAt: runtimeState.lastAttemptedAt || marker?.initializedAt || null,
    markerPath,
    markerExists,
    marker,
  };
}

export interface CodexDaemonSummary {
  dataRoot: string;
  logPath: string;
  message?: string;
  pidAlive: boolean;
  pidPath: string;
  projectId: string | null;
  projectRoot: string;
  ready: boolean;
  state: Record<string, unknown> | null;
  statePath: string;
  status: string;
}

export function summarizeCodexDaemonStatus(status: DaemonStatus): CodexDaemonSummary {
  return {
    status: status.status,
    ready: status.ready,
    projectRoot: status.projectRoot,
    dataRoot: status.dataRoot,
    projectId: status.projectId,
    pidAlive: status.pidAlive,
    statePath: status.statePath,
    pidPath: status.pidPath,
    logPath: status.logPath,
    state: summarizeCodexDaemonState(status.state),
    message: status.message,
  };
}

function summarizeCompactCodexDaemonStatus(
  status: DaemonStatus
): Pick<CodexDaemonSummary, 'message' | 'pidAlive' | 'projectId' | 'ready' | 'status'> {
  return {
    status: status.status,
    ready: status.ready,
    projectId: status.projectId,
    pidAlive: status.pidAlive,
    message: status.message,
  };
}

function summarizeCodexKnowledgeState(
  knowledge: CodexKnowledgeState
): CodexStatusData['knowledge'] {
  const jobs = asPlainRecord(knowledge.jobs) || {};
  return {
    initialized: knowledge.initialized,
    hasKnowledge: knowledge.hasKnowledge,
    usable: knowledge.usable,
    status: typeof knowledge.status === 'string' ? knowledge.status : null,
    recipeCount: typeof knowledge.recipeCount === 'number' ? knowledge.recipeCount : null,
    skillCount: typeof knowledge.skillCount === 'number' ? knowledge.skillCount : null,
    databaseEntryCount:
      typeof knowledge.databaseEntryCount === 'number' ? knowledge.databaseEntryCount : null,
    freshness: summarizeStringRecord(knowledge.freshness, [
      'status',
      'stale',
      'reason',
      'latestKnowledgeAt',
      'latestJobAt',
      'checkedAt',
    ]),
    bootstrapRunning: jobs.bootstrapRunning === true,
    jobs: summarizeStringRecord(jobs, ['running', 'bootstrapRunning', 'rescanRunning', 'total']),
  };
}

function summarizeCodexAutoInitStatus(value: Record<string, unknown>): CodexStatusData['autoInit'] {
  return {
    enabled: value.enabled === true,
    attempted: value.attempted === true,
    ok: value.ok === true,
    skippedReason: value.skippedReason ?? null,
    route: value.route ?? null,
    requestedTool: value.requestedTool ?? null,
    lastError: value.lastError ?? null,
    lastAttemptedAt: value.lastAttemptedAt ?? null,
    markerExists: value.markerExists === true,
  };
}

function summarizeCodexOnboarding(value: unknown): Record<string, unknown> {
  const onboarding = asPlainRecord(value) || {};
  return {
    state: onboarding.state ?? null,
    summary: onboarding.summary ?? null,
    primaryAction: summarizeCodexRecommendedAction(onboarding.primaryAction),
    nextActions: Array.isArray(onboarding.nextActions)
      ? onboarding.nextActions.map(summarizeCodexRecommendedAction).filter(Boolean)
      : [],
    notes: Array.isArray(onboarding.notes)
      ? onboarding.notes.filter((note): note is string => typeof note === 'string').slice(0, 6)
      : [],
  };
}

function summarizeCodexRecommendedAction(value: unknown): Record<string, unknown> | null {
  const action = asPlainRecord(value);
  if (!action) {
    return null;
  }
  return {
    label: action.label ?? null,
    tool: action.tool ?? null,
    startsDaemon: action.startsDaemon === true,
    reason: action.reason ?? null,
    ...(asPlainRecord(action.arguments) ? { arguments: action.arguments } : {}),
  };
}

function summarizeStringRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asPlainRecord(value);
  if (!record) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) {
      out[key] = record[key];
    }
  }
  return out;
}

function buildCodexHostAgentBootstrapAction(input: {
  label?: string;
  reason?: string;
  startsDaemon: boolean;
}): CodexRecommendedAction {
  return buildCodexRecommendedAction({
    label: input.label || 'Start Codex host-agent bootstrap',
    reason:
      input.reason ||
      'Have Codex read the Mission Briefing, analyze the project, submit knowledge, and complete dimensions without requiring an Alembic AI Provider.',
    startsDaemon: input.startsDaemon,
    tool: 'alembic_bootstrap',
  });
}

function buildCodexHostAgentRescanAction(input: {
  label?: string;
  reason?: string;
  startsDaemon: boolean;
}): CodexRecommendedAction {
  return buildCodexRecommendedAction({
    label: input.label || 'Run Codex host-agent rescan',
    reason:
      input.reason ||
      'Have Codex refresh Alembic project knowledge through the host-agent workflow without requiring an Alembic AI Provider.',
    startsDaemon: input.startsDaemon,
    tool: 'alembic_rescan',
  });
}

function buildCodexAgentPrimeAction(input: {
  label?: string;
  reason?: string;
  startsDaemon: boolean;
}): CodexRecommendedAction {
  return buildCodexRecommendedAction({
    arguments: { inputSource: 'host-declared-intent' },
    label: input.label || 'Prime agent context',
    reason:
      input.reason ||
      'Load compact Alembic project knowledge through the agent-facing public prime tool before non-trivial coding work.',
    startsDaemon: input.startsDaemon,
    tool: 'alembic_prime',
  });
}

export function buildCodexPostInitActions(
  knowledge: CodexKnowledgeState
): CodexRecommendedAction[] {
  if (knowledge.usable) {
    return [
      buildCodexAgentPrimeAction({
        reason:
          'Load the most relevant Alembic Recipes through the agent-facing public prime tool before non-trivial coding work.',
        startsDaemon: true,
      }),
      buildCodexHostAgentRescanAction({
        reason: 'Refresh Alembic project knowledge through the Codex host-agent workflow.',
        startsDaemon: true,
      }),
    ];
  }
  return [
    buildCodexHostAgentBootstrapAction({
      reason:
        'Build the first Alembic project knowledge through Codex host-agent analysis; no Alembic AI Provider is required.',
      startsDaemon: true,
    }),
  ];
}

export function buildCodexPostInitMessage(knowledge: CodexKnowledgeState): string {
  return knowledge.usable
    ? 'Alembic Codex workspace initialized with usable project knowledge. Next: prime agent context or run host-agent rescan.'
    : 'Alembic Codex workspace initialized. Next: run Codex host-agent bootstrap to build the first usable project knowledge.';
}

export function buildCodexKnowledgeGateActions(
  knowledge: CodexKnowledgeState
): CodexRecommendedAction[] {
  const actions = [
    buildCodexRecommendedAction({
      label: 'Check workspace status',
      reason: 'Inspect whether this project is initialized and whether Alembic knowledge exists.',
      startsDaemon: false,
      tool: 'alembic_status',
    }),
  ];
  if (!knowledge.initialized) {
    actions.push(
      buildCodexRecommendedAction({
        label: 'Initialize or attach workspace',
        reason:
          'Create or attach Alembic Codex data roots according to the ProjectRegistry workspace mode.',
        startsDaemon: false,
        tool: 'alembic_mcp_init',
      })
    );
  } else {
    actions.push(
      buildCodexHostAgentBootstrapAction({
        reason:
          'Build the first Alembic project knowledge through Codex host-agent analysis; no Alembic AI Provider is required.',
        startsDaemon: true,
      })
    );
  }
  return actions;
}

export function buildCodexStatusOnboarding(
  input: CodexStatusOnboardingInput
): Record<string, unknown> {
  const boundaryNotes = buildCodexRouteBoundaryNotes(input.enhancementRoute);
  const alignmentNotes = buildCodexHostProjectAlignmentNotes(input.hostProjectAlignment);
  const diagnosticsOk = input.diagnostics.ok !== false;
  const onboardingContract = buildStatusOnboardingContract(input, diagnosticsOk);
  if (input.projectRootResolution && input.projectRootResolution.trust !== 'trusted') {
    return {
      state: 'project_root_unresolved',
      summary:
        'Alembic Codex cannot determine the target project directory, so project workflows cannot be used yet.',
      primaryAction: buildCodexRecommendedAction({
        label: 'Run diagnostics',
        reason:
          'Show why the project root is unavailable and which absolute path must be provided.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: 'Run diagnostics',
          reason: 'Show the rejected or fallback project root and required environment variables.',
          startsDaemon: false,
          tool: 'alembic_status',
        }),
      ],
      notes: [
        buildCodexProjectRootRequiredMessage(input.projectRootResolution),
        ...buildCodexProjectRootRequiredActions(),
        'Initialization and init-on-demand tools fail closed until the project root is trusted.',
        ...alignmentNotes,
        ...boundaryNotes,
      ],
      ...onboardingContract,
    };
  }

  if (!diagnosticsOk) {
    return {
      state: 'runtime_issue',
      summary:
        'Alembic Codex is installed, but runtime diagnostics need attention before project knowledge is reliable.',
      primaryAction: buildCodexRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Resolve Node, npm, embedded runtime, or plugin metadata issues first.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: 'Run diagnostics',
          reason: 'Inspect structured issues and repair guidance.',
          startsDaemon: false,
          tool: 'alembic_status',
        }),
      ],
      notes: ['Status checks do not start the daemon.', ...alignmentNotes, ...boundaryNotes],
      ...onboardingContract,
    };
  }

  if (!input.knowledge.initialized) {
    const registeredStandard =
      input.workspace?.registered === true && input.workspace.mode === 'standard';
    const initLabel = registeredStandard
      ? 'Attach Standard workspace'
      : 'Initialize Ghost workspace';
    const initReason = registeredStandard
      ? 'Attach Codex to the existing Standard Alembic workspace without changing its mode.'
      : input.knowledge.hasKnowledge
        ? 'Connect Codex to the existing Alembic knowledge base without writing IDE MCP files into the project.'
        : 'Create Alembic Codex data roots without writing IDE MCP files into the project.';
    return {
      state: input.knowledge.hasKnowledge ? 'needs_init_existing_knowledge' : 'needs_init',
      summary: input.knowledge.hasKnowledge
        ? 'Alembic knowledge files exist for this project, but the Codex workspace runtime has not been initialized yet.'
        : 'Alembic Codex is installed and the runtime is healthy, but this workspace has not been initialized yet.',
      primaryAction: buildCodexRecommendedAction({
        label: initLabel,
        reason: initReason,
        startsDaemon: false,
        tool: 'alembic_mcp_init',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: initLabel,
          reason: registeredStandard
            ? 'Set up Codex runtime files in the registered Standard data root.'
            : 'Set up local Alembic config, database, knowledge, and Recipe directories.',
          startsDaemon: false,
          tool: 'alembic_mcp_init',
        }),
      ],
      notes: [
        input.knowledge.hasKnowledge
          ? 'Only cold-start initialization tools are exposed until setup completes.'
          : 'Only cold-start initialization tools are exposed until Alembic knowledge exists.',
        registeredStandard
          ? 'This project is already registered as Standard; Codex init inherits that mode unless the user explicitly migrates it.'
          : 'Ghost mode keeps Alembic data outside the repository by default for unregistered projects.',
        ...alignmentNotes,
        ...boundaryNotes,
      ],
      ...onboardingContract,
    };
  }

  if (input.knowledge.jobs?.bootstrapRunning) {
    return {
      state: 'bootstrap_in_progress',
      summary:
        'Alembic Codex bootstrap is already running for this project; a second writer must not be started.',
      primaryAction: buildCodexRecommendedAction({
        label: 'Check bootstrap progress',
        reason:
          'Read the single-writer bootstrap lease and wait for the existing Codex-owned bootstrap route to finish.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: 'Check bootstrap progress',
          reason:
            'Read bootstrapState.singleWriterLease and current progress without starting work.',
          startsDaemon: false,
          tool: 'alembic_status',
        }),
        buildCodexRecommendedAction({
          label: 'Inspect bootstrap job',
          reason: 'Inspect Codex bootstrap job state when job tools are available.',
          startsDaemon: false,
          tool: 'alembic_job',
        }),
      ],
      notes: [
        'bootstrap_in_progress is a visibility state; hard lease enforcement and takeover are handled by the lease-enforcement route.',
        'Do not start another host-agent bootstrap while the lease holder is visible.',
        ...alignmentNotes,
        ...boundaryNotes,
      ],
      ...onboardingContract,
    };
  }

  if (!input.knowledge.usable) {
    return {
      state: 'needs_bootstrap',
      summary:
        'Alembic Codex is initialized, but this project does not have usable Alembic Recipes or Project Skills yet.',
      primaryAction: buildCodexHostAgentBootstrapAction({
        reason:
          'Build the first Alembic project knowledge through Codex host-agent analysis; no Alembic AI Provider is required.',
        startsDaemon: true,
      }),
      nextActions: [
        buildCodexHostAgentBootstrapAction({
          reason:
            'Create the initial Alembic knowledge base by following the Mission Briefing from Codex.',
          startsDaemon: true,
        }),
      ],
      notes: [
        'Codex host-agent bootstrap does not require an Alembic AI Provider.',
        'Prime, Guard, search, and lifecycle tools are available after the knowledge base is usable.',
        ...alignmentNotes,
        ...boundaryNotes,
      ],
      ...onboardingContract,
    };
  }

  if (input.hostProjectAlignment && !input.hostProjectAlignment.handoffAllowed) {
    return {
      state: `project_handoff_${input.hostProjectAlignment.connectionState}`,
      summary:
        input.hostProjectAlignment.connectionState === 'mismatch'
          ? 'Alembic Codex is initialized, but the Codex host project differs from the Alembic selected or active project.'
          : 'Alembic Codex is initialized, but this Codex host project is not connected to an active Alembic runtime project yet.',
      primaryAction: buildCodexRecommendedAction({
        label: 'Check workspace status',
        reason:
          'Inspect the Codex host project, Alembic selected project, and active runtime project before Dashboard handoff.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
      nextActions: [
        buildCodexRecommendedAction({
          label: 'Run diagnostics',
          reason: 'Review plugin runtime status and project handoff mismatch details.',
          startsDaemon: false,
          tool: 'alembic_status',
        }),
      ],
      notes: [
        ...alignmentNotes,
        'Plugin does not switch Alembic projects or start an embedded runtime to cover a different selected project.',
        ...boundaryNotes,
      ],
      ...onboardingContract,
    };
  }

  const daemonReady = input.daemonStatus.ready === true;
  return {
    state: daemonReady ? 'ready_daemon_running' : 'ready',
    summary: daemonReady
      ? 'Alembic Codex is initialized and the daemon is ready.'
      : 'Alembic Codex is initialized. The daemon will start on demand when a project-knowledge tool needs it.',
    primaryAction: buildCodexAgentPrimeAction({
      reason:
        'Load relevant Alembic Recipes through the agent-facing public prime tool before non-trivial coding work.',
      startsDaemon: !daemonReady,
    }),
    nextActions: [
      buildCodexAgentPrimeAction({
        reason:
          'Load project conventions and trusted context from an intentRef or host-declared intent.',
        startsDaemon: !daemonReady,
      }),
      buildCodexHostAgentRescanAction({
        reason: 'Refresh project knowledge through the Codex host-agent workflow.',
        startsDaemon: !daemonReady,
      }),
      buildCodexRecommendedAction({
        label: 'Open Dashboard',
        reason: 'Inspect jobs, candidates, and project knowledge in the local UI.',
        startsDaemon: !daemonReady,
        tool: 'alembic_codex_dashboard',
      }),
    ],
    notes: daemonReady
      ? ['Dashboard and job APIs are available now.', ...alignmentNotes, ...boundaryNotes]
      : [
          'Status checks stay light; project-knowledge tools wake the daemon only when needed.',
          ...alignmentNotes,
          ...boundaryNotes,
        ],
    ...onboardingContract,
  };
}

function buildStatusOnboardingContract(
  input: CodexStatusOnboardingInput,
  diagnosticsOk: boolean
): ReturnType<typeof buildCodexStatusOnboardingContract> {
  const latestSnapshot = input.knowledge.snapshots?.latest;
  return buildCodexStatusOnboardingContract({
    dataRoot: input.daemonStatus.dataRoot,
    diagnosticsOk,
    dimensions: latestSnapshot
      ? [{ id: 'latest-bootstrap-snapshot', title: 'Latest Bootstrap Snapshot' }]
      : [],
    fileCount: latestSnapshot?.fileCount ?? null,
    hostProjectAlignment: input.hostProjectAlignment,
    knowledge: input.knowledge,
    primaryLanguage: latestSnapshot?.primaryLang ?? null,
    projectRoot: input.daemonStatus.projectRoot,
    projectRootTrusted: input.projectRootResolution
      ? input.projectRootResolution.trust === 'trusted'
      : true,
    session: latestSnapshot
      ? {
          id: latestSnapshot.sessionId,
        }
      : null,
  });
}

function buildCodexHostProjectAlignmentNotes(alignment?: CodexHostProjectAlignment): string[] {
  if (!alignment) {
    return [];
  }
  const mismatch = alignment.handoffMismatch;
  if (alignment.connectionState === 'connected') {
    return [
      'Codex host project matches the Alembic selected/active runtime project for Dashboard handoff.',
    ];
  }
  if (!mismatch) {
    return alignment.nextActions;
  }
  return [
    `Host project alignment: ${alignment.connectionState}; host=${mismatch.hostRoot || 'unavailable'}, selected=${mismatch.selectedRoot || 'unavailable'}, active=${mismatch.activeRoot || 'unavailable'}, reason=${mismatch.reason}.`,
    ...alignment.nextActions,
  ];
}

function buildCodexRouteBoundaryNotes(enhancementRoute?: CodexEnhancementRouteChoice): string[] {
  if (!enhancementRoute) {
    return [
      'Codex host-agent workflows write source=host-agent and remain separate from Alembic resident daemon job provider configuration.',
    ];
  }
  const providerSummary = enhancementRoute.residentDaemonJobProvider.available
    ? `${enhancementRoute.residentDaemonJobProvider.provider || 'configured'} via ${
        enhancementRoute.residentDaemonJobProvider.configSource || 'unknown'
      }`
    : `not configured (${enhancementRoute.residentDaemonJobProvider.configSource || 'empty'})`;
  const routeNote =
    enhancementRoute.selected === 'local-alembic-daemon'
      ? `Local Alembic resident service route: ${enhancementRoute.selected}. ${enhancementRoute.reason}`
      : enhancementRoute.selected === 'embedded-plugin-runtime'
        ? `Embedded Plugin runtime route: ${enhancementRoute.selected}. It recovers Codex host-agent jobs and is not Alembic resident enhancement. ${enhancementRoute.reason}`
        : `Alembic route candidate: ${enhancementRoute.selected}. ${enhancementRoute.reason}`;
  return [
    `Host-agent route uses source=${enhancementRoute.hostAgentRoute.source} for Codex-submitted knowledge, proposals, and dimension completion.`,
    routeNote,
    `Resident daemon job provider config: ${providerSummary}; this is provider/model state, not a Plugin knowledge source.`,
  ];
}

export function buildCodexRecommendedAction(input: {
  arguments?: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}): CodexRecommendedAction {
  return {
    arguments: input.arguments || {},
    label: input.label,
    reason: input.reason,
    startsDaemon: input.startsDaemon,
    tool: input.tool,
  };
}

export function buildCodexActionLabels(actions: unknown): string[] {
  return Array.isArray(actions)
    ? actions
        .map((action) => asPlainRecord(action))
        .map((action) =>
          action && typeof action.tool === 'string' && typeof action.label === 'string'
            ? `${action.label}: call ${action.tool}`
            : null
        )
        .filter((value): value is string => Boolean(value))
    : [];
}

function summarizeCodexDaemonState(state: unknown): Record<string, unknown> | null {
  const value = asPlainRecord(state);
  if (!value) {
    return null;
  }
  return {
    pid: value.pid,
    host: value.host,
    port: value.port,
    url: value.url,
    dashboardUrl: value.dashboardUrl,
    startedAt: value.startedAt,
    lastReadyAt: value.lastReadyAt,
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
