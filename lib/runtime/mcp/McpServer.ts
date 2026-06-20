/**
 * Alembic V3 MCP Server — Codex plugin runtime
 *
 * Model Context Protocol (stdio transport)
 * 提供给插件宿主 Agent 的工具集
 *
 * V3.3 tool surface：39 → 16 工具（14 agent + 2 admin）
 * 通过 ALEMBIC_MCP_TIER 环境变量控制可见工具集（agent/admin）
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
import { wrapHandler } from '../../runtime/mcp/errorHandler.js';
import type { McpContext, McpServiceContainer } from '../../runtime/mcp/handlers/types.js';
import {
  createCleanMcpErrorResponse,
  createMcpStructuredToolResult,
  isMcpCallToolResult,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../../runtime/mcp/output-contract.js';
import { TIER_ORDER, TOOLS, withMcpToolAnnotations } from '../../runtime/mcp/tools.js';
import {
  isProjectScopeSummaryForFolder,
  readProjectScopeRuntimeFromEnv,
} from '../../shared/project-scope-runtime.js';

// ─── TypeScript Interfaces ──────────────────────────────────

/** MCP session tracking */
interface McpSession {
  id: string;
  startedAt: number;
  toolCallCount: number;
  toolsUsed: Set<string>;
  lastActivityAt: number;
}

/** McpServer constructor options */
interface McpServerOptions {
  actorRole?: string;
  container?: McpServiceContainer | null;
  bootstrap?: BootstrapLike | null;
  source?: ToolCallSource;
  surface?: ToolSurface;
}

