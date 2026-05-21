import { describe, expect, test, vi } from 'vitest';
import { taskHandler } from '../../lib/external/mcp/handlers/task.js';
import type { McpContext } from '../../lib/external/mcp/handlers/types.js';
import { createIdleIntent } from '../../lib/external/mcp/handlers/types.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';

interface PrimeMaterial {
  status: 'delivered' | 'empty' | 'degraded';
  receiptId: string;
  acceptedKnowledge: Array<{
    id: string;
    kind: string;
    title: string;
    trigger: string;
    summary: string;
    score: number;
    evidenceRefs: Array<{ path: string; line: number | null }>;
  }>;
  acceptedGuards: Array<{
    id: string;
    title: string;
    trigger: string;
    score: number;
    evidenceRefs: Array<{ path: string; line: number | null }>;
  }>;
  shoutInstruction: string;
  hostResponse: {
    action: string;
    receiptId: string;
    status: 'delivered' | 'empty' | 'degraded';
    required: boolean;
  };
  nextActions: Array<{ tool: string; args: Record<string, unknown>; required: boolean }>;
}

interface PrimeEnvelope {
  success: boolean;
  message: string;
  data: {
    knowledge: {
      relatedKnowledge: PrimeSearchResult['relatedKnowledge'];
      guardRules: PrimeSearchResult['guardRules'];
    } | null;
    primeKnowledgeMaterial: PrimeMaterial;
    searchMeta: PrimeSearchResult['searchMeta'] | null;
  };
}

function makeContext(search: () => Promise<PrimeSearchResult | null>): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return { search };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
    session: {
      id: 'session-1',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

function makeContextWithoutPipeline(): McpContext {
  return {
    container: {
      get: vi.fn(() => null),
    },
    session: {
      id: 'session-1',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

describe('alembic_task prime knowledge material', () => {
  test('returns delivered primeKnowledgeMaterial with recipe, guard, and evidence refs', async () => {
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-1',
          title: 'Use codex plugin boundaries',
          trigger: '@codex-plugin-boundary',
          kind: 'pattern',
          language: 'typescript',
          score: 0.91,
          description: 'Keep Codex MCP wiring in the plugin layer.',
          actionHint: 'Use plugin adapter APIs instead of reintroducing agent runtime.',
          knowledgeType: 'code-standard',
          sourceRefs: ['lib/external/mcp/handlers/task.ts:42', 'lib/codex/StatusService.ts'],
        },
      ],
      guardRules: [
        {
          id: 'guard-1',
          title: 'Do not restore agent runtime',
          trigger: '@no-agent-runtime',
          kind: 'rule',
          language: 'typescript',
          score: 0.84,
          description: 'Plugin must not own agent runtime.',
          actionHint: 'Keep agent runtime out of AlembicPlugin.',
          sourceRefs: ['AGENTS.md:22'],
        },
      ],
      searchMeta: {
        queries: ['prime knowledge shout'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 2,
        filteredCount: 2,
      },
    };
    const result = (await taskHandler(
      makeContext(async () => searchResult),
      {
        operation: 'prime',
        userQuery: 'Add prime knowledge shout',
        activeFile: 'lib/external/mcp/handlers/task.ts',
        language: 'typescript',
      }
    )) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge?.relatedKnowledge).toEqual(searchResult.relatedKnowledge);
    expect(result.data.searchMeta).toEqual(searchResult.searchMeta);
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      acceptedKnowledge: [
        {
          id: 'recipe-1',
          kind: 'pattern',
          title: 'Use codex plugin boundaries',
          trigger: '@codex-plugin-boundary',
          summary: 'Keep Codex MCP wiring in the plugin layer.',
          score: 0.91,
          evidenceRefs: [
            { path: 'lib/external/mcp/handlers/task.ts', line: 42 },
            { path: 'lib/codex/StatusService.ts', line: null },
          ],
        },
      ],
      acceptedGuards: [
        {
          id: 'guard-1',
          title: 'Do not restore agent runtime',
          trigger: '@no-agent-runtime',
          score: 0.84,
          evidenceRefs: [{ path: 'AGENTS.md', line: 22 }],
        },
      ],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'tell the developer which Recipe and Guard knowledge prime delivered'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      required: true,
      status: 'delivered',
    });
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Codex must now tell the developer');
  });

  test('returns empty material when prime finds no matching recipes or guards', async () => {
    const result = (await taskHandler(
      makeContext(async () => null),
      {
        operation: 'prime',
        userQuery: 'Quick question',
      }
    )) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge).toBeNull();
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'empty',
      acceptedKnowledge: [],
      acceptedGuards: [],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'prime returned no matching Recipe or Guard knowledge'
    );
    expect(result.message).toContain('No matching recipes found.');
    expect(result.message).toContain('prime returned no usable project knowledge');
  });

  test('returns degraded material when the prime search pipeline is unavailable', async () => {
    const result = (await taskHandler(makeContextWithoutPipeline(), {
      operation: 'prime',
      userQuery: 'Implement something with project knowledge',
    })) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge).toBeNull();
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'degraded',
      acceptedKnowledge: [],
      acceptedGuards: [],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('prime degraded');
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      required: true,
      status: 'degraded',
    });
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Prime knowledge search degraded');
  });
});
