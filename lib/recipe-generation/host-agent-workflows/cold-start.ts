/**
 * HostAgentColdStartWorkflow — 宿主 Agent 驱动的冷启动
 *
 * ProjectContext 同步执行项目结构/源码/符号查询，
 * 构建 Mission Briefing 一次性返回，不启动异步 AI pipeline。
 * 等待 IDE 插件宿主中的宿主 Agent 主动提交知识 + 完成维度。
 *
 * 本文件只返回宿主 Agent Mission Briefing；插件侧不启动本地 AI pipeline。
 * 项目信息由 ProjectContext 直接提供，不再经过旧 snapshot 兼容载体。
 */

import {
  buildColdStartWorkflowPlan,
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildProjectContextMissionBriefing,
  createHostAgentColdStartIntent,
  getActiveHostAgentWorkflowSession,
  presentHostAgentColdStartEmptyProject,
  presentHostAgentColdStartResponse,
  runFullResetPolicy,
  type WorkflowLogger,
} from '@alembic/core/host-agent-workflows';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { buildLocalSelectionMismatch } from '#codex/HostProjectAlignment.js';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import { type HostKnowledgeState, inspectKnowledge } from '#codex/KnowledgeState.js';
import { buildColdStartOnboardingContract } from '#codex/status/OnboardingContract.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import {
  buildColdStartCompletenessCriticByDimension,
  projectCompletenessCriticForAgent,
} from '#recipe-generation/host-agent-workflows/completeness-critic.js';
import {
  buildHostAgentProjectContextAnalysis,
  createProjectContextHostAgentSession,
  selectProjectContextDimensions,
} from '#recipe-generation/host-agent-workflows/project-context-analysis.js';
import { resolveHostAgentDataRoot } from '#recipe-generation/host-agent-workflows/project-data-root.js';
import {
  acquirePlanGenerationLease,
  applyPlanGateToProjectAnalysisIntent,
  attachPlanGenerationGateData,
  type PlanGenerationGateReady,
  type PlanGenerationLease,
  planGateNoCleanupResult,
  resolvePlanGenerationGate,
} from '#recipe-generation/plan-generation-gate.js';
import { attachProjectContextCreationGuide } from '#recipe-generation/project-context-anchoring.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import type { BootstrapInput } from '#shared/schemas/mcp-tools.js';
import {
  attachFullBriefingRef,
  budgetBriefingResponseData,
} from '#recipe-generation/host-agent-workflows/briefing-budget.js';
import { jsonByteLength, type TransientTransportRef } from '#shared/transient-transport.js';

interface McpContext {
  container: ServiceContainer;
  logger: WorkflowLogger;
  startedAt?: number;
  [key: string]: unknown;
}

interface AttachColdStartOnboardingInput<T extends { meta?: Record<string, unknown> }> {
  briefing: T;
  dataRoot: string;
  dimensions: readonly unknown[];
  fileCount: number;
  moduleCount: number;
  primaryLang: string | null;
  projectRoot: string;
  projectType: string | null;
  secondaryLanguages: string[];
  session: unknown;
}

type ColdStartPlanGatePreparation =
  | { ok: true; lease: PlanGenerationLease; planGate: PlanGenerationGateReady }
  | { ok: false; response: Record<string, unknown> };

type ColdStartOnboardingContract = ReturnType<typeof buildColdStartOnboardingContract>;
type ColdStartOnboardingContractWithGuidance = ColdStartOnboardingContract & {
  currentDimensionGuidance: Record<string, unknown>;
  currentDimensionNextActions: Array<Record<string, unknown>>;
};

const COLD_START_BRIEFING_INLINE_BUDGET_BYTES = 18 * 1024;
const MAX_INLINE_CURRENT_DIMENSION_GUIDES = 2;

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * bootstrapForHostAgent — 宿主 Agent 驱动的一键冷启动
 *
 * 无参数调用，返回 Mission Briefing。
 * Phase 1-4 复用现有 bootstrap.js 逻辑，Phase 5 不启动。
 *
 * @param ctx { container, logger, startedAt }
 * @returns envelope({ success, data: MissionBriefing })
 */
export async function runHostAgentColdStartWorkflow(ctx: McpContext, args?: BootstrapInput) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveHostAgentDataRoot(ctx.container, projectRoot);
  const gate = await prepareColdStartPlanGate(ctx, args, projectRoot);
  if (!gate.ok) {
    return attachLocalSelectionMismatch(gate.response, projectRoot);
  }

  try {
    return await runPlanGatedColdStart(ctx, args, {
      dataRoot,
      planGate: gate.planGate,
      projectRoot,
      responseStartMs: t0,
    });
  } finally {
    gate.lease.release();
  }
}

async function prepareColdStartPlanGate(
  ctx: McpContext,
  args: BootstrapInput | undefined,
  projectRoot: string
): Promise<ColdStartPlanGatePreparation> {
  const planGate = await resolvePlanGenerationGate(ctx, args, {
    defaultStage: 'coldStart',
    toolName: 'alembic_bootstrap',
  });
  if (!planGate.ok) {
    return { ok: false, response: planGate.response };
  }
  const lease = acquirePlanGenerationLease({
    gate: planGate.value,
    idempotencyKey: args?.rescanId,
    toolName: 'alembic_bootstrap',
  });
  if (!lease.ok) {
    return { ok: false, response: lease.response };
  }
  return { ok: true, lease: lease.lease, planGate: planGate.value };
}

