/**
 * Alembic V3 MCP Server — Codex plugin runtime
 *
 * Model Context Protocol (stdio transport)
 * 提供给插件宿主 Agent 的工具集
 *
 * V3.3 tool surface：one ordinary public catalog.
 *
 * 冷启动路径:
 *   - 宿主 Agent 路径: bootstrap (Mission Briefing) → dimension_complete × N
 *
 * Gateway gating: 写操作经过具体工具策略/确认/项目范围校验，Gateway 保留路由与审计。
 *
 * 本文件仅包含服务编排层（初始化、路由、Gateway gating、生命周期）。
 * 工具定义 → tools.js
 * Handler 实现 → handlers/*.js
 * 参数路由 → handlers/tool-router.js
 */

import Logger from '@alembic/core/logging';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type HostTurnMetaInput,
  readHostTurnMetaFromMcpRequest,
} from '#service/task/host-turn-meta.js';
import { projectLocationService } from '../context/ProjectLocationService.js';
import type { ProjectRuntimeContext } from '../context/ProjectRuntimeContext.js';
import { wrapHandler } from './errorHandler.js';
import type { McpContext, McpServiceContainer } from './handlers/types.js';
import {
  createCleanMcpErrorResponse,
  createMcpStructuredToolResult,
  isMcpCallToolResult,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from './output-contract.js';
import { type McpToolUsageMap, trackMcpToolUsage } from './session-usage.js';
import { TOOLS, withMcpToolAnnotations } from './tools.js';

// ─── TypeScript Interfaces ──────────────────────────────────

/** MCP session tracking */
interface McpConnection {
  id: string;
  startedAt: number;
  toolCallCount: number;
  toolsUsed: Set<string>;
  toolUsage: McpToolUsageMap;
  lastActivityAt: number;
}

/** McpServer constructor options */
interface McpServerOptions {
  actorRole?: string;
  container?: McpServiceContainer | null;
  bootstrap?: BootstrapLike | null;
  source?: ToolCallSource;
  surface?: ToolSurface;
  projectRoot?: string;
}

export interface McpToolCallOptions {
  actor?: ToolActor;
  projectRuntime?: ProjectRuntimeContext | null;
  source?: ToolCallSource;
  surface?: ToolSurface;
  hostTurnMeta?: HostTurnMetaInput;
}

interface ToolActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

interface ToolCallSource {
  kind: string;
  name: string;
}

type ToolSurface = 'mcp' | string;

type McpToolResponse = CallToolResult;

function isMcpToolResponse(value: unknown): value is McpToolResponse {
  return isMcpCallToolResult(value);
}

function isErrorResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { errorCode?: unknown; ok?: unknown; success?: unknown };
  return record.ok === false || record.success === false || Boolean(record.errorCode);
}

const RETIRED_PUBLIC_TOOL_REPLACEMENTS: Record<string, string> = {
  alembic_knowledge: 'Use alembic_search with operation=search/get/expand.',
  alembic_project_matrix:
    'alembic_project_matrix is retired. Use alembic_recipe_map for Recipe-mounted ProjectContext regions and alembic_graph for pure ProjectContext structure.',
  alembic_structure:
    'Use alembic_recipe_map for navigation and alembic_graph for ProjectContext-backed project relations.',
  alembic_call_context:
    'Use alembic_graph with concrete ProjectContext node/detail refs, then validate dynamic behavior with raw source reads or repository tests.',
  alembic_panorama:
    'Use alembic_recipe_map and alembic_graph. This retired route does not invoke the old panorama service.',
};

function createRetiredPublicToolResult(toolName: string): McpToolResponse {
  const replacement = RETIRED_PUBLIC_TOOL_REPLACEMENTS[toolName];
  return createMcpStructuredToolResult(
    createCleanMcpErrorResponse({
      code: 'CODEX_TOOL_RETIRED',
      message: `${toolName} is retired from the default public Alembic MCP surface. ${replacement}`,
      status: 'retired',
      toolName,
    })
  );
}

