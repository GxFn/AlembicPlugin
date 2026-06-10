import {
  createSourceGraphAffectedTestsResult,
  createSourceGraphCalleesResult,
  createSourceGraphCallersResult,
  createSourceGraphEdge,
  createSourceGraphExploreResult,
  createSourceGraphImpactResult,
  createSourceGraphNodeResult,
  createSourceGraphSearchResult,
  createSourceGraphStatusResult,
  createSourceGraphValidationPlanResult,
  createSourceSection,
  createSourceSymbolNode,
} from '@alembic/core/source-graph';
import { describe, expect, test } from 'vitest';
import {
  findForbiddenSourceGraphOutputField,
  projectSourceGraphOperationBusiness,
  SOURCE_GRAPH_OPERATION_TOOL_NAMES,
  SOURCE_GRAPH_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
  SOURCE_GRAPH_TOOL_BUSINESS_SCHEMAS,
  type SourceGraphOperationToolName,
} from '../../lib/codex/mcp/source-graph/output.js';

const projectRoot = '/tmp/alembic-plugin-source-graph';
const freshness = {
  status: 'fresh' as const,
  checkedAt: 1,
  generationId: 'gen-1',
  indexedAt: 1,
  pendingFileCount: 0,
  staleFileCount: 0,
};
const degradedFreshness = {
  status: 'uninitialized' as const,
  checkedAt: 2,
  pendingFileCount: 0,
  staleFileCount: 0,
  reason: 'no Core source graph snapshot',
  nextAction: 'initialize_core_source_graph_or_run_catch_up_before_requesting_source_facts',
};

