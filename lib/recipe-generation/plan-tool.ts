import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path, { basename } from 'node:path';
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
  type FileFlowContext,
  type ModuleContext,
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

interface PlanProjectContextAnalysis {
  dimensions: DimensionDef[];
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  factSource: 'project-context' | 'project-context-repo-fallback';
  fallbackDiagnostics: Record<string, unknown>[];
  fileCount: number;
  frameworks: string[];
  moduleCount: number;
  moduleSeeds: PlanModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  primaryLanguage: string;
  projectType: string;
  requestKinds: ProjectContextRequestKind[];
  secondaryLanguages: string[];
  signatureScope: PlanProjectContextSignatureScope;
}

interface ModuleSnapshot {
  files: string[];
  fingerprint: string;
  moduleId: string;
  moduleName: string;
  role?: string;
}

type PlanArgs = PlanInput;
type PlanFileSummary = FileFlowContext['file'];
type PlanRelationSummary = FileFlowContext['imports'][number];
type PlanProjectContextSignatureScope = {
  focusModules?: string[];
};
type PlanProjectContextFallback = {
  diagnostics: Record<string, unknown>[];
  fileFlows: FileFlowContext[];
  fileSummaries: PlanFileSummary[];
  frameworks: string[];
  moduleSeeds: PlanModuleSeed[];
  modules: ModuleContext[];
};
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
const PLAN_FALLBACK_MAX_FILES = 96;
const PLAN_FALLBACK_MAX_FILES_PER_MODULE = 32;
const PLAN_FALLBACK_MAX_IMPORTS_PER_FILE = 16;
const PLAN_FALLBACK_MAX_SCAN_DEPTH = 8;
const PLAN_FALLBACK_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.m',
  '.mm',
  '.mjs',
  '.py',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
]);
const PLAN_FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  '.asd',
  '.build',
  '.git',
  '.swiftpm',
  'Alembic',
  'Build',
  'DerivedData',
  'Pods',
  'build',
  'dist',
  'node_modules',
  'third_party',
  'vendor',
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
    projectContextCreationGuide: buildProjectContextCreationGuide({
      dimensionIds: analysis.dimensions.map((dimension) => dimension.id),
      projectRoot,
      stage: 'plan-draft',
    }),
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
      projectContextCreationGuide: buildPlanProjectContextCreationGuide(plan, 'plan-draft'),
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

function buildPlanProjectContextHintsFromRecord(plan: PlanRecord): PlanArgs['hints'] | undefined {
  const planningBrief = readRecord(plan.planningBrief);
  const projectContext = readRecord(planningBrief.projectContext);
  const signatureScope = readPlanProjectContextSignatureScope(projectContext.signatureScope);
  if (!signatureScope.focusModules?.length) {
    return undefined;
  }
  return { focusModules: signatureScope.focusModules };
}

function readPlanProjectContextSignatureScope(value: unknown): PlanProjectContextSignatureScope {
  const focusModules = dedupeOrderedStrings(
    arrayStrings(readRecord(value).focusModules).map(normalizePath).filter(isPresent)
  ).slice(0, 40);
  return focusModules.length > 0 ? { focusModules } : {};
}

