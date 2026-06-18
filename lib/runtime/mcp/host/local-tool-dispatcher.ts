export interface CodexLocalToolHandlers {
  buildColdStartKnowledgeStatus(): Promise<Record<string, unknown>>;
  buildDiagnostics(): Promise<Record<string, unknown>>;
  buildStatus(): Promise<Record<string, unknown>>;
  cleanupRuntime(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  openDashboard(): Promise<Record<string, unknown>>;
  enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown>;
  readJob(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  stopDaemon(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type CodexLocalToolDispatchResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: Promise<unknown>;
    };

export function dispatchCodexLocalTool(
  name: string,
  args: Record<string, unknown>,
  handlers: CodexLocalToolHandlers
): CodexLocalToolDispatchResult {
  switch (name) {
    // MTC-4: alembic_mcp_status + alembic_codex_diagnostics merged into
    // alembic_status. aspect routes the cold-start view: knowledge = local
    // knowledge presence (never resident-only), runtime = runtime diagnostics,
    // omitted = the workspace/daemon status overview.
    case 'alembic_status': {
      const aspect = typeof args.aspect === 'string' ? args.aspect : undefined;
      if (aspect === 'knowledge') {
        return { handled: true, result: handlers.buildColdStartKnowledgeStatus() };
      }
      if (aspect === 'runtime') {
        return { handled: true, result: handlers.buildDiagnostics() };
      }
      return { handled: true, result: handlers.buildStatus() };
    }
    case 'alembic_mcp_init':
      return { handled: true, result: handlers.initializeWorkspace(args) };
    case 'alembic_codex_dashboard':
      return { handled: true, result: handlers.openDashboard() };
    case 'alembic_mcp_bootstrap_job':
      return { handled: true, result: handlers.enqueueJob('bootstrap', args) };
    case 'alembic_mcp_rescan_job':
      return { handled: true, result: handlers.enqueueJob('rescan', args) };
    case 'alembic_codex_job':
      return { handled: true, result: handlers.readJob(args) };
    case 'alembic_codex_stop':
      return { handled: true, result: handlers.stopDaemon(args) };
    case 'alembic_codex_cleanup':
      return { handled: true, result: handlers.cleanupRuntime(args) };
    default:
      return { handled: false };
  }
}
