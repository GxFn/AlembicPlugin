/**
 * NoOpGateway — RIC-8 governance decoupling for the slimmed embedded daemon.
 *
 * The embedded daemon is decoupled from governance: it injects this no-op instead of the
 * real Gateway. This is safe because the daemon's HTTP routes call services directly and
 * never invoke `req.gw()`/`gateway.execute()` (no route uses the gateway middleware path),
 * and Core's KnowledgeService/GuardService store but never call the gateway. The MCP host
 * path keeps the real Gateway (Bootstrap default mode), so MCP governance is unchanged.
 *
 * Implements the structural shape the daemon wiring touches: setDependencies (Bootstrap),
 * register (HttpServer.registerGatewayActions binds action handlers — accepted and ignored),
 * getRegisteredActions/getRoutes (introspection), and execute (defensive — returns a clear
 * "disabled" result should anything ever route through it). Bootstrap casts it to the Gateway
 * component slot at the single daemon-only seam.
 */
export class NoOpGateway {
  setDependencies(_deps: unknown): void {
    /* no-op */
  }

  register(_action: string, _handler: unknown): void {
    /* slim embedded daemon: gateway actions are accepted but never enforced */
  }

  getRegisteredActions(): string[] {
    return [];
  }

  async execute(_request: unknown): Promise<{ success: boolean; error?: string }> {
    // Defensive: no slimmed-daemon route invokes the gateway, but if one ever does,
    // fail closed with a clear signal rather than silently succeeding.
    return { success: false, error: 'governance gateway disabled in slim embedded daemon' };
  }

  getRoutes(): unknown[] {
    return [];
  }
}

export default NoOpGateway;
