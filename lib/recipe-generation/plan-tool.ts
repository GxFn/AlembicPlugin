import { execFileSync } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path, { basename } from 'node:path';
import {
  buildDimensionCatalogPayload,
  type DimensionCatalogPayloadItem,
  type ProjectLanguageFrameworkFacts,
} from '@alembic/core/dimensions';
import {
  baseDimensions,
  buildProjectContextMissionBriefing,
  type DimensionDef,
  resolvePlanDimensionDefinitions,
} from '@alembic/core/host-agent-workflows';
import {
  buildPlanDraftInformationPackage,
  compareProjectContextSignature,
  computeProjectContextSignature,
  type PlanGenerationState,
  type PlanIntent,
  PlanLedgerService,
  type PlanModuleBinding,
  type PlanNextAction,
  type PlanRecord,
  type PlanScaleDecision,
  type PlanStageId,
  type PlanView,
} from '@alembic/core/plans';
import {
  buildProjectContextPresenterInput,
  type ProjectContextEnvelope,
  type ProjectContextPresenterInput,
  type ProjectContextRef,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type RepoContext,
} from '@alembic/core/project-context';
import { ProjectContextCapabilities } from '@alembic/core/project-context-capabilities';
import { LanguageService } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildColdStartOnboardingContract } from '#codex/status/OnboardingContract.js';
import type { PlanInput } from '#shared/schemas/mcp-tools.js';
import {
  buildProjectContextCreationGuide,
  buildProjectContextCreationNextActions,
  type ProjectContextCreationStage,
} from './project-context-anchoring.js';

interface PlanToolContext {
  actor?: { role?: string; user?: string };
  container: {
    get(name: string): unknown;
    singletons?: Record<string, unknown>;
  };
}

interface PlanToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

interface PlanModuleSeed {
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  ref?: ProjectContextRef;
  role?: string;
}

interface PlanProjectSourceFileFact {
  filePath: string;
  language: string;
  sizeBytes: number;
}

interface PlanProjectContextAnalysis {
  contextStatus: 'complete' | 'partial';
  dimensions: DimensionDef[];
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  factSource: 'project-context';
  fileCount: number;
  frameworks: string[];
  moduleCount: number;
  moduleSeeds: PlanModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  primaryLanguage: string;
  projectType: string;
  requestKinds: ProjectContextRequestKind[];
  secondaryLanguages: string[];
  sourceFileFacts: PlanProjectSourceFileFact[];
  understandingGaps: Record<string, unknown>[];
}

type DraftDimensionCatalogItem = Omit<DimensionCatalogPayloadItem, 'weight'>;

interface ModuleSnapshot {
  files: string[];
  fingerprint: string;
  moduleId: string;
  moduleName: string;
  role?: string;
}

type PlanArgs = PlanInput;
type ArchitectureIntelligence = ReturnType<
  typeof ProjectContextCapabilities.analyzeArchitectureIntelligence
>;
type DynamicPlanningSignals = ReturnType<
  typeof ProjectContextCapabilities.aggregateDynamicPlanningSignals
>;
type PlanDraftPackage = ReturnType<typeof buildPlanDraftInformationPackage>;
type PlanRepositories = ConstructorParameters<typeof PlanLedgerService>[0];

interface PlanDraftContext {
  analysis: PlanProjectContextAnalysis;
  dynamicSignals: DynamicPlanningSignals;
  planningBrief: Record<string, unknown>;
  projectContextSignature: string;
  projectRoot: string;
  draftPackage: PlanDraftPackage;
}

interface ConfirmPlanBase {
  planId: string;
  version: number;
}

type ConfirmBaseResult =
  | { ok: true; base: ConfirmPlanBase; projectContextSignature: string }
  | { ok: false; response: PlanToolResponse };

type ConfirmCurrentSignatureResult =
  | { ok: true; currentProjectContextSignature: string }
  | { ok: false; response: PlanToolResponse };

type BuildConfirmIntentResult =
  | { ok: true; intent: PlanIntent }
  | { ok: false; response: PlanToolResponse };

const COUNTABLE_RECIPE_LIFECYCLES = [
  'active',
  'staging',
  'evolving',
  'decaying',
  'deprecated',
] as const;

const PLAN_TOOL_NAME = 'alembic_plan';
const PLAN_SOURCE_SCAN_MAX_FILES = 5000;
const PLAN_MODULE_OWNED_FILE_LIMIT = 400;
const PLAN_SOURCE_SCAN_EXCLUDE_DIRS = new Set([
  ...LanguageService.scanSkipDirs,
  '.asd',
  '.git',
  '.wakeflow-active',
  '.wakeflow-local',
  'DerivedData',
  'node_modules',
]);

export async function routePlanTool(
  ctx: PlanToolContext,
  args: PlanArgs
): Promise<PlanToolResponse> {
  switch (args.operation) {
    case 'draft':
      return draftPlan(ctx, args);
    case 'confirm':
      return confirmPlan(ctx, args);
    case 'get':
      return getPlan(ctx, args);
    default:
      return blocked(
        'PLAN_INVALID_OPERATION',
        'alembic_plan operation must be draft, confirm, or get.'
      );
  }
}

async function draftPlan(ctx: PlanToolContext, args: PlanArgs): Promise<PlanToolResponse> {
  const projectRoot = resolvePlanProjectRoot(ctx, args);
  const analysis = await collectPlanProjectContext(projectRoot, args.hints);
  if (analysis.fileCount === 0 && analysis.moduleCount === 0) {
    return emptyProjectContextResponse(projectRoot);
  }

  const draftContext = await buildPlanDraftContext(ctx, args, projectRoot, analysis);
  const plan = savePlanDraft(ctx, args, draftContext);
  return planDraftResponse(plan, draftContext);
}

async function confirmPlan(ctx: PlanToolContext, args: PlanArgs): Promise<PlanToolResponse> {
  const baseResult = resolveConfirmPlanBase(args);
  if (!baseResult.ok) {
    return baseResult.response;
  }
  const { base, projectContextSignature } = baseResult;
  const repositories = resolvePlanRepositories(ctx);
  const draft = repositories.planRepository.get(base.planId, base.version);
  if (!draft) {
    return blocked('PLAN_NOT_FOUND', `Plan ${base.planId}@${base.version} does not exist.`, {
      operation: 'confirm',
      plan: base,
    });
  }
  const versionResponse = validateConfirmPlanVersion(repositories, base, draft);
  if (versionResponse) {
    return versionResponse;
  }
  const signatureEchoResponse = validateDraftSignatureEcho(draft, projectContextSignature);
  if (signatureEchoResponse) {
    return signatureEchoResponse;
  }
  const projectRoot = args.projectRoot ?? draft.projectRoot;
  const signatureResult = await validateConfirmCurrentSignature(projectRoot, draft);
  if (!signatureResult.ok) {
    return signatureResult.response;
  }
  const payloadResult = buildConfirmedPlanIntent(args, draft);
  if (!payloadResult.ok) {
    return payloadResult.response;
  }
  let confirmed: PlanRecord;
  try {
    confirmed = saveConfirmedPlan(ctx, args, base, payloadResult.intent);
  } catch (err: unknown) {
    return blocked(
      'PLAN_CONFIRM_PAYLOAD_INVALID',
      err instanceof Error ? err.message : 'Core rejected the complete Plan confirmation payload.',
      { operation: 'confirm', plan: projectPlanRecord(draft) }
    );
  }
  const view = await createPlanLedgerService(ctx).getPlanView(
    confirmed.planId,
    confirmed.version,
    signatureResult.currentProjectContextSignature
  );
  return confirmedPlanResponse(confirmed, view, signatureResult.currentProjectContextSignature);
}

function emptyProjectContextResponse(projectRoot: string): PlanToolResponse {
  return blocked(
    'PLAN_PROJECT_CONTEXT_EMPTY',
    'ProjectContext returned no files or modules for Plan draft.',
    {
      operation: 'draft',
      projectRoot,
      planDiagnostics: [
        {
          code: 'project-context-empty',
          severity: 'warning',
          message: 'No ProjectContext files/modules were available to ground a Plan draft.',
        },
      ],
    }
  );
}

