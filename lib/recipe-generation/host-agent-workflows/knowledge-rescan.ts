/**
 * HostAgentKnowledgeRescanWorkflow — 宿主 Agent 增量知识重扫
 *
 * 保留已审核 Recipe，清理衍生缓存，全量/指定维度重新扫描。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   3. ProjectContext 直接读取项目结构/源码/符号事实
 *   4. 构建 Mission Briefing（含 allRecipes + evolutionGuide）
 *   5. 返回给宿主 Agent 按维度执行: evolve → gap-fill → dimension_complete
 */

import { execFile } from 'node:child_process';
import {
  auditRecipesForRescan,
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildKnowledgeRescanPlan,
  buildKnowledgeRescanWorkflowPlan,
  buildProjectContextMissionBriefing,
  buildRescanPrescreen,
  createHostAgentKnowledgeRescanIntent,
  type DimensionDef,
  presentHostAgentKnowledgeRescanEmptyProject,
  presentHostAgentKnowledgeRescanResponse,
  projectHostAgentRescanEvidencePlan,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
} from '@alembic/core/host-agent-workflows';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { buildLocalSelectionMismatch } from '#codex/HostProjectAlignment.js';
import { buildIDEAgentAnalysisSurface } from '#codex/ide-agent/IDEAgentAnalysisSurface.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import {
  FileChangeHandler,
  type UnifiedEvolutionReport,
} from '#recipe-generation/evolution/FileChangeHandler.js';
import {
  GitDiffScanner,
  type GitDiffScanResult,
} from '#recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import { buildPluginOpportunisticEvolutionSurface } from '#recipe-generation/evolution/PluginOpportunisticEvolution.js';
import {
  buildHostAgentProjectContextAnalysis,
  createProjectContextHostAgentSession,
  selectProjectContextDimensions,
} from '#recipe-generation/host-agent-workflows/project-context-analysis.js';
import {
  acquirePlanGenerationLease,
  applyPlanGateToProjectAnalysisIntent,
  attachPlanGenerationGateData,
  type PlanGenerationGateReady,
  resolvePlanGenerationGate,
} from '#recipe-generation/plan-generation-gate.js';
import { attachProjectContextCreationGuide } from '#recipe-generation/project-context-anchoring.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import { rebuildLocalKnowledgeIndexes } from './knowledge-index-rebuild.js';

/** MCP handler context */
interface McpContext {
  container: ServiceContainer;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  startedAt?: number;
  [key: string]: unknown;
}

interface ProjectContextAuditFile {
  filePath: string;
}

interface RescanUnifiedEvolutionCheckpoint {
  head: string | null;
  signature: string | null;
}

interface RescanUnifiedEvolutionResult {
  report: UnifiedEvolutionReport | null;
  routeError: string | null;
  scan: GitDiffScanResult;
  surface: Awaited<ReturnType<typeof buildPluginOpportunisticEvolutionSurface>>;
}

let rescanUnifiedEvolutionCheckpoints: Map<string, RescanUnifiedEvolutionCheckpoint> | null = null;

// ── 主入口 ─────────────────────────────────────────────────

export async function runHostAgentKnowledgeRescanWorkflow(ctx: McpContext, args: RescanInput) {
  const t0 = Date.now();
  const planGate = await resolvePlanGenerationGate(ctx, args, {
    defaultStage: resolveDefaultRescanGenerationStage(args),
    toolName: 'alembic_rescan',
  });
  if (!planGate.ok) {
    return planGate.response;
  }
  const lease = acquirePlanGenerationLease({
    gate: planGate.value,
    idempotencyKey: args.rescanId,
    toolName: 'alembic_rescan',
  });
  if (!lease.ok) {
    return lease.response;
  }

  try {
    const state = await prepareRescanState(ctx, args, planGate.value);

    // 空项目 fast-path
    if (state.projectContextAnalysis.isEmpty) {
      const response = attachPlanGenerationGateData(
        presentHostAgentKnowledgeRescanEmptyProject({
          responseTimeMs: Date.now() - t0,
        }) as Record<string, unknown> & { meta?: Record<string, unknown> },
        state.planGate
      );
      attachHostProjectSelectionMismatch(response, state.projectRoot);
      return response;
    }

    return buildRescanResponse(ctx, state, Date.now() - t0);
  } finally {
    lease.lease.release();
  }
}