async function runPlanGatedColdStart(
  ctx: McpContext,
  args: BootstrapInput | undefined,
  input: {
    dataRoot: string;
    planGate: PlanGenerationGateReady;
    projectRoot: string;
    responseStartMs: number;
  }
): Promise<Record<string, unknown>> {
  const confirmationBlock = buildColdStartDestructiveConfirmationBlock(
    input.projectRoot,
    input.planGate,
    args
  );
  if (confirmationBlock) {
    return attachLocalSelectionMismatch(confirmationBlock, input.projectRoot);
  }

  const intent = createHostAgentColdStartIntent();
  applyPlanGateToProjectAnalysisIntent(intent, input.planGate);
  const plan = buildColdStartWorkflowPlan({
    intent,
    projectRoot: input.projectRoot,
    dataRoot: input.dataRoot,
  });
  const cleanupResult = await runColdStartCleanup(ctx, input, plan);
  const projectContextAnalysis = await buildHostAgentProjectContextAnalysis({
    maxFiles: plan.projectAnalysis.scan.maxFiles,
    moduleScope: input.planGate.moduleScope,
    projectRoot: plan.projectAnalysis.projectRoot,
    source: 'codex-host-bootstrap',
  });
  if (projectContextAnalysis.isEmpty) {
    const response = attachPlanGenerationGateData(
      presentHostAgentColdStartEmptyProject({
        responseTimeMs: Date.now() - input.responseStartMs,
      }) as Record<string, unknown>,
      input.planGate
    );
    return attachLocalSelectionMismatch(response, input.projectRoot);
  }

  const briefingDimensions = selectProjectContextDimensions(
    projectContextAnalysis.dimensions,
    input.planGate.planSelection.dimensions
  );
  const response = await buildColdStartMissionBriefingResponse(ctx, {
    briefingDimensions,
    cleanupResult,
    dataRoot: input.dataRoot,
    planGate: input.planGate,
    projectContextAnalysis,
    projectRoot: input.projectRoot,
    responseTimeMs: Date.now() - input.responseStartMs,
  });
  return attachLocalSelectionMismatch(response, input.projectRoot);
}

function buildColdStartDestructiveConfirmationBlock(
  projectRoot: string,
  planGate: PlanGenerationGateReady,
  args: BootstrapInput | undefined
): Record<string, unknown> | null {
  const knowledgeBefore = inspectKnowledge(projectRoot);
  return planGate.cleanupPolicy === 'full-reset'
    ? buildBootstrapRebuildConfirmationBlock(knowledgeBefore, args)
    : null;
}

async function runColdStartCleanup(
  ctx: McpContext,
  input: { dataRoot: string; planGate: PlanGenerationGateReady },
  plan: ReturnType<typeof buildColdStartWorkflowPlan>
) {
  if (input.planGate.cleanupPolicy === 'none') {
    return planGateNoCleanupResult();
  }
  const db = ctx.container.get('database');
  return runFullResetPolicy({
    projectRoot: plan.cleanup.projectRoot,
    dataRoot: input.dataRoot,
    db,
    logger: ctx.logger,
    createCleanupService: (policyCtx) =>
      new CleanupService({
        projectRoot: policyCtx.projectRoot,
        dataRoot: policyCtx.dataRoot,
        db: policyCtx.db,
        logger: policyCtx.logger,
      }),
  });
}

async function buildColdStartMissionBriefingResponse(
  ctx: McpContext,
  input: {
    briefingDimensions: ReturnType<typeof selectProjectContextDimensions>;
    cleanupResult: Awaited<ReturnType<typeof runColdStartCleanup>>;
    dataRoot: string;
    planGate: PlanGenerationGateReady;
    projectContextAnalysis: Awaited<ReturnType<typeof buildHostAgentProjectContextAnalysis>>;
    projectRoot: string;
    responseTimeMs: number;
  }
): Promise<Record<string, unknown> & { message?: string }> {
  const session = createProjectContextHostAgentSession({
    container: ctx.container,
    dimensions: input.briefingDimensions,
    fileCount: input.projectContextAnalysis.fileCount,
    moduleCount: input.projectContextAnalysis.moduleCount,
    primaryLang: input.projectContextAnalysis.primaryLang,
    projectRoot: input.projectRoot,
  });
  const briefing = await buildColdStartMissionBriefing(ctx, input, session);
  const response = attachPlanGenerationGateData(
    presentHostAgentColdStartResponse({
      cleanupResult: input.cleanupResult,
      briefing,
      dimensionCount: input.briefingDimensions.length,
      responseTimeMs: input.responseTimeMs,
    }) as Record<string, unknown> & { message?: string },
    input.planGate
  );
  await budgetColdStartResponseData(response, {
    dataRoot: input.dataRoot,
    projectRoot: input.projectRoot,
  });
  attachBriefingTransportMeta(response, readRecord(response.data) ?? {});
  attachColdStartTrashMessage(response, input.cleanupResult);
  return response;
}

async function buildColdStartMissionBriefing(
  ctx: McpContext,
  input: {
    briefingDimensions: ReturnType<typeof selectProjectContextDimensions>;
    dataRoot: string;
    planGate: PlanGenerationGateReady;
    projectContextAnalysis: Awaited<ReturnType<typeof buildHostAgentProjectContextAnalysis>>;
    projectRoot: string;
  },
  session: ReturnType<typeof createProjectContextHostAgentSession>
) {
  const briefing = attachPlanScopeTargetCounts(
    buildProjectContextMissionBriefing({
      activeDimensions: input.briefingDimensions,
      projectContext: input.projectContextAnalysis.presenterInput,
      projectMeta: {
        fileCount: input.projectContextAnalysis.fileCount,
        moduleCount: input.projectContextAnalysis.moduleCount,
      },
      profile: 'cold-start-host-agent',
      session,
    }),
    {
      moduleScope: input.planGate.moduleScope,
      sourceFileFacts: input.projectContextAnalysis.sourceFileFacts,
    }
  );
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromProjectContext({
    dimensions: input.briefingDimensions,
    options: { profile: 'cold-start', projectRoot: input.projectRoot },
    projectContext: input.projectContextAnalysis.presenterInput,
  });
  const briefingWithIdeAgentSurface = attachIDEAgentAnalysisSurface(
    briefing,
    buildIDEAgentAnalysisSurface(ideAgentPacket)
  );
  const briefingWithOnboardingContract = attachColdStartOnboardingSurface({
    briefing: briefingWithIdeAgentSurface,
    dataRoot: input.dataRoot,
    dimensions: input.briefingDimensions,
    fileCount: input.projectContextAnalysis.fileCount,
    moduleCount: input.projectContextAnalysis.moduleCount,
    primaryLang: input.projectContextAnalysis.primaryLang,
    projectRoot: input.projectRoot,
    projectType: input.projectContextAnalysis.projectType,
    secondaryLanguages: input.projectContextAnalysis.secondaryLanguages,
    session,
  });
  const briefingWithCompletenessCritic = attachColdStartCompletenessCriticSurface(
    briefingWithOnboardingContract,
    {
      dimensions: input.briefingDimensions,
      projectContextAnalysis: input.projectContextAnalysis,
    }
  );
  briefingWithCompletenessCritic.meta.projectContextDirectSwitch = {
    moduleSeedCount: input.projectContextAnalysis.moduleSeeds.length,
    requestKinds: input.projectContextAnalysis.requestKinds,
  };
  const briefingWithProjectContextGuide = attachProjectContextCreationGuide(
    briefingWithCompletenessCritic,
    {
      dimensionIds: input.briefingDimensions.map((dimension) => dimension.id),
      generationStage: input.planGate.generationStage,
      moduleScope: input.planGate.moduleScope,
      projectRoot: input.projectRoot,
      stage: 'bootstrap',
      testMode: input.planGate.testMode,
    }
  );
  ctx.logger.info(
    `[BootstrapHostAgent] ProjectContext Mission Briefing ready: ${input.projectContextAnalysis.fileCount} files, ${input.briefingDimensions.length} dims, ` +
      `${briefingWithProjectContextGuide.meta?.responseSizeKB || '?'}KB — session ${(session as { id?: string }).id}`
  );
  return briefingWithProjectContextGuide;
}

