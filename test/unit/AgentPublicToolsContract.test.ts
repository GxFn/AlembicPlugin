import { describe, expect, test } from 'vitest';
import { getMcpOutputProjector, withMcpOutputSchema } from '../../lib/codex/mcp/output-contract.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/codex/mcp/PluginToolSurfaceCatalog.js';
import {
  AGENT_ACTION_KINDS,
  AGENT_INTENT_DESIGN_FIELD_MAPPINGS,
  AGENT_PUBLIC_TOOL_NAMES,
  AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS,
  AGENT_RESULT_STATUSES,
  AgentPublicToolResultEnvelopeSchema,
  createAgentPublicToolOutput,
  createAgentDetailRef,
  createAgentPublicToolResultEnvelope,
  createPrimePublicPackage,
  getAgentPublicToolContractDefinition,
  getAgentPublicToolDescriptionBase,
  listAgentPublicToolContractCatalog,
  PrimePublicPackageSchema,
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

  test('keeps public output schemas tool-specific and rejects cross-tool private fields', () => {
    const base = {
      actionKind: 'intent' as const,
      agentHost: 'codex' as const,
      inputSource: 'host-declared-intent' as const,
      ok: true,
      refs: { detailRefs: [] },
      status: 'ready' as const,
      summary: 'Intent output stays tool-specific.',
      toolName: 'alembic_intent' as const,
    };
    const validIntent = createAgentPublicToolOutput(
      createAgentPublicToolResultEnvelope(base),
      {
        detailRefs: [],
        intentClassification: {
          actionKind: 'implement',
          confidenceBand: 'high',
          objectKind: 'code',
          scopeKind: 'project',
        },
        intentPersistence: { consumable: true, created: true, kind: 'session-local' },
        localRecord: {
          createdAt: '2026-06-10T04:00:00.000Z',
          intentRef: 'intent-d22',
          status: 'ready',
        },
        recognizedIntent: {
          query: 'Tighten MCP output schema',
          action: 'implement',
          confidence: 0.9,
          evidenceSpans: [{ text: 'private span must stay summarized' }],
          source: 'host-declared',
          status: 'recognized',
        },
        retrievalPlan: { route: 'structure-first', vectorUseKind: 'none' },
        toolPlan: {
          guardNeed: 'recommend-if-code-changed',
          primeNeed: 'optional',
          workNeed: 'maybe-start',
        },
      }
    );

    expect(validIntent.recognizedIntent).toMatchObject({
      evidenceSpanCount: 1,
      query: 'Tighten MCP output schema',
    });
    expect(JSON.stringify(validIntent)).not.toContain('private span must stay summarized');

    expect(() =>
      createAgentPublicToolOutput(createAgentPublicToolResultEnvelope(base), {
        ...validIntent,
        primePackage: { primeRef: 'prime-owned-by-another-tool' },
      })
    ).toThrow();

    expect(
      AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.safeParse({
        ...base,
        actionKind: 'code-guard',
        toolName: 'alembic_code_guard',
        guard: {
          ok: true,
          resultSummary: { payloadType: 'object', violationCount: 0 },
          searchMeta: { leaked: true },
        },
      }).success
    ).toBe(false);
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
      summary: 'Work finished with compact evidence and a resident degradation reason.',
      toolName: 'alembic_work_finish',
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
          producerOnlyFields: ['intent', 'search', 'vector', 'relations', 'selectedKnowledge'],
          selectedCount: null,
          status: null,
        },
      },
      feedbackDigest: {
        decisionRefCount: 1,
        feedbackSignalCount: 3,
        observeOnly: true,
        relationEvidenceCount: 1,
        sourceRefCoverage: 1,
        supportedSignals: ['searchHit', 'view', 'adoption'],
      },
      kind: 'PrimePublicPackage',
      primeRef: 'prime-public-contract',
      refs: result.refs,
      status: 'ready',
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

  test('maps every Design intent enum requirement to a public or derived contract field', () => {
    expect(AGENT_INTENT_DESIGN_FIELD_MAPPINGS.map((entry) => entry.field)).toEqual([
      'agentHost',
      'hostSurface',
      'inputSource',
      'intentKind',
      'actionKind',
      'objectKind',
      'scopeKind',
      'persistenceKind',
      'primeNeed',
      'workNeed',
      'guardNeed',
      'vectorUseKind',
      'confidenceBand',
    ]);

    for (const entry of AGENT_INTENT_DESIGN_FIELD_MAPPINGS) {
      expect(['public-field', 'public-result-field', 'internal-derived-field']).toContain(
        entry.disposition
      );
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
  });
});
