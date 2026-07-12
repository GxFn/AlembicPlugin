import { envelope } from '../envelope.js';
import { buildMcpToolUsageView, type McpToolUsageMap } from '../session-usage.js';
import { type McpContext, requireRequestProjectRuntime } from './types.js';

/** Internal status projection for the embedded server. The public Host server
 * normally handles this tool first; both routes use the same location service. */
export async function status(ctx: McpContext, args: Record<string, unknown> = {}) {
  const location = requireRequestProjectRuntime(ctx).location;
  const aspect = typeof args.aspect === 'string' ? args.aspect : undefined;
  const project = {
    projectRoot: location.projectRoot,
    projectId: location.projectId,
    projectScopeId: location.projectScopeId,
    currentFolderId: location.currentFolderId,
    registered: location.registered,
    ghost: location.ghost,
    dataRoot: location.dataRoot,
    databasePath: location.databasePath,
    databaseExists: location.databaseExists,
  };
  const knowledge = {
    available: location.databaseExists,
    initialized: location.databaseExists,
    status: location.databaseExists ? 'available' : 'unavailable',
  };
  const runtime = {
    projectRoot: location.projectRoot,
    runtimeDir: location.runtimeDir,
  };
  const data =
    aspect === 'knowledge'
      ? { knowledge }
      : aspect === 'runtime'
        ? { project, runtime }
        : {
            initialized: location.databaseExists,
            project,
            knowledge,
            runtime,
            usage: buildMcpToolUsageView(ctx.toolUsage as McpToolUsageMap | undefined),
          };
  return envelope({ success: true, data, meta: { tool: 'alembic_status' } });
}
