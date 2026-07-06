import { describe, expect, test } from 'vitest';
import {
  getMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../../lib/host-runtime/mcp/output-contract.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/host-runtime/mcp/PluginToolSurfaceCatalog.js';
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
} from '../../lib/host-runtime/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/host-runtime/mcp/tools.js';
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
      uri: 'lib/host-runtime/mcp/public-tools/contract.ts',
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

  test('accepts code_guard public opportunistic evolution data with readable verdict', () => {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: 'codex',
      inputSource: 'automation-envelope',
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Code Guard checked explicit files.',
      toolName: 'alembic_code_guard',
    });

    const output = createAgentPublicToolOutput(result, {
      data: {
        unifiedEvolution: samplePluginOpportunisticEvolutionSurface(),
      },
    });

    expect(AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.parse(output)).toMatchObject({
      data: {
        unifiedEvolution: {
          evidenceGate: {
            verdict: 'routed',
          },
        },
      },
      toolName: 'alembic_code_guard',
    });
  });

  test('accepts code_guard primeAlignment and projects guardResult.appliedRules (2026-07-06 炸链钉)', () => {
    // C：primeAlignment 未进输出 schema 时，凡带 primeRef 的 guard 调用在输出
    // parse 处 unrecognized_keys 整体失败；D：appliedRules 在投影层被静默丢弃。
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: 'claude-code',
      inputSource: 'user-message',
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Code Guard checked explicit files.',
      toolName: 'alembic_code_guard',
    });

    const output = createAgentPublicToolOutput(result, {
      guard: {
        success: true,
        guardResult: {
          appliedRules: {
            total: 12,
            bySource: { recipe: 9, builtin: 3 },
            sample: [
              { id: 'r1', name: 'errorHandler 单咽喉', severity: 'warning', source: 'recipe' },
            ],
          },
          files: [{ language: 'typescript' }],
          summary: { total: 0, errors: 0, warnings: 0 },
        },
      },
      primeAlignment: {
        primeRef: 'prime-public-test-1',
        status: 'observed',
        deliveredKnowledgeCount: 6,
        overlappedKnowledgeCount: 1,
        overlappedKnowledge: [
          {
            id: 'k1',
            title: 'errorHandler 集中式错误处理中间件',
            matchedFiles: ['lib/http/middleware/errorHandler.ts'],
          },
        ],
      },
    });

    const parsed = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.parse(output);
    expect(parsed).toMatchObject({
      guard: {
        appliedRules: { total: 12, bySource: { recipe: 9 } },
      },
      primeAlignment: { status: 'observed', overlappedKnowledgeCount: 1 },
      toolName: 'alembic_code_guard',
    });

    // G-B：applicableRecipeRules（适用 Recipe 规矩清单）经投影层保留
    const withRecipeRules = createAgentPublicToolOutput(result, {
      guard: {
        success: true,
        guardResult: {
          applicableRecipeRules: [
            {
              recipeId: 'r1',
              title: 'errorHandler 单咽喉',
              trigger: '@error-handler',
              kind: 'pattern',
              doClause: 'Route all HTTP errors through errorHandler.',
              dontClause: 'Do not send raw error responses from route handlers.',
              sourceRef: 'Alembic/lib/http/middleware/errorHandler.ts:1-12',
            },
          ],
          summary: { total: 0, errors: 0, warnings: 0 },
        },
      },
    });
    const parsedRules = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.parse(withRecipeRules);
    expect(parsedRules.guard?.applicableRecipeRules).toHaveLength(1);
    expect(parsedRules.guard?.applicableRecipeRules?.[0]).toMatchObject({
      recipeId: 'r1',
      dontClause: 'Do not send raw error responses from route handlers.',
      sourceRef: 'Alembic/lib/http/middleware/errorHandler.ts:1-12',
    });

    const unknownOutput = createAgentPublicToolOutput(result, {
      primeAlignment: {
        primeRef: 'prime-public-other-session',
        status: 'prime-ref-unknown',
        note: 'No prime delivery record in this MCP session (expired, capped, or from another session).',
      },
    });
    expect(
      AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.parse(unknownOutput).primeAlignment
    ).toMatchObject({ status: 'prime-ref-unknown' });
  });

  test('projects guard violation details with recipe fix guidance (V-1) and degrades honestly on schema rejection (Wave 2)', () => {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: 'claude-code',
      inputSource: 'user-message',
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Code Guard checked explicit files.',
      toolName: 'alembic_code_guard',
    });

    // V-1：check 路径（顶层 violations）+ review 路径（files[].violations 含 recipe）统一扁平化
    const output = createAgentPublicToolOutput(result, {
      guard: {
        success: true,
        guardResult: {
          violations: [
            {
              ruleId: 'js-no-var',
              severity: 'warning',
              line: 2,
              message: '禁止 var',
              snippet: 'var x = 1;',
            },
          ],
          files: [
            {
              filePath: 'Alembic/lib/http/routes/demo.ts',
              violations: [
                {
                  ruleId: 'custom-no-todo',
                  severity: 'warning',
                  line: 7,
                  message: 'TODO 未处理',
                  recipe: {
                    title: 'No TODO',
                    doClause: 'Resolve TODOs before commit.',
                    dontClause: 'Do not commit TODO comments.',
                  },
                },
              ],
            },
          ],
          summary: { total: 2, errors: 0, warnings: 2 },
        },
      },
    });
    const parsed = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.parse(output);
    expect(parsed.guard?.violations).toHaveLength(2);
    expect(parsed.guard?.violations?.[0]).toMatchObject({ ruleId: 'js-no-var', line: 2 });
    expect(parsed.guard?.violations?.[1]).toMatchObject({
      filePath: 'Alembic/lib/http/routes/demo.ts',
      recipe: { title: 'No TODO', dontClause: 'Do not commit TODO comments.' },
    });

    // Wave 2：非法 payload（primeAlignment 非法枚举）不再崩整个工具——降级 base envelope+诊断
    const degraded = createAgentPublicToolOutput(result, {
      primeAlignment: { primeRef: 'p-1', status: 'not-a-valid-status' },
    }) as Record<string, unknown>;
    expect(degraded.ok).toBe(true);
    expect(degraded.summary).toBe('Code Guard checked explicit files.');
    const diagnostics = degraded.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics?.[0]?.code).toBe('output-projection-rejected');
    expect(degraded.primeAlignment).toBeUndefined();
  });

  test('serializes code_guard public unified evolution data through the MCP output projector', () => {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'code-guard',
      agentHost: 'codex',
      inputSource: 'automation-envelope',
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Code Guard checked explicit files.',
      toolName: 'alembic_code_guard',
    });
    const output = createAgentPublicToolOutput(result, {
      data: {
        unifiedEvolution: samplePluginOpportunisticEvolutionSurface(),
      },
    });

    const serialized = serializeMcpToolResult('alembic_code_guard', output, {
      isErrorResult: () => false,
    });

    expect(serialized.isError).toBeUndefined();
    expect(serialized.content).toEqual([{ type: 'text', text: output.summary }]);
    expect(serialized.structuredContent).toMatchObject({
      data: {
        unifiedEvolution: {
          evidenceGate: {
            verdict: 'routed',
          },
        },
      },
      meta: {
        outputSchema: 'alembic_code_guard_clean_output',
        projector: 'agent-public-clean-output-projector',
      },
      toolName: 'alembic_code_guard',
    });
  });

  test('keeps code_guard public data strict while allowing unified evolution verdict', () => {
    const parsed = AGENT_PUBLIC_TOOL_OUTPUT_SCHEMAS.alembic_code_guard.safeParse({
      actionKind: 'code-guard',
      agentHost: 'codex',
      data: {
        unexpectedContractLeak: true,
        unifiedEvolution: samplePluginOpportunisticEvolutionSurface(),
      },
      inputSource: 'automation-envelope',
      ok: true,
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Code Guard checked explicit files.',
      toolName: 'alembic_code_guard',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: ['data'],
        }),
      ])
    );
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
        recommendedTools: ['alembic_recipe_map', 'alembic_graph'],
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

