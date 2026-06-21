import { CORE_D25_REQUIRED_FAILURE_KINDS, getCoreFailureTaxonomyEntry } from '@alembic/core/shared';
import { describe, expect, test } from 'vitest';
import {
  CORE_BASE_OUTPUT_FIELD_NAMES,
  CORE_CLEAN_OUTPUT_TOOL_NAMES,
  CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
  CORE_TOOL_OUTPUT_SCHEMAS,
  findForbiddenCoreOutputField,
} from '../../lib/runtime/mcp/core-tools/output.js';
import {
  getMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../../lib/runtime/mcp/output-contract.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';

const expectedCoreToolNames = [
  'alembic_knowledge',
  'alembic_structure',
  'alembic_call_context',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_evolve',
  'alembic_consolidate',
  'alembic_dimension_complete',
  'alembic_panorama',
  'alembic_knowledge_lifecycle',
] as const;

describe('MCP core tools clean output contract', () => {
  test('registers output schemas for every P3 core/query/write/workflow/admin tool', () => {
    expect(CORE_CLEAN_OUTPUT_TOOL_NAMES).toEqual(expectedCoreToolNames);
    const activeToolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

    for (const toolName of CORE_CLEAN_OUTPUT_TOOL_NAMES) {
      expect(getMcpOutputProjector(toolName)).toMatchObject({
        outputSchemaName: `${toolName}_clean_output`,
        projectorName: 'core-tools-clean-output-projector',
      });
      expect(
        withMcpOutputSchema(activeToolsByName.get(toolName) ?? { name: toolName })
      ).toHaveProperty('outputSchema');
    }
  });

  test('does not expose removed candidate enrichment tool on active core surfaces', () => {
    expect(CORE_CLEAN_OUTPUT_TOOL_NAMES).not.toContain('alembic_enrich_candidates');
    expect(TOOLS.map((tool) => tool.name)).not.toContain('alembic_enrich_candidates');
    expect(CORE_TOOL_OUTPUT_SCHEMAS).not.toHaveProperty('alembic_enrich_candidates');
  });

  test('exposes tool-specific outputSchema business fields instead of a generic catchall payload', () => {
    const activeToolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));
    const baseFields = new Set<string>(CORE_BASE_OUTPUT_FIELD_NAMES);

    for (const toolName of CORE_CLEAN_OUTPUT_TOOL_NAMES) {
      const toolWithSchema = withMcpOutputSchema(
        activeToolsByName.get(toolName) ?? { name: toolName }
      );
      const outputSchema = toolWithSchema.outputSchema as
        | { additionalProperties?: unknown; properties?: Record<string, unknown> }
        | undefined;
      const properties = outputSchema?.properties ?? {};
      const businessFields = CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName];

      for (const fieldName of [...CORE_BASE_OUTPUT_FIELD_NAMES, ...businessFields]) {
        expect(properties).toHaveProperty(fieldName);
      }
      expect(Object.keys(properties).some((fieldName) => !baseFields.has(fieldName))).toBe(true);
      expect(outputSchema?.additionalProperties).not.toEqual(true);
    }
  });

  test('projects legacy envelopes into clean structuredContent with summary-only text', () => {
    for (const toolName of CORE_CLEAN_OUTPUT_TOOL_NAMES) {
      const legacy = sampleLegacyEnvelope(toolName);
      const result = serializeMcpToolResult(toolName, legacy, {
        isErrorResult: (value) =>
          !!value &&
          typeof value === 'object' &&
          (value as { success?: unknown }).success === false,
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.content).toEqual([{ type: 'text', text: structured.summary }]);
      expect(structured).toMatchObject({
        ok: legacy.success,
        summary: expect.any(String),
        toolName,
        meta: {
          contractVersion: 1,
          outputSchema: `${toolName}_clean_output`,
          projector: 'core-tools-clean-output-projector',
          toolName,
        },
      });
      expect(structured).not.toHaveProperty('data');
      expect(structured).not.toHaveProperty('errorCode');
      expect(structured).not.toHaveProperty('message');
      expect(structured).not.toHaveProperty('result');
      expect(structured).not.toHaveProperty('success');
      expect(structured).not.toHaveProperty('unexpectedContractLeak');
      expect(structured).not.toHaveProperty('temporaryCompatibilityBag');
      expect(structured).not.toHaveProperty('value');
      expect(topLevelFieldsAreWhitelisted(toolName, structured)).toEqual([]);
      expect(findForbiddenCoreOutputField(structured)).toBeNull();
      expect(CORE_TOOL_OUTPUT_SCHEMAS[toolName].parse(structured)).toEqual(structured);
    }
  });

  test('projects D25 provider problem taxonomy into clean ok=false errors', () => {
    for (const failureKind of CORE_D25_REQUIRED_FAILURE_KINDS) {
      const taxonomy = getCoreFailureTaxonomyEntry(failureKind);
      const result = serializeMcpToolResult(
        'alembic_call_context',
        {
          success: false,
          error: {
            ...taxonomy,
            apiKey: 'must-not-leak',
            code: `PROVIDER_${failureKind.toUpperCase().replace(/-/g, '_')}`,
            detailRefs: [`provider:${failureKind}`],
            message: `Provider ${failureKind}.`,
            providerPrivateTrace: 'must-not-leak',
            secretToken: 'must-not-leak',
          },
          data: {
            callers: [],
            methodName: 'taxonomy',
          },
        },
        {
          isErrorResult: () => true,
        }
      );
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.isError).toBe(true);
      expect(structured).toMatchObject({
        ok: false,
        error: {
          detailRefs: [`provider:${failureKind}`],
          failureId: taxonomy.stableId,
          failureStatus: taxonomy.status,
          mcpErrorCode: taxonomy.mcpErrorCode,
          mcpStatus: taxonomy.mcpStatus,
          privateDataSafe: true,
          problemClass: taxonomy.problemClass,
          reasonCode: taxonomy.kind,
          refPolicy: taxonomy.refPolicy,
          retryPolicy: taxonomy.retryPolicy,
          retryable: taxonomy.retryable,
        },
      });
      expect(JSON.stringify(structured)).not.toContain('apiKey');
      expect(JSON.stringify(structured)).not.toContain('providerPrivateTrace');
      expect(JSON.stringify(structured)).not.toContain('secretToken');
      expect(findForbiddenCoreOutputField(structured)).toBeNull();
    }
  });

  test('rejects diagnostic/runtime/source/search metadata bags in ordinary business output', () => {
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_call_context.safeParse({
      ok: true,
      status: 'ready',
      summary: 'Call context completed.',
      toolName: 'alembic_call_context',
      searchMeta: { residentSearch: { used: true } },
      meta: { contractVersion: 1, toolName: 'alembic_call_context' },
    });

    expect(parsed.success).toBe(false);
  });

  test('rejects already-clean core outputs with non-whitelisted business fields', () => {
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_call_context.safeParse({
      ok: true,
      status: 'ready',
      summary: 'Call context completed.',
      toolName: 'alembic_call_context',
      methodName: 'run',
      unexpectedContractLeak: true,
      meta: { contractVersion: 1, toolName: 'alembic_call_context' },
    });

    expect(parsed.success).toBe(false);
  });
});

