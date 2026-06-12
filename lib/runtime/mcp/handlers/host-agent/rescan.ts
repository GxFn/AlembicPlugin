/**
 * Compatibility export for the host-agent knowledge-rescan path.
 *
 * The Core workflow primitives live in `@alembic/core/host-agent-workflows`;
 * this wrapper owns Plugin transport cleanup and MCP response shaping.
 */

export { runHostAgentKnowledgeRescanWorkflow as rescanForHostAgent } from '#codex/mcp/host-agent-workflows/knowledge-rescan.js';
