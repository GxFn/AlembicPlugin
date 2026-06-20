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
  'contract:v1;hosts:codex|claude-code;tools:alembic_prime|alembic_work|alembic_code_guard;statuses:ready|skipped|degraded|blocked|failed';

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

    expect(TOOL_SCHEMAS.alembic_intent).toBeUndefined();
    expect(TOOL_SCHEMAS.alembic_work_start).toBeUndefined();
    expect(TOOL_SCHEMAS.alembic_work_finish).toBeUndefined();
    expect(TOOL_SCHEMAS.alembic_decision_record).toBeUndefined();
    expect(
      AgentPublicToolResultEnvelopeSchema.safeParse({
        ...envelopeSample('alembic_prime', 'codex'),
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
      'For semantic project work, call alembic_prime directly with taskAction, requirementGoal, and locator facets.',
    guardAndDecision: 'Use alembic_code_guard only with explicit files or inline code.',
    hostLabel,
    legacyBoundary:
      'Legacy compatibility hooks are not the primary guide for this host; use the three agent-facing public tools.',
    primeFlow:
      'Call alembic_prime directly before coding with taskAction, requirementGoal, and locator facets; obsolete intentRef/recognizedIntent inputs are blocked.',
    schemaSignature: sharedSchemaSignature,
    workLifecycle:
      'Use alembic_work phase=start for concrete evidence-producing work and alembic_work phase=finish with changed files and evidence refs when scoped work is complete.',
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
    case 'alembic_prime':
      return {
        ...base,
        capability: 'public-tool-contracts',
        requirementGoal: 'Prepare cross-host public tool guidance',
        scenario: 'cross-host readiness',
        taskAction: 'code-review',
        projectRoot: '/tmp/alembic-cross-host',
      };
    case 'alembic_work':
      return {
        ...base,
        phase: 'start',
        title: 'Cross-host readiness',
        workScope: { goal: 'Prove no schema fork across host agents' },
      };
    case 'alembic_code_guard':
      return {
        ...base,
        code: 'export const crossHost = true;',
        filePath: 'test/unit/AgentPublicToolsCrossHostReadiness.test.ts',
        language: 'typescript',
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
