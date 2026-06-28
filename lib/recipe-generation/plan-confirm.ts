import { resolvePlanDimensionDefinitions } from '@alembic/core/dimensions';
import {
  normalizeConfirmedPlanIntent,
  type PlanIntent,
  type PlanModuleBinding,
  type PlanNextAction,
  type PlanScaleDecision,
  type PlanSelection,
  type PlanStageId,
  validateCompletePlanIntent,
} from '@alembic/core/plans';
import type { EvolutionCoverageLedgerRepository } from '@alembic/core/repositories';
import { resolveProjectRoot } from '@alembic/core/workspace';
import type { PlanInput } from '#shared/schemas/mcp-tools.js';

export interface PlanConfirmContext {
  actor?: { role?: string; user?: string };
  container: {
    get(name: string): unknown;
    singletons?: Record<string, unknown>;
  };
}

export interface PlanConfirmResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

type PlanArgs = PlanInput;

type BuildConfirmIntentResult =
  | { ok: true; intent: PlanIntent }
  | { ok: false; response: PlanConfirmResponse };

export async function confirmPlan(
  ctx: PlanConfirmContext,
  args: PlanArgs
): Promise<PlanConfirmResponse> {
  const projectRoot = resolvePlanProjectRoot(ctx, args);
  const payloadResult = buildConfirmedPlanIntent(args);
  if (!payloadResult.ok) {
    return payloadResult.response;
  }
  let intent: PlanIntent;
  try {
    intent = normalizeConfirmedPlanIntent(payloadResult.intent);
    validateCompletePlanIntent(intent);
  } catch (err: unknown) {
    return blocked(
      'PLAN_CONFIRM_PAYLOAD_INVALID',
      err instanceof Error
        ? err.message
        : 'Core rejected the stateless planSelection confirmation payload.',
      { operation: 'confirm', projectRoot }
    );
  }
  // U2c：coldStart confirm 后，把「canonical 模块×已选维度」网格里 Agent 未绑定本轮扫的 cell 写成 deferred 空行。
  // best-effort、纯副作用，绝不改 confirm 响应（intent 已校验通过才走到这）。RED LINE 6：deferred 行写出而非缺席。
  if (intent.generationStage === 'coldStart') {
    await writeColdStartDeferredCoverageRows(ctx, projectRoot, intent);
  }
  return confirmedPlanResponse(projectRoot, intent, buildPlanSelection(intent));
}

/**
 * U2c：coldStart confirm 写 deferred 空行（best-effort，绝不阻断 confirm）。
 *
 * scan-now vs deferred 完全由 Agent 的 selectedDimensions × moduleBindings 决定：
 *   一个 (canonical 模块 × 维度) 算「本轮扫」当且仅当 —— 存在某个 moduleBinding，其 modulePath 与该模块 path 前缀重叠
 *   且该 binding 的 dimensions 含此维度。否则该 cell = deferred（Agent 本轮没选它）。
 * deferred cell 写 grade=empty,deferred=1,lastRound=0（round 0=coldStart 首扫），让 deepMining「空白格」语义无歧义。
 *
 * no-guess：Plugin 不臆造该扫哪些；deferred 纯由「网格 − Agent 已绑定」推导。
 * D3：只写 coverage_ledger，绝不触达 git_diff_checkpoints。
 */