async function buildPlanDraftContext(
  ctx: PlanToolContext,
  args: PlanArgs,
  projectRoot: string,
  analysis: PlanProjectContextAnalysis
): Promise<PlanDraftContext> {
  const architectureIntelligence = analyzeDraftArchitecture(projectRoot, analysis);
  const dynamicSignals = await buildDynamicSignals(ctx, {
    architectureIntelligence,
    dimensions: analysis.dimensions,
    moduleSnapshots: collectModuleSnapshots(analysis),
  });
  const projectContextSignature = computePlanProjectContextSignature({
    analysis,
    architectureStyle: architectureIntelligence.styles.primary,
    projectRoot,
  });
  const draftPackage = buildDraftInformationPackage(ctx, args, {
    analysis,
    architectureIntelligence,
    dynamicSignals,
    projectContextSignature,
  });
  return {
    analysis,
    dynamicSignals,
    planningBrief: buildDraftPlanningBrief(projectRoot, analysis, draftPackage, {
      dynamicSignals,
    }),
    projectContextSignature,
    projectRoot,
    draftPackage,
  };
}

function analyzeDraftArchitecture(
  projectRoot: string,
  analysis: PlanProjectContextAnalysis
): ArchitectureIntelligence {
  return ProjectContextCapabilities.analyzeArchitectureIntelligence({
    projectContext: analysis.presenterInput,
    primaryLanguage: analysis.primaryLanguage,
    projectRoot,
  });
}

function buildDraftInformationPackage(
  ctx: PlanToolContext,
  args: PlanArgs,
  input: {
    analysis: PlanProjectContextAnalysis;
    architectureIntelligence: ArchitectureIntelligence;
    dynamicSignals: DynamicPlanningSignals;
    projectContextSignature: string;
  }
): PlanDraftPackage {
  const profile = input.analysis;
  return buildPlanDraftInformationPackage({
    dynamicSignals: input.dynamicSignals as unknown as Record<string, unknown>,
    hints: buildDraftHints(ctx, args),
    missionBriefing: buildMissionBriefingForDraft(profile, resolvePlanProjectRoot(ctx, args)),
    projectContextSignature: input.projectContextSignature,
    projectProfile: {
      architectureHints: [
        input.architectureIntelligence.styles.primary,
        ...input.architectureIntelligence.domains.projectPresentDomains,
      ],
      fileCount: profile.fileCount,
      frameworks: profile.frameworks,
      moduleCount: profile.moduleCount,
      primaryLanguage: profile.primaryLanguage,
      projectType: profile.projectType,
      secondaryLanguages: profile.secondaryLanguages,
    },
  });
}

function buildDraftHints(ctx: PlanToolContext, args: PlanArgs): Record<string, unknown> {
  return {
    ...(args.hints?.focusModules ? { focusModules: args.hints.focusModules } : {}),
    ...(args.hints?.maxBudget ? { maxBudget: args.hints.maxBudget } : {}),
    createdBy: resolvePlanActor(ctx),
  };
}

function buildMissionBriefingForDraft(
  analysis: PlanProjectContextAnalysis,
  projectRoot: string
): Record<string, unknown> {
  return buildProjectContextMissionBriefing({
    activeDimensions: analysis.dimensions,
    profile: 'cold-start-host-agent',
    projectContext: analysis.presenterInput,
    session: createPlanDraftSession(projectRoot),
  });
}

function buildOnboardingContractForDraft(
  analysis: PlanProjectContextAnalysis,
  projectRoot: string
): ReturnType<typeof buildColdStartOnboardingContract> {
  return buildColdStartOnboardingContract({
    dimensions: analysis.dimensions,
    fileCount: analysis.fileCount,
    moduleCount: analysis.moduleCount,
    primaryLanguage: analysis.primaryLanguage,
    projectRoot,
    projectType: analysis.projectType,
    secondaryLanguages: analysis.secondaryLanguages,
    session: createPlanDraftSession(projectRoot),
  });
}

function buildDraftPlanningBrief(
  projectRoot: string,
  analysis: PlanProjectContextAnalysis,
  draftPackage: PlanDraftPackage,
  reports: {
    dynamicSignals: DynamicPlanningSignals;
  }
): Record<string, unknown> {
  const missionBriefing = buildMissionBriefingForDraft(analysis, projectRoot);
  const dimensionCatalog = buildDraftDimensionCatalog(analysis);
  return {
    ...draftPackage.planningBrief,
    dimensionCatalog,
    onboardingContract: summarizeOnboardingContract(
      buildOnboardingContractForDraft(analysis, projectRoot)
    ),
    projectContextCreationGuide: buildProjectContextCreationGuide({
      dimensionIds: analysis.dimensions.map((dimension) => dimension.id),
      projectRoot,
      stage: 'plan-draft',
    }),
    projectContext: buildProjectContextFactPackage(analysis),
    sourceReports: {
      dimensionCatalog,
      dynamicSignals: reports.dynamicSignals as unknown as Record<string, unknown>,
      missionBriefing,
    },
  };
}

function buildDraftDimensionCatalog(analysis: PlanProjectContextAnalysis): Record<string, unknown> {
  const facts = buildProjectLanguageFrameworkFacts(analysis);
  const dimensions = buildDimensionCatalogPayload(facts).map(omitDraftDimensionWeight);
  return {
    source: 'DIMENSION_REGISTRY',
    policy: {
      allDimensionsReturned: true,
      agentOwnsRelevanceAndScale: true,
      languageApplicableIsFactualOnly: true,
      noDraftRankingOrFiltering: true,
    },
    projectFacts: facts,
    dimensionCount: dimensions.length,
    dimensions,
  };
}

function buildProjectLanguageFrameworkFacts(
  analysis: PlanProjectContextAnalysis
): ProjectLanguageFrameworkFacts {
  const sourceLanguages = analysis.sourceFileFacts.map((file) => file.language);
  const languages = uniqueStrings([
    analysis.primaryLanguage,
    ...analysis.secondaryLanguages,
    ...sourceLanguages,
  ]);
  return {
    frameworks: analysis.frameworks,
    languages,
    primaryLanguage: analysis.primaryLanguage,
  };
}

function omitDraftDimensionWeight(
  dimension: DimensionCatalogPayloadItem
): DraftDimensionCatalogItem {
  // draft 只交付事实材料，不把历史 registry weight 暴露成 Agent 可能误读的优先级。
  const { weight: _weight, ...draftDimension } = dimension;
  return draftDimension;
}

function savePlanDraft(
  ctx: PlanToolContext,
  args: PlanArgs,
  draftContext: PlanDraftContext
): PlanRecord {
  return createPlanLedgerService(ctx).saveDraft({
    createdBy: resolvePlanActor(ctx),
    lastUpdatedFromCommit: readGitCommit(draftContext.projectRoot),
    projectContextSignature: draftContext.projectContextSignature,
    projectRoot: draftContext.projectRoot,
    rationale: args.hints?.goal
      ? [`draft goal: ${args.hints.goal}`]
      : ['Plan draft fact package collected.'],
  });
}

function planDraftResponse(plan: PlanRecord, draftContext: PlanDraftContext): PlanToolResponse {
  return {
    success: true,
    message: `Plan draft ${plan.planId}@${plan.version} is ready for Agent confirmation.`,
    data: {
      operation: 'draft',
      projectRoot: draftContext.projectRoot,
      projectContextSignature: draftContext.projectContextSignature,
      currentProjectContextSignature: draftContext.projectContextSignature,
      projectContextCreationGuide: buildProjectContextCreationGuide({
        dimensionIds: draftContext.analysis.dimensions.map((dimension) => dimension.id),
        projectRoot: draftContext.projectRoot,
        stage: 'plan-draft',
      }),
      plan: projectPlanRecord(plan),
      planningBrief: draftContext.planningBrief,
      ...(draftContext.analysis.contextStatus === 'partial'
        ? { planDiagnostics: buildPartialProjectContextDiagnostics(draftContext.analysis) }
        : {}),
      sourceReports: draftContext.planningBrief.sourceReports,
      nextActions: [buildDraftConfirmNextAction(plan, draftContext.projectContextSignature)],
    },
  };
}

