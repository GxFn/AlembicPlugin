import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { buildCodexMcpGuidance } from '../../../runtime/mcp/host/guidance.js';
import {
  projectSourceGraphOperationBusiness,
  SOURCE_GRAPH_OPERATION_TOOL_NAMES,
  type SourceGraphOperationToolName,
} from '../../../runtime/mcp/source-graph/output.js';
import { CODEX_LOCAL_TOOLS } from '../../../runtime/ToolPolicy.js';

type SourceGraphFreshnessState =
  | 'fresh'
  | 'partial'
  | 'stale'
  | 'pending'
  | 'degraded'
  | 'uninitialized'
  | 'wrong-scope'
  | 'unavailable';

interface SourceGraphFreshness {
  checkedAt?: number;
  degradedReason?: string;
  generationId?: string;
  indexedAt?: number;
  nextAction?: string;
  pendingFileCount?: number;
  reason?: string;
  staleFileCount?: number;
  status: SourceGraphFreshnessState;
}

interface SourceGraphDiagnostic {
  blocksReady?: boolean;
  code: string;
  filePath?: string;
  invalidConclusion?: string;
  line?: number;
  message: string;
  nextAction?: string;
  owner?: string;
  severity: 'info' | 'warning' | 'error';
}

interface SourceGraphCounts {
  edgeCount: number;
  fileCount: number;
  parseErrorCount: number;
  symbolCount: number;
}

interface SourceGraphStatusResult {
  counts: SourceGraphCounts;
  detailRefs: Array<Record<string, unknown>>;
  diagnostics: SourceGraphDiagnostic[];
  freshness: SourceGraphFreshness;
  generationId?: string;
  nextActions: string[];
  projectRoot: string;
  ready: boolean;
  repoId: string;
}

type SourceGraphOperationResult = SourceGraphStatusResult & Record<string, unknown>;

interface SourceGraphFreshnessInput extends Omit<SourceGraphFreshness, 'checkedAt'> {
  checkedAt?: number;
}

interface SourceGraphStatusInput {
  counts?: Partial<SourceGraphCounts>;
  detailRefs?: Array<Record<string, unknown>>;
  diagnostics?: SourceGraphDiagnostic[];
  freshness: SourceGraphFreshness;
  generationId?: string;
  nextActions?: string[];
  projectRoot: string;
  repoId: string;
}

interface SourceGraphIndexResult {
  changedFiles: string[];
  deletedFiles: string[];
  status: SourceGraphStatusResult;
}

interface SourceGraphFreshnessReport {
  changedFiles: string[];
  deletedFiles: string[];
  freshness: SourceGraphFreshness;
  snapshot?: { generationId?: string };
  status: SourceGraphStatusResult;
}