function samplePluginOpportunisticEvolutionSurface() {
  return {
    autoSubmit: false,
    evidenceGate: {
      reasons: [
        'Alembic resident ProjectScope is unavailable; Plugin fallback used git diff evidence.',
        'git diff surfaced 1 changed path(s)',
        'tool outcome available from alembic_code_guard',
      ],
      verdict: 'routed',
    },
    gitDiffEvidence: {
      dirtyPathCount: 1,
      eventCount: 1,
      events: [
        {
          eventSource: 'working-tree',
          path: 'src/service.ts',
          type: 'modified',
        },
      ],
      head: 'abc123',
      headChanged: true,
      headRangeStatus: 'changed',
      mergeBase: null,
      previousHead: 'abc122',
      scanned: true,
      scannedAt: '2026-06-28T21:45:00.000Z',
      signature: 'sig-1',
      truncated: false,
    },
    producerBoundary: {
      producerKind: 'plugin-opportunistic',
      separatedFrom: 'daemon-file-change',
    },
    serviceGate: {
      reason:
        'Alembic resident ProjectScope is unavailable, disabled, or unable to accept this source folder.',
      residentProjectScopeAvailable: false,
      residentSearchEnhancementReady: false,
    },
    trigger: {
      reason: 'commit-driven-unified-evolution',
      tool: 'alembic_code_guard',
    },
    unifiedEvolution: {
      classificationCounts: {
        modified: 1,
        proposed: 1,
      },
      deprecated: 0,
      fixed: 0,
      generationChangeLog: [
        {
          action: 'source-modified-review-needed',
          createdAt: 1782675900000,
          filePath: 'src/service.ts',
          reason: 'changed service tokens',
          recipeId: 'recipe-1',
        },
      ],
      moduleMiningRoutes: [],
      needsReview: 1,
      pendingProposals: [
        {
          action: 'update',
          confidence: 0.72,
          description: 'changed service tokens',
          filePath: 'src/service.ts',
          recipeId: 'recipe-1',
          source: 'file-change',
          status: 'submitted',
        },
      ],
      planBoundary: {
        generationStateWrites: 0,
        planIntentWrites: 0,
        projectedFromExistingDbSources: true,
      },
      skipped: 0,
      suggestReview: true,
    },
  };
}
