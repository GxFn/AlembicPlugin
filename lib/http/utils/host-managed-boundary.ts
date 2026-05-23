export const HOST_AGENT_MANAGED_CODE = 'HOST_AGENT_MANAGED' as const;
export const PLUGIN_DETERMINISTIC_EXTRACT_CODE = 'PLUGIN_DETERMINISTIC_EXTRACT' as const;

type BoundaryOwner = 'codex-host-agent' | 'alembic-plugin';
type EnhancementOwner = 'codex-host-agent-or-alembic-resident-service';

type CapabilityBoundary = {
  code: typeof HOST_AGENT_MANAGED_CODE | typeof PLUGIN_DETERMINISTIC_EXTRACT_CODE;
  context: string;
  owner: BoundaryOwner;
  enhancementOwner: EnhancementOwner;
  hostAgentManaged: boolean;
  localAi: false;
  localAiProvider: false;
  pluginAiProvider: false;
  note: string;
};

type HostAgentManagedFields = {
  hostAgentManaged: true;
  boundaryCode: typeof HOST_AGENT_MANAGED_CODE;
  canonicalCode: typeof HOST_AGENT_MANAGED_CODE;
  managedBy: EnhancementOwner;
  localAi: false;
  localAiProvider: false;
  pluginAiProvider: false;
  capabilityBoundary: CapabilityBoundary;
};

type PluginDeterministicFields = {
  deterministicPluginExtract: true;
  boundaryCode: typeof PLUGIN_DETERMINISTIC_EXTRACT_CODE;
  canonicalCode: typeof PLUGIN_DETERMINISTIC_EXTRACT_CODE;
  semanticEnhancementManagedBy: EnhancementOwner;
  localAi: false;
  localAiProvider: false;
  pluginAiProvider: false;
  capabilityBoundary: CapabilityBoundary;
};

function makeBoundary(
  code: typeof HOST_AGENT_MANAGED_CODE | typeof PLUGIN_DETERMINISTIC_EXTRACT_CODE,
  context: string,
  owner: BoundaryOwner,
  note: string
): CapabilityBoundary {
  return {
    code,
    context,
    owner,
    enhancementOwner: 'codex-host-agent-or-alembic-resident-service',
    hostAgentManaged: owner === 'codex-host-agent',
    localAi: false,
    localAiProvider: false,
    pluginAiProvider: false,
    note,
  };
}

export function makeHostAgentManagedError(message: string) {
  return {
    code: HOST_AGENT_MANAGED_CODE,
    canonicalCode: HOST_AGENT_MANAGED_CODE,
    boundaryCode: HOST_AGENT_MANAGED_CODE,
    message,
  };
}

export function attachHostAgentManagedBoundary<T extends Record<string, unknown>>(
  payload: T,
  context: string,
  note = 'AlembicPlugin 不执行本地第三方 AI；候选增强由 Codex host agent 或 Alembic resident service 接管。'
): T & HostAgentManagedFields {
  const boundary = makeBoundary(HOST_AGENT_MANAGED_CODE, context, 'codex-host-agent', note);
  return {
    ...payload,
    hostAgentManaged: true,
    boundaryCode: HOST_AGENT_MANAGED_CODE,
    canonicalCode: HOST_AGENT_MANAGED_CODE,
    managedBy: 'codex-host-agent-or-alembic-resident-service',
    localAi: false,
    localAiProvider: false,
    pluginAiProvider: false,
    capabilityBoundary: boundary,
  };
}

export function attachPluginDeterministicBoundary<T extends Record<string, unknown>>(
  payload: T,
  context: string,
  note = 'AlembicPlugin 只执行确定性提取；语义增强仍由 Codex host agent 或 Alembic resident service 接管。'
): T & PluginDeterministicFields {
  const boundary = makeBoundary(PLUGIN_DETERMINISTIC_EXTRACT_CODE, context, 'alembic-plugin', note);
  return {
    ...payload,
    deterministicPluginExtract: true,
    boundaryCode: PLUGIN_DETERMINISTIC_EXTRACT_CODE,
    canonicalCode: PLUGIN_DETERMINISTIC_EXTRACT_CODE,
    semanticEnhancementManagedBy: 'codex-host-agent-or-alembic-resident-service',
    localAi: false,
    localAiProvider: false,
    pluginAiProvider: false,
    capabilityBoundary: boundary,
  };
}
