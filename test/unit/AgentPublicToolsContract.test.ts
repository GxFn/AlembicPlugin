import { describe, expect, test } from 'vitest';
import { getMcpOutputProjector } from '../../lib/host-runtime/mcp/output-contract.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/host-runtime/mcp/PluginToolSurfaceCatalog.js';
import {
  AGENT_PUBLIC_TOOL_NAMES,
  AgentPrimeOutputSchema,
  createAgentPublicToolOutput,
  createAgentPublicToolResultEnvelope,
  createPrimePublicPackage,
  getAgentPublicToolContractDefinition,
  PrimePublicPackageSchema,
} from '../../lib/host-runtime/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/host-runtime/mcp/tools.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

describe('agent public tool contracts', () => {
  test('publishes one active ordinary surface', () => {
    const names = new Set([
      ...TOOLS.map((tool) => tool.name),
      ...Object.keys(PLUGIN_TOOL_SURFACE_CATALOG),
      ...Object.keys(TOOL_SCHEMAS),
    ]);
    for (const name of AGENT_PUBLIC_TOOL_NAMES) {
      expect(names.has(name)).toBe(true);
      expect(getAgentPublicToolContractDefinition(name)).toMatchObject({
        activeMcpSurface: true,
        implementationStatus: 'active-tool',
      });
      expect(getMcpOutputProjector(name)?.outputSchemaName).toBe(`${name}_clean_output`);
    }
  });

  test('Prime accepts an empty request or optional query/context only', () => {
    expect(TOOL_SCHEMAS.alembic_prime.parse({})).toEqual({});
    expect(
      TOOL_SCHEMAS.alembic_prime.parse({
        query: 'project storage',
        context: 'request scoped lookup',
        projectRoot: '/tmp/project',
      })
    ).toEqual({
      query: 'project storage',
      context: 'request scoped lookup',
      projectRoot: '/tmp/project',
    });
    expect(TOOL_SCHEMAS.alembic_prime.safeParse({ intentRef: 'old' }).success).toBe(false);
  });

  test('Prime package contains query material without host trust receipts', () => {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'prime',
      agentHost: 'codex',
      inputSource: 'user-message',
      refs: {
        detailRefs: [],
        primeRef: { refType: 'prime', id: 'prime-contract', toolName: 'alembic_prime' },
      },
      status: 'ready',
      summary: 'Prime returned zero matches.',
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
      },
      kind: 'PrimePublicPackage',
      primeRef: 'prime-contract',
      refs: result.refs,
      status: 'ready',
      projectContextGuidance: {
        boundary: 'Orientation only.',
        recommendedQueries: [],
        recommendedTools: ['alembic_search'],
        projectContextRefs: [],
        sourceEvidenceRefs: [],
        status: 'recommended',
      },
      summary: result.summary,
    });
    expect(PrimePublicPackageSchema.parse(projection)).toEqual(projection);
    const serialized = JSON.stringify(projection);
    for (const fragment of [
      'trust' + 'Receipt',
      'trust' + 'Posture',
      'primeInjection' + 'Package',
    ]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  test('Prime bounds projected detail summaries without losing candidate order or source refs', () => {
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'prime',
      agentHost: 'codex',
      inputSource: 'user-message',
      refs: {
        detailRefs: [],
        primeRef: { refType: 'prime', id: 'prime-bounded', toolName: 'alembic_prime' },
      },
      status: 'ready',
      summary: 'Prime returned ordered knowledge.',
      toolName: 'alembic_prime',
    });
    const primePackage = createPrimePublicPackage({
      compactPackage: {
        candidateRecipeIds: ['recipe-a', 'recipe-b'],
        acceptedGuards: [],
        acceptedKnowledge: [],
        counts: {
          acceptedGuards: 0,
          acceptedKnowledge: 0,
          detailRefs: 1,
          omittedFromCompact: 0,
        },
        detailRefsMode: 'ref-based',
        evidenceDelivery: 'detailRefs-and-primeKnowledgeMaterial',
      },
      kind: 'PrimePublicPackage',
      primeRef: 'prime-bounded',
      refs: result.refs,
      status: 'ready',
      projectContextGuidance: {
        boundary: 'Orientation only.',
        recommendedQueries: [],
        recommendedTools: ['alembic_search'],
        projectContextRefs: [],
        sourceEvidenceRefs: ['recipe-a', 'recipe-b'],
        status: 'recommended',
      },
      summary: result.summary,
    });

    const output = AgentPrimeOutputSchema.parse(
      createAgentPublicToolOutput(result, {
        primePackage,
        detailRefs: [
          {
            id: 'prime-knowledge:recipe-a',
            kind: 'source-ref',
            summary: `  ${'architecture guidance '.repeat(40)}  `,
            uri: 'recipe://recipe-a',
          },
        ],
      })
    );

    expect(output.detailRefs[0]).toMatchObject({
      id: 'prime-knowledge:recipe-a',
      uri: 'recipe://recipe-a',
    });
    expect(output.detailRefs[0]?.summary.length).toBeLessThanOrEqual(500);
    expect(output.detailRefs[0]?.summary).not.toMatch(/^\s|\s$/);
    expect(output.primePackage.compactPackage.candidateRecipeIds).toEqual(['recipe-a', 'recipe-b']);
  });

  test('Prime projection rejection returns a schema-valid Prime fallback', () => {
    const sourceRef = {
      id: 'prime-source:recipe-a',
      kind: 'source-ref' as const,
      summary: 'Authoritative Recipe source.',
      uri: 'recipe://recipe-a',
    };
    const result = createAgentPublicToolResultEnvelope({
      actionKind: 'prime',
      agentHost: 'codex',
      inputSource: 'user-message',
      refs: {
        detailRefs: [sourceRef],
        primeRef: { refType: 'prime', id: 'prime-fallback', toolName: 'alembic_prime' },
      },
      status: 'ready',
      summary: 'Prime returned ordered knowledge.',
      toolName: 'alembic_prime',
    });
    const primePackage = createPrimePublicPackage({
      compactPackage: {
        candidateRecipeIds: ['recipe-a', 'recipe-b'],
        acceptedGuards: [],
        acceptedKnowledge: [],
        counts: {
          acceptedGuards: 0,
          acceptedKnowledge: 0,
          detailRefs: 1,
          omittedFromCompact: 0,
        },
        detailRefsMode: 'ref-based',
        evidenceDelivery: 'detailRefs-and-primeKnowledgeMaterial',
      },
      kind: 'PrimePublicPackage',
      primeRef: 'prime-fallback',
      refs: result.refs,
      status: 'ready',
      projectContextGuidance: {
        boundary: 'Orientation only.',
        recommendedQueries: [],
        recommendedTools: ['alembic_search'],
        projectContextRefs: [],
        sourceEvidenceRefs: ['recipe-a', 'recipe-b'],
        status: 'recommended',
      },
      summary: result.summary,
    });

    const output = AgentPrimeOutputSchema.parse(
      createAgentPublicToolOutput(result, {
        detailRefs: [
          {
            id: 'prime-material:recipe-a',
            kind: 'source-ref',
            summary: 'layered boundary guidance '.repeat(30),
            uri: 'recipe://recipe-a/material',
          },
        ],
        primePackage,
        nextActions: [{ tool: '', reason: 'force projection rejection' }],
      })
    );

    expect(output.primePackage.compactPackage.candidateRecipeIds).toEqual(['recipe-a', 'recipe-b']);
    expect(output.primePackage.refs.detailRefs).toEqual([expect.objectContaining(sourceRef)]);
    expect(output.detailRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining(sourceRef),
        expect.objectContaining({
          id: 'prime-material:recipe-a',
          uri: 'recipe://recipe-a/material',
        }),
      ])
    );
    expect(
      output.detailRefs.find((ref) => ref.id === 'prime-material:recipe-a')?.summary.length
    ).toBe(500);
    expect(output.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'output-projection-rejected' })])
    );
  });

  test('non-ready work results retain matching reasons', () => {
    expect(
      createAgentPublicToolResultEnvelope({
        actionKind: 'work',
        agentHost: 'codex',
        inputSource: 'user-message',
        refs: { detailRefs: [] },
        reason: {
          kind: 'blocked',
          code: 'missing-work-ref',
          message: 'A current work reference is required.',
        },
        status: 'blocked',
        summary: 'Work finish blocked.',
        toolName: 'alembic_work',
      }).status
    ).toBe('blocked');
  });
});
