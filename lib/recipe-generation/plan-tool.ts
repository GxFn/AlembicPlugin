import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import {
  baseDimensions,
  buildProjectContextMissionBriefing,
  type DimensionDef,
  resolveActiveDimensions,
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
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildColdStartOnboardingContract } from '#codex/status/OnboardingContract.js';
import type { PlanInput } from '#shared/schemas/mcp-tools.js';

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

interface PlanProjectContextAnalysis {
  dimensions: DimensionDef[];
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  fileCount: number;
  frameworks: string[];
  moduleCount: number;
  moduleSeeds: PlanModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  primaryLanguage: string;
  projectType: string;
  requestKinds: ProjectContextRequestKind[];
  secondaryLanguages: string[];
}

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
type DimensionPlanningAids = ReturnType<
  typeof ProjectContextCapabilities.buildDimensionPlanningAids
>;
type PlanDraftPackage = ReturnType<typeof buildPlanDraftInformationPackage>;
type PlanRepositories = ConstructorParameters<typeof PlanLedgerService>[0];

interface PlanDraftContext {
  analysis: PlanProjectContextAnalysis;
  dynamicSignals: DynamicPlanningSignals;
  planningAids: DimensionPlanningAids;
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

const COUNTABLE_RECIPE_LIFECYCLES = [
  'active',
  'staging',
  'evolving',
  'decaying',
  'deprecated',
] as const;

const PLAN_TOOL_NAME = 'alembic_plan';

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
  const versionResponse = validateConfirmPlanVersion(repositories, base, draft, args);
  if (versionResponse) {
    return versionResponse;
  }
  const signatureEchoResponse = validateDraftSignatureEcho(draft, projectContextSignature);
  if (signatureEchoResponse) {
    return signatureEchoResponse;
  }
  const projectRoot = args.projectRoot ?? draft.projectRoot;
  const signatureResult = await validateConfirmCurrentSignature(
    projectRoot,
    draft,
    args.allowSignatureMismatch
  );
  if (!signatureResult.ok) {
    return signatureResult.response;
  }
  const confirmed = saveConfirmedPlan(ctx, args, base, draft);
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
  const planningAids = buildDraftPlanningAids(
    args,
    analysis,
    architectureIntelligence,
    dynamicSignals
  );
  const projectContextSignature = computePlanProjectContextSignature({
    analysis,
    architectureStyle: architectureIntelligence.styles.primary,
    projectRoot,
  });
  const draftPackage = buildDraftInformationPackage(ctx, args, {
    analysis,
    architectureIntelligence,
    dynamicSignals,
    planningAids,
    projectContextSignature,
  });
  return {
    analysis,
    dynamicSignals,
    planningAids,
    planningBrief: buildDraftPlanningBrief(projectRoot, analysis, draftPackage, {
      dynamicSignals,
      planningAids,
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

function buildDraftPlanningAids(
  args: PlanArgs,
  analysis: PlanProjectContextAnalysis,
  architectureIntelligence: ArchitectureIntelligence,
  dynamicSignals: DynamicPlanningSignals
): DimensionPlanningAids {
  return ProjectContextCapabilities.buildDimensionPlanningAids({
    architectureIntelligence,
    detectedFrameworks: analysis.frameworks,
    dynamicSignals,
    maxRecommendedDimensions: args.hints?.maxRecommendedDimensions,
    primaryLanguage: analysis.primaryLanguage,
  });
}

function buildDraftInformationPackage(
  ctx: PlanToolContext,
  args: PlanArgs,
  input: {
    analysis: PlanProjectContextAnalysis;
    architectureIntelligence: ArchitectureIntelligence;
    dynamicSignals: DynamicPlanningSignals;
    planningAids: DimensionPlanningAids;
    projectContextSignature: string;
  }
): PlanDraftPackage {
  const profile = input.analysis;
  return buildPlanDraftInformationPackage({
    dynamicSignals: summarizeDynamicSignals(input.dynamicSignals),
    hints: buildDraftHints(ctx, args),
    missionBriefing: summarizeMissionBriefing(
      buildMissionBriefingForDraft(profile, resolvePlanProjectRoot(ctx, args))
    ),
    planningAids: input.planningAids,
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
    planningAids: DimensionPlanningAids;
  }
): Record<string, unknown> {
  const missionBriefing = buildMissionBriefingForDraft(analysis, projectRoot);
  return {
    ...draftPackage.planningBrief,
    onboardingContract: summarizeOnboardingContract(
      buildOnboardingContractForDraft(analysis, projectRoot)
    ),
    projectContext: summarizeProjectContext(analysis),
    sourceReports: {
      dynamicSignals: summarizeDynamicSignals(reports.dynamicSignals),
      missionBriefing: summarizeMissionBriefing(missionBriefing),
      planningAids: summarizePlanningAids(reports.planningAids),
    },
  };
}

function savePlanDraft(
  ctx: PlanToolContext,
  args: PlanArgs,
  draftContext: PlanDraftContext
): PlanRecord {
  return createPlanLedgerService(ctx).saveDraft({
    createdBy: resolvePlanActor(ctx),
    intent: draftContext.draftPackage.intent,
    lastUpdatedFromCommit: readGitCommit(draftContext.projectRoot),
    planningBrief: draftContext.planningBrief,
    projectContextSignature: draftContext.projectContextSignature,
    projectRoot: draftContext.projectRoot,
    rationale: args.hints?.goal ? [`draft goal: ${args.hints.goal}`] : ['deterministic plan draft'],
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
      plan: projectPlanRecord(plan),
      planningBrief: draftContext.planningBrief,
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
      'Confirm selected dimensions, scale, module bindings, and planned next actions before generation.',
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
  draft: PlanRecord,
  args: PlanArgs
): PlanToolResponse | null {
  const latest = repositories.planRepository.get(base.planId);
  if (!latest || latest.version === base.version || args.allowStaleVersion) {
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

async function validateConfirmCurrentSignature(
  projectRoot: string,
  draft: PlanRecord,
  allowSignatureMismatch: boolean
): Promise<ConfirmCurrentSignatureResult> {
  const currentProjectContextSignature = await computeCurrentSignature(projectRoot);
  const signature = compareProjectContextSignature(
    draft.projectContextSignature,
    currentProjectContextSignature
  );
  if (signature.matches || allowSignatureMismatch) {
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
              'Project files/modules changed after draft; refresh the draft or confirm with controller-reviewed override.',
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
  draft: PlanRecord
): PlanRecord {
  return createPlanLedgerService(ctx).confirmPlan({
    confirmedBy: resolvePlanActor(ctx),
    intentPatch: buildConfirmIntentPatch(draft.intent, args),
    planId: base.planId,
    rationale: normalizeRationale(args.rationale, draft.rationale),
    version: base.version,
  });
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
  const currentProjectContextSignature =
    args.projectContextSignature ?? (await computeCurrentSignature(projectRoot));
  const planRecord = args.planId
    ? repositories.planRepository.get(args.planId, args.version)
    : repositories.planRepository.getActiveConfirmed(projectRoot);
  if (!planRecord) {
    return blocked('PLAN_NOT_FOUND', 'No matching confirmed Plan was found.', {
      operation: 'get',
      projectRoot,
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
  hints: PlanArgs['hints']
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
  const moduleSeeds = selectPlanModuleSeeds(repo, hints?.focusModules);
  if (moduleSeeds.length > 0) {
    await push('map', {
      moduleSeeds,
      repoName: readRecord(repo)?.repo ? readString(readRecord(repo)?.repo, 'name') : undefined,
    });
  }
  for (const seed of moduleSeeds.slice(0, 4)) {
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
  const primaryLanguage = inferPrimaryLanguage(presenterInput);
  const secondaryLanguages = inferSecondaryLanguages(presenterInput, primaryLanguage);
  const frameworks = collectFrameworkHints(presenterInput);
  return {
    dimensions: resolveActiveDimensions(baseDimensions, primaryLanguage, []),
    envelopes,
    fileCount: presenterInput.files.length,
    frameworks,
    moduleCount:
      presenterInput.modules.length || presenterInput.map?.modules.length || moduleSeeds.length,
    moduleSeeds,
    presenterInput,
    primaryLanguage,
    projectType: inferProjectType(presenterInput),
    requestKinds: [...new Set(envelopes.map((envelope) => envelope.queryLevel))],
    secondaryLanguages,
  };
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
    moduleDelta: {
      previousModules: [],
      currentModules: input.moduleSnapshots,
    },
    proposals: safeActiveProposalSignals(ctx),
  });
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

async function computeCurrentSignature(projectRoot: string): Promise<string> {
  const analysis = await collectPlanProjectContext(projectRoot, undefined);
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
    files: input.analysis.presenterInput.files.map((file) => ({
      contentHash: file.ref?.id ?? '',
      filePath: file.filePath,
      language: file.language,
      lineCount: file.lineCount,
    })),
  });
}

function buildConfirmIntentPatch(existing: PlanIntent, args: PlanArgs): Partial<PlanIntent> {
  const selectedDimensions = normalizeSelectedDimensions(args.selectedDimensions, existing);
  const dimensionIds = selectedDimensions.map((dimension) => dimension.dimensionId);
  const scale = normalizePlanScale(existing.scale, args.scale, selectedDimensions.length);
  const moduleBindings = normalizeModuleBindings(
    existing.moduleBindings,
    args.moduleBindings,
    dimensionIds
  );
  return {
    dimensions: selectedDimensions,
    scale,
    moduleBindings,
    plannedNextActions: normalizeNextActions(existing.plannedNextActions, args.plannedNextActions),
    stages: {
      coldStart: {
        dimensions: selectedDimensions
          .filter((dimension) => dimension.stage === 'coldStart')
          .map((dimension) => dimension.dimensionId),
        breadthBudget: scale.perStage.coldStart,
      },
      deepMining: {
        dimensions: selectedDimensions
          .filter((dimension) => dimension.stage !== 'coldStart')
          .map((dimension) => dimension.dimensionId),
        depthBudget: scale.perStage.deepMining,
        focusModules: moduleBindings.map((binding) => binding.modulePath),
      },
      moduleMining: {
        perModule: moduleBindings,
      },
    },
  };
}

function normalizeSelectedDimensions(
  selected: PlanArgs['selectedDimensions'],
  existing: PlanIntent
): PlanIntent['dimensions'] {
  if (!selected || selected.length === 0) {
    return existing.dimensions;
  }
  const existingById = new Map(
    existing.dimensions.map((dimension) => [dimension.dimensionId, dimension])
  );
  return selected
    .filter((dimension) => dimension.decided !== false)
    .map((dimension, index) => {
      const dimensionId = dimension.dimensionId ?? dimension.id ?? '';
      const previous = existingById.get(dimensionId);
      return {
        dimensionId,
        priority: dimension.priority ?? previous?.priority ?? index + 1,
        rationale:
          dimension.reason ??
          dimension.rationale ??
          previous?.rationale ??
          'confirmed by host Agent',
        stage: dimension.stage ?? previous?.stage ?? resolvePlanStage(index, selected.length),
        targetRecipes: dimension.targetRecipes ?? previous?.targetRecipes ?? 1,
      };
    })
    .filter((dimension) => dimension.dimensionId.length > 0);
}

function normalizePlanScale(
  existing: PlanScaleDecision,
  input: PlanArgs['scale'],
  selectedDimensionCount: number
): PlanScaleDecision {
  const totalRecipeBudget =
    input?.totalRecipeBudget ??
    existing.totalRecipeBudget ??
    Math.max(1, selectedDimensionCount * 2);
  return {
    totalRecipeBudget,
    perStage: {
      coldStart:
        input?.perStage?.coldStart ??
        existing.perStage.coldStart ??
        Math.ceil(totalRecipeBudget * 0.55),
      deepMining:
        input?.perStage?.deepMining ??
        existing.perStage.deepMining ??
        Math.ceil(totalRecipeBudget * 0.3),
      module:
        input?.perStage?.module ??
        existing.perStage.module ??
        Math.max(1, Math.floor(totalRecipeBudget * 0.15)),
    },
    depthLevels: input?.depthLevels ?? existing.depthLevels,
    ...((input?.budgetLevel ?? existing.budgetLevel)
      ? { budgetLevel: input?.budgetLevel ?? existing.budgetLevel }
      : {}),
    ...((input?.scale ?? existing.scale) ? { scale: input?.scale ?? existing.scale } : {}),
  };
}

function normalizeModuleBindings(
  existing: readonly PlanModuleBinding[],
  input: PlanArgs['moduleBindings'],
  dimensionIds: readonly string[]
): readonly PlanModuleBinding[] {
  if (!input || input.length === 0) {
    return existing.map((binding) => ({
      ...binding,
      dimensions: binding.dimensions.filter((dimensionId) => dimensionIds.includes(dimensionId)),
    }));
  }
  return input.map((binding, index) => ({
    modulePath: binding.modulePath,
    ...(binding.moduleId ? { moduleId: binding.moduleId } : {}),
    dimensions: binding.dimensions?.length ? binding.dimensions : dimensionIds,
    targetRecipes: binding.targetRecipes ?? 1,
    priority: binding.priority ?? index + 1,
  }));
}

function normalizeNextActions(
  existing: readonly PlanNextAction[],
  input: PlanArgs['plannedNextActions']
): readonly PlanNextAction[] {
  if (!input || input.length === 0) {
    return existing;
  }
  return input.map((action, index) => ({
    tool: action.tool,
    reason: action.reason,
    order: action.order ?? index + 1,
    ...(action.dimensionIds ? { dimensionIds: action.dimensionIds } : {}),
    ...(action.modulePaths ? { modulePaths: action.modulePaths } : {}),
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
    planningBrief: plan.planningBrief,
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
    return [
      {
        tool: 'alembic_recipe_map',
        required: false,
        reason: 'Inspect planned modules and mounted Recipes before filling coverage gaps.',
      },
      {
        tool: 'alembic_search',
        required: false,
        reason: 'Read Recipe details for generated/stale coverage before creating new Recipes.',
      },
    ];
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

function summarizeProjectContext(analysis: PlanProjectContextAnalysis): Record<string, unknown> {
  return {
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
    projectType: analysis.projectType,
    requestKinds: analysis.requestKinds,
    secondaryLanguages: analysis.secondaryLanguages,
  };
}

function summarizePlanningAids(
  planningAids: ReturnType<typeof ProjectContextCapabilities.buildDimensionPlanningAids>
): Record<string, unknown> {
  return {
    dimensionOrder: planningAids.dimensionOrder,
    recommendedDimensions: planningAids.recommendedDimensions.map((item) => ({
      dimensionId: item.dimension.id,
      priorityScore: item.priorityScore,
      reasons: item.reasons,
      informationSteps: item.informationSteps,
    })),
    informationGatheringSteps: planningAids.informationGatheringSteps,
    scaleDecision: planningAids.scaleDecision,
    subsetHints: planningAids.subsetHints,
    crossDimensionConstraints: planningAids.crossDimensionConstraints,
    lowConfidenceSignals: planningAids.lowConfidenceSignals,
    unavailableSignals: planningAids.unavailableSignals,
  };
}

function summarizeDynamicSignals(
  dynamicSignals: ReturnType<typeof ProjectContextCapabilities.aggregateDynamicPlanningSignals>
): Record<string, unknown> {
  return {
    proposals: dynamicSignals.proposals,
    decay: dynamicSignals.decay,
    coverage: {
      targetPerModuleDimension: dynamicSignals.coverage.targetPerModuleDimension,
      gaps: dynamicSignals.coverage.gaps,
    },
    moduleDelta: {
      added: dynamicSignals.moduleDelta.added,
      changed: dynamicSignals.moduleDelta.changed,
      removed: dynamicSignals.moduleDelta.removed,
      affectedModuleIds: dynamicSignals.moduleDelta.affectedModuleIds,
    },
    hotspotModuleIds: dynamicSignals.hotspotModuleIds,
    planSignals: dynamicSignals.planSignals,
  };
}

function summarizeMissionBriefing(briefing: Record<string, unknown>): Record<string, unknown> {
  const dimensions = Array.isArray(briefing.dimensions) ? briefing.dimensions : [];
  const projectContext = readRecord(briefing.projectContext);
  return {
    dimensionCount: dimensions.length,
    hasProjectContext: Boolean(projectContext),
    projectContextSource: readString(projectContext, 'source'),
    responseSizeKB: readNumber(readRecord(briefing.meta), 'responseSizeKB'),
    projectInformationSource: readString(readRecord(briefing.meta), 'projectInformationSource'),
  };
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

function selectPlanModuleSeeds(
  repo: RepoContext | undefined,
  focusModules?: readonly string[]
): PlanModuleSeed[] {
  const focus = new Set((focusModules ?? []).map(normalizePath).filter(isPresent));
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
        modulePath: normalizePath(parentPath(readScopeFilePath(ref))),
        ownedFiles: [readScopeFilePath(ref)].filter(isPresent),
        role: readString(target, 'kind') ?? 'target',
      }))
    ),
  ].filter(hasSeedScope);
  const filtered = focus.size
    ? candidates.filter((seed) => seed.modulePath && focus.has(seed.modulePath))
    : candidates;
  return dedupeBy(
    filtered.map((seed) => ({ ...seed, modulePath: normalizePath(seed.modulePath) })),
    (seed) => `${seed.modulePath ?? seed.ownedFiles?.join(',')}:${seed.moduleName}`
  ).slice(0, 8);
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

function resolvePlanStage(index: number, total: number): PlanStageId {
  return index < Math.ceil(total * 0.55) ? 'coldStart' : 'deepMining';
}

function normalizeRationale(
  rationale: PlanArgs['rationale'],
  fallback: readonly string[]
): readonly string[] {
  if (Array.isArray(rationale)) {
    return rationale;
  }
  if (typeof rationale === 'string') {
    return [rationale];
  }
  return fallback;
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