/** Bootstrap instance minimal shape */
interface BootstrapLike {
  initialize(): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

/** Tool handler function (sync or async, compatible with wrapHandler) */
type ToolHandlerFn = (ctx: McpContext, args: Record<string, unknown>) => Promise<unknown> | unknown;

// ─── Handler 模块 ─────────────────────────────────────────────

import * as agentPublicToolHandlers from './handlers/agent-public-tools.js';
import * as knowledgeHandlers from './handlers/knowledge.js';
import * as systemHandlers from './handlers/system.js';
import * as toolRouter from './handlers/tool-router.js';

// ─── Codex host-agent handlers ──────────────────────

import { consolidateHandler } from './handlers/consolidate.js';
import { dimensionComplete } from './handlers/host-agent/dimension-completion.js';
import { evolveForHostAgent } from './handlers/host-agent/evolve.js';
import { generateForHostAgent } from './handlers/host-agent/generate.js';
import { rescanForHostAgent } from './handlers/host-agent/rescan.js';

// ─── McpServer 类 ─────────────────────────────────────────────

export class McpServer {
  container: McpServiceContainer | null;
  logger: ReturnType<typeof Logger.getInstance> | null;
  _defaultActorRole: string | null;
  _defaultSource: ToolCallSource;
  _defaultSurface: ToolSurface;
  _connection: McpConnection;
  _startedAt: number;
  bootstrap: BootstrapLike | null;
  sdkServer: SdkMcpServer | null;
  readonly projectRoot: string | null;
  constructor(options: McpServerOptions = {}) {
    // Logger 延迟到 initialize() 之后获取，避免在 Bootstrap 之前触发单例初始化
    this.logger = null;
    this.container = options.container || null;
    this.bootstrap = options.bootstrap || null;
    this.sdkServer = null;
    this.projectRoot = options.projectRoot ?? null;
    this._startedAt = Date.now();
    this._defaultActorRole = options.actorRole || null;
    this._defaultSource = options.source || { kind: 'mcp', name: 'tools/call' };
    this._defaultSurface = options.surface || 'mcp';

    // ── Session 管理 ──
    this._connection = {
      id: `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startedAt: Date.now(),
      toolCallCount: 0,
      toolsUsed: new Set(),
      toolUsage: new Map(),
      lastActivityAt: Date.now(),
    };
  }

  /** 共享上下文对象，传给所有 handler（仅在 initialize() 之后使用） */
  get _ctx() {
    return {
      container: this.container,
      logger: this.logger || Logger.getInstance(),
      startedAt: this._startedAt,
      connection: this._connection,
    };
  }

  async initialize() {
    if (!this.container) {
      const { default: Bootstrap } = await import('../../bootstrap.js');

      // MCP 模式必须显式指定项目目录 — process.cwd() 在多根工作区中不可靠
      const projectRoot = this.projectRoot;
      if (!projectRoot) {
        const msg =
          `[MCP] 缺少 request-scoped projectRoot。MCP server 拒绝启动。\n` +
          `请由 Plugin 项目定位服务传入当前调用的明确 projectRoot。`;
        process.stderr.write(`${msg}\n`);
        throw new Error(msg);
      }

      // ── 排除项目检查 — 防止误配置 ALEMBIC_PROJECT_DIR 到不该创建运行时数据的目录 ──
      // Ghost 模式下跳过排除检查（数据不写入项目目录）
      const { isExcludedProject } = await import('@alembic/core/shared');
      const isGhost = projectLocationService.resolve(projectRoot).ghost;
      const exclusion = isExcludedProject(projectRoot);
      if (exclusion.excluded && !isGhost) {
        const msg =
          `[MCP] projectRoot "${projectRoot}" 是排除项目（${exclusion.reason}），` +
          `MCP server 拒绝在此目录创建运行时数据。\n` +
          `提示: 请由 Plugin 项目定位服务传入正确的 projectRoot。`;
        process.stderr.write(`${msg}\n`);
        throw new Error(msg);
      }

      // 切换工作目录到项目根 — 确保 DB 等相对路径正确解析
      if (projectRoot !== process.cwd()) {
        process.chdir(projectRoot);
      }

      Bootstrap.configurePathGuard(projectRoot);

      this.bootstrap = new Bootstrap();
      const components = await this.bootstrap.initialize();

      // 将 Bootstrap 组件注入 ServiceContainer
      const { getServiceContainer } = await import('#inject/ServiceContainer.js');
      this.container = getServiceContainer();
      await (
        this.container as unknown as { initialize(opts: Record<string, unknown>): Promise<void> }
      ).initialize({
        db: components.db,
        auditLogger: components.auditLogger,
        config: components.config,
        skillHooks: components.skillHooks,
        projectRoot,
        workspaceResolver: components.workspaceResolver,
      });
    }

    // Bootstrap 完成后获取 Logger 单例（此时已带 ghost 路径配置）
    this.logger = Logger.getInstance();

    this.sdkServer = new SdkMcpServer(
      { name: 'alembic-v3', version: '3.0.0' },
      { capabilities: { tools: {} } }
    );

    this._registerHandlers();
    return this;
  }

  /**
   * 注册 ListTools / CallTool 请求处理器
   * ListTools exposes the complete ordinary tool surface.
   */
  _registerHandlers() {
    if (!this.sdkServer) {
      throw new Error('MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS.map(withMcpToolAnnotations).map(withMcpOutputSchema) };
    });

    // ── CallTool: 路由到 handler ──
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const t0 = Date.now();
      try {
        return await this._handleToolCall(name, args || {}, {
          hostTurnMeta: readHostTurnMetaFromMcpRequest(request),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`MCP tool error: ${name}`, { error: errMsg });
        return createMcpStructuredToolResult(
          createCleanMcpErrorResponse({
            code: 'TOOL_ERROR',
            message: errMsg,
            responseTimeMs: Date.now() - t0,
            toolName: name,
          })
        );
      }
    });
  }

  async _handleToolCall(
    name: string,
    args: Record<string, unknown>,
    options: McpToolCallOptions = {}
  ): Promise<McpToolResponse> {
    if (Object.hasOwn(RETIRED_PUBLIC_TOOL_REPLACEMENTS, name)) {
      return createRetiredPublicToolResult(name);
    }
    const actorRole = options.actor?.role || this._defaultActorRole || this._resolveMcpActorRole();
    const source = options.source || this._defaultSource;
    const surface = options.surface || this._defaultSurface;
    const result = await this._executeMcpHandler(name, args, {
      actor: {
        role: actorRole,
        user: options.actor?.user || process.env.USER || undefined,
        sessionId: options.actor?.sessionId || this._connection.id,
      },
      projectRuntime: options.projectRuntime,
      source,
      surface,
      hostTurnMeta: options.hostTurnMeta,
    });
    if (isMcpToolResponse(result)) {
      return result;
    }
    return serializeMcpToolResult(name, result, { isErrorResult });
  }

  async _executeMcpHandler(
    name: string,
    args: Record<string, unknown>,
    runtime: {
      actor?: ToolActor;
      projectRuntime?: ProjectRuntimeContext | null;
      source?: ToolCallSource;
      surface?: ToolSurface;
      hostTurnMeta?: HostTurnMetaInput;
    } = {}
  ) {
    const ctx = this._ctx;
    Object.assign(ctx, {
      actor: runtime.actor,
      projectRuntime: runtime.projectRuntime,
      source: runtime.source,
      surface: runtime.surface,
      hostTurnMeta: runtime.hostTurnMeta,
    });

    // 查找 handler 并通过 wrapHandler 统一错误处理
    const handler = this._resolveHandler(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const wrapped = wrapHandler(name, handler as Parameters<typeof wrapHandler>[1]);

    const result = await wrapped(ctx, args);

    // ── Session 追踪 + 行为采集 ──
    this._trackSession(name, result);

    return result;
  }

  // ─── Session tracking + behavior collection ─────────────

  /**
   * Post-tool-call hook: update lightweight session stats only.
   * The retired intent lifecycle no longer records tool calls, drift, or active
   * decisions at the MCP server layer.
   */
  _trackSession(toolName: string, _result: unknown): void {
    // ── Session stats (always) ──
    this._connection.toolCallCount++;
    this._connection.toolsUsed.add(toolName);
    trackMcpToolUsage(this._connection.toolUsage, toolName);
    this._connection.lastActivityAt = Date.now();
  }

  /**
   * 解析工具名到 handler 函数（V3 routed surface）
   */
  _resolveHandler(name: string): ToolHandlerFn | null {
    const HANDLER_MAP: Record<string, ToolHandlerFn> = {
      // ── Agent 层 ──
      alembic_prime: (ctx, args) => agentPublicToolHandlers.primeHandler(ctx, args),
      // MTC-7: alembic_work routes by phase to the start/finish handlers.
      alembic_work: (ctx, args) =>
        (args as { phase?: unknown }).phase === 'finish'
          ? agentPublicToolHandlers.workFinishHandler(ctx, args)
          : agentPublicToolHandlers.workStartHandler(ctx, args),
      alembic_code_guard: (ctx, args) => agentPublicToolHandlers.codeGuardHandler(ctx, args),
      alembic_status: (ctx, args) => systemHandlers.status(ctx, args),
      alembic_recipe_map: (ctx, args) => toolRouter.routeRecipeMapTool(ctx, args),
      alembic_search: (ctx, args) =>
        toolRouter.routeSearchTool(ctx, args as Parameters<typeof toolRouter.routeSearchTool>[1]),
      // MTC-1: alembic_knowledge/structure/call_context retired (routes deleted).
      alembic_graph: (ctx, args) => toolRouter.routeGraphTool(ctx, args),
      alembic_plan: (ctx, args) => toolRouter.routePlanTool(ctx, args),
      alembic_submit_knowledge: (ctx, args) => toolRouter.routeSubmitKnowledgeTool(ctx, args),
      alembic_project_skill: (ctx, args) => toolRouter.routeProjectSkillTool(ctx, args),
      // ── Host Agent Bootstrap (v3.1) ──
      alembic_bootstrap: (ctx, args) =>
        generateForHostAgent(
          ctx as Parameters<typeof generateForHostAgent>[0],
          args as Parameters<typeof generateForHostAgent>[1]
        ),
      alembic_rescan: (ctx, args) =>
        rescanForHostAgent(
          ctx as Parameters<typeof rescanForHostAgent>[0],
          args as Parameters<typeof rescanForHostAgent>[1]
        ),
      alembic_evolve: (ctx, args) =>
        evolveForHostAgent(
          ctx as Parameters<typeof evolveForHostAgent>[0],
          args as Parameters<typeof evolveForHostAgent>[1]
        ),
      alembic_dimension_complete: (ctx, args) => dimensionComplete(ctx, args),
      alembic_consolidate: (ctx, args) =>
        consolidateHandler(
          ctx as Parameters<typeof consolidateHandler>[0],
          args as Parameters<typeof consolidateHandler>[1]
        ),
      // ── Admin 层 (+1) ──
      alembic_knowledge_lifecycle: (ctx, args) => knowledgeHandlers.knowledgeLifecycle(ctx, args),
    };
    return HANDLER_MAP[name] ?? null;
  }

  _resolveMcpActorRole() {
    return 'host-mcp';
  }

  // ─── Lifecycle ────────────────────────────────────────

  async start() {
    await this.initialize();

    const transport = new StdioServerTransport();
    if (!this.sdkServer) {
      throw new Error('MCP SDK server is not initialized');
    }
    await this.sdkServer.connect(transport);

    this.logger?.info(`MCP Server started (stdio) — ${TOOLS.length} tools`);
    process.stderr.write(`Alembic MCP ready — ${TOOLS.length} tools\n`);
  }

  async shutdown() {
    if (this.sdkServer) {
      await this.sdkServer.close();
    }
    if (this.bootstrap) {
      await this.bootstrap.shutdown();
    }
  }
}

export async function startMcpServer() {
  const server = new McpServer();
  await server.start();
  return server;
}

export default McpServer;
