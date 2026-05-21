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
    timing: 'immediate_after_prime';
    required: boolean;
    requiredBeforeNextAction: boolean;
    visibility: 'developer_visible';
    reason: string;
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
      'Immediately after this prime tool result'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'short, active knowledge receipt'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Use Codex/first-person as the speaker'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'what I accepted or what Codex received'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'accepted Recipe and Guard constraints'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'do not list evidenceRefs paths or line numbers by default'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Keep evidenceRefs for your later code reading'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).not.toContain(
      'Cite evidenceRefs as path:line'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).not.toContain(
      'line number is missing'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'delivered',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain('As Codex');
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain(
      'do not make Alembic prime'
    );
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Codex must immediately shout');
    expect(result.message).toContain('short knowledge receipt');
    expect(result.message).toContain('Speak as Codex or I');
    expect(result.message).toContain('not as Alembic prime');
    expect(result.message).toContain('keep evidenceRefs in the payload');
    expect(result.message).not.toContain('📍');
    expect(result.message).not.toContain('lib/external/mcp/handlers/task.ts:42');
    expect(result.message).not.toContain('Alembic prime has received');
    expect(result.message).not.toContain('Alembic prime received');
    expect(result.message).toContain('before any further tool call');
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
      'I did not receive matching Recipe or Guard knowledge'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('shout a clear receipt');
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'empty',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(result.message).toContain('No matching recipes found.');
    expect(result.message).toContain('it did not receive usable project knowledge');
    expect(result.message).toContain('Do not make Alembic prime');
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
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'I did not receive usable project knowledge because prime degraded'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('shout a clear receipt');
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'degraded',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Prime knowledge search degraded');
  });
});