async function prepareRescanState(
  ctx: McpContext,
  args: RescanInput,
  planGate: PlanGenerationGateReady
) {
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const db = ctx.container.get('database');
  const intent = createHostAgentKnowledgeRescanIntent({
    ...args,
    contentMaxLines: planGate.scale.contentMaxLines,
    dimensions: planGate.dimensionIds,
    force: planGate.cleanupPolicy === 'force-rescan',
    maxFiles: planGate.scale.maxFiles,
  });
  applyPlanGateToProjectAnalysisIntent(intent, planGate);
  intent.cleanupPolicy =
    planGate.cleanupPolicy === 'full-reset' ? 'rescan-clean' : planGate.cleanupPolicy;
  intent.analysisMode = planGate.cleanupPolicy === 'force-rescan' ? 'full' : 'incremental';
  const plan = buildKnowledgeRescanWorkflowPlan({ intent, projectRoot, dataRoot });
  const { cleanResult, recipeSnapshot } = await runRescanCleanup({
    dataRoot,
    db,
    intent,
    logger: ctx.logger,
    plan,
  });

  ctx.logger.info(`[Rescan] Preserved ${recipeSnapshot.count} recipes`, {
    cleanupPolicy: intent.cleanupPolicy,
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  if (intent.cleanupPolicy !== 'none') {
    await rebuildRescanIndexes(ctx, db);
  }

  const projectContextAnalysis = await buildHostAgentProjectContextAnalysis({
    maxFiles: plan.projectAnalysis.scan.maxFiles,
    moduleScope: planGate.moduleScope,
    projectRoot: plan.projectAnalysis.projectRoot,
    source: 'codex-host-rescan',
  });
  const unifiedEvolution = await runRescanUnifiedEvolution(ctx, {
    planGate,
    projectRoot,
  });

  return {
    cleanResult,
    dataRoot,
    db,
    intent,
    plan,
    planGate,
    projectContextAnalysis,
    projectRoot,
    recipeSnapshot,
    unifiedEvolution,
  };
}

async function runRescanCleanup(input: {
  dataRoot: string;
  db: unknown;
  intent: ReturnType<typeof createHostAgentKnowledgeRescanIntent>;
  logger: McpContext['logger'];
  plan: ReturnType<typeof buildKnowledgeRescanWorkflowPlan>;
}) {
  if (input.intent.cleanupPolicy === 'force-rescan') {
    return runForceRescanCleanPolicy({
      projectRoot: input.plan.cleanup.projectRoot,
      dataRoot: input.dataRoot,
      db: input.db,
      logger: input.logger,
      createCleanupService: createWorkflowCleanupService,
    });
  }
  if (input.intent.cleanupPolicy === 'rescan-clean') {
    return runRescanCleanPolicy({
      projectRoot: input.plan.cleanup.projectRoot,
      dataRoot: input.dataRoot,
      db: input.db,
      logger: input.logger,
      createCleanupService: createWorkflowCleanupService,
    });
  }

  const cleanupService = createWorkflowCleanupService({
    projectRoot: input.plan.cleanup.projectRoot,
    dataRoot: input.dataRoot,
    db: input.db,
    logger: input.logger,
  });
  const recipeSnapshot = await cleanupService.snapshotRecipes();
  return {
    cleanResult: {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: recipeSnapshot.count,
      errors: [],
    },
    recipeSnapshot,
  };
}

async function rebuildRescanIndexes(ctx: McpContext, db: unknown) {
  // 恢复 Recipe 文件 ↔ DB ↔ source-ref 桥接 ↔ semantic-region vectors。
  // rescanClean 保留 recipes/ 和 active/published/staging/evolving DB 记录，
  // 但可能清除派生桥接表；这里显式 reconcile source refs，再重建 region vectors。
  await rebuildLocalKnowledgeIndexes({
    container: ctx.container,
    db,
    logger: ctx.logger,
    logPrefix: 'Rescan',
  });
}

async function buildRescanResponse(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  responseTimeMs: number
) {
  const planning = await buildRescanPlanning(ctx, state);
  const briefing = buildRescanBriefing(ctx, state, planning);
  const response = presentHostAgentKnowledgeRescanResponse({
    recipeSnapshot: state.recipeSnapshot,
    cleanResult: state.cleanResult,
    auditSummary: planning.auditSummary,
    briefing,
    evidencePlan: planning.evidencePlan,
    dimensions: planning.requestedDimensions,
    reason: state.intent.reason,
    responseTimeMs,
  }) as Record<string, unknown> & { message?: string; meta?: Record<string, unknown> };

  attachPlanGenerationGateData(response, state.planGate);
  attachRescanUnifiedEvolution(response, state.unifiedEvolution);
  attachTrashArchiveMessage(response, state.cleanResult);
  attachHostProjectSelectionMismatch(response, state.projectRoot);
  return response;
}

function resolveDefaultRescanGenerationStage(args: RescanInput): 'deepMining' | 'moduleMining' {
  if (args.generationStage === 'moduleMining' || (args.moduleScope?.length ?? 0) > 0) {
    return 'moduleMining';
  }
  return 'deepMining';
}

async function buildRescanPlanning(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>
) {
  const auditSummary = await auditRecipesForRescan({
    container: ctx.container,
    logger: ctx.logger,
    recipeEntries: state.recipeSnapshot.entries,
    allFiles: projectContextFilesForRescanAudit(state.projectContextAnalysis.presenterInput.files),
    projectRoot: state.projectRoot,
  });

  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: state.recipeSnapshot.entries,
    auditSummary,
    dimensions: state.projectContextAnalysis.dimensions as DimensionDef[],
    requestedDimensionIds: state.intent.dimensionIds,
  });
  const dimensions = selectProjectContextDimensions(
    knowledgeRescanPlan.executionDimensions,
    state.intent.dimensionIds
  );
  const requestedDimensions = knowledgeRescanPlan.requestedDimensions;
  const prescreen = buildRescanPrescreen(auditSummary, state.recipeSnapshot.entries, dimensions);
  const evidencePlan = projectHostAgentRescanEvidencePlan(knowledgeRescanPlan);

  ctx.logger.info('[Rescan] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });
  ctx.logger.info('[Rescan] Execution reasons', {
    executionDimensions: knowledgeRescanPlan.executionDimensions.length,
    produceDimensions: knowledgeRescanPlan.produceDimensions.length,
    reasons: knowledgeRescanPlan.executionReasons,
  });

  return {
    auditSummary,
    dimensions,
    evidencePlan,
    prescreen,
    requestedDimensions,
  };
}

function buildRescanBriefing(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  planning: Awaited<ReturnType<typeof buildRescanPlanning>>
) {
  const dimensions = planning.dimensions;
  const projectContextAnalysis = state.projectContextAnalysis;
  const session = createProjectContextHostAgentSession({
    container: ctx.container,
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    fileCount: projectContextAnalysis.fileCount,
    moduleCount: projectContextAnalysis.moduleCount,
    primaryLang: projectContextAnalysis.primaryLang,
    projectRoot: state.projectRoot,
  });

  const briefing = buildProjectContextMissionBriefing({
    activeDimensions: Array.isArray(dimensions) ? dimensions : [],
    projectContext: projectContextAnalysis.presenterInput,
    profile: 'rescan-host-agent',
    rescan: { evidencePlan: planning.evidencePlan, prescreen: planning.prescreen },
    session,
  });
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromProjectContext({
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    options: {
      profile: 'rescan',
      projectRoot: state.projectRoot,
    },
    projectContext: projectContextAnalysis.presenterInput,
  });
  const ideAgentAnalysis = buildIDEAgentAnalysisSurface(ideAgentPacket);
  const briefingWithIdeAgentSurface = attachIDEAgentAnalysisSurface(
    briefing as Record<string, unknown>,
    ideAgentAnalysis
  );
  briefingWithIdeAgentSurface.meta.projectContextDirectSwitch = {
    moduleSeedCount: projectContextAnalysis.moduleSeeds.length,
    requestKinds: projectContextAnalysis.requestKinds,
  };
  const briefingWithProjectContextGuide = attachProjectContextCreationGuide(
    briefingWithIdeAgentSurface,
    {
      dimensionIds: (Array.isArray(dimensions) ? dimensions : []).map((dimension) => dimension.id),
      generationStage: state.planGate.generationStage,
      moduleScope: state.planGate.moduleScope,
      projectRoot: state.projectRoot,
      stage: 'rescan',
      testMode: state.planGate.testMode,
    }
  );
  logRescanBriefingReady(ctx, state, planning, session.id, ideAgentAnalysis.progress.totalUnits);
  return briefingWithProjectContextGuide;
}

async function runRescanUnifiedEvolution(
  ctx: McpContext,
  input: {
    planGate: PlanGenerationGateReady;
    projectRoot: string;
  }
): Promise<RescanUnifiedEvolutionResult> {
  const checkpointKey = input.projectRoot;
  const checkpoints = getRescanUnifiedEvolutionCheckpoints();
  const checkpoint = checkpoints.get(checkpointKey) ?? null;
  const previousHead =
    checkpoint?.head ??
    (await resolveInitialRescanEvolutionPreviousHead(input.projectRoot, input.planGate));
  const scanner = new GitDiffScanner({ projectRoot: input.projectRoot });
  const scan = await scanner.scanOnce(Date.now(), { previousHead });
  let report: UnifiedEvolutionReport | null = null;
  let routeError: string | null = null;

  if (shouldRouteRescanUnifiedEvolution(scan)) {
    const handler = createRescanUnifiedEvolutionHandler(ctx, input.projectRoot);
    if (handler) {
      try {
        report = await handler.handleFileChanges(scan.events);
      } catch (error: unknown) {
        routeError = error instanceof Error ? error.message : String(error);
      }
    } else {
      routeError = 'Core unified evolution services are unavailable in the rescan MCP container';
    }
  }

  if (scan.scanned) {
    checkpoints.set(checkpointKey, {
      head: scan.head,
      signature: scan.signature,
    });
  }

  const serviceGateReason =
    'alembic_rescan public workflow owns Plugin commit-driven unified evolution routing for this rescan response.';
  const surface = await buildPluginOpportunisticEvolutionSurface({
    projectRoot: input.projectRoot,
    scan,
    serviceGate: {
      mainServiceCanHandleProjectScope: false,
      residentProjectScopeAvailable: false,
      reason: routeError
        ? `${serviceGateReason} Routing did not complete: ${routeError}.`
        : serviceGateReason,
    },
    toolOutcome: {
      reason: 'alembic_rescan completed',
      success: true,
      tool: 'alembic_rescan',
    },
    unifiedEvolution: report,
  });

  return { report, routeError, scan, surface };
}

function attachRescanUnifiedEvolution(
  response: Record<string, unknown>,
  unifiedEvolution: RescanUnifiedEvolutionResult
): void {
  const data =
    response.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : {};
  response.data = data;
  const attach = (target: Record<string, unknown>) => {
    target.unifiedEvolution = unifiedEvolution.surface;
    if (unifiedEvolution.surface.gitDiffEvidence) {
      target.gitDiffEvidence = unifiedEvolution.surface.gitDiffEvidence;
    }
    if (!unifiedEvolution.surface.unifiedEvolution) {
      return;
    }
    const evolution = unifiedEvolution.surface.unifiedEvolution;
    target.evolution = evolution;
    target.pendingProposals = evolution.pendingProposals;
    target.proposals = evolution.pendingProposals;
    target.generationChangeLog = evolution.generationChangeLog;
    target.recommendations = evolution.recommendations;
  };
  attach(response);
  attach(data);
}

function shouldRouteRescanUnifiedEvolution(scan: GitDiffScanResult): boolean {
  if (!scan.scanned || scan.events.length === 0 || scan.truncated) {
    return false;
  }
  if (scan.headChanged && scan.headRangeStatus !== 'ancestor') {
    return false;
  }
  return true;
}

function createRescanUnifiedEvolutionHandler(
  ctx: McpContext,
  projectRoot: string
): FileChangeHandler | null {
  const sourceRefRepository = safeContainerGet(ctx, 'recipeSourceRefRepository');
  const knowledgeRepository = safeContainerGet(ctx, 'knowledgeRepository');
  if (
    !hasFunctions(sourceRefRepository, ['findByRecipeId', 'findBySourcePath', 'replaceSourcePath'])
  ) {
    return null;
  }
  if (!hasFunctions(knowledgeRepository, ['findById'])) {
    return null;
  }
  const contentPatcher = safeContainerGet(ctx, 'contentPatcher');
  const evolutionGateway = safeContainerGet(ctx, 'evolutionGateway');
  const recipeFreshnessService = safeContainerGet(ctx, 'recipeFreshnessService');
  const signalBus = safeContainerGet(ctx, 'signalBus');
  return new FileChangeHandler(
    sourceRefRepository as never,
    knowledgeRepository as never,
    contentPatcher,
    {
      evolutionGateway: hasFunctions(evolutionGateway, ['submit'])
        ? (evolutionGateway as never)
        : null,
      projectRoot,
      recipeFreshnessService: hasFunctions(recipeFreshnessService, ['refreshRecipes'])
        ? (recipeFreshnessService as never)
        : null,
      signalBus: hasFunctions(signalBus, ['send']) ? (signalBus as never) : null,
    }
  );
}

async function resolveInitialRescanEvolutionPreviousHead(
  projectRoot: string,
  planGate: PlanGenerationGateReady
): Promise<string | null> {
  const currentHead = await gitRevParse(projectRoot, 'HEAD');
  const planCommit = readString(planGate.plan, 'lastUpdatedFromCommit');
  if (currentHead && planCommit && planCommit !== currentHead) {
    return planCommit;
  }
  return await gitRevParse(projectRoot, 'HEAD^');
}

function gitRevParse(projectRoot: string, revision: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--verify', revision],
      { cwd: projectRoot, encoding: 'utf8', timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value.length > 0 ? value : null);
      }
    );
  });
}

