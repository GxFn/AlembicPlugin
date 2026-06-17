/**
 * NoOpAuditLogger — RIC-8 audit decoupling for the slimmed embedded daemon.
 *
 * The embedded daemon is decoupled from real audit: it injects this no-op instead of the
 * DB-backed AuditLogger, so daemon HTTP write operations produce no audit-log entries (and
 * the daemon does not open the audit store). The MCP host path keeps the real AuditLogger
 * (Bootstrap default mode), so MCP audit behavior is unchanged.
 *
 * Satisfies the structural AuditLoggerLike shape that Core's KnowledgeService/GuardService
 * require (they only ever call `.log()`, non-blocking). It does NOT implement the audit
 * read surface (query/getStats/...) because the slimmed daemon exposes no audit HTTP route;
 * Bootstrap casts it to the AuditLogger component slot at the single daemon-only seam.
 */
export class NoOpAuditLogger {
  async log(_entry: Record<string, unknown>): Promise<void> {
    /* slim embedded daemon: audit disabled — intentionally a no-op */
  }
}

export default NoOpAuditLogger;
