export interface LocalToolHandlers {
  buildColdStartKnowledgeStatus(): Promise<Record<string, unknown>>;
  buildDiagnostics(): Promise<Record<string, unknown>>;
  buildStatus(): Promise<Record<string, unknown>>;
  cleanupRuntime(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  initializeWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  enqueueJob(kind: 'bootstrap' | 'rescan', args: Record<string, unknown>): Promise<unknown>;
  readJob(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type LocalToolDispatchResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: Promise<unknown>;
    };

export function dispatchLocalTool(
  name: string,
  args: Record<string, unknown>,
  handlers: LocalToolHandlers
): LocalToolDispatchResult {
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
    case 'alembic_init':
      return { handled: true, result: handlers.initializeWorkspace(args) };
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
    // MTC-7: alembic_runtime action routes runtime control. cleanup previews or
    // deletes LOCAL runtime state files (gated by confirm). PDR-3: the embedded
    // daemon is removed, so the daemon-stop action is gone; cleanup is the only
    // action. MTC-5: action is required (no default) — a bare/invalid call
    // returns a blocker instead of accidentally running cleanup.
    case 'alembic_runtime': {
      const action = typeof args.action === 'string' ? args.action : undefined;
      if (action === 'cleanup') {
        return { handled: true, result: handlers.cleanupRuntime(args) };
      }
      return {
        handled: true,
        result: Promise.resolve({
          success: false,
          errorCode: 'CODEX_RUNTIME_ACTION_REQUIRED',
          message: "alembic_runtime requires action='cleanup'.",
        }),
      };
    }
    default:
      return { handled: false };
  }
}
