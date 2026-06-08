import { describe, expect, test } from 'vitest';
import {
  CORE_BASE_OUTPUT_FIELD_NAMES,
  CORE_CLEAN_OUTPUT_TOOL_NAMES,
  CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
  CORE_TOOL_OUTPUT_SCHEMAS,
  findForbiddenCoreOutputField,
} from '../../lib/codex/mcp/core-tools/output.js';
import {
  getMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../../lib/codex/mcp/output-contract.js';
import { TOOLS } from '../../lib/codex/mcp/tools.js';

const expectedCoreToolNames = [
  'alembic_health',
  'alembic_search',
  'alembic_knowledge',
  'alembic_structure',
  'alembic_graph',
  'alembic_call_context',
  'alembic_guard',
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_evolve',
  'alembic_consolidate',
  'alembic_dimension_complete',
  'alembic_panorama',
  'alembic_enrich_candidates',
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

  test('keeps guard scope blockers clean while removing legacy compatibility metadata', () => {
    const result = serializeMcpToolResult(
      'alembic_guard',
      {
        success: false,
        errorCode: 'GUARD_SCOPE_REQUIRED',
        message:
          'Legacy alembic_guard no-args whole-diff review is disabled. Call alembic_code_guard with explicit files or inline code.',
        data: {
          blocked: true,
          legacyBoundary: {
            noArgsWholeDiffDisabled: true,
            replacementTool: 'alembic_code_guard',
          },
          reasonCode: 'missing-guard-scope',
          required: { files: 'explicit task-scoped file list' },
        },
        meta: { legacyCompatibility: true, mode: 'review', tool: 'alembic_guard' },
      },
      {
        isErrorResult: () => true,
      }
    );
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      ok: false,
      status: 'blocked',
      reasonCode: 'missing-guard-scope',
      error: { code: 'GUARD_SCOPE_REQUIRED' },
    });
    expect(JSON.stringify(structured)).not.toContain('legacyBoundary');
    expect(JSON.stringify(structured)).not.toContain('legacyCompatibility');
    expect(findForbiddenCoreOutputField(structured)).toBeNull();
  });

  test('rejects diagnostic/runtime/source/search metadata bags in ordinary business output', () => {
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_search.safeParse({
      ok: true,
      status: 'ready',
      summary: 'Search completed.',
      toolName: 'alembic_search',
      searchMeta: { residentSearch: { used: true } },
      meta: { contractVersion: 1, toolName: 'alembic_search' },
    });

    expect(parsed.success).toBe(false);
  });

  test('rejects already-clean core outputs with non-whitelisted business fields', () => {
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_search.safeParse({
      ok: true,
      status: 'ready',
      summary: 'Search completed.',
      toolName: 'alembic_search',
      totalResults: 0,
      unexpectedContractLeak: true,
      meta: { contractVersion: 1, toolName: 'alembic_search' },
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
    success: toolName !== 'alembic_guard',
    errorCode: toolName === 'alembic_guard' ? 'GUARD_SCOPE_REQUIRED' : null,
    message: toolName === 'alembic_guard' ? 'Guard scope is required.' : '',
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
    case 'alembic_health':
      return { checks: { database: true }, status: 'ok', version: '0.0.0' };
    case 'alembic_search':
      return {
        items: [],
        kindCounts: { fact: 0, pattern: 0, rule: 0 },
        query: 'contract',
        totalResults: 0,
      };
    case 'alembic_knowledge':
      return { count: 0, items: [], total: 0 };
    case 'alembic_structure':
      return { summary: { targetCount: 1 }, targets: [{ name: 'App' }] };
    case 'alembic_graph':
      return { impactedCount: 0, impacted: [], nodeId: 'recipe-1' };
    case 'alembic_call_context':
      return { callers: [], callees: [], methodName: 'run' };
    case 'alembic_guard':
      return { blocked: true, reasonCode: 'missing-guard-scope' };
    case 'alembic_submit_knowledge':
      return { count: 1, ids: ['recipe-1'], total: 1 };
    case 'alembic_project_skill':
      return { operation: 'list', skills: [] };
    case 'alembic_bootstrap':
      return { dimensions: [], executionPlan: [] };
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
    case 'alembic_enrich_candidates':
      return { entries: [], needsEnrichment: 0, total: 0 };
    case 'alembic_knowledge_lifecycle':
      return { action: 'reactivate', updated: 1 };
  }
}
