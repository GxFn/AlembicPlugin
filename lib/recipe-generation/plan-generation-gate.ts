import { resolveProjectRoot } from '@alembic/core/workspace';
import { routePlanTool } from '#recipe-generation/plan-tool.js';

export type PlanGenerationStage = 'coldStart' | 'deepMining' | 'moduleMining';

export interface PlanScaleOverride {
  contentMaxLines?: number;
  maxFiles?: number;
  totalRecipeBudget?: number;
}

export interface PlanGenerationGateInput {
  dimensions?: readonly string[];
  generationStage?: PlanGenerationStage;
  moduleScope?: readonly string[];
  projectRoot?: string;
  rescanId?: string;
  scaleOverride?: PlanScaleOverride;
  testMode?: boolean;
}

export interface PlanGenerationGateContext {
  actor?: { role?: string; user?: string };
  container: {
    get(name: string): unknown;
    singletons?: Record<string, unknown>;
  };
  logger?: {
    info?(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
  };
}

interface PlanGateResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message?: string;
  success?: boolean;
}

export interface PlanGenerationGateReady {
  cleanupPolicy: 'full-reset' | 'rescan-clean' | 'force-rescan' | 'none';
  currentProjectContextSignature?: string;
  dimensionIds: string[];
  generationStage: PlanGenerationStage;
  moduleScope: string[];
  plan: Record<string, unknown>;
  planGate: Record<string, unknown>;
  planState: Record<string, unknown>;
  planView: Record<string, unknown>;
  projectRoot: string;
  scale: {
    contentMaxLines: number;
    maxFiles: number;
    totalRecipeBudget: number;
  };
  signature: Record<string, unknown>;
  testMode: boolean;
}

export type PlanGenerationGateResult =
  | { ok: true; value: PlanGenerationGateReady }
  | { ok: false; response: Record<string, unknown> };

export interface PlanGenerationLease {
  epoch: number;
  key: string;
  release(): void;
}

interface ActivePlanGenerationLease {
  epoch: number;
  key: string;
  projectRoot: string;
  startedAt: number;
  stage: PlanGenerationStage;
  toolName: string;
}

const TEST_MODE_DEFAULT_MAX_FILES = 80;
const TEST_MODE_DEFAULT_CONTENT_MAX_LINES = 80;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_CONTENT_MAX_LINES = 120;

let activePlanGenerationLeases: Map<string, ActivePlanGenerationLease> | null = null;
let nextLeaseEpoch: number | null = null;

export async function resolvePlanGenerationGate(
  ctx: PlanGenerationGateContext,
  input: PlanGenerationGateInput | undefined,
  options: { defaultStage: PlanGenerationStage; toolName: string }
): Promise<PlanGenerationGateResult> {
  const projectRoot = input?.projectRoot ?? resolveProjectRoot(ctx.container);
  const generationStage = input?.generationStage ?? options.defaultStage;
  const planRead = await readConfirmedPlanGateResponse(ctx, {
    generationStage,
    projectRoot,
    toolName: options.toolName,
  });
  if (!planRead.ok) {
    return planRead;
  }

  return {
    ok: true,
    value: buildPlanGenerationGateReady({
      data: planRead.data,
      generationStage,
      input,
      projectRoot,
      toolName: options.toolName,
    }),
  };
}

