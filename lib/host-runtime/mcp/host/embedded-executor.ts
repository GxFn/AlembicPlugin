import Logger from '@alembic/core/logging';
import { z } from 'zod';
import type { HostTurnMetaInput } from '#service/task/host-turn-meta.js';
import { resetServiceContainer } from '../../../injection/ServiceContainer.js';
import {
  ProjectContextBuildSessionManager,
  ProjectContextContinuationError,
} from '../../../service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { projectLocationService } from '../../context/ProjectLocationService.js';
import type { ProjectRuntimeContext } from '../../context/ProjectRuntimeContext.js';
import { StrictPublicationError } from '../../context/StrictPublicationError.js';
import { formatZodValidationMessage } from '../errorHandler.js';
import type { McpServiceContainer } from '../handlers/types.js';
import { McpServer as EmbeddedMcpServer } from '../McpServer.js';
import { isCleanMcpResponse } from '../output-contract.js';
import { TOOLS } from '../tools.js';
import { safeProjectRootFallback } from './project-root.js';
import { executeReadOnlyCodeGuard } from './read-only-code-guard-executor.js';
import { executeReadOnlyGraph } from './read-only-graph-executor.js';
import { executeReadOnlyPrime } from './read-only-prime-executor.js';
import { executeReadOnlyRecipeMap } from './read-only-recipe-map-executor.js';
import { executeReadOnlySearch } from './read-only-search-executor.js';
import { failureResult } from './results.js';
import {
  maybeRunStagingAccessSweep,
  STAGING_ACCESS_SWEEP_TOOL_NAMES,
} from './staging-access-sweep.js';

export interface ToolExecutionContext {
  projectRuntime?: ProjectRuntimeContext | null;
  projectRoot: string;
}

export interface EmbeddedToolExecutorOptions {
  getSessionId(): string;
  hostProjectRoot: string;
}

interface EmbeddedToolCallOptions {
  hostTurnMeta?: HostTurnMetaInput;
  signal?: AbortSignal;
}

let sharedPluginOwnedMcpServer: EmbeddedMcpServer | null = null;
let sharedPluginOwnedMcpServerKey: string | null = null;

export async function resetPluginOwnedMcpServer(): Promise<void> {
  const server = sharedPluginOwnedMcpServer;
  sharedPluginOwnedMcpServer = null;
  sharedPluginOwnedMcpServerKey = null;
  try {
    await server?.shutdown();
  } finally {
    resetServiceContainer();
  }
}

export async function resetPluginOwnedMcpServerForTests(): Promise<void> {
  await resetPluginOwnedMcpServer();
}

export class EmbeddedToolExecutor {
  readonly #getSessionId: () => string;
  readonly #hostProjectRoot: string;
  readonly #projectContextBuildSessions = new ProjectContextBuildSessionManager();

