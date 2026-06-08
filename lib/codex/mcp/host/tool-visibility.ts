import {
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  CODEX_PROJECT_ROOT_PROPERTY,
  type CodexKnowledgeState,
  EMPTY_CODEX_KNOWLEDGE_STATE,
  inspectCodexKnowledge,
  isTrustedCodexProjectRoot,
  resolveCodexProjectRoot,
  resolveCodexToolPolicy,
} from '../../index.js';
import '../codex-local-tools/output.js';
import { withMcpOutputSchema } from '../output-contract.js';
import { TIER_ORDER, TOOLS, withMcpToolAnnotations } from '../tools.js';
import { safeProjectRootFallback } from './project-root.js';

// Tool list 必须按当前知识状态和 tier 过滤，同时保留 projectRoot 覆盖入口。
export function getVisibleCodexTools(
  tierName = process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER,
  projectRoot = resolveCodexProjectRoot().path || safeProjectRootFallback(),
  options: { residentProjectScopeAvailable?: boolean } = {}
) {
  const resolution = resolveCodexProjectRoot({ projectRoot });
  const knowledge = isTrustedCodexProjectRoot(resolution)
    ? inspectCodexKnowledge(projectRoot)
    : buildExplicitProjectRootRequiredKnowledgeState();
  return resolveCodexToolPolicy({
    adminEnabled: process.env[CODEX_ADMIN_ENABLE_ENV] === '1',
    coreTools: TOOLS,
    knowledge,
    residentProjectScopeAvailable: options.residentProjectScopeAvailable,
    tierName,
    tierOrder: TIER_ORDER,
  })
    .visibleTools.map(withMcpToolAnnotations)
    .map(withMcpOutputSchema)
    .map(withCodexProjectRootInput);
}

function buildExplicitProjectRootRequiredKnowledgeState(): CodexKnowledgeState {
  return {
    ...EMPTY_CODEX_KNOWLEDGE_STATE,
    initialized: true,
    hasKnowledge: true,
    recipeCount: 1,
    skillCount: 0,
    status: 'knowledge_ready',
    usable: true,
  };
}

function withCodexProjectRootInput<T extends { inputSchema?: Record<string, unknown> }>(
  tool: T
): T {
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
        projectRoot: CODEX_PROJECT_ROOT_PROPERTY,
        ...properties,
      },
    },
  };
}
