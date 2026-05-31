export const CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES = [
  'dist/bin/codex-mcp.js',
  'dist/bin/daemon-server.js',
  'dist/lib/external/mcp/CodexMcpServer.js',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
] as const;

export const CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES = [
  '/api/v1/health',
  '/api/v1/daemon/health',
  '/api/v1/jobs',
  '/api/v1/jobs/bootstrap',
  '/api/v1/jobs/rescan',
  '/api/v1/search',
  '/api/v1/skills',
  '/api/v1/candidates',
  '/api/v1/knowledge',
] as const;

export const CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY = 'dist/bin/daemon-server.js' as const;
