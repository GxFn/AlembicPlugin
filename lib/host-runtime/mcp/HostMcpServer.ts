import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Logger from '@alembic/core/logging';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  type HostTurnMetaInput,
  readHostTurnMetaFromMcpRequest,
} from '#service/task/host-turn-meta.js';
import { SetupService } from '../../cli/SetupService.js';
import { getPackageVersion } from '../../shared/package-assets.js';
import type { GenerateInput, RescanInput } from '../../shared/schemas/mcp-tools.js';
import {
  buildProjectRuntimeContext,
  CODEX_SETUP_PROFILE,
  type HostAdapter,
  type ProjectRootResolution,
  projectLocationService,
  resolveHostAdapter,
} from '../index.js';
import { PluginJobStore } from '../jobs/PluginJobStore.js';
import { type EventLoopWatchdogHandle, startEventLoopWatchdog } from './EventLoopWatchdog.js';
import {
  EmbeddedToolExecutor,
  resetPluginOwnedMcpServer,
  resetPluginOwnedMcpServerForTests,
  type ToolExecutionContext,
} from './host/embedded-executor.js';
import { buildMcpInitializeInstructions } from './host/guidance.js';
import { dispatchLocalTool } from './host/local-tool-dispatcher.js';
import { failureResult, isErrorResult } from './host/results.js';
import { getVisibleTools } from './host/tool-visibility.js';
import {
  createCleanMcpErrorResponse,
  createMcpStructuredToolResult,
  serializeMcpToolResult,
} from './output-contract.js';
import { buildMcpToolUsageView, type McpToolUsageMap, trackMcpToolUsage } from './session-usage.js';
import { raceToolCallDeadline, ToolCallDeadlineError } from './tool-call-deadline.js';
import './local-tools/output.js';

interface HostMcpServerOptions {
  projectRoot?: string;
  waitUntilReadyMs?: number;
}

interface InitRuntimeState {
  attempted: boolean;
  lastAttemptedAt: string | null;
  lastError: string | null;
  ok: boolean;
  requestedTool: string | null;
  route: 'explicit' | 'tool-call' | null;
}

interface ToolCallOptions {
  hostTurnMeta?: HostTurnMetaInput;
}

// 每调用软超时档位(async 挂死兜底;同步钉死归 EventLoopWatchdog)。
// 轻档 120s 覆盖常规工具(真机 search/graph/prime 秒级);重档 600s 覆盖 bootstrap/rescan
// (内含检索+账本重建,BiliDili 真机 2-5min 常态)。ALEMBIC_MCP_TOOL_DEADLINE_MS 统一覆盖。
const DEFAULT_TOOL_DEADLINE_MS = 120_000;
const HEAVY_TOOL_DEADLINE_MS = 600_000;
const HEAVY_TOOL_DEADLINE_TOOLS = new Set([
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_plan',
  'alembic_submit_knowledge',
]);

function readPositiveIntEnv(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface WorkspaceInitializationInput {
  force: boolean;
  initializedBy: 'alembic_init' | 'codex-plugin-init-on-demand';
  requestedMode: 'ghost' | 'standard' | null;
  requestedTool?: string;
  route: 'explicit' | 'tool-call';
  seed: boolean;
}

function attachProjectRuntimeContext(
  result: unknown,
  projectRuntime: ReturnType<typeof buildProjectRuntimeContext>
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: true, data: { projectRuntime, value: result } };
  }
  const record = result as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  return {
    ...record,
    data: {
      ...data,
      projectRuntime,
    },
  };
}

function resolveWorkspaceModeConflict(
  projectRoot: string,
  requestedMode: WorkspaceInitializationInput['requestedMode']
): {
  existingMode: 'ghost' | 'standard';
  projectId: string;
  requestedMode: 'ghost' | 'standard';
} | null {
  if (!requestedMode) {
    return null;
  }
  const location = projectLocationService.resolve(projectRoot);
  if (!location.registered || !location.projectId) {
    return null;
  }
  const existingMode = location.ghost ? 'ghost' : 'standard';
  if (existingMode === requestedMode) {
    return null;
  }
  return { existingMode, projectId: location.projectId, requestedMode };
}

type WorkspaceModeConflict = NonNullable<ReturnType<typeof resolveWorkspaceModeConflict>>;

