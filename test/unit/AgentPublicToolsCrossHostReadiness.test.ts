import { describe, expect, test } from 'vitest';
import type { AgentHost, AgentPublicToolName } from '../../lib/runtime/mcp/public-tools/index.js';
import {
  AGENT_HOSTS,
  AGENT_PUBLIC_TOOL_NAMES,
  AgentPublicToolResultEnvelopeSchema,
  buildAgentPublicCrossHostReadinessReport,
  CROSS_HOST_FORBIDDEN_LEGACY_PRIMARY_GUIDANCE,
  createAgentPublicToolResultEnvelope,
  getAgentPublicToolContractDefinition,
} from '../../lib/runtime/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const sharedSchemaSignature =
  'contract:v1;hosts:codex|claude-code|generic-host-agent;tools:alembic_intent|alembic_prime|alembic_work_start|alembic_work_finish|alembic_code_guard|alembic_decision_record;statuses:ready|skipped|degraded|blocked|failed';

describe('AFAPI Stage 1D cross-host readiness', () => {
  test('locks Codex, Claude Code, and generic host prompt snapshots without schema fork', () => {
    const report = buildAgentPublicCrossHostReadinessReport();

    expect(report).toMatchObject({
      contractVersion: 1,
      noSchemaFork: true,
      schemaSignature: sharedSchemaSignature,
      sharedContract: {
        resultStatuses: ['ready', 'skipped', 'degraded', 'blocked', 'failed'],
        toolNames: AGENT_PUBLIC_TOOL_NAMES,
      },
      version: 1,
    });
    expect(report.hostSnapshots).toEqual([
      hostSnapshot('codex', 'Codex host agent'),
      hostSnapshot('claude-code', 'Claude Code host agent'),
      hostSnapshot('generic-host-agent', 'Generic host agent'),
    ]);

    const serializedGuide = JSON.stringify(report.hostSnapshots);
    for (const forbidden of CROSS_HOST_FORBIDDEN_LEGACY_PRIMARY_GUIDANCE) {
      expect(serializedGuide).not.toContain(forbidden);
    }
  });

  test('keeps MCP input schemas host-compatible and rejects wrong host labels', () => {
    for (const agentHost of AGENT_HOSTS) {
      for (const toolName of AGENT_PUBLIC_TOOL_NAMES) {
        expect(
          TOOL_SCHEMAS[toolName].safeParse(schemaSample(toolName, agentHost)).success,
          `${toolName} should accept ${agentHost}`
        ).toBe(true);
      }
    }

    expect(
      TOOL_SCHEMAS.alembic_intent.safeParse({
        agentHost: 'internal-ai',
        inputSource: 'host-declared-intent',
        userQuery: 'wrong host must not create a hidden schema fork',
      }).success
    ).toBe(false);
    expect(
      AgentPublicToolResultEnvelopeSchema.safeParse({
        ...envelopeSample('alembic_intent', 'codex'),
        agentHost: 'internal-ai',
      }).success
    ).toBe(false);
  });

  test('keeps result envelope shape identical across supported hosts', () => {
    for (const toolName of AGENT_PUBLIC_TOOL_NAMES) {
      const normalizedByHost = AGENT_HOSTS.map((agentHost) => {
        const envelope = AgentPublicToolResultEnvelopeSchema.parse(
          envelopeSample(toolName, agentHost)
        );
        const { agentHost: _agentHost, ...hostIndependentEnvelope } = envelope;
        return JSON.stringify(hostIndependentEnvelope);
      });
      expect(new Set(normalizedByHost).size, `${toolName} result envelope forked by host`).toBe(1);
    }
  });

  test('does not advertise legacy compatibility hooks as cross-host primary guidance', () => {
    const publicToolDescriptions = TOOLS.filter((tool) =>
      AGENT_PUBLIC_TOOL_NAMES.includes(tool.name as AgentPublicToolName)
    )
      .map((tool) => tool.description)
      .join('\n');
    const report = buildAgentPublicCrossHostReadinessReport();
    const serializedPromptSnapshots = JSON.stringify(report.hostSnapshots);

    for (const forbidden of CROSS_HOST_FORBIDDEN_LEGACY_PRIMARY_GUIDANCE) {
      expect(publicToolDescriptions).not.toContain(forbidden);
      expect(serializedPromptSnapshots).not.toContain(forbidden);
    }

    expect(TOOLS.find((tool) => tool.name === 'alembic_task')).toBeUndefined();
    expect(serializedPromptSnapshots).not.toContain('alembic_task');
  });
});

