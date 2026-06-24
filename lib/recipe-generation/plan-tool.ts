import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path, { basename } from 'node:path';
import {
  buildDimensionCatalogPayload,
  type DimensionCatalogPayloadItem,
  type ProjectLanguageFrameworkFacts,
  resolvePlanDimensionDefinitions,
} from '@alembic/core/dimensions';
import { baseDimensions, type DimensionDef } from '@alembic/core/host-agent-workflows';
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
import { LanguageService } from '@alembic/core/shared';
import { resolveProjectRoot, WorkspaceResolver } from '@alembic/core/workspace';
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

interface PlanProjectSourceFileFact {
  filePath: string;
  language: string;
  sizeBytes: number;
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
  sourceFileFacts: PlanProjectSourceFileFact[];
  understandingGaps: Record<string, unknown>[];
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
  role?: string;
}

type PlanArgs = PlanInput;

interface PlanDraftContext {
  analysis: PlanProjectContextAnalysis;
  projectRoot: string;
  projectInfoTree: ProjectInfoTreeRoot;
  candidateDimensions: CandidateDimension[];
}

type BuildConfirmIntentResult =
  | { ok: true; intent: PlanIntent }
  | { ok: false; response: PlanToolResponse };

const PLAN_TOOL_NAME = 'alembic_plan';
const DEFAULT_PROJECT_INFO_TREE_BUDGET_BYTES = 12 * 1024;
const PLAN_SOURCE_SCAN_MAX_FILES = 5000;
const PLAN_MODULE_OWNED_FILE_LIMIT = 400;
const PLAN_SOURCE_SCAN_EXCLUDE_DIRS = new Set([
  ...LanguageService.scanSkipDirs,
  '.asd',
  '.git',
  '.wakeflow-active',
  '.wakeflow-local',
  'DerivedData',
  'node_modules',
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

  const draftContext = await buildPlanDraftContext(args, projectRoot, analysis);
  return planDraftResponse(draftContext);
}

async function confirmPlan(ctx: PlanToolContext, args: PlanArgs): Promise<PlanToolResponse> {
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
  return confirmedPlanResponse(projectRoot, intent, buildPlanSelection(intent));
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
  return {
    analysis,
    projectRoot,
    projectInfoTree,
    candidateDimensions: buildCandidateDimensions(analysis),
  };
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
      generationStage: 'coldStart',
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
  if (!projectInfoTree.meta.truncated) {
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
  const moduleContexts = new Map(
    analysis.presenterInput.modules.map((moduleContext) => [
      normalizePath(moduleContext.module.id) ?? moduleContext.module.name,
      moduleContext,
    ])
  );
  const fromSnapshots = collectModuleSnapshots(analysis).map((snapshot) => {
    const context =
      moduleContexts.get(snapshot.moduleId) ?? moduleContexts.get(snapshot.moduleName);
    const filePaths = uniqueStrings([
      ...snapshot.files,
      ...(context?.ownedFiles.map((file) => file.filePath) ?? []),
    ]);
    return buildProjectInfoModuleCandidate({
      analysis,
      fileFacts,
      filePaths,
      kind: resolveProjectInfoModuleKind(context?.module.kind),
      key: snapshot.moduleId,
      keyDependencies: collectModuleKeyDependencies(context),
      language: dominantLanguage(filePaths, fileFacts),
      path: normalizePath(snapshot.moduleId) ?? snapshot.moduleName,
      role: snapshot.role ?? context?.module.role,
    });
  });

  if (fromSnapshots.length > 0) {
    return dedupeBy(fromSnapshots, (candidate) => candidate.path).sort((left, right) =>
      left.path.localeCompare(right.path)
    );
  }

  return groupFilesIntoFallbackModules(analysis, fileFacts);
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
  fileFacts: Map<string, ProjectInfoFileCandidate>
): ProjectInfoModuleCandidate[] {
  const byTopPath = new Map<string, string[]>();
  for (const filePath of fileFacts.keys()) {
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
    fullTreeRef: input.fullTreeRef ?? null,
    omitted,
    truncated: Object.keys(omitted).length > 0,
  };
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
  const filePath = projectInfoFullTreePath(input.projectRoot);
  const content = `${JSON.stringify(input.tree, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    path: filePath,
  };
}

async function removeProjectInfoFullTreeIfPresent(projectRoot: string): Promise<void> {
  await fs.rm(projectInfoFullTreePath(projectRoot), { force: true });
}

function projectInfoFullTreePath(projectRoot: string): string {
  const dataRoot = resolvePlanTreeDataRoot(projectRoot);
  return path.join(dataRoot, '.asd', 'tmp', `plan-tree-${projectHash(projectRoot)}.json`);
}

function resolvePlanTreeDataRoot(projectRoot: string): string {
  try {
    return WorkspaceResolver.fromProject(projectRoot).dataRoot;
  } catch {
    return projectRoot;
  }
}

function projectHash(projectRoot: string): string {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
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

function nextGenerationToolForStage(stage: PlanStageId): 'alembic_bootstrap' | 'alembic_rescan' {
  return stage === 'coldStart' ? 'alembic_bootstrap' : 'alembic_rescan';
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

function confirmedPlanResponse(
  projectRoot: string,
  intent: PlanIntent,
  planSelection: PlanSelection
): PlanToolResponse {
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

async function collectPlanProjectContext(
  projectRoot: string,
  _hints: PlanArgs['hints']
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
  const sourceFileFacts = await collectProjectSourceFileFacts(projectRoot);
  const moduleSeeds = attachSourceFilesToModuleSeeds(selectPlanModuleSeeds(repo), sourceFileFacts);
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

async function collectProjectSourceFileFacts(
  projectRoot: string
): Promise<PlanProjectSourceFileFact[]> {
  const facts: PlanProjectSourceFileFact[] = [];
  const absoluteRoot = path.resolve(projectRoot);
  const pending = [absoluteRoot];
  while (pending.length > 0 && facts.length < PLAN_SOURCE_SCAN_MAX_FILES) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    const entries = await safeReadDir(current);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toProjectContextPath(path.relative(absoluteRoot, absolutePath));
      if (!relativePath || relativePath.startsWith('..')) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!PLAN_SOURCE_SCAN_EXCLUDE_DIRS.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const language = LanguageService.inferLang(relativePath);
      if (language === 'unknown') {
        continue;
      }
      const stat = await safeStat(absolutePath);
      facts.push({
        filePath: relativePath,
        language,
        sizeBytes: stat?.size ?? 0,
      });
      if (facts.length >= PLAN_SOURCE_SCAN_MAX_FILES) {
        break;
      }
    }
  }
  return facts.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

async function safeReadDir(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function attachSourceFilesToModuleSeeds(
  seeds: readonly PlanModuleSeed[],
  sourceFileFacts: readonly PlanProjectSourceFileFact[]
): PlanModuleSeed[] {
  const sourceFilesByPath = new Set(sourceFileFacts.map((file) => file.filePath));
  return mergePlanModuleSeeds(
    seeds
      .map((seed) => {
        const explicitFiles = uniqueStrings(
          (seed.ownedFiles ?? [])
            .map(normalizePath)
            .filter(isPresent)
            .filter((filePath) => sourceFilesByPath.has(filePath))
        );
        const matchedFiles = sourceFilesForModuleSeed(seed, sourceFileFacts).map(
          (file) => file.filePath
        );
        const ownedFiles = uniqueStrings([...explicitFiles, ...matchedFiles]).slice(
          0,
          PLAN_MODULE_OWNED_FILE_LIMIT
        );
        return {
          ...seed,
          ownedFiles: ownedFiles.length > 0 ? ownedFiles : undefined,
        };
      })
      .filter((seed) => hasSeedScope(seed) && (seed.ownedFiles?.length ?? 0) > 0)
  );
}

function sourceFilesForModuleSeed(
  seed: PlanModuleSeed,
  sourceFileFacts: readonly PlanProjectSourceFileFact[]
): PlanProjectSourceFileFact[] {
  const modulePath = normalizePath(seed.modulePath);
  if (!modulePath) {
    return [];
  }
  return sourceFileFacts.filter(
    (file) => file.filePath === modulePath || file.filePath.startsWith(`${modulePath}/`)
  );
}

function toProjectContextPath(value: string): string {
  return value.split(path.sep).join('/');
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

function hasSeedScope(seed: PlanModuleSeed): boolean {
  return Boolean(seed.modulePath || seed.ownedFiles?.length);
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

function normalizeStringArray(value: unknown): string[] {
  return arrayStrings(value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
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
