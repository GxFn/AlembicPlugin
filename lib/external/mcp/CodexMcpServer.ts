import { rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
import {
  buildCodexEnhancementRouteChoice,
  buildCodexHostProjectAlignment,
  buildCodexPostInitActions,
  buildCodexPostInitMessage,
  buildCodexProjectRootRequiredActions,
  buildCodexProjectRootRequiredMessage,
  buildCodexRecommendedAction,
  buildCodexRuntimeDiagnostics,
  buildCodexStatus,
  CODEX_RESIDENT_PROJECT_SCOPE_TOOL_NAMES,
  CODEX_SETUP_PROFILE,
  type CodexEnhancementRequirement,
  type CodexEnhancementRouteChoice,
  type CodexHostProjectAlignment,
  type CodexKnowledgeState,
  type CodexProjectRootResolution,
  type CodexServiceBoundaryDecision,
  createCodexJobContext,
  EMPTY_CODEX_KNOWLEDGE_STATE,
  inspectCodexKnowledge,
  isCodexInitOnDemandTool,
  isTrustedCodexProjectRoot,
  preflightCodexTool,
  resolveCodexProjectRoot,
  resolveCodexRuntimeContext,
  resolveCodexServiceRequestBoundary,
  summarizeCodexDaemonStatus,
  summarizeCodexProjectRootResolution,
  writeCodexInitMarker,
  writeCodexSavedProjectRoot,
} from '../../codex/index.js';
import { type DaemonStatus, DaemonSupervisor } from '../../daemon/DaemonSupervisor.js';
import {
  type AlembicResidentProjectScopeIdentity,
  AlembicResidentServiceClient,
} from '../../service/resident/AlembicResidentServiceClient.js';
import { getPackageVersion } from '../../shared/package-assets.js';
import {
  ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV,
  serializeCodexProjectScopeSummary,
} from '../../shared/project-scope-runtime.js';
import { buildCodexHostProjectHandoffBlock } from './codex/host-project-handoff.js';
import { safeProjectRootFallback } from './codex/project-root.js';
import {
  attachCodexServiceBoundary,
  attachEnhancementRoute,
  failureResult,
  isErrorResult,
} from './codex/results.js';
import { getVisibleCodexTools } from './codex/tool-visibility.js';
import { McpServer as EmbeddedMcpServer } from './McpServer.js';
import { TIER_ORDER, TOOLS } from './tools.js';

interface CodexMcpServerOptions {
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
  initializedBy: 'alembic_codex_init' | 'codex-plugin-init-on-demand';
  requestedMode: 'ghost' | 'standard' | null;
  requestedTool?: string;
  route: 'explicit' | 'tool-call';
  seed: boolean;
}

interface CodexEnhancementDaemonResult {
  blocked: Record<string, unknown> | null;
  daemon: DaemonStatus;
  enhancementRoute: CodexEnhancementRouteChoice;
  hostProjectAlignment: CodexHostProjectAlignment;
}

interface CodexToolExecutionContext {
  projectRoot: string;
  projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
  residentProjectScopeAvailable: boolean;
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

export class CodexMcpServer {
  readonly projectRoot: string;
  readonly projectRootResolution: CodexProjectRootResolution;
  readonly supervisor: DaemonSupervisorLike;
  readonly waitUntilReadyMs: number;
  readonly sessionId: string;
  sdkServer: SdkMcpServer | null = null;
  #pluginOwnedMcpServer: EmbeddedMcpServer | null = null;
  #pluginOwnedMcpServerKey: string | null = null;
  #residentServiceClient: AlembicResidentServiceClient | null = null;
  #initPromise: Promise<Record<string, unknown>> | null = null;
  #initRuntimeState: CodexInitRuntimeState = {
    attempted: false,
    lastAttemptedAt: null,
    lastError: null,
    ok: false,
    requestedTool: null,
    route: null,
  };

  constructor(options: CodexMcpServerOptions = {}) {
    this.projectRootResolution = resolveCodexProjectRoot({ projectRoot: options.projectRoot });
    this.projectRoot = this.projectRootResolution.path || safeProjectRootFallback();
    this.supervisor = options.supervisor || new DaemonSupervisor();
    this.waitUntilReadyMs = options.waitUntilReadyMs ?? 3000;
    this.sessionId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(): Promise<void> {
    this.sdkServer = new SdkMcpServer(
      { name: 'alembic-codex', version: getPackageVersion() },
      { capabilities: { tools: {} } }
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
    if (this.#pluginOwnedMcpServer) {
      await this.#pluginOwnedMcpServer.shutdown();
      this.#pluginOwnedMcpServer = null;
    }
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
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: isErrorResult(result) ? true : undefined,
        };
      } catch (err: unknown) {
        const result = failureResult(name, err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }
    });
  }

  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    options: CodexToolCallOptions = {}
  ): Promise<unknown> {
    const projectRootArg = args.projectRoot;
    if (projectRootArg !== undefined) {
      if (typeof projectRootArg !== 'string' || projectRootArg.trim().length === 0) {
        return failureResult(name, 'projectRoot must be a non-empty absolute path string.', {
          errorCode: 'CODEX_INVALID_PROJECT_ROOT_ARGUMENT',
          required: { projectRoot: 'absolute path' },
        });
      }
      if (!isAbsolute(projectRootArg)) {
        return failureResult(name, 'projectRoot must be an absolute path.', {
          errorCode: 'CODEX_INVALID_PROJECT_ROOT_ARGUMENT',
          received: projectRootArg,
          required: { projectRoot: 'absolute path' },
        });
      }
      const scopedArgs = { ...args };
      delete scopedArgs.projectRoot;
      const scopedServer = new CodexMcpServer({
        projectRoot: projectRootArg,
        supervisor: this.supervisor,
        waitUntilReadyMs: this.waitUntilReadyMs,
      });
      if (isTrustedCodexProjectRoot(scopedServer.projectRootResolution)) {
        writeCodexSavedProjectRoot(scopedServer.projectRoot);
      }
      return scopedServer.handleToolCallInCurrentProject(name, scopedArgs, options);
    }
    return this.handleToolCallInCurrentProject(name, args, options);
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

    switch (name) {
      case 'alembic_codex_status':
        return this.buildStatus();
      case 'alembic_codex_diagnostics':
        return this.buildDiagnostics();
      case 'alembic_codex_init':
        return this.initializeWorkspace(args);
      case 'alembic_codex_dashboard': {
        const serviceBoundary = resolveCodexServiceRequestBoundary(name, args);
        return attachCodexServiceBoundary(await this.openDashboard(), serviceBoundary);
      }
      case 'alembic_codex_bootstrap': {
        const serviceBoundary = resolveCodexServiceRequestBoundary(name, args);
        return attachCodexServiceBoundary(
          await this.enqueueJob('bootstrap', args),
          serviceBoundary
        );
      }
      case 'alembic_codex_rescan': {
        const serviceBoundary = resolveCodexServiceRequestBoundary(name, args);
        return attachCodexServiceBoundary(await this.enqueueJob('rescan', args), serviceBoundary);
      }
      case 'alembic_codex_job': {
        const serviceBoundary = resolveCodexServiceRequestBoundary(name, args);
        return attachCodexServiceBoundary(await this.readJob(args), serviceBoundary);
      }
      case 'alembic_codex_stop':
        return this.stopDaemon(args);
      case 'alembic_codex_cleanup':
        return this.cleanupRuntime(args);
      default: {
        const serviceBoundary = resolveCodexServiceRequestBoundary(name, args);
        return this.callPluginOwnedTool(name, args, serviceBoundary, executionContext, options);
      }
    }
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

  async buildDiagnostics(): Promise<Record<string, unknown>> {
    const daemonStatus = await this.supervisor.status(this.projectRoot);
    const residentClient = this.residentServiceClient();
    const residentService = await residentClient.probe({ daemonStatus });
    const projectScopeIdentity = await residentClient.resolveProjectScopeIdentity({ daemonStatus });
    const runtime = resolveCodexRuntimeContext();
    const enhancementRoute = buildCodexEnhancementRouteChoice({
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
    return {
      success: true,
      data: buildCodexRuntimeDiagnostics(daemonStatus, runtime, {
        autoInit: this.#initRuntimeState as unknown as Record<string, unknown>,
        enhancementRoute,
        hostProjectAlignment,
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
      initializedBy: 'alembic_codex_init',
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
      (status as { data?: { knowledge?: CodexKnowledgeState } }).data?.knowledge ??
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
                tool: 'alembic_codex_diagnostics',
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
        input.requestedTool || 'alembic_codex_init',
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
        input.requestedTool || 'alembic_codex_init',
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
              tool: 'alembic_codex_status',
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
          input.requestedTool || 'alembic_codex_init',
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
        input.requestedTool || 'alembic_codex_init',
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
    const projectScopeIdentity = await this.residentServiceClient().resolveProjectScopeIdentity({
      daemonStatus: daemon,
    });
    const enhancementRoute = buildCodexEnhancementRouteChoice({
      daemonStatus: daemon,
      runtime: resolveCodexRuntimeContext(),
      requirement: 'dashboard',
    });
    const hostProjectAlignment = buildCodexHostProjectAlignment({
      daemonStatus: daemon,
      enhancementRoute,
      projectScopeIdentity,
      projectRoot: this.projectRoot,
    });
    const blocked = buildCodexHostProjectHandoffBlock({
      daemon,
      enhancementRoute,
      hostProjectAlignment,
      requirement: 'dashboard',
      tool: 'alembic_codex_dashboard',
    });
    if (blocked) {
      return blocked;
    }
    const dashboardResult = await this.residentServiceClient().dashboard({ daemonStatus: daemon });
    if (
      enhancementRoute.selected !== 'local-alembic-daemon' ||
      !daemon.ready ||
      !daemon.state ||
      !dashboardResult.ok ||
      !dashboardResult.value.url ||
      enhancementRoute.missingCapabilities.includes('dashboard')
    ) {
      return failureResult(
        'alembic_codex_dashboard',
        'Dashboard handoff requires a local Alembic daemon that serves the Dashboard. The embedded Codex plugin runtime does not bundle or serve Dashboard frontend assets.',
        {
          daemon: summarizeCodexDaemonStatus(daemon),
          enhancementRoute,
          errorCode: 'CODEX_DASHBOARD_HANDOFF_UNAVAILABLE',
          hostProjectAlignment,
          needsUserInput: true,
          residentService: summarizeResidentServiceResult(dashboardResult),
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Check workspace status',
              reason: 'Inspect host project alignment and local Alembic daemon readiness.',
              startsDaemon: false,
              tool: 'alembic_codex_status',
            }),
            buildCodexRecommendedAction({
              label: 'Run diagnostics',
              reason: 'Check plugin runtime wiring and local Alembic handoff capabilities.',
              startsDaemon: false,
              tool: 'alembic_codex_diagnostics',
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
        residentService: summarizeResidentServiceResult(dashboardResult),
        nextActions: [
          hostAgentAction,
          buildCodexRecommendedAction({
            arguments: { limit: 10 },
            label: 'List recoverable jobs',
            reason:
              'Recover status for explicit Alembic resident or embedded host-agent jobs after Codex reconnects or the Dashboard refreshes.',
            startsDaemon: false,
            tool: 'alembic_codex_job',
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
    const paths = resolveDaemonPaths(this.projectRoot);
    const targets = {
      dataRoot: paths.dataRoot,
      jobsDir: paths.jobsDir,
      lockDir: paths.lockDir,
      logPath: paths.logPath,
      pidPath: paths.pidPath,
      runtimeDir: paths.runtimeDir,
      statePath: paths.statePath,
    };

    if (args.confirm !== true) {
      return {
        success: true,
        data: {
          dryRun: true,
          targets,
        },
        message:
          'Dry run only. Plugin uninstall does not remove Alembic data. Re-run with confirm=true to delete daemon runtime state/log/job files.',
      };
    }

    await this.supervisor.stop({ projectRoot: this.projectRoot, waitMs: 5000 });
    rmSync(paths.statePath, { force: true });
    rmSync(paths.pidPath, { force: true });
    rmSync(paths.logPath, { force: true });
    rmSync(paths.lockDir, { force: true, recursive: true });
    rmSync(paths.jobsDir, { force: true, recursive: true });
    return {
      success: true,
      data: {
        dryRun: false,
        cleaned: targets,
      },
      message:
        'Alembic Codex daemon runtime state cleaned. Knowledge, Recipes, and project data were left intact.',
    };
  }

  async enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown> {
    const { blocked, daemon, enhancementRoute, hostProjectAlignment } =
      await this.ensureEnhancementDaemon('jobs', `alembic_codex_${kind}`);
    if (blocked) {
      return blocked;
    }
    if (!daemon.ready || !daemon.state) {
      return failureResult(
        `alembic_codex_${kind}`,
        daemon.message || 'Alembic daemon is not ready yet.',
        {
          daemon: summarizeCodexDaemonStatus(daemon),
          enhancementRoute,
          hostProjectAlignment,
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Run diagnostics',
              reason: 'Check daemon startup state before retrying the job.',
              startsDaemon: false,
              tool: 'alembic_codex_diagnostics',
            }),
          ],
        }
      );
    }
    const residentResult = await this.residentServiceClient().enqueueJob(kind, {
      daemonStatus: daemon,
      body: {
        ...args,
        jobContext: createCodexJobContext({
          createdByTool: `alembic_codex_${kind}`,
          sessionId: this.sessionId,
          user: process.env.USER || undefined,
        }),
      },
    });
    if (!residentResult.ok) {
      return failureResult(
        `alembic_codex_${kind}`,
        residentResult.message || 'Alembic resident job API is unavailable.',
        {
          daemon: summarizeCodexDaemonStatus(daemon),
          enhancementRoute,
          errorCode: residentResult.errorCode || 'CODEX_RESIDENT_JOB_UNAVAILABLE',
          hostProjectAlignment,
          residentService: summarizeResidentServiceResult(residentResult),
        }
      );
    }

    return attachEnhancementRoute(
      attachResidentServiceResult(residentResult.value, residentResult),
      enhancementRoute
    );
  }

  async readJob(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const daemonResult = await this.tryReadJobFromDaemon(args);
    if (daemonResult) {
      return daemonResult;
    }

    const store = new JobStore({ projectRoot: this.projectRoot });
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (jobId) {
      const job = store.get(jobId);
      return job
        ? { success: true, data: { job } }
        : failureResult('alembic_codex_job', `Alembic job not found: ${jobId}`);
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
      },
    };
  }

  async tryReadJobFromDaemon(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    let daemon: DaemonStatus;
    try {
      daemon = await this.supervisor.status(this.projectRoot);
    } catch {
      return null;
    }
    if (!daemon.ready || !daemon.state?.token) {
      return null;
    }

    try {
      const result = await this.residentServiceClient().readJob(args, { daemonStatus: daemon });
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
    if (!TOOLS.some((tool) => tool.name === name)) {
      return attachCodexServiceBoundary(
        failureResult(name, `Unknown Alembic tool: ${name}`),
        serviceBoundary
      );
    }

    try {
      const localMcp = await this.getPluginOwnedMcpServer(executionContext);
      const result = await localMcp._executeMcpHandler(name, args, {
        actor: {
          role: 'external_agent',
          user: process.env.USER || undefined,
          sessionId: this.sessionId,
        },
        source: { kind: 'codex', name: 'plugin-owned-codex-facing' },
        surface: 'codex',
        hostTurnMeta: options.hostTurnMeta,
      });
      return attachCodexExecutionContext(
        attachCodexServiceBoundary(result, serviceBoundary),
        executionContext,
        this.projectRoot
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return attachCodexExecutionContext(
        attachCodexServiceBoundary(
          failureResult(name, `Plugin-owned Codex tool execution failed: ${message}`),
          serviceBoundary
        ),
        executionContext,
        this.projectRoot
      );
    }
  }

  private async getPluginOwnedMcpServer(
    executionContext: CodexToolExecutionContext
  ): Promise<EmbeddedMcpServer> {
    const scopeKey = [
      executionContext.projectRoot,
      executionContext.projectScopeIdentity?.projectScopeId ?? 'single-folder',
      executionContext.projectScopeIdentity?.currentFolderId ?? '',
    ].join('\0');
    if (this.#pluginOwnedMcpServer && this.#pluginOwnedMcpServerKey === scopeKey) {
      return this.#pluginOwnedMcpServer;
    }
    if (this.#pluginOwnedMcpServer) {
      await this.#pluginOwnedMcpServer.shutdown();
      this.#pluginOwnedMcpServer = null;
      this.#pluginOwnedMcpServerKey = null;
    }

    const previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
    const previousProjectScopeSummary = process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
    const previousCwd = safeProjectRootFallback();
    process.env.ALEMBIC_PROJECT_DIR = executionContext.projectRoot;
    const serializedProjectScope = serializeCodexProjectScopeSummary(
      executionContext.projectScopeIdentity?.projectScope ?? null
    );
    if (serializedProjectScope) {
      process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV] = serializedProjectScope;
    } else {
      delete process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
    }
    const server = new EmbeddedMcpServer({
      actorRole: 'external_agent',
      source: { kind: 'codex', name: 'plugin-owned-codex-facing' },
      surface: 'codex',
    });
    try {
      // Plugin-owned Codex tools use the embedded Plugin handler tree. Alembic daemon can still
      // serve resident capabilities, but it must not replace Codex-facing task payload ownership.
      await server.initialize();
      this.#pluginOwnedMcpServer = server;
      this.#pluginOwnedMcpServerKey = scopeKey;
      return server;
    } finally {
      if (previousProjectDir === undefined) {
        delete process.env.ALEMBIC_PROJECT_DIR;
      } else {
        process.env.ALEMBIC_PROJECT_DIR = previousProjectDir;
      }
      if (previousProjectScopeSummary === undefined) {
        delete process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
      } else {
        process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV] = previousProjectScopeSummary;
      }
      try {
        process.chdir(previousCwd);
      } catch (err: unknown) {
        process.stderr.write(
          `[Codex MCP] failed to restore cwd after Plugin-owned tool init: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
    }
  }

  private residentServiceClient(): AlembicResidentServiceClient {
    if (!this.#residentServiceClient) {
      this.#residentServiceClient = new AlembicResidentServiceClient({
        projectRoot: this.projectRoot,
      });
    }
    return this.#residentServiceClient;
  }

  private async isResidentProjectScopeAvailable(): Promise<boolean> {
    try {
      const identity = await this.residentServiceClient().resolveProjectScopeIdentity();
      return isResidentProjectScopeReady(identity);
    } catch {
      return false;
    }
  }

  private async resolveToolExecutionContext(toolName: string): Promise<CodexToolExecutionContext> {
    if (!CODEX_RESIDENT_PROJECT_SCOPE_TOOL_NAMES.has(toolName)) {
      return {
        projectRoot: this.projectRoot,
        projectScopeIdentity: null,
        residentProjectScopeAvailable: false,
      };
    }
    try {
      const identity = await this.residentServiceClient().resolveProjectScopeIdentity({
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

  private async ensureEnhancementDaemon(
    requirement: CodexEnhancementRequirement,
    tool: string
  ): Promise<CodexEnhancementDaemonResult> {
    const currentDaemon = await this.supervisor.status(this.projectRoot);
    const currentProjectScopeIdentity =
      await this.residentServiceClient().resolveProjectScopeIdentity({
        daemonStatus: currentDaemon,
      });
    const currentEnhancementRoute = buildCodexEnhancementRouteChoice({
      daemonStatus: currentDaemon,
      runtime: resolveCodexRuntimeContext(),
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
    const enhancementRoute = buildCodexEnhancementRouteChoice({
      daemonStatus: daemon,
      runtime: resolveCodexRuntimeContext(),
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
      requirement,
      tool,
    });
    return { blocked: block, daemon, enhancementRoute, hostProjectAlignment };
  }
}

export { getVisibleCodexTools };

function isResidentProjectScopeReady(
  identity: AlembicResidentProjectScopeIdentity | null | undefined
): boolean {
  return (
    identity?.available === true &&
    identity.mode === 'project-scope' &&
    identity.resident.owner === 'alembic' &&
    identity.resident.route === 'local-alembic-daemon'
  );
}

function attachCodexExecutionContext(
  result: unknown,
  executionContext: CodexToolExecutionContext,
  hostProjectRoot: string
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  if (!executionContext.residentProjectScopeAvailable || !executionContext.projectScopeIdentity) {
    return result;
  }
  const record = result as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  const identity = executionContext.projectScopeIdentity;
  return {
    ...record,
    data: {
      ...data,
      codexProjectScopeExecution: {
        controlRoot: identity.controlRoot,
        currentFolderId: identity.currentFolderId,
        currentFolderPath: identity.currentFolderPath,
        dataRoot: identity.dataRoot,
        enabled: true,
        hostProjectRoot,
        mode: identity.mode,
        projectScopeId: identity.projectScopeId,
        reason:
          'ProjectScope resident identity is ready; Plugin-owned Codex tool execution uses the resident ghost dataRoot instead of creating runtime data in the bound source folder.',
        serviceScopeId: identity.serviceScopeId,
      },
    },
  };
}

export async function startCodexMcpServer(): Promise<CodexMcpServer> {
  const server = new CodexMcpServer();
  await server.start();
  return server;
}

export default CodexMcpServer;
