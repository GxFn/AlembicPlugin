import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AlembicResidentServiceResult,
  JobStore,
  resolveDaemonPaths,
  summarizeAlembicResidentServiceStatus,
} from '@alembic/core/daemon';
import { ProjectRegistry } from '@alembic/core/workspace';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  type HostTurnMetaInput,
  readHostTurnMetaFromMcpRequest,
} from '#service/task/HostIntentFrame.js';
import { SetupService } from '../../cli/SetupService.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import {
  buildCodexHostProjectAlignment,
  buildCodexPostInitActions,
  buildCodexPostInitMessage,
  buildCodexProjectRootRequiredActions,
  buildCodexProjectRootRequiredMessage,
  buildCodexProjectRuntimeContext,
  buildCodexRecommendedAction,
  buildCodexRuntimeDiagnostics,
  buildCodexStatus,
  buildHostEnhancementRouteChoice,
  CODEX_RESIDENT_PROJECT_SCOPE_TOOL_NAMES,
  CODEX_SETUP_PROFILE,
  type CodexEnhancementRequirement,
  type CodexHostProjectAlignment,
  type CodexProjectRootResolution,
  type CodexServiceBoundaryDecision,
  createCodexJobContext,
  EMPTY_CODEX_KNOWLEDGE_STATE,
  getCodexRuntimeFallbackIsolation,
  type HostEnhancementRouteChoice,
  type HostKnowledgeState,
  inspectCodexKnowledge,
  isCodexInitOnDemandTool,
  isTrustedCodexProjectRoot,
  preflightCodexTool,
  resolveCodexProjectRoot,
  resolveCodexServiceRequestBoundary,
  resolveHostRuntimeContext,
  summarizeCodexDaemonStatus,
  summarizeCodexProjectRootResolution,
  writeCodexInitMarker,
} from '../../runtime/index.js';
import {
  CodexEmbeddedToolExecutor,
  type CodexToolExecutionContext,
  resetCodexPluginOwnedMcpServerForTests,
  resetPluginOwnedMcpServer,
} from '../../runtime/mcp/host/embedded-executor.js';
import { buildCodexMcpInitializeInstructions } from '../../runtime/mcp/host/guidance.js';
import { buildCodexHostProjectHandoffBlock } from '../../runtime/mcp/host/host-project-handoff.js';
import { dispatchCodexLocalTool } from '../../runtime/mcp/host/local-tool-dispatcher.js';
import { attachPluginOpportunisticEvolutionSurface } from '../../runtime/mcp/host/opportunistic-evolution-presenter.js';
import { safeProjectRootFallback } from '../../runtime/mcp/host/project-root.js';
import {
  persistTrustedCodexProjectRootScope,
  resolveCodexProjectRootScope,
} from '../../runtime/mcp/host/project-root-scope.js';
import {
  attachCodexServiceBoundary,
  attachEnhancementRoute,
  failureResult,
  isErrorResult,
} from '../../runtime/mcp/host/results.js';
import { getVisibleCodexTools } from '../../runtime/mcp/host/tool-visibility.js';
import {
  createCleanMcpErrorResponse,
  createMcpStructuredToolResult,
  serializeMcpToolResult,
} from '../../runtime/mcp/output-contract.js';
import {
  type AlembicResidentCapabilityClients,
  createAlembicResidentCapabilityClients,
  isResidentProjectScopeReady,
} from '../../service/resident/AlembicResidentCapabilityClients.js';
import { getPackageVersion } from '../../shared/package-assets.js';
import '../../runtime/mcp/local-tools/output.js';
import { TIER_ORDER, TOOLS } from '../../runtime/mcp/tools.js';

interface HostMcpServerOptions {
  projectRoot?: string;
  supervisor?: DaemonSupervisorLike;
  waitUntilReadyMs?: number;
}

interface DaemonSupervisorLike {
  ensure(options: { projectRoot: string; waitUntilReadyMs?: number }): Promise<DaemonStatus>;
  status(projectRoot: string): Promise<DaemonStatus>;
  stop(options: { projectRoot: string; waitMs?: number }): Promise<DaemonStatus>;
}

interface CodexInitRuntimeState {
  attempted: boolean;
  lastAttemptedAt: string | null;
  lastError: string | null;
  ok: boolean;
  requestedTool: string | null;
  route: 'explicit' | 'tool-call' | null;
}

interface CodexToolCallOptions {
  hostTurnMeta?: HostTurnMetaInput;
}

