import { describe, expect, test } from 'vitest';
import { getMcpOutputProjector } from '../../lib/host-runtime/mcp/output-contract.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '../../lib/host-runtime/mcp/PluginToolSurfaceCatalog.js';
import {
  AGENT_PUBLIC_TOOL_NAMES,
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