async function validateConfirmCurrentSignature(
  projectRoot: string,
  draft: PlanRecord,
  allowSignatureMismatch: boolean
): Promise<ConfirmCurrentSignatureResult> {
  const currentProjectContextSignature = await computeCurrentSignature(
    projectRoot,
    buildPlanProjectContextHintsFromRecord(draft)
  );
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
  const signatureScope = buildPlanProjectContextSignatureScope(projectRoot, hints);
  const scopedHints = buildPlanProjectContextScopedHints(hints, signatureScope);
  const moduleSeeds = selectPlanModuleSeeds(repo, signatureScope.focusModules);
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
  const fallback = await buildPlanProjectContextFallback({
    hints: scopedHints,
    moduleSeeds,
    presenterInput,
    projectRoot,
    repo,
  });
  const effectivePresenterInput = fallback
    ? mergePlanPresenterInput(presenterInput, fallback)
    : presenterInput;
  const effectiveModuleSeeds = fallback
    ? mergePlanModuleSeeds([...moduleSeeds, ...fallback.moduleSeeds])
    : moduleSeeds;
  const frameworks = uniqueStrings([
    ...collectFrameworkHints(effectivePresenterInput),
    ...(fallback?.frameworks ?? []),
  ]);
  const primaryLanguage = inferPrimaryLanguage(effectivePresenterInput);
  const secondaryLanguages = inferSecondaryLanguages(effectivePresenterInput, primaryLanguage);
  const repoFileCount = countRepoLanguageFiles(repo);
  return {
    dimensions: resolveActiveDimensions(baseDimensions, primaryLanguage, frameworks),
    envelopes,
    factSource: fallback ? 'project-context-repo-fallback' : 'project-context',
    fallbackDiagnostics: fallback?.diagnostics ?? [],
    fileCount: Math.max(effectivePresenterInput.files.length, repoFileCount),
    frameworks,
    moduleCount:
      effectivePresenterInput.modules.length ||
      effectivePresenterInput.map?.modules.length ||
      effectiveModuleSeeds.length,
    moduleSeeds: effectiveModuleSeeds,
    presenterInput: effectivePresenterInput,
    primaryLanguage,
    projectType: inferProjectType(effectivePresenterInput),
    requestKinds: [...new Set(envelopes.map((envelope) => envelope.queryLevel))],
    secondaryLanguages,
    signatureScope,
  };
}

async function buildPlanProjectContextFallback(input: {
  hints: PlanArgs['hints'];
  moduleSeeds: readonly PlanModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  projectRoot: string;
  repo: RepoContext | undefined;
}): Promise<PlanProjectContextFallback | null> {
  if (!shouldBuildPlanProjectContextFallback(input)) {
    return null;
  }

  const roots = selectFallbackRoots(input.projectRoot, input.repo, input.hints, input.moduleSeeds);
  const files = collectFallbackFiles(input.projectRoot, roots).slice(0, PLAN_FALLBACK_MAX_FILES);
  if (files.length === 0) {
    return null;
  }

  const fileDetails = files.map((filePath) => readFallbackFile(input.projectRoot, filePath));
  const fileSummaries = fileDetails.map((detail) => detail.summary);
  const fileFlows = fileDetails.map((detail) =>
    buildFallbackFileFlow(input.projectRoot, detail.summary, detail.content)
  );
  const moduleSeeds = buildFallbackModuleSeeds(input.projectRoot, roots, fileSummaries);
  const modules = buildFallbackModules(input.projectRoot, moduleSeeds, fileSummaries);
  const frameworks = uniqueStrings([
    ...collectFallbackFrameworkHints(fileDetails),
    ...collectFallbackFrameworkHintsFromRepo(input.repo),
  ]);

  return {
    diagnostics: [
      {
        code: 'project-context-repo-fallback',
        severity: 'info',
        message:
          'Core ProjectContext repo facts showed source files while presenter module/file facts were empty or sparse; Plan used bounded local source facts for draft grounding.',
        fileCount: fileSummaries.length,
        moduleCount: moduleSeeds.length,
        roots,
      },
    ],
    fileFlows,
    fileSummaries,
    frameworks,
    moduleSeeds,
    modules,
  };
}

function buildPlanProjectContextSignatureScope(
  projectRoot: string,
  hints: PlanArgs['hints']
): PlanProjectContextSignatureScope {
  const focusModules = dedupeOrderedStrings(
    (hints?.focusModules ?? [])
      .map(normalizePath)
      .filter(isPresent)
      .filter((candidate) => pathExistsInsideProject(projectRoot, candidate))
  ).slice(0, 40);
  return focusModules.length > 0 ? { focusModules } : {};
}