export class HostMcpServer {
  readonly projectRoot: string;
  readonly projectRootResolution: ProjectRootResolution;
  readonly waitUntilReadyMs: number;
  readonly sessionId: string;
  readonly #sessionStartedAt = Date.now();
  #toolCallCount = 0;
  readonly #toolsUsed = new Set<string>();
  readonly #toolUsage: McpToolUsageMap = new Map();
  sdkServer: SdkMcpServer | null = null;
  /** 事件循环看门狗句柄(start 建、shutdown 停);null=未启动或被 env 关闭。 */
  watchdog: EventLoopWatchdogHandle | null = null;
  #embeddedToolExecutor: EmbeddedToolExecutor | null = null;
  #initPromise: Promise<Record<string, unknown>> | null = null;
  #initRuntimeState: InitRuntimeState = {
    attempted: false,
    lastAttemptedAt: null,
    lastError: null,
    ok: false,
    requestedTool: null,
    route: null,
  };
  // DH-2（RC-2）：L3 host adapter（codex 单实现）。HostMcpServer 经它消费宿主特定的
  // 项目根解析 / 运行时上下文 / init-marker 操作，不再直依赖 Codex* host 函数实现。
  readonly #hostAdapter: HostAdapter = resolveHostAdapter();

  constructor(options: HostMcpServerOptions = {}) {
    const location = projectLocationService.resolve(options.projectRoot);
    this.projectRootResolution = location.rootResolution;
    this.projectRoot = location.projectRoot;
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    const visibleTools = getVisibleTools(undefined, this.projectRoot);
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic', version: getPackageVersion() },
      {
        capabilities: { tools: {} },
        instructions: buildMcpInitializeInstructions(visibleTools),
      }
    );
    this.registerHandlers();
    // 事件循环看门狗:同步钉死(正则回溯/无界同步 IO)时软超时救不了(计时器不触发),
    // worker 线程从旁路报告并按阈值退出让宿主重生——2026-07-10 事故的最后防线。
    this.watchdog = startEventLoopWatchdog({
      onStallReport: (stalledMs) => {
        Logger.getInstance().warn('[HostMcpServer] event loop stall recovered', { stalledMs });
      },
    });
    await this.sdkServer.connect(new StdioServerTransport());
    process.stderr.write(
      `Alembic Codex MCP ready — ${getVisibleTools(undefined, this.projectRoot).length} tools\n`
    );
  }

  async shutdown(): Promise<void> {
    this.watchdog?.stop();
    this.watchdog = null;
    if (this.sdkServer) {
      await this.sdkServer.close();
    }
    await resetPluginOwnedMcpServer();
  }

  registerHandlers(): void {
    if (!this.sdkServer) {
      throw new Error('Codex MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getVisibleTools() }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startedAt = Date.now();
      // 统一观测(2026-07-10 事故补课):每次调用必有 start/done 两行——
      // "有 start 无 done"即挂死/进程死亡的取证锚点。此前只有校验错误留痕,
      // 事件循环被钉死时服务端完全不可见,破案全靠进程恰好还活着可采样。
      Logger.getInstance().info(`[MCP] ${name} start`);
      try {
        const result = await this.#withToolCallDeadline(
          name,
          this.handleToolCall(name, args || {}, {
            hostTurnMeta: readHostTurnMetaFromMcpRequest(request),
          })
        );
        Logger.getInstance().info(`[MCP] ${name} done`, {
          durationMs: Date.now() - startedAt,
          ok: !isErrorResult(result),
        });
        return serializeMcpToolResult(name, result, { isErrorResult });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof ToolCallDeadlineError;
        Logger.getInstance().warn(`[MCP] ${name} ${timedOut ? 'timeout' : 'error'}`, {
          durationMs: Date.now() - startedAt,
          message,
        });
        return createMcpStructuredToolResult(
          createCleanMcpErrorResponse({
            code: timedOut ? 'TOOL_TIMEOUT' : 'CODEX_MCP_ERROR',
            message,
            toolName: name,
          })
        );
      }
    });
  }

  /** 按工具档位计算软超时并委托 raceToolCallDeadline(逻辑在 tool-call-deadline.ts,可直测)。 */
  #withToolCallDeadline<T>(name: string, work: Promise<T>): Promise<T> {
    const heavy = HEAVY_TOOL_DEADLINE_TOOLS.has(name);
    const deadlineMs =
      readPositiveIntEnv('ALEMBIC_MCP_TOOL_DEADLINE_MS') ??
      (heavy ? HEAVY_TOOL_DEADLINE_MS : DEFAULT_TOOL_DEADLINE_MS);
    return raceToolCallDeadline(work, deadlineMs);
  }

  getInitializeInstructions(): string {
    return buildMcpInitializeInstructions(getVisibleTools(undefined, this.projectRoot));
  }

  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions = {}
  ): Promise<unknown> {
    const requestedRoot = typeof args.projectRoot === 'string' ? args.projectRoot : undefined;
    if (requestedRoot && resolve(requestedRoot) !== this.projectRoot) {
      const scopedServer = new HostMcpServer({
        projectRoot: requestedRoot,
        waitUntilReadyMs: this.waitUntilReadyMs,
      });
      const { projectRoot: _projectRoot, ...scopedArgs } = args;
      return scopedServer.handleToolCallInCurrentProject(name, scopedArgs, options);
    }
    const { projectRoot: _projectRoot, ...localArgs } = args;
    return this.handleToolCallInCurrentProject(name, localArgs, options);
  }

  private async handleToolCallInCurrentProject(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions = {}
  ): Promise<unknown> {
    const executionContext = await this.resolveToolExecutionContext(name);

    const localDispatch = dispatchLocalTool(name, args, {
      buildColdStartKnowledgeStatus: () => this.buildColdStartKnowledgeStatus(),
      buildDiagnostics: () => this.buildDiagnostics(),
      buildStatus: () => this.buildStatus(),
      cleanupRuntime: (nextArgs) => this.cleanupRuntime(nextArgs),
      initializeWorkspace: (nextArgs) => this.initializeWorkspace(nextArgs),
      enqueueJob: async (kind, nextArgs) => this.enqueueJob(kind, nextArgs),
      readJob: async (nextArgs) => this.readJob(nextArgs),
    });
    if (localDispatch.handled) {
      const result = await localDispatch.result;
      this.trackSession(name);
      return result;
    }

    const result = await this.callPluginOwnedTool(name, args, executionContext, options);
    this.trackSession(name);
    return result;
  }

  async buildStatus(): Promise<Record<string, unknown>> {
    const location = projectLocationService.resolve(this.projectRoot);
    return {
      success: true,
      data: {
        project: {
          projectRoot: location.projectRoot,
          projectId: location.projectId,
          projectScopeId: location.projectScopeId,
          currentFolderId: location.currentFolderId,
          registered: location.registered,
          ghost: location.ghost,
          dataRoot: location.dataRoot,
          databasePath: location.databasePath,
          databaseExists: location.databaseExists,
        },
        knowledge: {
          available: location.databaseExists,
          initialized: location.databaseExists,
          status: location.databaseExists ? 'available' : 'unavailable',
        },
        initialized: location.databaseExists,
        workspace: {
          mode: location.ghost ? 'ghost' : 'standard',
          ghost: location.ghost,
          dataRoot: location.dataRoot,
          projectRoot: location.projectRoot,
        },
        session: this.buildSessionView(),
        usage: buildMcpToolUsageView(this.#toolUsage),
      },
    };
  }

  private trackSession(toolName: string): void {
    this.#toolCallCount++;
    this.#toolsUsed.add(toolName);
    trackMcpToolUsage(this.#toolUsage, toolName);
  }

  private buildSessionView(): Record<string, unknown> {
    return {
      id: this.sessionId,
      toolCallCount: this.#toolCallCount,
      toolsUsed: Array.from(this.#toolsUsed),
      durationMs: Date.now() - this.#sessionStartedAt,
    };
  }

  async buildColdStartKnowledgeStatus(): Promise<Record<string, unknown>> {
    const status = await this.buildStatus();
    const statusData = status.data as { knowledge?: Record<string, unknown> } | undefined;
    return {
      success: true,
      data: {
        knowledge: {
          ...(statusData?.knowledge ?? {}),
          note: 'Knowledge availability is reported for this request-scoped project only.',
        },
      },
    };
  }

  async buildDiagnostics(): Promise<Record<string, unknown>> {
    const runtime = this.#hostAdapter.resolveRuntimeContext();
    const location = projectLocationService.resolve(this.projectRoot);
    return {
      success: true,
      data: {
        project: {
          projectRoot: location.projectRoot,
          projectId: location.projectId,
          dataRoot: location.dataRoot,
          databasePath: location.databasePath,
          databaseExists: location.databaseExists,
        },
        runtime,
      },
    };
  }

  async initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const standardExplicit = Object.hasOwn(args, 'standard');
    const requestedMode = standardExplicit ? (args.standard === true ? 'standard' : 'ghost') : null;
    const initResult = await this.runWorkspaceInitialization({
      force: Boolean(args.force),
      initializedBy: 'alembic_init',
      requestedMode,
      route: 'explicit',
      seed: Boolean(args.seed),
    });
    if (isErrorResult(initResult)) {
      return initResult;
    }
    const results = Array.isArray((initResult.data as { results?: unknown })?.results)
      ? ((initResult.data as { results: Array<Record<string, unknown>> }).results ?? [])
      : [];
    const status = await this.buildStatus();
    const statusData = readOptionalRecord(status.data) ?? {};
    const postInitConsistency = verifyPostInitConsistency({
      initData: readOptionalRecord(initResult.data) ?? {},
      markerReadback: this.#hostAdapter.readInitMarker(this.projectRoot),
      projectRoot: this.projectRoot,
      statusData,
    });
    const ok =
      initResult.success !== false &&
      results.every((result) => result.ok !== false) &&
      postInitConsistency.ok;
    if (!postInitConsistency.ok) {
      this.#initRuntimeState = {
        ...this.#initRuntimeState,
        lastError: postInitConsistency.reason,
        ok: false,
      };
      process.stderr.write(
        `[MCP/HostMcpServer] init post-status rejected for ${this.projectRoot}: ${postInitConsistency.reason}\n`
      );
    }
    return {
      success: ok,
      data: {
        mode:
          ((status as { data?: { workspace?: { mode?: string } } }).data?.workspace?.mode as
            | string
            | undefined) ??
          requestedMode ??
          'ghost',
        nextActions: ok ? [] : [{ tool: 'alembic_status', required: false }],
        profile: CODEX_SETUP_PROFILE,
        results,
        status: statusData,
      },
      message: ok
        ? 'Alembic workspace initialized for this project.'
        : postInitConsistency.ok
          ? 'Alembic Codex initialization failed. Run diagnostics before retrying.'
          : `Alembic Codex initialization artifacts were created, but post-initialization status could not verify the same initialized project identity: ${postInitConsistency.reason}`,
    };
  }

  async runWorkspaceInitialization(
    input: WorkspaceInitializationInput
  ): Promise<Record<string, unknown>> {
    if (this.#initPromise) {
      return this.#initPromise;
    }
    const promise = this.performWorkspaceInitialization(input).finally(() => {
      if (this.#initPromise === promise) {
        this.#initPromise = null;
      }
    });
    this.#initPromise = promise;
    return promise;
  }

  private async performWorkspaceInitialization(
    input: WorkspaceInitializationInput
  ): Promise<Record<string, unknown>> {
    const startedAt = new Date().toISOString();
    this.#initRuntimeState = {
      attempted: true,
      lastAttemptedAt: startedAt,
      lastError: null,
      ok: false,
      requestedTool: input.requestedTool || null,
      route: input.route,
    };

    const modeConflict = resolveWorkspaceModeConflict(this.projectRoot, input.requestedMode);
    if (modeConflict) {
      return this.buildWorkspaceModeConflictResult(input, modeConflict);
    }

    if (
      projectLocationService.resolve(this.projectRoot).databaseExists &&
      !input.force &&
      !input.seed &&
      input.requestedMode !== 'standard'
    ) {
      this.#initRuntimeState = { ...this.#initRuntimeState, ok: true };
      return {
        success: true,
        data: {
          alreadyInitialized: true,
          initialized: false,
          requestedTool: input.requestedTool || null,
          results: [],
          route: input.route,
        },
        message: 'Alembic Codex workspace is already initialized.',
      };
    }

    try {
      const service = new SetupService({
        projectRoot: this.projectRoot,
        force: input.force,
        seed: input.seed,
        ghost: input.requestedMode ? input.requestedMode === 'ghost' : undefined,
        profile: CODEX_SETUP_PROFILE,
        quiet: true,
      });
      const results = (await service.run()) as Array<Record<string, unknown>>;
      const ok = results.every((result) => result.ok !== false);
      if (!ok) {
        this.#initRuntimeState = {
          ...this.#initRuntimeState,
          lastError: 'One or more setup steps failed.',
          ok: false,
        };
        return failureResult(
          input.requestedTool || 'alembic_init',
          'Alembic Codex initialization failed. Run diagnostics before retrying.',
          {
            errorCode: 'CODEX_AUTO_INIT_FAILED',
            results,
            route: input.route,
          }
        );
      }
      const marker = this.#hostAdapter.writeInitMarker(this.projectRoot, {
        initializedBy: input.initializedBy,
        requestedTool: input.requestedTool,
        results,
        route: input.route,
      });
      this.#initRuntimeState = {
        ...this.#initRuntimeState,
        lastAttemptedAt: marker.initializedAt,
        ok: true,
      };
      return {
        success: true,
        data: {
          initialized: true,
          marker,
          requestedTool: input.requestedTool || null,
          results,
          route: input.route,
        },
        message:
          input.route === 'explicit'
            ? 'Alembic Codex workspace initialized.'
            : 'Alembic Codex workspace initialized before running the requested tool.',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#initRuntimeState = {
        ...this.#initRuntimeState,
        lastError: message,
        ok: false,
      };
      return failureResult(
        input.requestedTool || 'alembic_init',
        'Alembic Codex initialization failed. Run diagnostics before retrying.',
        {
          errorCode: 'CODEX_AUTO_INIT_FAILED',
          lastError: message,
          route: input.route,
        }
      );
    }
  }

  private buildWorkspaceModeConflictResult(
    input: WorkspaceInitializationInput,
    modeConflict: WorkspaceModeConflict
  ): Record<string, unknown> {
    const message = `Alembic Codex initialization requested ${modeConflict.requestedMode} mode, but this project is already registered as ${modeConflict.existingMode}.`;
    this.#initRuntimeState = {
      ...this.#initRuntimeState,
      lastError: message,
      ok: false,
    };
    return failureResult(
      input.requestedTool || 'alembic_init',
      `${message} Ordinary Codex init will not switch workspace mode automatically.`,
      {
        errorCode: 'CODEX_WORKSPACE_MODE_CONFLICT',
        existingMode: modeConflict.existingMode,
        needsUserInput: true,
        projectId: modeConflict.projectId,
        requestedMode: modeConflict.requestedMode,
        nextActions: [{ tool: 'alembic_status', required: false }],
      }
    );
  }

  async cleanupRuntime(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const location = projectLocationService.resolve(this.projectRoot);
    const projectRuntime = buildProjectRuntimeContext({ projectRoot: location.projectRoot });
    const targets = {
      dataRoot: location.dataRoot,
      jobsDir: join(location.runtimeDir, 'jobs'),
      runtimeDir: location.runtimeDir,
    };

    if (args.confirm !== true) {
      return {
        success: true,
        data: {
          dryRun: true,
          projectRuntime,
          targets,
        },
        message:
          'Dry run only. Plugin uninstall does not remove Alembic data. Re-run with confirm=true to delete Plugin job files.',
      };
    }

    rmSync(targets.jobsDir, { force: true, recursive: true });
    return {
      success: true,
      data: {
        dryRun: false,
        projectRuntime,
        cleaned: targets,
      },
      message:
        'Alembic Plugin job state cleaned. Knowledge, Recipes, and project data were left intact.',
    };
  }

  async enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown> {
    const toolName = 'alembic_job';
    const { getServiceContainer } = await import('#inject/ServiceContainer.js');
    const container = getServiceContainer();
    const logger = Logger.getInstance();
    const projectRuntime = buildProjectRuntimeContext({
      projectRoot: this.projectRoot,
      requiredServices: ['project-identity', 'jobs'],
    });

    const store = new PluginJobStore(this.projectRoot);
    const job = store.create({
      kind,
      request: args,
      createdByTool: toolName,
      sessionId: this.sessionId,
    });
    store.markRunning(job.id);
    try {
      let raw: unknown;
      if (kind === 'bootstrap') {
        const { generateForHostAgent } = await import('./handlers/host-agent/generate.js');
        raw = await generateForHostAgent({ container, logger }, normalizeBootstrapJobArgs(args));
      } else {
        const { rescanForHostAgent } = await import('./handlers/host-agent/rescan.js');
        raw = await rescanForHostAgent({ container, logger }, normalizeRescanJobArgs(args));
      }
      const result =
        raw && typeof raw === 'object' && 'data' in raw
          ? ((raw as { data?: unknown }).data ?? raw)
          : raw;
      const completedJob = store.complete(job.id, result);
      return attachProjectRuntimeContext(
        { success: true, data: { job: completedJob } },
        projectRuntime
      );
    } catch (err: unknown) {
      store.fail(job.id, err);
      return failureResult(toolName, err instanceof Error ? err.message : String(err), {
        projectRuntime,
      });
    }
  }

  async readJob(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectRuntime = buildProjectRuntimeContext({
      projectRoot: this.projectRoot,
      projectRootResolution: this.projectRootResolution,
      requiredServices: ['project-identity', 'jobs'],
    });

    const store = new PluginJobStore(this.projectRoot);
    const jobRoute = { selected: 'plugin-owned-local-jobstore' };
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (jobId) {
      const job = store.get(jobId);
      return job
        ? { success: true, data: { job, jobRoute, projectRuntime } }
        : failureResult('alembic_job', `Alembic job not found: ${jobId}`, {
            jobRoute,
            projectRuntime,
          });
    }

    const kind = args.kind === 'bootstrap' || args.kind === 'rescan' ? args.kind : undefined;
    const status =
      args.status === 'queued' ||
      args.status === 'running' ||
      args.status === 'completed' ||
      args.status === 'failed' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 20;
    return {
      success: true,
      data: {
        jobs: store.list({ kind, limit, status }),
        jobRoute,
        projectRuntime,
      },
    };
  }

  async callPluginOwnedTool(
    name: string,
    args: Record<string, unknown>,
    executionContext: ToolExecutionContext = {
      projectRoot: this.projectRoot,
    },
    options: ToolCallOptions = {}
  ): Promise<unknown> {
    const scopedExecutionContext = executionContext.projectRuntime
      ? executionContext
      : {
          ...executionContext,
          projectRuntime: await this.buildPluginOwnedProjectRuntimeContext(executionContext),
        };
    const result = await this.embeddedToolExecutor().execute(
      name,
      args,
      scopedExecutionContext,
      options
    );
    return result;
  }

  private embeddedToolExecutor(): EmbeddedToolExecutor {
    if (!this.#embeddedToolExecutor) {
      this.#embeddedToolExecutor = new EmbeddedToolExecutor({
        getSessionId: () => this.sessionId,
        hostProjectRoot: this.projectRoot,
      });
    }
    return this.#embeddedToolExecutor;
  }

  private async resolveToolExecutionContext(_toolName: string): Promise<ToolExecutionContext> {
    return {
      projectRoot: this.projectRoot,
      projectRuntime: buildProjectRuntimeContext({
        projectRoot: this.projectRoot,
        projectRootResolution: this.projectRootResolution,
        requiredServices: ['project-identity'],
      }),
    };
  }

  private async buildPluginOwnedProjectRuntimeContext(
    executionContext: ToolExecutionContext
  ): Promise<ReturnType<typeof buildProjectRuntimeContext>> {
    return buildProjectRuntimeContext({
      projectRoot: executionContext.projectRoot,
      projectRootResolution: this.projectRootResolution,
      requiredServices: ['project-identity'],
    });
  }
}

