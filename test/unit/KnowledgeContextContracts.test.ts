import { describe, expect, test } from 'vitest';
import { KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/knowledge-context-tools/output.js';
import {
  createMcpStructuredToolResult,
  getMcpOutputProjector,
} from '../../lib/runtime/mcp/output-contract.js';
import {
  createKnowledgeContextMcpResult,
  KNOWLEDGE_CONTEXT_AGENT_HOSTS,
  KNOWLEDGE_CONTEXT_STATUSES,
  KnowledgeContextBaseInputSchema,
  KnowledgeContextMcpResultSchema,
  KnowledgeContextToolOutputSchema,
  KnowledgeSearchInputSchema,
  PrimeInputSchema,
  ProjectGraphInputSchema,
  ProjectMatrixInputSchema,
} from '../../lib/service/project-knowledge-context/contracts/index.js';

function sampleOutput(status: (typeof KNOWLEDGE_CONTEXT_STATUSES)[number]) {
  return {
    ok: status === 'ready' || status === 'partial',
    status,
    tool: 'alembic_project_matrix' as const,
    toolName: 'alembic_project_matrix' as const,
    operation: 'overview',
    summary: `Project matrix contract is ${status}.`,
    request: {
      query: 'summarize project knowledge context',
      detailLevel: 'summary' as const,
    },
    project: {
      projectRoot: '/workspace/project',
      name: 'project',
    },
    result: {
      matrixRef: `matrix:${status}`,
      nodeCount: 3,
    },
    inventory: {
      domains: ['project', 'knowledge', 'document'],
    },
    relations: [
      {
        fromId: 'project:root',
        toId: 'file:lib/index.ts',
        relationType: 'ownsFile',
      },
    ],
    items: [
      {
        id: 'file:lib/index.ts',
        kind: 'file',
      },
    ],
    detailRefs: [
      {
        id: `detail:${status}`,
        domain: 'project' as const,
        tool: 'alembic_project_matrix' as const,
        operation: 'overview',
        summary: 'Stable detail ref for budget-controlled follow-up data.',
        requiredForCompletion: true,
      },
    ],
    sources: [
      {
        domain: 'project' as const,
        id: 'project:current',
        detailRefId: `detail:${status}`,
        confidence: 0.9,
      },
    ],
    diagnostics:
      status === 'ready'
        ? []
        : [
            {
              code: `context-${status}`,
              severity: status === 'failed' ? ('error' as const) : ('warning' as const),
              message: `The ${status} branch keeps machine details in structuredContent.`,
              retryable: status === 'degraded',
            },
          ],
    nextActions: [
      {
        tool: 'alembic_search' as const,
        operation: 'search',
        reason: 'Search can expand detail refs without putting machine data in visible text.',
      },
    ],
    meta: {
      contractVersion: 1 as const,
      generatedAt: '2026-06-14T00:00:00Z',
    },
  };
}

describe('Project knowledge context four-tool contracts', () => {
  test('parses host-neutral base input without defaulting to a specific agent host', () => {
    const parsed = KnowledgeContextBaseInputSchema.parse({
      query: 'What project knowledge should guide this change?',
      inputSource: 'user-message',
      intentKind: 'implementation-task',
    });

    expect(parsed.agentHost).toBeUndefined();
    expect(KNOWLEDGE_CONTEXT_AGENT_HOSTS).toEqual([
      'codex',
      'claude-code',
      'generic-host-agent',
      'desktop-host-agent',
      'terminal-host-agent',
      'automation-host-agent',
    ]);
    expect(KNOWLEDGE_CONTEXT_AGENT_HOSTS).toContain('generic-host-agent');
  });

  test('parses valid inputs for the four public knowledge context tools', () => {
    expect(
      ProjectMatrixInputSchema.parse({
        projectRoot: '/workspace/project',
        operation: 'overview',
        query: 'map active project context',
        budget: { itemLimit: 10, detailLimit: 5 },
      })
    ).toMatchObject({
      operation: 'overview',
      detailLevel: 'summary',
    });

    expect(
      PrimeInputSchema.parse({
        operation: 'matrix-first',
        recognizedIntent: {
          query: 'Implement a focused contract boundary',
          action: 'implementation',
          confidence: 0.86,
        },
        primeMode: 'working-set',
      })
    ).toMatchObject({
      operation: 'matrix-first',
      primeMode: 'working-set',
    });

    expect(
      KnowledgeSearchInputSchema.parse({
        operation: 'get',
        mode: 'semantic',
        refId: 'knowledge:contract-boundary',
        kind: 'guide',
      })
    ).toMatchObject({
      operation: 'get',
      kind: 'guide',
    });

    expect(KnowledgeSearchInputSchema.safeParse({ query: 'x', mode: 'auto' }).success).toBe(true);
    expect(KnowledgeSearchInputSchema.safeParse({ query: 'x', mode: 'keyword' }).success).toBe(
      true
    );
    expect(KnowledgeSearchInputSchema.safeParse({ query: 'x', mode: 'semantic' }).success).toBe(
      true
    );
    expect(KnowledgeSearchInputSchema.safeParse({ query: 'x', mode: 'unsupported-mode' }).success)
      .toBe(false);
    expect(KnowledgeSearchInputSchema.safeParse({ query: 'x', mode: 'legacy-mode' }).success).toBe(
      false
    );

    expect(
      ProjectGraphInputSchema.parse({
        operation: 'neighborhood',
        nodeId: 'file:lib/service/project.ts',
        nodeType: 'file',
        relationType: 'ownsFile',
        maxDepth: 3,
      })
    ).toMatchObject({
      operation: 'neighborhood',
      nodeType: 'file',
      relationType: 'ownsFile',
    });
  });

  test('rejects lifecycle operations from the four-tool knowledge context surface', () => {
    expect(KnowledgeSearchInputSchema.safeParse({ operation: 'confirm_usage' }).success).toBe(
      false
    );
    expect(ProjectMatrixInputSchema.safeParse({ operation: 'stage_acceptance' }).success).toBe(
      false
    );
    expect(PrimeInputSchema.safeParse({ operation: 'start_work' }).success).toBe(false);
    expect(ProjectGraphInputSchema.safeParse({ operation: 'knowledge_lifecycle' }).success).toBe(
      false
    );
  });

  test('rejects non-project graph node types from alembic_graph input', () => {
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'recipe' }).success).toBe(false);
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'recipeRelation' }).success).toBe(false);
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'file' }).success).toBe(true);
  });

  test('accepts hostDeclaredIntent on alembic_graph with the shared MCP intent shape', () => {
    const parsed = ProjectGraphInputSchema.parse({
      hostDeclaredIntent: {
        action: 'review',
        confidence: 0.8,
        goal: 'Inspect project graph boundary',
        keywords: ['ProjectContext'],
        labels: ['graph'],
        language: 'typescript',
        module: 'ProjectGraphProvider',
        query: 'ProjectContext direct graph boundary',
        scenario: 'boundary-review',
        source: 'codex',
        sourceRefs: ['host:intent'],
        summary: 'Review graph direct boundary',
      },
      operation: 'query',
    });

    expect(parsed.hostDeclaredIntent?.query).toBe('ProjectContext direct graph boundary');
    expect(parsed.hostDeclaredIntent?.summary).toBe('Review graph direct boundary');
    expect(parsed.hostDeclaredIntent?.sourceRefs).toEqual(['host:intent']);
  });

  test('accepts hostDeclaredIntent on alembic_project_matrix with the shared MCP intent shape', () => {
    const parsed = ProjectMatrixInputSchema.parse({
      hostDeclaredIntent: {
        action: 'inspect',
        confidence: 0.75,
        goal: 'Inspect ProjectContext matrix output limits',
        keywords: ['ProjectContext', 'matrix'],
        labels: ['schema'],
        language: 'typescript',
        module: 'KnowledgeContextOutputProjector',
        query: 'ProjectContext matrix diagnostics budget',
        scenario: 'schema-repair',
        source: 'codex',
        sourceRefs: ['host:intent'],
        summary: 'Review matrix schema repair',
      },
      operation: 'overview',
    });

    expect(parsed.hostDeclaredIntent?.query).toBe('ProjectContext matrix diagnostics budget');
    expect(parsed.hostDeclaredIntent?.goal).toBe('Inspect ProjectContext matrix output limits');
    expect(parsed.hostDeclaredIntent?.keywords).toEqual(['ProjectContext', 'matrix']);
  });

  test('registers alembic_graph as a knowledge context clean-output tool', () => {
    expect(KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES).toEqual([
      'alembic_project_matrix',
      'alembic_search',
      'alembic_graph',
    ]);
    expect(getMcpOutputProjector('alembic_graph')).toMatchObject({
      outputSchemaName: 'alembic_graph_clean_output',
      projectorName: 'knowledge-context-clean-output-projector',
    });
  });

  test('accepts all five knowledge context output statuses', () => {
    for (const status of KNOWLEDGE_CONTEXT_STATUSES) {
      const parsed = KnowledgeContextToolOutputSchema.parse(sampleOutput(status));

      expect(parsed.status).toBe(status);
      expect(parsed.detailRefs[0]?.id).toBe(`detail:${status}`);
      expect(parsed.sources[0]?.domain).toBe('project');
      expect(parsed.meta).toMatchObject({
        contractVersion: 1,
        outputSchema: 'KnowledgeContextToolOutput',
      });
    }
  });

  test('keeps MCP visible content summary-only and machine data in structuredContent', () => {
    const output = KnowledgeContextToolOutputSchema.parse(sampleOutput('ready'));
    const result = createKnowledgeContextMcpResult(output);

    expect(result.content).toEqual([{ type: 'text', text: output.summary }]);
    expect(result.structuredContent).toMatchObject({
      result: { matrixRef: 'matrix:ready', nodeCount: 3 },
      detailRefs: [{ id: 'detail:ready' }],
      items: [{ id: 'file:lib/index.ts' }],
    });
    expect(JSON.stringify(result.content)).not.toContain('matrix:ready');

    expect(
      KnowledgeContextMcpResultSchema.safeParse({
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }).success
    ).toBe(false);
  });

  test('serializes knowledge context meta through the shared clean MCP envelope', () => {
    const output = KnowledgeContextToolOutputSchema.parse({
      ...sampleOutput('ready'),
      meta: {
        contractVersion: 1,
        generatedAt: '2026-06-14T00:00:00Z',
        producer: 'ProjectKnowledgeContextLayer',
        traceRef: 'trace:knowledge-context',
      },
    });

    const result = createMcpStructuredToolResult(output);

    expect(result.structuredContent?.meta).toMatchObject({
      contractVersion: 1,
      generatedAt: '2026-06-14T00:00:00Z',
      producer: 'ProjectKnowledgeContextLayer',
      traceRef: 'trace:knowledge-context',
    });
    expect(result.content).toEqual([{ type: 'text', text: output.summary }]);
  });
});
