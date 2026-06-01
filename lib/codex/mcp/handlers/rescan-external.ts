/**
 * Compatibility export for the external knowledge-rescan path.
 *
 * The Core workflow primitives live in `@alembic/core/host-agent-workflows`;
 * this wrapper owns Plugin transport cleanup and MCP response shaping.
 */

export { runExternalKnowledgeRescanWorkflow as rescanExternal } from '#codex/mcp/handlers/rescan/ExternalKnowledgeRescanWorkflow.js';
