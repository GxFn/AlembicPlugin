import type { HostTurnMetaInput } from '#service/task/host-turn-meta.js';
import { resetServiceContainer } from '../../../injection/ServiceContainer.js';
import type { ServiceBoundaryDecision } from '../../../runtime/index.js';
import type { McpServiceContainer } from '../../../runtime/mcp/handlers/types.js';
import { safeProjectRootFallback } from '../../../runtime/mcp/host/project-root.js';
import { attachServiceBoundary, failureResult } from '../../../runtime/mcp/host/results.js';
import { McpServer as EmbeddedMcpServer } from '../../../runtime/mcp/McpServer.js';
import { isCleanMcpResponse } from '../../../runtime/mcp/output-contract.js';
import { TOOLS } from '../../../runtime/mcp/tools.js';
import type { ProjectRuntimeContext } from '../../../runtime/runtime/ProjectRuntimeContext.js';
import type { AlembicResidentProjectScopeIdentity } from '../../../service/resident/AlembicResidentServiceClient.js';
import {
  ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV,
  serializeProjectScopeSummary,
} from '../../../shared/project-scope-runtime.js';

export interface ToolExecutionContext {
  projectRuntime?: ProjectRuntimeContext | null;
  projectRoot: string;
  projectScopeIdentity: AlembicResidentProjectScopeIdentity | null;
  residentProjectScopeAvailable: boolean;
}

export interface EmbeddedToolExecutorOptions {
  getSessionId(): string;
  hostProjectRoot: string;
}

interface EmbeddedToolCallOptions {
  hostTurnMeta?: HostTurnMetaInput;
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

  constructor(options: EmbeddedToolExecutorOptions) {
    this.#getSessionId = options.getSessionId;
    this.#hostProjectRoot = options.hostProjectRoot;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    serviceBoundary: ServiceBoundaryDecision,
    executionContext: ToolExecutionContext,
    options: EmbeddedToolCallOptions = {}
  ): Promise<unknown> {
    if (!TOOLS.some((tool) => tool.name === name)) {
      return attachServiceBoundary(
        failureResult(name, `Unknown Alembic tool: ${name}`),
        serviceBoundary
      );
    }

    try {
      const localMcp = await this.#getPluginOwnedMcpServer(executionContext);
      const result = await localMcp._executeMcpHandler(name, args, {
        actor: {
          role: 'host-mcp',
          user: process.env.USER || undefined,
          sessionId: this.#getSessionId(),
        },
        source: { kind: 'codex', name: 'plugin-owned-codex-facing' },
        surface: 'codex',
        hostTurnMeta: options.hostTurnMeta,
      });
      return attachExecutionContext(
        attachServiceBoundary(result, serviceBoundary),
        executionContext,
        this.#hostProjectRoot
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return attachExecutionContext(
        attachServiceBoundary(
          failureResult(name, `Plugin-owned Codex tool execution failed: ${message}`),
          serviceBoundary
        ),
        executionContext,
        this.#hostProjectRoot
      );
    }
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
      executionContext.projectScopeIdentity?.projectScopeId ?? 'single-folder',
      executionContext.projectScopeIdentity?.currentFolderId ?? '',
    ].join('\0');
    if (sharedPluginOwnedMcpServer && sharedPluginOwnedMcpServerKey === scopeKey) {
      return sharedPluginOwnedMcpServer;
    }
    await resetPluginOwnedMcpServer();

    const previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
    const previousProjectScopeSummary = process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
    const previousCwd = safeProjectRootFallback();
    process.env.ALEMBIC_PROJECT_DIR = executionContext.projectRoot;
    const serializedProjectScope = serializeProjectScopeSummary(
      executionContext.projectScopeIdentity?.projectScope ?? null
    );
    if (serializedProjectScope) {
      process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV] = serializedProjectScope;
    } else {
      delete process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
    }
    const server = new EmbeddedMcpServer({
      actorRole: 'host-mcp',
      source: { kind: 'codex', name: 'plugin-owned-codex-facing' },
      surface: 'codex',
    });
    try {
      // Plugin-owned Codex tools use the embedded Plugin handler tree. Alembic daemon can still
      // serve resident capabilities, but it must not replace Codex-facing task payload ownership.
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
  const identity = executionContext.residentProjectScopeAvailable
    ? executionContext.projectScopeIdentity
    : null;
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
  if (!identity) {
    return Object.keys(projectRuntimePatch).length > 0
      ? {
          ...record,
          data: {
            ...data,
            ...projectRuntimePatch,
          },
        }
      : result;
  }
  return {
    ...record,
    data: {
      ...data,
      ...projectRuntimePatch,
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
