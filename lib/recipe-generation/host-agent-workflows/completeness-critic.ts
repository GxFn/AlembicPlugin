import {
  buildCompletenessCritic,
  type CompletenessCriticResult,
  type CompletenessMiningGuidance,
  type CompletenessProjectArea,
  type CompletenessProjectFact,
  type CompletenessProjectFile,
  type CompletenessProjectInfoTree,
  type CompletenessProjectSymbol,
  type CompletenessSourceRefInput,
  type CompletenessSubmittedRecipe,
} from '@alembic/core/host-agent-workflows';
import type { HostAgentProjectContextAnalysis } from '#recipe-generation/host-agent-workflows/project-context-analysis.js';

interface DimensionLike {
  id: string;
  label?: string;
  guide?: string;
  knowledgeTypes?: readonly string[];
}

interface CompletionCriticInput {
  dimension: DimensionLike;
  exhaustedReason?: string;
  noPadding?: boolean;
  referencedFiles: readonly string[];
  sessionSnapshot?: SessionSnapshotLike | null;
  submittedRecipeCount?: number;
  submittedRecipes: readonly CompletenessSubmittedRecipe[];
}

interface SessionSnapshotLike {
  allFiles?: readonly SessionSnapshotFileLike[];
  localPackageModules?: readonly SessionLocalPackageLike[];
  targetsSummary?: readonly SessionTargetLike[];
}

interface SessionSnapshotFileLike {
  path?: string;
  filePath?: string;
  relativePath?: string;
  language?: string;
}

interface SessionLocalPackageLike {
  packageName?: string;
  name?: string;
  path?: string;
}

interface SessionTargetLike {
  name?: string;
  path?: string;
  type?: string;
}

interface AgentCriticProjectionOptions {
  maxGuidance?: number;
  maxHints?: number;
  maxNotes?: number;
  maxSourceRefsPerItem?: number;
}

const DEFAULT_TARGET_PER_DIMENSION = 5;
const DEFAULT_FLOOR_PER_DIMENSION = 3;
const MAX_PROJECT_FILES_FOR_CRITIC = 120;
const MAX_PROJECT_SYMBOLS_FOR_CRITIC = 80;
const MAX_GUIDANCE_SOURCE_REFS = 12;

export function buildColdStartCompletenessCriticByDimension(input: {
  dimensions: readonly DimensionLike[];
  projectContextAnalysis: HostAgentProjectContextAnalysis;
}): Map<string, CompletenessCriticResult> {
  const results = new Map<string, CompletenessCriticResult>();
  for (const dimension of input.dimensions) {
    const projectInfoTree = buildProjectContextCompletenessTree({
      dimensionId: dimension.id,
      projectContextAnalysis: input.projectContextAnalysis,
    });
    const miningGuidance = buildDimensionMiningGuidance({
      dimension,
      projectInfoTree,
      projectSummary: {
        fileCount: input.projectContextAnalysis.fileCount,
        moduleCount: input.projectContextAnalysis.moduleCount,
        primaryLang: input.projectContextAnalysis.primaryLang,
      },
    });
    results.set(
      dimension.id,
      buildCompletenessCritic({
        dimensionId: dimension.id,
        floorPerDimension: DEFAULT_FLOOR_PER_DIMENSION,
        maxHints: DEFAULT_TARGET_PER_DIMENSION,
        miningGuidance,
        projectInfoTree,
        submittedRecipeCount: 0,
        targetPerDimension: DEFAULT_TARGET_PER_DIMENSION,
      })
    );
  }
  return results;
}

