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

  test('rejects legacy alembic_plan keys at the strict clean output schema boundary', () => {
    const parsed = CORE_TOOL_OUTPUT_SCHEMAS.alembic_plan.safeParse({
      ok: true,
      status: 'ready',
      summary: 'legacy plan leak',
      toolName: 'alembic_plan',
      meta: {
        contractVersion: 1,
        outputSchema: 'alembic_plan_clean_output',
        projector: 'core-tools-clean-output-projector',
        toolName: 'alembic_plan',
      },
      operation: 'draft',
      projectRoot: '/tmp/project',
      projectInfoTree: {},
      candidateDimensions: [],
      agentDecisionChecklist: [],
      nextActions: [],
      plan: { planId: 'removed' },
    });

    expect(parsed.success).toBe(false);
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
      if (toolName === 'alembic_bootstrap') {
        expect(readRecord(structured.meta).fullBriefingRef).toMatchObject({
          bytes: 1234,
          path: '/tmp/full-bootstrap.json',
        });
      }
      if (toolName === 'alembic_rescan') {
        expect(readRecord(structured.meta).fullBriefingRef).toMatchObject({
          bytes: 5678,
          path: '/tmp/full-rescan.json',
        });
        expect(readRecord(structured.meta).coverageLedgerSeed).toEqual({
          status: 'written',
          writtenCells: 4,
          coveredPathCount: 2,
          moduleCount: 1,
          dimensionIds: ['architecture'],
        });
        expect(structured.hostAgentLifecycle).toMatchObject({
          actionRequired: true,
          state: 'action-required',
          terminal: false,
        });
        expect(JSON.stringify(structured)).not.toContain('secretToken');
        expect(JSON.stringify(structured)).not.toContain('rawCandidates');
        expect(JSON.stringify(structured)).not.toContain('sourceRefPaths');
      }
      if (toolName === 'alembic_dimension_complete') {
        expect(structured.completenessCritic).toMatchObject({
          targetGate: 'advisory',
          shouldBlockCompletion: false,
        });
      }
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

  test('preserves actionable submit_knowledge evidence gate refusal details', () => {
    const nextAction = 'Cite the exact source line range that contains the submitted code snippet.';
    const summary = `Recipe evidence gate failed (1 violation): #0 SNIPPET_MISMATCH → ${nextAction}`;
    const result = serializeMcpToolResult(
      'alembic_submit_knowledge',
      {
        success: false,
        errorCode: 'SNIPPET_MISMATCH',
        message: summary,
        data: {
          evidenceGate: {
            status: 'rebuild-required',
            violationCount: 1,
            violations: [
              {
                code: 'SNIPPET_MISMATCH',
                itemIndex: 0,
                nextAction,
              },
            ],
          },
          problem: {
            status: 'rebuild-required',
            nextAction,
          },
          rejectedItems: [
            {
              code: 'SNIPPET_MISMATCH',
              index: 0,
              nextAction,
            },
          ],
        },
      },
      {
        isErrorResult: () => true,
      }
    );
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: summary }]);
    expect(structured).toMatchObject({
      ok: false,
      error: { code: 'SNIPPET_MISMATCH' },
      evidenceGate: {
        status: 'rebuild-required',
        violationCount: 1,
        violations: [
          {
            code: 'SNIPPET_MISMATCH',
            itemIndex: 0,
            nextAction,
          },
        ],
      },
      problem: {
        status: 'rebuild-required',
        nextAction,
      },
      rejectedItems: [
        {
          code: 'SNIPPET_MISMATCH',
          index: 0,
          nextAction,
        },
      ],
      toolName: 'alembic_submit_knowledge',
    });
    expect(topLevelFieldsAreWhitelisted('alembic_submit_knowledge', structured)).toEqual([]);
    expect(findForbiddenCoreOutputField(structured)).toBeNull();
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
      ...(toolName === 'alembic_bootstrap'
        ? { fullBriefingRef: { bytes: 1234, path: '/tmp/full-bootstrap.json' } }
        : {}),
      ...(toolName === 'alembic_rescan'
        ? {
            coverageLedgerSeed: {
              status: 'written',
              writtenCells: 4,
              coveredPathCount: 2,
              moduleCount: 1,
              dimensionIds: ['architecture'],
              rawCandidates: [{ sourceRefPaths: ['src/App.ts'] }],
              secretToken: 'must-not-leak',
              sourceRefPaths: ['src/App.ts'],
            },
            fullBriefingRef: { bytes: 5678, path: '/tmp/full-rescan.json' },
          }
        : {}),
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
        operation: 'draft',
        projectInfoTree: {
          kind: 'project',
          projectType: 'swift-package',
          primaryLanguage: 'swift',
          secondaryLanguages: [],
          frameworks: ['swift-package-manager'],
          moduleCount: 1,
          fileCount: 2,
          children: [],
          meta: {
            budgetBytes: 12288,
            deliveredDepth: 'modules',
            fullTreeRef: null,
            omitted: {},
            truncated: false,
          },
        },
        candidateDimensions: [
          {
            id: 'architecture',
            label: 'Architecture',
            layer: 'universal',
            languageApplicable: true,
            miningGuidance: 'Architecture boundaries',
          },
        ],
        agentDecisionChecklist: ['Select dimensions and scale before confirm.'],
        nextActions: [{ tool: 'alembic_plan', operation: 'confirm' }],
      };
    case 'alembic_submit_knowledge':
      return {
        count: 1,
        finality: 'final',
        freshness: { status: 'completed', processed: 1, retrievalMayBeStale: false },
        ids: ['recipe-1'],
        relationshipGrounding: { status: 'grounded' },
        retrievalMayBeStale: false,
        total: 1,
      };
    case 'alembic_project_skill':
      return { operation: 'list', skills: [] };
    case 'alembic_bootstrap':
      return {
        bootstrapState: { status: 'bootstrap_ready' },
        currentDimensionGuidance: {
          currentTier: { dimensions: ['architecture'], tier: 1 },
          dimensionIds: ['architecture'],
          dimensions: [
            {
              analysisGuide: { steps: [{ phase: 'scan' }] },
              dimensionId: 'architecture',
              submissionSpec: { knowledgeTypes: ['architecture'] },
            },
          ],
        },
        currentDimensionNextActions: [{ tool: 'alembic_recipe_map' }],
        dimensions: [],
        executionPlan: [],
        gates: { graphFreshness: { rule: 'check status first' } },
        hostAgentContract: {
          contractVersion: 1,
          recipeGuidanceFloor: { candidateCounts: { minimumPerDimension: 3 } },
          submitKnowledgeContract: { tool: 'alembic_submit_knowledge' },
        },
        projectContextCreationGuide: {
          source: 'RG-5-project-context-anchored-creation',
          stage: 'bootstrap',
        },
        recipeCreationNextActions: [{ tool: 'alembic_recipe_map' }],
        repairState: { status: 'ready' },
        toolCapabilities: { canonicalSourceGraph: [] },
      };
    case 'alembic_rescan':
      return {
        allRecipes: [],
        dimensions: [],
        executionPlan: [],
        hostAgentLifecycle: {
          actionRequired: true,
          state: 'action-required',
          terminal: false,
          terminalGate: { pass: false, reason: 'host-agent-action-required' },
        },
        projectContextCreationGuide: {
          source: 'RG-5-project-context-anchored-creation',
          stage: 'rescan',
        },
        recipeCreationNextActions: [{ tool: 'alembic_recipe_map' }],
      };
    case 'alembic_evolve':
      return {
        freshness: { status: 'completed', processed: 1, retrievalMayBeStale: false },
        processed: 1,
        proposed: 0,
        refreshed: 1,
        retrievalMayBeStale: false,
      };
    case 'alembic_consolidate':
      return { kept: 1, merged: 0, processed: 1, rejected: 0 };
    case 'alembic_dimension_complete':
      return {
        completed: true,
        completenessCritic: {
          dimensionId: 'architecture',
          hints: [{ pattern: 'Missing local package coverage' }],
          shouldBlockCompletion: false,
          status: 'has-grounded-hints',
          targetGate: 'advisory',
        },
        dimensionId: 'architecture',
      };
    case 'alembic_knowledge_lifecycle':
      return { action: 'reactivate', updated: 1 };
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