function buildDraftConfirmNextAction(
  plan: PlanRecord,
  projectContextSignature: string
): Record<string, unknown> {
  return {
    tool: PLAN_TOOL_NAME,
    operation: 'confirm',
    required: true,
    reason:
      'Agent must author a complete Plan confirmation payload from the returned facts before generation.',
    requiredPayloadFields: [
      'selectedDimensions',
      'scale',
      'moduleBindings',
      'plannedNextActions',
      'evidenceRefs',
      'rationale',
    ],
    args: {
      operation: 'confirm',
      basePlanId: plan.planId,
      baseVersion: plan.version,
      projectContextSignature,
    },
  };
}

function resolveConfirmPlanBase(args: PlanArgs): ConfirmBaseResult {
  const planId = args.basePlanId ?? args.planId;
  const version = args.baseVersion ?? args.version;
  if (!planId || !version) {
    return {
      ok: false,
      response: blocked(
        'PLAN_CONFIRM_BASE_REQUIRED',
        'confirm requires basePlanId/planId and baseVersion/version.',
        {
          operation: 'confirm',
          planDiagnostics: [
            {
              code: 'base-plan-required',
              severity: 'error',
              message: 'No base Plan id/version was supplied.',
            },
          ],
        }
      ),
    };
  }
  if (!args.projectContextSignature) {
    return {
      ok: false,
      response: blocked(
        'PLAN_CONFIRM_SIGNATURE_REQUIRED',
        'confirm requires projectContextSignature returned by draft.',
        { operation: 'confirm', plan: { planId, version } }
      ),
    };
  }
  return {
    ok: true,
    base: { planId, version },
    projectContextSignature: args.projectContextSignature,
  };
}

function validateConfirmPlanVersion(
  repositories: PlanRepositories,
  base: ConfirmPlanBase,
  draft: PlanRecord
): PlanToolResponse | null {
  const latest = repositories.planRepository.get(base.planId);
  if (!latest || latest.version === base.version) {
    return null;
  }
  return blocked(
    'PLAN_STALE_VERSION',
    `Plan ${base.planId}@${base.version} is stale; latest version is ${latest.version}.`,
    {
      operation: 'confirm',
      plan: projectPlanRecord(draft),
      planDiagnostics: [
        {
          code: 'stale-plan-version',
          severity: 'error',
          message: `Latest draft version is ${latest.version}.`,
        },
      ],
    }
  );
}

function validateDraftSignatureEcho(
  draft: PlanRecord,
  projectContextSignature: string
): PlanToolResponse | null {
  if (draft.projectContextSignature === projectContextSignature) {
    return null;
  }
  return blocked(
    'PLAN_SIGNATURE_ECHO_MISMATCH',
    'Provided projectContextSignature does not match the draft Plan signature.',
    {
      operation: 'confirm',
      plan: projectPlanRecord(draft),
      signature: compareProjectContextSignature(
        draft.projectContextSignature,
        projectContextSignature
      ),
    }
  );
}

function buildPlanProjectContextHintsFromRecord(_plan: PlanRecord): PlanArgs['hints'] | undefined {
  return undefined;
}

async function validateConfirmCurrentSignature(
  projectRoot: string,
  draft: PlanRecord
): Promise<ConfirmCurrentSignatureResult> {
  const currentProjectContextSignature = await computeCurrentSignature(
    projectRoot,
    buildPlanProjectContextHintsFromRecord(draft)
  );
  const signature = compareProjectContextSignature(
    draft.projectContextSignature,
    currentProjectContextSignature
  );
  if (signature.matches) {
    return { ok: true, currentProjectContextSignature };
  }
  return {
    ok: false,
    response: blocked(
      'PLAN_PROJECT_CONTEXT_STALE',
      'Current ProjectContext signature differs from the draft Plan signature.',
      {
        operation: 'confirm',
        currentProjectContextSignature,
        plan: projectPlanRecord(draft),
        planDiagnostics: [
          {
            code: 'project-context-signature-mismatch',
            severity: 'error',
            message:
              'Project files/modules changed after draft; refresh the draft before confirming.',
          },
        ],
        signature,
      }
    ),
  };
}

