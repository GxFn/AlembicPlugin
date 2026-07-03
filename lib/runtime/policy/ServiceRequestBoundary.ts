export type ServiceBoundaryOwner = 'alembic-plugin' | 'alembic-resident-service';

export type ServiceBoundaryExecutionPath = 'plugin-owned-codex-facing' | 'resident-service-request';

export interface ServiceBoundaryDecision {
  executionPath: ServiceBoundaryExecutionPath;
  operation: string | null;
  owner: ServiceBoundaryOwner;
  reason: string;
  residentServiceRequested: boolean;
  sharedContractCandidate: boolean;
  tool: string;
}

const RESIDENT_SERVICE_REQUEST_TOOLS = new Set(['alembic_search', 'alembic_job']);

export function resolveServiceRequestBoundary(
  tool: string,
  args: Record<string, unknown>
): ServiceBoundaryDecision {
  const operation = typeof args.operation === 'string' ? args.operation : null;

  // Codex-facing MCP tools are Plugin-owned. Alembic may still be asked through explicit resident
  // service APIs such as /api/v1/search, but never through the removed daemon MCP bridge.
  return {
    executionPath: 'plugin-owned-codex-facing',
    operation,
    owner: 'alembic-plugin',
    reason: buildPluginOwnedReason(tool, operation),
    residentServiceRequested: RESIDENT_SERVICE_REQUEST_TOOLS.has(tool),
    sharedContractCandidate: true,
    tool,
  };
}

export function isPluginOwnedTool(decision: ServiceBoundaryDecision): boolean {
  return decision.executionPath === 'plugin-owned-codex-facing';
}

function buildPluginOwnedReason(tool: string, operation: string | null): string {
  if (tool === 'alembic_task') {
    return operation
      ? 'Retired alembic_task direct calls remain Plugin-owned fail-closed semantics; local daemon readiness must not transfer old task operation ownership.'
      : 'Retired alembic_task validation and unknown-operation errors are Plugin-owned Codex-facing semantics.';
  }
  if (tool === 'alembic_search') {
    return 'alembic_search is Codex-facing and runs in AlembicPlugin; semantic/vector enhancement must use the explicit Alembic resident /api/v1/search API.';
  }
  if (tool === 'alembic_job') {
    return `${tool} is Codex-facing and owned by AlembicPlugin; local Alembic is requested only through explicit resident service APIs.`;
  }
  return 'Codex-facing Alembic tools run in AlembicPlugin; the daemon MCP compatibility bridge is removed.';
}