  constructor(options: EmbeddedToolExecutorOptions) {
    this.#getSessionId = options.getSessionId;
    this.#hostProjectRoot = options.hostProjectRoot;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    executionContext: ToolExecutionContext,
    options: EmbeddedToolCallOptions = {}
  ): Promise<unknown> {
    if (!TOOLS.some((tool) => tool.name === name)) {
      return failureResult(name, `Unknown Alembic tool: ${name}`, {
        code: 'CODEX_UNKNOWN_TOOL',
      });
    }

    try {
      if (name === 'alembic_search') {
        const result = await executeReadOnlySearch(args, executionContext);
        return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
      }
      if (name === 'alembic_graph') {
        const result = await executeReadOnlyGraph(args, executionContext, {
          buildSessions: this.#projectContextBuildSessions,
          signal: options.signal,
        });
        return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
      }
      if (name === 'alembic_prime') {
        const result = await executeReadOnlyPrime(args, executionContext);
        return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
      }
      if (name === 'alembic_recipe_map') {
        const result = await executeReadOnlyRecipeMap(args, executionContext, {
          buildSessions: this.#projectContextBuildSessions,
          signal: options.signal,
        });
        return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
      }
      if (name === 'alembic_code_guard') {
        const result = await executeReadOnlyCodeGuard(args, executionContext);
        return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
      }
      // 未初始化门禁（用户决策：拒绝并引导 alembic_init）。必须在打开插件自有容器之前判定：
      // 容器初始化会跑 Bootstrap，在 dataRoot（未注册项目即仓库本身）下创建 .asd/alembic.db 与日志，
      // 之后再看 databaseExists 也会把未初始化项目误判为已初始化。
      if (!isRequestProjectInitialized(executionContext.projectRoot)) {
        if (options.signal?.aborted) {
          // 已取消的请求保持 CANCELLED 语义，不被未初始化拒绝覆盖。
          const reason = abortReasonMessage(options.signal.reason);
          Logger.getInstance().warn(
            `[MCP:${name}] CANCELLED before initialization gate: ${reason}`,
            {
              projectRoot: executionContext.projectRoot,
            }
          );
          return attachExecutionContext(
            failureResult(name, `Plugin-owned tool execution failed: ${reason}`, {
              code: 'CANCELLED',
            }),
            executionContext,
            this.#hostProjectRoot
          );
        }
        return attachExecutionContext(
          projectNotInitializedResult(name, executionContext.projectRoot),
          executionContext,
          this.#hostProjectRoot
        );
      }
      const localMcp = await this.#getPluginOwnedMcpServer(executionContext);
      if (STAGING_ACCESS_SWEEP_TOOL_NAMES.has(name)) {
        // 走到这里项目必然已初始化（门禁已在容器打开前判定）。
        await runStagingAccessSweepBeforeHandler(name, localMcp, executionContext, options.signal);
      }
      const result = await localMcp._executeMcpHandler(name, args, {
        actor: {
          role: 'host-mcp',
          user: process.env.USER || undefined,
          sessionId: this.#getSessionId(),
        },
        projectRuntime: executionContext.projectRuntime,
        source: { kind: 'codex', name: 'plugin-owned-codex-facing' },
        surface: 'codex',
        hostTurnMeta: options.hostTurnMeta,
        signal: options.signal,
      });
      return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ProjectContextContinuationError) {
        return attachExecutionContext(
          failureResult(name, message, {
            code: err.code,
            data: { retryable: err.retryable },
          }),
          executionContext,
          this.#hostProjectRoot
        );
      }
      if (err instanceof StrictPublicationError) {
        return attachExecutionContext(
          failureResult(name, `Plugin-owned tool execution failed: ${message}`, {
            code: err.code,
            data: { retryable: err.retryable },
          }),
          executionContext,
          this.#hostProjectRoot
        );
      }
      if (err instanceof z.ZodError && READ_ONLY_SELF_PARSING_TOOL_NAMES.has(name)) {
        return attachExecutionContext(
          readOnlyValidationErrorResult(name, err),
          executionContext,
          this.#hostProjectRoot
        );
      }
      // Read-only Graph/Recipe Map 不经过 wrapHandler；已知业务错误保持上方优先级，
      // 这里只将真实 AbortError 归类为取消，不能因 signal 已取消就重写其它失败。
      const cancelled = err instanceof Error && err.name === 'AbortError';
      if (cancelled) {
        Logger.getInstance().warn(`[MCP:${name}] CANCELLED: ${message}`, {
          tool: name,
          errorCode: 'CANCELLED',
        });
      }
      return attachExecutionContext(
        failureResult(name, `Plugin-owned tool execution failed: ${message}`, {
          code: cancelled ? 'CANCELLED' : 'INTERNAL_ERROR',
        }),
        executionContext,
        this.#hostProjectRoot
      );
    }
  }

  async dispose(): Promise<void> {
    await this.#projectContextBuildSessions.dispose();
  }

  async withPluginOwnedContainer<T>(
    executionContext: ToolExecutionContext,
    callback: (container: McpServiceContainer) => Promise<T>
  ): Promise<T> {
    const localMcp = await this.#getPluginOwnedMcpServer(executionContext);
    if (!localMcp.container) {
      throw new Error('Plugin-owned MCP container is not initialized');
    }
    return callback(localMcp.container);
  }

  async #getPluginOwnedMcpServer(
    executionContext: ToolExecutionContext
  ): Promise<EmbeddedMcpServer> {
    const scopeKey = [
      executionContext.projectRoot,
      executionContext.projectRuntime?.identity.projectScopeId ?? 'single-folder',
      executionContext.projectRuntime?.identity.currentFolderId ?? '',
    ].join('\0');
    if (sharedPluginOwnedMcpServer && sharedPluginOwnedMcpServerKey === scopeKey) {
      return sharedPluginOwnedMcpServer;
    }
    await resetPluginOwnedMcpServer();

    const previousCwd = safeProjectRootFallback();
    const server = new EmbeddedMcpServer({
      actorRole: 'host-mcp',
      projectRoot: executionContext.projectRoot,
      source: { kind: 'codex', name: 'plugin-owned-codex-facing' },
      surface: 'codex',
    });
    try {
      // Plugin-owned tools execute in-process for this request-scoped project.
      await server.initialize();
      sharedPluginOwnedMcpServer = server;
      sharedPluginOwnedMcpServerKey = scopeKey;
      return server;
    } catch (err: unknown) {
      try {
        await server.shutdown();
      } catch {
        // Ignore shutdown errors while preserving the original initialization failure.
      }
      resetServiceContainer();
      throw err;
    } finally {
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
}

/**
 * 自行用 Zod 解析入参、不经过 wrapHandler 的五个只读执行器。它们抛出的 ZodError 来自入参解析
 * （parse 位于任何知识库访问之前），属于调用方输入错误而非内部故障。
 */
const READ_ONLY_SELF_PARSING_TOOL_NAMES = new Set([
  'alembic_prime',
  'alembic_search',
  'alembic_graph',
  'alembic_recipe_map',
  'alembic_code_guard',
]);

/**
 * 只读执行器的入参校验失败：与 wrapHandler 的 VALIDATION_ERROR 同码，消息由 errorHandler
 * 的唯一格式化函数生成（`输入校验失败: <path>: <message>; ...`），标记不可重试——同样的入参重试必然再次失败。
 */
function readOnlyValidationErrorResult(toolName: string, err: z.ZodError): Record<string, unknown> {
  const message = formatZodValidationMessage(err);
  // Logger 输出到 stderr / 日志文件，不占用 stdout（MCP 协议通道）。
  Logger.getInstance().warn(`[MCP:${toolName}] VALIDATION_ERROR: ${message}`, {
    tool: toolName,
    errorCode: 'VALIDATION_ERROR',
    path: 'read-only-executor',
  });
  return failureResult(toolName, message, {
    code: 'VALIDATION_ERROR',
    data: { retryable: false },
  });
}

/** 未初始化项目拒绝写类工具时使用的错误码（错误分类表中映射为 not-found）。 */
export const PROJECT_NOT_INITIALIZED_CODE = 'PROJECT_NOT_INITIALIZED';

/**
 * 请求项目是否已初始化（知识库数据库存在），口径与 alembic_status 的 initialized /
 * projectRuntime.location.databaseExists 相同。只读解析，不创建任何文件；
 * 解析失败直接抛出，由调用方归类为内部错误，不能把无效项目当作“未初始化”引导去 init。
 */
export function isRequestProjectInitialized(projectRoot: string): boolean {
  return projectLocationService.resolve(projectRoot).databaseExists;
}

/**
 * 未初始化项目上的写类工具拒绝结果（legacy failureResult 信封）：告诉 Agent 先调用 alembic_init，
 * 不自动初始化——RELEASE-PLAYBOOK：没有数据库的项目不会被自动初始化，默认 Ghost、仓库内零文件。
 */
export function projectNotInitializedResult(
  toolName: string,
  projectRoot: string
): Record<string, unknown> {
  const reason = `No Alembic knowledge database exists for ${projectRoot}; call alembic_init for this project before ${toolName}.`;
  Logger.getInstance().warn(
    `[MCP:${toolName}] ${PROJECT_NOT_INITIALIZED_CODE}: refused before Bootstrap; no project files created`,
    { projectRoot }
  );
  return failureResult(
    toolName,
    `Alembic is not initialized for this project (${projectRoot}). Call alembic_init first, then retry ${toolName}.`,
    {
      code: PROJECT_NOT_INITIALIZED_CODE,
      data: {
        requiredActions: [`Call alembic_init for this project, then retry ${toolName}.`],
        nextActions: [{ tool: 'alembic_init', required: true, reason }],
      },
    }
  );
}

function abortReasonMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return typeof reason === 'string' && reason ? reason : 'Request cancelled.';
}