interface WorkspaceInitializationInput {
  force: boolean;
  initializedBy: 'alembic_init' | 'codex-plugin-init-on-demand';
  requestedMode: 'ghost' | 'standard' | null;
  requestedTool?: string;
  route: 'explicit' | 'tool-call';
  seed: boolean;
}

interface CodexEnhancementDaemonResult {
  blocked: Record<string, unknown> | null;
  daemon: DaemonStatus;
  enhancementRoute: HostEnhancementRouteChoice;
  hostProjectAlignment: CodexHostProjectAlignment;
}

function summarizeResidentServiceResult(
  result: AlembicResidentServiceResult<unknown>
): Record<string, unknown> {
  const base = {
    ok: result.ok,
    owner: result.owner,
    route: result.route,
    status: result.status ? summarizeAlembicResidentServiceStatus(result.status) : null,
    telemetry: result.telemetry || null,
  };
  return result.ok
    ? base
    : {
        ...base,
        errorCode: result.errorCode || null,
        message: result.message,
        reason: result.reason,
        retryable: result.retryable,
      };
}

function attachResidentServiceResult(
  result: unknown,
  residentService: AlembicResidentServiceResult<unknown>
): unknown {
  const summary = summarizeResidentServiceResult(residentService);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: true, data: { residentService: summary, value: result } };
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
      residentService: summary,
    },
  };
}

function attachProjectRuntimeContext(
  result: unknown,
  projectRuntime: ReturnType<typeof buildCodexProjectRuntimeContext>
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
  const entry = ProjectRegistry.get(projectRoot);
  if (!entry) {
    return null;
  }
  const existingMode = entry.ghost ? 'ghost' : 'standard';
  if (existingMode === requestedMode) {
    return null;
  }
  return { existingMode, projectId: entry.id, requestedMode };
}