function buildPlanProjectContextScopedHints(
  hints: PlanArgs['hints'],
  signatureScope: PlanProjectContextSignatureScope
): PlanArgs['hints'] {
  if (!signatureScope.focusModules?.length) {
    return hints;
  }
  return {
    ...(hints ?? {}),
    focusModules: signatureScope.focusModules,
  };
}

function shouldBuildPlanProjectContextFallback(input: {
  hints: PlanArgs['hints'];
  moduleSeeds: readonly PlanModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  repo: RepoContext | undefined;
}): boolean {
  const repoFileCount = countRepoLanguageFiles(input.repo);
  if (repoFileCount <= 0) {
    return false;
  }
  const presenterModuleCount =
    input.presenterInput.modules.length || input.presenterInput.map?.modules.length || 0;
  return (
    input.presenterInput.files.length === 0 ||
    presenterModuleCount === 0 ||
    ((input.hints?.focusModules?.length ?? 0) > 0 && input.moduleSeeds.length === 0)
  );
}

function mergePlanPresenterInput(
  presenterInput: ProjectContextPresenterInput,
  fallback: PlanProjectContextFallback
): ProjectContextPresenterInput {
  return {
    ...presenterInput,
    fileFlows: dedupeBy(
      [...presenterInput.fileFlows, ...fallback.fileFlows],
      (flow) => flow.file.filePath
    ),
    files: dedupeFileSummaries([...presenterInput.files, ...fallback.fileSummaries]),
    modules: dedupeBy(
      [...presenterInput.modules, ...fallback.modules],
      (module) => module.module.id
    ),
    refs: dedupeBy([...presenterInput.refs, ...collectFallbackRefs(fallback)], (ref) => ref.id),
  };
}

function collectFallbackRefs(fallback: PlanProjectContextFallback): ProjectContextRef[] {
  return [
    ...fallback.fileSummaries.map((file) => file.ref).filter(isPresent),
    ...fallback.fileFlows.flatMap((flow) => [
      ...flow.imports.map((relation) => relation.ref).filter(isPresent),
      ...flow.nextRefs,
    ]),
    ...fallback.modules.flatMap((module) => [
      ...(module.module.ref ? [module.module.ref] : []),
      ...module.nextRefs,
      ...module.ownedFiles.map((file) => file.ref).filter(isPresent),
    ]),
  ];
}

function selectFallbackRoots(
  projectRoot: string,
  repo: RepoContext | undefined,
  hints: PlanArgs['hints'],
  moduleSeeds: readonly PlanModuleSeed[]
): string[] {
  const requestedFocus = (hints?.focusModules ?? [])
    .map(normalizePath)
    .filter(isPresent)
    .filter((candidate) => pathExistsInsideProject(projectRoot, candidate));
  const seedRoots = moduleSeeds
    .map((seed) => seed.modulePath)
    .map(normalizePath)
    .filter(isPresent)
    .filter((candidate) => pathExistsInsideProject(projectRoot, candidate));
  const repoRoots = [
    ...arrayRecords(readRecord(repo).sourceRoots)
      .filter((root) => readBoolean(root, 'exists') !== false)
      .map((root) => readString(root, 'path')),
    ...arrayRecords(readRecord(repo).topAreas)
      .filter((area) => readBoolean(area, 'exists') !== false)
      .filter((area) => {
        const role = readString(area, 'role') ?? '';
        return role === 'source-root' || role === 'top-directory' || role === 'source-area';
      })
      .map((area) => readString(area, 'path')),
  ]
    .map(normalizePath)
    .filter(isPresent)
    .filter((candidate) => pathExistsInsideProject(projectRoot, candidate));

  return dedupeOrderedStrings([...requestedFocus, ...seedRoots, ...repoRoots, '.']).filter(
    (candidate) => !isExcludedFallbackPath(candidate)
  );
}