export interface McpToolCallOptions {
  actor?: ToolActor;
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

import * as agentPublicToolHandlers from '../../runtime/mcp/handlers/agent-public-tools.js';
import * as knowledgeHandlers from '../../runtime/mcp/handlers/knowledge.js';
import * as systemHandlers from '../../runtime/mcp/handlers/system.js';
import * as toolRouter from '../../runtime/mcp/handlers/tool-router.js';

// ─── Codex host-agent handlers ──────────────────────

import { consolidateHandler } from '../../runtime/mcp/handlers/consolidate.js';
import { bootstrapForHostAgent } from '../../runtime/mcp/handlers/host-agent/bootstrap.js';
import { dimensionComplete } from '../../runtime/mcp/handlers/host-agent/dimension-completion.js';
import { evolveForHostAgent } from '../../runtime/mcp/handlers/host-agent/evolve.js';
import { rescanForHostAgent } from '../../runtime/mcp/handlers/host-agent/rescan.js';

// ─── McpServer 类 ─────────────────────────────────────────────

export class McpServer {
  container: McpServiceContainer | null;
  logger: ReturnType<typeof Logger.getInstance> | null;
  _defaultActorRole: string | null;
  _defaultSource: ToolCallSource;
  _defaultSurface: ToolSurface;
  _session: McpSession;
  _startedAt: number;
  bootstrap: BootstrapLike | null;
  sdkServer: SdkMcpServer | null;
  constructor(options: McpServerOptions = {}) {
    // Logger 延迟到 initialize() 之后获取，避免在 Bootstrap 之前触发单例初始化
    this.logger = null;
    this.container = options.container || null;
    this.bootstrap = options.bootstrap || null;
    this.sdkServer = null;
    this._startedAt = Date.now();
    this._defaultActorRole = options.actorRole || null;
    this._defaultSource = options.source || { kind: 'mcp', name: 'tools/call' };
    this._defaultSurface = options.surface || 'mcp';

    // ── Session 管理 ──
    this._session = {
      id: `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startedAt: Date.now(),
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: Date.now(),
    };
  }

  /** 共享上下文对象，传给所有 handler（仅在 initialize() 之后使用） */
  get _ctx() {
    return {
      container: this.container,
      logger: this.logger || Logger.getInstance(),
      startedAt: this._startedAt,
      session: this._session,
    };
  }

  async initialize() {
    if (!this.container) {
      const { default: Bootstrap } = await import('../../bootstrap.js');

      // MCP 模式必须显式指定项目目录 — process.cwd() 在多根工作区中不可靠
      const projectRoot = process.env.ALEMBIC_PROJECT_DIR;
      if (!projectRoot) {
        const msg =
          `[MCP] 缺少 ALEMBIC_PROJECT_DIR 环境变量。MCP server 拒绝启动。\n` +
          `在多根工作区中 process.cwd() 可能指向任意子目录，不能作为项目根目录。\n` +
          `请由插件宿主传入 ALEMBIC_PROJECT_DIR，或在调用 MCP 工具时提供明确的 projectRoot。`;
        process.stderr.write(`${msg}\n`);
        throw new Error(msg);
      }

      // ── 排除项目检查 — 防止误配置 ALEMBIC_PROJECT_DIR 到不该创建运行时数据的目录 ──
      // Ghost 模式下跳过排除检查（数据不写入项目目录）
      const { isExcludedProject } = await import('@alembic/core/shared');
      const { ProjectRegistry } = await import('@alembic/core/workspace');
      const isGhost = ProjectRegistry.isGhost(projectRoot);
      const exclusion = isExcludedProject(projectRoot);
      const projectScopeRuntime = readProjectScopeRuntimeFromEnv();
      const isProjectScopeGhostExecution =
        projectScopeRuntime?.summary.storageKind === 'ghost' &&
        isProjectScopeSummaryForFolder(projectScopeRuntime.summary, projectRoot);
      if (exclusion.excluded && !isGhost && !isProjectScopeGhostExecution) {
        const msg =
          `[MCP] projectRoot "${projectRoot}" 是排除项目（${exclusion.reason}），` +
          `MCP server 拒绝在此目录创建运行时数据。\n` +
          `提示: 请由插件宿主传入正确的 ALEMBIC_PROJECT_DIR。`;
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
   * ListTools 基于 ALEMBIC_MCP_TIER 过滤可见工具
   */
  _registerHandlers() {
    if (!this.sdkServer) {
      throw new Error('MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    // ── ListTools: 按 tier 过滤 ──
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tierName = process.env.ALEMBIC_MCP_TIER || 'agent';
      const maxTier = (TIER_ORDER as Record<string, number>)[tierName] ?? TIER_ORDER.agent;
      const visible = TOOLS.filter(
        (t) => ((TIER_ORDER as Record<string, number>)[t.tier || 'agent'] ?? 0) <= maxTier
      );
      return { tools: visible.map(withMcpToolAnnotations).map(withMcpOutputSchema) };
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
    if (name === 'alembic_task') {
      return createMcpStructuredToolResult(
        createCleanMcpErrorResponse({
          code: 'CODEX_TOOL_RETIRED',
          message:
            'alembic_task has been retired. Use alembic_prime, alembic_work, or alembic_code_guard.',
          status: 'retired',
          toolName: name,
        })
      );
    }
    const actorRole = options.actor?.role || this._defaultActorRole || this._resolveMcpActorRole();
    const source = options.source || this._defaultSource;
    const surface = options.surface || this._defaultSurface;
    const result = await this._executeMcpHandler(name, args, {
      actor: {
        role: actorRole,
        user: options.actor?.user || process.env.USER || undefined,
        sessionId: options.actor?.sessionId || this._session.id,
      },
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
      source?: ToolCallSource;
      surface?: ToolSurface;
      hostTurnMeta?: HostTurnMetaInput;
    } = {}
  ) {
    const ctx = this._ctx;
    Object.assign(ctx, {
      actor: runtime.actor,
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
    this._session.toolCallCount++;
    this._session.toolsUsed.add(toolName);
    this._session.lastActivityAt = Date.now();
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
      alembic_submit_knowledge: (ctx, args) => toolRouter.routeSubmitKnowledgeTool(ctx, args),
      alembic_project_skill: (ctx, args) => toolRouter.routeProjectSkillTool(ctx, args),
      // ── Host Agent Bootstrap (v3.1) ──
      alembic_bootstrap: (ctx, args) =>
        bootstrapForHostAgent(
          ctx as Parameters<typeof bootstrapForHostAgent>[0],
          args as Parameters<typeof bootstrapForHostAgent>[1]
        ),
      alembic_rescan: (ctx, args) =>
        rescanForHostAgent(ctx as Parameters<typeof rescanForHostAgent>[0], args),
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

    const tierName = process.env.ALEMBIC_MCP_TIER || 'agent';
    const maxTier = (TIER_ORDER as Record<string, number>)[tierName] ?? TIER_ORDER.agent;
    const visibleCount = TOOLS.filter(
      (t) => ((TIER_ORDER as Record<string, number>)[t.tier || 'agent'] ?? 0) <= maxTier
    ).length;

    this.logger?.info(`MCP Server started (stdio) — ${visibleCount} tools [tier=${tierName}]`);
    process.stderr.write(`Alembic MCP ready — ${visibleCount} tools [tier=${tierName}]\n`);
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
