import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseConnection } from '@alembic/core/database';
import {
  createSourceGraphFreshness,
  createSourceGraphStatusResult,
  type SourceGraphFreshnessState,
  SourceGraphRepositoryImpl,
  SourceGraphService,
  type SourceGraphStatusResult,
} from '@alembic/core/source-graph';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { CODEX_LOCAL_TOOLS } from '../../ToolPolicy.js';
import { projectSourceGraphOperationBusiness } from './output.js';

interface SourceGraphStatusOptions {
  catchUp?: boolean;
  maxCatchUpFiles?: number;
  now?: number;
  projectScope?: string;
  repoId?: string;
}

interface SourceGraphRuntime {
  connection: DatabaseConnection;
  databasePath: string;
  projectRoot: string;
  repoId: string;
  resolver: WorkspaceResolver;
  service: SourceGraphService;
}

interface SourceGraphRuntimeResolution {
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
      projectScope: options.projectScope,
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

async function inspectSourceGraphStatus(
  projectRoot: string,
  options: SourceGraphStatusOptions
): Promise<Record<string, unknown>> {
  const resolution = resolveSourceGraphRuntime(projectRoot, options);
  if ('error' in resolution) {
    return projectRuntimeStatus(resolution.error, resolution.context);
  }
  if (!resolution.databaseExists) {
    return projectRuntimeStatus(createUninitializedStatus(resolution.projectRoot, options), {
      databaseExists: false,
      runtimeReady: true,
    });
  }

  try {
    const runtime = await getSourceGraphRuntime(resolution);
    const report = await runtime.service.inspectFreshness({
      projectRoot: runtime.projectRoot,
      repoId: runtime.repoId,
      projectScope: options.projectScope,
      now: options.now,
    });
    const catchUp = await maybeCatchUpSourceGraph(runtime, report, options);
    return projectRuntimeStatus(catchUp.status, {
      catchUp: catchUp.catchUp,
      databaseExists: true,
      runtimeReady: true,
    });
  } catch (err: unknown) {
    return projectRuntimeStatus(createUnavailableStatus(projectRoot, options, err), {
      databaseExists: resolution.databaseExists,
      runtimeReady: false,
    });
  }
}

async function maybeCatchUpSourceGraph(
  runtime: SourceGraphRuntime,
  report: Awaited<ReturnType<SourceGraphService['inspectFreshness']>>,
  options: SourceGraphStatusOptions
): Promise<{ catchUp: SourceGraphCatchUpState; status: SourceGraphStatusResult }> {
  const changedFiles = report.changedFiles;
  const deletedFiles = report.deletedFiles;
  const catchUp: SourceGraphCatchUpState = {
    attempted: false,
    changedFiles,
    deletedFiles,
  };

  if (options.catchUp === false || report.freshness.status !== 'stale') {
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
      projectScope: options.projectScope,
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
  const repoId = normalizeStringOption(options.repoId) ?? DEFAULT_REPO_ID;
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    return {
      context: { databaseExists: false, runtimeReady: false },
      error: createWrongScopeStatus(resolvedRoot, options),
    };
  }
  try {
    const resolver = WorkspaceResolver.fromProject(resolvedRoot);
    return {
      databaseExists: options.createDatabase === true || existsSync(resolver.databasePath),
      projectRoot: resolver.projectRoot,
      projectScope: normalizeStringOption(options.projectScope),
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
  const cacheKey = [
    resolution.resolver.databasePath,
    resolution.projectRoot,
    resolution.repoId,
    resolution.projectScope ?? '',
  ].join('\0');
  let runtimePromise = SOURCE_GRAPH_RUNTIME_CACHE.get(cacheKey);
  if (!runtimePromise) {
    runtimePromise = openSourceGraphRuntime(resolution);
    SOURCE_GRAPH_RUNTIME_CACHE.set(cacheKey, runtimePromise);
  }
  return runtimePromise;
}

async function openSourceGraphRuntime(
  resolution: SourceGraphRuntimeResolution
): Promise<SourceGraphRuntime> {
  const connection = new DatabaseConnection(
    { path: resolution.resolver.databasePath },
    resolution.resolver
  );
  await connection.connect();
  await runMigrationsQuietly(connection);
  const repository = new SourceGraphRepositoryImpl(connection.getDrizzle());
  return {
    connection,
    databasePath: resolution.resolver.databasePath,
    projectRoot: resolution.projectRoot,
    repoId: resolution.repoId,
    resolver: resolution.resolver,
    service: new SourceGraphService(repository),
  };
}

async function runMigrationsQuietly(connection: DatabaseConnection): Promise<void> {
  const previous = process.env.ALEMBIC_QUIET;
  process.env.ALEMBIC_QUIET = '1';
  try {
    await connection.runMigrations();
  } finally {
    if (previous === undefined) {
      delete process.env.ALEMBIC_QUIET;
    } else {
      process.env.ALEMBIC_QUIET = previous;
    }
  }
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
  options: SourceGraphStatusOptions
): SourceGraphStatusResult {
  const freshness = createSourceGraphFreshness({
    status: 'wrong-scope',
    checkedAt: options.now,
    reason: 'The requested projectRoot does not exist or is not a directory.',
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
        message: 'Select a valid projectRoot before reading source graph facts.',
        nextAction: 'select_project_scope',
        invalidConclusion: 'source graph facts belong to the active project scope',
        blocksReady: true,
      },
    ],
  });
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

function buildSourceGraphInitializeGuidance(): Record<string, unknown> {
  const toolNames = CODEX_LOCAL_TOOLS.map((tool) => tool.name);
  const sourceGraphTools = toolNames.filter(
    (toolName) => toolName === 'alembic_source_graph_status'
  );
  const recoveryTools = toolNames.filter((toolName) =>
    ['alembic_codex_init', 'alembic_codex_bootstrap', 'alembic_codex_rescan'].includes(toolName)
  );
  return {
    sourceGraphTools,
    recoveryTools,
    playbook: [
      'Use alembic_source_graph_status first to inspect source graph lifecycle and freshness.',
      'Trust source facts only when sourceGraphFresh is true and ready is true.',
      'When status reports needs_source_graph_init or run_incremental_source_graph_index, run an authorized Core source graph build or catch-up path before source queries.',
    ],
  };
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

function normalizeStringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