async function readConfirmedPlanGateResponse(
  ctx: PlanGenerationGateContext,
  options: { generationStage: PlanGenerationStage; projectRoot: string; toolName: string }
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; response: Record<string, unknown> }
> {
  let planResponse: PlanGateResponse;
  try {
    planResponse = (await routePlanTool(ctx as never, {
      operation: 'get',
      allowSignatureMismatch: false,
      allowStaleVersion: false,
      projectRoot: options.projectRoot,
    })) as PlanGateResponse;
  } catch (err: unknown) {
    return {
      ok: false,
      response: buildPlanGateBlockedResponse({
        blockedReason:
          err instanceof Error
            ? `Plan gate could not read the active confirmed Plan: ${err.message}`
            : 'Plan gate could not read the active confirmed Plan.',
        errorCode: 'PLAN_GATE_UNAVAILABLE',
        generationStage: options.generationStage,
        projectRoot: options.projectRoot,
        toolName: options.toolName,
      }),
    };
  }

  if (planResponse.success !== true) {
    return {
      ok: false,
      response: buildPlanGateBlockedResponse({
        blockedReason:
          planResponse.message ||
          'No active confirmed Plan is available for generation-stage tools.',
        errorCode:
          planResponse.errorCode === 'PLAN_NOT_FOUND'
            ? 'PLAN_REQUIRED'
            : planResponse.errorCode || 'PLAN_REQUIRED',
        generationStage: options.generationStage,
        planToolData: planResponse.data,
        projectRoot: options.projectRoot,
        toolName: options.toolName,
      }),
    };
  }

  const data = readRecord(planResponse.data);
  const signature = readRecord(data.signature);
  if (signature.matches !== true) {
    return {
      ok: false,
      response: buildPlanGateBlockedResponse({
        blockedReason:
          'Current ProjectContext signature differs from the confirmed Plan; refresh and confirm a new Plan before generation.',
        errorCode: 'PLAN_PROJECT_CONTEXT_STALE',
        generationStage: options.generationStage,
        planToolData: data,
        projectRoot: options.projectRoot,
        signature,
        toolName: options.toolName,
      }),
    };
  }

  return { ok: true, data };
}

function buildPlanGenerationGateReady(input: {
  data: Record<string, unknown>;
  generationStage: PlanGenerationStage;
  input: PlanGenerationGateInput | undefined;
  projectRoot: string;
  toolName: string;
}): PlanGenerationGateReady {
  const { data, generationStage, projectRoot, toolName } = input;
  const plan = readRecord(data.plan);
  const planState = readRecord(data.planState);
  const planView = readRecord(data.planView);
  const signature = readRecord(data.signature);
  const dimensions = selectPlanDimensions({
    requestedDimensionIds: normalizeStringArray(input.input?.dimensions),
    generationStage,
    plan,
    planState,
  });
  const moduleScope = selectPlanModuleScope({
    generationStage,
    moduleScope: normalizeStringArray(input.input?.moduleScope),
    plan,
    planState,
    testMode: input.input?.testMode === true,
  });
  const scale = resolvePlanScale({
    dimensions,
    override: input.input?.scaleOverride,
    plan,
    testMode: input.input?.testMode === true,
  });
  const cleanupPolicy = resolvePlanCleanupPolicy({
    force: readBoolean(input.input, 'force'),
    generationStage,
    testMode: input.input?.testMode === true,
    toolName,
  });
  const planGate = {
    status: 'ready',
    toolName,
    generationStage,
    cleanupPolicy,
    testMode: input.input?.testMode === true,
    plan: summarizePlan(plan),
    selectedDimensions: dimensions,
    moduleScope,
    scale,
    signature,
    coverageGaps: summarizeCoverageGaps(planState, generationStage, moduleScope).slice(0, 20),
  };

  return {
    cleanupPolicy,
    currentProjectContextSignature: readString(data, 'currentProjectContextSignature'),
    dimensionIds: dimensions,
    generationStage,
    moduleScope,
    plan,
    planGate,
    planState,
    planView,
    projectRoot,
    scale,
    signature,
    testMode: input.input?.testMode === true,
  };
}

