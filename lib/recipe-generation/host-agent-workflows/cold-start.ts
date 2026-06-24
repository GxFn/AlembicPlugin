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
  const response = buildColdStartMissionBriefingResponse(ctx, {
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

function buildColdStartMissionBriefingResponse(
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
): Record<string, unknown> & { message?: string } {
  const session = createProjectContextHostAgentSession({
    container: ctx.container,
    dimensions: input.briefingDimensions,
    fileCount: input.projectContextAnalysis.fileCount,
    moduleCount: input.projectContextAnalysis.moduleCount,
    primaryLang: input.projectContextAnalysis.primaryLang,
    projectRoot: input.projectRoot,
  });
  const briefing = buildColdStartMissionBriefing(ctx, input, session);
  const response = attachPlanGenerationGateData(
    presentHostAgentColdStartResponse({
      cleanupResult: input.cleanupResult,
      briefing,
      dimensionCount: input.briefingDimensions.length,
      responseTimeMs: input.responseTimeMs,
    }) as Record<string, unknown> & { message?: string },
    input.planGate
  );
  attachColdStartTrashMessage(response, input.cleanupResult);
  return response;
}

function buildColdStartMissionBriefing(
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
  const briefing = buildProjectContextMissionBriefing({
    activeDimensions: input.briefingDimensions,
    projectContext: input.projectContextAnalysis.presenterInput,
    profile: 'cold-start-host-agent',
    session,
  });
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
  briefingWithOnboardingContract.meta.projectContextDirectSwitch = {
    moduleSeedCount: input.projectContextAnalysis.moduleSeeds.length,
    requestKinds: input.projectContextAnalysis.requestKinds,
  };
  const briefingWithProjectContextGuide = attachProjectContextCreationGuide(
    briefingWithOnboardingContract,
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
      `当前项目已有可用知识库（Recipe ${knowledge.recipeCount} 个、Skill ${knowledge.skillCount} 个、DB 条目 ${knowledge.databaseEntryCount} 条）。` +
      `bootstrap 会把全部现有知识移入 .asd/.trash/<时间戳>/ 并从零重建。` +
      `如需保留 Recipe 并刷新知识，请改用 alembic_rescan；` +
      `确认要重建请显式传入 { "rebuild": true } 重新调用。本次未做任何修改。`,
    data: {
      knowledge: {
        databaseEntryCount: knowledge.databaseEntryCount,
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
): T & ReturnType<typeof buildColdStartOnboardingContract> & { meta: Record<string, unknown> } {
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
  return attachOnboardingContract(input.briefing, onboardingContract);
}

function attachOnboardingContract<T extends { meta?: Record<string, unknown> }>(
  briefing: T,
  onboardingContract: ReturnType<typeof buildColdStartOnboardingContract>
): T & ReturnType<typeof buildColdStartOnboardingContract> & { meta: Record<string, unknown> } {
  return {
    ...briefing,
    ...onboardingContract,
    meta: {
      ...(briefing.meta || {}),
      onboardingContract: {
        contractVersion: 1,
        currentDomainId: onboardingContract.progress.currentDomainId,
        stagedDomainCount: onboardingContract.domainQueue.length,
      },
    },
  };
}