export function attachPlanScopeTargetCounts<T extends { targets?: unknown }>(
  briefing: T,
  input: {
    moduleScope?: readonly string[];
    sourceFileFacts: readonly { filePath: string }[];
  }
): T {
  const moduleScopes = (input.moduleScope ?? []).map(normalizeProjectScopePath).filter(isString);
  if (moduleScopes.length === 0) {
    return briefing;
  }
  const targets = readRecordArray(briefing.targets).map((target) => ({ ...target }));
  for (const scope of moduleScopes) {
    const files = input.sourceFileFacts
      .map((file) => file.filePath)
      .filter((filePath) => filePath === scope || filePath.startsWith(`${scope}/`))
      .sort();
    if (files.length === 0) {
      continue;
    }
    const targetName = moduleNameFromProjectScope(scope);
    const existingIndex = targets.findIndex((target) =>
      targetMatchesProjectScope(target, targetName, scope)
    );
    const patch = {
      fileCount: files.length,
      keyFiles: files.slice(0, 12),
      modulePath: scope,
      name: targetName,
      source: 'plan-module-scope',
      type: 'target',
    };
    if (existingIndex >= 0) {
      targets[existingIndex] = {
        ...targets[existingIndex],
        ...patch,
        fileCount: Math.max(readNumber(targets[existingIndex].fileCount) ?? 0, files.length),
      };
    } else {
      targets.push(patch);
    }
  }
  return {
    ...briefing,
    targets,
  };
}

function targetMatchesProjectScope(
  target: Record<string, unknown>,
  targetName: string,
  scope: string
): boolean {
  const modulePath = normalizeProjectScopePath(readString(target.modulePath) ?? undefined);
  const name = readString(target.name);
  return modulePath === scope || name === targetName || name === scope;
}

function normalizeProjectScopePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.') {
    return undefined;
  }
  return trimmed.replace(/\\/g, '/').replace(/\/$/, '');
}

