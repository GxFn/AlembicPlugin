import { existsSync, realpathSync, rmSync } from 'node:fs';
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
import { GenerateInput, RescanInput } from '../../shared/schemas/mcp-tools.js';
import {
  buildProjectRootRequiredActions,
  buildProjectRootRequiredMessage,
  buildProjectRuntimeContext,
  CODEX_SETUP_PROFILE,
  type HostAdapter,
  isTrustedProjectRoot,
  type ProjectRootResolution,
  projectLocationService,
  resolveHostAdapter,
  resolveProjectRootFromEnv,
  summarizeProjectRootResolution,
} from '../index.js';
import { PluginJobStore } from '../jobs/PluginJobStore.js';
import { projectCoreToolOutput } from './core-tools/output.js';
import { type EventLoopWatchdogHandle, startEventLoopWatchdog } from './EventLoopWatchdog.js';
import { formatZodValidationMessage } from './errorHandler.js';
import {
  EmbeddedToolExecutor,
  isRequestProjectInitialized,
  projectNotInitializedResult,
  resetPluginOwnedMcpServer,
  resetPluginOwnedMcpServerForTests,
  type ToolExecutionContext,
} from './host/embedded-executor.js';
import { buildMcpInitializeInstructions } from './host/guidance.js';
import { dispatchLocalTool } from './host/local-tool-dispatcher.js';
import { failureResult, isErrorResult } from './host/results.js';
import { getToolCatalog } from './host/tool-catalog.js';
import { createCleanMcpErrorResponse, serializeMcpToolResult } from './output-contract.js';
import { buildMcpToolUsageView, type McpToolUsageMap, trackMcpToolUsage } from './session-usage.js';
import {
  raceToolCallDeadline,
  ToolCallDeadlineError,
  withMcpRequestSignal,
} from './tool-call-deadline.js';
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
  signal?: AbortSignal;
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
// alembic_job 的 op=bootstrap|rescan 跑的就是 alembic_bootstrap / alembic_rescan 同一 workflow，
// 必须拿重档；op=status 只读 job 文件，保持轻档。
const HEAVY_JOB_OPS = new Set(['bootstrap', 'rescan']);
// 仅属于 alembic_job 的控制字段；转发给 workflow 之前剥离，避免进入 Zod 校验与 job.request 以外的语义。
const JOB_CONTROL_ARG_KEYS = new Set(['op', 'jobId', 'kind', 'status', 'limit']);