export function buildDimensionCompletionCompletenessCritic(
  input: CompletionCriticInput
): CompletenessCriticResult {
  const projectInfoTree = buildSessionCompletenessTree(input);
  const miningGuidance = buildDimensionMiningGuidance({
    dimension: input.dimension,
    projectInfoTree,
    projectSummary: {
      fileCount: input.sessionSnapshot?.allFiles?.length ?? input.referencedFiles.length,
      moduleCount: input.sessionSnapshot?.localPackageModules?.length ?? 0,
      primaryLang: firstFileLanguage(input.sessionSnapshot?.allFiles),
    },
  });

  return buildCompletenessCritic({
    dimensionId: input.dimension.id,
    exhaustedReason: input.exhaustedReason,
    floorPerDimension: DEFAULT_FLOOR_PER_DIMENSION,
    maxHints: DEFAULT_TARGET_PER_DIMENSION,
    miningGuidance,
    noPadding: input.noPadding,
    projectInfoTree,
    submittedRecipeCount: input.submittedRecipeCount ?? input.submittedRecipes.length,
    submittedRecipes: input.submittedRecipes,
    submittedSourceRefs: input.referencedFiles,
    targetPerDimension: DEFAULT_TARGET_PER_DIMENSION,
  });
}

export function projectCompletenessCriticForAgent(
  result: CompletenessCriticResult,
  options: AgentCriticProjectionOptions = {}
): Record<string, unknown> {
  const maxHints = options.maxHints ?? 5;
  const maxGuidance = options.maxGuidance ?? 5;
  const maxNotes = options.maxNotes ?? 5;
  const maxSourceRefsPerItem = options.maxSourceRefsPerItem ?? 5;
  return {
    dimensionId: result.dimensionId,
    status: result.status,
    targetGate: result.targetGate,
    shouldBlockCompletion: result.shouldBlockCompletion,
    submittedRecipeCount: result.submittedRecipeCount,
    floorPerDimension: result.floorPerDimension,
    targetPerDimension: result.targetPerDimension,
    neededToTarget: result.neededToTarget,
    floorStatus: result.floorStatus,
    hints: result.hints.slice(0, maxHints).map((hint) => ({
      pattern: hint.pattern,
      reason: hint.reason,
      importance: hint.importance,
      sourceRefs: hint.sourceRefs.slice(0, maxSourceRefsPerItem),
      matchedGuidanceIds: hint.matchedGuidanceIds,
      coverageStatus: hint.coverageStatus,
    })),
    sortedMiningGuidance: result.sortedMiningGuidance.slice(0, maxGuidance).map((guidance) => ({
      id: guidance.id,
      title: guidance.title,
      description: guidance.description,
      importance: guidance.importance,
      coverageStatus: guidance.coverageStatus,
      sourceRefs: guidance.sourceRefs.slice(0, maxSourceRefsPerItem),
    })),
    exhaustedReason: result.exhaustedReason,
    notes: result.notes.slice(0, maxNotes),
  };
}

export function buildSubmittedRecipesForCompletenessCritic(input: {
  dimensionId: string;
  submittedRecipeIds: readonly string[];
  trackerSubmissions: readonly { recipeId?: string; sources?: readonly string[]; title?: string }[];
}): CompletenessSubmittedRecipe[] {
  const byId = new Map<string, CompletenessSubmittedRecipe>();
  for (const submission of input.trackerSubmissions) {
    const recipeId = submission.recipeId;
    if (!recipeId) {
      continue;
    }
    byId.set(recipeId, {
      id: recipeId,
      dimensionId: input.dimensionId,
      title: submission.title,
      sourceRefs: [...(submission.sources ?? [])],
    });
  }
  for (const recipeId of input.submittedRecipeIds) {
    if (!byId.has(recipeId)) {
      byId.set(recipeId, {
        id: recipeId,
        dimensionId: input.dimensionId,
        sourceRefs: [],
      });
    }
  }
  return [...byId.values()];
}

