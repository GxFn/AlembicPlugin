/**
 * Compatibility exports for the external cold-start path.
 *
 * The Core workflow primitives live in `@alembic/core/workflows/cold-start`;
 * this wrapper owns Plugin transport cleanup and MCP response shaping.
 */

export {
  getActiveSession,
  runExternalColdStartWorkflow as bootstrapExternal,
} from '#external/mcp/handlers/bootstrap/ExternalColdStartWorkflow.js';
