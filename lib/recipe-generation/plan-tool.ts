import path, { basename } from 'node:path';
import {
  buildDimensionCatalogPayload,
  type DimensionCatalogPayloadItem,
  type ProjectLanguageFrameworkFacts,
} from '@alembic/core/dimensions';
import {
  baseDimensions,
  type DimensionDef,
  resolveModuleTier,
  resolvePerCellTargetDefault,
} from '@alembic/core/host-agent-workflows';
import type { PlanIntent, PlanStageId } from '@alembic/core/plans';
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
import type {
  CoverageLedgerRecord,
  EvolutionCoverageLedgerRepository,
} from '@alembic/core/repositories';
import {
  loadProjectScopeForFolder,
  type ProjectDescriptor,
  type ProjectFolderDescriptor,
  readProjectScopeRegistryDocument,
} from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import type { PlanInput } from '#shared/schemas/mcp-tools.js';
import {
  removeTransientTransportIfPresent,
  writeTransientTransport,
} from '@alembic/core/service/planFacts';
import { confirmPlan } from './plan-confirm.js';
import {
  attachSourceFilesToProjectContextModuleSeeds,
  collectProjectSourceFileFacts,
  type ProjectSourceFileFact,
} from '@alembic/core/service/planFacts';

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
  sourceFileFacts: ProjectSourceFileFact[];
  understandingGaps: Record<string, unknown>[];
}

interface PlanProjectScopeContext {
  displayName: string;
  projectId?: string;
  repoDisplayName: string;
  repoProjectRoot: string;
  repoSourceFolder?: string;
  scanBase: string;
  sourceFolders?: string[];
}

interface PlanProjectScopeFolderSelection {
  folder: ProjectFolderDescriptor;
  sourceFolder: string;
}

interface CandidateDimension {
  id: string;
  label: string;
  languageApplicable: boolean;
  layer: DimensionCatalogPayloadItem['layer'];
  miningGuidance: string;
}

type ProjectInfoDeliveredDepth = 'modules' | 'files' | 'symbols';

interface ProjectInfoTreeMeta {
  budgetBytes: number;
  deliveredDepth: ProjectInfoDeliveredDepth;
  fullTreeRef: ProjectInfoFullTreeRef | null;
  omitted: {
    files?: number;
    modules?: number;
    symbols?: number;
  };
  truncated: boolean;
}

interface ProjectInfoFullTreeRef {
  bytes: number;
  path: string;
}

interface ProjectInfoTreeRoot {
  children: ProjectInfoModuleNode[];
  fileCount: number;
  frameworks: string[];
  kind: 'project';
  meta: ProjectInfoTreeMeta;
  moduleCount: number;
  primaryLanguage: string;
  projectType: string;
  secondaryLanguages: string[];
}

interface ProjectInfoModuleNode {
  children: ProjectInfoFileNode[];
  fileCount: number;
  keyDependencies: string[];
  kind: 'module' | 'package';
  language: string;
  path: string;
  role?: string;
}

interface ProjectInfoFileNode {
  children: ProjectInfoSymbolNode[];
  kind: 'file';
  language: string;
  lineCount: number;
  path: string;
}

interface ProjectInfoSymbolNode {
  children: [];
  exported?: boolean;
  filePath: string;
  kind: 'symbol';
  name: string;
  signature?: string;
}

interface ProjectInfoModuleCandidate extends Omit<ProjectInfoModuleNode, 'children'> {
  files: ProjectInfoFileCandidate[];
}

interface ProjectInfoFileCandidate extends Omit<ProjectInfoFileNode, 'children'> {
  symbols: ProjectInfoSymbolNode[];
}

interface ModuleSnapshot {
  files: string[];
  fingerprint: string;
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  role?: string;
}

type PlanArgs = PlanInput;

/** U2b：deepMining 草稿向 Agent 暴露的覆盖账本「信号」（gap 候选 + 现存计数 + 评级 + 单轮上限）。 */
interface CoverageSeedGapCandidate {
  moduleId: string;
  moduleName?: string;
  dimensionId: string;
  grade: CoverageLedgerRecord['grade'];
  coveredCount: number;
  totalCandidateCount: number;
  valueScore: number;
  /** 距 perCellTarget 的缺口（advisory，供 Agent 参考；非强制目标）。 */
  suggestedDeficit: number;
}

interface CoverageSeedRatingByDimension {
  empty: number;
  thin: number;
  partial: number;
  covered: number;
}

interface CoverageSeed {
  /** 价值降序的空白/单薄 cell（已排除 exhausted-with-reason 格），已按 D2 单轮上限截断。 */
  gapCandidates: CoverageSeedGapCandidate[];
  /** 每维已覆盖 recipe 计数（账本 coveredCount 求和）。 */
  existingCountByDimension: Record<string, number>;
  /** 每维 cell 评级分布（empty/thin/partial/covered 计数）。 */
  ratingByDimension: Record<string, CoverageSeedRatingByDimension>;
  /** D2 单轮 cell 上限（按 tier）。 */
  perRoundCellBudget: number;
  tier: 'S' | 'M' | 'L';
}

interface PlanDraftContext {
  analysis: PlanProjectContextAnalysis;
  projectRoot: string;
  projectInfoTree: ProjectInfoTreeRoot;
  candidateDimensions: CandidateDimension[];
  // U2b：deepMining 草稿才有的覆盖账本信号；coldStart/moduleMining 留 undefined（coldStart 仍从零）。
  coverageSeed?: CoverageSeed;
  // U2b：把请求的 generationStage 透传进来，让 confirm next-action 不再硬编码 coldStart。
  requestedStage?: PlanStageId;
}

const PLAN_TOOL_NAME = 'alembic_plan';
const DEFAULT_PROJECT_INFO_TREE_BUDGET_BYTES = 12 * 1024;

