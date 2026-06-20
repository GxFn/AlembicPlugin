#!/usr/bin/env node

/**
 * Alembic Codex MCP shim.
 * Lightweight stdio entry: lists tools immediately and starts/connects daemon only when a tool needs Core.
 */

// DH-2（RC-2）：host env 初始化经 L3 HostAdapter（codex 单实现逐行委托现有
// ensureCodexRuntimeEnvironment，行为不变）；DH-3 起按物理 shell 形态选 codex / cc adapter。
const { resolveHostAdapter } = await import('../lib/runtime/index.js');
resolveHostAdapter().ensureRuntimeEnvironment();

process.on('uncaughtException', (error) => {
  process.stderr.write(`[Codex MCP] Uncaught Exception: ${error.message}\n`);
  if (error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[Codex MCP] Unhandled Rejection: ${message}\n`);
  process.exit(1);
});

const { shutdown } = await import('../lib/shared/shutdown.js');
const { timerRegistry } = await import('@alembic/core/events');
shutdown.install();
shutdown.register(async () => {
  await timerRegistry.dispose();
}, 'timer-registry');

const { startHostMcpServer } = await import('../lib/runtime/mcp/HostMcpServer.js');

startHostMcpServer()
  .then((server) => {
    shutdown.register(() => server.shutdown(), 'host-mcp-server');
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Codex MCP Server failed to start: ${message}\n`);
    process.exit(1);
  });