/** 判断一次工具调用是否应使用重档软超时(bootstrap/rescan 类 workflow)。 */
export function isHeavyToolCall(name: string, args: Record<string, unknown> | undefined): boolean {
  if (HEAVY_TOOL_DEADLINE_TOOLS.has(name)) {
    return true;
  }
  return name === 'alembic_job' && typeof args?.op === 'string' && HEAVY_JOB_OPS.has(args.op);
}

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
  readonly #scopedProjectServers = new Map<string, HostMcpServer>();
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
    const rootResolution = resolveProjectRootFromEnv({ projectRoot: options.projectRoot });
    this.projectRootResolution = rootResolution;
    // MCP transport 与静态 catalog 不拥有项目身份。启动环境只有插件 cache/package cwd
    // 时保留拒绝诊断但不解析 location，实际 root 延迟到每次工具请求再确定。
    this.projectRoot =
      rootResolution.path && isTrustedProjectRoot(rootResolution)
        ? projectLocationService.resolve(rootResolution.path).projectRoot
        : '';
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    const tools = getToolCatalog();
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic', version: getPackageVersion() },
      {
        capabilities: { tools: {} },
        instructions: buildMcpInitializeInstructions(tools),
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
    process.stderr.write(`Alembic Codex MCP ready — ${getToolCatalog().length} tools\n`);
  }

  async shutdown(): Promise<void> {
    this.watchdog?.stop();
    this.watchdog = null;
    if (this.sdkServer) {
      await this.sdkServer.close();
    }
    await resetPluginOwnedMcpServer();
    await this.#embeddedToolExecutor?.dispose();
    this.#embeddedToolExecutor = null;
    for (const server of this.#scopedProjectServers.values()) {
      await server.#embeddedToolExecutor?.dispose();
      server.#embeddedToolExecutor = null;
    }
    this.#scopedProjectServers.clear();
  }

  registerHandlers(): void {
    if (!this.sdkServer) {
      throw new Error('Codex MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolCatalog() }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const startedAt = Date.now();
      // 统一观测(2026-07-10 事故补课):每次调用必有 start/done 两行——
      // "有 start 无 done"即挂死/进程死亡的取证锚点。此前只有校验错误留痕,
      // 事件循环被钉死时服务端完全不可见,破案全靠进程恰好还活着可采样。
      Logger.getInstance().info(`[MCP] ${name} start`);
      try {
        const result = await withMcpRequestSignal(extra.signal, (senderSignal) =>
          this.#withToolCallDeadline(name, args, (deadlineSignal) =>
            this.handleToolCall(name, args || {}, {
              hostTurnMeta: readHostTurnMetaFromMcpRequest(request),
              // 两种取消共享清理链；sender 无权覆盖内部 TOOL_TIMEOUT 的错误类型。
              signal: AbortSignal.any([senderSignal, deadlineSignal]),
            })
          )
        );
        Logger.getInstance().info(`[MCP] ${name} done`, {
          durationMs: Date.now() - startedAt,
          ok: !isErrorResult(result),
        });
        return serializeMcpToolResult(name, result, { isErrorResult });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof ToolCallDeadlineError;
        const cancelled = err instanceof Error && err.name === 'AbortError';
        Logger.getInstance().warn(
          `[MCP] ${name} ${timedOut ? 'timeout' : cancelled ? 'cancelled' : 'error'}`,
          {
            durationMs: Date.now() - startedAt,
            message,
          }
        );
        // catch 路径自身绝不能再抛：只附加本次请求实际项目的 projectRuntime；
        // 请求项目不可解析（顶层根被拒、显式根被拒）时省略，仍返回结构化失败。
        const projectRuntime = this.#buildFailureProjectRuntime(name, args || {});
        return serializeMcpToolResult(
          name,
          {
            ...failureResult(name, message, {
              code: timedOut ? 'TOOL_TIMEOUT' : cancelled ? 'CANCELLED' : 'INTERNAL_ERROR',
              data: {
                ...(projectRuntime ? { projectRuntime } : {}),
                retryable: timedOut,
              },
            }),
            ...(projectRuntime
              ? { _meta: { alembicPublication: projectRuntime.publication } }
              : {}),
          },
          { isErrorResult }
        );
      }
    });
  }

  /** 按工具档位计算软超时并委托 raceToolCallDeadline(逻辑在 tool-call-deadline.ts,可直测)。 */
  #withToolCallDeadline<T>(
    name: string,
    args: Record<string, unknown> | undefined,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const heavy = isHeavyToolCall(name, args);
    const deadlineMs =
      readPositiveIntEnv('ALEMBIC_MCP_TOOL_DEADLINE_MS') ??
      (heavy ? HEAVY_TOOL_DEADLINE_MS : DEFAULT_TOOL_DEADLINE_MS);
    return raceToolCallDeadline(work, deadlineMs, { cleanupAckMs: 1_000 });
  }

  getInitializeInstructions(): string {
    return buildMcpInitializeInstructions(getToolCatalog());
  }

  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions = {}
  ): Promise<unknown> {
    const requestedRoot = readRequestedProjectRoot(args);
    const resolvedRequestedRoot = requestedRoot !== undefined ? resolve(requestedRoot) : undefined;
    const canonicalRequestedRoot = resolvedRequestedRoot
      ? canonicalProjectPath(resolvedRequestedRoot)
      : undefined;
    const canonicalCurrentRoot = this.projectRoot ? canonicalProjectPath(this.projectRoot) : '';
    if (
      requestedRoot !== undefined &&
      canonicalRequestedRoot &&
      canonicalRequestedRoot !== canonicalCurrentRoot
    ) {
      // 显式 projectRoot 必须自身被信任；被拒绝时返回与顶层门禁相同的 PROJECT_ROOT_REQUIRED，
      // 不能交给 scoped server（其 projectRoot='' 会让 buildProjectRuntimeContext 回落到 PWD/cwd）。
      const explicitResolution = resolveExplicitRequestRoot(requestedRoot);
      if (!isTrustedProjectRoot(explicitResolution)) {
        Logger.getInstance().warn(
          `[MCP/HostMcpServer] ${name} explicit projectRoot rejected; returning PROJECT_ROOT_REQUIRED without env fallback`,
          { reason: explicitResolution.reason, requestedRoot }
        );
        return projectRootRequiredResponse(name, explicitResolution);
      }
      let scopedServer = this.#scopedProjectServers.get(canonicalRequestedRoot);
      if (!scopedServer) {
        const candidate = new HostMcpServer({
          // Key sessions by canonical identity, but preserve the caller's logical
          // path in public projectRoot outputs (/var must not become /private/var).
          projectRoot: resolvedRequestedRoot ?? canonicalRequestedRoot,
          waitUntilReadyMs: this.waitUntilReadyMs,
        });
        if (!candidate.projectRoot) {
          // 校验与构造之间目录被删除等竞态：同样拒绝，且不缓存被拒绝的 scoped server。
          Logger.getInstance().warn(
            `[MCP/HostMcpServer] ${name} explicit projectRoot rejected while creating its scoped server`,
            { reason: candidate.projectRootResolution.reason, requestedRoot }
          );
          return projectRootRequiredResponse(
            name,
            restrictToExplicitCandidate(candidate.projectRootResolution, requestedRoot)
          );
        }
        scopedServer = candidate;
        this.#scopedProjectServers.set(canonicalRequestedRoot, scopedServer);
      }
      const { projectRoot: _projectRoot, ...scopedArgs } = args;
      return scopedServer.handleToolCallInCurrentProject(name, scopedArgs, options);
    }
    if (!this.projectRoot) {
      return projectRootRequiredResponse(name, this.projectRootResolution);
    }
    const { projectRoot: _projectRoot, ...localArgs } = args;
    return this.handleToolCallInCurrentProject(name, localArgs, options);
  }

  /**
   * CallTool catch 路径的 projectRuntime：按与 handleToolCall 相同的规则确定请求实际项目
   * （显式 projectRoot 优先，且必须自身被信任；否则用顶层根），只做解析不建 scoped server。
   * 不可解析或构建失败时返回 undefined 并记录诊断，调用方据此省略 projectRuntime。
   */
  #buildFailureProjectRuntime(
    name: string,
    args: Record<string, unknown>
  ): ReturnType<typeof buildProjectRuntimeContext> | undefined {
    const requestedRoot = readRequestedProjectRoot(args);
    let effectiveRoot = this.projectRoot;
    if (requestedRoot !== undefined) {
      const explicitResolution = resolveExplicitRequestRoot(requestedRoot);
      effectiveRoot =
        isTrustedProjectRoot(explicitResolution) && explicitResolution.path
          ? explicitResolution.path
          : '';
    }
    if (!effectiveRoot) {
      Logger.getInstance().warn(
        `[MCP] ${name} failure has no resolvable request project; projectRuntime omitted`,
        { requestedRoot: requestedRoot ?? null }
      );
      return undefined;
    }
    try {
      return buildProjectRuntimeContext({ projectRoot: effectiveRoot });
    } catch (err: unknown) {
      Logger.getInstance().warn(
        `[MCP] ${name} failure projectRuntime could not be built; projectRuntime omitted`,
        { message: err instanceof Error ? err.message : String(err), projectRoot: effectiveRoot }
      );
      return undefined;
    }
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
      enqueueJob: async (kind, nextArgs) => this.enqueueJob(kind, nextArgs, options),
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
            code: 'CODEX_AUTO_INIT_FAILED',
            data: {
              results,
              route: input.route,
            },
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
          code: 'CODEX_AUTO_INIT_FAILED',
          data: {
            lastError: message,
            route: input.route,
          },
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
        code: 'CODEX_WORKSPACE_MODE_CONFLICT',
        data: {
          existingMode: modeConflict.existingMode,
          needsUserInput: true,
          projectId: modeConflict.projectId,
          requestedMode: modeConflict.requestedMode,
          nextActions: [{ tool: 'alembic_status', required: false }],
        },
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

  /**
   * alembic_job op=bootstrap|rescan：以 Plugin 自有 job 记录包裹 alembic_bootstrap / alembic_rescan
   * 的同一条执行链——请求级 projectRuntime（dataRoot 来源）+ 请求项目的插件自有容器
   * （EmbeddedToolExecutor 内的 embedded McpServer）+ wrapHandler 的同一 Zod schema。
   * 不能再用全局 getServiceContainer()：它不属于请求项目，且缺 projectRuntime 时
   * cold-start / rescan 首步就会抛 "Request-scoped project runtime dataRoot is required."。
   */
  async enqueueJob(
    kind: 'bootstrap' | 'rescan',
    args: Record<string, unknown>,
    options: ToolCallOptions = {}
  ): Promise<unknown> {
    const toolName = 'alembic_job';
    const workflowTool = kind === 'bootstrap' ? 'alembic_bootstrap' : 'alembic_rescan';
    const jobRoute = { selected: 'plugin-owned-local-jobstore', workflowTool };
    const executionContext = await this.resolveToolExecutionContext(workflowTool);
    const projectRuntime =
      executionContext.projectRuntime ??
      buildProjectRuntimeContext({ projectRoot: this.projectRoot });
    const workflowArgs = Object.fromEntries(
      Object.entries(args).filter(([key]) => !JOB_CONTROL_ARG_KEYS.has(key))
    );

    // 与 alembic_bootstrap / alembic_rescan 直调同一未初始化门禁，且排在输入校验与 job 创建之前：
    // 未初始化项目的 runtimeDir 在仓库内，任何 job 记录都会在用户仓库落盘。
    if (!isRequestProjectInitialized(executionContext.projectRoot)) {
      return attachProjectRuntimeContext(
        projectNotInitializedResult(toolName, executionContext.projectRoot),
        projectRuntime
      );
    }

    // 先用与 alembic_bootstrap / alembic_rescan 相同的 Zod schema 预校验：坏输入返回结构化
    // VALIDATION_ERROR，不创建 job、不进入 workflow（与直接调用工具时 wrapHandler 的行为一致）。
    const schema = kind === 'bootstrap' ? GenerateInput : RescanInput;
    const parsed = schema.safeParse(workflowArgs);
    if (!parsed.success) {
      // 线路消息与直调 alembic_bootstrap / alembic_rescan（wrapHandler）逐字一致，同一格式化来源；
      // job 入口身份由 data.jobRoute 与日志里的 op 表达，不再靠消息前缀。
      const message = formatZodValidationMessage(parsed.error);
      Logger.getInstance().warn(`[MCP:${toolName}] op=${kind} VALIDATION_ERROR: ${message}`, {
        workflowTool,
      });
      return failureResult(toolName, message, {
        code: 'VALIDATION_ERROR',
        data: { jobRoute, projectRuntime },
      });
    }

    if (kind === 'rescan' && workflowArgs.reason === undefined) {
      // 沿用旧 job 路由的默认触发原因，保证 rescan 报告里能区分 job 入口。
      workflowArgs.reason = 'host-rescan';
    }

    const store = new PluginJobStore(this.projectRoot);
    const job = store.create({
      kind,
      request: args,
      createdByTool: toolName,
      sessionId: this.sessionId,
    });
    store.markRunning(job.id);
    try {
      // 走 EmbeddedToolExecutor.execute：与 alembic_bootstrap / alembic_rescan 共用插件自有
      // embedded McpServer（容器、actor、signal、hostTurnMeta 与 wrapHandler 错误归一）。
      const raw = await this.embeddedToolExecutor().execute(
        workflowTool,
        workflowArgs,
        executionContext,
        options
      );
      const outcome = readJobWorkflowOutcome(raw, workflowTool);
      if (outcome.failed) {
        // workflow 返回的结构化失败（Plan gate 阻断、校验失败、取消等）必须让 job 记 failed，
        // 不能再被包装成 success + completed。
        Logger.getInstance().warn(
          `[MCP:${toolName}] op=${kind} job ${job.id} failed: ${outcome.errorCode}`,
          { message: outcome.message, workflowTool }
        );
        const failedJob = store.fail(job.id, new Error(outcome.message), outcome.result);
        return failureResult(toolName, outcome.message, {
          code: outcome.errorCode,
          data: {
            job: failedJob,
            jobRoute,
            projectRuntime,
            ...outcome.userInput,
          },
        });
      }
      const completedJob = store.complete(job.id, outcome.result);
      return attachProjectRuntimeContext(
        { success: true, data: { job: completedJob, jobRoute } },
        projectRuntime
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.getInstance().warn(`[MCP:${toolName}] op=${kind} job ${job.id} threw: ${message}`, {
        workflowTool,
      });
      const failedJob = store.fail(job.id, err);
      return failureResult(toolName, message, {
        data: { job: failedJob, jobRoute, projectRuntime },
      });
    }
  }

  async readJob(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectRuntime = buildProjectRuntimeContext({
      projectRoot: this.projectRoot,
    });

    const store = new PluginJobStore(this.projectRoot);
    const jobRoute = { selected: 'plugin-owned-local-jobstore' };
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (jobId) {
      const job = store.get(jobId);
      return job
        ? { success: true, data: { job, jobRoute, projectRuntime } }
        : failureResult('alembic_job', `Alembic job not found: ${jobId}`, {
            code: 'NOT_FOUND',
            data: {
              jobRoute,
              projectRuntime,
            },
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
      }),
    };
  }

  private async buildPluginOwnedProjectRuntimeContext(
    executionContext: ToolExecutionContext
  ): Promise<ReturnType<typeof buildProjectRuntimeContext>> {
    return buildProjectRuntimeContext({
      projectRoot: executionContext.projectRoot,
    });
  }
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

/** 请求参数里的显式 projectRoot；空串沿用“未提供”的旧语义，由顶层根处理。 */
function readRequestedProjectRoot(args: Record<string, unknown>): string | undefined {
  return typeof args.projectRoot === 'string' && args.projectRoot !== ''
    ? args.projectRoot
    : undefined;
}

/**
 * 只按显式 projectRoot 自身判定信任，结果要么是 trusted 的 explicit-option，要么是 rejected。
 * resolveProjectRootFromEnv 会 trim 候选并在显式值为空白时退回环境候选（PWD / cwd），
 * 这里把这两类情况都强制归为拒绝，保证显式根永远不会静默换成环境项目。
 */
function resolveExplicitRequestRoot(requestedRoot: string): ProjectRootResolution {
  if (!requestedRoot.trim()) {
    return {
      candidates: [],
      path: null,
      reason: 'Explicit projectRoot is blank.',
      rejected: true,
      source: 'explicit-option',
      trust: 'rejected',
    };
  }
  const resolution = resolveProjectRootFromEnv({ projectRoot: resolve(requestedRoot) });
  if (resolution.source !== 'explicit-option') {
    return restrictToExplicitCandidate(
      {
        ...resolution,
        path: resolve(requestedRoot),
        reason: `Explicit projectRoot could not be resolved on its own: ${requestedRoot}`,
        rejected: true,
        source: 'explicit-option',
        trust: 'rejected',
      },
      requestedRoot
    );
  }
  return isTrustedProjectRoot(resolution)
    ? resolution
    : restrictToExplicitCandidate(resolution, requestedRoot);
}

/**
 * 显式根被拒绝时的诊断只保留显式候选本身：resolveProjectRootFromEnv 总会把服务器环境候选
 * （CODEX_WORKSPACE_DIR / PWD / process.cwd 等）追加在后面，若原样回给调用方，就会把 MCP 服务器
 * 所在的项目路径泄露给一个与之无关的请求。顶层（省略 projectRoot）门禁不走这里，保留完整候选列表。
 */
function restrictToExplicitCandidate(
  resolution: ProjectRootResolution,
  requestedRoot: string
): ProjectRootResolution {
  const explicitPath = resolve(requestedRoot);
  const candidates = resolution.candidates.filter(
    (candidate) => candidate.source === 'explicit-option'
  );
  if (candidates.length !== resolution.candidates.length) {
    Logger.getInstance().debug(
      '[MCP/HostMcpServer] explicit projectRoot rejected; environment candidates withheld from diagnostics',
      {
        requestedRoot,
        withheldCandidateCount: resolution.candidates.length - candidates.length,
      }
    );
  }
  return {
    ...resolution,
    candidates:
      candidates.length > 0
        ? candidates
        : [{ path: explicitPath, source: 'explicit-option', trust: 'trusted' }],
  };
}

/** 与顶层门禁同形的 PROJECT_ROOT_REQUIRED clean error（拒绝原因、候选摘要与 requiredActions）。 */
function projectRootRequiredResponse(toolName: string, resolution: ProjectRootResolution) {
  return createCleanMcpErrorResponse({
    code: 'PROJECT_ROOT_REQUIRED',
    details: {
      projectRootResolution: summarizeProjectRootResolution(resolution),
      requiredActions: buildProjectRootRequiredActions(),
    },
    message: buildProjectRootRequiredMessage(resolution),
    status: 'project-root-required',
    toolName,
  });
}

function canonicalProjectPath(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

interface JobWorkflowOutcome {
  errorCode: string;
  failed: boolean;
  message: string;
  result: unknown;
  userInput: Record<string, unknown>;
}

/**
 * 把 alembic_bootstrap / alembic_rescan 的执行结果归一成 job 结果。
 * 三种形态：wrapHandler 的 CallToolResult（structuredContent，含 VALIDATION_ERROR / 抛错归一），
 * EmbeddedToolExecutor 的 failureResult，以及 workflow 自身的 { success, data } 信封
 * （Plan gate 阻断即 success:false + errorCode）。
 */
function readJobWorkflowOutcome(
  raw: unknown,
  workflowTool: 'alembic_bootstrap' | 'alembic_rescan'
): JobWorkflowOutcome {
  const record = readOptionalRecord(raw) ?? {};
  const structured = readOptionalRecord(record.structuredContent);
  if (structured) {
    const error = readOptionalRecord(structured.error);
    const failed = record.isError === true || structured.ok === false;
    return {
      errorCode: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
      failed,
      message:
        (typeof error?.message === 'string' && error.message) ||
        (typeof structured.summary === 'string' && structured.summary) ||
        'Alembic job workflow failed.',
      result: structured,
      userInput: {},
    };
  }
  const data = readOptionalRecord(record.data);
  // attachExecutionContext 会把 projectRuntime 塞进 data；job 响应顶层已带 projectRuntime，
  // job.result 只保留 workflow 业务数据，避免同一份运行时上下文重复落盘。
  const { projectRuntime: _projectRuntime, ...businessData } = data ?? {};
  const failed = isErrorResult(record);
  const result = data ? projectJobWorkflowResult(record, businessData, workflowTool, failed) : raw;
  const planGate = readOptionalRecord(businessData.planGate);
  const errorCode =
    (typeof record.errorCode === 'string' && record.errorCode) ||
    (typeof planGate?.errorCode === 'string' && planGate.errorCode) ||
    'INTERNAL_ERROR';
  const message =
    [record.message, businessData.blockedReason]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ') || 'Alembic job workflow failed.';
  return {
    errorCode,
    failed,
    message,
    result,
    userInput: failed
      ? {
          ...(businessData.needsUserInput === true ? { needsUserInput: true } : {}),
          ...(Array.isArray(businessData.nextActions)
            ? { nextActions: businessData.nextActions }
            : {}),
        }
      : {},
  };
}

/**
 * job.result 必须与直调 alembic_bootstrap / alembic_rescan 返回给智能体的内容一致：走同一个
 * core clean-output 投影（业务白名单、敏感键剥离、rescan trash 路径相对化与超预算收敛）。
 * 否则 job 路由会把直调时被过滤的原始字段（绝对路径、内部 meta 等）原样存入并回传。
 * 投影异常时回退为去掉 projectRuntime 的原始业务数据，并写诊断日志，不让 job 因投影失败而丢结果。
 */
function projectJobWorkflowResult(
  record: Record<string, unknown>,
  businessData: Record<string, unknown>,
  workflowTool: 'alembic_bootstrap' | 'alembic_rescan',
  failed: boolean
): unknown {
  try {
    return projectCoreToolOutput(record, workflowTool);
  } catch (err: unknown) {
    Logger.getInstance().warn(
      `[MCP:alembic_job] ${workflowTool} result projection failed; storing unprojected business data`,
      { error: err instanceof Error ? err.message : String(err), failed }
    );
    return businessData;
  }
}

export { getToolCatalog, resetPluginOwnedMcpServerForTests };

export async function startHostMcpServer(): Promise<HostMcpServer> {
  const server = new HostMcpServer();
  await server.start();
  return server;
}

export default HostMcpServer;