// D2 perRoundCellBudget —— 单轮 cell 上限，防止 deepMining 单轮预算爆炸；
// 这是 plan 编排侧的 cell 数上限，与 Core 的 K/maxRounds 停止条件正交（一个限「本轮喂多少格」，
// 一个限「该不该再扫一轮」）。按 canonical 模块规模 tier 取值。
const D2_PER_ROUND_CELL_BUDGET = { S: 50, M: 60, L: 80 } as const;

/**
 * U2b（纯函数，可独立单测）：从账本 cells 构建 deepMining 草稿的覆盖信号。
 *
 * gapCandidates = grade∈{empty,thin} 且非（exhausted && 有 reason）的 cell，按 valueScore 降序，
 * 再按 D2[tier] 单轮上限截断。每项带 suggestedDeficit=max(0, perCellTarget−coveredCount)。
 * 另产出 existingCountByDimension（每维 coveredCount 求和）与 ratingByDimension（每维评级分布）。
 *
 * no-guess：这些只是 SIGNAL，最终扫哪些 cell / 预算多少由 Agent confirm 决定。
 */
export function buildCoverageSeedFromCells(
  cells: readonly CoverageLedgerRecord[],
  options: { moduleCount: number }
): CoverageSeed {
  const tier = resolveModuleTier(options.moduleCount);
  const perCellTarget = resolvePerCellTargetDefault(tier);
  const perRoundCellBudget = D2_PER_ROUND_CELL_BUDGET[tier];

  // 每维已覆盖计数 + 评级分布（遍历全量 cells，无论是否进 gapCandidates）。
  const existingCountByDimension: Record<string, number> = {};
  const ratingByDimension: Record<string, CoverageSeedRatingByDimension> = {};
  for (const cell of cells) {
    existingCountByDimension[cell.dimensionId] =
      (existingCountByDimension[cell.dimensionId] ?? 0) + cell.coveredCount;
    const rating =
      ratingByDimension[cell.dimensionId] ??
      (ratingByDimension[cell.dimensionId] = { empty: 0, thin: 0, partial: 0, covered: 0 });
    rating[cell.grade] += 1;
  }

  // gap 候选：只取空白/单薄；排除 Agent 已声明尽力（exhausted+reason）的格——那是「已尽」不是「缺口」。
  const gapCandidates: CoverageSeedGapCandidate[] = cells
    .filter((cell) => {
      const isGapGrade = cell.grade === 'empty' || cell.grade === 'thin';
      const exhaustedWithReason =
        cell.exhausted === true &&
        typeof cell.exhaustedReason === 'string' &&
        cell.exhaustedReason.trim().length > 0;
      return isGapGrade && !exhaustedWithReason;
    })
    .map((cell) => ({
      // CoverageLedgerRecord 不带 moduleName（只有 moduleId/dimensionId 轴），故 gap 候选只透传 moduleId。
      moduleId: cell.moduleId,
      dimensionId: cell.dimensionId,
      grade: cell.grade,
      coveredCount: cell.coveredCount,
      totalCandidateCount: cell.totalCandidateCount,
      valueScore: cell.valueScore ?? 0,
      suggestedDeficit: Math.max(0, perCellTarget - cell.coveredCount),
    }))
    // 价值降序：高价值空白排前，供 Agent 优先考虑。
    .sort((left, right) => right.valueScore - left.valueScore)
    // D2 单轮上限截断（防预算爆炸）。
    .slice(0, perRoundCellBudget);

  return {
    gapCandidates,
    existingCountByDimension,
    ratingByDimension,
    perRoundCellBudget,
    tier,
  };
}

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
      return blocked(
        'PLAN_GET_REMOVED',
        'alembic_plan get was removed with the stateless planSelection contract; run draft and confirm for each generation stage.',
        {
          operation: 'get',
          projectRoot: resolvePlanProjectRoot(ctx, args),
          nextActions: buildStatelessPlanNextActions(resolvePlanProjectRoot(ctx, args)),
        }
      );
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
  return planDraftResponse(draftContext);
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
  const budgetBytes = resolveProjectInfoTreeBudgetBytes(args);
  const projectInfoTree = buildProjectInfoTree(analysis, budgetBytes);
  await attachFullProjectInfoTreeRefIfNeeded(projectInfoTree, {
    analysis,
    projectRoot,
  });
  // U2b：deepMining 草稿每次都「重新读」账本生成覆盖信号；coldStart/moduleMining 不读（coldStart 仍从零）。
  // RED LINE 1：plan 仍是无状态 draft→confirm，账本只是被读取的覆盖状态，绝不把 plan 持久化。
  const coverageSeed =
    args.generationStage === 'deepMining'
      ? loadDeepMiningCoverageSeed(ctx, projectRoot, analysis.moduleCount)
      : undefined;
  return {
    analysis,
    projectRoot,
    projectInfoTree,
    candidateDimensions: buildCandidateDimensions(analysis),
    ...(coverageSeed ? { coverageSeed } : {}),
    // requestedStage 透传：confirm next-action 据此回填 generationStage（不再硬编码 coldStart）。
    ...(args.generationStage ? { requestedStage: args.generationStage } : {}),
  };
}

/**
 * U2b：读账本 → 覆盖信号（best-effort）。账本不可用或读失败 → 返回 undefined（草稿仍可工作，只是没信号）。
 * RED LINE 1：这是「每次草稿重新读」，无任何 plan/session 持久化。
 */
function loadDeepMiningCoverageSeed(
  ctx: PlanToolContext,
  projectRoot: string,
  moduleCount: number
): CoverageSeed | undefined {
  try {
    const coverageLedgerRepository = ctx.container.get('coverageLedgerRepository') as
      | EvolutionCoverageLedgerRepository
      | undefined;
    if (!coverageLedgerRepository) {
      return undefined;
    }
    const cells = coverageLedgerRepository.listByProjectRoot(projectRoot);
    if (cells.length === 0) {
      // 账本空（尚未跑过 coldStart/dimension_complete）→ 无信号；deepMining 草稿照常返回项目事实。
      return undefined;
    }
    return buildCoverageSeedFromCells(cells, { moduleCount });
  } catch (_err: unknown) {
    // 读账本失败绝不影响草稿：吞掉异常、返回 undefined（草稿仍输出 projectInfoTree/candidateDimensions）。
    return undefined;
  }
}

