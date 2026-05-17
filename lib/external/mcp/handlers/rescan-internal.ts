/**
 * Compatibility export for the internal knowledge-rescan path.
 *
 * The Core workflow primitives live in `@alembic/core/workflows/knowledge-rescan`;
 * this wrapper owns Plugin internal-agent execution and MCP response shaping.
 */

export { runInternalKnowledgeRescanWorkflow as rescanInternal } from '#external/mcp/handlers/rescan/InternalKnowledgeRescanWorkflow.js';