describe('MCP source graph output contract', () => {
  test('projects Core source graph operation DTOs into operation-specific clean business fields', () => {
    const samples = sampleOperationResults();

    for (const toolName of SOURCE_GRAPH_OPERATION_TOOL_NAMES) {
      const projected = projectSourceGraphOperationBusiness(samples[toolName], toolName);
      const allowed = new Set(SOURCE_GRAPH_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]);

      expect(SOURCE_GRAPH_TOOL_BUSINESS_SCHEMAS[toolName].parse(projected)).toEqual(projected);
      expect(Object.keys(projected).every((fieldName) => allowed.has(fieldName))).toBe(true);
      expect(projected).not.toHaveProperty('projectRoot');
      expect(projected).not.toHaveProperty('data');
      expect(projected).not.toHaveProperty('success');
      expect(projected).toHaveProperty('sourceGraphRef');
      expect(projected).toHaveProperty('sourceEvidenceRefs');
      expect(JSON.stringify(projected)).not.toContain(projectRoot);
      expect(JSON.stringify(projected)).not.toContain('must-not-leak');
      if ('sourceSections' in projected && Array.isArray(projected.sourceSections)) {
        expect(JSON.stringify(projected.sourceSections)).not.toContain('metadata');
      }
      expect(findForbiddenSourceGraphOutputField(projected)).toBeNull();
    }

    expect(samples.alembic_validation_plan).toBeTruthy();
    const validationPlan = projectSourceGraphOperationBusiness(
      samples.alembic_validation_plan,
      'alembic_validation_plan'
    );
    expect(validationPlan).toMatchObject({
      operation: 'validation-plan',
      validationPlan: {
        mustRun: [
          {
            command: 'npm run test:unit -- test/unit/McpSourceGraphOutputContract.test.ts',
            evidenceCount: 1,
          },
        ],
        recommended: [{ command: 'npm run build:check' }],
        manualReview: [{ diagnosticCode: 'affected-tests-unknown' }],
        unknown: [{ diagnosticCode: 'source-ref-unproven' }],
      },
    });
    expect(JSON.stringify(validationPlan)).not.toContain('metadata');
  });

  test('keeps source graph status honest when the Core graph is unavailable', () => {
    const projected = projectSourceGraphOperationBusiness(
      createSourceGraphStatusResult({
        projectRoot,
        repoId: 'plugin-repo',
        freshness: degradedFreshness,
        diagnostics: [
          {
            code: 'source-ref-unproven',
            message: 'source graph is unavailable',
            metadata: { traceId: 'must-not-leak' },
          },
        ],
        counts: {
          fileCount: 0,
          symbolCount: 0,
          edgeCount: 0,
          parseErrorCount: 0,
        },
      }),
      'alembic_source_graph_status'
    );

    expect(projected).toMatchObject({
      operation: 'status',
      ready: false,
      graph: { freshness: 'uninitialized' },
      sync: { status: 'uninitialized' },
      counts: {
        fileCount: 0,
        symbolCount: 0,
        edgeCount: 0,
        parseErrorCount: 0,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('must-not-leak');
  });

  test('allows ready status only when the Core freshness contract permits it', () => {
    const projected = projectSourceGraphOperationBusiness(
      createSourceGraphStatusResult({
        projectRoot,
        repoId: 'plugin-repo',
        freshness,
        counts: {
          fileCount: 3,
          symbolCount: 5,
          edgeCount: 7,
          parseErrorCount: 0,
        },
      }),
      'alembic_source_graph_status'
    );

    expect(projected).toMatchObject({
      operation: 'status',
      ready: true,
      graph: { freshness: 'fresh' },
      sync: { status: 'fresh' },
      counts: {
        fileCount: 3,
        symbolCount: 5,
        edgeCount: 7,
        parseErrorCount: 0,
      },
    });
  });

  test('rejects unrelated refs, resident metadata, internal telemetry, output budgets, and data bags', () => {
    const invalid = SOURCE_GRAPH_TOOL_BUSINESS_SCHEMAS.alembic_symbol_search.safeParse({
      operation: 'search',
      ready: true,
      repo: { id: 'plugin-repo', metadata: { traceId: 'must-not-leak' } },
      graph: { freshness: 'fresh' },
      symbols: [],
      data: { global: true },
      refs: ['legacy-ref'],
      residentService: { ok: true },
      internalTelemetry: { span: 'hidden' },
      outputBudget: { maxTokens: 1000 },
      legacyAliases: ['alembic_graph'],
    });

    expect(invalid.success).toBe(false);
  });
});

function sampleOperationResults(): Record<SourceGraphOperationToolName, unknown> {
  const { caller, edge, section, symbol } = sampleGraphFixtures();
  const base = sampleOperationBase();

  return {
    alembic_source_graph_status: {
      ...createSourceGraphStatusResult({
        ...base,
        counts: {
          fileCount: 1,
          symbolCount: 2,
          edgeCount: 1,
          parseErrorCount: 0,
        },
      }),
      telemetry: { traceId: 'must-not-leak' },
    },
    alembic_symbol_search: createSourceGraphSearchResult({
      ...base,
      query: 'resolve project root',
      symbols: [symbol],
      sourceSections: [section],
      edges: [edge],
      impactedFiles: ['test/unit/CodexMcpServer.test.ts'],
    }),
    alembic_code_explore: createSourceGraphExploreResult({
      ...base,
      query: 'source graph',
      focus: 'status',
      symbols: [symbol],
      sourceSections: [section],
      edges: [edge],
    }),
    alembic_source_node: createSourceGraphNodeResult({
      ...base,
      nodeId: 'symbol-1',
      symbol,
      sourceSections: [section],
      edges: [edge],
    }),
    alembic_callers: createSourceGraphCallersResult({
      ...base,
      symbolId: 'symbol-1',
      callers: [caller],
      sourceSections: [section],
      edges: [edge],
    }),
    alembic_callees: createSourceGraphCalleesResult({
      ...base,
      symbolId: 'symbol-caller',
      callees: [symbol],
      sourceSections: [section],
      edges: [edge],
    }),
    alembic_code_impact: createSourceGraphImpactResult({
      ...base,
      changedFiles: ['lib/codex/mcp/source-graph/status.ts'],
      impactedFiles: ['test/unit/McpSourceGraphOutputContract.test.ts'],
      edges: [edge],
      affectedValidations: ['npm run test:unit -- test/unit/McpSourceGraphOutputContract.test.ts'],
    }),
    alembic_affected_tests: createSourceGraphAffectedTestsResult({
      ...base,
      changedFiles: ['lib/codex/mcp/source-graph/status.ts'],
      testFiles: ['test/unit/McpSourceGraphOutputContract.test.ts'],
      unknownReason: 'affected tests are illustrative until Core query path is connected',
    }),
    alembic_validation_plan: sampleValidationPlanResult(base, symbol, edge),
  };
}

function sampleValidationPlanResult(
  base: ReturnType<typeof sampleOperationBase>,
  symbol: ReturnType<typeof createSourceSymbolNode>,
  edge: ReturnType<typeof createSourceGraphEdge>
) {
  return createSourceGraphValidationPlanResult({
    ...base,
    changedFiles: ['lib/codex/mcp/source-graph/status.ts'],
    impactedFiles: [
      'lib/codex/mcp/source-graph/status.ts',
      'test/unit/McpSourceGraphOutputContract.test.ts',
    ],
    impactedSymbols: [symbol],
    edges: [edge],
    mustRun: [sampleMustRunRecommendation()],
    recommended: [sampleRecommendedRecommendation()],
    manualReview: [sampleManualReviewRecommendation()],
    unknown: [sampleUnknownRecommendation()],
  });
}

function sampleMustRunRecommendation() {
  return {
    kind: 'test-file' as const,
    label: 'Run source graph output contract tests',
    command: 'npm run test:unit -- test/unit/McpSourceGraphOutputContract.test.ts',
    filePath: 'test/unit/McpSourceGraphOutputContract.test.ts',
    reason: 'Changed source graph projection should keep clean output stable.',
    evidence: [
      {
        kind: 'changed-file' as const,
        ref: 'lib/codex/mcp/source-graph/status.ts',
        filePath: 'lib/codex/mcp/source-graph/status.ts',
        reason: 'Changed Plugin source graph runtime.',
      },
    ],
  };
}

function sampleRecommendedRecommendation() {
  return {
    kind: 'repo-command' as const,
    label: 'Run typecheck',
    command: 'npm run build:check',
    reason: 'TypeScript surface changed.',
    evidence: [
      {
        kind: 'repo-script' as const,
        ref: 'package.json#build:check',
        command: 'npm run build:check',
        reason: 'Repo script discovered by Core validation planner.',
      },
    ],
  };
}

function sampleManualReviewRecommendation() {
  return {
    kind: 'manual-review' as const,
    label: 'Review MCP clean-output contract',
    diagnosticCode: 'affected-tests-unknown' as const,
    reason: 'Validation plan cannot prove controller acceptance.',
    evidence: [
      {
        kind: 'diagnostic' as const,
        ref: 'affected-tests-unknown',
        diagnosticCode: 'affected-tests-unknown' as const,
        reason: 'Affected tests are advisory.',
      },
    ],
  };
}

function sampleUnknownRecommendation() {
  return {
    kind: 'unknown' as const,
    label: 'Unknown downstream host smoke',
    diagnosticCode: 'source-ref-unproven' as const,
    reason: 'Host smoke coverage is outside source graph proof.',
    evidence: [
      {
        kind: 'diagnostic' as const,
        ref: 'source-ref-unproven',
        diagnosticCode: 'source-ref-unproven' as const,
        reason: 'Source graph evidence is not acceptance evidence.',
      },
    ],
  };
}

function sampleOperationBase() {
  return {
    generationId: 'gen-1',
    projectRoot,
    repoId: 'plugin-repo',
    freshness,
    diagnostics: [
      {
        code: 'low-confidence-query' as const,
        message: 'query needs narrowing',
        metadata: { traceId: 'must-not-leak' },
      },
    ],
    detailRefs: [{ kind: 'source-section' as const, ref: 'source-section:1', label: 'status.ts' }],
  };
}

function sampleGraphFixtures() {
  const symbol = createSourceSymbolNode({
    generationId: 'gen-1',
    symbolId: 'symbol-1',
    displayName: 'resolveProjectRoot',
    qualifiedName: 'resolveProjectRoot',
    kind: 'function',
    filePath: 'lib/codex/mcp/source-graph/status.ts',
    range: { startLine: 1, startColumn: 1, endLine: 8, endColumn: 1 },
    metadata: { internal: 'must-not-leak' },
    provenance: { parser: 'must-not-leak' },
  });
  const caller = createSourceSymbolNode({
    generationId: 'gen-1',
    symbolId: 'symbol-caller',
    displayName: 'handleToolCall',
    kind: 'method',
    filePath: 'lib/codex/mcp/CodexMcpServer.ts',
    range: { startLine: 1, startColumn: 1, endLine: 10, endColumn: 1 },
    metadata: { internal: 'must-not-leak' },
  });
  const edge = createSourceGraphEdge({
    generationId: 'gen-1',
    edgeId: 'edge-1',
    kind: 'calls',
    fromSymbolId: 'symbol-caller',
    toSymbolId: 'symbol-1',
    site: { startLine: 5, startColumn: 3, endLine: 5, endColumn: 24 },
    provenance: 'deterministic',
    metadata: { internal: 'must-not-leak' },
  });
  const section = createSourceSection({
    filePath: 'lib/codex/mcp/source-graph/status.ts',
    startLine: 1,
    endLine: 8,
    text: 'export function buildSourceGraphStatus() {}',
    reason: 'symbol-context',
    freshness,
    symbolIds: ['symbol-1'],
    metadata: {
      internal: 'must-not-leak',
      overflow: true,
      originalStartLine: 1,
      originalEndLine: 12,
    },
  });
  return { caller, edge, section, symbol };
}