function buildCandidateDimensions(analysis: PlanProjectContextAnalysis): CandidateDimension[] {
  const facts = buildProjectLanguageFrameworkFacts(analysis);
  return buildDimensionCatalogPayload(facts).map((dimension) => ({
    id: dimension.id,
    label: dimension.label,
    languageApplicable: dimension.languageApplicable,
    layer: dimension.layer,
    miningGuidance: dimension.extractionGuide,
  }));
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

function planDraftResponse(draftContext: PlanDraftContext): PlanToolResponse {
  return {
    success: true,
    message: 'Stateless Plan draft is ready for Agent confirmation.',
    data: {
      operation: 'draft',
      projectRoot: draftContext.projectRoot,
      projectInfoTree: draftContext.projectInfoTree,
      candidateDimensions: draftContext.candidateDimensions,
      agentDecisionChecklist: buildAgentDecisionChecklist(),
      // U2b：deepMining 草稿带覆盖信号（gap 候选/现存计数/评级/单轮上限）。no-guess：是 SIGNAL，由 Agent 决定。
      ...(draftContext.coverageSeed ? { coverageSeed: draftContext.coverageSeed } : {}),
      nextActions: [buildDraftConfirmNextAction(draftContext)],
    },
  };
}

function buildDraftConfirmNextAction(draftContext: PlanDraftContext): Record<string, unknown> {
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
      // U2b：generationStage 不再硬编码 coldStart。有覆盖信号 → deepMining；否则回退请求的 stage，再退 coldStart。
      // （coverageSeed 仅 deepMining 草稿才有，故它在场即等价于 deepMining。）
      generationStage: draftContext.coverageSeed
        ? 'deepMining'
        : (draftContext.requestedStage ?? 'coldStart'),
      projectProfile: buildProjectProfileFromAnalysis(draftContext.analysis),
    },
  };
}

function buildAgentDecisionChecklist(): string[] {
  return [
    'Pick dimensions from candidateDimensions; do not infer hidden recommended or skipped dimensions.',
    'Choose one generationStage for this run: coldStart, deepMining, or moduleMining.',
    'Set scale.totalRecipeBudget, depthLevels, maxFiles, and contentMaxLines from the projectInfoTree evidence.',
    'Bind selected dimensions to concrete module paths when moduleMining or scoped deepMining is needed.',
    'Call alembic_plan confirm with projectProfile from projectInfoTree L0 before bootstrap or rescan.',
  ];
}

function resolveProjectInfoTreeBudgetBytes(args: PlanArgs): number {
  const hintedKilobytes = args.hints?.maxBudget;
  if (typeof hintedKilobytes === 'number' && Number.isFinite(hintedKilobytes)) {
    return Math.max(1024, Math.floor(hintedKilobytes * 1024));
  }
  return DEFAULT_PROJECT_INFO_TREE_BUDGET_BYTES;
}

function buildProjectInfoTree(
  analysis: PlanProjectContextAnalysis,
  budgetBytes: number
): ProjectInfoTreeRoot {
  const candidates = collectProjectInfoModuleCandidates(analysis);
  const totals = countProjectInfoCandidateTotals(candidates);
  const root: ProjectInfoTreeRoot = {
    children: [],
    fileCount: analysis.fileCount,
    frameworks: analysis.frameworks,
    kind: 'project',
    meta: buildProjectInfoTreeMeta({
      budgetBytes,
      delivered: { modules: 0, files: 0, symbols: 0 },
      totals,
    }),
    moduleCount: analysis.moduleCount,
    primaryLanguage: analysis.primaryLanguage,
    projectType: analysis.projectType,
    secondaryLanguages: analysis.secondaryLanguages,
  };

  const delivered = { modules: 0, files: 0, symbols: 0 };
  for (const candidate of candidates) {
    const moduleNode: ProjectInfoModuleNode = {
      children: [],
      fileCount: candidate.fileCount,
      keyDependencies: candidate.keyDependencies,
      kind: candidate.kind,
      language: candidate.language,
      path: candidate.path,
      ...(candidate.role ? { role: candidate.role } : {}),
    };
    if (!tryAppendProjectInfoNode(root.children, moduleNode, root, budgetBytes)) {
      continue;
    }
    delivered.modules += 1;
  }

  const modulesByPath = new Map(root.children.map((moduleNode) => [moduleNode.path, moduleNode]));
  for (const candidate of candidates) {
    const moduleNode = modulesByPath.get(candidate.path);
    if (!moduleNode) {
      continue;
    }
    for (const fileCandidate of candidate.files) {
      const fileNode: ProjectInfoFileNode = {
        children: [],
        kind: 'file',
        language: fileCandidate.language,
        lineCount: fileCandidate.lineCount,
        path: fileCandidate.path,
      };
      if (tryAppendProjectInfoNode(moduleNode.children, fileNode, root, budgetBytes)) {
        delivered.files += 1;
      }
    }
  }

  const fileNodesByPath = new Map<string, ProjectInfoFileNode>();
  for (const moduleNode of root.children) {
    for (const fileNode of moduleNode.children) {
      fileNodesByPath.set(fileNode.path, fileNode);
    }
  }
  for (const candidate of candidates) {
    for (const fileCandidate of candidate.files) {
      const fileNode = fileNodesByPath.get(fileCandidate.path);
      if (!fileNode) {
        continue;
      }
      for (const symbol of fileCandidate.symbols) {
        if (tryAppendProjectInfoNode(fileNode.children, symbol, root, budgetBytes)) {
          delivered.symbols += 1;
        }
      }
    }
  }

  root.meta = buildProjectInfoTreeMeta({ budgetBytes, delivered, totals });
  pruneProjectInfoTreeToBudget(root, budgetBytes, totals);
  return root;
}

