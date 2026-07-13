import type { HostTurnMetaInput } from '#service/task/host-turn-meta.js';
import { resetServiceContainer } from '../../../injection/ServiceContainer.js';
import {
  ProjectContextBuildSessionManager,
  ProjectContextContinuationError,
} from '../../../service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import type { ProjectRuntimeContext } from '../../context/ProjectRuntimeContext.js';
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
      return {
        ...failureResult(name, `Unknown Alembic tool: ${name}`),
        errorCode: 'CODEX_UNKNOWN_TOOL',
      };
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
      const localMcp = await this.#getPluginOwnedMcpServer(executionContext);
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
      });
      return attachExecutionContext(result, executionContext, this.#hostProjectRoot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ProjectContextContinuationError) {
        return attachExecutionContext(
          {
            ...failureResult(name, message, { retryable: err.retryable }),
            errorCode: err.code,
          },
          executionContext,
          this.#hostProjectRoot
        );
      }
      return attachExecutionContext(
        failureResult(name, `Plugin-owned Codex tool execution failed: ${message}`),
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
    return record;
  }
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  const projectRuntimePatch =
    executionContext.projectRuntime && !Object.hasOwn(data, 'projectRuntime')
      ? { projectRuntime: executionContext.projectRuntime }
      : {};
  return Object.keys(projectRuntimePatch).length > 0
    ? { ...record, data: { ...data, ...projectRuntimePatch } }
    : result;
}
