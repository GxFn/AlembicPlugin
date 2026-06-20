import {
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  EMPTY_KNOWLEDGE_STATE,
  type HostKnowledgeState,
  inspectKnowledge,
  isTrustedProjectRoot,
  PROJECT_ROOT_PROPERTY,
  resolveHostAdapter,
  resolveToolPolicy,
} from '../../../runtime/index.js';
import '../../../runtime/mcp/local-tools/output.js';
import { safeProjectRootFallback } from '../../../runtime/mcp/host/project-root.js';
import { withMcpOutputSchema } from '../../../runtime/mcp/output-contract.js';
import { TIER_ORDER, TOOLS, withMcpToolAnnotations } from '../../../runtime/mcp/tools.js';

// Tool list 必须按当前知识状态和 tier 过滤，同时保留 projectRoot 覆盖入口。
export function getVisibleTools(
  tierName = process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER,
  projectRoot = resolveHostAdapter().resolveProjectRoot().path || safeProjectRootFallback(),
  options: { residentProjectScopeAvailable?: boolean } = {}
) {
  // DH-3c: host-operation 经 L3 HostAdapter 走（L2 不再直依赖 host-specific 函数）。
  const adapter = resolveHostAdapter();
  const resolution = adapter.resolveProjectRoot({ projectRoot });
  const knowledge = isTrustedProjectRoot(resolution)
    ? inspectKnowledge(projectRoot)
    : buildExplicitProjectRootRequiredKnowledgeState();
  return resolveToolPolicy({
    adminEnabled: process.env[CODEX_ADMIN_ENABLE_ENV] === '1',
    coreTools: TOOLS,
    knowledge,
    residentProjectScopeAvailable: options.residentProjectScopeAvailable,
    tierName,
    tierOrder: TIER_ORDER,
  })
    .visibleTools.map(withMcpToolAnnotations)
    .map(withMcpOutputSchema)
    .map(withProjectRootInput);
}

function buildExplicitProjectRootRequiredKnowledgeState(): HostKnowledgeState {
  return {
    ...EMPTY_KNOWLEDGE_STATE,
    initialized: true,
    hasKnowledge: true,
    recipeCount: 1,
    skillCount: 0,
    status: 'knowledge_ready',
    usable: true,
  };
}

function withProjectRootInput<T extends { inputSchema?: Record<string, unknown> }>(tool: T): T {
  const inputSchema = tool.inputSchema || {};
  const properties =
    inputSchema.properties && typeof inputSchema.properties === 'object'
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PROPERTY,
        ...properties,
      },
    },
  };
}