function collectFallbackFiles(projectRoot: string, roots: readonly string[]): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    for (const filePath of collectFallbackFilesFromRoot(projectRoot, root)) {
      files.add(filePath);
      if (files.size >= PLAN_FALLBACK_MAX_FILES) {
        break;
      }
    }
    if (files.size >= PLAN_FALLBACK_MAX_FILES) {
      break;
    }
  }
  return [...files].sort(compareFallbackFilePaths);
}

function collectFallbackFilesFromRoot(projectRoot: string, root: string): string[] {
  const absoluteRoot = path.resolve(projectRoot, root);
  if (!isInsideProject(projectRoot, absoluteRoot) || !fs.existsSync(absoluteRoot)) {
    return [];
  }
  const stat = fs.lstatSync(absoluteRoot);
  if (stat.isFile()) {
    const filePath = relativeProjectPath(projectRoot, absoluteRoot);
    return filePath && isFallbackSourceFile(filePath) ? [filePath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > PLAN_FALLBACK_MAX_SCAN_DEPTH || files.length >= PLAN_FALLBACK_MAX_FILES) {
      return;
    }
    const relativeDirectory = relativeProjectPath(projectRoot, directory);
    if (relativeDirectory && isExcludedFallbackPath(relativeDirectory)) {
      return;
    }
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= PLAN_FALLBACK_MAX_FILES) {
        return;
      }
      const absoluteEntry = path.join(directory, entry.name);
      const relativeEntry = relativeProjectPath(projectRoot, absoluteEntry);
      if (!relativeEntry || isExcludedFallbackPath(relativeEntry)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(absoluteEntry, depth + 1);
      } else if (entry.isFile() && isFallbackSourceFile(relativeEntry)) {
        files.push(relativeEntry);
      }
    }
  };
  visit(absoluteRoot, 0);
  return files.sort(compareFallbackFilePaths);
}

function readFallbackFile(
  projectRoot: string,
  filePath: string
): { content: string; summary: PlanFileSummary } {
  const absolutePath = path.resolve(projectRoot, filePath);
  const stat = fs.statSync(absolutePath);
  const content = fs.readFileSync(absolutePath, 'utf8');
  const lineCount = content.length > 0 ? content.split(/\r?\n/).length : 0;
  const ref = fallbackRef(projectRoot, 'file', filePath, {
    label: filePath,
    level: 'source-file',
  });
  return {
    content,
    summary: {
      filePath,
      language: languageFromFilePath(filePath),
      lineCount,
      mtimeMs: stat.mtimeMs,
      ref,
    },
  };
}

function buildFallbackFileFlow(
  projectRoot: string,
  file: PlanFileSummary,
  content: string
): FileFlowContext {
  const imports = dedupeBy(
    [
      ...extractImportRelations(projectRoot, file, content),
      ...extractSignalRelations(projectRoot, file, content),
    ],
    (relation) =>
      `${relation.kind}:${relation.label}:${relation.filePath}:${relation.range?.startLine ?? 0}`
  );
  return {
    file,
    imports,
    exports: [],
    callers: [],
    callees: [],
    inflow: [],
    outflow: imports,
    nextRefs: imports.map((relation) => relation.ref).filter(isPresent),
  };
}