function moduleNameFromProjectScope(scope: string): string {
  return scope.split('/').filter(Boolean).at(-1) ?? scope;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function budgetColdStartResponseData(
  input: Record<string, unknown>,
  context: {
    dataRoot: string;
    projectRoot: string;
  }
): Promise<void> {
  // U3：委托共享预算步骤 budgetBriefingResponseData；cold-start 专属的瘦身阶梯
  // （compactColdStartBriefing → attachFullBriefingRef(ref) → trimColdStartBriefingToBudget）
  // 作为 compact 回调注入、**不下沉**到共享层。回调内字节顺序与历史逐字一致：trim 逐级测量的是
  // 已附 ref 的体积，故 attachFullBriefingRef(ref) 必须在 trim 之前；inline 与 >预算两路行为前后
  // 逐字段一致（行为快照硬验收）。
  await budgetBriefingResponseData(input, {
    dataRoot: context.dataRoot,
    projectRoot: context.projectRoot,
    transportName: 'bootstrap-briefing',
    inlineBudgetBytes: COLD_START_BRIEFING_INLINE_BUDGET_BYTES,
    attachRef: (data, ref) => attachFullBriefingRef(data, ref),
    compact: (fullInline, ref) =>
      trimColdStartBriefingToBudget(
        attachFullBriefingRef(compactColdStartBriefing(fullInline), ref),
        COLD_START_BRIEFING_INLINE_BUDGET_BYTES
      ),
  });
}

function compactColdStartBriefing<T extends { meta?: Record<string, unknown> }>(
  briefing: T
): T & { meta: Record<string, unknown> } {
  const record = briefing as Record<string, unknown>;
  const currentDimensionIds = readGuidanceDimensionIds(
    readRecord(record.currentDimensionGuidance) ?? {}
  );
  const inlineFullIds = new Set(currentDimensionIds.slice(0, MAX_INLINE_CURRENT_DIMENSION_GUIDES));
  return {
    ...briefing,
    dimensions: readRecordArray(record.dimensions).map((dimension, index) =>
      compactBriefingDimension(dimension, index, new Set())
    ),
    currentDimensionGuidance: compactCurrentDimensionGuidance(
      record.currentDimensionGuidance,
      inlineFullIds
    ),
    meta: { ...(briefing.meta || {}) },
  };
}

type CurrentDimensionDetailMode = 'full' | 'compact';

function compactBriefingDimension(
  dimension: Record<string, unknown>,
  index: number,
  currentIds: Set<string>,
  detailMode: CurrentDimensionDetailMode = 'full'
): Record<string, unknown> {
  const dimensionId = readDimensionId(dimension, index);
  const summary = {
    id: dimensionId,
    dimensionId,
    label:
      readString(dimension.label) ||
      readString(dimension.title) ||
      readString(dimension.name) ||
      dimensionId,
    tier:
      typeof dimension.tier === 'number' && Number.isFinite(dimension.tier) ? dimension.tier : null,
  };
  const completenessCritic = compactDimensionCompletenessCritic(
    dimension.completenessCritic,
    detailMode
  );
  if (!currentIds.has(dimensionId)) {
    return detailMode === 'compact' ? summary : { ...summary, ...completenessCritic };
  }
  if (detailMode === 'full') {
    return {
      ...summary,
      analysisGuide: dimension.analysisGuide ?? null,
      ...completenessCritic,
      submissionSpec: dimension.submissionSpec ?? null,
    };
  }
  return {
    ...summary,
    analysisGuide: compactDimensionGuide(dimension.analysisGuide),
    ...completenessCritic,
    submissionSpec: compactDimensionSubmissionSpec(dimension.submissionSpec),
  };
}

function compactDimensionCompletenessCritic(
  value: unknown,
  detailMode: CurrentDimensionDetailMode
): Record<string, unknown> {
  const critic = readRecord(value);
  if (!critic) {
    return {};
  }
  if (detailMode === 'full') {
    return { completenessCritic: critic };
  }
  return {
    completenessCritic: {
      status: critic.status,
      targetGate: critic.targetGate,
      shouldBlockCompletion: critic.shouldBlockCompletion,
    },
  };
}

function compactDimensionGuide(value: unknown): unknown {
  const guide = readRecord(value);
  if (!guide) {
    return value ?? null;
  }
  return {
    purpose: guide.purpose ?? guide.goal ?? guide.summary ?? null,
    focus: guide.focus ?? guide.focusAreas ?? guide.keyQuestions ?? null,
    steps: readRecordArray(guide.steps).slice(0, 4),
    evidence: guide.evidence ?? guide.requiredEvidence ?? null,
  };
}

function compactDimensionSubmissionSpec(value: unknown): unknown {
  const spec = readRecord(value);
  if (!spec) {
    return value ?? null;
  }
  const checklist = readRecord(spec.preSubmitChecklist);
  const required = appendChecklistItems(checklist?.required ?? checklist?.MUST ?? checklist?.must, [
    'P5: EN do/dont + ✅/❌.',
  ]);
  const rejectIf = appendChecklistItems(
    checklist?.rejectIf ?? checklist?.FAIL ?? checklist?.fail,
    []
  );
  return {
    knowledgeTypes: spec.knowledgeTypes,
    requiredFields: spec.requiredFields,
    sourceRefRequirements: spec.sourceRefRequirements ?? spec.sourceRefs,
    preSubmitChecklist: checklist
      ? {
          required,
          ...(rejectIf.length > 0 ? { rejectIf } : {}),
        }
      : { required },
  };
}

function compactCurrentDimensionGuidance(
  value: unknown,
  inlineFullIds: Set<string>,
  detailMode: CurrentDimensionDetailMode = 'full'
): Record<string, unknown> | unknown {
  const guidance = readRecord(value);
  if (!guidance) {
    return value;
  }
  const dimensions = readRecordArray(guidance.dimensions).map((dimension, index) =>
    compactBriefingDimension(dimension, index, inlineFullIds, detailMode)
  );
  return {
    ...guidance,
    dimensions,
    inlineFullDimensionIds: detailMode === 'full' ? [...inlineFullIds] : [],
    inlineDimensionDetailMode: detailMode,
    fullDimensionGuidanceRef: 'meta.fullBriefingRef.path',
  };
}

function trimColdStartBriefingToBudget<T extends { meta?: Record<string, unknown> }>(
  briefing: T & { meta: Record<string, unknown> },
  budgetBytes: number
): T & { meta: Record<string, unknown> } {
  let compact = briefing;
  if (jsonByteLength(compact) <= budgetBytes) {
    return compact;
  }

  const record = compact as Record<string, unknown>;
  if (isRecord(record.ideAgentAnalysis)) {
    compact = {
      ...compact,
      ideAgentAnalysis: compactIDEAgentAnalysis(record.ideAgentAnalysis, {
        maxNextUnits: 3,
        maxProgressUnits: 20,
        maxReadSet: 20,
        maxSourceRefs: 24,
        maxStructuralRefs: 12,
      }),
    };
  }
  if (jsonByteLength(compact) <= budgetBytes) {
    return compact;
  }

  const compactRecord = compact as Record<string, unknown>;
  const ideAgentAnalysis = compactRecord.ideAgentAnalysis;
  compact = {
    ...compact,
    ideAgentAnalysis: isRecord(ideAgentAnalysis)
      ? compactIDEAgentAnalysis(ideAgentAnalysis, {
          maxNextUnits: 1,
          maxProgressUnits: 8,
          maxReadSet: 8,
          maxSourceRefs: 8,
          maxStructuralRefs: 4,
        })
      : ideAgentAnalysis,
  };
  if (jsonByteLength(compact) <= budgetBytes) {
    return compact;
  }

  compact = compactColdStartLargeAnalysisFields(compact);
  if (jsonByteLength(compact) <= budgetBytes) {
    return compact;
  }

  compact = reduceCurrentDimensionGuidanceDetail(compact, 1);
  if (jsonByteLength(compact) <= budgetBytes) {
    return compact;
  }

  return minimalColdStartInlineData(compact);
}

function compactIDEAgentAnalysis(
  value: Record<string, unknown>,
  limits: {
    maxNextUnits: number;
    maxProgressUnits: number;
    maxReadSet: number;
    maxSourceRefs: number;
    maxStructuralRefs: number;
  }
): Record<string, unknown> {
  const retrieval = readRecord(value.retrieval) ?? {};
  const progress = readRecord(value.progress) ?? {};
  return {
    ...value,
    nextUnits: readRecordArray(value.nextUnits).slice(0, limits.maxNextUnits),
    retrieval: {
      ...retrieval,
      requiredReadSet: readStringArray(retrieval.requiredReadSet).slice(0, limits.maxReadSet),
      sourceRefs: readRecordArray(retrieval.sourceRefs).slice(0, limits.maxSourceRefs),
      structuralEvidenceRefs: readRecordArray(retrieval.structuralEvidenceRefs).slice(
        0,
        limits.maxStructuralRefs
      ),
    },
    progress: {
      ...progress,
      remainingUnitIds: readStringArray(progress.remainingUnitIds).slice(
        0,
        limits.maxProgressUnits
      ),
      unitProgress: readRecordArray(progress.unitProgress).slice(0, limits.maxProgressUnits),
    },
  };
}

function attachBriefingTransportMeta(
  response: Record<string, unknown>,
  briefing: Record<string, unknown>
): void {
  const briefingMeta = readRecord(briefing.meta);
  const fullBriefingRef = briefingMeta?.fullBriefingRef;
  const meta = readRecord(response.meta) ?? {};
  response.meta = {
    ...meta,
    fullBriefingRef: isTransientTransportRef(fullBriefingRef) ? fullBriefingRef : null,
  };
}

function compactColdStartLargeAnalysisFields<T extends { meta?: Record<string, unknown> }>(
  briefing: T & { meta: Record<string, unknown> }
): T & { meta: Record<string, unknown> } {
  const record = briefing as Record<string, unknown>;
  return {
    ...briefing,
    ast: summarizeAst(record.ast),
    currentDimensionNextActions: readRecordArray(record.currentDimensionNextActions).map(
      compactNextAction
    ),
    dependencyGraph: summarizeDependencyGraph(record.dependencyGraph),
    guardFindings: summarizeGuardFindings(record.guardFindings),
    hostAgentContract: compactHostAgentContract(record.hostAgentContract),
    initialToolBriefing: undefined,
    languageExtension: summarizeMaybePresent(record.languageExtension),
    mustCoverModules: summarizeMustCoverModules(record.mustCoverModules),
    panorama: summarizePanorama(record.panorama),
    progress: undefined,
    projectContextCreationGuide: undefined,
    recipeCreationNextActions: undefined,
    session: undefined,
    submissionSchema: summarizeSubmissionSchema(record.submissionSchema),
    toolCapabilities: compactToolCapabilities(record.toolCapabilities),
  };
}

function reduceCurrentDimensionGuidanceDetail<T extends { meta?: Record<string, unknown> }>(
  briefing: T & { meta: Record<string, unknown> },
  maxFullDimensions: number
): T & { meta: Record<string, unknown> } {
  const record = briefing as Record<string, unknown>;
  const guidance = readRecord(record.currentDimensionGuidance);
  if (!guidance) {
    return briefing;
  }
  const fullIds = readRecordArray(guidance.dimensions)
    .map((dimension, index) => readDimensionId(dimension, index))
    .slice(0, maxFullDimensions);
  return {
    ...briefing,
    currentDimensionGuidance: compactCurrentDimensionGuidance(
      guidance,
      new Set(fullIds),
      'compact'
    ),
  };
}

function minimalColdStartInlineData<T extends { meta?: Record<string, unknown> }>(
  briefing: T & { meta: Record<string, unknown> }
): T & { meta: Record<string, unknown> } {
  const record = briefing as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'bootstrapState',
    'currentDimensionGuidance',
    'currentDimensionNextActions',
    'dimensions',
    'executionPlan',
    'fileCount',
    'gates',
    'hostAgentContract',
    'meta',
    'progress',
    'projectRoot',
    'repairState',
    'serviceBoundary',
    'session',
    'toolCapabilities',
  ]) {
    if (key in record) {
      out[key] = record[key];
    }
  }
  return out as T & { meta: Record<string, unknown> };
}