function buildProjectContextCompletenessTree(input: {
  dimensionId: string;
  projectContextAnalysis: HostAgentProjectContextAnalysis;
}): CompletenessProjectInfoTree {
  const presenter = input.projectContextAnalysis.presenterInput;
  const files = uniqueByPath([
    ...presenter.files.map((file) => ({
      path: file.filePath,
      relativePath: file.filePath,
      name: file.filePath.split('/').pop(),
      summary: file.language
        ? `${file.language} source file from ProjectContext`
        : 'Source file from ProjectContext',
      dimensionIds: [input.dimensionId],
      tags: ['project-context', file.language ?? 'source'],
    })),
    ...input.projectContextAnalysis.sourceFileFacts.map((file) => ({
      path: file.filePath,
      relativePath: file.filePath,
      name: file.filePath.split('/').pop(),
      summary: `${file.language} source file discovered from the project root`,
      dimensionIds: [input.dimensionId],
      tags: ['source-file', file.language],
    })),
  ]).slice(0, MAX_PROJECT_FILES_FOR_CRITIC);
  const modules = uniqueAreas([
    ...input.projectContextAnalysis.moduleSeeds.map((seed) => ({
      name: seed.moduleName,
      description: describeModuleSeed(seed.role, seed.modulePath, seed.ownedFiles?.length),
      importance: seed.role === 'local-package' ? 90 : 75,
      dimensionIds: [input.dimensionId],
      tags: ['project-context-module', seed.role ?? seed.kind ?? 'module'],
      sourceRefs: areaSourceRefs(seed.modulePath, seed.ownedFiles),
      keyFiles: sourceRefSlice(seed.ownedFiles),
    })),
    ...presenter.modules.map((moduleContext) => ({
      name: moduleContext.module.name,
      description: describeModuleSeed(
        moduleContext.module.role,
        moduleContext.module.ref?.scope.filePath,
        moduleContext.ownedFiles.length
      ),
      importance: 85,
      dimensionIds: [input.dimensionId],
      tags: ['project-context-module', moduleContext.module.role ?? 'module'],
      sourceRefs: areaSourceRefs(
        moduleContext.module.ref?.scope.filePath,
        moduleContext.ownedFiles.map((file) => file.filePath)
      ),
      keyFiles: sourceRefSlice(moduleContext.ownedFiles.map((file) => file.filePath)),
    })),
    ...(presenter.map?.modules ?? []).map((module) => ({
      name: module.name,
      description: describeModuleSeed(
        module.role,
        module.ref?.scope.filePath,
        module.ownedFileCount
      ),
      importance: module.role === 'local-package' ? 85 : 70,
      dimensionIds: [input.dimensionId],
      tags: ['project-context-map', module.role ?? 'module'],
      sourceRefs: areaSourceRefs(module.ref?.scope.filePath),
    })),
  ]);
  const areas = uniqueAreas([
    ...(presenter.repo?.localPackages ?? []).map((pkg) => ({
      name: pkg.name,
      description: `Local package ${pkg.name}${pkg.path ? ` at ${pkg.path}` : ''}`,
      importance: 90,
      dimensionIds: [input.dimensionId],
      tags: ['local-package'],
      sourceRefs: sourceRefSlice([pkg.path, pkg.ref?.scope.filePath]),
    })),
    ...(presenter.repo?.sourceRoots ?? []).map((root) => ({
      name: root.path,
      description: `Source root${root.role ? ` (${root.role})` : ''}: ${root.path}`,
      importance: 75,
      dimensionIds: [input.dimensionId],
      tags: ['source-root', root.role ?? 'source'],
      sourceRefs: sourceRefSlice([root.path, root.ref?.scope.filePath]),
    })),
    ...(presenter.repo?.configFiles ?? []).map((file) => ({
      name: file.path,
      description: `Project config ${file.kind}: ${file.path}`,
      importance: 65,
      dimensionIds: [input.dimensionId],
      tags: ['config', file.kind],
      sourceRefs: sourceRefSlice([file.path, file.ref?.scope.filePath]),
    })),
  ]);
  const facts = buildProjectContextFacts(input.dimensionId, input.projectContextAnalysis);
  const symbols = uniqueSymbols(
    [
      ...presenter.fileSymbols.flatMap((fileSymbols) =>
        fileSymbols.symbols.map((symbol) => ({
          name: symbol.qualifiedName ?? symbol.name,
          file: symbol.filePath,
          relativePath: symbol.filePath,
          kind: symbol.kind,
          summary: symbol.signature ?? `Project symbol ${symbol.name}`,
          importance: symbol.exported ? 80 : 60,
          dimensionIds: [input.dimensionId],
          tags: ['project-context-symbol', symbol.kind],
        }))
      ),
      ...presenter.fileFlows.flatMap((flow) =>
        flow.exports.map((symbol) => ({
          name: symbol.qualifiedName ?? symbol.name,
          file: symbol.filePath,
          relativePath: symbol.filePath,
          kind: symbol.kind,
          summary: symbol.signature ?? `Exported project symbol ${symbol.name}`,
          importance: 75,
          dimensionIds: [input.dimensionId],
          tags: ['project-context-export', symbol.kind],
        }))
      ),
    ].slice(0, MAX_PROJECT_SYMBOLS_FOR_CRITIC)
  );

  return { facts, files, modules, areas, symbols };
}

