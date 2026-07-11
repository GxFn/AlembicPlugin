import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceSettingsStore } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { type HostKnowledgeState, inspectKnowledge } from '#service/knowledge/KnowledgeState.js';
import {
  localEmbeddingSetupGuidance,
  resolveLocalEmbeddingConfig,
} from '../../recipe-pipeline/vector/LocalEmbedding.js';
import { createReadOnlyGitDiffCheckpointReader } from '../../repository/skills/ProjectSkillKnowledgeRepository.js';
import { AlembicResidentServiceClient } from '../../service/resident/AlembicResidentServiceClient.js';
import { resolveProjectScopeRuntime } from '../../shared/project-scope-runtime.js';
import {
  buildHostProjectAlignment,
  type HostProjectAlignment,
} from '../context/HostProjectAlignment.js';
import { buildModuleBoundaryStatus } from '../context/ModuleBoundary.js';
import {
  buildProjectRootRequiredActions,
  buildProjectRootRequiredMessage,
  type ProjectRootResolution,
} from '../context/ProjectRootResolver.js';
import { buildProjectRuntimeContext } from '../context/ProjectRuntimeContext.js';
import { type HostRuntimeContext, resolveHostRuntimeContext } from '../context/RuntimeContext.js';
import {
  type LoadedBuildProvenance,
  readLoadedBuildProvenance,
} from '../diagnostics/BuildProvenance.js';
import { buildRuntimeDiagnostics } from '../diagnostics/Diagnostics.js';
import { resolveHostAdapter } from '../host-adapter/resolveHostAdapter.js';
import {
  buildRetrievalCheckpointPosture,
  type RetrievalCheckpointPosture,
  resolveRetrievalCheckpointPostureInput,
} from '../mcp/handlers/retrieval-checkpoint-diagnostics.js';
import {
  buildHostEnhancementRouteChoice,
  type HostEnhancementRouteChoice,
} from './EnhancementRoute.js';
import type { HostRuntimeStatus } from './host-runtime-status.js';
import { buildStatusOnboardingContract } from './OnboardingContract.js';
import { probeSourcePresence, type SourcePresence } from './SourcePresenceProbe.js';

export interface DaemonStatusProvider {
  status(projectRoot: string): Promise<HostRuntimeStatus>;
}

export interface RecommendedAction {
  arguments: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}

export interface StatusServiceOptions {
  autoInit?: Record<string, unknown>;
  buildProvenance?: LoadedBuildProvenance;
  projectRootResolution?: ProjectRootResolution;
  runtime?: HostRuntimeContext;
  supervisor?: DaemonStatusProvider;
}