function hostSnapshot(agentHost: AgentHost, hostLabel: string) {
  return {
    agentHost,
    envelopeInvariant:
      'Return the same contractVersion, actionKind, refs/detailRefs, status, and skip/degraded/blocked/failed reason envelope for every supported host.',
    firstMove:
      'For semantic project work, call alembic_intent with agentHost plus hostDeclaredIntent or host-turn metadata before loading knowledge.',
    guardAndDecision:
      'Use alembic_code_guard only with explicit files or inline code, and use alembic_decision_record only for confirmed durable decisions.',
    hostLabel,
    legacyBoundary:
      'Legacy compatibility hooks are not the primary guide for this host; use the six agent-facing public tools.',
    primeFlow:
      'Call alembic_prime with the intentRef or the same structured host intent, then keep receipt evidence compact and ref-based.',
    schemaSignature: sharedSchemaSignature,
    workLifecycle:
      'Use alembic_work_start for concrete evidence-producing work and alembic_work_finish with changed files and evidence refs when scoped work is complete.',
  };
}

function schemaSample(
  toolName: AgentPublicToolName,
  agentHost: AgentHost
): Record<string, unknown> {
  const base = {
    agentHost,
    inputSource: 'host-declared-intent',
  };
  switch (toolName) {
    case 'alembic_intent':
      return {
        ...base,
        hostDeclaredIntent: { query: 'Prepare cross-host public tool guidance' },
      };
    case 'alembic_prime':
      return {
        ...base,
        intentRef: 'intent-cross-host',
        projectRoot: '/tmp/alembic-cross-host',
      };
    case 'alembic_work_start':
      return {
        ...base,
        intentRef: 'intent-cross-host',
        title: 'Cross-host readiness',
        workScope: { goal: 'Prove no schema fork across host agents' },
      };
    case 'alembic_work_finish':
      return {
        ...base,
        evidenceRefs: ['test/unit/AgentPublicToolsCrossHostReadiness.test.ts'],
        summary: 'Cross-host readiness evidence is complete.',
        workRef: 'work-cross-host',
      };
    case 'alembic_code_guard':
      return {
        ...base,
        code: 'export const crossHost = true;',
        filePath: 'test/unit/AgentPublicToolsCrossHostReadiness.test.ts',
        language: 'typescript',
      };
    case 'alembic_decision_record':
      return {
        ...base,
        description: 'Cross-host guidance uses one result envelope.',
        title: 'No schema fork for host agents',
      };
  }
}

function envelopeSample(toolName: AgentPublicToolName, agentHost: AgentHost) {
  const contract = getAgentPublicToolContractDefinition(toolName);
  return createAgentPublicToolResultEnvelope({
    actionKind: contract.actionKind,
    agentHost,
    inputSource: 'host-declared-intent',
    intentKind: 'implementation-task',
    refs: {
      detailRefs: [
        {
          id: `detail:${toolName}:cross-host`,
          kind: 'contract',
          requiredForCompletion: true,
          summary: 'Cross-host readiness uses a shared public result envelope.',
          uri: 'lib/runtime/mcp/public-tools/cross-host-readiness.ts',
        },
      ],
    },
    status: 'ready',
    summary: 'Cross-host readiness uses one public result envelope shape.',
    toolName,
  });
}
