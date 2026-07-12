export const EMBEDDED_RUNTIME_REQUIRED_FILES = [
  'dist/bin/host-mcp.js',
  'dist/lib/host-runtime/mcp/HostMcpServer.js',
  '.alembic-runtime-boundary.json',
] as const;

// The Plugin uses an in-process MCP executor and has no required HTTP routes.
export const EMBEDDED_RUNTIME_REQUIRED_ROUTES = [] as const;