function buildSessionCompletenessTree(input: CompletionCriticInput): CompletenessProjectInfoTree {
  const snapshot = input.sessionSnapshot;
  const coveredFiles = new Set(input.referencedFiles.map(stripLineRange));
  const files = uniqueByPath([
    ...(snapshot?.allFiles ?? []).map((file) => {
      const path = file.filePath ?? file.relativePath ?? file.path ?? '';
      return {
        path,
        relativePath: path,
        name: path.split('/').pop(),
        summary: file.language ? `${file.language} source file` : 'Session source file',
        dimensionIds: [input.dimension.id],
        tags: ['session-cache', file.language ?? 'source'],
      };
    }),
    ...input.referencedFiles.map((filePath) => ({
      path: stripLineRange(filePath),
      relativePath: stripLineRange(filePath),
      name: stripLineRange(filePath).split('/').pop(),
      summary: 'File referenced by submitted Recipe evidence',
      dimensionIds: [input.dimension.id],
      tags: ['submitted-source-ref', 'covered'],
    })),
  ]).slice(0, MAX_PROJECT_FILES_FOR_CRITIC);
  const modules = uniqueAreas(
    (snapshot?.localPackageModules ?? []).map((pkg) => {
      const path = pkg.packageName ?? pkg.path ?? pkg.name ?? '';
      const covered = [...coveredFiles].some(
        (file) => path.length > 0 && (file === path || file.startsWith(`${path}/`))
      );
      return {
        name: pkg.name ?? pkg.packageName ?? path,
        description: covered
          ? `Local package already touched by submitted sourceRefs: ${path}`
          : `Local package not yet touched by submitted sourceRefs: ${path}`,
        importance: covered ? 55 : 95,
        dimensionIds: [input.dimension.id],
        tags: ['local-package', covered ? 'covered' : 'uncovered'],
        sourceRefs: sourceRefSlice([path]),
        keyFiles: sourceRefSlice([path]),
      };
    })
  );
  const areas = uniqueAreas([
    ...(snapshot?.targetsSummary ?? []).map((target) => ({
      name: target.name ?? target.path ?? 'target',
      description: `Build target${target.type ? ` (${target.type})` : ''}`,
      importance: 65,
      dimensionIds: [input.dimension.id],
      tags: ['target', target.type ?? 'target'],
      sourceRefs: sourceRefSlice([target.path, target.name]),
    })),
  ]);
  const facts: CompletenessProjectFact[] = input.referencedFiles.map((filePath, index) => ({
    id: `submitted-source-${index}`,
    title: `Submitted source evidence ${stripLineRange(filePath)}`,
    description: 'Already submitted evidence; used so the critic can avoid repeating covered refs.',
    importance: 40,
    dimensionIds: [input.dimension.id],
    tags: ['submitted-source-ref', 'covered'],
    sourceRefs: [filePath],
  }));
  return { facts, files, modules, areas };
}