async function attachFullProjectInfoTreeRefIfNeeded(
  projectInfoTree: ProjectInfoTreeRoot,
  input: {
    analysis: PlanProjectContextAnalysis;
    projectRoot: string;
  }
): Promise<void> {
  if (!hasProjectInfoTreeOmissions(projectInfoTree.meta)) {
    await removeProjectInfoFullTreeIfPresent(input.projectRoot);
    projectInfoTree.meta = {
      ...projectInfoTree.meta,
      fullTreeRef: null,
    };
    return;
  }

  const fullTree = buildCompleteProjectInfoTree(input.analysis);
  const fullTreeRef = await writeProjectInfoFullTree({
    projectRoot: input.projectRoot,
    tree: fullTree,
  });
  projectInfoTree.meta = {
    ...projectInfoTree.meta,
    fullTreeRef,
  };
  pruneProjectInfoTreeToBudget(
    projectInfoTree,
    projectInfoTree.meta.budgetBytes,
    countDeliveredProjectInfoNodes(fullTree)
  );
}

function buildCompleteProjectInfoTree(analysis: PlanProjectContextAnalysis): ProjectInfoTreeRoot {
  const candidates = collectProjectInfoModuleCandidates(analysis);
  const totals = countProjectInfoCandidateTotals(candidates);
  const root = createProjectInfoTreeRoot(analysis, {
    budgetBytes: 0,
    delivered: totals,
    totals,
  });
  root.children = candidates.map((candidate) => ({
    children: candidate.files.map((file) => ({
      children: file.symbols.map((symbol) => ({ ...symbol, children: [] })),
      kind: file.kind,
      language: file.language,
      lineCount: file.lineCount,
      path: file.path,
    })),
    fileCount: candidate.fileCount,
    keyDependencies: candidate.keyDependencies,
    kind: candidate.kind,
    language: candidate.language,
    path: candidate.path,
    ...(candidate.role ? { role: candidate.role } : {}),
  }));
  root.meta = buildProjectInfoTreeMeta({
    budgetBytes: projectInfoTreeByteLength(root),
    delivered: totals,
    totals,
  });
  return root;
}

function createProjectInfoTreeRoot(
  analysis: PlanProjectContextAnalysis,
  metaInput: Parameters<typeof buildProjectInfoTreeMeta>[0]
): ProjectInfoTreeRoot {
  return {
    children: [],
    fileCount: analysis.fileCount,
    frameworks: analysis.frameworks,
    kind: 'project',
    meta: buildProjectInfoTreeMeta(metaInput),
    moduleCount: analysis.moduleCount,
    primaryLanguage: analysis.primaryLanguage,
    projectType: analysis.projectType,
    secondaryLanguages: analysis.secondaryLanguages,
  };
}

function collectProjectInfoModuleCandidates(
  analysis: PlanProjectContextAnalysis
): ProjectInfoModuleCandidate[] {
  const fileFacts = collectProjectInfoFileFacts(analysis);
  const moduleContexts = collectProjectInfoModuleContexts(analysis);
  const fromSnapshots = collectModuleSnapshots(analysis).flatMap((snapshot) => {
    const context =
      moduleContexts.get(snapshot.moduleId) ??
      moduleContexts.get(snapshot.modulePath ?? '') ??
      moduleContexts.get(snapshot.moduleName);
    const filePaths = uniqueStrings([
      ...snapshot.files,
      ...(context?.ownedFiles.map((file) => file.filePath) ?? []),
    ]);
    const modulePath = canonicalProjectInfoModulePath({
      files: filePaths,
      moduleId: snapshot.moduleId,
      moduleName: snapshot.moduleName,
      modulePath: snapshot.modulePath,
      role: snapshot.role ?? context?.module.role,
    });
    if (!modulePath) {
      return [];
    }
    return buildProjectInfoModuleCandidate({
      analysis,
      fileFacts,
      filePaths,
      kind: resolveProjectInfoModuleKind(context?.module.kind),
      key: snapshot.moduleId,
      keyDependencies: collectModuleKeyDependencies(context),
      language: dominantLanguage(filePaths, fileFacts),
      path: modulePath,
      role: snapshot.role ?? context?.module.role,
    });
  });

  if (fromSnapshots.length > 0) {
    const mergedSnapshots = pruneProjectInfoCandidateFileOwnership(
      mergeProjectInfoModuleCandidates(fromSnapshots)
    );
    const assignedFilePaths = new Set(
      mergedSnapshots.flatMap((candidate) => candidate.files.map((file) => file.path))
    );
    const uncoveredFilePaths = [...fileFacts.keys()].filter(
      (filePath) => !assignedFilePaths.has(filePath)
    );
    return pruneProjectInfoCandidateFileOwnership(
      mergeProjectInfoModuleCandidates([
        ...mergedSnapshots,
        ...groupFilesIntoFallbackModules(analysis, fileFacts, uncoveredFilePaths),
      ])
    ).sort((left, right) => left.path.localeCompare(right.path));
  }

  return pruneProjectInfoCandidateFileOwnership(
    groupFilesIntoFallbackModules(analysis, fileFacts, [...fileFacts.keys()])
  );
}

function collectProjectInfoModuleContexts(
  analysis: PlanProjectContextAnalysis
): Map<string, ProjectContextPresenterInput['modules'][number]> {
  const contexts = new Map<string, ProjectContextPresenterInput['modules'][number]>();
  for (const moduleContext of analysis.presenterInput.modules) {
    for (const key of [
      normalizePath(moduleContext.module.id),
      canonicalProjectInfoModulePath({
        moduleId: moduleContext.module.id,
        moduleName: moduleContext.module.name,
        modulePath: readString(moduleContext.module, 'path'),
        role: moduleContext.module.role,
      }),
      normalizePath(readString(moduleContext.module, 'path')),
      moduleContext.module.name,
    ]) {
      if (key) {
        contexts.set(key, moduleContext);
      }
    }
  }
  return contexts;
}

