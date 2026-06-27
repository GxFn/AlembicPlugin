import { applyPlanSelection, type PlanSelection as CorePlanSelection } from '@alembic/core/plans';
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
  // U1 #1（additive）：直接 surface 既有 planSelection.moduleBindings（per-(模块×维度) 意图，含
  // dimensions/targetRecipes），供 #2 透传给 Core buildKnowledgeRescanPlan 驱动 per-cell gap。
  // 零新派生；flat moduleScope 出口保持不变（lease key / attachPlanGenerationGateData / creationGuide
  // 仍只依赖 flat moduleScope:string[]），新字段不拍扁、不替换 flat 出口。
  moduleBindings: NormalizedPlanSelection['moduleBindings'];
  moduleScope: string[];
  planGate: Record<string, unknown>;
  planSelection: NormalizedPlanSelection;
  projectRoot: string;
  scale: {
    contentMaxLines: number;
    maxFiles: number;
    totalRecipeBudget: number;
  };
  testMode: boolean;
}

export type NormalizedPlanSelection = Required<
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

let activePlanGenerationLeases: Map<string, ActivePlanGenerationLease> | null = null;
let nextLeaseEpoch: number | null = null;

export async function resolvePlanGenerationGate(
  ctx: PlanGenerationGateContext,
  input: PlanGenerationGateInput | undefined,
  options: { defaultStage: PlanGenerationStage; toolName: string }
): Promise<PlanGenerationGateResult> {
  const projectRoot = input?.projectRoot ?? resolveProjectRoot(ctx.container);
  const stageResolution = resolveExecutorGenerationStage(input, options);
  const generationStage = stageResolution.generationStage;
  if (!stageResolution.ok) {
    return {
      ok: false,
      response: buildPlanGateBlockedResponse({
        blockedReason: stageResolution.reason,
        errorCode: 'PLAN_REQUIRED',
        generationStage,
        projectRoot,
        toolName: options.toolName,
      }),
    };
  }
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

function resolveExecutorGenerationStage(
  input: PlanGenerationGateInput | undefined,
  options: { defaultStage: PlanGenerationStage; toolName: string }
):
  | { ok: true; generationStage: PlanGenerationStage }
  | { ok: false; generationStage: PlanGenerationStage; reason: string } {
  const requestedStage = readString(input, 'generationStage');
  const normalizedRequestedStage =
    requestedStage && isPlanGenerationStage(requestedStage) ? requestedStage : undefined;
  if (requestedStage && !normalizedRequestedStage) {
    return {
      ok: false,
      generationStage: options.defaultStage,
      reason: `Unsupported generationStage ${requestedStage}.`,
    };
  }
  if (options.toolName === 'alembic_bootstrap') {
    if (normalizedRequestedStage && normalizedRequestedStage !== 'coldStart') {
      return {
        ok: false,
        generationStage: 'coldStart',
        reason: `alembic_bootstrap only supports coldStart generationStage; received ${normalizedRequestedStage}.`,
      };
    }
    return { ok: true, generationStage: 'coldStart' };
  }
  if (options.toolName === 'alembic_rescan') {
    if (normalizedRequestedStage === 'coldStart') {
      return {
        ok: false,
        generationStage: 'coldStart',
        reason: 'alembic_rescan requires deepMining or moduleMining generationStage.',
      };
    }
    if (normalizedRequestedStage === 'deepMining' || normalizedRequestedStage === 'moduleMining') {
      return { ok: true, generationStage: normalizedRequestedStage };
    }
    if (options.defaultStage === 'coldStart') {
      return {
        ok: false,
        generationStage: 'coldStart',
        reason: 'alembic_rescan default generationStage must be deepMining or moduleMining.',
      };
    }
  }
  return { ok: true, generationStage: normalizedRequestedStage ?? options.defaultStage };
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

function isPlanGenerationStage(value: string): value is PlanGenerationStage {
  return value === 'coldStart' || value === 'deepMining' || value === 'moduleMining';
}

function buildPlanGenerationGateReady(input: {
  generationStage: PlanGenerationStage;
  input: PlanGenerationGateInput | undefined;
  planSelection: NormalizedPlanSelection;
  projectRoot: string;
  toolName: string;
}): PlanGenerationGateReady {
  const { generationStage, planSelection, projectRoot, toolName } = input;
  const projection = applyPlanSelection(toCorePlanSelection(planSelection), {
    moduleScope: input.input?.moduleScope,
    scaleOverride: input.input?.scaleOverride,
    testMode: input.input?.testMode === true,
  });
  const dimensions = projection.executionDimensions;
  const moduleScope = projection.moduleScope;
  const scale = projection.budget;
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
    selectedDimensions: dimensions,
    moduleScope,
    scale,
  };

  return {
    cleanupPolicy,
    dimensionIds: dimensions,
    generationStage,
    // U1 #1：直接复用既有 planSelection.moduleBindings（零派生）；flat moduleScope 不变。
    moduleBindings: planSelection.moduleBindings,
    moduleScope,
    planGate,
    planSelection,
    projectRoot,
    scale,
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
  intent.dimensionIds = [...gate.planSelection.dimensions];
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
  toolName: string;
}): Record<string, unknown> {
  return {
    success: false,
    errorCode: input.errorCode,
    tool: input.toolName,
    message: `${input.toolName} blocked: pass planSelection from a just-run alembic_plan confirm before ${input.generationStage} generation.`,
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
      reason: 'Collect the bounded ProjectContext and candidate dimensions before generation.',
      args: { operation: 'draft', projectRoot },
    },
    {
      tool: 'alembic_plan',
      operation: 'confirm',
      required: true,
      reason:
        'Confirm the Agent-authored single-stage selection and pass the returned planSelection to the executor.',
    },
  ];
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

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readString(record: unknown, key: string): string | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(record: unknown, key: string): boolean | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function toCorePlanSelection(selection: NormalizedPlanSelection): CorePlanSelection {
  if (typeof selection.scale.totalRecipeBudget !== 'number') {
    throw new Error(
      'Validated planSelection.scale.totalRecipeBudget is required before projection.'
    );
  }
  return {
    dimensions: selection.dimensions,
    generationStage: selection.generationStage,
    moduleBindings: selection.moduleBindings.map((binding, index) => {
      const dimensions = uniqueStrings(binding.dimensions ?? []);
      return {
        dimensions,
        modulePath: binding.modulePath,
        ...(binding.moduleId ? { moduleId: binding.moduleId } : {}),
        priority: binding.priority ?? index + 1,
        targetRecipes: binding.targetRecipes ?? Math.max(1, dimensions.length),
      };
    }),
    scale: {
      totalRecipeBudget: selection.scale.totalRecipeBudget,
      ...(typeof selection.scale.contentMaxLines === 'number'
        ? { contentMaxLines: selection.scale.contentMaxLines }
        : {}),
      ...(Array.isArray(selection.scale.depthLevels)
        ? { depthLevels: selection.scale.depthLevels }
        : {}),
      ...(typeof selection.scale.maxFiles === 'number'
        ? { maxFiles: selection.scale.maxFiles }
        : {}),
    },
  };
}
