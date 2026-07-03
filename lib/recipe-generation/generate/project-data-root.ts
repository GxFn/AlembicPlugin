import { resolveDataRoot, WorkspaceResolver } from '@alembic/core/workspace';

/**
 * Host-agent cold-start writes must follow the current Codex project identity.
 * The shared MCP container may carry resident or previously selected project
 * state, so derive the data root from the explicit project root first.
 */
export function resolveHostAgentDataRoot(container: unknown, projectRoot: string): string {
  try {
    return WorkspaceResolver.fromProjectScopeRegistry(projectRoot).dataRoot;
  } catch {
    try {
      // @scope-singleroot(temporary) - legacy container fallback when no native scope is available.
      return resolveDataRoot(container as never) || projectRoot;
    } catch {
      return projectRoot;
    }
  }
}