function buildProjectInfoModuleCandidate(input: {
  analysis: PlanProjectContextAnalysis;
  fileFacts: Map<string, ProjectInfoFileCandidate>;
  filePaths: readonly string[];
  key: string;
  keyDependencies: readonly string[];
  kind: ProjectInfoModuleNode['kind'];
  language: string;
  path: string;
  role?: string;
}): ProjectInfoModuleCandidate {
  const files = uniqueStrings(input.filePaths)
    .map((filePath) => input.fileFacts.get(filePath))
    .filter(isPresent);
  return {
    files,
    fileCount: files.length,
    keyDependencies: uniqueStrings(input.keyDependencies).slice(0, 8),
    kind: input.kind,
    language: input.language,
    path: input.path,
    ...(input.role ? { role: input.role } : {}),
  };
}

function mergeProjectInfoModuleCandidates(
  candidates: readonly ProjectInfoModuleCandidate[]
): ProjectInfoModuleCandidate[] {
  const byPath = new Map<string, ProjectInfoModuleCandidate>();
  for (const candidate of candidates) {
    const modulePath = canonicalProjectInfoModulePath({
      files: candidate.files.map((file) => file.path),
      modulePath: candidate.path,
      role: candidate.role,
    });
    if (!modulePath) {
      continue;
    }
    const normalizedCandidate = { ...candidate, path: modulePath };
    const existing = byPath.get(modulePath);
    if (!existing) {
      byPath.set(modulePath, normalizedCandidate);
      continue;
    }
    const files = dedupeBy([...existing.files, ...normalizedCandidate.files], (file) => file.path);
    byPath.set(modulePath, {
      ...existing,
      files,
      fileCount: files.length,
      keyDependencies: uniqueStrings([
        ...existing.keyDependencies,
        ...normalizedCandidate.keyDependencies,
      ]).slice(0, 8),
      kind:
        existing.kind === 'package' || normalizedCandidate.kind === 'package'
          ? 'package'
          : 'module',
      language: dominantLanguageFromProjectInfoFiles(files),
      role: existing.role ?? normalizedCandidate.role,
    });
  }
  return [...byPath.values()];
}

function pruneProjectInfoCandidateFileOwnership(
  candidates: readonly ProjectInfoModuleCandidate[]
): ProjectInfoModuleCandidate[] {
  const candidatesByFilePath = new Map<string, ProjectInfoModuleCandidate[]>();
  for (const candidate of candidates) {
    for (const file of candidate.files) {
      const existing = candidatesByFilePath.get(file.path) ?? [];
      existing.push(candidate);
      candidatesByFilePath.set(file.path, existing);
    }
  }
  return candidates
    .map((candidate) => {
      const files = candidate.files.filter((file) =>
        isProjectInfoCandidateFileOwner(candidate, file.path, candidatesByFilePath)
      );
      return {
        ...candidate,
        files,
        fileCount: files.length,
        language: dominantLanguageFromProjectInfoFiles(files),
      };
    })
    .filter((candidate) => candidate.fileCount > 0);
}

function isProjectInfoCandidateFileOwner(
  candidate: ProjectInfoModuleCandidate,
  filePath: string,
  candidatesByFilePath: Map<string, ProjectInfoModuleCandidate[]>
): boolean {
  const candidates = candidatesByFilePath.get(filePath) ?? [];
  const pathOwners = candidates.filter((owner) =>
    projectInfoFileBelongsToPath(filePath, owner.path)
  );
  if (pathOwners.length === 0) {
    return true;
  }
  const longestOwnerPathLength = Math.max(...pathOwners.map((owner) => owner.path.length));
  return pathOwners.some(
    (owner) => owner.path === candidate.path && owner.path.length === longestOwnerPathLength
  );
}

function projectInfoFileBelongsToPath(filePath: string, candidatePath: string): boolean {
  return filePath === candidatePath || filePath.startsWith(`${candidatePath}/`);
}

function canonicalProjectInfoModulePath(input: {
  files?: readonly string[];
  moduleId?: string;
  moduleName?: string;
  modulePath?: string;
  role?: string;
}): string | undefined {
  const explicitPath = normalizeProjectInfoModulePath(input.modulePath);
  if (explicitPath && !isGenericProjectInfoModulePath(explicitPath, input.role)) {
    return explicitPath;
  }
  const pathFromId = normalizeProjectInfoModulePath(projectInfoPathFromModuleId(input.moduleId));
  if (pathFromId && !isGenericProjectInfoModulePath(pathFromId, input.role)) {
    return pathFromId;
  }
  const inferred = inferProjectInfoModulePathFromFiles(input.files ?? []);
  if (inferred) {
    return inferred;
  }
  const namePath = normalizeProjectInfoModulePath(input.moduleName);
  if (namePath && !isGenericProjectInfoModulePath(namePath, input.role)) {
    return namePath;
  }
  return undefined;
}

function projectInfoPathFromModuleId(value: string | undefined): string | undefined {
  const normalized = normalizePath(value);
  if (!normalized) {
    return undefined;
  }
  if (!normalized.startsWith('module:root:')) {
    return normalized;
  }
  const parts = normalized.split(':');
  return parts.length >= 4 ? parts.slice(3).join(':') : undefined;
}

function normalizeProjectInfoModulePath(value: string | undefined): string | undefined {
  const normalized = normalizePath(value);
  if (!normalized || normalized.startsWith('module:root:')) {
    return undefined;
  }
  return normalized;
}

function isGenericProjectInfoModulePath(value: string, role: string | undefined): boolean {
  return value === 'module' && !role;
}

