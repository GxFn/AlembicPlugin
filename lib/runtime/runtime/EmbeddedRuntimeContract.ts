export const EMBEDDED_RUNTIME_REQUIRED_FILES = [
  'dist/bin/host-mcp.js',
  'dist/lib/runtime/mcp/HostMcpServer.js',
  '.alembic-runtime-boundary.json',
] as const;

// PDR-3: the embedded daemon HTTP surface is removed; the plugin is a pure
// non-resident MCP process, so there are no required daemon HTTP routes.
export const EMBEDDED_RUNTIME_REQUIRED_ROUTES = [] as const;