export function acquirePlanGenerationLease(input: {
  gate: PlanGenerationGateReady;
  idempotencyKey?: string;
  toolName: string;
}): { ok: true; lease: PlanGenerationLease } | { ok: false; response: Record<string, unknown> } {
  const key =
    input.idempotencyKey ||
    [
      input.toolName,
      input.gate.generationStage,
      readString(input.gate.plan, 'planId') ?? 'plan',
      readNumber(input.gate.plan, 'version') ?? 0,
      input.gate.currentProjectContextSignature ?? 'signature',
      input.gate.dimensionIds.join(','),
      input.gate.moduleScope.join(','),
      input.gate.testMode ? 'test' : 'live',
    ].join(':');
  const leases = getActivePlanGenerationLeases();
  const existing = leases.get(key);
  if (existing) {
    return {
      ok: false,
      response: buildPlanGateBlockedResponse({
        blockedReason: `Generation request is already in progress for ${existing.toolName}/${existing.stage}.`,
        errorCode: 'PLAN_GENERATION_IN_PROGRESS',
        generationStage: input.gate.generationStage,
        projectRoot: input.gate.projectRoot,
        toolName: input.toolName,
        extraData: {
          planGate: {
            ...input.gate.planGate,
            status: 'in-progress',
            lease: {
              epoch: existing.epoch,
              key: existing.key,
              startedAt: existing.startedAt,
            },
          },
          needsUserInput: false,
        },
      }),
    };
  }
  const lease: ActivePlanGenerationLease = {
    epoch: nextPlanGenerationLeaseEpoch(),
    key,
    projectRoot: input.gate.projectRoot,
    startedAt: Date.now(),
    stage: input.gate.generationStage,
    toolName: input.toolName,
  };
  leases.set(key, lease);
  return {
    ok: true,
    lease: {
      epoch: lease.epoch,
      key,
      release: () => {
        const current = getActivePlanGenerationLeases().get(key);
        if (current?.epoch === lease.epoch) {
          getActivePlanGenerationLeases().delete(key);
        }
      },
    },
  };
}

function getActivePlanGenerationLeases(): Map<string, ActivePlanGenerationLease> {
  if (activePlanGenerationLeases === null) {
    activePlanGenerationLeases = new Map();
  }
  return activePlanGenerationLeases;
}

function nextPlanGenerationLeaseEpoch(): number {
  const epoch = nextLeaseEpoch ?? 1;
  nextLeaseEpoch = epoch + 1;
  return epoch;
}

export function attachPlanGenerationGateData<T extends Record<string, unknown>>(
  response: T,
  gate: PlanGenerationGateReady
): T {
  const record = response as T & { data?: unknown };
  const data = readRecord(record.data);
  record.data = {
    ...data,
    generationStage: gate.generationStage,
    cleanupPolicy: gate.cleanupPolicy,
    moduleScope: gate.moduleScope,
    planGate: gate.planGate,
    planState: gate.planState,
    testMode: gate.testMode
      ? {
          enabled: true,
          dimensions: gate.dimensionIds,
          moduleScope: gate.moduleScope,
          scaleOverride: gate.scale,
        }
      : undefined,
  };
  return response;
}

export function applyPlanGateToProjectAnalysisIntent(
  intent: {
    dimensionIds?: string[];
    projectAnalysis?: { contentMaxLines: number; maxFiles: number };
  },
  gate: PlanGenerationGateReady
): void {
  intent.dimensionIds = gate.dimensionIds;
  if (intent.projectAnalysis) {
    intent.projectAnalysis.maxFiles = gate.scale.maxFiles;
    intent.projectAnalysis.contentMaxLines = gate.scale.contentMaxLines;
  }
}

export function planGateNoCleanupResult() {
  return {
    deletedFiles: 0,
    clearedTables: [],
    preservedRecipes: 0,
    errors: [],
    trash: undefined,
    purgedTrash: undefined,
  };
}

export function planGateNoRecipeSnapshot() {
  return {
    count: 0,
    entries: [],
    coverageByDimension: {},
  };
}