export class HostMcpServer {
  readonly projectRoot: string;
  readonly projectRootResolution: CodexProjectRootResolution;
  readonly supervisor: DaemonSupervisorLike;
  readonly waitUntilReadyMs: number;
  readonly sessionId: string;
  sdkServer: SdkMcpServer | null = null;
  #embeddedToolExecutor: CodexEmbeddedToolExecutor | null = null;
  #residentCapabilityClients: AlembicResidentCapabilityClients | null = null;
  #initPromise: Promise<Record<string, unknown>> | null = null;
  #initRuntimeState: CodexInitRuntimeState = {
    attempted: false,
    lastAttemptedAt: null,
    lastError: null,
    ok: false,
    requestedTool: null,
    route: null,
  };

  constructor(options: HostMcpServerOptions = {}) {
    this.projectRootResolution = resolveCodexProjectRoot({ projectRoot: options.projectRoot });
    this.projectRoot = this.projectRootResolution.path || safeProjectRootFallback();
    this.supervisor = options.supervisor || new DaemonSupervisor();
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    const visibleTools = getVisibleCodexTools(undefined, this.projectRoot);
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic', version: getPackageVersion() },
      {
        capabilities: { tools: {} },
        instructions: buildCodexMcpInitializeInstructions(visibleTools),
      }
    );
    this.registerHandlers();
    await this.sdkServer.connect(new StdioServerTransport());
    process.stderr.write(
      `Alembic Codex MCP ready — ${getVisibleCodexTools(undefined, this.projectRoot).length} tools\n`
    );
  }

  async shutdown(): Promise<void> {
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

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getVisibleCodexTools(undefined, this.projectRoot, {
        residentProjectScopeAvailable: await this.isResidentProjectScopeAvailable(),
      }),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const result = await this.handleToolCall(name, args || {}, {
          hostTurnMeta: readHostTurnMetaFromMcpRequest(request),
        });
        return serializeMcpToolResult(name, result, { isErrorResult });
      } catch (err: unknown) {
        return createMcpStructuredToolResult(
          createCleanMcpErrorResponse({
            code: 'CODEX_MCP_ERROR',
            message: err instanceof Error ? err.message : String(err),
            toolName: name,
          })
        );
      }
    });
  }

  getInitializeInstructions(): string {
    return buildCodexMcpInitializeInstructions(getVisibleCodexTools(undefined, this.projectRoot));
  }

  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    options: CodexToolCallOptions = {}
  ): Promise<unknown> {
    if (name === 'alembic_task') {
      return createCleanMcpErrorResponse({
        code: 'CODEX_TOOL_RETIRED',
        message:
          'alembic_task has been retired. Use alembic_prime, alembic_work, or alembic_code_guard.',
        status: 'retired',
        toolName: name,
      });
    }
    const scope = resolveCodexProjectRootScope(name, args);
    if (scope.kind === 'failure') {
      return scope.result;
    }
    if (scope.kind === 'scoped-project') {
      const scopedServer = new HostMcpServer({
        projectRoot: scope.override.projectRoot,
        supervisor: this.supervisor,
        waitUntilReadyMs: this.waitUntilReadyMs,
      });
      persistTrustedCodexProjectRootScope({
        ...scope.override,
        projectRoot: scopedServer.projectRoot,
        resolution: scopedServer.projectRootResolution,
        trusted: scope.override.trusted,
      });
      return scopedServer.handleToolCallInCurrentProject(name, scope.override.args, options);
    }
    return this.handleToolCallInCurrentProject(name, scope.args, options);
  }

  private async handleToolCallInCurrentProject(
    name: string,
    args: Record<string, unknown>,
    options: CodexToolCallOptions = {}
  ): Promise<unknown> {
    const executionContext = await this.resolveToolExecutionContext(name);
    let knowledge = inspectCodexKnowledge(this.projectRoot);
    const residentProjectScopeAvailable = executionContext.residentProjectScopeAvailable;

    const initialPreflight = preflightCodexTool({
      coreTools: TOOLS,
      knowledge,
      projectRootResolution: this.projectRootResolution,
      residentProjectScopeAvailable,
      stage: 'before-auto-init',
      tierOrder: TIER_ORDER,
      toolName: name,
    });
    if (!initialPreflight.ok) {
      return initialPreflight.failure;
    }

    if (initialPreflight.autoInit) {
      const initResult = await this.ensureWorkspaceInitializedForTool(name);
      if (isErrorResult(initResult)) {
        return initResult;
      }
      knowledge = inspectCodexKnowledge(this.projectRoot);
    }

    const executePreflight = preflightCodexTool({
      coreTools: TOOLS,
      knowledge,
      projectRootResolution: this.projectRootResolution,
      residentProjectScopeAvailable,
      stage: 'execute',
      tierOrder: TIER_ORDER,
      toolName: name,
    });
    if (!executePreflight.ok) {
      return executePreflight.failure;
    }

    const localDispatch = dispatchCodexLocalTool(name, args, {
      buildColdStartKnowledgeStatus: () => this.buildColdStartKnowledgeStatus(),
      buildDiagnostics: () => this.buildDiagnostics(),
      buildStatus: () => this.buildStatus(),
      cleanupRuntime: (nextArgs) => this.cleanupRuntime(nextArgs),
      initializeWorkspace: (nextArgs) => this.initializeWorkspace(nextArgs),
      openDashboard: async () =>
        attachCodexServiceBoundary(
          await this.openDashboard(),
          resolveCodexServiceRequestBoundary(name, args)
        ) as Record<string, unknown>,
      enqueueJob: async (kind, nextArgs) =>
        attachCodexServiceBoundary(
          await this.enqueueJob(kind, nextArgs),
          resolveCodexServiceRequestBoundary(name, args)
        ),
      readJob: async (nextArgs) =>
        attachCodexServiceBoundary(
          await this.readJob(nextArgs),
          resolveCodexServiceRequestBoundary(name, args)
        ) as Record<string, unknown>,
      stopDaemon: (nextArgs) => this.stopDaemon(nextArgs),
    });
    if (localDispatch.handled) {
      return localDispatch.result;
    }

    const serviceBoundary = resolveCodexServiceRequestBoundary(name, args);
    return this.callPluginOwnedTool(name, args, serviceBoundary, executionContext, options);
  }

  async buildStatus(): Promise<Record<string, unknown>> {
    return {
      success: true,
      data: await buildCodexStatus(this.projectRoot, {
        autoInit: this.#initRuntimeState as unknown as Record<string, unknown>,
        projectRootResolution: this.projectRootResolution,
        supervisor: this.supervisor,
      }),
    };
  }

  // MTC-4: alembic_status aspect='knowledge' in the cold-start shell. Reports
  // only local knowledge presence derived from the cold-start status summary;
  // it never reaches resident-only recipe/candidate/vector-index stats.
  async buildColdStartKnowledgeStatus(): Promise<Record<string, unknown>> {
    const status = await this.buildStatus();
    const statusData = status.data as { knowledge?: Record<string, unknown> } | undefined;
    return {
      success: true,
      data: {
        knowledge: {
          resident: false,
          ...(statusData?.knowledge ?? {}),
          note: 'Cold-start reports local knowledge presence only; resident recipe/candidate/vector-index stats require an active project runtime.',
        },
      },
    };
  }

  async buildDiagnostics(): Promise<Record<string, unknown>> {
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    const residentClients = this.residentClients();
    const residentService = await residentClients.probe.probe({ daemonStatus });
    const projectScopeIdentity = await residentClients.projectScope.resolveProjectScopeIdentity({
      daemonStatus,
    });
    const runtime = resolveHostRuntimeContext();
    const enhancementRoute = buildHostEnhancementRouteChoice({
      daemonStatus,
      runtime,
      requirement: 'status',
    });
    const hostProjectAlignment = buildCodexHostProjectAlignment({
      daemonStatus,
      enhancementRoute,
      projectScopeIdentity,
      projectRoot: this.projectRoot,
    });
    const projectRuntime = buildCodexProjectRuntimeContext({
      daemonStatus,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      projectRootResolution: this.projectRootResolution,
      projectScopeIdentity,
      requiredServices: ['project-identity'],
      runtime,
    });
    return {
      success: true,
      data: buildCodexRuntimeDiagnostics(daemonStatus, runtime, {
        autoInit: this.#initRuntimeState as unknown as Record<string, unknown>,
        enhancementRoute,
        hostProjectAlignment,
        projectRuntime,
        projectScopeIdentity,
        residentService,
        projectRootResolution: this.projectRootResolution,
      }),
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
    const ok = initResult.success !== false && results.every((result) => result.ok !== false);
    const knowledgeAfterInit =
      (status as { data?: { knowledge?: HostKnowledgeState } }).data?.knowledge ??
      EMPTY_CODEX_KNOWLEDGE_STATE;
    return {
      success: ok,
      data: {
        mode:
          ((status as { data?: { workspace?: { mode?: string } } }).data?.workspace?.mode as
            | string
            | undefined) ??
          requestedMode ??
          'ghost',
        nextActions: ok
          ? buildCodexPostInitActions(knowledgeAfterInit)
          : [
              buildCodexRecommendedAction({
                label: 'Run diagnostics',
                reason: 'Inspect runtime, package, and plugin metadata before retrying setup.',
                startsDaemon: false,
                tool: 'alembic_status',
              }),
            ],
        profile: CODEX_SETUP_PROFILE,
        results,
        status: (status as { data?: unknown }).data,
      },
      message: ok
        ? buildCodexPostInitMessage(knowledgeAfterInit)
        : 'Alembic Codex initialization failed. Run diagnostics before retrying.',
    };
  }

  async ensureWorkspaceInitializedForTool(toolName: string): Promise<Record<string, unknown>> {
    if (!isCodexInitOnDemandTool(toolName)) {
      return { success: true, data: { initialized: false, reason: 'tool is not init-on-demand' } };
    }
    if (inspectCodexKnowledge(this.projectRoot).initialized) {
      return {
        success: true,
        data: {
          initialized: false,
          reason: 'workspace already initialized',
          requestedTool: toolName,
        },
      };
    }
    return this.runWorkspaceInitialization({
      force: false,
      initializedBy: 'codex-plugin-init-on-demand',
      requestedMode: null,
      requestedTool: toolName,
      route: 'tool-call',
      seed: false,
    });
  }

  async runWorkspaceInitialization(
    input: WorkspaceInitializationInput
  ): Promise<Record<string, unknown>> {
    if (!isTrustedCodexProjectRoot(this.projectRootResolution)) {
      const errorCode =
        this.projectRootResolution.trust === 'rejected'
          ? 'CODEX_PROJECT_ROOT_REJECTED'
          : 'CODEX_PROJECT_ROOT_UNRESOLVED';
      this.#initRuntimeState = {
        attempted: false,
        lastAttemptedAt: null,
        lastError: buildCodexProjectRootRequiredMessage(this.projectRootResolution),
        ok: false,
        requestedTool: input.requestedTool || null,
        route: input.route,
      };
      return failureResult(
        input.requestedTool || 'alembic_init',
        buildCodexProjectRootRequiredMessage(this.projectRootResolution),
        {
          errorCode,
          needsUserInput: true,
          projectRootResolution: summarizeCodexProjectRootResolution(this.projectRootResolution),
          required: { projectRoot: 'absolute path' },
          requiredActions: buildCodexProjectRootRequiredActions(),
        }
      );
    }
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
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Check workspace status',
              reason: 'Inspect the registered Alembic workspace mode before retrying init.',
              startsDaemon: false,
              tool: 'alembic_status',
            }),
          ],
        }
      );
    }

    if (
      inspectCodexKnowledge(this.projectRoot).initialized &&
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
      const marker = writeCodexInitMarker(this.projectRoot, {
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

  async openDashboard(): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.status(this.projectRoot);
    const projectScopeIdentity =
      await this.residentClients().projectScope.resolveProjectScopeIdentity({
        daemonStatus: daemon,
      });
    const enhancementRoute = buildHostEnhancementRouteChoice({
      daemonStatus: daemon,
      runtime: resolveHostRuntimeContext(),
      requirement: 'dashboard',
    });
    const hostProjectAlignment = buildCodexHostProjectAlignment({
      daemonStatus: daemon,
      enhancementRoute,
      projectScopeIdentity,
      projectRoot: this.projectRoot,
    });
    const projectRuntime = buildCodexProjectRuntimeContext({
      daemonStatus: daemon,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      projectRootResolution: this.projectRootResolution,
      projectScopeIdentity,
      requiredServices: ['project-identity', 'dashboard'],
      runtime: resolveHostRuntimeContext(),
    });
    const blocked = buildCodexHostProjectHandoffBlock({
      daemon,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      requirement: 'dashboard',
      tool: 'alembic_dashboard',
    });
    if (blocked) {
      return attachProjectRuntimeContext(blocked, projectRuntime) as Record<string, unknown>;
    }
    const dashboardResult = await this.residentClients().dashboard.dashboard({
      daemonStatus: daemon,
    });
    if (
      enhancementRoute.selected !== 'local-alembic-daemon' ||
      !daemon.ready ||
      !daemon.state ||
      !dashboardResult.ok ||
      !dashboardResult.value.url ||
      enhancementRoute.missingCapabilities.includes('dashboard')
    ) {
      return failureResult(
        'alembic_dashboard',
        'Dashboard handoff requires a local Alembic daemon that serves the Dashboard. The embedded Codex plugin runtime does not bundle or serve Dashboard frontend assets.',
        {
          daemon: summarizeCodexDaemonStatus(daemon),
          enhancementRoute,
          errorCode: 'CODEX_DASHBOARD_HANDOFF_UNAVAILABLE',
          hostProjectAlignment,
          needsUserInput: true,
          projectRuntime,
          residentService: summarizeResidentServiceResult(dashboardResult),
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Check workspace status',
              reason: 'Inspect host project alignment and local Alembic daemon readiness.',
              startsDaemon: false,
              tool: 'alembic_status',
            }),
            buildCodexRecommendedAction({
              label: 'Run diagnostics',
              reason: 'Check plugin runtime wiring and local Alembic handoff capabilities.',
              startsDaemon: false,
              tool: 'alembic_status',
            }),
          ],
        }
      );
    }
    const dashboardUrl = dashboardResult.value.url;
    const knowledge = inspectCodexKnowledge(this.projectRoot);
    const hostAgentAction = knowledge.usable
      ? buildCodexRecommendedAction({
          label: 'Run Codex host-agent rescan',
          reason: 'Refresh Alembic project knowledge through the Codex host-agent workflow.',
          startsDaemon: true,
          tool: 'alembic_rescan',
        })
      : buildCodexRecommendedAction({
          label: 'Start Codex host-agent bootstrap',
          reason:
            'Have Codex read the Mission Briefing, analyze the project, submit knowledge, and complete dimensions without requiring an Alembic AI Provider.',
          startsDaemon: true,
          tool: 'alembic_bootstrap',
        });
    return {
      success: true,
      data: {
        dashboardUrl,
        daemon: summarizeCodexDaemonStatus(daemon),
        enhancementRoute,
        hostProjectAlignment,
        projectRuntime,
        residentService: summarizeResidentServiceResult(dashboardResult),
        nextActions: [
          hostAgentAction,
          buildCodexRecommendedAction({
            arguments: { limit: 10 },
            label: 'List recoverable jobs',
            reason:
              'Recover status for explicit Alembic resident or embedded host-agent jobs after Codex reconnects or the Dashboard refreshes.',
            startsDaemon: false,
            tool: 'alembic_job',
          }),
        ],
      },
    };
  }

  async stopDaemon(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.stop({
      projectRoot: this.projectRoot,
      waitMs: typeof args.waitMs === 'number' ? args.waitMs : 5000,
    });
    return {
      success: true,
      data: { daemon: summarizeCodexDaemonStatus(daemon) },
      message: daemon.message || 'Alembic daemon stopped.',
    };
  }

  async cleanupRuntime(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemon = await this.supervisor.status(this.projectRoot);
    const projectScopeIdentity =
      await this.residentClients().projectScope.resolveProjectScopeIdentity({
        daemonStatus: daemon,
      });
    const enhancementRoute = buildHostEnhancementRouteChoice({
      daemonStatus: daemon,
      runtime: resolveHostRuntimeContext(),
      requirement: 'mcp',
    });
    const hostProjectAlignment = buildCodexHostProjectAlignment({
      daemonStatus: daemon,
      enhancementRoute,
      projectScopeIdentity,
      projectRoot: this.projectRoot,
    });
    const projectRuntime = buildCodexProjectRuntimeContext({
      daemonStatus: daemon,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      projectRootResolution: this.projectRootResolution,
      projectScopeIdentity,
      requiredServices: ['project-identity', 'daemon'],
    });
    const paths = resolveDaemonPaths(this.projectRoot);
    const runtimeDir = projectRuntime.identity.runtimeDir || paths.runtimeDir;
    const dataRoot = projectRuntime.identity.dataRoot || paths.dataRoot;
    const targets = {
      dataRoot,
      jobsDir: join(runtimeDir, 'jobs'),
      lockDir: join(runtimeDir, 'daemon.lock'),
      logPath: join(runtimeDir, 'daemon.log'),
      pidPath: join(runtimeDir, 'daemon.pid'),
      runtimeDir,
      statePath: join(runtimeDir, 'daemon.json'),
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
          'Dry run only. Plugin uninstall does not remove Alembic data. Re-run with confirm=true to delete daemon runtime state/log/job files.',
      };
    }

    await this.supervisor.stop({ projectRoot: this.projectRoot, waitMs: 5000 });
    rmSync(targets.statePath, { force: true });
    rmSync(targets.pidPath, { force: true });
    rmSync(targets.logPath, { force: true });
    rmSync(targets.lockDir, { force: true, recursive: true });
    rmSync(targets.jobsDir, { force: true, recursive: true });
    return {
      success: true,
      data: {
        dryRun: false,
        projectRuntime,
        cleaned: targets,
      },
      message:
        'Alembic Codex daemon runtime state cleaned. Knowledge, Recipes, and project data were left intact.',
    };
  }

  async enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown> {
    // MTC-7: public surface is the merged alembic_job route; kind stays the
    // bootstrap/rescan job discriminator for the shared resident job runner.
    const toolName = 'alembic_job';
    const { blocked, daemon, enhancementRoute, hostProjectAlignment } =
      await this.ensureEnhancementDaemon('jobs', toolName);
    const projectScopeIdentity =
      await this.residentClients().projectScope.resolveProjectScopeIdentity({
        daemonStatus: daemon,
      });
    const projectRuntime = buildCodexProjectRuntimeContext({
      daemonStatus: daemon,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      projectRootResolution: this.projectRootResolution,
      projectScopeIdentity,
      requiredServices: ['project-identity', 'jobs'],
    });
    if (blocked) {
      return attachProjectRuntimeContext(blocked, projectRuntime);
    }
    if (!daemon.ready || !daemon.state) {
      return failureResult(toolName, daemon.message || 'Alembic daemon is not ready yet.', {
        daemon: summarizeCodexDaemonStatus(daemon),
        enhancementRoute,
        hostProjectAlignment,
        projectRuntime,
        nextActions: [
          buildCodexRecommendedAction({
            label: 'Run diagnostics',
            reason: 'Check daemon startup state before retrying the job.',
            startsDaemon: false,
            tool: 'alembic_status',
          }),
        ],
      });
    }
    const residentResult = await this.residentClients().jobs.enqueueJob(kind, {
      daemonStatus: daemon,
      body: {
        ...args,
        jobContext: createCodexJobContext({
          createdByTool: toolName,
          sessionId: this.sessionId,
          user: process.env.USER || undefined,
        }),
      },
    });
    if (!residentResult.ok) {
      return failureResult(
        toolName,
        residentResult.message || 'Alembic resident job API is unavailable.',
        {
          daemon: summarizeCodexDaemonStatus(daemon),
          enhancementRoute,
          errorCode: residentResult.errorCode || 'CODEX_RESIDENT_JOB_UNAVAILABLE',
          hostProjectAlignment,
          projectRuntime,
          residentService: summarizeResidentServiceResult(residentResult),
        }
      );
    }

    return attachEnhancementRoute(
      attachProjectRuntimeContext(
        attachResidentServiceResult(residentResult.value, residentResult),
        projectRuntime
      ),
      enhancementRoute
    );
  }

  async readJob(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let daemon: DaemonStatus | null = null;
    try {
      daemon = await this.supervisor.status(this.projectRoot);
    } catch {
      daemon = null;
    }
    const projectScopeIdentity = daemon
      ? await this.residentClients().projectScope.resolveProjectScopeIdentity({
          daemonStatus: daemon,
        })
      : null;
    const enhancementRoute = daemon
      ? buildHostEnhancementRouteChoice({
          daemonStatus: daemon,
          runtime: resolveHostRuntimeContext(),
          requirement: 'jobs',
        })
      : null;
    const hostProjectAlignment =
      daemon && enhancementRoute
        ? buildCodexHostProjectAlignment({
            daemonStatus: daemon,
            enhancementRoute,
            projectScopeIdentity,
            projectRoot: this.projectRoot,
          })
        : null;
    const projectRuntime = buildCodexProjectRuntimeContext({
      daemonStatus: daemon,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      projectRootResolution: this.projectRootResolution,
      projectScopeIdentity,
      requiredServices: ['project-identity', 'jobs'],
    });
    const daemonResult = await this.tryReadJobFromDaemon(args, daemon);
    if (daemonResult) {
      return attachProjectRuntimeContext(daemonResult, projectRuntime) as Record<string, unknown>;
    }

    const store = new JobStore({ projectRoot: this.projectRoot });
    const jobRoute = {
      fallback: true,
      fallbackIsolation: getCodexRuntimeFallbackIsolation('local-jobstore'),
      reason: 'resident-job-api-unavailable-or-not-ready',
      selected: 'embedded-host-agent-recoverable',
      note: 'Local JobStore is exposed only as embedded Codex host-agent job recovery, not as the effective project identity source.',
    };
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

  async tryReadJobFromDaemon(
    args: Record<string, unknown>,
    daemonInput?: DaemonStatus | null
  ): Promise<Record<string, unknown> | null> {
    let daemon: DaemonStatus;
    if (daemonInput) {
      daemon = daemonInput;
    } else {
      try {
        daemon = await this.supervisor.status(this.projectRoot);
      } catch {
        return null;
      }
    }
    if (!daemon.ready || !daemon.state?.token) {
      return null;
    }

    try {
      const result = await this.residentClients().jobs.readJob(args, { daemonStatus: daemon });
      if (!result.ok || isErrorResult(result.value)) {
        return null;
      }
      return attachResidentServiceResult(result.value, result) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async callPluginOwnedTool(
    name: string,
    args: Record<string, unknown>,
    serviceBoundary: CodexServiceBoundaryDecision,
    executionContext: CodexToolExecutionContext = {
      projectRoot: this.projectRoot,
      projectScopeIdentity: null,
      residentProjectScopeAvailable: false,
    },
    options: CodexToolCallOptions = {}
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
      serviceBoundary,
      scopedExecutionContext,
      options
    );
    return attachPluginOpportunisticEvolutionSurface({
      args,
      executionContext: scopedExecutionContext,
      projectRoot: this.projectRoot,
      result,
      toolName: name,
    });
  }

  private residentClients(): AlembicResidentCapabilityClients {
    if (!this.#residentCapabilityClients) {
      this.#residentCapabilityClients = createAlembicResidentCapabilityClients({
        projectRoot: this.projectRoot,
      });
    }
    return this.#residentCapabilityClients;
  }

  private embeddedToolExecutor(): CodexEmbeddedToolExecutor {
    if (!this.#embeddedToolExecutor) {
      this.#embeddedToolExecutor = new CodexEmbeddedToolExecutor({
        getSessionId: () => this.sessionId,
        hostProjectRoot: this.projectRoot,
      });
    }
    return this.#embeddedToolExecutor;
  }

  private async isResidentProjectScopeAvailable(): Promise<boolean> {
    try {
      const identity = await this.residentClients().projectScope.resolveProjectScopeIdentity();
      return isResidentProjectScopeReady(identity);
    } catch {
      return false;
    }
  }

  private async resolveToolExecutionContext(toolName: string): Promise<CodexToolExecutionContext> {
    const usesResidentProjectScope = CODEX_RESIDENT_PROJECT_SCOPE_TOOL_NAMES.has(toolName);
    if (!usesResidentProjectScope) {
      return {
        projectRoot: this.projectRoot,
        projectScopeIdentity: null,
        residentProjectScopeAvailable: false,
      };
    }
    try {
      const identity = await this.residentClients().projectScope.resolveProjectScopeIdentity({
        folderPath: this.projectRoot,
      });
      const residentProjectScopeAvailable = isResidentProjectScopeReady(identity);
      return {
        // ProjectScope 执行保持当前 source folder 作为 projectRoot；
        // WorkspaceResolver 通过 resident summary 只写入 ghost dataRoot。
        projectRoot: this.projectRoot,
        projectScopeIdentity: residentProjectScopeAvailable ? identity : null,
        residentProjectScopeAvailable,
      };
    } catch {
      return {
        projectRoot: this.projectRoot,
        projectScopeIdentity: null,
        residentProjectScopeAvailable: false,
      };
    }
  }

  private async buildPluginOwnedProjectRuntimeContext(
    executionContext: CodexToolExecutionContext
  ): Promise<ReturnType<typeof buildCodexProjectRuntimeContext>> {
    let daemonStatus: DaemonStatus | null = null;
    try {
      daemonStatus = await this.supervisor.status(this.projectRoot);
    } catch {
      daemonStatus = null;
    }
    const runtime = resolveHostRuntimeContext();
    const enhancementRoute = daemonStatus
      ? buildHostEnhancementRouteChoice({
          daemonStatus,
          runtime,
          requirement: 'mcp',
        })
      : null;
    const hostProjectAlignment =
      daemonStatus && enhancementRoute
        ? buildCodexHostProjectAlignment({
            daemonStatus,
            enhancementRoute,
            projectScopeIdentity: executionContext.projectScopeIdentity,
            projectRoot: this.projectRoot,
          })
        : null;
    return buildCodexProjectRuntimeContext({
      daemonStatus,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: executionContext.projectRoot,
      projectRootResolution: this.projectRootResolution,
      projectScopeIdentity: executionContext.projectScopeIdentity,
      requiredServices: ['project-identity'],
      runtime,
    });
  }

  private async ensureEnhancementDaemon(
    requirement: CodexEnhancementRequirement,
    tool: string
  ): Promise<CodexEnhancementDaemonResult> {
    const currentDaemon = await this.supervisor.status(this.projectRoot);
    const currentProjectScopeIdentity =
      await this.residentClients().projectScope.resolveProjectScopeIdentity({
        daemonStatus: currentDaemon,
      });
    const currentEnhancementRoute = buildHostEnhancementRouteChoice({
      daemonStatus: currentDaemon,
      runtime: resolveHostRuntimeContext(),
      requirement,
    });
    const currentHostProjectAlignment = buildCodexHostProjectAlignment({
      daemonStatus: currentDaemon,
      enhancementRoute: currentEnhancementRoute,
      projectScopeIdentity: currentProjectScopeIdentity,
      projectRoot: this.projectRoot,
    });
    const currentBlock = buildCodexHostProjectHandoffBlock({
      daemon: currentDaemon,
      enhancementRoute: currentEnhancementRoute,
      hostProjectAlignment: currentHostProjectAlignment,
      projectRoot: this.projectRoot,
      requirement,
      tool,
    });
    if (currentBlock) {
      return {
        blocked: currentBlock,
        daemon: currentDaemon,
        enhancementRoute: currentEnhancementRoute,
        hostProjectAlignment: currentHostProjectAlignment,
      };
    }
    if (isResidentProjectScopeReady(currentProjectScopeIdentity)) {
      return {
        blocked: null,
        daemon: currentDaemon,
        enhancementRoute: currentEnhancementRoute,
        hostProjectAlignment: currentHostProjectAlignment,
      };
    }

    const daemon = await this.supervisor.ensure({
      projectRoot: this.projectRoot,
      waitUntilReadyMs: this.waitUntilReadyMs,
    });
    const enhancementRoute = buildHostEnhancementRouteChoice({
      daemonStatus: daemon,
      runtime: resolveHostRuntimeContext(),
      requirement,
    });
    const hostProjectAlignment = buildCodexHostProjectAlignment({
      daemonStatus: daemon,
      enhancementRoute,
      projectRoot: this.projectRoot,
    });
    const block = buildCodexHostProjectHandoffBlock({
      daemon,
      enhancementRoute,
      hostProjectAlignment,
      projectRoot: this.projectRoot,
      requirement,
      tool,
    });
    return { blocked: block, daemon, enhancementRoute, hostProjectAlignment };
  }
}

export { getVisibleCodexTools, resetCodexPluginOwnedMcpServerForTests };

export async function startHostMcpServer(): Promise<HostMcpServer> {
  const server = new HostMcpServer();
  await server.start();
  return server;
}

export default HostMcpServer;