function getRescanUnifiedEvolutionCheckpoints(): Map<string, RescanUnifiedEvolutionCheckpoint> {
  if (rescanUnifiedEvolutionCheckpoints === null) {
    rescanUnifiedEvolutionCheckpoints = new Map();
  }
  return rescanUnifiedEvolutionCheckpoints;
}

function safeContainerGet(ctx: McpContext, serviceName: string): unknown {
  try {
    return ctx.container.get(serviceName);
  } catch {
    return null;
  }
}

function hasFunctions(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

function logRescanBriefingReady(
  ctx: McpContext,
  state: Awaited<ReturnType<typeof prepareRescanState>>,
  planning: Awaited<ReturnType<typeof buildRescanPlanning>>,
  sessionId: string,
  ideUnitCount: number
) {
  const dimGapLog = planning.evidencePlan.dimensionGaps
    .map(
      (dimensionGap) =>
        `${dimensionGap.dimensionId}(${dimensionGap.existingCount}→gap ${dimensionGap.gap}, mode ${dimensionGap.executionMode}, budget ${dimensionGap.createBudget})`
    )
    .join(', ');
  ctx.logger.info(
    `[Rescan] ProjectContext Mission Briefing ready: ${state.projectContextAnalysis.fileCount} files, ${
      Array.isArray(planning.dimensions) ? planning.dimensions.length : 0
    } dims, ` +
      `preserved: ${state.recipeSnapshot.count}, decayed: ${planning.evidencePlan.decayCount}, totalGap: ${planning.evidencePlan.totalGap}, ` +
      `ideUnits: ${ideUnitCount} — session ${sessionId}`
  );
  ctx.logger.info(`[Rescan] Dimension gaps: ${dimGapLog}`);
}

function attachTrashArchiveMessage(
  response: Record<string, unknown> & { message?: string },
  cleanResult: Awaited<ReturnType<CleanupService['rescanClean']>>
) {
  if (cleanResult.trash && cleanResult.trash.movedItems > 0) {
    response.message =
      `📦 已清理的 candidates/wiki 投影归档到 .asd/.trash/${cleanResult.trash.folder.split(/[\\/]/).filter(Boolean).pop()}/` +
      `（${cleanResult.trash.movedItems} 项，可恢复）。${response.message ?? ''}`;
  }
}

function attachHostProjectSelectionMismatch(
  response: Record<string, unknown> & { meta?: Record<string, unknown> },
  projectRoot: string
) {
  const mismatch = buildLocalSelectionMismatch(projectRoot);
  if (mismatch) {
    response.meta = { ...(response.meta ?? {}), hostProjectSelectionMismatch: mismatch };
  }
}

function attachIDEAgentAnalysisSurface(
  briefing: Record<string, unknown>,
  ideAgentAnalysis: ReturnType<typeof buildIDEAgentAnalysisSurface>
): Record<string, unknown> & {
  ideAgentAnalysis: ReturnType<typeof buildIDEAgentAnalysisSurface>;
  meta: Record<string, unknown>;
} {
  const meta =
    briefing.meta && typeof briefing.meta === 'object' && !Array.isArray(briefing.meta)
      ? (briefing.meta as Record<string, unknown>)
      : {};
  return {
    ...briefing,
    ideAgentAnalysis,
    meta: {
      ...meta,
      ideAgentAnalysis: {
        packetId: ideAgentAnalysis.packetSummary.packetId,
        profile: ideAgentAnalysis.packetSummary.profile,
        totalUnits: ideAgentAnalysis.progress.totalUnits,
        remainingUnits: ideAgentAnalysis.progress.remainingUnitIds.length,
      },
    },
  };
}

function createWorkflowCleanupService(ctx: {
  projectRoot: string;
  dataRoot?: string;
  db?: unknown;
  logger?: ConstructorParameters<typeof CleanupService>[0]['logger'];
}) {
  return new CleanupService({
    projectRoot: ctx.projectRoot,
    dataRoot: ctx.dataRoot,
    db: ctx.db,
    logger: ctx.logger,
  });
}

function projectContextFilesForRescanAudit(files: readonly ProjectContextAuditFile[]): Array<{
  name: string;
  path?: string;
  relativePath?: string;
}> {
  return files.map((file) => ({
    name: file.filePath.split(/[\\/]/).filter(Boolean).pop() ?? file.filePath,
    path: file.filePath,
    relativePath: file.filePath,
  }));
}

function readString(record: unknown, key: string): string | undefined {
  const value =
    record && typeof record === 'object' && !Array.isArray(record)
      ? (record as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