async function writeColdStartDeferredCoverageRows(
  ctx: PlanConfirmContext,
  projectRoot: string,
  intent: PlanIntent
): Promise<void> {
  try {
    const coverageLedgerRepository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!coverageLedgerRepository) {
      return;
    }
    const moduleService = ctx.container.get('moduleService') as
      | { listCanonicalModules(): Promise<Array<{ id?: string; name: string; path?: string }>> }
      | undefined;
    if (!moduleService || typeof moduleService.listCanonicalModules !== 'function') {
      return;
    }
    const canonicalModules = await moduleService.listCanonicalModules();
    if (canonicalModules.length === 0) {
      // no-guess：无 canonical 模块就没有可信网格，不写任何 deferred 行。
      return;
    }

    const selectedDimensionIds = intent.dimensions.map((dimension) => dimension.dimensionId);
    if (selectedDimensionIds.length === 0) {
      return;
    }

    // 预归一化每个 binding 的 modulePath + 其覆盖的维度集合，供前缀重叠判定。
    const normalizedBindings = intent.moduleBindings.map((binding) => ({
      path: normalizeCoveragePath(binding.modulePath),
      dimensions: new Set(binding.dimensions),
    }));

    let deferredWritten = 0;
    for (const module of canonicalModules) {
      const moduleId = module.id ?? module.name;
      const modulePath = normalizeCoveragePath(module.path);
      for (const dimensionId of selectedDimensionIds) {
        // 该 (模块×维度) 是否被 Agent 绑定本轮扫：任一 binding 与模块 path 重叠且含此维度即算「扫」。
        const scanned = normalizedBindings.some(
          (binding) =>
            binding.dimensions.has(dimensionId) && coveragePathsOverlap(binding.path, modulePath)
        );
        if (scanned) {
          continue;
        }
        // 未被绑定 → deferred 空行（grade=empty,deferred=1）。
        coverageLedgerRepository.upsertCell({
          projectRoot,
          moduleId,
          dimensionId,
          grade: 'empty',
          deferred: true,
          coveredCount: 0,
          totalCandidateCount: 0,
          valueScore: 0,
          lastRound: 0,
        });
        deferredWritten += 1;
      }
    }

    // info：deferred 行是 advisory 覆盖状态（标记「本轮选择不扫」），非门禁。
    if (deferredWritten > 0) {
      logCoverageInfo(ctx, '[PlanConfirm] coldStart deferred coverage rows written (advisory)', {
        projectRoot,
        deferredCells: deferredWritten,
        selectedDimensions: selectedDimensionIds.length,
      });
    }
  } catch (_err: unknown) {
    // 吞掉任何异常：deferred 写入是 coldStart confirm 的旁路副作用，绝不改响应、不阻断 confirm。
  }
}

/** 归一化覆盖路径：统一斜杠、去首尾分隔符，保证前缀匹配两侧坐标系一致（空路径返回空串）。 */
function normalizeCoveragePath(value: string | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').trim();
}

/**
 * 路径前缀重叠：任一方是另一方的「路径段前缀」即视为重叠（与 canonical-module-axis / Core pathsOverlap 同语义）。
 * 任一为空串视为不重叠（无路径的模块/绑定不参与覆盖归属）。
 */
function coveragePathsOverlap(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** plan-confirm 容器没有强类型 logger，这里安全探测 ctx.logger 再打印（缺省静默）。 */
function logCoverageInfo(
  ctx: PlanConfirmContext,
  message: string,
  meta?: Record<string, unknown>
): void {
  const maybeLogger = (
    ctx as { logger?: { info?(m: string, meta?: Record<string, unknown>): void } }
  ).logger;
  maybeLogger?.info?.(message, meta);
}

function buildConfirmedPlanIntent(args: PlanArgs): BuildConfirmIntentResult {
  const issues: string[] = [];
  const projectProfile = buildConfirmProjectProfile(args.projectProfile, issues);
  const dimensions = normalizeConfirmedDimensions(args.selectedDimensions, issues);
  const dimensionIds = dimensions.map((dimension) => dimension.dimensionId);
  const missingDimensionIds = resolvePlanDimensionDefinitions(dimensionIds).missingDimensionIds;
  for (const dimensionId of missingDimensionIds) {
    issues.push(`selectedDimensions references unknown dimension ${dimensionId}`);
  }
  const scale = normalizeRequiredPlanScale(args.scale, issues);
  const moduleBindings = normalizeRequiredModuleBindings(args.moduleBindings, dimensionIds, issues);
  const plannedNextActions = normalizeRequiredNextActions(args.plannedNextActions, issues);
  const evidenceRefs = normalizeRequiredEvidenceRefs(args.evidenceRefs, issues);
  const rationale = normalizeRequiredRationale(args.rationale);
  const generationStage = normalizeRequiredGenerationStage(args, issues);
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
      generationStage,
      projectProfile,
      dimensions,
      scale,
      moduleBindings,
      plannedNextActions,
      evidenceRefs,
      draftSource: 'host-agent',
    },
  };
}