function compactHostAgentContract(value: unknown): unknown {
  const contract = readRecord(value);
  if (!contract) {
    return value;
  }
  const knowledgeResetContract = readRecord(contract.knowledgeResetContract);
  const dimensionCompletionContract = readRecord(contract.dimensionCompletionContract);
  const recipeAuthoringRubric = readRecord(contract.recipeAuthoringRubric);
  const recipeGuidanceFloor = readRecord(contract.recipeGuidanceFloor);
  const resumePrompt = readRecord(contract.resumePrompt);
  const submitKnowledgeContract = readRecord(contract.submitKnowledgeContract);
  const fieldFloors = readRecord(submitKnowledgeContract?.fieldFloors);
  const sourceRefCardinality = readRecord(submitKnowledgeContract?.sourceRefCardinality);
  return {
    contractVersion: contract.contractVersion,
    dimensionCompletionContract: dimensionCompletionContract
      ? {
          completionGate: dimensionCompletionContract.completionGate,
          requiredAfterTool: dimensionCompletionContract.requiredAfterTool,
          sessionField: dimensionCompletionContract.sessionField,
          requiredFields: dimensionCompletionContract.requiredFields,
          firstCallExample: dimensionCompletionContract.firstCallExample,
        }
      : undefined,
    knowledgeResetContract: knowledgeResetContract
      ? {
          backupByDefault: knowledgeResetContract.backupByDefault,
          scopes: knowledgeResetContract.scopes,
        }
      : undefined,
    recipeAuthoringRubric: recipeAuthoringRubric
      ? { futureActionability: recipeAuthoringRubric.futureActionability }
      : undefined,
    recipeCreationSop: readStringArray(contract.recipeCreationSop).slice(0, 5),
    recipeGuidanceFloor: recipeGuidanceFloor
      ? { candidateCounts: recipeGuidanceFloor.candidateCounts }
      : undefined,
    resumePrompt: resumePrompt
      ? { bootstrapSessionRefField: resumePrompt.bootstrapSessionRefField }
      : undefined,
    scopeBrief: summarizeScopeBrief(contract.scopeBrief),
    stopConditions: readStringArray(contract.stopConditions).slice(0, 6),
    submitKnowledgeContract: submitKnowledgeContract
      ? {
          exactFields: submitKnowledgeContract.exactFields,
          fieldFloors: {
            category: fieldFloors?.category,
            contentMarkdown: fieldFloors?.contentMarkdown,
            doClause: fieldFloors?.doClause,
            dontClause: fieldFloors?.dontClause,
          },
          purpose: submitKnowledgeContract.purpose,
          sourceRefCardinality: {
            universalRuleOrPattern: sourceRefCardinality?.universalRuleOrPattern,
          },
        }
      : undefined,
    toolCapabilityMatrix: readRecordArray(contract.toolCapabilityMatrix)
      .map((entry) => ({
        name: entry.name,
        status: entry.status,
        provides: entry.provides,
        requiredFor: entry.requiredFor,
      }))
      .slice(0, 12),
  };
}