/**
 * 恢复的 tick-on-access staging sweep（用户决策）：删 daemon 后，staging→active 晋级、
 * lifecycle 超时、observing proposal 执行与 decay 只靠写类工具访问时驱动。
 * - 仅在 STAGING_ACCESS_SWEEP_TOOL_NAMES（submit / dimension_complete / rescan）、且复用本次请求项目的
 *   插件自有容器时运行；只读工具与本地工具不进入此处。调用点位于未初始化门禁之后，项目必然已初始化
 *   （未初始化项目在容器打开前就被拒绝，sweep 不会被调用）。
 * - 节流（15s/项目）、共享 cap（50）、信封超时（2s）由 maybeRunStagingAccessSweep 保证；
 *   这里再兜底吞掉任何异常，sweep 失败/超时只记诊断，绝不让工具失败，也不写入工具响应。
 */
async function runStagingAccessSweepBeforeHandler(
  toolName: string,
  localMcp: EmbeddedMcpServer,
  executionContext: ToolExecutionContext,
  signal: AbortSignal | undefined
): Promise<void> {
  const logger = Logger.getInstance();
  const projectRoot = executionContext.projectRoot;
  if (signal?.aborted) {
    logger.debug(`[StagingAccessSweep] ${toolName} skipped: request already cancelled`, {
      projectRoot,
    });
    return;
  }
  const container = localMcp.container;
  if (!container) {
    logger.warn(`[StagingAccessSweep] ${toolName} skipped: plugin-owned container missing`, {
      projectRoot,
    });
    return;
  }
  try {
    const result = await maybeRunStagingAccessSweep({
      getContainer: async () => container,
      logger,
      projectRoot,
      toolName,
    });
    if (result.timedOut) {
      // 信封超时后 sweep 在后台继续（in-flight 防重入），工具照常执行。
      logger.warn(
        `[StagingAccessSweep] ${toolName} continues before staging sweep finished for ${projectRoot}`
      );
    } else if (result.skipped) {
      // throttled / in-flight / driver 失败（失败已由 sweep 自身 warn）：只记 debug 诊断。
      logger.debug(
        `[StagingAccessSweep] ${toolName} sweep skipped: ${result.reason ?? 'unknown'}`,
        {
          projectRoot,
        }
      );
    }
  } catch (err: unknown) {
    logger.warn(`[StagingAccessSweep] ${toolName} sweep threw; tool continues`, {
      error: err instanceof Error ? err.message : String(err),
      projectRoot,
    });
  }
}

