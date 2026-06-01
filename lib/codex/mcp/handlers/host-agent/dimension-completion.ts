/**
 * Compatibility adapter for the host-agent dimension completion workflow.
 *
 * The host-agnostic workflow state lives in Core; this Plugin wrapper adds
 * MCP envelope behavior and Codex-facing completion side effects.
 */

import { envelope } from '#codex/mcp/envelope.js';
import {
  type HostAgentDimensionCompleteArgs,
  runHostAgentDimensionCompletionWorkflow,
} from '#codex/mcp/host-agent-workflows/dimension-completion.js';
import type { McpContext } from '../types.js';

export async function dimensionComplete(ctx: McpContext, args: HostAgentDimensionCompleteArgs) {
  return envelope(await runHostAgentDimensionCompletionWorkflow(ctx, args));
}