function summarizeScopeBrief(value: unknown): Record<string, unknown> {
  const scopeBrief = readRecord(value);
  if (!scopeBrief) {
    return {};
  }
  return {
    goal: scopeBrief.goal,
    primaryTools: scopeBrief.primaryTools,
    forbiddenConclusions: readStringArray(scopeBrief.forbiddenConclusions).slice(0, 4),
  };
}

function compactToolCapabilities(value: unknown): unknown {
  const capabilities = readRecord(value);
  if (!capabilities) {
    return value;
  }
  const removedOrBlocked = readRecordArray(capabilities.removedOrBlocked).map(
    compactToolCapabilityEntry
  );
  return {
    canonicalProjectContext: readRecordArray(capabilities.canonicalProjectContext).map(
      compactToolCapabilityEntry
    ),
    ...(removedOrBlocked.length > 0 ? { removedOrBlocked } : {}),
  };
}

function compactToolCapabilityEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    name: entry.name,
    status: entry.status,
    replacementTools: entry.replacementTools,
  };
}

function compactNextAction(action: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: action.tool,
    required: action.required,
    order: action.order,
  };
}

function summarizeAst(value: unknown): unknown {
  const ast = readRecord(value);
  if (!ast) {
    return value;
  }
  return {
    compressionLevel: ast.compressionLevel,
    classCount: readRecordArray(ast.classes).length,
    protocolCount: readRecordArray(ast.protocols).length,
    categoriesCount: Array.isArray(ast.categories) ? ast.categories.length : 0,
  };
}

function summarizeDependencyGraph(value: unknown): unknown {
  const graph = readRecord(value);
  if (!graph) {
    return value;
  }
  return {
    nodeCount: readRecordArray(graph.nodes).length,
    edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
    nodes: readRecordArray(graph.nodes).slice(0, 12),
  };
}

function summarizeGuardFindings(value: unknown): unknown {
  const findings = readRecord(value);
  if (!findings) {
    return value;
  }
  return {
    totalViolations: findings.totalViolations,
    errors: findings.errors,
    warnings: findings.warnings,
    topViolations: readRecordArray(findings.topViolations).slice(0, 5),
  };
}

function summarizeMustCoverModules(value: unknown): unknown {
  const modules = readRecord(value);
  if (!modules) {
    return value;
  }
  return {
    totalLocalPackages: modules.totalLocalPackages,
    instruction: modules.instruction,
    modules: readRecordArray(modules.modules)
      .map((module) => ({
        name: module.name,
        packageName: module.packageName,
        fileCount: module.fileCount,
        inferredRole: module.inferredRole,
      }))
      .slice(0, 20),
  };
}

function summarizePanorama(value: unknown): unknown {
  const panorama = readRecord(value);
  if (!panorama) {
    return value;
  }
  return {
    layers: readRecordArray(panorama.layers).slice(0, 8),
    couplingHotspots: readRecordArray(panorama.couplingHotspots).slice(0, 8),
    cyclicDependencies: readRecordArray(panorama.cyclicDependencies).slice(0, 5),
    knowledgeGaps: readRecordArray(panorama.knowledgeGaps).slice(0, 12),
  };
}

function summarizeSubmissionSchema(value: unknown): unknown {
  const schema = readRecord(value);
  if (!schema) {
    return value;
  }
  return {
    requiredFields: schema.requiredFields,
    topLevelFields: schema.topLevelFields,
    note: 'Full submission schema is available from meta.fullBriefingRef.path when this inline briefing is truncated.',
  };
}

function summarizeMaybePresent(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return {
    available: true,
    note: 'Full language extension details are available from meta.fullBriefingRef.path.',
  };
}

function attachColdStartTrashMessage(
  response: Record<string, unknown> & { message?: string },
  cleanupResult: Awaited<ReturnType<typeof runColdStartCleanup>>
): void {
  const cleanupTrash = cleanupResult.trash;
  if (!cleanupTrash || cleanupTrash.movedItems <= 0) {
    return;
  }
  response.message =
    `⚠️ 原有知识已归档到 .asd/.trash/${baseName(cleanupTrash.folder)}/` +
    `（${cleanupTrash.movedItems} 项，含 DB 快照 ${cleanupTrash.dbSnapshotRows} 行，可恢复）。` +
    `知识库清空后，知识相关工具会从 tools/list 暂时隐藏，直到重建出可用知识。` +
    `${response.message ?? ''}`;
}

/**
 * 可用知识库 + 未确认 rebuild → 拒绝销毁（导出供单测直接验证门禁矩阵）。
 */
export function buildBootstrapRebuildConfirmationBlock(
  knowledge: HostKnowledgeState,
  args?: BootstrapInput
): Record<string, unknown> | null {
  if (!knowledge.usable || args?.rebuild === true) {
    return null;
  }
  return {
    success: false,
    errorCode: 'CODEX_BOOTSTRAP_REBUILD_CONFIRMATION_REQUIRED',
    tool: 'alembic_bootstrap',
    message:
      `当前项目已有可用知识库（DB Recipe ${knowledge.recipeCount} 个、磁盘导出 Recipe ${knowledge.materializedRecipeCount ?? 0} 个、Skill ${knowledge.skillCount} 个、DB 条目 ${knowledge.databaseEntryCount} 条）。` +
      `bootstrap 会把全部现有知识移入 .asd/.trash/<时间戳>/ 并从零重建。` +
      `如需保留 Recipe 并刷新知识，请改用 alembic_rescan；` +
      `确认要重建请显式传入 { "rebuild": true } 重新调用。本次未做任何修改。`,
    data: {
      knowledge: {
        databaseEntryCount: knowledge.databaseEntryCount,
        dbRecipeCount: knowledge.dbRecipeCount,
        materializedRecipeCount: knowledge.materializedRecipeCount,
        recipeCount: knowledge.recipeCount,
        skillCount: knowledge.skillCount,
        usable: knowledge.usable,
      },
      needsUserInput: true,
      nextActions: [
        {
          label: 'Refresh while preserving Recipes',
          reason: 'alembic_rescan keeps reviewed Recipes and rebuilds derived knowledge.',
          tool: 'alembic_rescan',
        },
        {
          arguments: { rebuild: true },
          label: 'Rebuild from zero (destructive, archived to trash)',
          reason: 'Archives ALL existing knowledge to .asd/.trash/<timestamp>/ before rebuilding.',
          tool: 'alembic_bootstrap',
        },
      ],
    },
  };
}