function inferProjectInfoModulePathFromFiles(files: readonly string[]): string | undefined {
  const normalizedFiles = files.map(normalizePath).filter(isPresent);
  if (normalizedFiles.length === 0) {
    return undefined;
  }
  const topLevel = uniqueStrings(normalizedFiles.map((filePath) => filePath.split('/')[0] ?? ''));
  if (topLevel.length !== 1) {
    return undefined;
  }
  const first = normalizedFiles[0];
  if (!first) {
    return undefined;
  }
  const parts = first.split('/');
  if (parts[0] === 'Packages' && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function dominantLanguageFromProjectInfoFiles(files: readonly ProjectInfoFileCandidate[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      ([leftLanguage, leftCount], [rightLanguage, rightCount]) =>
        rightCount - leftCount || leftLanguage.localeCompare(rightLanguage)
    )[0]?.[0] ?? 'unknown'
  );
}

function collectProjectInfoFileFacts(
  analysis: PlanProjectContextAnalysis
): Map<string, ProjectInfoFileCandidate> {
  const files = dedupeBy(
    [
      ...analysis.presenterInput.files.map((file) => ({
        kind: 'file' as const,
        language: file.language ?? 'unknown',
        lineCount: file.lineCount ?? 0,
        path: file.filePath,
      })),
      ...analysis.sourceFileFacts.map((file) => ({
        kind: 'file' as const,
        language: file.language,
        lineCount: 0,
        path: file.filePath,
      })),
    ],
    (file) => file.path
  );
  return new Map(
    files
      .map((file) => ({
        ...file,
        symbols: collectProjectInfoSymbolsForFile(analysis, file.path),
      }))
      .map((file) => [file.path, file])
  );
}

function collectProjectInfoSymbolsForFile(
  analysis: PlanProjectContextAnalysis,
  filePath: string
): ProjectInfoSymbolNode[] {
  const fromModules = analysis.presenterInput.modules.flatMap((moduleContext) =>
    moduleContext.publicSurfaces.filter((symbol) => symbol.filePath === filePath)
  );
  const fromFileSymbols = analysis.presenterInput.fileSymbols.flatMap((context) =>
    context.file.filePath === filePath ? context.symbols : []
  );
  return dedupeBy([...fromModules, ...fromFileSymbols], (symbol) => {
    return `${symbol.filePath}:${symbol.qualifiedName ?? symbol.name}:${symbol.kind}`;
  })
    .map((symbol) => ({
      children: [] as [],
      ...(symbol.exported !== undefined ? { exported: symbol.exported } : {}),
      filePath: symbol.filePath,
      kind: 'symbol' as const,
      name: symbol.qualifiedName ?? symbol.name,
      ...(symbol.signature ? { signature: symbol.signature } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function collectModuleKeyDependencies(
  moduleContext: ProjectContextPresenterInput['modules'][number] | undefined
): string[] {
  if (!moduleContext) {
    return [];
  }
  return uniqueStrings(
    [...moduleContext.inflow, ...moduleContext.outflow].map((relation) => {
      const endpoint = relation.direction === 'outflow' ? relation.to : relation.from;
      return endpoint?.label ?? relation.label ?? relation.kind;
    })
  );
}

function groupFilesIntoFallbackModules(
  analysis: PlanProjectContextAnalysis,
  fileFacts: Map<string, ProjectInfoFileCandidate>,
  filePaths: readonly string[]
): ProjectInfoModuleCandidate[] {
  const byTopPath = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const topPath = filePath.split('/')[0] ?? filePath;
    const existing = byTopPath.get(topPath) ?? [];
    existing.push(filePath);
    byTopPath.set(topPath, existing);
  }
  return [...byTopPath.entries()]
    .map(([topPath, filePaths]) =>
      buildProjectInfoModuleCandidate({
        analysis,
        fileFacts,
        filePaths,
        key: topPath,
        keyDependencies: [],
        kind: 'module',
        language: dominantLanguage(filePaths, fileFacts),
        path: topPath,
        role: 'source-root',
      })
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}

function dominantLanguage(
  filePaths: readonly string[],
  fileFacts: Map<string, ProjectInfoFileCandidate>
): string {
  const counts = new Map<string, number>();
  for (const filePath of filePaths) {
    const language = fileFacts.get(filePath)?.language ?? 'unknown';
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      ([leftLanguage, leftCount], [rightLanguage, rightCount]) =>
        rightCount - leftCount || leftLanguage.localeCompare(rightLanguage)
    )[0]?.[0] ?? 'unknown'
  );
}

function resolveProjectInfoModuleKind(value: string | undefined): ProjectInfoModuleNode['kind'] {
  return value === 'package' ? 'package' : 'module';
}

function countProjectInfoCandidateTotals(candidates: readonly ProjectInfoModuleCandidate[]): {
  files: number;
  modules: number;
  symbols: number;
} {
  return {
    modules: candidates.length,
    files: candidates.reduce((sum, moduleNode) => sum + moduleNode.files.length, 0),
    symbols: candidates.reduce(
      (sum, moduleNode) =>
        sum + moduleNode.files.reduce((fileSum, file) => fileSum + file.symbols.length, 0),
      0
    ),
  };
}

function buildProjectInfoTreeMeta(input: {
  budgetBytes: number;
  delivered: { files: number; modules: number; symbols: number };
  fullTreeRef?: ProjectInfoFullTreeRef | null;
  totals: { files: number; modules: number; symbols: number };
}): ProjectInfoTreeMeta {
  const fullTreeRef = input.fullTreeRef ?? null;
  const omitted = {
    ...(input.totals.modules > input.delivered.modules
      ? { modules: input.totals.modules - input.delivered.modules }
      : {}),
    ...(input.totals.files > input.delivered.files
      ? { files: input.totals.files - input.delivered.files }
      : {}),
    ...(input.totals.symbols > input.delivered.symbols
      ? { symbols: input.totals.symbols - input.delivered.symbols }
      : {}),
  };
  return {
    budgetBytes: input.budgetBytes,
    deliveredDepth:
      input.delivered.symbols > 0 ? 'symbols' : input.delivered.files > 0 ? 'files' : 'modules',
    fullTreeRef,
    omitted,
    truncated: fullTreeRef !== null,
  };
}

function hasProjectInfoTreeOmissions(meta: ProjectInfoTreeMeta): boolean {
  return Object.keys(meta.omitted).length > 0;
}

function tryAppendProjectInfoNode<T>(
  children: T[],
  node: T,
  root: ProjectInfoTreeRoot,
  budgetBytes: number
): boolean {
  children.push(node);
  if (projectInfoTreeByteLength(root) <= budgetBytes) {
    return true;
  }
  children.pop();
  return false;
}

function pruneProjectInfoTreeToBudget(
  root: ProjectInfoTreeRoot,
  budgetBytes: number,
  totals: { files: number; modules: number; symbols: number }
): void {
  while (projectInfoTreeByteLength(root) > budgetBytes) {
    if (removeLastProjectInfoSymbol(root) || removeLastProjectInfoFile(root)) {
      root.meta = buildProjectInfoTreeMeta({
        budgetBytes,
        delivered: countDeliveredProjectInfoNodes(root),
        fullTreeRef: root.meta.fullTreeRef,
        totals,
      });
      continue;
    }
    if (root.children.pop()) {
      root.meta = buildProjectInfoTreeMeta({
        budgetBytes,
        delivered: countDeliveredProjectInfoNodes(root),
        fullTreeRef: root.meta.fullTreeRef,
        totals,
      });
      continue;
    }
    break;
  }
}

function removeLastProjectInfoSymbol(root: ProjectInfoTreeRoot): boolean {
  for (const moduleNode of [...root.children].reverse()) {
    for (const fileNode of [...moduleNode.children].reverse()) {
      if (fileNode.children.pop()) {
        return true;
      }
    }
  }
  return false;
}

function removeLastProjectInfoFile(root: ProjectInfoTreeRoot): boolean {
  for (const moduleNode of [...root.children].reverse()) {
    if (moduleNode.children.pop()) {
      return true;
    }
  }
  return false;
}

function countDeliveredProjectInfoNodes(root: ProjectInfoTreeRoot): {
  files: number;
  modules: number;
  symbols: number;
} {
  return {
    modules: root.children.length,
    files: root.children.reduce((sum, moduleNode) => sum + moduleNode.children.length, 0),
    symbols: root.children.reduce(
      (sum, moduleNode) =>
        sum + moduleNode.children.reduce((fileSum, file) => fileSum + file.children.length, 0),
      0
    ),
  };
}

function projectInfoTreeByteLength(root: ProjectInfoTreeRoot): number {
  return Buffer.byteLength(JSON.stringify(root), 'utf8');
}

async function writeProjectInfoFullTree(input: {
  projectRoot: string;
  tree: ProjectInfoTreeRoot;
}): Promise<ProjectInfoFullTreeRef> {
  return writeTransientTransport({
    name: 'plan-tree',
    payload: input.tree,
    projectRoot: input.projectRoot,
  });
}

async function removeProjectInfoFullTreeIfPresent(projectRoot: string): Promise<void> {
  await removeTransientTransportIfPresent({ name: 'plan-tree', projectRoot });
}

function buildProjectProfileFromAnalysis(
  analysis: PlanProjectContextAnalysis
): PlanIntent['projectProfile'] {
  return {
    fileCount: analysis.fileCount,
    frameworks: analysis.frameworks,
    moduleCount: analysis.moduleCount,
    primaryLanguage: analysis.primaryLanguage,
    projectType: analysis.projectType,
    secondaryLanguages: analysis.secondaryLanguages,
  };
}

function buildStatelessPlanNextActions(projectRoot: string): Record<string, unknown>[] {
  return [
    {
      tool: PLAN_TOOL_NAME,
      operation: 'draft',
      required: true,
      reason: 'Collect a fresh bounded projectInfoTree and candidateDimensions before generation.',
      args: { operation: 'draft', projectRoot },
    },
    {
      tool: PLAN_TOOL_NAME,
      operation: 'confirm',
      required: true,
      reason: 'Return a stateless planSelection and pass it directly to the generation tool.',
    },
  ];
}

async function collectPlanProjectContext(
  projectRoot: string,
  hints: PlanArgs['hints']
): Promise<PlanProjectContextAnalysis> {
  const scopeContext = resolvePlanProjectScopeContext(projectRoot, hints);
  const envelopes: ProjectContextEnvelope<ProjectContextResult>[] = [];
  const push = async (
    kind: ProjectContextRequestKind,
    payload?: Record<string, unknown>,
    options: {
      displayName: string;
      projectRoot: string;
    } = {
      displayName: scopeContext.displayName,
      projectRoot: scopeContext.scanBase,
    }
  ): Promise<ProjectContextEnvelope<ProjectContextResult>> => {
    const envelope = await ProjectContextCapabilities.execute({
      kind,
      payload,
      project: {
        displayName: options.displayName,
        projectRoot: options.projectRoot,
        source: 'codex-host-plan',
      },
      scope: { projectRoot: options.projectRoot },
    });
    envelopes.push(envelope);
    return envelope;
  };

  await push('space', {
    includeProjectTree: true,
    ...(scopeContext.projectId ? { projectId: scopeContext.projectId } : {}),
    ...(scopeContext.sourceFolders ? { sourceFolders: scopeContext.sourceFolders } : {}),
  });
  const repoEnvelope = await push(
    'repo',
    { includeMapSummary: true },
    {
      displayName: scopeContext.repoDisplayName,
      projectRoot: scopeContext.repoProjectRoot,
    }
  );
  const repo = isRepoContext(repoEnvelope.data) ? repoEnvelope.data : undefined;
  const sourceFileFacts = await collectProjectSourceFileFacts(scopeContext.scanBase, {
    sourceFolders: scopeContext.sourceFolders,
  });
  const moduleSeeds = attachSourceFilesToProjectContextModuleSeeds(
    prefixPlanModuleSeeds(selectPlanModuleSeeds(repo), scopeContext.repoSourceFolder),
    sourceFileFacts
  );
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

function resolvePlanProjectScopeContext(
  projectRoot: string,
  hints: PlanArgs['hints']
): PlanProjectScopeContext {
  const projectScope = loadPlanProjectScope(projectRoot);
  if (!projectScope) {
    return {
      displayName: basename(projectRoot),
      repoDisplayName: basename(projectRoot),
      repoProjectRoot: projectRoot,
      scanBase: projectRoot,
    };
  }

  const scanBase = projectScope.controlRoot.path;
  const activeFolders = projectScope.folders
    .filter((folder) => folder.state === 'active')
    .map((folder) => ({
      folder,
      sourceFolder: planProjectScopeFolderRelativePath(scanBase, folder),
    }))
    .filter((selection): selection is PlanProjectScopeFolderSelection =>
      Boolean(selection.sourceFolder)
    );
  if (activeFolders.length === 0) {
    return {
      displayName: projectScope.displayName,
      projectId: projectScope.projectId,
      repoDisplayName: projectScope.displayName,
      repoProjectRoot: scanBase,
      scanBase,
    };
  }

  const focusedFolders = selectFocusedProjectScopeFolders(activeFolders, hints?.focusModules);
  const selectedFolders = focusedFolders.length > 0 ? focusedFolders : activeFolders;
  const repoFolder =
    selectedFolders.find((selection) => selection.folder.role === 'primary-source') ??
    selectedFolders[0];

  return {
    displayName: projectScope.displayName,
    projectId: projectScope.projectId,
    repoDisplayName: repoFolder.folder.displayName,
    repoProjectRoot: repoFolder.folder.path,
    repoSourceFolder: repoFolder.sourceFolder,
    scanBase,
    sourceFolders: selectedFolders.map((selection) => selection.sourceFolder),
  };
}

function loadPlanProjectScope(projectRoot: string): ProjectDescriptor | null {
  const folderScope = loadProjectScopeForFolder(projectRoot);
  if (folderScope) {
    return folderScope;
  }
  const normalizedProjectRoot = path.resolve(projectRoot);
  try {
    return (
      Object.values(readProjectScopeRegistryDocument().scopes).find(
        (scope) => path.resolve(scope.controlRoot.path) === normalizedProjectRoot
      ) ?? null
    );
  } catch {
    return null;
  }
}

function planProjectScopeFolderRelativePath(
  scanBase: string,
  folder: ProjectFolderDescriptor
): string | undefined {
  const relativePath = normalizePath(path.relative(scanBase, folder.path));
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    return undefined;
  }
  return relativePath;
}

function selectFocusedProjectScopeFolders(
  folders: readonly PlanProjectScopeFolderSelection[],
  focusModules: readonly string[] | undefined
): PlanProjectScopeFolderSelection[] {
  const focused = uniqueStrings((focusModules ?? []).map((value) => normalizePath(value) ?? ''));
  if (focused.length === 0) {
    return [];
  }
  return folders.filter((selection) =>
    focused.some((focusModule) => projectScopeFolderMatchesFocus(selection, focusModule))
  );
}

function projectScopeFolderMatchesFocus(
  selection: PlanProjectScopeFolderSelection,
  focusModule: string
): boolean {
  const candidates = [
    selection.sourceFolder,
    selection.folder.displayName,
    selection.folder.id,
    selection.folder.repositoryId ?? undefined,
    normalizePath(path.basename(selection.folder.path)),
  ]
    .map((value) => normalizePath(value))
    .filter(isPresent);
  return candidates.some(
    (candidate) =>
      candidate === focusModule ||
      focusModule.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${focusModule}/`)
  );
}

function prefixPlanModuleSeeds(
  seeds: readonly PlanModuleSeed[],
  sourceFolder: string | undefined
): PlanModuleSeed[] {
  if (!sourceFolder) {
    return [...seeds];
  }
  return seeds.map((seed) => {
    const modulePath = prefixProjectContextPath(sourceFolder, seed.modulePath);
    const ownedFiles = seed.ownedFiles
      ?.map((filePath) => prefixProjectContextPath(sourceFolder, filePath))
      .filter(isPresent);
    return {
      ...seed,
      ...(modulePath ? { modulePath } : {}),
      ...(ownedFiles && ownedFiles.length > 0 ? { ownedFiles } : {}),
    };
  });
}

function prefixProjectContextPath(
  sourceFolder: string,
  pathValue: string | undefined
): string | undefined {
  const normalizedPath = normalizePath(pathValue);
  const normalizedSourceFolder = normalizePath(sourceFolder);
  if (!normalizedPath || !normalizedSourceFolder) {
    return normalizedPath;
  }
  return normalizedPath === normalizedSourceFolder ||
    normalizedPath.startsWith(`${normalizedSourceFolder}/`)
    ? normalizedPath
    : `${normalizedSourceFolder}/${normalizedPath}`;
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

function resolvePlanProjectRoot(ctx: PlanToolContext, args: Partial<PlanArgs>): string {
  return args.projectRoot ?? resolveProjectRoot(ctx.container);
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
    const role = readString(module, 'role');
    return {
      files,
      fingerprint: `${role ?? ''}:${files.join('|')}`,
      moduleId,
      moduleName,
      modulePath: canonicalProjectInfoModulePath({
        files,
        moduleId,
        moduleName,
        modulePath: readString(module, 'path'),
        role,
      }),
      role,
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
      modulePath: normalizeProjectInfoModulePath(seed.modulePath),
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

function hasSeedScope(seed: PlanModuleSeed): boolean {
  return Boolean(seed.modulePath || seed.ownedFiles?.length);
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