export interface StatusData {
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
  daemon: Pick<DaemonSummary, 'message' | 'pidAlive' | 'projectId' | 'ready' | 'status'> & {
    implemented: boolean;
    pidExists: boolean;
    stateExists: boolean;
  };
  initialized: boolean;
  knowledge: {
    bootstrapRunning: boolean;
    databaseEntryCount: number | null;
    dbRecipeCount: number | null;
    freshness: Record<string, unknown>;
    hasKnowledge: boolean;
    initialized: boolean;
    jobs: Record<string, unknown>;
    /** S2（2026-07-06）：staging/active/deprecated/other 分布；查询不可用为 null */
    lifecycle: Record<string, number> | null;
    /** S1（2026-07-06）：代码漂移参考（durable checkpoint 摘要+rescan 建议）；缺失为 null */
    codeDrift: Record<string, unknown> | null;
    materializedRecipeCount: number | null;
    recipeCount: number | null;
    skillCount: number | null;
    status: string | null;
    sourceRevisionManifest: RetrievalCheckpointPosture['sourceRevisionManifest'];
    sourceRevisionStatus: RetrievalCheckpointPosture['status'] | null;
    usable: boolean;
  };
  localEmbedding: {
    configExists: boolean;
    configPath: string;
    enabled: boolean;
    endpoint: string;
    model: string;
    provider: 'ollama';
    setup: {
      enableConfig: string;
      enableEnv: string;
      guidance: string[];
      pullCommand: string;
    };
    status: 'disabled' | 'enabled-needs-runtime-probe';
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
  runtime: {
    buildProvenance: LoadedBuildProvenance;
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

interface StatusOnboardingInput {
  daemonStatus: HostRuntimeStatus;
  diagnostics: Record<string, unknown>;
  enhancementRoute?: HostEnhancementRouteChoice;
  hostProjectAlignment?: HostProjectAlignment;
  knowledge: HostKnowledgeState;
  projectRootResolution?: ProjectRootResolution;
  sourcePresence?: SourcePresence;
  workspace?: {
    ghost: boolean;
    mode: string;
    registered: boolean;
  };
}

interface StatusOnboardingContext {
  alignmentNotes: string[];
  boundaryNotes: string[];
  onboardingContract: ReturnType<typeof buildStatusOnboardingContract>;
}

type WorkspaceFacts = ReturnType<WorkspaceResolver['toFacts']>;

export async function buildStatus(
  projectRootInput: string,
  options: StatusServiceOptions = {}
): Promise<StatusData> {
  const projectRoot = resolve(projectRootInput);
  const projectScopeRuntime = resolveProjectScopeRuntime(projectRoot);
  const resolver = WorkspaceResolver.fromProject(projectRoot, {
    projectScope: projectScopeRuntime?.descriptor ?? null,
  });
  const settingsStore = new WorkspaceSettingsStore(resolver);
  const facts = resolver.toFacts();
  const localEmbedding = buildLocalEmbeddingStatus(resolver);
  const daemonStatus: HostRuntimeStatus = options.supervisor
    ? await options.supervisor.status(projectRoot)
    : buildRemovedDaemonStatus({
        dataRoot: facts.dataRoot,
        projectId: facts.projectId ?? null,
        projectRoot,
        runtimeDir: resolver.runtimeDir,
      });
  const knowledge = inspectKnowledge(projectRoot);
  const runtime = options.runtime || resolveHostRuntimeContext();
  const buildProvenance = options.buildProvenance ?? readLoadedBuildProvenance();
  const residentClient = new AlembicResidentServiceClient({ projectRoot });
  const residentService = await residentClient.probe({ daemonStatus });
  const projectScopeIdentity = await residentClient.resolveProjectScopeIdentity({ daemonStatus });
  const enhancementRoute = buildHostEnhancementRouteChoice({
    daemonStatus,
    requirement: 'status',
  });
  const hostProjectAlignment = buildHostProjectAlignment({
    daemonStatus,
    enhancementRoute,
    projectScopeIdentity,
    projectRoot,
  });
  const retrievalCheckpointPosture = readStatusRetrievalCheckpointPosture(
    projectRoot,
    resolver.databasePath,
    hostProjectAlignment
  );
  const projectRootResolution =
    options.projectRootResolution ||
    resolveHostAdapter().resolveProjectRoot({ projectRoot: projectRootInput });
  const projectRuntime = buildProjectRuntimeContext({
    daemonStatus,
    enhancementRoute,
    hostProjectAlignment,
    projectRoot,
    projectRootResolution,
    projectScopeIdentity,
    requiredServices: ['project-identity'],
    runtime,
  });
  const moduleBoundary = buildModuleBoundaryStatus({
    enhancementRoute,
    hostProjectAlignment,
  });
  const autoInit = buildAutoInitStatus(projectRoot, knowledge, projectRootResolution, {
    runtimeState: options.autoInit,
  });
  const diagnostics = buildRuntimeDiagnostics(daemonStatus, runtime, {
    autoInit,
    buildProvenance,
    enhancementRoute,
    hostProjectAlignment,
    moduleBoundary,
    projectRootResolution,
    projectRuntime,
    projectScopeIdentity,
    residentService,
  });
  const sourcePresence = knowledge.initialized ? undefined : probeSourcePresence(projectRoot);
  const onboarding = buildStatusOnboarding({
    daemonStatus,
    diagnostics,
    enhancementRoute,
    hostProjectAlignment,
    knowledge,
    projectRootResolution,
    sourcePresence,
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
    runtime: { buildProvenance },
    workspace: summarizeWorkspaceStatus(facts, resolver, settingsStore),
    daemon: {
      ...summarizeCompactDaemonStatus(daemonStatus),
      implemented: true,
      stateExists: existsSync(daemonStatePath),
      pidExists: existsSync(daemonPidPath),
    },
    knowledge: summarizeHostKnowledgeState(knowledge, retrievalCheckpointPosture),
    localEmbedding,
    autoInit: summarizeAutoInitStatus(autoInit),
    onboarding: summarizeOnboarding(onboarding),
    nextActions: buildActionLabels(onboarding.nextActions),
  };
}

function summarizeWorkspaceStatus(
  facts: WorkspaceFacts,
  resolver: WorkspaceResolver,
  settingsStore: WorkspaceSettingsStore
): StatusData['workspace'] {
  return {
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
  };
}

function buildRemovedDaemonStatus(input: {
  dataRoot: string;
  projectId: string | null;
  projectRoot: string;
  runtimeDir: string;
}): HostRuntimeStatus {
  // PDR-3: status reports a synthetic daemon-less state so downstream consumers
  // keep a non-null HostRuntimeStatus while reflecting the absent daemon.
  return {
    status: 'stopped',
    ready: false,
    projectRoot: input.projectRoot,
    dataRoot: input.dataRoot,
    projectId: input.projectId,
    statePath: join(input.runtimeDir, 'daemon.json'),
    pidPath: join(input.runtimeDir, 'daemon.pid'),
    lockDir: join(input.runtimeDir, 'daemon.lock'),
    logPath: join(input.runtimeDir, 'daemon.log'),
    state: null,
    pidAlive: false,
    health: null,
    message: 'daemon removed (PDR-3)',
  };
}

function buildLocalEmbeddingStatus(resolver: WorkspaceResolver): StatusData['localEmbedding'] {
  const config = readRuntimeConfig(resolver.configPath);
  const vectorConfig = asPlainRecord(config?.vector) ?? {};
  const localConfig = resolveLocalEmbeddingConfig(vectorConfig);
  return {
    configExists: existsSync(resolver.configPath),
    configPath: resolver.configPath,
    enabled: localConfig.enabled,
    endpoint: localConfig.endpoint,
    model: localConfig.model,
    provider: 'ollama',
    setup: {
      enableConfig: 'vector.localEmbedding.enabled=true',
      enableEnv: 'ALEMBIC_LOCAL_EMBEDDING_ENABLED=1',
      guidance: localEmbeddingSetupGuidance(localConfig),
      pullCommand: `ollama pull ${localConfig.model}`,
    },
    status: localConfig.enabled ? 'enabled-needs-runtime-probe' : 'disabled',
  };
}

function readRuntimeConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    return asPlainRecord(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return null;
  }
}

function buildAutoInitStatus(
  projectRoot: string,
  knowledge: HostKnowledgeState,
  projectRootResolution: ProjectRootResolution,
  options: { runtimeState?: Record<string, unknown> } = {}
): Record<string, unknown> {
  let markerPath: string | null = null;
  let markerExists = false;
  let marker = null;
  try {
    const adapter = resolveHostAdapter();
    markerPath = adapter.initMarkerPath(projectRoot);
    marker = adapter.readInitMarker(projectRoot);
    markerExists = Boolean(marker);
  } catch {
    markerPath = null;
  }
  const runtimeState = options.runtimeState || {};
  const skippedReason =
    projectRootResolution.trust !== 'trusted'
      ? buildProjectRootRequiredMessage(projectRootResolution)
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

export interface DaemonSummary {
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

export function summarizeDaemonStatus(status: HostRuntimeStatus): DaemonSummary {
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
    state: summarizeDaemonState(status.state),
    message: status.message,
  };
}

function summarizeCompactDaemonStatus(
  status: HostRuntimeStatus
): Pick<DaemonSummary, 'message' | 'pidAlive' | 'projectId' | 'ready' | 'status'> {
  return {
    status: status.status,
    ready: status.ready,
    projectId: status.projectId,
    pidAlive: status.pidAlive,
    message: status.message,
  };
}

function summarizeHostKnowledgeState(
  knowledge: HostKnowledgeState,
  checkpointPosture: RetrievalCheckpointPosture | null
): StatusData['knowledge'] {
  const jobs = asPlainRecord(knowledge.jobs) || {};
  return {
    initialized: knowledge.initialized,
    hasKnowledge: knowledge.hasKnowledge,
    usable: knowledge.usable,
    status: typeof knowledge.status === 'string' ? knowledge.status : null,
    recipeCount: typeof knowledge.recipeCount === 'number' ? knowledge.recipeCount : null,
    dbRecipeCount: typeof knowledge.dbRecipeCount === 'number' ? knowledge.dbRecipeCount : null,
    materializedRecipeCount:
      typeof knowledge.materializedRecipeCount === 'number'
        ? knowledge.materializedRecipeCount
        : null,
    skillCount: typeof knowledge.skillCount === 'number' ? knowledge.skillCount : null,
    databaseEntryCount:
      typeof knowledge.databaseEntryCount === 'number' ? knowledge.databaseEntryCount : null,
    lifecycle: knowledge.lifecycle ? { ...knowledge.lifecycle } : null,
    codeDrift: knowledge.codeDrift ? { ...knowledge.codeDrift } : null,
    sourceRevisionManifest: checkpointPosture?.sourceRevisionManifest ?? null,
    sourceRevisionStatus: checkpointPosture?.status ?? null,
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

function readStatusRetrievalCheckpointPosture(
  projectRoot: string,
  databasePath: string,
  hostProjectAlignment: HostProjectAlignment
): RetrievalCheckpointPosture | null {
  if (!existsSync(databasePath)) {
    return null;
  }
  try {
    const repository = createReadOnlyGitDiffCheckpointReader(databasePath);
    const posture = buildRetrievalCheckpointPosture(
      { get: (name: string) => (name === 'gitDiffCheckpointRepository' ? repository : null) },
      resolveRetrievalCheckpointPostureInput(projectRoot)
    );
    if (!posture.sourceRevisionManifest) {
      return posture;
    }
    const identityAlignment =
      hostProjectAlignment.handoffAllowed === true
        ? 'current'
        : hostProjectAlignment.handoffAllowed === false
          ? 'mismatch'
          : 'unknown';
    const sourceAlignment = posture.sourceRevisionManifest.alignment;
    const alignment =
      identityAlignment === 'mismatch'
        ? ('stale' as const)
        : identityAlignment === 'unknown' && sourceAlignment === 'current'
          ? ('unknown' as const)
          : sourceAlignment;
    return {
      ...posture,
      retrievalMayBeStale: alignment !== 'current',
      sourceRevisionManifest: {
        ...posture.sourceRevisionManifest,
        alignment,
        identityAlignment,
      },
      status: alignment,
    };
  } catch {
    return null;
  }
}

function summarizeAutoInitStatus(value: Record<string, unknown>): StatusData['autoInit'] {
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

function summarizeOnboarding(value: unknown): Record<string, unknown> {
  const onboarding = asPlainRecord(value) || {};
  return {
    state: onboarding.state ?? null,
    summary: onboarding.summary ?? null,
    primaryAction: summarizeRecommendedAction(onboarding.primaryAction),
    nextActions: Array.isArray(onboarding.nextActions)
      ? onboarding.nextActions.map(summarizeRecommendedAction).filter(Boolean)
      : [],
    notes: Array.isArray(onboarding.notes)
      ? onboarding.notes.filter((note): note is string => typeof note === 'string').slice(0, 6)
      : [],
    sourcePresence: summarizeSourcePresence(onboarding.sourcePresence),
    currentDimensionGuidance: summarizeCurrentDimensionGuidance(
      onboarding.currentDimensionGuidance
    ),
    currentDimensionNextActions: Array.isArray(onboarding.currentDimensionNextActions)
      ? onboarding.currentDimensionNextActions
          .map(summarizeCurrentDimensionAction)
          .filter((action): action is Record<string, unknown> => action !== null)
      : [],
    progress: summarizeStringRecord(onboarding.progress, [
      'stage',
      'currentDimensionIds',
      'completedDimensionIds',
      'pendingDimensionIds',
      'remainingDimensionIds',
      'dimensionCount',
      'nextRequiredTools',
    ]),
    hostAgentContract: summarizeHostAgentContract(onboarding.hostAgentContract),
  };
}

function summarizeRecommendedAction(value: unknown): Record<string, unknown> | null {
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

function summarizeSourcePresence(value: unknown): Record<string, unknown> | null {
  const presence = asPlainRecord(value);
  if (!presence) {
    return null;
  }
  return summarizeStringRecord(presence, [
    'hasSource',
    'sourceFileCount',
    'sourceFileLimit',
    'capped',
    'maxDepth',
    'unreadableDirectoryCount',
  ]);
}

function summarizeCurrentDimensionGuidance(value: unknown): Record<string, unknown> {
  const guidance = asPlainRecord(value);
  if (!guidance) {
    return {};
  }
  return summarizeStringRecord(guidance, [
    'contractVersion',
    'source',
    'currentTier',
    'dimensionIds',
    'remainingDimensionIds',
    'dimensions',
    'completionRule',
    'note',
    'requiredEvidenceFields',
    'invalidConclusions',
  ]);
}

function summarizeCurrentDimensionAction(value: unknown): Record<string, unknown> | null {
  const action = summarizeRecommendedAction(value);
  const original = asPlainRecord(value);
  if (!action || !original) {
    return action;
  }
  return {
    ...action,
    required: original.required === true,
    ...(typeof original.afterTool === 'string' ? { afterTool: original.afterTool } : {}),
    ...(original.completionGate === true ? { completionGate: true } : {}),
  };
}

function summarizeHostAgentContract(value: unknown): Record<string, unknown> {
  const contract = asPlainRecord(value);
  if (!contract) {
    return {};
  }
  return summarizeStringRecord(contract, [
    'contractVersion',
    'source',
    'scopeBrief',
    'stagedProtocol',
    'submitKnowledgeContract',
    'dimensionCompletionContract',
    'stopConditions',
  ]);
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

function buildHostAgentBootstrapAction(input: {
  label?: string;
  reason?: string;
  startsDaemon: boolean;
}): RecommendedAction {
  return buildRecommendedAction({
    label: input.label || 'Start Codex host-agent bootstrap',
    reason:
      input.reason ||
      'Have Codex read the Mission Briefing, analyze the project, submit knowledge, and complete dimensions without requiring an Alembic AI Provider.',
    startsDaemon: input.startsDaemon,
    tool: 'alembic_bootstrap',
  });
}

function buildHostAgentRescanAction(input: {
  label?: string;
  reason?: string;
  startsDaemon: boolean;
}): RecommendedAction {
  return buildRecommendedAction({
    label: input.label || 'Run Codex host-agent rescan',
    reason:
      input.reason ||
      'Have Codex refresh Alembic project knowledge through the host-agent workflow without requiring an Alembic AI Provider.',
    startsDaemon: input.startsDaemon,
    tool: 'alembic_rescan',
  });
}

function buildAgentPrimeAction(input: {
  label?: string;
  reason?: string;
  startsDaemon: boolean;
}): RecommendedAction {
  return buildRecommendedAction({
    arguments: { inputSource: 'host-declared-intent' },
    label: input.label || 'Prime agent context',
    reason:
      input.reason ||
      'Load compact Alembic project knowledge through the agent-facing public prime tool before non-trivial coding work.',
    startsDaemon: input.startsDaemon,
    tool: 'alembic_prime',
  });
}

export function buildPostInitActions(knowledge: HostKnowledgeState): RecommendedAction[] {
  if (knowledge.usable) {
    return [
      buildAgentPrimeAction({
        reason:
          'Load the most relevant Alembic Recipes through the agent-facing public prime tool before non-trivial coding work.',
        startsDaemon: true,
      }),
      buildHostAgentRescanAction({
        reason: 'Refresh Alembic project knowledge through the Codex host-agent workflow.',
        startsDaemon: true,
      }),
    ];
  }
  return [
    buildHostAgentBootstrapAction({
      reason:
        'Build the first Alembic project knowledge through Codex host-agent analysis; no Alembic AI Provider is required.',
      startsDaemon: true,
    }),
  ];
}

export function buildPostInitMessage(knowledge: HostKnowledgeState): string {
  return knowledge.usable
    ? 'Alembic Codex workspace initialized with usable project knowledge. Next: prime agent context or run host-agent rescan.'
    : 'Alembic Codex workspace initialized. Next: run Codex host-agent bootstrap to build the first usable project knowledge.';
}

export function buildKnowledgeGateActions(knowledge: HostKnowledgeState): RecommendedAction[] {
  const actions = [
    buildRecommendedAction({
      label: 'Check workspace status',
      reason: 'Inspect whether this project is initialized and whether Alembic knowledge exists.',
      startsDaemon: false,
      tool: 'alembic_status',
    }),
  ];
  if (!knowledge.initialized) {
    actions.push(
      buildRecommendedAction({
        label: 'Initialize or attach workspace',
        reason:
          'Create or attach Alembic Codex data roots according to the ProjectRegistry workspace mode.',
        startsDaemon: false,
        tool: 'alembic_init',
      })
    );
  } else {
    actions.push(
      buildHostAgentBootstrapAction({
        reason:
          'Build the first Alembic project knowledge through Codex host-agent analysis; no Alembic AI Provider is required.',
        startsDaemon: true,
      })
    );
  }
  return actions;
}

export function buildStatusOnboarding(input: StatusOnboardingInput): Record<string, unknown> {
  const context = buildStatusOnboardingContext(input);
  const projectRootResolution = input.projectRootResolution;
  if (projectRootResolution && projectRootResolution.trust !== 'trusted') {
    return buildProjectRootUnresolvedOnboarding(projectRootResolution, context);
  }
  if (input.diagnostics.ok === false) {
    return buildRuntimeIssueOnboarding(context);
  }
  if (!input.knowledge.initialized) {
    return buildNeedsInitOnboarding(input, context);
  }
  if (input.knowledge.jobs?.bootstrapRunning) {
    return buildBootstrapInProgressOnboarding(context);
  }
  if (!input.knowledge.usable) {
    return buildNeedsBootstrapOnboarding(context);
  }
  if (input.hostProjectAlignment && !input.hostProjectAlignment.handoffAllowed) {
    return buildProjectHandoffOnboarding(input.hostProjectAlignment, context);
  }
  return buildReadyOnboarding(input, context);
}

function buildStatusOnboardingContext(input: StatusOnboardingInput): StatusOnboardingContext {
  const diagnosticsOk = input.diagnostics.ok !== false;
  return {
    alignmentNotes: buildHostProjectAlignmentNotes(input.hostProjectAlignment),
    boundaryNotes: buildRouteBoundaryNotes(input.enhancementRoute),
    onboardingContract: composeStatusOnboardingContract(input, diagnosticsOk),
  };
}

function buildProjectRootUnresolvedOnboarding(
  projectRootResolution: ProjectRootResolution,
  context: StatusOnboardingContext
): Record<string, unknown> {
  return {
    state: 'project_root_unresolved',
    summary:
      'Alembic Codex cannot determine the target project directory, so project workflows cannot be used yet.',
    primaryAction: buildRecommendedAction({
      label: 'Run diagnostics',
      reason: 'Show why the project root is unavailable and which absolute path must be provided.',
      startsDaemon: false,
      tool: 'alembic_status',
    }),
    nextActions: [
      buildRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Show the rejected or fallback project root and required environment variables.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
    ],
    notes: [
      buildProjectRootRequiredMessage(projectRootResolution),
      ...buildProjectRootRequiredActions(),
      'Initialization and init-on-demand tools fail closed until the project root is trusted.',
      ...context.alignmentNotes,
      ...context.boundaryNotes,
    ],
    ...context.onboardingContract,
  };
}

function buildRuntimeIssueOnboarding(context: StatusOnboardingContext): Record<string, unknown> {
  return {
    state: 'runtime_issue',
    summary:
      'Alembic Codex is installed, but runtime diagnostics need attention before project knowledge is reliable.',
    primaryAction: buildRecommendedAction({
      label: 'Run diagnostics',
      reason: 'Resolve Node, npm, embedded runtime, or plugin metadata issues first.',
      startsDaemon: false,
      tool: 'alembic_status',
    }),
    nextActions: [
      buildRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Inspect structured issues and repair guidance.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
    ],
    notes: [
      'Status checks do not start the daemon.',
      ...context.alignmentNotes,
      ...context.boundaryNotes,
    ],
    ...context.onboardingContract,
  };
}

function buildNeedsInitOnboarding(
  input: StatusOnboardingInput,
  context: StatusOnboardingContext
): Record<string, unknown> {
  const registeredStandard =
    input.workspace?.registered === true && input.workspace.mode === 'standard';
  const hasSource = input.sourcePresence?.hasSource === true;
  const initLabel = registeredStandard ? 'Attach Standard workspace' : 'Initialize Ghost workspace';
  const baseInitReason = registeredStandard
    ? 'Attach Codex to the existing Standard Alembic workspace without changing its mode.'
    : input.knowledge.hasKnowledge
      ? 'Connect Codex to the existing Alembic knowledge base without writing IDE MCP files into the project.'
      : 'Create Alembic Codex data roots without writing IDE MCP files into the project.';
  const initReason = hasSource
    ? `${baseInitReason} Source files are present, so initialization enables a later alembic_bootstrap cold-start guidance step; this status check only recommends that step and does not run it.`
    : baseInitReason;
  return {
    state: input.knowledge.hasKnowledge ? 'needs_init_existing_knowledge' : 'needs_init',
    summary: input.knowledge.hasKnowledge
      ? 'Alembic knowledge files exist for this project, but the Codex workspace runtime has not been initialized yet.'
      : 'Alembic Codex is installed and the runtime is healthy, but this workspace has not been initialized yet.',
    sourcePresence: input.sourcePresence,
    primaryAction: buildRecommendedAction({
      label: initLabel,
      reason: initReason,
      startsDaemon: false,
      tool: 'alembic_init',
    }),
    nextActions: buildNeedsInitNextActions(initLabel, registeredStandard, hasSource),
    notes: buildNeedsInitNotes(input, context, registeredStandard, hasSource),
    ...context.onboardingContract,
  };
}

function buildNeedsInitNextActions(
  initLabel: string,
  registeredStandard: boolean,
  hasSource: boolean
): RecommendedAction[] {
  const nextActions = [
    buildRecommendedAction({
      label: initLabel,
      reason: registeredStandard
        ? 'Set up Codex runtime files in the registered Standard data root.'
        : 'Set up local Alembic config, database, knowledge, and Recipe directories.',
      startsDaemon: false,
      tool: 'alembic_init',
    }),
  ];
  if (hasSource) {
    nextActions.push(
      buildHostAgentBootstrapAction({
        label: 'Plan cold-start after init',
        reason:
          'After alembic_init succeeds, call alembic_bootstrap to build the first cold-start guidance from the detected source tree; this status check does not start bootstrap or create jobs.',
        startsDaemon: false,
      })
    );
  }
  return nextActions;
}

function buildNeedsInitNotes(
  input: StatusOnboardingInput,
  context: StatusOnboardingContext,
  registeredStandard: boolean,
  hasSource: boolean
): string[] {
  return [
    ...buildNeedsInitSourcePresenceNotes({
      hasSource,
      sourcePresence: input.sourcePresence,
      workspaceGhost: input.workspace?.ghost === true,
    }),
    input.knowledge.hasKnowledge
      ? 'Only cold-start initialization tools are exposed until setup completes.'
      : 'Only cold-start initialization tools are exposed until Alembic knowledge exists.',
    registeredStandard
      ? 'This project is already registered as Standard; Codex init inherits that mode unless the user explicitly migrates it.'
      : 'Ghost mode keeps Alembic data outside the repository by default for unregistered projects.',
    ...context.alignmentNotes,
    ...context.boundaryNotes,
  ];
}

function buildBootstrapInProgressOnboarding(
  context: StatusOnboardingContext
): Record<string, unknown> {
  return {
    state: 'bootstrap_in_progress',
    summary:
      'Alembic Codex bootstrap is already running for this project; a second writer must not be started.',
    primaryAction: buildRecommendedAction({
      label: 'Check bootstrap progress',
      reason:
        'Read the single-writer bootstrap lease and wait for the existing Codex-owned bootstrap route to finish.',
      startsDaemon: false,
      tool: 'alembic_status',
    }),
    nextActions: [
      buildRecommendedAction({
        label: 'Check bootstrap progress',
        reason: 'Read bootstrapState.singleWriterLease and current progress without starting work.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
      buildRecommendedAction({
        label: 'Inspect bootstrap job',
        reason: 'Inspect Codex bootstrap job state when job tools are available.',
        startsDaemon: false,
        tool: 'alembic_job',
      }),
    ],
    notes: [
      'bootstrap_in_progress is a visibility state; hard lease enforcement and takeover are handled by the lease-enforcement route.',
      'Do not start another host-agent bootstrap while the lease holder is visible.',
      ...context.alignmentNotes,
      ...context.boundaryNotes,
    ],
    ...context.onboardingContract,
  };
}

function buildNeedsBootstrapOnboarding(context: StatusOnboardingContext): Record<string, unknown> {
  return {
    state: 'needs_bootstrap',
    summary:
      'Alembic Codex is initialized, but this project does not have usable Alembic Recipes or Project Skills yet.',
    primaryAction: buildHostAgentBootstrapAction({
      reason:
        'Build the first Alembic project knowledge through Codex host-agent analysis; no Alembic AI Provider is required.',
      startsDaemon: true,
    }),
    nextActions: [
      buildHostAgentBootstrapAction({
        reason:
          'Create the initial Alembic knowledge base by following the Mission Briefing from Codex.',
        startsDaemon: true,
      }),
    ],
    notes: [
      'Codex host-agent bootstrap does not require an Alembic AI Provider.',
      'Prime, Guard, search, and lifecycle tools are available after the knowledge base is usable.',
      ...context.alignmentNotes,
      ...context.boundaryNotes,
    ],
    ...context.onboardingContract,
  };
}

function buildProjectHandoffOnboarding(
  alignment: HostProjectAlignment,
  context: StatusOnboardingContext
): Record<string, unknown> {
  return {
    state: `project_handoff_${alignment.connectionState}`,
    summary:
      alignment.connectionState === 'mismatch'
        ? 'Alembic Codex is initialized, but the Codex host project differs from the Alembic selected or active project.'
        : 'Alembic Codex is initialized, but this Codex host project is not connected to an active Alembic runtime project yet.',
    primaryAction: buildRecommendedAction({
      label: 'Check workspace status',
      reason:
        'Inspect the Codex host project, Alembic selected project, and active runtime project before Dashboard handoff.',
      startsDaemon: false,
      tool: 'alembic_status',
    }),
    nextActions: [
      buildRecommendedAction({
        label: 'Run diagnostics',
        reason: 'Review plugin runtime status and project handoff mismatch details.',
        startsDaemon: false,
        tool: 'alembic_status',
      }),
    ],
    notes: [
      ...context.alignmentNotes,
      'Plugin does not switch Alembic projects or start an embedded runtime to cover a different selected project.',
      ...context.boundaryNotes,
    ],
    ...context.onboardingContract,
  };
}

function buildReadyOnboarding(
  input: StatusOnboardingInput,
  context: StatusOnboardingContext
): Record<string, unknown> {
  const daemonReady = input.daemonStatus.ready === true;
  return {
    state: daemonReady ? 'ready_daemon_running' : 'ready',
    summary: daemonReady
      ? 'Alembic Codex is initialized and the daemon is ready.'
      : 'Alembic Codex is initialized. The daemon will start on demand when a project-knowledge tool needs it.',
    primaryAction: buildAgentPrimeAction({
      reason:
        'Load relevant Alembic Recipes through the agent-facing public prime tool before non-trivial coding work.',
      startsDaemon: !daemonReady,
    }),
    nextActions: [
      buildAgentPrimeAction({
        reason:
          'Load project conventions and trusted context from taskAction, requirementGoal, and locator facets.',
        startsDaemon: !daemonReady,
      }),
      buildHostAgentRescanAction({
        reason: 'Refresh project knowledge through the Codex host-agent workflow.',
        startsDaemon: !daemonReady,
      }),
    ],
    notes: daemonReady
      ? [
          'Dashboard and job APIs are available now.',
          ...context.alignmentNotes,
          ...context.boundaryNotes,
        ]
      : [
          'Status checks stay light; project-knowledge tools wake the daemon only when needed.',
          ...context.alignmentNotes,
          ...context.boundaryNotes,
        ],
    ...context.onboardingContract,
  };
}

function buildNeedsInitSourcePresenceNotes(input: {
  hasSource: boolean;
  sourcePresence?: SourcePresence;
  workspaceGhost: boolean;
}): string[] {
  if (!input.sourcePresence) {
    return [];
  }
  if (input.hasSource) {
    return [
      input.workspaceGhost
        ? 'Source files were detected in the project tree; Ghost mode keeps Alembic data outside the repository, but host-visible bootstrap guidance is still useful after init.'
        : 'Source files were detected in the project tree; after init, alembic_bootstrap can build cold-start guidance, but this status check did not start it.',
    ];
  }
  return [
    input.workspaceGhost
      ? 'No source files were detected by the bounded status probe; Ghost mode remains quiet and does not suggest bootstrap yet.'
      : 'No source files were detected by the bounded status probe, so bootstrap guidance stays quiet until the project contains source code.',
  ];
}

function composeStatusOnboardingContract(
  input: StatusOnboardingInput,
  diagnosticsOk: boolean
): ReturnType<typeof buildStatusOnboardingContract> {
  const latestSnapshot = input.knowledge.snapshots?.latest;
  return buildStatusOnboardingContract({
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

function buildHostProjectAlignmentNotes(alignment?: HostProjectAlignment): string[] {
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

function buildRouteBoundaryNotes(enhancementRoute?: HostEnhancementRouteChoice): string[] {
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
    enhancementRoute.selected === 'resident'
      ? `Resident Alembic service route: ${enhancementRoute.selected}. ${enhancementRoute.reason}`
      : `Pure-local route (in-process Services + local vector): ${enhancementRoute.selected}. ${enhancementRoute.reason}`;
  return [
    `Host-agent route uses source=${enhancementRoute.hostAgentRoute.source} for Codex-submitted knowledge, proposals, and dimension completion.`,
    routeNote,
    `Resident daemon job provider config: ${providerSummary}; this is provider/model state, not a Plugin knowledge source.`,
  ];
}

export function buildRecommendedAction(input: {
  arguments?: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}): RecommendedAction {
  return {
    arguments: input.arguments || {},
    label: input.label,
    reason: input.reason,
    startsDaemon: input.startsDaemon,
    tool: input.tool,
  };
}

export function buildActionLabels(actions: unknown): string[] {
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

function summarizeDaemonState(state: unknown): Record<string, unknown> | null {
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