function attachExecutionContext(
  result: unknown,
  executionContext: ToolExecutionContext,
  hostProjectRoot: string
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (isCleanMcpResponse(record)) {
    const publication = publicationForResult(record, executionContext);
    return {
      ...record,
      _meta: {
        ...(record._meta && typeof record._meta === 'object' && !Array.isArray(record._meta)
          ? (record._meta as Record<string, unknown>)
          : {}),
        alembicPublication: publication,
      },
    };
  }
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  const projectRuntimePatch =
    executionContext.projectRuntime && !Object.hasOwn(data, 'projectRuntime')
      ? { projectRuntime: executionContext.projectRuntime }
      : {};
  const publication = publicationForResult(record, executionContext);
  return Object.keys(projectRuntimePatch).length > 0
    ? {
        ...record,
        _meta: { alembicPublication: publication },
        data: { ...data, ...projectRuntimePatch },
      }
    : { ...record, _meta: { alembicPublication: publication } };
}

function publicationForResult(
  result: Record<string, unknown>,
  executionContext: ToolExecutionContext
): ProjectRuntimeContext['publication'] | null {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    return null;
  }
  const publication = projectRuntime.publication;
  if (publication.mode !== 'strict-v1' || publication.routeState !== 'ready') {
    return publication;
  }
  const structured = asRecord(result.structuredContent);
  const meta = asRecord(structured?.meta);
  const projectContext = asRecord(meta?.projectContext);
  const liveProbe = asRecord(projectContext?.liveProbeReceipt);
  const observed =
    typeof liveProbe?.observedSourceVectorHash === 'string'
      ? liveProbe.observedSourceVectorHash
      : null;
  if (!observed || !publication.sourceRevisionVectorHash) {
    return publication;
  }
  const sourceRevisionMatch =
    observed === publication.sourceRevisionVectorHash ? 'matched' : 'mismatched';
  projectRuntime.publication = { ...publication, sourceRevisionMatch };
  return projectRuntime.publication;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