function buildConfirmProjectProfile(
  input: PlanArgs['projectProfile'],
  issues: string[]
): PlanIntent['projectProfile'] {
  if (!input) {
    issues.push('projectProfile is required');
  }
  const profile = readRecord(input);
  return {
    ...(readString(profile, 'projectType')
      ? { projectType: readString(profile, 'projectType') }
      : {}),
    ...(readString(profile, 'primaryLanguage')
      ? { primaryLanguage: readString(profile, 'primaryLanguage') }
      : {}),
    secondaryLanguages: normalizeStringArray(profile.secondaryLanguages),
    frameworks: normalizeStringArray(profile.frameworks),
    ...(readNumber(profile, 'moduleCount') !== undefined
      ? { moduleCount: readNumber(profile, 'moduleCount') }
      : {}),
    ...(readNumber(profile, 'fileCount') !== undefined
      ? { fileCount: readNumber(profile, 'fileCount') }
      : {}),
    architectureHints: normalizeStringArray(profile.architectureHints),
  };
}

function normalizeRequiredGenerationStage(args: PlanArgs, issues: string[]): PlanStageId {
  if (!args.generationStage) {
    issues.push('generationStage is required');
    return 'coldStart';
  }
  return args.generationStage;
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
      if (!dimension.targetRecipes || dimension.targetRecipes <= 0) {
        issues.push(`selectedDimensions[${index}].targetRecipes must be > 0`);
      }
      return {
        dimensionId,
        priority: dimension.priority ?? index + 1,
        rationale,
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
  if (!input?.depthLevels?.length) {
    issues.push('scale.depthLevels are required');
  }
  return {
    totalRecipeBudget: input?.totalRecipeBudget ?? 0,
    depthLevels: input?.depthLevels ?? [],
    ...(input?.maxFiles ? { maxFiles: input.maxFiles } : {}),
    ...(input?.contentMaxLines ? { contentMaxLines: input.contentMaxLines } : {}),
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

function normalizeRequiredRationale(rationale: PlanArgs['rationale']): readonly string[] {
  if (Array.isArray(rationale)) {
    return rationale;
  }
  if (typeof rationale === 'string') {
    return [rationale];
  }
  return [];
}

function nextGenerationToolForStage(stage: PlanStageId): 'alembic_bootstrap' | 'alembic_rescan' {
  return stage === 'coldStart' ? 'alembic_bootstrap' : 'alembic_rescan';
}

function confirmedPlanResponse(
  projectRoot: string,
  intent: PlanIntent,
  planSelection: PlanSelection
): PlanConfirmResponse {
  return {
    success: true,
    message: `Stateless planSelection for ${intent.generationStage} is ready for downstream generation.`,
    data: {
      operation: 'confirm',
      projectRoot,
      status: 'confirmed',
      planSelection,
      nextActions: [
        {
          tool: nextGenerationToolForStage(intent.generationStage),
          required: true,
          reason: 'Pass this stateless planSelection directly to the generation tool.',
          args: { planSelection, projectRoot },
        },
      ],
    },
  };
}

function buildPlanSelection(intent: PlanIntent): PlanSelection {
  return {
    generationStage: intent.generationStage,
    dimensions: intent.dimensions.map((dimension) => dimension.dimensionId),
    scale: {
      totalRecipeBudget: intent.scale.totalRecipeBudget,
      ...(intent.scale.maxFiles ? { maxFiles: intent.scale.maxFiles } : {}),
      ...(intent.scale.contentMaxLines ? { contentMaxLines: intent.scale.contentMaxLines } : {}),
      ...(intent.scale.depthLevels.length > 0 ? { depthLevels: intent.scale.depthLevels } : {}),
    },
    moduleBindings: intent.moduleBindings,
  };
}

function resolvePlanProjectRoot(ctx: PlanConfirmContext, args: Partial<PlanArgs>): string {
  return args.projectRoot ?? resolveProjectRoot(ctx.container);
}

function blocked(
  errorCode: string,
  message: string,
  data: Record<string, unknown> = {}
): PlanConfirmResponse {
  return {
    success: false,
    errorCode,
    message,
    data,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: unknown, key: string): string | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(record: unknown, key: string): number | undefined {
  const value = readRecord(record)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeStringArray(value: unknown): string[] {
  return arrayStrings(value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
