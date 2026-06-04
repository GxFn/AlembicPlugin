import { describe, expect, test } from 'vitest';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/codex/mcp/PluginToolSurfaceCatalog.js';
import {
  AGENT_ACTION_KINDS,
  AGENT_PUBLIC_TOOL_NAMES,
  AGENT_RESULT_STATUSES,
  AgentPublicToolResultEnvelopeSchema,
  createAgentDetailRef,
  createAgentPublicToolResultEnvelope,
  getAgentPublicToolContractDefinition,
  getAgentPublicToolDescriptionBase,
  listAgentPublicToolContractCatalog,
} from '../../lib/codex/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/codex/mcp/tools.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

describe('Agent-facing public tools contract foundation', () => {
  test('declares the six public tools and marks them as active public tools', () => {
    expect(AGENT_PUBLIC_TOOL_NAMES).toEqual([
      'alembic_intent',
      'alembic_prime',
      'alembic_work_start',
      'alembic_work_finish',
      'alembic_code_guard',
      'alembic_decision_record',
    ]);
    expect(AGENT_ACTION_KINDS).toEqual([
      'intent',
      'prime',
      'work-start',
      'work-finish',
      'code-guard',
      'decision-record',
    ]);

    const catalog = listAgentPublicToolContractCatalog();
    expect(catalog.map((entry) => entry.name)).toEqual(AGENT_PUBLIC_TOOL_NAMES);
    for (const definition of catalog) {
      expect(definition.activeMcpSurface).toBe(true);
      expect(definition.implementationStatus).toBe('active-tool');
      expect(definition.handlerDependency).toBe('McpServer.agent-public-tools');
      expect(definition.resultContract.statuses).toEqual(AGENT_RESULT_STATUSES);
      expect(definition.resultContract.reasonKinds).toEqual([
        'skip',
        'degraded',
        'blocked',
        'failure',
      ]);
      expect(definition.resultContract.producesRefs).toContain('detailRefs');
    }
  });

  test('publishes every public tool through the active MCP tool surface', () => {
    const activeToolNames = new Set([
      ...TOOLS.map((tool) => tool.name),
      ...Object.keys(PLUGIN_TOOL_SURFACE_CATALOG),
      ...Object.keys(TOOL_SCHEMAS),
    ]);

    for (const name of AGENT_PUBLIC_TOOL_NAMES) {
      expect(activeToolNames.has(name)).toBe(true);
    }
  });

  test('provides tool description base text without legacy operation wording', () => {
    for (const name of AGENT_PUBLIC_TOOL_NAMES) {
      const description = getAgentPublicToolDescriptionBase(name);
      expect(description.name).toBe(name);
      expect(description.title).toMatch(/\S/);
      expect(description.purpose).toMatch(/\S/);
      expect(description.selectionHint).toMatch(/\S/);
      expect(description.nonGoal).toMatch(/\S/);
    }

    const serializedDescriptions = JSON.stringify(
      AGENT_PUBLIC_TOOL_NAMES.map((name) => getAgentPublicToolDescriptionBase(name))
    );
    expect(serializedDescriptions).not.toContain('alembic_task');
    expect(serializedDescriptions).not.toContain('operation=prime');
    expect(serializedDescriptions).not.toContain('operation=create');
    expect(serializedDescriptions).not.toContain('operation=close');
  });

  test('validates result envelopes with refs, detailRefs, reasons, and output budget', () => {
    const detailRef = createAgentDetailRef({
      id: 'contract:public-tools',
      kind: 'contract',
      summary: 'Public tools contract catalog and result envelope evidence',
      uri: 'lib/codex/mcp/public-tools/contract.ts',
      requiredForCompletion: true,
    });

    const envelope = createAgentPublicToolResultEnvelope({
      agentHost: 'codex',
      actionKind: 'work-finish',
      inputSource: 'host-declared-intent',
      intentKind: 'implementation-task',
      refs: {
        intentRef: { refType: 'intent', id: 'intent-1', toolName: 'alembic_intent' },
        workRef: { refType: 'work', id: 'work-1', toolName: 'alembic_work_start' },
        detailRefs: [detailRef],
      },
      reason: {
        kind: 'degraded',
        code: 'resident-unavailable',
        message: 'Resident service was unavailable, so the contract returns compact evidence.',
      },
      status: 'degraded',
      summary: {
        compact: 'Work finished with compact evidence and a resident degradation reason.',
        outputBudget: {
          mode: 'compact',
          maxChars: 1200,
          usedChars: 86,
          truncated: false,
        },
      },
      toolName: 'alembic_work_finish',
    });

    expect(envelope.contractVersion).toBe(1);
    expect(envelope.refs.detailRefs).toHaveLength(1);
    expect(envelope.reason).toMatchObject({
      kind: 'degraded',
      code: 'resident-unavailable',
    });
    expect(envelope.legacyCompatibility).toEqual({
      usesLegacyTaskHandler: false,
      compatibilityRole: 'none',
    });
  });

  test('requires skip, degraded, blocked, and failed results to carry matching reasons', () => {
    const base = {
      agentHost: 'codex' as const,
      inputSource: 'user-message' as const,
      refs: { detailRefs: [] },
      summary: {
        compact: 'Contract result',
        outputBudget: {
          maxChars: 1000,
          mode: 'compact' as const,
          truncated: false,
          usedChars: 15,
        },
      },
      toolName: 'alembic_intent' as const,
      actionKind: 'intent' as const,
    };

    expect(
      createAgentPublicToolResultEnvelope({
        ...base,
        status: 'skipped',
        reason: {
          kind: 'skip',
          code: 'no-semantic-intent',
          message: 'No semantic task was present.',
        },
      }).status
    ).toBe('skipped');

    expect(
      createAgentPublicToolResultEnvelope({
        ...base,
        status: 'blocked',
        reason: {
          kind: 'blocked',
          code: 'missing-required-intent',
          message: 'The intentRef is required before this tool can proceed.',
        },
      }).status
    ).toBe('blocked');

    expect(
      createAgentPublicToolResultEnvelope({
        ...base,
        status: 'failed',
        reason: {
          kind: 'failure',
          code: 'schema-validation-failed',
          message: 'The output did not match the contract schema.',
        },
      }).status
    ).toBe('failed');

    expect(() =>
      AgentPublicToolResultEnvelopeSchema.parse({
        contractVersion: 1,
        ...base,
        reason: {
          kind: 'skip',
          code: 'no-semantic-intent',
          message: 'Wrong reason kind for a blocked result.',
        },
        status: 'blocked',
      })
    ).toThrow();
  });

  test('guards against old task-handler dependency in the contract catalog', () => {
    const serializedCatalog = JSON.stringify(listAgentPublicToolContractCatalog());
    expect(serializedCatalog).not.toContain('McpServer.task');
    expect(serializedCatalog).not.toContain('handlers/task');
    expect(serializedCatalog).not.toContain('alembic_task');

    for (const name of AGENT_PUBLIC_TOOL_NAMES) {
      const definition = getAgentPublicToolContractDefinition(name);
      expect(definition.handlerDependency).toBe('McpServer.agent-public-tools');
      expect(definition.activeMcpSurface).toBe(true);
    }
  });
});