function buildPlanGateBlockedResponse(input: {
  blockedReason: string;
  errorCode: string;
  extraData?: Record<string, unknown>;
  generationStage: PlanGenerationStage;
  planToolData?: unknown;
  projectRoot: string;
  signature?: Record<string, unknown>;
  toolName: string;
}): Record<string, unknown> {
  return {
    success: false,
    errorCode: input.errorCode,
    tool: input.toolName,
    message: `${input.toolName} blocked: confirm an Alembic Plan before ${input.generationStage} generation.`,
    data: {
      blockedReason: input.blockedReason,
      generationStage: input.generationStage,
      needsUserInput: true,
      nextActions: buildPlanGateNextActions(input.projectRoot),
      planGate: {
        status: 'blocked',
        errorCode: input.errorCode,
        generationStage: input.generationStage,
        projectRoot: input.projectRoot,
        signature: input.signature,
      },
      projectRoot: input.projectRoot,
      ...(input.planToolData ? { planToolData: input.planToolData } : {}),
      ...(input.extraData ?? {}),
    },
  };
}

function buildPlanGateNextActions(projectRoot: string): Record<string, unknown>[] {
  return [
    {
      tool: 'alembic_plan',
      operation: 'draft',
      required: true,
      reason: 'Create a ProjectContext-grounded Plan draft before generation.',
      args: { operation: 'draft', projectRoot },
    },
    {
      tool: 'alembic_plan',
      operation: 'confirm',
      required: true,
      reason:
        'Confirm selected dimensions, scale, module bindings, and planned next actions returned by the draft.',
    },
  ];
}

function selectPlanDimensions(input: {
  generationStage: PlanGenerationStage;
  plan: Record<string, unknown>;
  planState: Record<string, unknown>;
  requestedDimensionIds: readonly string[];
}): string[] {
  const intent = readRecord(input.plan.intent);
  const stages = readRecord(intent.stages);
  const stageTarget = readRecord(stages[input.generationStage]);
  const planDimensions = arrayRecords(intent.dimensions)
    .map((dimension) => ({
      dimensionId: readString(dimension, 'dimensionId') ?? '',
      priority: readNumber(dimension, 'priority'),
      stage: readString(dimension, 'stage') as PlanGenerationStage | undefined,
      targetRecipes: readNumber(dimension, 'targetRecipes'),
    }))
    .filter((dimension) => dimension.dimensionId.length > 0);
  let selected =
    input.generationStage === 'moduleMining'
      ? dimensionsFromModuleBindings(intent, input.planState)
      : normalizeStringArray(stageTarget.dimensions);
  if (selected.length === 0) {
    selected = planDimensions
      .filter((dimension) =>
        input.generationStage === 'coldStart'
          ? dimension.stage === 'coldStart'
          : dimension.stage !== 'coldStart'
      )
      .sort((left, right) => (left.priority ?? 999) - (right.priority ?? 999))
      .map((dimension) => dimension.dimensionId)
      .filter(Boolean);
  }
  if (selected.length === 0) {
    selected = planDimensions
      .sort((left, right) => (left.priority ?? 999) - (right.priority ?? 999))
      .map((dimension) => dimension.dimensionId)
      .filter(Boolean);
  }
  if (input.requestedDimensionIds.length > 0) {
    const requested = new Set(input.requestedDimensionIds);
    selected = selected.filter((dimensionId) => requested.has(dimensionId));
  }
  return uniqueStrings(selected);
}

function dimensionsFromModuleBindings(
  intent: Record<string, unknown>,
  planState: Record<string, unknown>
): string[] {
  const gaps = arrayRecords(readRecord(planState.coverage).gaps);
  const gapDimensions = gaps.map((gap) => readString(gap, 'dimensionId')).filter(isPresent);
  if (gapDimensions.length > 0) {
    return gapDimensions;
  }
  return arrayRecords(intent.moduleBindings)
    .flatMap((binding) => normalizeStringArray(binding.dimensions))
    .filter(isPresent);
}

