/**
 * Compatibility exports for the host-agent cold-start path.
 *
 * The Core workflow primitives live in `@alembic/core/host-agent-workflows`;
 * this wrapper owns Plugin transport cleanup and MCP response shaping.
 */

export {
  getActiveSession,
  runGenerateWorkflow,
  runHostAgentColdStartWorkflow as generateForHostAgent,
} from '#recipe-pipeline/generate/generate-workflow.js';
