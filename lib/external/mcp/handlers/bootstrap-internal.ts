/**
 * Compatibility exports for the internal cold-start path.
 *
 * The Core workflow primitives live in `@alembic/core/host-agent-workflows`;
 * this wrapper owns Plugin internal-agent execution and MCP response shaping.
 */

export { runInternalColdStartWorkflow as bootstrapKnowledge } from '#external/mcp/handlers/bootstrap/InternalColdStartWorkflow.js';
export { bootstrapRefine } from './bootstrap/refine.js';