function selectPlanModuleScope(input: {
  generationStage: PlanGenerationStage;
  moduleScope: readonly string[];
  plan: Record<string, unknown>;
  planState: Record<string, unknown>;
  testMode: boolean;
}): string[] {
  const intent = readRecord(input.plan.intent);
  const bindings = arrayRecords(intent.moduleBindings)
    .map((binding) => ({
      dimensions: normalizeStringArray(binding.dimensions),
      moduleId: readString(binding, 'moduleId'),
      modulePath: readString(binding, 'modulePath') ?? '',
      priority: readNumber(binding, 'priority'),
      targetRecipes: readNumber(binding, 'targetRecipes'),
    }))
    .filter((binding) => binding.modulePath.length > 0);
  const boundModulePaths = bindings.map((binding) => binding.modulePath).filter(Boolean);
  const requested = input.moduleScope.length ? input.moduleScope : [];
  const plannedModulePaths = arrayRecords(intent.plannedNextActions)
    .filter((action) => {
      const tool = readString(action, 'tool');
      return tool === 'alembic_rescan' || normalizeStringArray(action.modulePaths).length > 0;
    })
    .flatMap((action) => normalizeStringArray(action.modulePaths));
  const gapModules = arrayRecords(readRecord(input.planState.coverage).gaps)
    .map((gap) => readString(gap, 'modulePath'))
    .filter(isPresent);
  const selected = uniqueStrings(
    input.generationStage === 'moduleMining'
      ? [...requested, ...plannedModulePaths, ...boundModulePaths, ...gapModules]
      : requested.length > 0
        ? requested
        : [...boundModulePaths, ...plannedModulePaths]
  );
  return selected;
}

function resolvePlanScale(input: {
  dimensions: readonly string[];
  override?: PlanScaleOverride;
  plan: Record<string, unknown>;
  testMode: boolean;
}): PlanGenerationGateReady['scale'] {
  const planScale = readRecord(readRecord(input.plan.intent).scale);
  const totalRecipeBudget =
    input.override?.totalRecipeBudget ??
    readNumber(planScale, 'totalRecipeBudget') ??
    Math.max(1, input.dimensions.length);
  const maxFiles =
    input.override?.maxFiles ?? (input.testMode ? TEST_MODE_DEFAULT_MAX_FILES : DEFAULT_MAX_FILES);
  const contentMaxLines =
    input.override?.contentMaxLines ??
    (input.testMode ? TEST_MODE_DEFAULT_CONTENT_MAX_LINES : DEFAULT_CONTENT_MAX_LINES);
  return {
    contentMaxLines: clampPositiveInteger(contentMaxLines, DEFAULT_CONTENT_MAX_LINES, 2000),
    maxFiles: clampPositiveInteger(maxFiles, DEFAULT_MAX_FILES, 20000),
    totalRecipeBudget: clampPositiveInteger(
      input.testMode
        ? Math.min(totalRecipeBudget, Math.max(1, input.dimensions.length * 2))
        : totalRecipeBudget,
      Math.max(1, input.dimensions.length),
      500
    ),
  };
}

function resolvePlanCleanupPolicy(input: {
  force?: boolean;
  generationStage: PlanGenerationStage;
  testMode: boolean;
  toolName: string;
}): PlanGenerationGateReady['cleanupPolicy'] {
  if (input.testMode || input.generationStage === 'moduleMining') {
    return 'none';
  }
  if (input.toolName === 'alembic_bootstrap') {
    return 'full-reset';
  }
  return input.force ? 'force-rescan' : 'rescan-clean';
}

function summarizePlan(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    planId: readString(plan, 'planId'),
    version: readNumber(plan, 'version'),
    planStatus: readString(plan, 'planStatus'),
    projectRoot: readString(plan, 'projectRoot'),
    projectContextSignature: readString(plan, 'projectContextSignature'),
  };
}

function summarizeCoverageGaps(
  planState: Record<string, unknown>,
  generationStage: PlanGenerationStage,
  moduleScope: readonly string[]
): Record<string, unknown>[] {
  const scope = new Set(moduleScope);
  return arrayRecords(readRecord(planState.coverage).gaps).filter((gap) => {
    const modulePath = readString(gap, 'modulePath');
    if (generationStage !== 'moduleMining' || scope.size === 0) {
      return true;
    }
    return modulePath ? scope.has(modulePath) : false;
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      )
    : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function clampPositiveInteger(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}