/**
 * MT1 P3-3 一致性：本地工作流在全局选择不一致时照常工作（只动宿主项目
 * 自己的数据根），但必须把 codex_* 门禁所依据的同一事实带回响应，
 * 不允许静默绕过。
 */
function attachLocalSelectionMismatch(
  response: Record<string, unknown>,
  projectRoot: string
): Record<string, unknown> {
  const mismatch = buildLocalSelectionMismatch(projectRoot);
  if (!mismatch) {
    return response;
  }
  const meta =
    response.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
      ? (response.meta as Record<string, unknown>)
      : {};
  response.meta = { ...meta, hostProjectSelectionMismatch: mismatch };
  return response;
}

function baseName(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? value;
}

/**
 * 获取当前 active session（供其他 handler 使用）
 *
 * 当指定了 sessionId 时，如果 active session 已过期但 id 匹配，
 * 仍然返回该 session（支持新 bootstrap 创建后旧 session 的 dimension_complete 继续工作）。
 */
export { getActiveHostAgentWorkflowSession as getActiveSession };

function attachIDEAgentAnalysisSurface<T extends { meta?: Record<string, unknown> }>(
  briefing: T,
  ideAgentAnalysis: ReturnType<typeof buildIDEAgentAnalysisSurface>
): T & { ideAgentAnalysis: typeof ideAgentAnalysis; meta: Record<string, unknown> } {
  return {
    ...briefing,
    ideAgentAnalysis,
    meta: {
      ...(briefing.meta || {}),
      ideAgentAnalysis: {
        packetId: ideAgentAnalysis.packetSummary.packetId,
        profile: ideAgentAnalysis.packetSummary.profile,
        totalUnits: ideAgentAnalysis.progress.totalUnits,
        remainingUnits: ideAgentAnalysis.progress.remainingUnitIds.length,
      },
    },
  };
}

function attachColdStartOnboardingSurface<T extends { meta?: Record<string, unknown> }>(
  input: AttachColdStartOnboardingInput<T>
): T & ColdStartOnboardingContractWithGuidance & { meta: Record<string, unknown> } {
  const onboardingContract = buildColdStartOnboardingContract({
    dataRoot: input.dataRoot,
    dimensions: input.dimensions,
    fileCount: input.fileCount,
    moduleCount: input.moduleCount,
    primaryLanguage: input.primaryLang,
    projectRoot: input.projectRoot,
    projectType: input.projectType,
    secondaryLanguages: input.secondaryLanguages,
    session: input.session,
  });
  const currentDimensionGuidance = buildCurrentDimensionGuidanceFromBriefing(
    input.briefing as Record<string, unknown>
  );
  return attachOnboardingContract(input.briefing, {
    ...onboardingContract,
    currentDimensionGuidance,
    currentDimensionNextActions:
      buildCurrentDimensionNextActionsFromGuidance(currentDimensionGuidance),
  });
}

function attachOnboardingContract<T extends { meta?: Record<string, unknown> }>(
  briefing: T,
  onboardingContract: ColdStartOnboardingContractWithGuidance
): T & ColdStartOnboardingContractWithGuidance & { meta: Record<string, unknown> } {
  return {
    ...briefing,
    ...onboardingContract,
    meta: {
      ...(briefing.meta || {}),
      onboardingContract: {
        contractVersion: 1,
        currentDimensionIds: readGuidanceDimensionIds(onboardingContract.currentDimensionGuidance),
        currentTier: readGuidanceCurrentTier(onboardingContract.currentDimensionGuidance),
      },
    },
  };
}

function attachColdStartCompletenessCriticSurface<
  T extends { currentDimensionGuidance?: unknown; meta?: Record<string, unknown> },
>(
  briefing: T,
  input: {
    dimensions: ReturnType<typeof selectProjectContextDimensions>;
    projectContextAnalysis: Awaited<ReturnType<typeof buildHostAgentProjectContextAnalysis>>;
  }
): T {
  const guidance = readRecord(briefing.currentDimensionGuidance);
  if (!guidance) {
    return briefing;
  }
  const criticByDimension = buildColdStartCompletenessCriticByDimension(input);
  const dimensions = readRecordArray(guidance.dimensions).map((dimension, index) => {
    const dimensionId = readDimensionId(dimension, index);
    const critic = criticByDimension.get(dimensionId);
    return critic
      ? {
          ...dimension,
          completenessCritic: projectCompletenessCriticForAgent(critic, {
            maxGuidance: 1,
            maxHints: 1,
            maxNotes: 1,
            maxSourceRefsPerItem: 2,
          }),
        }
      : dimension;
  });
  return {
    ...briefing,
    currentDimensionGuidance: {
      ...guidance,
      dimensions,
    },
  };
}