function topLevelFieldsAreWhitelisted(
  toolName: (typeof CORE_CLEAN_OUTPUT_TOOL_NAMES)[number],
  structured: Record<string, unknown>
) {
  const allowed = new Set<string>([
    ...CORE_BASE_OUTPUT_FIELD_NAMES,
    ...CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName],
  ]);
  return Object.keys(structured).filter((fieldName) => !allowed.has(fieldName));
}

function sampleLegacyEnvelope(toolName: (typeof CORE_CLEAN_OUTPUT_TOOL_NAMES)[number]) {
  return {
    success: true,
    errorCode: null,
    message: '',
    data: {
      ...sampleBusinessData(toolName),
      diagnostics: { traceId: 'diag-1' },
      metadata: { internal: true },
      projectRuntime: { runtimeDir: '/tmp/not-public' },
      runtimePolicy: { route: 'internal' },
      searchMeta: { residentSearch: { used: true } },
      sourcePolicy: { owner: 'internal' },
      telemetry: { durationMs: 7 },
      temporaryCompatibilityBag: { stale: true },
      unexpectedContractLeak: 'must be dropped by the tool whitelist',
    },
    meta: {
      responseTimeMs: 7,
      source: 'unit-sample',
      tool: toolName,
    },
  };
}

function sampleBusinessData(toolName: (typeof CORE_CLEAN_OUTPUT_TOOL_NAMES)[number]) {
  switch (toolName) {
    case 'alembic_knowledge':
      return { count: 0, items: [], total: 0 };
    case 'alembic_structure':
      return { summary: { targetCount: 1 }, targets: [{ name: 'App' }] };
    case 'alembic_call_context':
      return { callers: [], callees: [], methodName: 'run' };
    case 'alembic_plan':
      return {
        operation: 'get',
        plan: { planId: 'plan-1', version: 1 },
        planState: { coverage: { gaps: [] } },
      };
    case 'alembic_submit_knowledge':
      return { count: 1, ids: ['recipe-1'], total: 1 };
    case 'alembic_project_skill':
      return { operation: 'list', skills: [] };
    case 'alembic_bootstrap':
      return {
        bootstrapState: { status: 'bootstrap_ready' },
        currentDomainSop: { domainId: 'D1-runtime-entrypoints' },
        dimensions: [],
        domainQueue: [{ domainId: 'D1-runtime-entrypoints' }],
        executionPlan: [],
        gates: { graphFreshness: { rule: 'check status first' } },
        repairState: { status: 'ready' },
        sopPack: { contractVersion: 1 },
        toolCapabilities: { canonicalSourceGraph: [] },
      };
    case 'alembic_rescan':
      return { allRecipes: [], dimensions: [], executionPlan: [] };
    case 'alembic_evolve':
      return { processed: 1, proposed: 0, refreshed: 1 };
    case 'alembic_consolidate':
      return { kept: 1, merged: 0, processed: 1, rejected: 0 };
    case 'alembic_dimension_complete':
      return { completed: true, dimensionId: 'architecture' };
    case 'alembic_panorama':
      return { modules: [], overview: { moduleCount: 0 } };
    case 'alembic_knowledge_lifecycle':
      return { action: 'reactivate', updated: 1 };
  }
}
