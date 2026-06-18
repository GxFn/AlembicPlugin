export const CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES = [
  'dist/bin/host-mcp.js',
  'dist/bin/daemon-server.js',
  'dist/lib/runtime/mcp/HostMcpServer.js',
  '.alembic-runtime-boundary.json',
] as const;

export const CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES = [
  '/api/v1/health',
  '/api/v1/daemon/health',
  '/api/v1/jobs',
  '/api/v1/jobs/bootstrap',
  '/api/v1/jobs/rescan',
  '/api/v1/search',
  '/api/v1/skills',
  '/api/v1/knowledge',
] as const;

export const CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY = 'dist/bin/daemon-server.js' as const;
