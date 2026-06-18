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
    // MTC-7: alembic_job op routes to the shared job runner. bootstrap/rescan
    // enqueue an explicit resident job; status (default) reads recoverable job
    // status without starting a new job.
    case 'alembic_job': {
      const op = typeof args.op === 'string' ? args.op : undefined;
      if (op === 'bootstrap') {
        return { handled: true, result: handlers.enqueueJob('bootstrap', args) };
      }
      if (op === 'rescan') {
        return { handled: true, result: handlers.enqueueJob('rescan', args) };
      }
      return { handled: true, result: handlers.readJob(args) };
    }
    // MTC-7: alembic_runtime action routes daemon control. cleanup previews or
    // deletes runtime state (gated by confirm); stop (default) stops the daemon.
    case 'alembic_runtime': {
      const action = typeof args.action === 'string' ? args.action : undefined;
      if (action === 'cleanup') {
        return { handled: true, result: handlers.cleanupRuntime(args) };
      }
      return { handled: true, result: handlers.stopDaemon(args) };
    }
    default:
      return { handled: false };
  }
}
