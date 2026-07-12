import type { HostKnowledgeState } from '#service/knowledge/KnowledgeState.js';
import { resolveHostRuntimeContext, TOOL_POLICY_AGENT_PUBLIC_TOOL_NAMES } from '../../index.js';
import {
  AGENT_HOSTS,
  AGENT_INPUT_SOURCES,
  AGENT_PUBLIC_TOOL_ACTION_BY_NAME,
  type AgentHost,
  type AgentInputSource,
  type AgentPublicToolName,
  createAgentPublicToolResultEnvelope,
  createPrimePublicPackage,
  PRIME_PUBLIC_TRUST_LAYERS,
} from '../public-tools/contract.js';
import { createAgentPublicToolOutput } from '../public-tools/output.js';

interface AgentPublicPreBootstrapGateInput {
  args: Record<string, unknown>;
  knowledge: HostKnowledgeState;
  residentProjectScopeAvailable: boolean;
  toolName: string;
}

const BLOCK_REASON = {
  code: 'project-isolation-unconfirmed' as const,
  kind: 'blocked' as const,
  message:
    'Project-knowledge execution was blocked before embedded runtime initialization because this host source root has neither an initialized Alembic workspace nor a matching ProjectScope identity. Check alembic_status, then explicitly initialize this project or select the matching ProjectScope before retrying.',
  retryable: false,
};

export function buildAgentPublicPreBootstrapBlock(
  input: AgentPublicPreBootstrapGateInput
): Record<string, unknown> | null {
  if (
    !TOOL_POLICY_AGENT_PUBLIC_TOOL_NAMES.has(input.toolName) ||
    input.knowledge.initialized ||
    input.residentProjectScopeAvailable
  ) {
    return null;
  }

  const toolName = input.toolName as AgentPublicToolName;
  const refs = { detailRefs: [] };
  const summary = `Blocked ${toolName} before embedded Bootstrap because project isolation is unconfirmed.`;
  const result = createAgentPublicToolResultEnvelope({
    actionKind: AGENT_PUBLIC_TOOL_ACTION_BY_NAME[toolName],
    agentHost: resolveAgentHost(input.args.agentHost),
    inputSource: resolveInputSource(input.args.inputSource),
    reason: BLOCK_REASON,
    refs,
    status: 'blocked',
    summary,
    toolName,
  });
  const diagnostics = [
    {
      code: BLOCK_REASON.code,
      message: BLOCK_REASON.message,
      retryable: false,
      severity: 'warning' as const,
    },
  ];
  return createAgentPublicToolOutput(
    result,
    toolName === 'alembic_prime'
      ? { diagnostics, primePackage: createBlockedPrimePackage(result) }
      : { diagnostics },
    { ok: false }
  );
}

function createBlockedPrimePackage(result: ReturnType<typeof createAgentPublicToolResultEnvelope>) {
  return createPrimePublicPackage({
    compactPackage: {
      acceptedGuards: [],
      acceptedKnowledge: [],
      counts: {
        acceptedGuards: 0,
        acceptedKnowledge: 0,
        detailRefs: 0,
        omittedFromCompact: 0,
      },
      detailRefsMode: 'ref-based',
      evidenceDelivery: 'detailRefs-and-primeKnowledgeMaterial',
      primeInjectionPackage: {
        availability: 'not-run',
        missingProducerFields: [],
        omittedCount: null,
        pluginSynthesized: false,
        producer: 'alembic-resident-service',
        producerBoundary:
          'Resident prime production was not entered because the host rejected an unconfirmed project-isolation boundary before embedded initialization.',
        producerOnlyFields: [],
        selectedCount: null,
        status: null,
      },
    },
    feedbackDigest: null,
    kind: 'PrimePublicPackage',
    primeRef: 'prebootstrap-project-isolation-block',
    projectContextGuidance: {
      boundary:
        'No ProjectContext evidence is available until the host source root is initialized or bound to its matching ProjectScope.',
      recommendedQueries: [],
      recommendedTools: ['alembic_status', 'alembic_init'],
      projectContextRefs: [],
      sourceEvidenceRefs: [],
      status: 'degraded',
    },
    reason: result.reason,
    refs: result.refs,
    status: result.status,
    summary: result.summary,
    trustPosture: {
      antiEmptyReceiptRequired: true,
      noTrustedClaimRequired: true,
      receiptChecklist: PRIME_PUBLIC_TRUST_LAYERS.map((layer) => ({
        itemCount: layer === 'not-available-or-degraded' ? 1 : 0,
        items: [],
        label: `Prime trust layer: ${layer}`,
        layer,
        requiredInVisibleReceipt: layer === 'not-available-or-degraded',
        visibleReceiptDirective:
          layer === 'not-available-or-degraded'
            ? 'Say that no project knowledge was delivered because project isolation is unconfirmed.'
            : `No ${layer} material was delivered before project isolation was confirmed.`,
      })),
      status: 'blocked',
    },
    trustReceipt: {
      hostResponse: null,
      receiptId: null,
      status: 'blocked',
    },
  });
}

function resolveAgentHost(value: unknown): AgentHost {
  const candidate = typeof value === 'string' ? value : resolveHostRuntimeContext().pluginHost;
  return AGENT_HOSTS.includes(candidate as AgentHost) ? (candidate as AgentHost) : 'codex';
}

function resolveInputSource(value: unknown): AgentInputSource {
  return AGENT_INPUT_SOURCES.includes(value as AgentInputSource)
    ? (value as AgentInputSource)
    : 'user-message';
}