function saveConfirmedPlan(
  ctx: PlanToolContext,
  args: PlanArgs,
  base: ConfirmPlanBase,
  intent: PlanIntent
): PlanRecord {
  try {
    return createPlanLedgerService(ctx).confirmPlan({
      confirmedBy: resolvePlanActor(ctx),
      intent,
      planId: base.planId,
      rationale: normalizeRequiredRationale(args.rationale),
      version: base.version,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Core rejected the complete Plan confirmation payload.';
    throw new Error(message);
  }
}

function confirmedPlanResponse(
  confirmed: PlanRecord,
  view: PlanView | null,
  currentProjectContextSignature: string
): PlanToolResponse {
  return {
    success: true,
    message: `Plan ${confirmed.planId}@${confirmed.version} confirmed for downstream generation.`,
    data: {
      operation: 'confirm',
      projectRoot: confirmed.projectRoot,
      projectContextSignature: confirmed.projectContextSignature,
      currentProjectContextSignature,
      projectContextCreationGuide: buildPlanProjectContextCreationGuide(confirmed, 'plan-confirm'),
      plan: projectPlanRecord(confirmed),
      ...(view
        ? {
            planView: projectPlanView(view),
            planState: projectPlanState(view.state),
            signature: view.signature,
          }
        : {}),
      nextActions: [
        {
          tool: PLAN_TOOL_NAME,
          operation: 'get',
          required: false,
          reason:
            'Read the active confirmed Plan with current generation-state projection before generation work.',
          args: { operation: 'get', projectRoot: confirmed.projectRoot },
        },
      ],
    },
  };
}

async function getPlan(ctx: PlanToolContext, args: PlanArgs): Promise<PlanToolResponse> {
  const repositories = resolvePlanRepositories(ctx);
  const service = createPlanLedgerService(ctx);
  const projectRoot = resolvePlanProjectRoot(ctx, args);
  const planRecord = args.planId
    ? repositories.planRepository.get(args.planId, args.version)
    : repositories.planRepository.getActiveConfirmed(projectRoot);
  if (!planRecord) {
    return blocked('PLAN_NOT_FOUND', 'No matching confirmed Plan was found.', {
      operation: 'get',
      projectRoot,
      projectContextCreationGuide: buildProjectContextCreationGuide({
        projectRoot,
        stage: 'plan-get',
      }),
      planDiagnostics: [
        {
          code: 'no-confirmed-plan',
          severity: 'warning',
          message: 'Call alembic_plan draft and confirm before generation-stage tools.',
        },
      ],
      nextActions: [
        {
          tool: PLAN_TOOL_NAME,
          operation: 'draft',
          required: true,
          reason: 'Create a Plan draft before generation work.',
          args: { operation: 'draft', projectRoot },
        },
      ],
    });
  }
  const currentProjectContextSignature =
    args.projectContextSignature ??
    (await computeCurrentSignature(
      planRecord.projectRoot,
      buildPlanProjectContextHintsFromRecord(planRecord)
    ));
  const view = args.planId
    ? await service.getPlanView(
        planRecord.planId,
        planRecord.version,
        currentProjectContextSignature
      )
    : await service.getActivePlanView(planRecord.projectRoot, currentProjectContextSignature);
  if (!view) {
    return blocked(
      'PLAN_VIEW_UNAVAILABLE',
      `Plan ${planRecord.planId}@${planRecord.version} could not be projected.`,
      {
        operation: 'get',
        plan: projectPlanRecord(planRecord),
      }
    );
  }
  return {
    success: true,
    message: `Plan ${view.intent.planId}@${view.intent.version} returned with generation-state projection.`,
    data: {
      operation: 'get',
      projectRoot: view.intent.projectRoot,
      projectContextSignature: view.intent.projectContextSignature,
      currentProjectContextSignature,
      projectContextCreationGuide: buildPlanProjectContextCreationGuide(view.intent, 'plan-get'),
      plan: projectPlanRecord(view.intent),
      planView: projectPlanView(view),
      planState: projectPlanState(view.state),
      signature: view.signature,
      nextActions: buildGetNextActions(view),
    },
  };
}

async function collectPlanProjectContext(
  projectRoot: string,
  _hints: PlanArgs['hints']
): Promise<PlanProjectContextAnalysis> {
  const envelopes: ProjectContextEnvelope<ProjectContextResult>[] = [];
  const push = async (
    kind: ProjectContextRequestKind,
    payload?: Record<string, unknown>
  ): Promise<ProjectContextEnvelope<ProjectContextResult>> => {
    const envelope = await ProjectContextCapabilities.execute({
      kind,
      payload,
      project: {
        displayName: basename(projectRoot),
        projectRoot,
        source: 'codex-host-plan',
      },
      scope: { projectRoot },
    });
    envelopes.push(envelope);
    return envelope;
  };

  await push('space', { includeProjectTree: true });
  const repoEnvelope = await push('repo', { includeMapSummary: true });
  const repo = isRepoContext(repoEnvelope.data) ? repoEnvelope.data : undefined;
  const sourceFileFacts = await collectProjectSourceFileFacts(projectRoot);
  const moduleSeeds = attachSourceFilesToModuleSeeds(selectPlanModuleSeeds(repo), sourceFileFacts);
  if (moduleSeeds.length > 0) {
    await push('map', {
      moduleSeeds,
      repoName: readRecord(repo)?.repo ? readString(readRecord(repo)?.repo, 'name') : undefined,
    });
  }
  for (const seed of moduleSeeds) {
    await push('module', {
      ...seed,
      includeDependencies: true,
      includePublicSurfaces: true,
    });
    await push('module-layers', {
      ...seed,
      includeBoundaryCrossings: true,
    });
  }

  const presenterInput = buildProjectContextPresenterInput(envelopes);
  const frameworks = uniqueStrings(collectFrameworkHints(presenterInput));
  const primaryLanguage = inferPrimaryLanguage(presenterInput);
  const secondaryLanguages = inferSecondaryLanguages(presenterInput, primaryLanguage);
  const repoFileCount = countRepoLanguageFiles(repo);
  const moduleCount =
    presenterInput.modules.length || presenterInput.map?.modules.length || moduleSeeds.length;
  const understandingGaps = buildProjectContextUnderstandingGaps({
    moduleCount,
    moduleSeeds,
    presenterInput,
    repoFileCount,
  });
  return {
    contextStatus: understandingGaps.length > 0 ? 'partial' : 'complete',
    dimensions: [...baseDimensions],
    envelopes,
    factSource: 'project-context',
    fileCount: Math.max(presenterInput.files.length, repoFileCount, sourceFileFacts.length),
    frameworks,
    moduleCount,
    moduleSeeds,
    presenterInput,
    primaryLanguage,
    projectType: inferProjectType(presenterInput),
    requestKinds: [...new Set(envelopes.map((envelope) => envelope.queryLevel))],
    secondaryLanguages,
    sourceFileFacts,
    understandingGaps,
  };
}

async function collectProjectSourceFileFacts(
  projectRoot: string
): Promise<PlanProjectSourceFileFact[]> {
  const facts: PlanProjectSourceFileFact[] = [];
  const absoluteRoot = path.resolve(projectRoot);
  const pending = [absoluteRoot];
  while (pending.length > 0 && facts.length < PLAN_SOURCE_SCAN_MAX_FILES) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    const entries = await safeReadDir(current);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toProjectContextPath(path.relative(absoluteRoot, absolutePath));
      if (!relativePath || relativePath.startsWith('..')) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!PLAN_SOURCE_SCAN_EXCLUDE_DIRS.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const language = LanguageService.inferLang(relativePath);
      if (language === 'unknown') {
        continue;
      }
      const stat = await safeStat(absolutePath);
      facts.push({
        filePath: relativePath,
        language,
        sizeBytes: stat?.size ?? 0,
      });
      if (facts.length >= PLAN_SOURCE_SCAN_MAX_FILES) {
        break;
      }
    }
  }
  return facts.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

async function safeReadDir(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function attachSourceFilesToModuleSeeds(
  seeds: readonly PlanModuleSeed[],
  sourceFileFacts: readonly PlanProjectSourceFileFact[]
): PlanModuleSeed[] {
  const sourceFilesByPath = new Set(sourceFileFacts.map((file) => file.filePath));
  return mergePlanModuleSeeds(
    seeds
      .map((seed) => {
        const explicitFiles = uniqueStrings(
          (seed.ownedFiles ?? [])
            .map(normalizePath)
            .filter(isPresent)
            .filter((filePath) => sourceFilesByPath.has(filePath))
        );
        const matchedFiles = sourceFilesForModuleSeed(seed, sourceFileFacts).map(
          (file) => file.filePath
        );
        const ownedFiles = uniqueStrings([...explicitFiles, ...matchedFiles]).slice(
          0,
          PLAN_MODULE_OWNED_FILE_LIMIT
        );
        return {
          ...seed,
          ownedFiles: ownedFiles.length > 0 ? ownedFiles : undefined,
        };
      })
      .filter((seed) => hasSeedScope(seed) && (seed.ownedFiles?.length ?? 0) > 0)
  );
}

function sourceFilesForModuleSeed(
  seed: PlanModuleSeed,
  sourceFileFacts: readonly PlanProjectSourceFileFact[]
): PlanProjectSourceFileFact[] {
  const modulePath = normalizePath(seed.modulePath);
  if (!modulePath) {
    return [];
  }
  return sourceFileFacts.filter(
    (file) => file.filePath === modulePath || file.filePath.startsWith(`${modulePath}/`)
  );
}

function toProjectContextPath(value: string): string {
  return value.split(path.sep).join('/');
}

function mergePlanModuleSeeds(seeds: readonly PlanModuleSeed[]): PlanModuleSeed[] {
  return dedupeBy(
    seeds.map((seed) => ({ ...seed, modulePath: normalizePath(seed.modulePath) })),
    (seed) => `${seed.modulePath ?? seed.ownedFiles?.join(',')}:${seed.moduleName}`
  );
}

function countRepoLanguageFiles(repo: RepoContext | undefined): number {
  return arrayRecords(readRecord(repo).languages).reduce(
    (sum, language) => sum + (readNumber(language, 'fileCount') ?? 0),
    0
  );
}

function buildProjectContextUnderstandingGaps(input: {
  moduleCount: number;
  moduleSeeds: readonly PlanModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  repoFileCount: number;
}): Record<string, unknown>[] {
  const gaps: Record<string, unknown>[] = [];
  if (input.repoFileCount > 0 && input.presenterInput.files.length === 0) {
    gaps.push({
      code: 'project-context-files-omitted',
      severity: 'warning',
      message:
        'ProjectContext repo facts reported language files, but no file summaries were present in the presenter payload.',
      omittedFact: 'fileSummaries',
      repoFileCount: input.repoFileCount,
    });
  }
  if (input.moduleSeeds.length > 0 && input.moduleCount === 0) {
    gaps.push({
      code: 'project-context-modules-partial',
      severity: 'warning',
      message:
        'ProjectContext repo facts exposed module seeds, but map/module presenter details were not available.',
      omittedFact: 'moduleDetails',
      moduleSeedCount: input.moduleSeeds.length,
    });
  }
  return gaps;
}

function buildPartialProjectContextDiagnostics(
  analysis: PlanProjectContextAnalysis
): Record<string, unknown>[] {
  return analysis.understandingGaps.map((gap) => ({
    ...gap,
    code: readString(gap, 'code') ?? 'project-context-partial',
    severity: readString(gap, 'severity') ?? 'warning',
  }));
}

async function buildDynamicSignals(
  ctx: PlanToolContext,
  input: {
    architectureIntelligence: Parameters<
      typeof ProjectContextCapabilities.aggregateDynamicPlanningSignals
    >[0]['architectureIntelligence'];
    dimensions: readonly DimensionDef[];
    moduleSnapshots: readonly ModuleSnapshot[];
  }
) {
  const recipes = await safeFindRecipes(ctx);
  const sourceRefs = safeSourceRefs(ctx);
  const recipeById = new Map(recipes.map((recipe) => [readString(recipe, 'id'), recipe]));
  const dimensionCoverage = input.dimensions.map((dimension) => {
    const matching = recipes.filter((recipe) => readString(recipe, 'dimensionId') === dimension.id);
    const decayingRecipeIds = matching
      .filter((recipe) =>
        ['decaying', 'deprecated'].includes(readString(recipe, 'lifecycle') ?? '')
      )
      .map((recipe) => readString(recipe, 'id'))
      .filter(isPresent);
    return {
      dimensionId: dimension.id,
      existingCount: matching.length,
      targetCount: 2,
      ...(decayingRecipeIds.length > 0 ? { decayingRecipeIds } : {}),
    };
  });
  const moduleCoverageRecords = sourceRefs.flatMap((ref) => {
    const recipe = recipeById.get(readString(ref, 'recipeId'));
    const sourcePath = readString(ref, 'sourcePath') ?? '';
    const moduleSnapshot = resolveModuleForPath(sourcePath, input.moduleSnapshots);
    const dimensionId = recipe ? readString(recipe, 'dimensionId') : undefined;
    const recipeId = readString(ref, 'recipeId');
    if (!recipeId || !dimensionId || !moduleSnapshot) {
      return [];
    }
    return [
      {
        dimensionId,
        moduleId: moduleSnapshot.moduleId,
        moduleName: moduleSnapshot.moduleName,
        recipeId,
        sourceRefs: [sourcePath],
        status: normalizeCoverageStatus(readString(recipe, 'lifecycle')),
      },
    ];
  });
  const previousModules = collectPreviousModuleSnapshotsFromSourceRefs(
    sourceRefs,
    input.moduleSnapshots
  );
  return ProjectContextCapabilities.aggregateDynamicPlanningSignals({
    architectureIntelligence: input.architectureIntelligence,
    decaySignals: recipes
      .filter((recipe) =>
        ['decaying', 'deprecated'].includes(readString(recipe, 'lifecycle') ?? '')
      )
      .map((recipe) => ({
        id: `recipe:${readString(recipe, 'id') ?? 'unknown'}`,
        targetRecipeId: readString(recipe, 'id'),
        status: readString(recipe, 'lifecycle'),
        description: readString(recipe, 'title'),
      })),
    dimensionCoverage,
    moduleCoverage: {
      records: moduleCoverageRecords,
      moduleIds: input.moduleSnapshots.map((module) => module.moduleId),
      dimensionIds: input.dimensions.map((dimension) => dimension.id),
      targetPerModuleDimension: 2,
    },
    ...(previousModules.length > 0
      ? {
          moduleDelta: {
            previousModules,
            currentModules: input.moduleSnapshots,
          },
        }
      : {}),
    proposals: safeActiveProposalSignals(ctx),
  });
}

function collectPreviousModuleSnapshotsFromSourceRefs(
  sourceRefs: readonly Record<string, unknown>[],
  currentModules: readonly ModuleSnapshot[]
): ModuleSnapshot[] {
  const modules = sourceRefs
    .map((ref) => resolveModuleForPath(readString(ref, 'sourcePath') ?? '', currentModules))
    .filter(isPresent);
  return dedupeBy(modules, (module) => module.moduleId);
}

function createPlanLedgerService(ctx: PlanToolContext): PlanLedgerService {
  return new PlanLedgerService(resolvePlanRepositories(ctx));
}

function resolvePlanRepositories(
  ctx: PlanToolContext
): ConstructorParameters<typeof PlanLedgerService>[0] {
  return {
    knowledgeRepository: ctx.container.get('knowledgeRepository') as ConstructorParameters<
      typeof PlanLedgerService
    >[0]['knowledgeRepository'],
    lifecycleEventRepository: safeGet(ctx, 'lifecycleEventRepository') as ConstructorParameters<
      typeof PlanLedgerService
    >[0]['lifecycleEventRepository'],
    planRepository: ctx.container.get('planRepository') as ConstructorParameters<
      typeof PlanLedgerService
    >[0]['planRepository'],
    proposalRepository: safeGet(ctx, 'proposalRepository') as ConstructorParameters<
      typeof PlanLedgerService
    >[0]['proposalRepository'],
    recipeSourceRefRepository: ctx.container.get(
      'recipeSourceRefRepository'
    ) as ConstructorParameters<typeof PlanLedgerService>[0]['recipeSourceRefRepository'],
  };
}

function resolvePlanProjectRoot(ctx: PlanToolContext, args: Partial<PlanArgs>): string {
  return args.projectRoot ?? resolveProjectRoot(ctx.container);
}

async function computeCurrentSignature(
  projectRoot: string,
  hints?: PlanArgs['hints']
): Promise<string> {
  const analysis = await collectPlanProjectContext(projectRoot, hints);
  const architectureIntelligence = ProjectContextCapabilities.analyzeArchitectureIntelligence({
    projectContext: analysis.presenterInput,
    primaryLanguage: analysis.primaryLanguage,
    projectRoot,
  });
  return computePlanProjectContextSignature({
    analysis,
    architectureStyle: architectureIntelligence.styles.primary,
    projectRoot,
  });
}

function computePlanProjectContextSignature(input: {
  analysis: PlanProjectContextAnalysis;
  architectureStyle?: string;
  projectRoot: string;
}): string {
  return computeProjectContextSignature({
    frameworks: input.analysis.frameworks,
    metadata: {
      architectureStyle: input.architectureStyle ?? null,
      fileCount: input.analysis.fileCount,
      moduleCount: input.analysis.moduleCount,
      projectType: input.analysis.projectType,
      requestKinds: input.analysis.requestKinds,
    },
    modules: collectModuleSnapshots(input.analysis).map((module) => ({
      files: module.files,
      fingerprint: module.fingerprint,
      id: module.moduleId,
      name: module.moduleName,
      role: module.role,
    })),
    primaryLanguage: input.analysis.primaryLanguage,
    projectRoot: input.projectRoot,
    files: collectProjectContextSignatureFiles(input.analysis),
  });
}

function collectProjectContextSignatureFiles(analysis: PlanProjectContextAnalysis): Array<{
  contentHash: string;
  filePath: string;
  language?: string;
  lineCount?: number;
}> {
  const presenterFiles = analysis.presenterInput.files.map((file) => ({
    contentHash: file.ref?.id ?? '',
    filePath: file.filePath,
    language: file.language,
    lineCount: file.lineCount,
  }));
  const sourceFiles = analysis.sourceFileFacts.map((file) => ({
    contentHash: '',
    filePath: file.filePath,
    language: file.language,
  }));
  return dedupeBy([...presenterFiles, ...sourceFiles], (file) => file.filePath).sort(
    (left, right) => left.filePath.localeCompare(right.filePath)
  );
}

function buildConfirmedPlanIntent(args: PlanArgs, draft: PlanRecord): BuildConfirmIntentResult {
  const issues: string[] = [];
  const dimensions = normalizeConfirmedDimensions(args.selectedDimensions, issues);
  const dimensionIds = dimensions.map((dimension) => dimension.dimensionId);
  const missingDimensionIds = resolvePlanDimensionDefinitions(
    baseDimensions,
    dimensionIds
  ).missingDimensionIds;
  for (const dimensionId of missingDimensionIds) {
    issues.push(`selectedDimensions references unknown dimension ${dimensionId}`);
  }
  const scale = normalizeRequiredPlanScale(args.scale, issues);
  const moduleBindings = normalizeRequiredModuleBindings(args.moduleBindings, dimensionIds, issues);
  const plannedNextActions = normalizeRequiredNextActions(args.plannedNextActions, issues);
  const evidenceRefs = normalizeRequiredEvidenceRefs(args.evidenceRefs, issues);
  const rationale = normalizeRequiredRationale(args.rationale);
  if (rationale.length === 0) {
    issues.push('rationale is required');
  }
  if (issues.length > 0) {
    return {
      ok: false,
      response: blocked(
        'PLAN_CONFIRM_PAYLOAD_REQUIRED',
        'confirm requires a complete Agent-authored Plan payload.',
        {
          operation: 'confirm',
          plan: projectPlanRecord(draft),
          planDiagnostics: uniqueStrings(issues).map((issue) => ({
            code: 'confirm-payload-required',
            severity: 'error',
            message: issue,
          })),
        }
      ),
    };
  }
  return {
    ok: true,
    intent: {
      projectProfile: draft.intent.projectProfile,
      dimensions,
      scale,
      moduleBindings,
      stages: {
        coldStart: {
          dimensions: dimensions
            .filter((dimension) => dimension.stage === 'coldStart')
            .map((dimension) => dimension.dimensionId),
          breadthBudget: scale.perStage.coldStart,
        },
        deepMining: {
          dimensions: dimensions
            .filter((dimension) => dimension.stage === 'deepMining')
            .map((dimension) => dimension.dimensionId),
          depthBudget: scale.perStage.deepMining,
          focusModules: moduleBindings.map((binding) => binding.modulePath),
        },
        moduleMining: {
          perModule: moduleBindings,
        },
      },
      plannedNextActions,
      evidenceRefs,
      draftSource: 'host-agent',
    },
  };
}

function normalizeConfirmedDimensions(
  selected: PlanArgs['selectedDimensions'],
  issues: string[]
): PlanIntent['dimensions'] {
  if (!selected || selected.filter((dimension) => dimension.decided !== false).length === 0) {
    issues.push('selectedDimensions are required');
    return [];
  }
  return selected
    .filter((dimension) => dimension.decided !== false)
    .map((dimension, index) => {
      const dimensionId = dimension.dimensionId ?? dimension.id ?? '';
      const rationale = dimension.reason ?? dimension.rationale ?? '';
      if (!dimensionId) {
        issues.push(`selectedDimensions[${index}].dimensionId is required`);
      }
      if (!rationale) {
        issues.push(`selectedDimensions[${index}].rationale is required`);
      }
      if (!dimension.stage) {
        issues.push(`selectedDimensions[${index}].stage is required`);
      }
      if (!dimension.targetRecipes || dimension.targetRecipes <= 0) {
        issues.push(`selectedDimensions[${index}].targetRecipes must be > 0`);
      }
      return {
        dimensionId,
        priority: dimension.priority ?? index + 1,
        rationale,
        stage: dimension.stage ?? 'coldStart',
        targetRecipes: dimension.targetRecipes ?? 0,
      };
    })
    .filter((dimension) => dimension.dimensionId.length > 0);
}

function normalizeRequiredPlanScale(input: PlanArgs['scale'], issues: string[]): PlanScaleDecision {
  if (!input) {
    issues.push('scale is required');
  }
  if (!input?.totalRecipeBudget) {
    issues.push('scale.totalRecipeBudget is required');
  }
  if (!input?.perStage) {
    issues.push('scale.perStage is required');
  }
  if (!input?.depthLevels?.length) {
    issues.push('scale.depthLevels are required');
  }
  const perStage = input?.perStage ?? {};
  for (const key of ['coldStart', 'deepMining', 'module'] as const) {
    if (perStage[key] === undefined) {
      issues.push(`scale.perStage.${key} is required`);
    }
  }
  return {
    totalRecipeBudget: input?.totalRecipeBudget ?? 0,
    perStage: {
      coldStart: perStage.coldStart ?? 0,
      deepMining: perStage.deepMining ?? 0,
      module: perStage.module ?? 0,
    },
    depthLevels: input?.depthLevels ?? [],
    ...(input?.budgetLevel ? { budgetLevel: input.budgetLevel } : {}),
    ...(input?.scale ? { scale: input.scale } : {}),
  };
}

function normalizeRequiredModuleBindings(
  input: PlanArgs['moduleBindings'],
  dimensionIds: readonly string[],
  issues: string[]
): readonly PlanModuleBinding[] {
  if (!input || input.length === 0) {
    issues.push('moduleBindings are required');
    return [];
  }
  const knownDimensionIds = new Set(dimensionIds);
  return input.map((binding, index) => {
    if (!binding.dimensions?.length) {
      issues.push(`moduleBindings[${index}].dimensions are required`);
    }
    if (!binding.targetRecipes || binding.targetRecipes <= 0) {
      issues.push(`moduleBindings[${index}].targetRecipes must be > 0`);
    }
    for (const dimensionId of binding.dimensions ?? []) {
      if (!knownDimensionIds.has(dimensionId)) {
        issues.push(`moduleBindings[${index}] references unknown dimension ${dimensionId}`);
      }
    }
    return {
      modulePath: binding.modulePath,
      ...(binding.moduleId ? { moduleId: binding.moduleId } : {}),
      dimensions: binding.dimensions ?? [],
      targetRecipes: binding.targetRecipes ?? 0,
      priority: binding.priority ?? index + 1,
    };
  });
}

function normalizeRequiredNextActions(
  input: PlanArgs['plannedNextActions'],
  issues: string[]
): readonly PlanNextAction[] {
  if (!input || input.length === 0) {
    issues.push('plannedNextActions are required');
    return [];
  }
  return input.map((action, index) => ({
    tool: action.tool,
    reason: action.reason,
    order: action.order ?? index + 1,
    ...(action.dimensionIds ? { dimensionIds: action.dimensionIds } : {}),
    ...(action.modulePaths ? { modulePaths: action.modulePaths } : {}),
  }));
}

function normalizeRequiredEvidenceRefs(
  input: PlanArgs['evidenceRefs'],
  issues: string[]
): PlanIntent['evidenceRefs'] {
  if (!input || input.length === 0) {
    issues.push('evidenceRefs are required');
    return [];
  }
  return input.map((ref) => ({
    kind: ref.kind,
    ref: ref.ref,
    ...(ref.detail ? { detail: ref.detail } : {}),
  }));
}

function projectPlanRecord(plan: PlanRecord): Record<string, unknown> {
  return {
    planId: plan.planId,
    version: plan.version,
    planStatus: plan.status,
    projectRoot: plan.projectRoot,
    projectContextSignature: plan.projectContextSignature,
    lastUpdatedFromCommit: plan.lastUpdatedFromCommit,
    createdBy: plan.createdBy,
    confirmedBy: plan.confirmedBy,
    confirmedAt: plan.confirmedAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    supersedesPlanId: plan.supersedesPlanId,
    intent: plan.intent,
    rationale: plan.rationale,
    intentChangeLog: plan.intentChangeLog,
  };
}

function projectPlanView(view: PlanView): Record<string, unknown> {
  return {
    intent: projectPlanRecord(view.intent),
    planState: projectPlanState(view.state),
    signature: view.signature,
  };
}

function projectPlanState(state: PlanGenerationState): Record<string, unknown> {
  return {
    codeRecipeMapping: state.codeRecipeMapping.map((mapping) => ({
      codeRegion: mapping.codeRegion,
      recipeIds: mapping.recipeIds,
      status: mapping.status,
      dimensionIds: mapping.dimensionIds,
      modulePath: mapping.modulePath,
      evidenceRefs: mapping.evidenceRefs,
    })),
    coverage: state.coverage,
    pendingProposals: state.pendingProposals.map((proposal) => ({
      id: readString(proposal, 'id'),
      type: readString(proposal, 'type'),
      targetRecipeId: readString(proposal, 'targetRecipeId'),
      status: readString(proposal, 'status'),
      confidence: readNumber(proposal, 'confidence'),
      description: readString(proposal, 'description'),
    })),
    generationChangeLog: state.generationChangeLog.map((event) => ({
      id: readString(event, 'id'),
      recipeId: readString(event, 'recipeId'),
      fromState: readString(event, 'fromState'),
      toState: readString(event, 'toState'),
      trigger: readString(event, 'trigger'),
      createdAt: readNumber(event, 'createdAt'),
    })),
  };
}

function buildPlanProjectContextCreationGuide(
  plan: PlanRecord,
  stage: ProjectContextCreationStage
): Record<string, unknown> {
  return buildProjectContextCreationGuide({
    dimensionIds: plan.intent.dimensions.map((dimension) => dimension.dimensionId),
    generationStage: inferPlanGenerationStage(plan.intent),
    moduleScope: plan.intent.moduleBindings.map((binding) => binding.modulePath),
    planId: plan.planId,
    projectRoot: plan.projectRoot,
    stage,
  });
}

function inferPlanGenerationStage(intent: PlanIntent): PlanStageId {
  if (intent.stages.moduleMining.perModule.length > 0) {
    return 'moduleMining';
  }
  const selectedStages = intent.dimensions.map((dimension) => dimension.stage);
  if (selectedStages.includes('deepMining')) {
    return 'deepMining';
  }
  return 'coldStart';
}

function buildGetNextActions(view: PlanView): Record<string, unknown>[] {
  if (!view.signature.matches) {
    return [
      {
        tool: PLAN_TOOL_NAME,
        operation: 'draft',
        required: true,
        reason: 'ProjectContext changed; refresh the Plan draft before generation.',
        args: { operation: 'draft', projectRoot: view.intent.projectRoot },
      },
    ];
  }
  if (view.state.coverage.gaps.length > 0) {
    const gapScope = buildCoverageGapGuideScope(view);
    return buildProjectContextCreationNextActions({
      dimensionIds: gapScope.dimensionIds,
      generationStage: inferPlanGenerationStage(view.intent.intent),
      moduleScope: gapScope.moduleScope,
      planId: view.intent.planId,
      projectRoot: view.intent.projectRoot,
      stage: 'plan-get',
    });
  }
  return [
    {
      tool: PLAN_TOOL_NAME,
      operation: 'get',
      required: false,
      reason:
        'Plan coverage currently has no missing buckets; re-read when project or Recipes change.',
    },
  ];
}

function buildCoverageGapGuideScope(view: PlanView): {
  dimensionIds: string[];
  moduleScope: string[];
} {
  const gapDimensions = uniqueStrings(
    view.state.coverage.gaps.map((gap) => gap.dimensionId).filter(isPresent)
  );
  const gapModules = uniqueStrings(
    view.state.coverage.gaps.map((gap) => gap.modulePath).filter(isPresent)
  );
  return {
    dimensionIds:
      gapDimensions.length > 0
        ? gapDimensions
        : view.intent.intent.dimensions.map((dimension) => dimension.dimensionId),
    moduleScope:
      gapModules.length > 0
        ? gapModules
        : view.intent.intent.moduleBindings.map((binding) => binding.modulePath),
  };
}

function buildProjectContextFactPackage(
  analysis: PlanProjectContextAnalysis
): Record<string, unknown> {
  return {
    contextStatus: analysis.contextStatus,
    envelopes: analysis.envelopes,
    factSource: analysis.factSource,
    fileCount: analysis.fileCount,
    frameworks: analysis.frameworks,
    moduleCount: analysis.moduleCount,
    moduleSeeds: analysis.moduleSeeds.map((seed) => ({
      moduleName: seed.moduleName,
      modulePath: seed.modulePath,
      role: seed.role,
      ownedFiles: seed.ownedFiles,
    })),
    primaryLanguage: analysis.primaryLanguage,
    presenterInput: analysis.presenterInput,
    projectType: analysis.projectType,
    repoFacts: {
      sourceFileCount: analysis.sourceFileFacts.length,
      sourceFiles: analysis.sourceFileFacts,
      sourceFilesByLanguage: countSourceFilesByLanguage(analysis.sourceFileFacts),
    },
    requestKinds: analysis.requestKinds,
    secondaryLanguages: analysis.secondaryLanguages,
    understandingGaps: analysis.understandingGaps,
  };
}

function countSourceFilesByLanguage(
  files: readonly PlanProjectSourceFileFact[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function summarizeOnboardingContract(
  contract: ReturnType<typeof buildColdStartOnboardingContract>
): Record<string, unknown> {
  return {
    bootstrapState: {
      status: readString(contract.bootstrapState, 'status'),
      projectIdentity: readRecord(contract.bootstrapState.projectIdentity),
    },
    currentDomainSop: {
      domainId: readString(contract.currentDomainSop, 'domainId'),
      title: readString(contract.currentDomainSop, 'title'),
      toolSequence: Array.isArray(contract.currentDomainSop.toolSequence)
        ? contract.currentDomainSop.toolSequence
        : [],
    },
    domainQueue: contract.domainQueue.map((entry) => ({
      domainId: entry.domainId,
      status: entry.status,
      dimensionRefs: entry.dimensionRefs,
      toolSequence: entry.toolSequence,
    })),
    initialToolBriefing: contract.initialToolBriefing,
    toolCapabilities: contract.toolCapabilities,
  };
}

function selectPlanModuleSeeds(repo: RepoContext | undefined): PlanModuleSeed[] {
  const records = readRecord(repo);
  const candidates: PlanModuleSeed[] = [
    ...arrayRecords(records.localPackages).map((pkg) => ({
      moduleName: readString(pkg, 'name') ?? 'local-package',
      modulePath: normalizePath(readString(pkg, 'path') ?? readScopeFilePath(pkg.ref)),
      role: 'local-package',
    })),
    ...arrayRecords(records.sourceRoots).map((root) => ({
      moduleName: moduleNameFromPath(readString(root, 'path') ?? 'source'),
      modulePath: normalizePath(readString(root, 'path')),
      role: readString(root, 'role') ?? 'source-root',
    })),
    ...arrayRecords(records.topAreas).map((area) => ({
      moduleName: moduleNameFromPath(readString(area, 'path') ?? 'area'),
      modulePath: normalizePath(readString(area, 'path')),
      role: readString(area, 'role') ?? 'top-area',
    })),
    ...arrayRecords(records.entrypoints).flatMap((entrypoint) =>
      arrayRecords(entrypoint.refs).map((ref) => ({
        moduleName:
          readString(entrypoint, 'name') ??
          moduleNameFromPath(readScopeFilePath(ref) ?? 'entrypoint'),
        modulePath: normalizePath(parentPath(readScopeFilePath(ref))),
        ownedFiles: [readScopeFilePath(ref)].filter(isPresent),
        role: readString(entrypoint, 'kind') ?? 'entrypoint',
      }))
    ),
    ...arrayRecords(records.targets).flatMap((target) =>
      arrayRecords(target.refs).map((ref) => ({
        moduleName:
          readString(target, 'name') ?? moduleNameFromPath(readScopeFilePath(ref) ?? 'target'),
        modulePath: normalizePath(readScopeFilePath(ref)),
        ownedFiles: [readScopeFilePath(ref)].filter(isPresent),
        role: readString(target, 'kind') ?? 'target',
      }))
    ),
  ].filter(hasSeedScope);
  return mergePlanModuleSeeds(
    candidates.map((seed) => ({ ...seed, modulePath: normalizePath(seed.modulePath) }))
  );
}

function collectModuleSnapshots(analysis: PlanProjectContextAnalysis): ModuleSnapshot[] {
  const fromPresenter = [
    ...arrayRecords(analysis.presenterInput.map?.modules),
    ...arrayRecords(analysis.presenterInput.modules),
  ].map((module) => {
    const files = uniqueStrings([
      ...arrayStrings(module.files),
      ...arrayRecords(module.ownedFiles)
        .map((file) => readString(file, 'filePath'))
        .filter(isPresent),
    ]);
    const moduleName =
      readString(module, 'name') ??
      readString(module, 'moduleName') ??
      readString(module, 'id') ??
      'module';
    const moduleId =
      readString(module, 'moduleId') ??
      readString(module, 'id') ??
      normalizePath(readString(module, 'path')) ??
      moduleName;
    return {
      files,
      fingerprint: `${readString(module, 'role') ?? ''}:${files.join('|')}`,
      moduleId,
      moduleName,
      role: readString(module, 'role'),
    };
  });
  const fromSeeds = analysis.moduleSeeds.map((seed) => {
    const files = uniqueStrings(seed.ownedFiles ?? []);
    const moduleId = seed.modulePath ?? seed.moduleName;
    return {
      files,
      fingerprint: `${seed.role ?? ''}:${seed.modulePath ?? ''}:${files.join('|')}`,
      moduleId,
      moduleName: seed.moduleName,
      role: seed.role,
    };
  });
  return dedupeBy(
    [...fromPresenter, ...fromSeeds].filter((module) => module.moduleId),
    (module) => module.moduleId
  );
}

function inferPrimaryLanguage(input: ProjectContextPresenterInput): string {
  const languages = input.repo?.languages ?? [];
  return (
    [...languages].sort((left, right) => (right.fileCount ?? 0) - (left.fileCount ?? 0))[0]
      ?.language ?? 'unknown'
  );
}

function inferSecondaryLanguages(
  input: ProjectContextPresenterInput,
  primaryLanguage: string
): string[] {
  return (input.repo?.languages ?? [])
    .map((language) => language.language)
    .filter((language) => language !== primaryLanguage)
    .sort();
}

function inferProjectType(input: ProjectContextPresenterInput): string {
  return (
    input.repo?.packageSystems[0]?.kind ??
    input.repo?.buildSystems[0]?.kind ??
    input.repo?.repo.name ??
    'project-context'
  );
}

function collectFrameworkHints(input: ProjectContextPresenterInput): string[] {
  const repo = readRecord(input.repo);
  const manifestDependencies = arrayRecords(repo.manifestDependencies).map((dep) =>
    readString(dep, 'name')
  );
  const packageSystems = arrayRecords(repo.packageSystems).map(
    (entry) => readString(entry, 'kind') ?? readString(entry, 'name')
  );
  const buildSystems = arrayRecords(repo.buildSystems).map(
    (entry) => readString(entry, 'kind') ?? readString(entry, 'name')
  );
  const commands = arrayRecords(repo.commands).flatMap((entry) => [
    readString(entry, 'name'),
    readString(entry, 'command'),
  ]);
  return uniqueStrings(
    [...manifestDependencies, ...packageSystems, ...buildSystems, ...commands].filter(isPresent)
  ).slice(0, 30);
}

async function safeFindRecipes(ctx: PlanToolContext): Promise<Record<string, unknown>[]> {
  const repository = safeGet(ctx, 'knowledgeRepository') as {
    findAllByLifecycles?(lifecycles: readonly string[]): Promise<unknown[]>;
  } | null;
  const rows = await repository?.findAllByLifecycles?.(COUNTABLE_RECIPE_LIFECYCLES);
  return (rows ?? []).map(toRecord);
}

function safeSourceRefs(ctx: PlanToolContext): Record<string, unknown>[] {
  const repository = safeGet(ctx, 'recipeSourceRefRepository') as { findAll?(): unknown[] } | null;
  return (repository?.findAll?.() ?? []).map(toRecord);
}

function safeActiveProposalSignals(ctx: PlanToolContext): Array<{
  id: string;
  type?: string;
  status?: string;
  targetRecipeId?: string;
  confidence?: number;
  description?: string;
}> {
  const repository = safeGet(ctx, 'proposalRepository') as { findActive?(): unknown[] } | null;
  return (repository?.findActive?.() ?? []).map(toRecord).map((proposal, index) => ({
    id: readString(proposal, 'id') ?? `proposal:${index + 1}`,
    ...(readString(proposal, 'type') ? { type: readString(proposal, 'type') } : {}),
    ...(readString(proposal, 'status') ? { status: readString(proposal, 'status') } : {}),
    ...(readString(proposal, 'targetRecipeId')
      ? { targetRecipeId: readString(proposal, 'targetRecipeId') }
      : {}),
    ...(readNumber(proposal, 'confidence') !== undefined
      ? { confidence: readNumber(proposal, 'confidence') }
      : {}),
    ...(readString(proposal, 'description')
      ? { description: readString(proposal, 'description') }
      : {}),
  }));
}

function resolveModuleForPath(
  pathValue: string,
  modules: readonly ModuleSnapshot[]
): ModuleSnapshot | null {
  const normalized = normalizePath(pathValue);
  if (!normalized) {
    return null;
  }
  return (
    [...modules]
      .filter(
        (module) =>
          normalized.startsWith(normalizePath(module.moduleId) ?? '') ||
          module.files.some((file) => normalized.startsWith(normalizePath(file) ?? ''))
      )
      .sort((left, right) => right.moduleId.length - left.moduleId.length)[0] ?? null
  );
}

function normalizeCoverageStatus(
  value: string | undefined
): 'active' | 'evolving' | 'staging' | 'decaying' | 'deprecated' | 'unknown' {
  if (
    value === 'active' ||
    value === 'evolving' ||
    value === 'staging' ||
    value === 'decaying' ||
    value === 'deprecated'
  ) {
    return value;
  }
  return 'unknown';
}

function hasSeedScope(seed: PlanModuleSeed): boolean {
  return Boolean(seed.modulePath || seed.ownedFiles?.length);
}

function normalizeRequiredRationale(rationale: PlanArgs['rationale']): readonly string[] {
  if (Array.isArray(rationale)) {
    return rationale;
  }
  if (typeof rationale === 'string') {
    return [rationale];
  }
  return [];
}

function createPlanDraftSession(projectRoot: string): { toJSON(): Record<string, unknown> } {
  return {
    toJSON: () => ({
      id: 'plan-draft-session',
      projectRoot,
      source: PLAN_TOOL_NAME,
      status: 'planning',
    }),
  };
}

function readGitCommit(projectRoot: string): string | null {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolvePlanActor(ctx: PlanToolContext): string {
  return ctx.actor?.user ?? ctx.actor?.role ?? 'host-agent';
}

function blocked(
  errorCode: string,
  message: string,
  data: Record<string, unknown> = {}
): PlanToolResponse {
  return {
    success: false,
    errorCode,
    message,
    data,
  };
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return !!value && typeof value === 'object' && 'repo' in value && 'sourceRoots' in value;
}

function safeGet(ctx: PlanToolContext, name: string): unknown {
  try {
    return ctx.container.get(name);
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toRecord(value: unknown): Record<string, unknown> {
  if (
    value &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  ) {
    return value.toJSON() as Record<string, unknown>;
  }
  return readRecord(value);
}

function readString(record: unknown, key: string): string | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(record: unknown, key: string): number | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(readRecord) : [];
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readScopeFilePath(ref: unknown): string | undefined {
  return readString(readRecord(ref).scope, 'filePath');
}

function parentPath(pathValue: string | undefined): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  const parts = pathValue.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/') || undefined;
}

function moduleNameFromPath(pathValue: string): string {
  return (
    pathValue
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? pathValue
  );
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.') {
    return undefined;
  }
  return trimmed.replace(/\\/g, '/').replace(/\/$/, '');
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function dedupeBy<T>(values: readonly T[], keyFn: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    const key = keyFn(value);
    if (key && !byKey.has(key)) {
      byKey.set(key, value);
    }
  }
  return [...byKey.values()];
}

function isPresent<T>(value: T | null | undefined | ''): value is T {
  return value !== null && value !== undefined && value !== '';
}