function buildProjectContextFacts(
  dimensionId: string,
  analysis: HostAgentProjectContextAnalysis
): CompletenessProjectFact[] {
  const facts: CompletenessProjectFact[] = [
    {
      id: 'project-context-summary',
      title: 'ProjectContext project summary',
      description: `${analysis.fileCount} files, ${analysis.moduleCount} modules, primary language ${analysis.primaryLang}`,
      importance: 80,
      dimensionIds: [dimensionId],
      tags: ['project-context-summary', analysis.primaryLang],
      sourceRefs: sourceRefSlice([
        analysis.presenterInput.repo?.repo.ref?.scope.filePath,
        analysis.presenterInput.repo?.packageSystems[0]?.manifestRefs[0]?.scope.filePath,
        analysis.sourceFileFacts[0]?.filePath,
      ]),
    },
  ];
  for (const flow of analysis.presenterInput.map?.majorFlows ?? []) {
    facts.push({
      title: flow.summary,
      description: `Project major flow: ${flow.summary}`,
      importance: 85,
      dimensionIds: [dimensionId],
      tags: ['project-context-flow'],
      sourceRefs: sourceRefSlice(flow.refs.map((ref) => ref.scope.filePath)),
    });
  }
  for (const hotspot of analysis.presenterInput.map?.hotspots ?? []) {
    facts.push({
      title: hotspot.reason,
      description: `Project hotspot score ${hotspot.score}: ${hotspot.reason}`,
      importance: Math.max(60, Math.min(100, hotspot.score)),
      dimensionIds: [dimensionId],
      tags: ['project-context-hotspot'],
      sourceRefs: sourceRefSlice([hotspot.ref.scope.filePath]),
    });
  }
  return facts.filter((fact) => (fact.sourceRefs?.length ?? 0) > 0);
}

function buildDimensionMiningGuidance(input: {
  dimension: DimensionLike;
  projectInfoTree: CompletenessProjectInfoTree;
  projectSummary: { fileCount: number; moduleCount: number; primaryLang?: string | null };
}): CompletenessMiningGuidance[] {
  const dimensionTitle = input.dimension.label ?? input.dimension.id;
  const topSourceRefs = collectTopSourceRefs(input.projectInfoTree).slice(
    0,
    MAX_GUIDANCE_SOURCE_REFS
  );
  const knowledgeTypes = input.dimension.knowledgeTypes?.join(', ');
  return [
    {
      id: `${input.dimension.id}:definition`,
      title: `${dimensionTitle} defining project patterns`,
      description: [
        input.dimension.guide,
        knowledgeTypes ? `Knowledge types: ${knowledgeTypes}` : '',
        `Project scope: ${input.projectSummary.fileCount} files, ${input.projectSummary.moduleCount} modules, primary language ${input.projectSummary.primaryLang ?? 'unknown'}.`,
      ]
        .filter(Boolean)
        .join('\n'),
      importance: 100,
      keywords: dimensionKeywords(input.dimension),
      dimensionIds: [input.dimension.id],
      sourceRefs: topSourceRefs,
    },
    {
      id: `${input.dimension.id}:module-coverage`,
      title: `${dimensionTitle} module and source coverage`,
      description:
        'Prioritize grounded rules that cover project modules, local packages, public surfaces, and high-value source files instead of padding similar Recipes.',
      importance: 90,
      keywords: ['module', 'package', 'source', 'file', 'public', 'surface', 'coverage'],
      dimensionIds: [input.dimension.id],
      sourceRefs: topSourceRefs,
    },
    {
      id: `${input.dimension.id}:no-padding`,
      title: `${dimensionTitle} no-padding completion`,
      description:
        'Target five Recipes is advisory. If no more grounded project patterns exist, complete with noPadding and an explicit exhausted reason instead of inventing Recipes.',
      importance: 80,
      keywords: ['target', 'recipe', 'evidence', 'source', 'grounded', 'pattern'],
      dimensionIds: [input.dimension.id],
    },
  ];
}

