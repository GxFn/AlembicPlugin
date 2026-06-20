import {
  AGENT_HOSTS,
  AGENT_PUBLIC_TOOL_CONTRACT_CATALOG,
  AGENT_PUBLIC_TOOL_CONTRACT_VERSION,
  AGENT_PUBLIC_TOOL_NAMES,
  AGENT_RESULT_STATUSES,
  type AgentHost,
} from '../../../runtime/mcp/public-tools/contract.js';

export const AGENT_PUBLIC_CROSS_HOST_READINESS_VERSION = 1 as const;

// 这组词只用于证明 cross-host prompt snapshot 不把退役入口当主入口。
// 工具物理保留与否由 cleanup 阶段裁决，本模块只负责 host prompt readiness。
export const CROSS_HOST_FORBIDDEN_LEGACY_PRIMARY_GUIDANCE = [
  'alembic_task',
  'operation=prime',
  'operation=create',
  'operation=close',
  'record_decision',
  'prime/create/close',
] as const;

export interface AgentPublicCrossHostPromptSnapshot {
  agentHost: AgentHost;
  envelopeInvariant: string;
  firstMove: string;
  guardAndDecision: string;
  hostLabel: string;
  legacyBoundary: string;
  primeFlow: string;
  schemaSignature: string;
  workLifecycle: string;
}

export interface AgentPublicCrossHostReadinessReport {
  contractVersion: typeof AGENT_PUBLIC_TOOL_CONTRACT_VERSION;
  forbiddenLegacyPrimaryGuidance: readonly string[];
  hostSnapshots: readonly AgentPublicCrossHostPromptSnapshot[];
  noSchemaFork: boolean;
  schemaSignature: string;
  sharedContract: {
    resultStatuses: readonly string[];
    toolNames: readonly string[];
    tools: readonly {
      acceptedRefs: readonly string[];
      actionKind: string;
      name: string;
      producedRefs: readonly string[];
      requiredFields: readonly string[];
    }[];
  };
  version: typeof AGENT_PUBLIC_CROSS_HOST_READINESS_VERSION;
}

const HOST_LABEL_BY_AGENT_HOST = {
  codex: 'Codex host agent',
  'claude-code': 'Claude Code host agent',
} as const satisfies Record<AgentHost, string>;

const SHARED_SCHEMA_SIGNATURE = [
  `contract:v${AGENT_PUBLIC_TOOL_CONTRACT_VERSION}`,
  `hosts:${AGENT_HOSTS.join('|')}`,
  `tools:${AGENT_PUBLIC_TOOL_NAMES.join('|')}`,
  `statuses:${AGENT_RESULT_STATUSES.join('|')}`,
].join(';');

// Stage 1D 只固定 host-facing guide/snapshot 证据：三类 host 共享同一 schema
// signature，不能在这里派生 Claude/Generic 专属字段或替换 result envelope。
export function buildAgentPublicCrossHostReadinessReport(): AgentPublicCrossHostReadinessReport {
  const hostSnapshots = AGENT_HOSTS.map((agentHost) =>
    buildAgentPublicCrossHostPromptSnapshot(agentHost)
  );

  return {
    contractVersion: AGENT_PUBLIC_TOOL_CONTRACT_VERSION,
    forbiddenLegacyPrimaryGuidance: [...CROSS_HOST_FORBIDDEN_LEGACY_PRIMARY_GUIDANCE],
    hostSnapshots,
    noSchemaFork: new Set(hostSnapshots.map((snapshot) => snapshot.schemaSignature)).size === 1,
    schemaSignature: SHARED_SCHEMA_SIGNATURE,
    sharedContract: {
      resultStatuses: [...AGENT_RESULT_STATUSES],
      toolNames: [...AGENT_PUBLIC_TOOL_NAMES],
      tools: AGENT_PUBLIC_TOOL_CONTRACT_CATALOG.map((tool) => ({
        acceptedRefs: [...tool.inputContract.acceptedRefs],
        actionKind: tool.actionKind,
        name: tool.name,
        producedRefs: [...tool.resultContract.producesRefs],
        requiredFields: [...tool.inputContract.requiredFields],
      })),
    },
    version: AGENT_PUBLIC_CROSS_HOST_READINESS_VERSION,
  };
}

export function buildAgentPublicCrossHostPromptSnapshot(
  agentHost: AgentHost
): AgentPublicCrossHostPromptSnapshot {
  return {
    agentHost,
    envelopeInvariant:
      'Return the same contractVersion, actionKind, refs/detailRefs, status, and skip/degraded/blocked/failed reason envelope for every supported host.',
    firstMove:
      'For semantic project work, call alembic_prime directly with taskAction, requirementGoal, and locator facets.',
    guardAndDecision: 'Use alembic_code_guard only with explicit files or inline code.',
    hostLabel: HOST_LABEL_BY_AGENT_HOST[agentHost],
    legacyBoundary:
      'Legacy compatibility hooks are not the primary guide for this host; use the three agent-facing public tools.',
    primeFlow:
      'Call alembic_prime directly before coding with taskAction, requirementGoal, and locator facets; obsolete intentRef/recognizedIntent inputs are blocked.',
    schemaSignature: SHARED_SCHEMA_SIGNATURE,
    workLifecycle:
      'Use alembic_work phase=start for concrete evidence-producing work and alembic_work phase=finish with changed files and evidence refs when scoped work is complete.',
  };
}