function normalizeBootstrapJobArgs(args: Record<string, unknown>): GenerateInput {
  return {
    rebuild: readOptionalBoolean(args.rebuild),
    generationStage: args.generationStage === 'coldStart' ? 'coldStart' : undefined,
    planSelection: args.planSelection as GenerateInput['planSelection'],
    testMode: readOptionalBoolean(args.testMode),
    dimensions: readStringArray(args.dimensions),
    scaleOverride: readScaleOverride(args.scaleOverride),
    rescanId: readOptionalString(args.rescanId),
  };
}

function normalizeRescanJobArgs(args: Record<string, unknown>): RescanInput {
  return {
    dimensions: readStringArray(args.dimensions),
    reason: readOptionalString(args.reason) ?? 'host-rescan',
    force: readOptionalBoolean(args.force),
    produceSession: readOptionalRecord(args.produceSession) as RescanInput['produceSession'],
    controllerAuthorizedGaps: readRecordArray(
      args.controllerAuthorizedGaps
    ) as RescanInput['controllerAuthorizedGaps'],
    produceSessionDimensions: readStringArray(args.produceSessionDimensions),
    controllerAuthorized: readOptionalBoolean(args.controllerAuthorized),
    generationStage: readRescanGenerationStage(args.generationStage),
    planSelection: args.planSelection as RescanInput['planSelection'],
    testMode: readOptionalBoolean(args.testMode),
    moduleScope: readStringArray(args.moduleScope),
    scaleOverride: readScaleOverride(args.scaleOverride),
    rescanId: readOptionalString(args.rescanId),
  };
}

