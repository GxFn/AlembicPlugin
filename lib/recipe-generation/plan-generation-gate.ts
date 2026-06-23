import { resolveProjectRoot } from '@alembic/core/workspace';

export type PlanGenerationStage = 'coldStart' | 'deepMining' | 'moduleMining';

export interface PlanScaleOverride {
  contentMaxLines?: number;
  maxFiles?: number;
  totalRecipeBudget?: number;
}

export interface PlanSelectionModuleBinding {
  dimensions?: readonly string[];
  moduleId?: string;
  modulePath: string;
  priority?: number;
  targetRecipes?: number;
}

export interface PlanSelectionInput {
  dimensions?: readonly string[];
  generationStage?: PlanGenerationStage;
  moduleBindings?: readonly PlanSelectionModuleBinding[];
  scale?: PlanScaleOverride & { depthLevels?: readonly string[] };
}

export interface PlanGenerationGateInput {
  dimensions?: readonly string[];
  generationStage?: PlanGenerationStage;
  moduleScope?: readonly string[];
  planSelection?: PlanSelectionInput;
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

type NormalizedPlanSelection = Required<
  Pick<PlanSelectionInput, 'dimensions' | 'generationStage' | 'moduleBindings' | 'scale'>
>;

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
  const generationStage =
    input?.planSelection?.generationStage ?? input?.generationStage ?? options.defaultStage;
  const planSelection = validatePlanSelection(input?.planSelection, generationStage);
  if (!planSelection.ok) {
    return {
      ok: false,
      response: buildPlanGateBlockedResponse({
        blockedReason: planSelection.reason,
        errorCode: 'PLAN_REQUIRED',
        generationStage,
        projectRoot,
        toolName: options.toolName,
      }),
    };
  }

  return {
    ok: true,
    value: buildPlanGenerationGateReady({
      generationStage,
      input,
      planSelection: planSelection.value,
      projectRoot,
      toolName: options.toolName,
    }),
  };
}

function validatePlanSelection(
  selection: PlanSelectionInput | undefined,
  generationStage: PlanGenerationStage
): { ok: true; value: NormalizedPlanSelection } | { ok: false; reason: string } {
  if (!selection) {
    return {
      ok: false,
      reason:
        'Missing stateless planSelection. Run alembic_plan draft, confirm the single-stage selection, then pass planSelection to this tool.',
    };
  }
  if (selection.generationStage && selection.generationStage !== generationStage) {
    return {
      ok: false,
      reason: `planSelection.generationStage ${selection.generationStage} does not match requested ${generationStage}.`,
    };
  }
  const dimensions = uniqueStrings(selection.dimensions ?? []);
  if (dimensions.length === 0) {
    return { ok: false, reason: 'planSelection.dimensions must be non-empty.' };
  }
  const scale = selection.scale;
  if (!scale?.totalRecipeBudget || scale.totalRecipeBudget <= 0) {
    return { ok: false, reason: 'planSelection.scale.totalRecipeBudget must be > 0.' };
  }
  const moduleBindings = (selection.moduleBindings ?? []).filter(
    (binding) => binding.modulePath.trim().length > 0
  );
  if (moduleBindings.length === 0) {
    return { ok: false, reason: 'planSelection.moduleBindings must be non-empty.' };
  }
  const knownDimensions = new Set(dimensions);
  for (const binding of moduleBindings) {
    const bindingDimensions = uniqueStrings(binding.dimensions ?? []);
    if (bindingDimensions.length === 0) {
      return {
        ok: false,
        reason: `planSelection.moduleBindings ${binding.modulePath} must declare dimensions.`,
      };
    }
    for (const dimensionId of bindingDimensions) {
      if (!knownDimensions.has(dimensionId)) {
        return {
          ok: false,
          reason: `planSelection.moduleBindings ${binding.modulePath} references unknown dimension ${dimensionId}.`,
        };
      }
    }
  }
  return {
    ok: true,
    value: {
      dimensions,
      generationStage: selection.generationStage ?? generationStage,
      moduleBindings,
      scale,
    },
  };
}