function extractImportRelations(
  projectRoot: string,
  file: PlanFileSummary,
  content: string
): PlanRelationSummary[] {
  const relations: PlanRelationSummary[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (relations.length >= PLAN_FALLBACK_MAX_IMPORTS_PER_FILE) {
      break;
    }
    const line = lines[index] ?? '';
    const importName =
      matchFirst(line, /^\s*import\s+([A-Za-z_][\w.]*)/) ??
      matchFirst(line, /^\s*import\s+[^'"]*['"]([^'"]+)['"]/) ??
      matchFirst(line, /^\s*#import\s+[<"]([^>"]+)/);
    if (!importName) {
      continue;
    }
    const lineNumber = index + 1;
    const ref = fallbackRef(projectRoot, 'relation-site', file.filePath, {
      label: `import ${importName}`,
      level: 'file-flow',
      range: { startLine: lineNumber, endLine: lineNumber },
    });
    relations.push({
      direction: 'outflow',
      filePath: file.filePath,
      from: { label: file.filePath, filePath: file.filePath, ref: file.ref },
      kind: 'imports',
      label: importName,
      range: { startLine: lineNumber, endLine: lineNumber },
      ref,
      sourceRef: file.ref,
      to: { label: importName },
    });
  }
  return relations;
}

function extractSignalRelations(
  projectRoot: string,
  file: PlanFileSummary,
  content: string
): PlanRelationSummary[] {
  const signals: string[] = [];
  const text = `${file.filePath}\n${content}`;
  if (/\bURLSession\b|\bWebSocket\b|\bHTTP\b|network|api|client/i.test(text)) {
    signals.push('URLSession networking api');
  }
  if (/\basync\b|\bawait\b|\bTask\b|\bactor\b|\bDispatchQueue\b/i.test(text)) {
    signals.push('async await Task actor concurrency');
  }
  if (/\bSwiftUI\b/.test(text)) {
    signals.push('SwiftUI ui');
  }
  if (/\bUIKit\b/.test(text)) {
    signals.push('UIKit ui');
  }
  return uniqueStrings(signals).map((label, index) => {
    const ref = fallbackRef(projectRoot, 'relation-site', file.filePath, {
      label,
      level: 'file-flow',
      range: { startLine: index + 1, endLine: index + 1 },
    });
    return {
      direction: 'outflow',
      filePath: file.filePath,
      from: { label: file.filePath, filePath: file.filePath, ref: file.ref },
      kind: 'uses',
      label,
      range: { startLine: index + 1, endLine: index + 1 },
      ref,
      sourceRef: file.ref,
      to: { label },
    };
  });
}

function buildFallbackModuleSeeds(
  projectRoot: string,
  roots: readonly string[],
  files: readonly PlanFileSummary[]
): PlanModuleSeed[] {
  const seeds = roots
    .filter((root) => root !== '.')
    .map((root) => {
      const ownedFiles = files
        .map((file) => file.filePath)
        .filter((filePath) => isPathWithinModule(filePath, root))
        .slice(0, PLAN_FALLBACK_MAX_FILES_PER_MODULE);
      if (ownedFiles.length === 0) {
        return null;
      }
      return {
        moduleName: moduleNameFromPath(root),
        modulePath: normalizePath(root),
        ownedFiles,
        ref: fallbackRef(projectRoot, 'module', root, {
          label: moduleNameFromPath(root),
          level: 'module',
        }),
        role: inferModuleRoleFromPath(root),
      } satisfies PlanModuleSeed;
    })
    .filter(isPresent);
  return mergePlanModuleSeeds(seeds).slice(0, 8);
}

function buildFallbackModules(
  projectRoot: string,
  seeds: readonly PlanModuleSeed[],
  files: readonly PlanFileSummary[]
): ModuleContext[] {
  return seeds.map((seed) => {
    const ownedFiles = files.filter((file) =>
      seed.modulePath ? isPathWithinModule(file.filePath, seed.modulePath) : false
    );
    const moduleRef =
      seed.ref ??
      fallbackRef(projectRoot, 'module', seed.modulePath ?? seed.moduleName, {
        label: seed.moduleName,
        level: 'module',
      });
    return {
      module: {
        id: seed.modulePath ?? seed.moduleName,
        name: seed.moduleName,
        ownedFileCount: ownedFiles.length,
        ref: moduleRef,
        role: seed.role,
        roleConfidence: 0.58,
      },
      ownedFiles,
      publicSurfaces: [],
      inflow: [],
      outflow: [],
      nextRefs: [moduleRef, ...ownedFiles.map((file) => file.ref).filter(isPresent)],
    };
  });
}

function mergePlanModuleSeeds(seeds: readonly PlanModuleSeed[]): PlanModuleSeed[] {
  return dedupeBy(
    seeds.map((seed) => ({ ...seed, modulePath: normalizePath(seed.modulePath) })),
    (seed) => `${seed.modulePath ?? seed.ownedFiles?.join(',')}:${seed.moduleName}`
  );
}

function dedupeFileSummaries(files: readonly PlanFileSummary[]): PlanFileSummary[] {
  return dedupeBy(files, (file) => file.filePath).sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
  );
}

function collectFallbackFrameworkHints(
  details: readonly { content: string; summary: PlanFileSummary }[]
): string[] {
  const hints: string[] = [];
  for (const detail of details) {
    const text = `${detail.summary.filePath}\n${detail.content}`;
    if (/\bSwiftUI\b/.test(text)) {
      hints.push('swiftui', 'ui');
    }
    if (/\bUIKit\b/.test(text)) {
      hints.push('uikit', 'ui');
    }
    if (/\bFoundation\b/.test(text)) {
      hints.push('foundation');
    }
    if (/\bCombine\b/.test(text)) {
      hints.push('combine', 'concurrency');
    }
    if (/\bURLSession\b|\bWebSocket\b|\bHTTP\b|network|api|client/i.test(text)) {
      hints.push('networking', 'api');
    }
    if (/\basync\b|\bawait\b|\bTask\b|\bactor\b|\bDispatchQueue\b/i.test(text)) {
      hints.push('async', 'concurrency');
    }
  }
  return uniqueStrings(hints);
}

function collectFallbackFrameworkHintsFromRepo(repo: RepoContext | undefined): string[] {
  return uniqueStrings(
    [
      ...arrayRecords(readRecord(repo).packageSystems).map((entry) => readString(entry, 'kind')),
      ...arrayRecords(readRecord(repo).buildSystems).map((entry) => readString(entry, 'kind')),
      ...arrayRecords(readRecord(repo).configFiles).map((entry) => readString(entry, 'kind')),
    ].filter(isPresent)
  );
}

function countRepoLanguageFiles(repo: RepoContext | undefined): number {
  return arrayRecords(readRecord(repo).languages).reduce(
    (sum, language) => sum + (readNumber(language, 'fileCount') ?? 0),
    0
  );
}

function fallbackRef(
  projectRoot: string,
  kind: ProjectContextRef['kind'],
  filePath: string,
  options: {
    label?: string;
    level?: string;
    range?: ProjectContextRef['scope']['range'];
  } = {}
): ProjectContextRef {
  return {
    id: `plan-fallback:${kind}:${filePath}:${options.range?.startLine ?? 0}:${fallbackRefIdSegment(
      options.label ?? filePath
    )}`,
    kind,
    label: options.label ?? filePath,
    level: options.level,
    scope: {
      filePath,
      projectRoot,
      ...(options.range ? { range: options.range } : {}),
    },
    metadata: {
      source: 'alembic-plan-project-context-fallback',
    },
  };
}

function fallbackRefIdSegment(value: string): string {
  return value.replace(/[^\w./:-]+/g, '-').replace(/^-|-$/g, '');
}

function languageFromFilePath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.swift':
      return 'swift';
    case '.m':
    case '.mm':
    case '.h':
    case '.hpp':
      return 'objectivec';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    case '.java':
      return 'java';
    case '.kt':
      return 'kotlin';
    case '.cs':
      return 'csharp';
    default:
      return 'unknown';
  }
}

