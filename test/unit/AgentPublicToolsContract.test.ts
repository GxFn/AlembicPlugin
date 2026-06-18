import { describe, expect, test } from 'vitest';
import {
  getMcpOutputProjector,
  withMcpOutputSchema,
} from '../../lib/runtime/mcp/output-contract.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import {
  AGENT_ACTION_KINDS,
  AGENT_PUBLIC_TOOL_NAMES,
  AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS,
  AGENT_RESULT_STATUSES,
  AgentPublicToolResultEnvelopeSchema,
  createAgentDetailRef,
  createAgentPublicToolOutput,
  createAgentPublicToolResultEnvelope,
  createPrimePublicPackage,
  getAgentPublicToolContractDefinition,
  getAgentPublicToolDescriptionBase,
  listAgentPublicToolContractCatalog,
  PrimePublicPackageSchema,
} from '../../lib/runtime/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

describe('Agent-facing public tools contract foundation', () => {
  test('declares the three public tools and marks them as active public tools', () => {
    expect(AGENT_PUBLIC_TOOL_NAMES).toEqual([
      'alembic_prime',
      'alembic_work',
      'alembic_code_guard',
    ]);
    expect(AGENT_ACTION_KINDS).toEqual(['prime', 'work', 'code-guard']);

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

  test('registers clean MCP output schemas for every public tool', () => {
    const activeToolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

    for (const name of AGENT_PUBLIC_TOOL_NAMES) {
      expect(getMcpOutputProjector(name)).toMatchObject({
        outputSchemaName: `${name}_clean_output`,
        projectorName: 'agent-public-clean-output-projector',
      });
      expect(
        withMcpOutputSchema(activeToolsByName.get(name) ?? { name }).outputSchema
      ).toMatchObject({
        type: 'object',
      });
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

  test('validates clean public results with refs, detailRefs, and reasons', () => {
    const detailRef = createAgentDetailRef({
      id: 'contract:public-tools',
      kind: 'contract',
      summary: 'Public tools contract catalog and result envelope evidence',
      uri: 'lib/runtime/mcp/public-tools/contract.ts',
      requiredForCompletion: true,
    });

    const envelope = createAgentPublicToolResultEnvelope({
      agentHost: 'codex',
      actionKind: 'work',
      inputSource: 'host-declared-intent',
      intentKind: 'implementation-task',
      refs: {
        workRef: { refType: 'work', id: 'work-1', toolName: 'alembic_work' },
        detailRefs: [detailRef],
      },
      reason: {
        kind: 'degraded',
        code: 'resident-unavailable',
        message: 'Resident service was unavailable, so the contract returns compact evidence.',
      },
      status: 'degraded',
      summary: 'Work finished with compact evidence and a resident degradation reason.',
      toolName: 'alembic_work',
    });

    expect(envelope.refs.detailRefs).toHaveLength(1);
    expect(envelope.reason).toMatchObject({
      kind: 'degraded',
      code: 'resident-unavailable',
    });
    expect(JSON.stringify(envelope)).not.toContain('legacyCompatibility');
    expect(JSON.stringify(envelope)).not.toContain('outputBudget');
  });

  test('validates canonical prime public package projection', () => {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'prime',
      agentHost: 'codex',
      inputSource: 'host-declared-intent',
      refs: {
        detailRefs: [],
        primeRef: { refType: 'prime', id: 'prime-public-contract', toolName: 'alembic_prime' },
      },
      status: 'ready',
      summary: 'Prime delivered compact trust material.',
      toolName: 'alembic_prime',
    });

    const projection = createPrimePublicPackage({
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
          availability: 'not-produced',
          missingProducerFields: [],
          omittedCount: null,
          pluginSynthesized: false,
          producer: 'alembic-resident-service',
          producerBoundary:
            'Resident producer owns PrimeInjectionPackage fields; Plugin does not synthesize them.',
          producerOnlyFields: ['intent', 'search', 'vector', 'selectedKnowledge'],
          selectedCount: null,
          status: null,
        },
      },
      feedbackDigest: {
        decisionRefCount: 1,
        feedbackSignalCount: 3,
        observeOnly: true,
        sourceRefCoverage: 1,
        supportedSignals: ['searchHit', 'view', 'adoption'],
      },
      kind: 'PrimePublicPackage',
      primeRef: 'prime-public-contract',
      refs: result.refs,
      status: 'ready',
      projectContextGuidance: {
        boundary:
          'ProjectContext guidance is code-structure evidence only; it does not replace validation.',
        recommendedQueries: [
          {
            query: 'project graph',
            tool: 'alembic_graph',
          },
        ],
        recommendedTools: ['alembic_project_matrix', 'alembic_graph'],
        projectContextRefs: [],
        sourceEvidenceRefs: [],
        status: 'recommended',
      },
      summary: result.summary,
      trustPosture: {
        antiEmptyReceiptRequired: true,
        noTrustedClaimRequired: false,
        receiptChecklist: [
          'trusted-to-obey',
          'trusted-to-use',
          'context-only',
          'requires-verification',
          'not-available-or-degraded',
        ].map((layer) => ({
          itemCount: 0,
          label: layer,
          layer,
          requiredInVisibleReceipt: false,
          visibleReceiptDirective: `Directive for ${layer}`,
        })),
        status: 'delivered',
      },
      trustReceipt: {
        hostResponse: null,
        receiptId: 'prime-receipt-contract',
        status: 'delivered',
      },
    });

    expect(PrimePublicPackageSchema.parse(projection)).toMatchObject({
      kind: 'PrimePublicPackage',
      primeRef: 'prime-public-contract',
      compactPackage: {
        detailRefsMode: 'ref-based',
        primeInjectionPackage: { pluginSynthesized: false },
      },
      feedbackDigest: {
        observeOnly: true,
        supportedSignals: expect.arrayContaining(['adoption']),
      },
    });
    expect(JSON.stringify(projection)).not.toContain('"diagnostics"');
    expect(JSON.stringify(projection)).not.toContain('"runtimePolicy"');
    expect(JSON.stringify(projection)).not.toContain('"sourcePolicy"');
    expect(JSON.stringify(projection)).not.toContain('"retrievalConsumer"');
  });

  test('requires skip, degraded, blocked, and failed results to carry matching reasons', () => {
    const base = {
      agentHost: 'codex' as const,
      inputSource: 'user-message' as const,
      refs: { detailRefs: [] },
      summary: 'Contract result',
      toolName: 'alembic_work' as const,
      actionKind: 'work' as const,
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
