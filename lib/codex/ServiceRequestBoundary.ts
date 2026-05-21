const PLUGIN_OWNED_TASK_OPERATIONS = new Set([
  'prime',
  'create',
  'close',
  'fail',
  'record_decision',
]);

export type CodexServiceBoundaryOwner = 'alembic-plugin' | 'alembic-resident-service';

export type CodexServiceBoundaryExecutionPath =
  | 'daemon-mcp-compat-bridge'
  | 'plugin-owned-codex-facing'
  | 'resident-service-request';

export interface CodexServiceBoundaryDecision {
  executionPath: CodexServiceBoundaryExecutionPath;
  operation: string | null;
  owner: CodexServiceBoundaryOwner;
  reason: string;
  residentServiceRequested: boolean;
  sharedContractCandidate: boolean;
  tool: string;
}

export function resolveCodexServiceRequestBoundary(
  tool: string,
  args: Record<string, unknown>
): CodexServiceBoundaryDecision {
  const operation = typeof args.operation === 'string' ? args.operation : null;

  if (tool === 'alembic_task') {
    return {
      executionPath: 'plugin-owned-codex-facing',
      operation,
      owner: 'alembic-plugin',
      reason: PLUGIN_OWNED_TASK_OPERATIONS.has(operation ?? '')
        ? 'alembic_task owns Codex intent lifecycle and prime host-response payloads; local daemon readiness must not transfer tool ownership.'
        : 'alembic_task validation and unknown-operation errors are Plugin-owned Codex-facing semantics; they must not be delegated to a daemon bridge.',
      residentServiceRequested: false,
      sharedContractCandidate: true,
      tool,
    };
  }

  return {
    executionPath: 'daemon-mcp-compat-bridge',
    operation,
    owner: 'alembic-resident-service',
    reason:
      'No Plugin-owned Codex interaction boundary is declared for this tool; keep the daemon MCP bridge as a compatibility service request path.',
    residentServiceRequested: true,
    sharedContractCandidate: false,
    tool,
  };
}

export function isPluginOwnedCodexFacingTool(decision: CodexServiceBoundaryDecision): boolean {
  return decision.executionPath === 'plugin-owned-codex-facing';
}
