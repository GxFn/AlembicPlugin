/**
 * Compatibility exports for the host-agent cold-start path.
 *
 * The Core workflow primitives live in `@alembic/core/host-agent-workflows`;
 * this wrapper owns Plugin transport cleanup and MCP response shaping.
 */

export {
  getActiveSession,
  runHostAgentColdStartWorkflow as generateForHostAgent,
  runGenerateWorkflow,
} from '#recipe-generation/host-agent-workflows/generate-workflow.js';