function inferModuleRoleFromPath(pathValue: string): string | undefined {
  const normalized = pathValue.toLowerCase();
  if (/network|api|client|websocket/.test(normalized)) {
    return 'networking';
  }
  if (/ui|view|screen|feature|module/.test(normalized)) {
    return 'ui';
  }
  if (/core|foundation|infrastructure/.test(normalized)) {
    return 'core';
  }
  if (/test|spec/.test(normalized)) {
    return 'test';
  }
  return undefined;
}

function compareFallbackFilePaths(left: string, right: string): number {
  return fallbackFilePriority(left) - fallbackFilePriority(right) || left.localeCompare(right);
}

function fallbackFilePriority(filePath: string): number {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.swift') {
    return 0;
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extension)) {
    return 1;
  }
  if (['.m', '.mm', '.h', '.hpp'].includes(extension)) {
    return 2;
  }
  return 3;
}

function isFallbackSourceFile(filePath: string): boolean {
  return PLAN_FALLBACK_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function pathExistsInsideProject(projectRoot: string, pathValue: string): boolean {
  const absolutePath = path.resolve(projectRoot, pathValue);
  return isInsideProject(projectRoot, absolutePath) && fs.existsSync(absolutePath);
}

function isInsideProject(projectRoot: string, absolutePath: string): boolean {
  const relative = path.relative(projectRoot, absolutePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeProjectPath(projectRoot: string, absolutePath: string): string | undefined {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return normalizePath(relative);
}

function isExcludedFallbackPath(pathValue: string): boolean {
  return pathValue
    .split('/')
    .filter(Boolean)
    .some((part) => PLAN_FALLBACK_EXCLUDED_DIRECTORIES.has(part));
}

function isPathWithinModule(filePath: string, modulePath: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedModule = normalizePath(modulePath);
  return Boolean(
    normalizedFile &&
      normalizedModule &&
      (normalizedFile === normalizedModule || normalizedFile.startsWith(`${normalizedModule}/`))
  );
}

function pathMatchesFocus(pathValue: string, focus: ReadonlySet<string>): boolean {
  const normalized = normalizePath(pathValue);
  if (!normalized) {
    return false;
  }
  return [...focus].some(
    (focusPath) =>
      normalized === focusPath ||
      normalized.startsWith(`${focusPath}/`) ||
      focusPath.startsWith(`${normalized}/`)
  );
}

function matchFirst(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
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
      ...(input.analysis.signatureScope.focusModules?.length
        ? { signatureScope: input.analysis.signatureScope }
        : {}),
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
    return buildProjectContextCreationNextActions({
      dimensionIds: view.intent.intent.dimensions.map((dimension) => dimension.dimensionId),
      generationStage: inferPlanGenerationStage(view.intent.intent),
      moduleScope: view.intent.intent.moduleBindings.map((binding) => binding.modulePath),
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

function summarizeProjectContext(analysis: PlanProjectContextAnalysis): Record<string, unknown> {
  return {
    factSource: analysis.factSource,
    fallbackDiagnostics: analysis.fallbackDiagnostics,
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
    ...(analysis.signatureScope.focusModules?.length
      ? { signatureScope: analysis.signatureScope }
      : {}),
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
    ? [
        ...focusModuleSeedsFromPaths(repo, focus),
        ...candidates.filter((seed) => seed.modulePath && pathMatchesFocus(seed.modulePath, focus)),
      ]
    : candidates;
  return mergePlanModuleSeeds(
    filtered.map((seed) => ({ ...seed, modulePath: normalizePath(seed.modulePath) }))
  ).slice(0, 8);
}

function focusModuleSeedsFromPaths(
  repo: RepoContext | undefined,
  focus: ReadonlySet<string>
): PlanModuleSeed[] {
  const records = readRecord(repo);
  const repoPaths = new Set(
    [
      ...arrayRecords(records.sourceRoots).map((root) => readString(root, 'path')),
      ...arrayRecords(records.topAreas).map((area) => readString(area, 'path')),
      ...arrayRecords(records.localPackages).map((pkg) => readString(pkg, 'path')),
    ]
      .map(normalizePath)
      .filter(isPresent)
  );
  return [...focus].map((modulePath) => ({
    moduleName: moduleNameFromPath(modulePath),
    modulePath,
    role: repoPaths.has(modulePath) ? 'focus-module' : 'focus-submodule',
  }));
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

function readBoolean(record: unknown, key: string): boolean | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'boolean' ? value : undefined;
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

function dedupeOrderedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