function readRescanGenerationStage(value: unknown): RescanInput['generationStage'] {
  return value === 'deepMining' || value === 'moduleMining' ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function verifyPostInitConsistency(input: {
  initData: Record<string, unknown>;
  markerReadback: unknown;
  projectRoot: string;
  statusData: Record<string, unknown>;
}): { ok: boolean; reason: string } {
  const statusProject = readOptionalRecord(input.statusData.project) ?? {};
  const statusWorkspace = readOptionalRecord(input.statusData.workspace) ?? {};
  const statusKnowledge = readOptionalRecord(input.statusData.knowledge) ?? {};
  if (input.statusData.initialized !== true || statusKnowledge.initialized !== true) {
    return { ok: false, reason: 'post-status remained uninitialized' };
  }
  if (!sameResolvedPath(statusProject.projectRoot, input.projectRoot)) {
    return { ok: false, reason: 'post-status project root differs from the initialized root' };
  }
  const markerReadback = readOptionalRecord(input.markerReadback);
  const initMarker = readOptionalRecord(input.initData.marker);
  const marker = initMarker ?? markerReadback;
  if (!marker || !markerReadback || (!initMarker && input.initData.alreadyInitialized !== true)) {
    return { ok: false, reason: 'init marker was not readable after post-status' };
  }
  if (!sameResolvedPath(marker.projectRoot, input.projectRoot)) {
    return { ok: false, reason: 'init marker project root differs from the initialized root' };
  }
  if (!sameResolvedPath(marker.projectRoot, markerReadback.projectRoot)) {
    return { ok: false, reason: 'marker readback resolved a different project root' };
  }
  if (!sameResolvedPath(marker.dataRoot, markerReadback.dataRoot)) {
    return { ok: false, reason: 'marker readback resolved a different data root' };
  }
  if (typeof marker.ghost !== 'boolean' || marker.ghost !== markerReadback.ghost) {
    return { ok: false, reason: 'marker readback workspace mode contradicts init' };
  }
  if (statusWorkspace.ghost !== marker.ghost) {
    return { ok: false, reason: 'post-status workspace mode contradicts the init marker' };
  }
  if (!sameResolvedPath(statusProject.dataRoot, marker.dataRoot)) {
    return { ok: false, reason: 'post-status data root contradicts the init marker' };
  }
  return { ok: true, reason: 'post-status and init marker are identity-consistent' };
}

function sameResolvedPath(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && resolve(left) === resolve(right);
}

function readRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      )
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function readScaleOverride(value: unknown): GenerateInput['scaleOverride'] {
  const record = readOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    contentMaxLines: readPositiveNumber(record.contentMaxLines),
    maxFiles: readPositiveNumber(record.maxFiles),
    totalRecipeBudget: readPositiveNumber(record.totalRecipeBudget),
  };
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export { getVisibleTools, resetPluginOwnedMcpServerForTests };

export async function startHostMcpServer(): Promise<HostMcpServer> {
  const server = new HostMcpServer();
  await server.start();
  return server;
}

export default HostMcpServer;