interface SourceGraphServiceLike {
  buildFullIndex(input: Record<string, unknown>): Promise<SourceGraphIndexResult>;
  buildIncrementalIndex(input: Record<string, unknown>): Promise<SourceGraphIndexResult>;
  exploreSourceGraph(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  getSourceGraphAffectedTests(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  getSourceGraphCallees(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  getSourceGraphCallers(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  getSourceGraphImpact(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  getSourceGraphNode(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  getSourceGraphValidationPlan(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
  inspectFreshness(input: Record<string, unknown>): Promise<SourceGraphFreshnessReport>;
  searchSourceGraph(input: Record<string, unknown>): Promise<SourceGraphOperationResult>;
}

function createSourceGraphFreshness(input: SourceGraphFreshnessInput): SourceGraphFreshness {
  return {
    ...input,
    checkedAt: input.checkedAt ?? Date.now(),
  };
}

function createSourceGraphStatusResult(input: SourceGraphStatusInput): SourceGraphStatusResult {
  const counts = {
    edgeCount: input.counts?.edgeCount ?? 0,
    fileCount: input.counts?.fileCount ?? 0,
    parseErrorCount: input.counts?.parseErrorCount ?? 0,
    symbolCount: input.counts?.symbolCount ?? 0,
  };
  return {
    counts,
    detailRefs: input.detailRefs ?? [],
    diagnostics: input.diagnostics ?? [],
    freshness: input.freshness,
    generationId: input.generationId ?? input.freshness.generationId,
    nextActions: input.nextActions ?? [input.freshness.nextAction].filter(isString),
    projectRoot: input.projectRoot,
    ready: input.freshness.status === 'fresh' && Boolean(input.generationId),
    repoId: input.repoId,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function createSourceGraphSearchResult(input: SourceGraphOperationResult): SourceGraphOperationResult {
  return { symbols: [], sourceSections: [], edges: [], ...input };
}

function createSourceGraphExploreResult(input: SourceGraphOperationResult): SourceGraphOperationResult {
  return { symbols: [], sourceSections: [], edges: [], ...input };
}

function createSourceGraphNodeResult(input: SourceGraphOperationResult): SourceGraphOperationResult {
  return { sourceSections: [], edges: [], ...input };
}

function createSourceGraphCallersResult(input: SourceGraphOperationResult): SourceGraphOperationResult {
  return { callers: [], sourceSections: [], edges: [], ...input };
}

function createSourceGraphCalleesResult(input: SourceGraphOperationResult): SourceGraphOperationResult {
  return { callees: [], sourceSections: [], edges: [], ...input };
}

function createSourceGraphImpactResult(input: SourceGraphOperationResult): SourceGraphOperationResult {
  return { impactedFiles: [], edges: [], affectedValidations: [], ...input };
}

function createSourceGraphAffectedTestsResult(
  input: SourceGraphOperationResult
): SourceGraphOperationResult {
  return { testFiles: [], ...input };
}

function createSourceGraphValidationPlanResult(
  input: SourceGraphOperationResult
): SourceGraphOperationResult {
  return {
    impactedFiles: [],
    impactedSymbols: [],
    validationPlan: [],
    ...input,
  };
}

interface SourceGraphStatusOptions {
  catchUp?: boolean;
  maxCatchUpFiles?: number;
  now?: number;
  projectScope?: string;
  repoId?: string;
}

interface SourceGraphOperationOptions extends SourceGraphStatusOptions {
  changedFiles?: string[];
  contextLines?: number;
  edgeLimit?: number;
  filePath?: string;
  focus?: string;
  generationId?: string;
  includeConfig?: boolean;
  includeEdges?: boolean;
  includeGenerated?: boolean;
  includeTests?: boolean;
  includeText?: boolean;
  kind?: string;
  limit?: number;
  maxSectionLines?: number;
  nodeId?: string;
  packageScripts?: Record<string, string>;
  query?: string;
  sourceSectionLineBudget?: number;
  symbolIds?: string[];
  symbolId?: string;
}

interface SourceGraphRuntime {
  connection: { close(): void };
  databasePath: string;
  coreProjectScope?: string;
  projectRoot: string;
  repoId: string;
  resolver: WorkspaceResolver;
  service: SourceGraphServiceLike;
}

interface SourceGraphRuntimeResolution {
  coreProjectScope?: string;
  databaseExists: boolean;
  projectRoot: string;
  projectScope?: string;
  repoId: string;
  resolver: WorkspaceResolver;
}

interface SourceGraphCatchUpState {
  attempted: boolean;
  changedFiles: string[];
  deletedFiles: string[];
  reason?: string;
  skipped?: boolean;
  succeeded?: boolean;
}

interface SourceGraphRuntimeAction {
  code: string;
  description: string;
}

const DEFAULT_REPO_ID = 'default';
const DEFAULT_MAX_CATCH_UP_FILES = 50;
const SOURCE_GRAPH_QUERY_TOOL_NAMES = SOURCE_GRAPH_OPERATION_TOOL_NAMES.filter(
  (toolName) => toolName !== 'alembic_source_graph_status'
) as Exclude<SourceGraphOperationToolName, 'alembic_source_graph_status'>[];

// Reuse Core source graph runtimes per project inside one Codex MCP session.
const SOURCE_GRAPH_RUNTIME_CACHE = new Map<string, Promise<SourceGraphRuntime>>();

export async function buildSourceGraphStatus(
  projectRoot: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const options = normalizeSourceGraphStatusOptions(args);
  const business = await inspectSourceGraphStatus(projectRoot, options);
  return { success: true, data: business };
}

export async function buildSourceGraphOperation(
  projectRoot: string,
  args: Record<string, unknown> = {},
  toolName: string
): Promise<Record<string, unknown>> {
  if (!isSourceGraphQueryToolName(toolName)) {
    return buildSourceGraphStatus(projectRoot, args);
  }
  const options = normalizeSourceGraphOperationOptions(args);
  const business = await inspectSourceGraphOperation(projectRoot, options, toolName);
  return { success: true, data: business };
}

export async function buildFullSourceGraphIndexForProject(
  projectRoot: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const options = normalizeSourceGraphStatusOptions(args);
  const resolution = resolveSourceGraphRuntime(projectRoot, { ...options, createDatabase: true });
  if ('error' in resolution) {
    return { success: true, data: projectRuntimeStatus(resolution.error, resolution.context) };
  }

  try {
    const runtime = await getSourceGraphRuntime(resolution);
    const result = await runtime.service.buildFullIndex({
      projectRoot: runtime.projectRoot,
      repoId: runtime.repoId,
      projectScope: runtime.coreProjectScope,
      now: options.now,
    });
    return {
      success: true,
      data: projectRuntimeStatus(result.status, {
        catchUp: {
          attempted: true,
          changedFiles: result.changedFiles,
          deletedFiles: result.deletedFiles,
          succeeded: true,
        },
        databaseExists: true,
        runtimeReady: true,
      }),
    };
  } catch (err: unknown) {
    return {
      success: true,
      data: projectRuntimeStatus(createUnavailableStatus(projectRoot, options, err), {
        databaseExists: resolution.databaseExists,
        runtimeReady: false,
      }),
    };
  }
}

export async function resetSourceGraphRuntimeCacheForTests(): Promise<void> {
  await Promise.allSettled(
    Array.from(SOURCE_GRAPH_RUNTIME_CACHE.values(), async (runtimePromise) => {
      const runtime = await runtimePromise;
      runtime.connection.close();
    })
  );
  SOURCE_GRAPH_RUNTIME_CACHE.clear();
}

async function inspectSourceGraphOperation(
  projectRoot: string,
  options: SourceGraphOperationOptions,
  toolName: Exclude<SourceGraphOperationToolName, 'alembic_source_graph_status'>
): Promise<Record<string, unknown>> {
  const resolution = resolveSourceGraphRuntime(projectRoot, options);
  if ('error' in resolution) {
    return projectOperationResult(resolution.error, options, toolName);
  }
  const hasRuntime = hasCachedSourceGraphRuntime(resolution);
  if (!resolution.databaseExists && !hasRuntime && options.catchUp === false) {
    return projectOperationResult(
      createUninitializedStatus(resolution.projectRoot, options),
      options,
      toolName
    );
  }

  try {
    const runtime = await getSourceGraphRuntime(resolution);
    const catchUp =
      !resolution.databaseExists && !hasRuntime
        ? await buildInitialSourceGraphIndex(runtime, options)
        : await inspectAndMaybeCatchUpSourceGraph(runtime, options);
    if (!canQuerySourceGraph(catchUp.status)) {
      return projectOperationResult(catchUp.status, options, toolName);
    }
    const result = await queryCoreSourceGraph(runtime, catchUp.status, options, toolName);
    return projectSourceGraphOperationBusiness(result, toolName);
  } catch (err: unknown) {
    return projectOperationResult(
      createUnavailableStatus(resolution.projectRoot, options, err),
      options,
      toolName
    );
  }
}

async function inspectSourceGraphStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions
): Promise<Record<string, unknown>> {
  const resolution = resolveSourceGraphRuntime(projectRoot, options);
  if ('error' in resolution) {
    return projectRuntimeStatus(resolution.error, resolution.context);
  }
  const hasRuntime = hasCachedSourceGraphRuntime(resolution);
  if (!resolution.databaseExists && !hasRuntime && options.catchUp === false) {
    return projectRuntimeStatus(createUninitializedStatus(resolution.projectRoot, options), {
      databaseExists: false,
      runtimeReady: true,
    });
  }

  try {
    const runtime = await getSourceGraphRuntime(resolution);
    const catchUp =
      !resolution.databaseExists && !hasRuntime
        ? await buildInitialSourceGraphIndex(runtime, options)
        : await inspectAndMaybeCatchUpSourceGraph(runtime, options);
    return projectRuntimeStatus(catchUp.status, {
      catchUp: catchUp.catchUp,
      databaseExists: true,
      runtimeReady: true,
    });
  } catch (err: unknown) {
    return projectRuntimeStatus(createUnavailableStatus(resolution.projectRoot, options, err), {
      databaseExists: resolution.databaseExists,
      runtimeReady: false,
    });
  }
}

async function queryCoreSourceGraph(
  runtime: SourceGraphRuntime,
  status: SourceGraphStatusResult,
  options: SourceGraphOperationOptions,
  toolName: Exclude<SourceGraphOperationToolName, 'alembic_source_graph_status'>
): Promise<SourceGraphOperationResult> {
  const ranking = {
    generationId: options.generationId ?? status.generationId,
    projectRoot: runtime.projectRoot,
    repoId: runtime.repoId,
    limit: options.limit,
    kind: options.kind,
    filePath: options.filePath,
    includeEdges: options.includeEdges,
    includeText: options.includeText,
    includeTests: options.includeTests,
    includeGenerated: options.includeGenerated,
    includeConfig: options.includeConfig,
    contextLines: options.contextLines,
    maxSectionLines: options.maxSectionLines,
    sourceSectionLineBudget: options.sourceSectionLineBudget,
    edgeLimit: options.edgeLimit,
  };

  switch (toolName) {
    case 'alembic_symbol_search':
      return runtime.service.searchSourceGraph({
        ...ranking,
        query: sourceGraphQueryString(options),
      });
    case 'alembic_code_explore':
      return runtime.service.exploreSourceGraph({
        ...ranking,
        query: options.query,
        focus: options.focus,
      });
    case 'alembic_source_node':
      return runtime.service.getSourceGraphNode({
        ...ranking,
        nodeId: sourceGraphNodeId(options),
      });
    case 'alembic_callers':
      return runtime.service.getSourceGraphCallers({
        ...ranking,
        symbolId: sourceGraphSymbolId(options),
      });
    case 'alembic_callees':
      return runtime.service.getSourceGraphCallees({
        ...ranking,
        symbolId: sourceGraphSymbolId(options),
      });
    case 'alembic_code_impact':
      return runtime.service.getSourceGraphImpact({
        ...ranking,
        changedFiles: options.changedFiles,
        symbolId: options.symbolId,
      });
    case 'alembic_affected_tests':
      return runtime.service.getSourceGraphAffectedTests({
        ...ranking,
        changedFiles: options.changedFiles ?? [],
      });
    case 'alembic_validation_plan':
      return runtime.service.getSourceGraphValidationPlan({
        ...ranking,
        changedFiles: options.changedFiles ?? [],
        packageScripts: options.packageScripts,
        symbolIds: options.symbolIds ?? [],
      });
  }
}

function projectOperationResult(
  status: SourceGraphStatusResult,
  options: SourceGraphOperationOptions,
  toolName: Exclude<SourceGraphOperationToolName, 'alembic_source_graph_status'>
): Record<string, unknown> {
  return projectSourceGraphOperationBusiness(
    createBlockedOperationResult(status, options, toolName),
    toolName
  );
}

function createBlockedOperationResult(
  status: SourceGraphStatusResult,
  options: SourceGraphOperationOptions,
  toolName: Exclude<SourceGraphOperationToolName, 'alembic_source_graph_status'>
): SourceGraphOperationResult {
  const base = {
    counts: status.counts,
    ready: status.ready,
    generationId: status.generationId,
    projectRoot: status.projectRoot,
    repoId: status.repoId,
    freshness: status.freshness,
    diagnostics: status.diagnostics,
    detailRefs: status.detailRefs,
    nextActions: status.nextActions,
  };
  switch (toolName) {
    case 'alembic_symbol_search':
      return createSourceGraphSearchResult({
        ...base,
        query: sourceGraphQueryString(options),
      });
    case 'alembic_code_explore':
      return createSourceGraphExploreResult({
        ...base,
        query: options.query,
        focus: options.focus,
      });
    case 'alembic_source_node':
      return createSourceGraphNodeResult({
        ...base,
        nodeId: sourceGraphNodeId(options),
      });
    case 'alembic_callers':
      return createSourceGraphCallersResult({
        ...base,
        symbolId: sourceGraphSymbolId(options),
      });
    case 'alembic_callees':
      return createSourceGraphCalleesResult({
        ...base,
        symbolId: sourceGraphSymbolId(options),
      });
    case 'alembic_code_impact':
      return createSourceGraphImpactResult({
        ...base,
        changedFiles: options.changedFiles,
      });
    case 'alembic_affected_tests':
      return createSourceGraphAffectedTestsResult({
        ...base,
        changedFiles: options.changedFiles,
        unknownReason: status.freshness.reason ?? 'Source graph is not fresh enough to map tests.',
      });
    case 'alembic_validation_plan':
      return createSourceGraphValidationPlanResult({
        ...base,
        changedFiles: options.changedFiles,
        seedSymbols: options.symbolIds,
        unknown: [
          {
            kind: 'unknown',
            label: 'Source graph validation plan unavailable',
            diagnosticCode: 'source-ref-unproven',
            reason:
              status.freshness.reason ??
              'Source graph is not fresh enough to plan validation from source facts.',
            evidence: [
              {
                kind: 'diagnostic',
                ref: 'source-ref-unproven',
                diagnosticCode: 'source-ref-unproven',
                reason: 'Source graph freshness blocks validation planning.',
              },
            ],
          },
        ],
      });
  }
}

async function maybeCatchUpSourceGraph(
  runtime: SourceGraphRuntime,
  report: SourceGraphFreshnessReport,
  options: SourceGraphStatusOptions
): Promise<{ catchUp: SourceGraphCatchUpState; status: SourceGraphStatusResult }> {
  const changedFiles = report.changedFiles;
  const deletedFiles = report.deletedFiles;
  const catchUp: SourceGraphCatchUpState = {
    attempted: false,
    changedFiles,
    deletedFiles,
  };

  if (options.catchUp === false) {
    return { catchUp, status: report.status };
  }

  if (report.freshness.status === 'uninitialized') {
    try {
      return await buildInitialSourceGraphIndex(runtime, options);
    } catch (err: unknown) {
      return {
        catchUp: {
          ...catchUp,
          attempted: true,
          reason: errorMessage(err),
          succeeded: false,
        },
        status: createInitialIndexFailedStatus(runtime.projectRoot, options, report.status, err),
      };
    }
  }

  if (report.freshness.status !== 'stale') {
    return { catchUp, status: report.status };
  }

  const maxCatchUpFiles = options.maxCatchUpFiles ?? DEFAULT_MAX_CATCH_UP_FILES;
  if (changedFiles.length + deletedFiles.length > maxCatchUpFiles) {
    return {
      catchUp: {
        ...catchUp,
        reason: 'too-many-pending-files-for-bounded-catch-up',
        skipped: true,
      },
      status: report.status,
    };
  }

  try {
    const result = await runtime.service.buildIncrementalIndex({
      projectRoot: runtime.projectRoot,
      repoId: runtime.repoId,
      projectScope: runtime.coreProjectScope,
      baseGenerationId: report.snapshot?.generationId,
      changedFiles,
      deletedFiles,
      now: options.now,
    });
    return {
      catchUp: { ...catchUp, attempted: true, succeeded: true },
      status: result.status,
    };
  } catch (err: unknown) {
    return {
      catchUp: {
        ...catchUp,
        attempted: true,
        reason: errorMessage(err),
        succeeded: false,
      },
      status: createDegradedStatus(runtime.projectRoot, options, report.status, err),
    };
  }
}

async function inspectAndMaybeCatchUpSourceGraph(
  runtime: SourceGraphRuntime,
  options: SourceGraphStatusOptions
): Promise<{ catchUp: SourceGraphCatchUpState; status: SourceGraphStatusResult }> {
  const report = await runtime.service.inspectFreshness({
    projectRoot: runtime.projectRoot,
    repoId: runtime.repoId,
    projectScope: runtime.coreProjectScope,
    now: options.now,
  });
  return maybeCatchUpSourceGraph(runtime, report, options);
}

async function buildInitialSourceGraphIndex(
  runtime: SourceGraphRuntime,
  options: SourceGraphStatusOptions
): Promise<{ catchUp: SourceGraphCatchUpState; status: SourceGraphStatusResult }> {
  const result = await runtime.service.buildFullIndex({
    projectRoot: runtime.projectRoot,
    repoId: runtime.repoId,
    projectScope: runtime.coreProjectScope,
    now: options.now,
  });
  return {
    catchUp: {
      attempted: true,
      changedFiles: result.changedFiles,
      deletedFiles: result.deletedFiles,
      succeeded: true,
    },
    status: result.status,
  };
}

function projectRuntimeStatus(
  status: SourceGraphStatusResult,
  context: {
    catchUp?: SourceGraphCatchUpState;
    databaseExists?: boolean;
    runtimeReady?: boolean;
  } = {}
): Record<string, unknown> {
  const business = projectSourceGraphOperationBusiness(status, 'alembic_source_graph_status');
  const freshness = status.freshness.status;
  const actions = sourceGraphActionsForFreshness(freshness);
  return {
    ...business,
    nextActions: uniqueStrings([
      ...stringArray(business.nextActions),
      ...actions.map((action) => action.code),
    ]),
    lifecycle: {
      mcpInstalled: true,
      runtimeReady: context.runtimeReady !== false,
      knowledgeSynced: null,
      sourceGraphInitialized: freshness !== 'uninitialized' && freshness !== 'wrong-scope',
      sourceGraphIndexed: Boolean(status.generationId) && status.counts.fileCount > 0,
      sourceGraphFresh: status.ready === true && freshness === 'fresh',
      watcher: {
        mode: 'unavailable',
        nextAction: 'run_incremental_source_graph_index',
      },
      catchUp: context.catchUp ?? {
        attempted: false,
        changedFiles: [],
        deletedFiles: [],
      },
      databaseExists: context.databaseExists ?? true,
    },
    guidance: buildSourceGraphInitializeGuidance(),
    actions,
  };
}

function resolveSourceGraphRuntime(
  projectRoot: string,
  options: SourceGraphStatusOptions & { createDatabase?: boolean }
):
  | SourceGraphRuntimeResolution
  | {
      context: { databaseExists: boolean; runtimeReady: false };
      error: SourceGraphStatusResult;
    } {
  const resolvedRoot = path.resolve(projectRoot);
  const projectScope = normalizeStringOption(options.projectScope);
  const repoId = normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID;
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    return {
      context: { databaseExists: false, runtimeReady: false },
      error: createWrongScopeStatus(resolvedRoot, options),
    };
  }
  const scopedRoot = resolveProjectScopeRoot(resolvedRoot, projectScope);
  if (scopedRoot?.error) {
    return {
      context: { databaseExists: false, runtimeReady: false },
      error: createWrongScopeStatus(resolvedRoot, options, {
        reason: `Project scope is not a readable child repository: ${projectScope ?? ''}`,
        message: 'Select a valid projectScope child repository before reading source graph facts.',
      }),
    };
  }
  if (!projectScope && isWorkspaceControlRoot(resolvedRoot)) {
    return {
      context: { databaseExists: false, runtimeReady: false },
      error: createWrongScopeStatus(resolvedRoot, options, {
        reason: 'Workspace control roots require an explicit projectScope for source graph facts.',
        message:
          'Select a product projectScope before reading source graph facts from a workspace root.',
      }),
    };
  }
  const effectiveRoot = scopedRoot?.projectRoot ?? resolvedRoot;
  try {
    const resolver = WorkspaceResolver.fromProject(effectiveRoot);
    return {
      databaseExists: options.createDatabase === true || existsSync(resolver.databasePath),
      coreProjectScope: scopedRoot?.coreProjectScope,
      projectRoot: resolver.projectRoot,
      projectScope,
      repoId,
      resolver,
    };
  } catch (err: unknown) {
    return {
      context: { databaseExists: false, runtimeReady: false },
      error: createUnavailableStatus(resolvedRoot, options, err),
    };
  }
}

function getSourceGraphRuntime(
  resolution: SourceGraphRuntimeResolution
): Promise<SourceGraphRuntime> {
  const cacheKey = sourceGraphRuntimeCacheKey(resolution);
  let runtimePromise = SOURCE_GRAPH_RUNTIME_CACHE.get(cacheKey);
  if (!runtimePromise) {
    runtimePromise = openSourceGraphRuntime(resolution);
    SOURCE_GRAPH_RUNTIME_CACHE.set(cacheKey, runtimePromise);
  }
  return runtimePromise;
}

function hasCachedSourceGraphRuntime(resolution: SourceGraphRuntimeResolution): boolean {
  return SOURCE_GRAPH_RUNTIME_CACHE.has(sourceGraphRuntimeCacheKey(resolution));
}

function sourceGraphRuntimeCacheKey(resolution: SourceGraphRuntimeResolution): string {
  return [
    resolution.resolver.databasePath,
    resolution.projectRoot,
    resolution.repoId,
    resolution.coreProjectScope ?? '',
  ].join('\0');
}

async function openSourceGraphRuntime(
  resolution: SourceGraphRuntimeResolution
): Promise<SourceGraphRuntime> {
  void resolution;
  throw new Error(
    'Core source graph public runtime has been withdrawn; use ProjectContext-backed project graph tools for current project structure facts.'
  );
}

function createUninitializedStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions
): SourceGraphStatusResult {
  const freshness = createSourceGraphFreshness({
    status: 'uninitialized',
    checkedAt: options.now,
    reason: 'No Alembic database or source graph generation exists for this project.',
    nextAction: 'needs_source_graph_init',
  });
  return createSourceGraphStatusResult({
    projectRoot,
    repoId: normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID,
    freshness,
    diagnostics: [
      {
        code: 'source-ref-unproven',
        severity: 'warning',
        owner: 'plugin',
        message: 'Source graph is not initialized for this project.',
        nextAction: 'needs_source_graph_init',
        invalidConclusion: 'source graph facts are ready for this project',
        blocksReady: true,
      },
    ],
  });
}

function createWrongScopeStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions,
  detail: { message?: string; reason?: string } = {}
): SourceGraphStatusResult {
  const freshness = createSourceGraphFreshness({
    status: 'wrong-scope',
    checkedAt: options.now,
    reason: detail.reason ?? 'The requested projectRoot does not exist or is not a directory.',
    nextAction: 'select_project_scope',
  });
  return createSourceGraphStatusResult({
    projectRoot,
    repoId: normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID,
    freshness,
    diagnostics: [
      {
        code: 'ambiguous-project-scope',
        severity: 'error',
        owner: 'plugin',
        message: detail.message ?? 'Select a valid projectRoot before reading source graph facts.',
        nextAction: 'select_project_scope',
        invalidConclusion: 'source graph facts belong to the active project scope',
        blocksReady: true,
      },
    ],
  });
}

function resolveProjectScopeRoot(
  projectRoot: string,
  projectScope: string | undefined
): { coreProjectScope?: string; error?: true; projectRoot: string } | null {
  if (!projectScope) {
    return null;
  }
  if (path.isAbsolute(projectScope) || projectScope.split(/[\\/]+/).includes('..')) {
    return { error: true, projectRoot };
  }
  const candidate = path.resolve(projectRoot, projectScope);
  if (!isPathInsideOrEqual(projectRoot, candidate)) {
    return { error: true, projectRoot };
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    return { error: true, projectRoot };
  }
  return { projectRoot: candidate };
}

function isWorkspaceControlRoot(projectRoot: string): boolean {
  return (
    existsSync(path.join(projectRoot, 'workspace.config.json')) ||
    existsSync(path.join(projectRoot, '.workspace-active', 'workspace', 'index.md'))
  );
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createUnavailableStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions,
  err: unknown
): SourceGraphStatusResult {
  const freshness = createSourceGraphFreshness({
    status: 'unavailable',
    checkedAt: options.now,
    reason: 'Core source graph runtime could not be opened.',
    nextAction: 'inspect_source_graph_runtime',
    degradedReason: errorMessage(err),
  });
  return createSourceGraphStatusResult({
    projectRoot,
    repoId: normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID,
    freshness,
    diagnostics: [
      {
        code: 'catch-up-failed',
        severity: 'error',
        owner: 'plugin',
        message: `Core source graph runtime open failed: ${errorMessage(err)}`,
        nextAction: 'inspect_source_graph_runtime',
        invalidConclusion: 'source graph runtime is available',
        blocksReady: true,
      },
    ],
  });
}

function createDegradedStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions,
  previous: SourceGraphStatusResult,
  err: unknown
): SourceGraphStatusResult {
  const freshness = createSourceGraphFreshness({
    status: 'degraded',
    checkedAt: options.now,
    generationId: previous.generationId,
    indexedAt: previous.freshness.indexedAt,
    reason: 'Core source graph incremental catch-up failed.',
    nextAction: 'run_incremental_source_graph_index',
    pendingFileCount: previous.freshness.pendingFileCount,
    staleFileCount: previous.freshness.staleFileCount,
    degradedReason: errorMessage(err),
  });
  return createSourceGraphStatusResult({
    generationId: previous.generationId,
    projectRoot,
    repoId: normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID,
    freshness,
    counts: previous.counts,
    diagnostics: [
      ...previous.diagnostics,
      {
        code: 'catch-up-failed',
        severity: 'error',
        owner: 'plugin',
        message: `Core source graph catch-up failed: ${errorMessage(err)}`,
        nextAction: 'run_incremental_source_graph_index',
        invalidConclusion: 'source graph is fresh after file changes',
        blocksReady: true,
      },
    ],
  });
}

function createInitialIndexFailedStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions,
  previous: SourceGraphStatusResult,
  err: unknown
): SourceGraphStatusResult {
  const freshness = createSourceGraphFreshness({
    status: 'unavailable',
    checkedAt: options.now,
    reason: 'Core source graph initial build failed.',
    nextAction: 'build_source_graph',
    degradedReason: errorMessage(err),
  });
  return createSourceGraphStatusResult({
    projectRoot,
    repoId: normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID,
    freshness,
    counts: previous.counts,
    diagnostics: [
      ...previous.diagnostics,
      {
        code: 'catch-up-failed',
        severity: 'error',
        owner: 'plugin',
        message: `Core source graph initial build failed: ${errorMessage(err)}`,
        nextAction: 'build_source_graph',
        invalidConclusion: 'source graph is initialized for this project',
        blocksReady: true,
      },
    ],
  });
}

function buildSourceGraphInitializeGuidance(): Record<string, unknown> {
  const guidance = buildCodexMcpGuidance(CODEX_LOCAL_TOOLS);
  return {
    sourceGraphTools: guidance.sourceGraphTools,
    recoveryTools: guidance.recoveryTools,
    playbook: guidance.playbook,
    limitations: guidance.limitations,
  };
}

function isSourceGraphQueryToolName(
  toolName: string
): toolName is Exclude<SourceGraphOperationToolName, 'alembic_source_graph_status'> {
  return (SOURCE_GRAPH_QUERY_TOOL_NAMES as readonly string[]).includes(toolName);
}

function canQuerySourceGraph(status: SourceGraphStatusResult): boolean {
  return (
    Boolean(status.generationId) &&
    (status.freshness.status === 'fresh' ||
      status.freshness.status === 'partial' ||
      status.freshness.status === 'degraded')
  );
}

function sourceGraphActionsForFreshness(
  freshness: SourceGraphFreshnessState
): SourceGraphRuntimeAction[] {
  switch (freshness) {
    case 'uninitialized':
      return [
        {
          code: 'needs_source_graph_init',
          description: 'Initialize the Core source graph before trusting source facts.',
        },
      ];
    case 'stale':
    case 'pending':
      return [
        {
          code: 'run_incremental_source_graph_index',
          description: 'Run Core incremental source graph indexing for pending filesystem changes.',
        },
      ];
    case 'fresh':
      return [
        { code: 'source_graph_ready', description: 'Source graph freshness permits source facts.' },
      ];
    case 'partial':
    case 'degraded':
      return [
        {
          code: 'review_source_graph_diagnostics',
          description:
            'Use available source graph context with diagnostics; validate unsupported or degraded coverage with raw reads/tests.',
        },
      ];
    case 'wrong-scope':
      return [
        { code: 'select_project_scope', description: 'Select a valid projectRoot/repo scope.' },
      ];
    default:
      return [
        {
          code: 'inspect_source_graph_runtime',
          description: 'Inspect source graph runtime diagnostics before trusting source facts.',
        },
      ];
  }
}

function normalizeSourceGraphStatusOptions(
  args: Record<string, unknown>
): SourceGraphStatusOptions {
  return {
    catchUp: typeof args.catchUp === 'boolean' ? args.catchUp : undefined,
    maxCatchUpFiles:
      typeof args.maxCatchUpFiles === 'number' && Number.isInteger(args.maxCatchUpFiles)
        ? args.maxCatchUpFiles
        : undefined,
    projectScope: normalizeStringOption(args.projectScope),
    repoId: normalizeStringOption(args.repoId),
    now: typeof args.now === 'number' && Number.isFinite(args.now) ? args.now : undefined,
  };
}

function normalizeSourceGraphOperationOptions(
  args: Record<string, unknown>
): SourceGraphOperationOptions {
  return {
    ...normalizeSourceGraphStatusOptions(args),
    changedFiles: stringArray(args.changedFiles),
    contextLines: normalizeNumberOption(args.contextLines),
    edgeLimit: normalizeNumberOption(args.edgeLimit),
    filePath: normalizeStringOption(args.filePath),
    focus: normalizeStringOption(args.focus),
    generationId: normalizeStringOption(args.generationId),
    includeConfig: normalizeBooleanOption(args.includeConfig),
    includeEdges: normalizeBooleanOption(args.includeEdges),
    includeGenerated: normalizeBooleanOption(args.includeGenerated),
    includeTests: normalizeBooleanOption(args.includeTests),
    includeText: normalizeBooleanOption(args.includeText),
    kind: normalizeStringOption(args.kind),
    limit: normalizeNumberOption(args.limit),
    maxSectionLines: normalizeNumberOption(args.maxSectionLines),
    nodeId: normalizeStringOption(args.nodeId),
    packageScripts: normalizeStringRecord(args.packageScripts),
    query: normalizeStringOption(args.query),
    sourceSectionLineBudget: normalizeNumberOption(args.sourceSectionLineBudget),
    symbolIds: stringArray(args.symbolIds),
    symbolId: normalizeStringOption(args.symbolId),
  };
}

function sourceGraphQueryString(options: SourceGraphOperationOptions): string {
  return options.query ?? options.focus ?? options.filePath ?? options.kind ?? 'source-graph-query';
}

function sourceGraphNodeId(options: SourceGraphOperationOptions): string {
  return options.nodeId ?? options.symbolId ?? options.filePath ?? 'missing-source-node';
}

function sourceGraphSymbolId(options: SourceGraphOperationOptions): string {
  return options.symbolId ?? options.nodeId ?? 'missing-source-symbol';
}

function normalizeStringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// QD2 / F-V2-1: the source-graph wire schema declares typed fields (e.g.
// `limit: number`), but normalizeNumberOption/normalizeBooleanOption silently
// drop wrong-typed values, so the server used to ACCEPT `limit: "ten"` while a
// schema-validating client rejects it. This validator restores schema honesty:
// a field that is PRESENT but the wrong primitive type is reported so the
// dispatch boundary can reject it with a structured taxonomy error. Omitted
// (undefined/null) fields stay valid — only genuinely-malformed values fail,
// so every correctly-typed or omitted input still parses byte-identically.
type SourceGraphFieldType = 'number' | 'boolean' | 'string' | 'string-array';

// Mirrors the published SOURCE_GRAPH_COMMON_INPUT_PROPERTIES + per-tool string
// additions in ToolPolicy.ts. Internal-only fields (e.g. `now`) are not in the
// published schema and are intentionally excluded.
const SOURCE_GRAPH_TYPED_FIELDS: ReadonlyArray<readonly [string, SourceGraphFieldType]> = [
  ['maxCatchUpFiles', 'number'],
  ['limit', 'number'],
  ['contextLines', 'number'],
  ['maxSectionLines', 'number'],
  ['sourceSectionLineBudget', 'number'],
  ['edgeLimit', 'number'],
  ['catchUp', 'boolean'],
  ['includeEdges', 'boolean'],
  ['includeText', 'boolean'],
  ['includeTests', 'boolean'],
  ['includeGenerated', 'boolean'],
  ['includeConfig', 'boolean'],
  ['repoId', 'string'],
  ['projectScope', 'string'],
  ['generationId', 'string'],
  ['kind', 'string'],
  ['filePath', 'string'],
  ['query', 'string'],
  ['focus', 'string'],
  ['nodeId', 'string'],
  ['symbolId', 'string'],
  ['changedFiles', 'string-array'],
];

function matchesSourceGraphFieldType(value: unknown, type: SourceGraphFieldType): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'string-array':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  }
}

function describeSourceGraphReceivedType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Report source-graph args that are present but violate their declared wire
 * type. Returns one human-readable issue per offending field (empty = valid).
 * Pure: callers decide how to surface the rejection.
 */
export function findSourceGraphArgTypeIssues(args: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const [field, type] of SOURCE_GRAPH_TYPED_FIELDS) {
    const value = args[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (!matchesSourceGraphFieldType(value, type)) {
      const expected = type === 'string-array' ? 'array of strings' : type;
      issues.push(
        `${field} (expected ${expected}, received ${describeSourceGraphReceivedType(value)})`
      );
    }
  }
  return issues;
}

function normalizeNumberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeBooleanOption(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === 'string' &&
      entry[0].length > 0 &&
      typeof entry[1] === 'string' &&
      entry[1].length > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