function buildCurrentDimensionGuidanceFromBriefing(
  briefing: Record<string, unknown>
): Record<string, unknown> {
  const dimensions = readRecordArray(briefing.dimensions);
  const dimensionById = new Map(
    dimensions
      .map((dimension, index) => [readDimensionId(dimension, index), dimension] as const)
      .filter(([id]) => id.length > 0)
  );
  const executionPlan = isRecord(briefing.executionPlan) ? briefing.executionPlan : {};
  const currentTier = selectCurrentExecutionTier(executionPlan);
  const tierDimensionIds = currentTier ? readTierDimensionIds(currentTier) : [];
  const fallbackDimensionIds = dimensions.map((dimension, index) =>
    readDimensionId(dimension, index)
  );
  const dimensionIds = uniqueStrings(
    tierDimensionIds.length > 0 ? tierDimensionIds : fallbackDimensionIds
  );
  const guidanceDimensions = dimensionIds.map((dimensionId) => {
    const dimension = dimensionById.get(dimensionId) || {};
    return {
      dimensionId,
      title:
        readString(dimension.label) ||
        readString(dimension.title) ||
        readString(dimension.name) ||
        dimensionId,
      tier:
        typeof dimension.tier === 'number' && Number.isFinite(dimension.tier)
          ? dimension.tier
          : null,
      analysisGuide: isRecord(dimension.analysisGuide)
        ? dimension.analysisGuide
        : (dimension.analysisGuide ?? null),
      submissionSpec: isRecord(dimension.submissionSpec)
        ? dimension.submissionSpec
        : (dimension.submissionSpec ?? null),
    };
  });

  return {
    contractVersion: 1,
    source: 'mission-briefing.executionPlan.current-tier',
    currentTier: currentTier
      ? {
          tier: currentTier.tier ?? null,
          label: readString(currentTier.label),
          note: readString(currentTier.note),
          dimensions: readTierDimensionIds(currentTier),
        }
      : null,
    dimensionIds,
    remainingDimensionIds: dimensionIds,
    dimensions: guidanceDimensions,
    completionRule: {
      afterTool: 'alembic_submit_knowledge',
      completionGate: true,
      requiredClosingTool: 'alembic_dimension_complete',
      rule: 'For every dimension in dimensionIds, submit session-bound Recipe ids first, then call alembic_dimension_complete before treating that dimension as complete.',
    },
    nextActions: buildCurrentDimensionActionTemplates(),
    invalidConclusions: [
      'do not infer current work from retired static task queues',
      'do not submit Recipes without exact sourceRefs and graph/detail evidence',
      'do not complete a dimension before session-bound Recipe ids are returned',
      'do not treat a dimension as complete until alembic_dimension_complete succeeds for that dimension',
    ],
    note:
      currentTier && tierDimensionIds.length > 0
        ? 'Current work is projected from executionPlan.tiers[0] and the matching dimensions[].analysisGuide/submissionSpec already present in this briefing.'
        : 'No executionPlan tier was available; use the visible dimensions as a plan-derived fallback and do not invent extra dimensions.',
  };
}

function selectCurrentExecutionTier(
  executionPlan: Record<string, unknown>
): Record<string, unknown> | null {
  const explicitCurrent = isRecord(executionPlan.currentTier) ? executionPlan.currentTier : null;
  if (explicitCurrent) {
    return explicitCurrent;
  }
  const tiers = readRecordArray(executionPlan.tiers);
  return tiers[0] || null;
}

function buildCurrentDimensionActionTemplates(): Array<Record<string, unknown>> {
  return [
    {
      label: 'Orient current plan dimensions',
      reason: 'Use compact ProjectContext orientation before broad raw exploration.',
      tool: 'alembic_recipe_map',
    },
    {
      label: 'Collect source and relationship evidence',
      reason:
        'Use graph/detail refs for caller/callee/ownership/impact claims, then raw-read gaps.',
      tool: 'alembic_graph',
    },
    {
      label: 'Submit source-grounded Recipe candidates',
      reason: 'Submit only after candidates satisfy hostAgentContract.submitKnowledgeContract.',
      required: true,
      tool: 'alembic_submit_knowledge',
    },
    {
      label: 'Complete current dimensions',
      afterTool: 'alembic_submit_knowledge',
      completionGate: true,
      reason:
        'Required per-dimension closing step: use session-bound Recipe ids and analysis evidence for alembic_dimension_complete before marking the dimension complete.',
      required: true,
      tool: 'alembic_dimension_complete',
    },
  ];
}

function buildCurrentDimensionNextActionsFromGuidance(
  guidance: Record<string, unknown>
): Array<Record<string, unknown>> {
  const actions = Array.isArray(guidance.nextActions) ? guidance.nextActions : [];
  return actions
    .filter((action): action is Record<string, unknown> => isRecord(action))
    .map((action, index) => ({
      ...action,
      order: index + 1,
      required: isRequiredCurrentDimensionAction(action, index),
    }));
}

function isRequiredCurrentDimensionAction(action: Record<string, unknown>, index: number): boolean {
  const tool = readString(action.tool);
  return (
    action.required === true ||
    index < 2 ||
    tool === 'alembic_submit_knowledge' ||
    tool === 'alembic_dimension_complete'
  );
}

function readTierDimensionIds(tier: Record<string, unknown>): string[] {
  const dimensionValues = Array.isArray(tier.dimensions)
    ? tier.dimensions
    : Array.isArray(tier.dimensionIds)
      ? tier.dimensionIds
      : [];
  return uniqueStrings(
    dimensionValues
      .map((value, index) =>
        typeof value === 'string' ? value : isRecord(value) ? readDimensionId(value, index) : ''
      )
      .filter((value) => value.length > 0)
  );
}

function readDimensionId(dimension: Record<string, unknown>, index: number): string {
  return (
    readString(dimension.id) ||
    readString(dimension.dimensionId) ||
    readString(dimension.key) ||
    `dimension-${index + 1}`
  );
}

function readGuidanceDimensionIds(guidance: Record<string, unknown>): string[] {
  return Array.isArray(guidance.dimensionIds)
    ? uniqueStrings(
        guidance.dimensionIds.filter((value): value is string => typeof value === 'string')
      )
    : [];
}

function readGuidanceCurrentTier(
  guidance: Record<string, unknown>
): Record<string, unknown> | null {
  return isRecord(guidance.currentTier) ? guidance.currentTier : null;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function appendChecklistItems(value: unknown, additions: string[]): string[] {
  const current =
    typeof value === 'string' && value.trim().length > 0 ? [value] : readStringArray(value);
  return uniqueStrings([...current, ...additions]);
}

function isTransientTransportRef(value: unknown): value is TransientTransportRef {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.bytes === 'number' &&
    Number.isFinite(value.bytes) &&
    value.bytes >= 0
  );
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
