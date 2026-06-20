import type { HostKnowledgeState } from '../../runtime/KnowledgeState.js';
import {
  buildProjectRootRequiredActions,
  buildProjectRootRequiredMessage,
  isTrustedProjectRoot,
  type ProjectRootResolution,
  summarizeProjectRootResolution,
} from '../../runtime/ProjectRootResolver.js';
import {
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
} from '../../runtime/runtime/RuntimeContext.js';
import { buildKnowledgeGateActions } from '../../runtime/status/StatusService.js';
import {
  allowedToolNames,
  INIT_ON_DEMAND_TOOL_NAMES,
  LOCAL_TOOLS,
  resolveToolPolicy,
  type ToolDefinition,
} from '../../runtime/ToolPolicy.js';

export type PreflightStage = 'before-auto-init' | 'execute';

export interface PreflightInput<T extends ToolDefinition = ToolDefinition> {
  adminEnabled?: boolean;
  args?: Record<string, unknown>;
  coreTools: T[];
  knowledge: HostKnowledgeState;
  projectRootResolution: ProjectRootResolution;
  residentProjectScopeAvailable?: boolean;
  stage: PreflightStage;
  tierName?: string;
  tierOrder: Record<string, number>;
  toolName: string;
}

export interface PreflightOk {
  autoInit: boolean;
  ok: true;
  state: {
    allowedTools: string[];
    stage: PreflightStage;
  };
}

export interface PreflightBlocked {
  failure: Record<string, unknown>;
  ok: false;
}

export type PreflightResult = PreflightOk | PreflightBlocked;

const PROJECT_ROOT_DISCOVERY_TOOL_NAMES = new Set(['alembic_status']);

export function preflightTool<T extends ToolDefinition>(input: PreflightInput<T>): PreflightResult {
  const tool = findKnownTool(input.toolName, input.coreTools);
  if (!tool) {
    return {
      ok: false,
      failure: codexFailure(input.toolName, `Unknown Alembic tool: ${input.toolName}`, {
        errorCode: 'CODEX_UNKNOWN_TOOL',
      }),
    };
  }

  if (
    !isTrustedProjectRoot(input.projectRootResolution) &&
    !PROJECT_ROOT_DISCOVERY_TOOL_NAMES.has(input.toolName)
  ) {
    const errorCode =
      input.projectRootResolution.trust === 'rejected'
        ? 'CODEX_PROJECT_ROOT_REJECTED'
        : 'CODEX_PROJECT_ROOT_UNRESOLVED';
    return {
      ok: false,
      failure: codexFailure(
        input.toolName,
        buildProjectRootRequiredMessage(input.projectRootResolution),
        {
          errorCode,
          needsUserInput: true,
          projectRootResolution: summarizeProjectRootResolution(input.projectRootResolution),
          required: { projectRoot: 'absolute path' },
          requiredActions: buildProjectRootRequiredActions(),
        }
      ),
    };
  }

  const policy = resolveToolPolicy({
    adminEnabled: input.adminEnabled ?? process.env[CODEX_ADMIN_ENABLE_ENV] === '1',
    coreTools: input.coreTools,
    knowledge: input.knowledge,
    residentProjectScopeAvailable: input.residentProjectScopeAvailable,
    tierName: input.tierName || process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER,
    tierOrder: input.tierOrder,
  });
  const visibleToolNames = new Set(policy.visibleTools.map((visibleTool) => visibleTool.name));
  if (!visibleToolNames.has(input.toolName)) {
    return {
      ok: false,
      failure: buildToolHiddenFailure({
        allowedTools: [...allowedToolNames(input.knowledge)],
        coreTools: input.coreTools,
        effectiveTier: policy.effectiveTier,
        knowledge: input.knowledge,
        residentProjectScopeAvailable: input.residentProjectScopeAvailable === true,
        toolName: input.toolName,
      }),
    };
  }

  const autoInit =
    input.stage === 'before-auto-init' &&
    !input.knowledge.initialized &&
    INIT_ON_DEMAND_TOOL_NAMES.has(input.toolName);

  return {
    ok: true,
    autoInit,
    state: {
      allowedTools: [...visibleToolNames],
      stage: input.stage,
    },
  };
}

export function isInitOnDemandTool(name: string): boolean {
  return INIT_ON_DEMAND_TOOL_NAMES.has(name);
}

export function isProjectRootDiscoveryTool(name: string): boolean {
  return PROJECT_ROOT_DISCOVERY_TOOL_NAMES.has(name);
}

function buildToolHiddenFailure(input: {
  allowedTools: string[];
  coreTools: ToolDefinition[];
  effectiveTier: string;
  knowledge: HostKnowledgeState;
  residentProjectScopeAvailable: boolean;
  toolName: string;
}): Record<string, unknown> {
  const coreTool = input.coreTools.find((tool) => tool.name === input.toolName);
  if (coreTool?.tier === 'admin' && input.effectiveTier !== 'admin') {
    return codexFailure(
      input.toolName,
      'This Alembic admin tool is hidden until Codex admin mode is explicitly enabled.',
      {
        allowedTools: input.allowedTools,
        errorCode: 'CODEX_ADMIN_OPT_IN_REQUIRED',
        needsUserInput: true,
        required: { env: `${CODEX_ADMIN_ENABLE_ENV}=1`, tier: 'admin' },
        requiredActions: [
          `Set ${CODEX_ADMIN_ENABLE_ENV}=1 only for explicit admin workflows.`,
          `Set ${CODEX_MCP_TIER_ENV}=admin for this Codex plugin session.`,
        ],
      }
    );
  }

  if (!input.knowledge.usable && !input.residentProjectScopeAvailable) {
    return codexFailure(
      input.toolName,
      'Alembic project-knowledge tools are hidden until this project has a usable Alembic knowledge base. Use the cold-start initialization tools first.',
      {
        allowedTools: input.allowedTools,
        errorCode: 'CODEX_ALEMBIC_KNOWLEDGE_REQUIRED',
        nextActions: buildKnowledgeGateActions(input.knowledge),
      }
    );
  }

  return codexFailure(input.toolName, `Alembic tool is not available: ${input.toolName}`, {
    allowedTools: input.allowedTools,
    errorCode: 'CODEX_TOOL_NOT_AVAILABLE',
  });
}

function findKnownTool<T extends ToolDefinition>(
  toolName: string,
  coreTools: T[]
): T | ToolDefinition | null {
  return (
    LOCAL_TOOLS.find((tool) => tool.name === toolName) ||
    coreTools.find((tool) => tool.name === toolName) ||
    null
  );
}

function codexFailure(
  tool: string,
  message: string,
  data: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    success: false,
    message,
    errorCode: 'CODEX_MCP_ERROR',
    tool,
    data,
  };
}