function collectTopSourceRefs(tree: CompletenessProjectInfoTree): CompletenessSourceRefInput[] {
  return uniqueStrings([
    ...(tree.modules ?? []).flatMap((module) => sourceRefStrings(module.sourceRefs)),
    ...(tree.areas ?? []).flatMap((area) => sourceRefStrings(area.sourceRefs)),
    ...(tree.facts ?? []).flatMap((fact) => sourceRefStrings(fact.sourceRefs)),
    ...(tree.files ?? []).map((file) => file.relativePath ?? file.path ?? ''),
    ...(tree.symbols ?? []).map(
      (symbol) => symbol.relativePath ?? symbol.file ?? symbol.path ?? ''
    ),
  ]);
}

function sourceRefStrings(refs?: readonly CompletenessSourceRefInput[]): string[] {
  return (refs ?? [])
    .map((ref) =>
      typeof ref === 'string' ? ref : ref.path || ref.relativePath || ref.qualifiedPath || ''
    )
    .filter(Boolean);
}

function areaSourceRefs(
  primaryPath?: string,
  ownedFiles?: readonly string[]
): CompletenessSourceRefInput[] {
  return sourceRefSlice([primaryPath, ...(ownedFiles ?? [])]);
}

function sourceRefSlice(
  values: readonly (string | undefined)[] = []
): CompletenessSourceRefInput[] {
  return uniqueStrings(
    values.filter((value): value is string => Boolean(value)).map(stripLineRange)
  )
    .slice(0, 5)
    .map((path) => ({ path }));
}

function describeModuleSeed(
  role: string | undefined,
  modulePath: string | undefined,
  fileCount: number | undefined
): string {
  return [
    role ? `Project module role: ${role}.` : 'Project module.',
    modulePath ? `Path: ${modulePath}.` : '',
    typeof fileCount === 'number' ? `Owned files: ${fileCount}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function uniqueByPath(files: readonly CompletenessProjectFile[]): CompletenessProjectFile[] {
  const seen = new Set<string>();
  const out: CompletenessProjectFile[] = [];
  for (const file of files) {
    const path = stripLineRange(file.relativePath ?? file.path ?? '');
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push({ ...file, path, relativePath: path });
  }
  return out;
}

function uniqueAreas(areas: readonly CompletenessProjectArea[]): CompletenessProjectArea[] {
  const seen = new Set<string>();
  const out: CompletenessProjectArea[] = [];
  for (const area of areas) {
    const key = `${area.name}:${sourceRefStrings(area.sourceRefs).join(',')}`;
    if (!area.name || seen.has(key) || (area.sourceRefs?.length ?? 0) === 0) {
      continue;
    }
    seen.add(key);
    out.push(area);
  }
  return out;
}

function uniqueSymbols(symbols: readonly CompletenessProjectSymbol[]): CompletenessProjectSymbol[] {
  const seen = new Set<string>();
  const out: CompletenessProjectSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.name}:${symbol.relativePath ?? symbol.file ?? symbol.path ?? ''}`;
    if (!symbol.name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

function dimensionKeywords(dimension: DimensionLike): string[] {
  return uniqueStrings([
    ...dimension.id.split(/[-_\s]+/),
    ...(dimension.label ?? '').split(/[-_\s]+/),
    ...(dimension.guide ?? '').split(/[^a-zA-Z0-9]+/),
    ...(dimension.knowledgeTypes ?? []),
  ]).slice(0, 40);
}

function firstFileLanguage(files: readonly SessionSnapshotFileLike[] | undefined): string | null {
  return files?.find((file) => file.language)?.language ?? null;
}

function stripLineRange(value: string): string {
  return value.trim().replace(/:\d+(?:-\d+)?$/, '');
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