function buildPlanGenerationGateReady(input: {
  generationStage: PlanGenerationStage;
  input: PlanGenerationGateInput | undefined;
  planSelection: NormalizedPlanSelection;
  projectRoot: string;
  toolName: string;
}): PlanGenerationGateReady {
  const { generationStage, planSelection, projectRoot, toolName } = input;
  const plan = {
    planStatus: 'confirmed',
    projectRoot,
    intent: {
      generationStage,
      dimensions: planSelection.dimensions.map((dimensionId, index) => ({
        dimensionId,
        priority: index + 1,
      })),
      moduleBindings: planSelection.moduleBindings,
      scale: planSelection.scale,
    },
    selectionSource: 'stateless-planSelection',
  };
  const planState = buildEmptyPlanState(planSelection);
  const planView = { planSelection };
  const signature = { matches: true, source: 'stateless-planSelection' };
  const dimensions = selectPlanDimensions({
    requestedDimensionIds: normalizeStringArray(input.input?.dimensions),
    generationStage,
    planSelection,
    testMode: input.input?.testMode === true,
  });
  const moduleScope = selectPlanModuleScope({
    generationStage,
    moduleScope: normalizeStringArray(input.input?.moduleScope),
    planSelection,
    testMode: input.input?.testMode === true,
  });
  const scale = resolvePlanScale({
    dimensions,
    override: input.input?.scaleOverride,
    planSelection,
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
    coverageByModuleDimension: readRecord(readRecord(planState.coverage).byModuleDimension),
    coverageGaps: summarizeCoverageGaps(planState, generationStage, moduleScope).slice(0, 20),
  };

  return {
    cleanupPolicy,
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

function buildEmptyPlanState(selection: NormalizedPlanSelection): Record<string, unknown> {
  return {
    codeRecipeMapping: [],
    coverage: {
      byDimension: Object.fromEntries(
        selection.dimensions.map((dimensionId) => [
          dimensionId,
          { planned: 0, generated: 0, stale: 0, missing: 0 },
        ])
      ),
      byModule: Object.fromEntries(
        selection.moduleBindings.map((binding) => [
          binding.modulePath,
          {
            planned: binding.targetRecipes ?? 0,
            generated: 0,
            stale: 0,
            missing: binding.targetRecipes ?? 0,
            dimensions: binding.dimensions ?? [],
          },
        ])
      ),
      byModuleDimension: {},
      generated: 0,
      planned: selection.scale.totalRecipeBudget,
      gaps: [],
    },
    pendingProposals: [],
    generationChangeLog: [],
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
      input.gate.projectRoot,
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
      reason: 'Confirm a complete Agent-authored Plan payload from the draft fact package.',
    },
  ];
}

function selectPlanDimensions(input: {
  generationStage: PlanGenerationStage;
  planSelection: NormalizedPlanSelection;
  requestedDimensionIds: readonly string[];
  testMode: boolean;
}): string[] {
  let selected = uniqueStrings(input.planSelection.dimensions);
  if (input.generationStage === 'moduleMining') {
    const bindingDimensions = uniqueStrings(
      input.planSelection.moduleBindings.flatMap((binding) => binding.dimensions ?? [])
    );
    if (bindingDimensions.length > 0) {
      selected = bindingDimensions;
    }
  }
  if (input.testMode && input.requestedDimensionIds.length > 0) {
    const requested = new Set(input.requestedDimensionIds);
    selected = selected.filter((dimensionId) => requested.has(dimensionId));
  }
  return selected;
}

function selectPlanModuleScope(input: {
  generationStage: PlanGenerationStage;
  moduleScope: readonly string[];
  planSelection: NormalizedPlanSelection;
  testMode: boolean;
}): string[] {
  const plannedModulePaths = uniqueStrings(
    input.planSelection.moduleBindings.map((binding) => binding.modulePath)
  );
  if (input.testMode && input.moduleScope.length > 0) {
    const requested = new Set(input.moduleScope);
    return plannedModulePaths.filter((modulePath) => requested.has(modulePath));
  }
  return plannedModulePaths;
}

function resolvePlanScale(input: {
  dimensions: readonly string[];
  override?: PlanScaleOverride;
  planSelection: NormalizedPlanSelection;
  testMode: boolean;
}): PlanGenerationGateReady['scale'] {
  const planScale = input.planSelection.scale;
  const override = input.testMode ? input.override : undefined;
  const totalRecipeBudget =
    override?.totalRecipeBudget ??
    planScale.totalRecipeBudget ??
    Math.max(1, input.dimensions.length);
  const maxFiles =
    override?.maxFiles ??
    planScale.maxFiles ??
    (input.testMode ? TEST_MODE_DEFAULT_MAX_FILES : DEFAULT_MAX_FILES);
  const contentMaxLines =
    override?.contentMaxLines ??
    planScale.contentMaxLines ??
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

function clampPositiveInteger(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}
