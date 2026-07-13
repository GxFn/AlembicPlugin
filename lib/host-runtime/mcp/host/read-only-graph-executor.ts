import { resolve } from 'node:path';
import type { ProjectContextBuildSessionManager } from '../../../service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { GraphInput } from '../../../shared/schemas/mcp-tools.js';
import { graph } from '../handlers/structure.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';

/** Public Graph reads only request-scoped ProjectContext source facts. */
export async function executeReadOnlyGraph(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext,
  projectContextExecution?: {
    buildSessions: ProjectContextBuildSessionManager;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Graph.');
  }
  const identity = projectRuntime.identity;
  GraphInput.parse(args);
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const container: McpServiceContainer = {
    get(name: string): unknown {
      throw new Error(`Read-only Graph container does not expose ${name}.`);
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: { dataRoot },
    },
  };
  const ctx: McpContext = { container, projectRuntime, projectContextExecution };
  return graph(ctx, args);
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Graph project identity is missing ${field}.`);
  }
  return value;
}
