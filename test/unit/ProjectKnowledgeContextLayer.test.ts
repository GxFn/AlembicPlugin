import { describe, expect, test } from 'vitest';
import {
  ContextCache,
  createContextIndexSnapshot,
  defaultResultRanker,
  isContextIndexSnapshotSourceOfTruth,
  KnowledgeContextInputNormalizer,
  type KnowledgeContextToolOutput,
  ProjectKnowledgeContextLayer,
  RetrievalPlanner,
} from '../../lib/service/project-knowledge-context/index.js';

function readResult(output: KnowledgeContextToolOutput) {
  return output.result as {
    route?: string;
    truncated?: {
      content?: boolean;
      detailRefs?: boolean;
      items?: boolean;
      matrixNodes?: boolean;
      nextActions?: boolean;
      relations?: boolean;
    };
    retrievalTrace?: {
      degradedReasons?: string[];
      domains?: string[];
      truncatedByBudget?: string[];
    };
    matrixNodes?: unknown[];
  };
}

describe('ProjectKnowledgeContextLayer support layer foundation', () => {
  test('normalizes four-tool input through the K1 shared contracts', () => {
    const normalizer = new KnowledgeContextInputNormalizer();
    const normalized = normalizer.normalize('alembic_search', {
      budget: { detailLimit: 2, itemLimit: 3 },
      freshnessPolicy: { policy: 'requireFresh' },
      inputSource: 'user-message',
      intentKind: 'read-only-analysis',
      operation: 'search',
      query: 'project knowledge context contracts',
      sourceRefs: ['knowledge:contract'],
    });

    expect(normalized).toMatchObject({
      tool: 'alembic_search',
      operation: 'search',
      query: 'project knowledge context contracts',
      inputSource: 'user-message',
      intentKind: 'read-only-analysis',
      detailLevel: 'summary',
      budget: {
        detailLimit: 2,
        itemLimit: 3,
      },
      freshnessPolicy: {
        policy: 'requireFresh',
      },
      sourceRefs: ['knowledge:contract'],
    });
    expect(normalized.rawInput.tool).toBe('alembic_search');
  });

  test('builds a rebuildable derived ContextIndexSnapshot instead of a source of truth', () => {
    const normalizer = new KnowledgeContextInputNormalizer();
    const normalized = normalizer.normalize('alembic_project_matrix', {
      activeFile: 'lib/service/project.ts',
      budget: { matrixNodeLimit: 2 },
      operation: 'overview',
      projectRoot: '/workspace/project',
      sourceGraphRef: 'source-graph:current',
    });
    const snapshot = createContextIndexSnapshot(normalized, {
      projectNodes: [
        { id: 'project:/workspace/project', label: 'project', type: 'project' },
        { id: 'file:a.ts', label: 'a.ts', type: 'file' },
        { id: 'file:b.ts', label: 'b.ts', type: 'file' },
      ],
    });
    const secondSnapshot = createContextIndexSnapshot(normalized);

    expect(snapshot).toMatchObject({
      derivedView: true,
      rebuildable: true,
      sourceOfTruth: false,
      projectMap: {
        nodeCount: 3,
        truncated: true,
      },
    });
    expect(snapshot.projectMap.nodes).toHaveLength(2);
    expect(isContextIndexSnapshotSourceOfTruth(snapshot)).toBe(false);
    expect(snapshot.detailRefs[0]?.id).toBe(secondSnapshot.detailRefs[0]?.id);
  });

  test('selects matrix-first, search-first, graph-first, and prime-orchestrated routes', () => {
    const normalizer = new KnowledgeContextInputNormalizer();
    const planner = new RetrievalPlanner();

    const matrixInput = normalizer.normalize('alembic_project_matrix', { operation: 'overview' });
    expect(planner.plan(matrixInput, createContextIndexSnapshot(matrixInput)).route).toBe(
      'matrix-first'
    );

    const searchInput = normalizer.normalize('alembic_search', {
      operation: 'search',
      query: 'contract',
    });
    expect(planner.plan(searchInput, createContextIndexSnapshot(searchInput)).route).toBe(
      'search-first'
    );

    const graphInput = normalizer.normalize('alembic_graph', {
      nodeId: 'file:lib/index.ts',
      nodeType: 'file',
      operation: 'impact',
    });
    expect(planner.plan(graphInput, createContextIndexSnapshot(graphInput)).route).toBe(
      'graph-first'
    );

    const primeInput = normalizer.normalize('alembic_prime', {
      operation: 'auto',
      query: 'prepare implementation context',
    });
    expect(planner.plan(primeInput, createContextIndexSnapshot(primeInput)).route).toBe(
      'prime-orchestrated'
    );
  });

  test('projects summary-only MCP content while keeping machine data in structuredContent', () => {
    const layer = new ProjectKnowledgeContextLayer();
    const result = layer.resolveMcpResult(
      'alembic_project_matrix',
      {
        budget: { detailLimit: 1, itemLimit: 1, matrixNodeLimit: 1, nextActionLimit: 1 },
        operation: 'overview',
        query: 'map project',
      },
      {
        payload: {
          items: [
            { id: 'item-1', title: 'first' },
            { id: 'item-2', title: 'second' },
          ],
          nextActions: [
            {
              tool: 'alembic_search',
              operation: 'expand',
              reason: 'Expand the first result.',
            },
            {
              tool: 'alembic_graph',
              operation: 'neighborhood',
              reason: 'Inspect the structure.',
            },
          ],
        },
        snapshot: {
          projectNodes: [
            { id: 'node-1', label: 'one', type: 'file' },
            { id: 'node-2', label: 'two', type: 'file' },
          ],
        },
      }
    );
    const structured = result.structuredContent as KnowledgeContextToolOutput;
    const projected = readResult(structured);

    expect(result.content).toEqual([{ type: 'text', text: structured.summary }]);
    expect(JSON.stringify(result.content)).not.toContain('item-2');
    expect(structured.items).toHaveLength(1);
    expect(structured.nextActions).toHaveLength(1);
    expect(projected.matrixNodes).toHaveLength(1);
    expect(projected.truncated).toMatchObject({
      items: true,
      matrixNodes: true,
      nextActions: true,
    });
    expect(structured.status).toBe('partial');
  });

  test('applies content text budget to summary and structured text fields', () => {
    const layer = new ProjectKnowledgeContextLayer();
    const longText = `content-budget-start ${'x'.repeat(180)} content-budget-tail`;
    const result = layer.resolveMcpResult(
      'alembic_search',
      {
        budget: { contentCharLimit: 120, detailLimit: 5, itemLimit: 5, nextActionLimit: 2 },
        operation: 'search',
        query: 'budget text content',
      },
      {
        payload: {
          detailRefs: [
            {
              domain: 'knowledge',
              id: 'knowledge:detail-long',
              summary: longText,
              title: longText,
            },
          ],
          items: [
            {
              contentPreview: longText,
              id: 'item-1',
              nested: { content: longText },
              summary: longText,
              title: longText,
            },
          ],
          nextActions: [
            {
              operation: 'expand',
              reason: longText,
              tool: 'alembic_search',
            },
          ],
          relations: [{ description: longText, id: 'relation-1' }],
          result: { content: longText, summary: longText },
          summary: longText,
        },
      }
    );
    const structured = result.structuredContent as KnowledgeContextToolOutput;
    const projected = readResult(structured);
    const item = structured.items?.[0] as {
      contentPreview?: string;
      nested?: { content?: string };
      summary?: string;
      title?: string;
    };
    const payloadResult = structured.result as { content?: string; summary?: string };

    expect(result.content).toEqual([{ type: 'text', text: structured.summary }]);
    expect(structured.summary.length).toBeLessThanOrEqual(120);
    expect(structured.summary).not.toContain('content-budget-tail');
    expect(JSON.stringify(result.content)).not.toContain('content-budget-tail');
    expect(item.summary?.length).toBeLessThanOrEqual(120);
    expect(item.contentPreview?.length).toBeLessThanOrEqual(120);
    expect(item.nested?.content?.length).toBeLessThanOrEqual(120);
    expect(structured.detailRefs.every((ref) => ref.summary.length <= 120)).toBe(true);
    expect(structured.nextActions[0]?.reason.length).toBeLessThanOrEqual(120);
    expect(payloadResult.content?.length).toBeLessThanOrEqual(120);
    expect(payloadResult.summary?.length).toBeLessThanOrEqual(120);
    expect(projected.truncated).toMatchObject({ content: true });
    expect(structured.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'budget-truncated-content',
        severity: 'info',
      })
    );
    expect(structured.status).toBe('partial');
  });

  test('keeps freshness degraded diagnostics separated by source domain', () => {
    const layer = new ProjectKnowledgeContextLayer();
    const output = layer.resolveProjectGraph(
      {
        nodeId: 'file:lib/index.ts',
        nodeType: 'file',
        operation: 'impact',
      },
      {
        snapshot: {
          domainFreshness: {
            knowledge: { state: 'ready' },
            sourceGraph: {
              degradedReason: 'Source graph catch-up is pending.',
              state: 'stale',
            },
          },
        },
      }
    );
    const projected = readResult(output);

    expect(output.status).toBe('degraded');
    expect(output.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'freshness-sourceGraph-stale',
        domain: 'sourceGraph',
      })
    );
    expect(projected.retrievalTrace?.domains).toEqual(['project', 'sourceGraph']);
    expect(projected.retrievalTrace?.degradedReasons).toContain('sourceGraph:stale');
  });

  test('provides support primitives for cache and deterministic ranking', () => {
    const cache = new ContextCache<{ value: string }>();
    const entry = cache.set('context:snapshot', { value: 'derived' }, '2026-06-14T00:00:00Z');
    const ranked = defaultResultRanker.rank([
      { id: 'b', score: 0.5 },
      { id: 'a', score: 0.9 },
      { id: 'c', score: 0.5 },
    ]);

    expect(entry).toMatchObject({
      derivedView: true,
      key: 'context:snapshot',
      value: { value: 'derived' },
    });
    expect(cache.get('context:snapshot')).toBe(entry);
    expect(ranked.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
