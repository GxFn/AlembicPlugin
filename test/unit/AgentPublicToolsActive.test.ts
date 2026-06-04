import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { intentHandler, primeHandler } from '../../lib/codex/mcp/handlers/agent-public-tools.js';
import type { McpContext } from '../../lib/codex/mcp/handlers/types.js';
import { createIdleIntent } from '../../lib/codex/mcp/handlers/types.js';
import { TOOLS } from '../../lib/codex/mcp/tools.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

function makeContext(
  search?: (intent: unknown, options?: unknown) => Promise<PrimeSearchResult | null>
): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return search ? { search } : null;
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
    session: {
      id: 'session-public-tools',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

function deliveredSearchResult(): PrimeSearchResult {
  return {
    guardRules: [
      {
        actionHint: 'Keep Plugin-owned Codex MCP boundaries.',
        description: 'Do not route Codex public tools through legacy task operations.',
        id: 'guard-public-api',
        kind: 'rule',
        language: 'typescript',
        score: 0.86,
        sourceRefs: ['lib/codex/mcp/handlers/agent-public-tools.ts:42'],
        title: 'Keep public tools Plugin-owned',
        trigger: '@plugin-public-tools',
      },
    ],
    relatedKnowledge: [
      {
        actionHint: 'Use structure-first Recipe retrieval.',
        description: 'Prime should search with extracted structure and host intent context.',
        id: 'recipe-public-prime',
        kind: 'pattern',
        language: 'typescript',
        score: 0.92,
        sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:112'],
        title: 'Agent public prime',
        trigger: '@agent-public-prime',
      },
    ],
    searchMeta: {
      filteredCount: 2,
      language: 'typescript',
      module: 'codex/mcp',
      queries: ['Implement public prime active tool'],
      resultCount: 2,
      scenario: 'generate',
      residentSearch: {
        attempted: true,
        available: true,
        route: 'alembic-resident-service',
        semanticUsed: true,
        vectorUsed: true,
        residentVector: { available: true },
      },
    },
  };
}

describe('agent-facing active public tools', () => {
  test('registers alembic_intent and alembic_prime with active schemas', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('alembic_intent');
    expect(names).toContain('alembic_prime');

    expect(
      TOOL_SCHEMAS.alembic_intent.safeParse({ userQuery: 'Implement public tools' }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        intentRef: 'intent-1',
        projectRoot: '/tmp/project',
      }).success
    ).toBe(true);
  });

  test('captures a host-declared intent with intentRef, detailRefs, and vectorPlan', async () => {
    const ctx = makeContext();
    const result = (await intentHandler(ctx, {
      agentHost: 'codex',
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.91,
        language: 'typescript',
        query: 'Implement public prime active tool',
        sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage0.md'],
      },
      inputSource: 'host-declared-intent',
      language: 'typescript',
      sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage0.md'],
    })) as {
      data: {
        detailRefs: Array<{ kind: string; uri?: string }>;
        intentRef: string;
        recognizedIntent: { query: string; status: string };
        result: { legacyCompatibility: { usesLegacyTaskHandler: boolean }; status: string };
        vectorPlan: { route: string; queries: string[] };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.result.status).toBe('ready');
    expect(result.data.intentRef).toMatch(/^intent-/);
    expect(result.data.recognizedIntent).toMatchObject({
      query: 'Implement public prime active tool',
      status: 'recognized',
    });
    expect(result.data.detailRefs.map((ref) => ref.kind)).toEqual(
      expect.arrayContaining(['contract', 'file', 'schema', 'source-ref'])
    );
    expect(result.data.vectorPlan).toMatchObject({
      route: 'structure-first-recipe-retrieval',
    });
    expect(result.data.result.legacyCompatibility.usesLegacyTaskHandler).toBe(false);
  });

  test('primes from an intentRef using PrimeSearchPipeline and Trust Receipt material', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const ctx = makeContext(search);
    const intent = (await intentHandler(ctx, {
      agentHost: 'codex',
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.9,
        language: 'typescript',
        query: 'Implement public prime active tool',
      },
      inputSource: 'host-declared-intent',
    })) as { data: { intentRef: string } };

    const result = (await primeHandler(ctx, {
      agentHost: 'codex',
      inputSource: 'host-declared-intent',
      intentRef: intent.data.intentRef,
      projectRoot: '/tmp/alembic-plugin-public-tools',
    })) as {
      data: {
        primeKnowledgeMaterial: {
          acceptedGuards: unknown[];
          acceptedKnowledge: unknown[];
          hostResponse: { requiredBeforeNextAction: boolean };
          status: string;
          trustPosture: { receiptChecklist: Array<{ layer: string; items: unknown[] }> };
        };
        primePackage: { trustReceipt: { receiptId: string; status: string } };
        result: {
          refs: { intentRef: { id: string }; primeRef: { id: string }; detailRefs: unknown[] };
          status: string;
        };
      };
      success: boolean;
    };

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data.result.status).toBe('ready');
    expect(result.data.result.refs.intentRef.id).toBe(intent.data.intentRef);
    expect(result.data.result.refs.primeRef.id).toMatch(/^prime-public-/);
    expect(result.data.result.refs.detailRefs).not.toHaveLength(0);
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      hostResponse: { requiredBeforeNextAction: true },
    });
    expect(result.data.primeKnowledgeMaterial.acceptedKnowledge).toHaveLength(1);
    expect(result.data.primeKnowledgeMaterial.acceptedGuards).toHaveLength(1);
    expect(result.data.primeKnowledgeMaterial.trustPosture.receiptChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'trusted-to-obey' }),
        expect.objectContaining({ layer: 'trusted-to-use' }),
        expect.objectContaining({ layer: 'requires-verification' }),
      ])
    );
    expect(result.data.primePackage.trustReceipt.receiptId).toMatch(/^prime-/);
  });

  test('skips raw automation intent and blocks automation prime without sourceRefs', async () => {
    const ctx = makeContext(async () => deliveredSearchResult());
    const intent = (await intentHandler(ctx, {
      inputSource: 'automation-envelope',
      userQuery: '<codex_delegation><input>继续当前窗口任务</input></codex_delegation>',
    })) as { data: { result: { reason: { code: string }; status: string } } };

    expect(intent.data.result).toMatchObject({
      reason: { code: 'mechanical-envelope-only' },
      status: 'skipped',
    });

    const blockedPrime = (await primeHandler(ctx, {
      hostDeclaredIntent: {
        action: 'implement',
        query: 'Implement public prime active tool',
      },
      inputSource: 'automation-envelope',
      projectRoot: '/tmp/alembic-plugin-public-tools',
    })) as { data: { result: { reason: { code: string }; status: string } }; success: boolean };

    expect(blockedPrime.success).toBe(false);
    expect(blockedPrime.data.result).toMatchObject({
      reason: { code: 'missing-referenced-docs' },
      status: 'blocked',
    });
  });

  test('returns degraded prime when retrieval finds no Recipe or Guard knowledge', async () => {
    const ctx = makeContext(async () => null);
    const result = (await primeHandler(ctx, {
      hostDeclaredIntent: {
        action: 'review',
        query: 'Review public prime active tool',
      },
      inputSource: 'host-declared-intent',
      projectRoot: '/tmp/alembic-plugin-public-tools',
      sourceRefs: ['workspace-ledger/AlembicPlugin/afapi-stage3.md'],
    })) as {
      data: {
        primeKnowledgeMaterial: { status: string };
        result: { reason: { code: string }; status: string };
      };
    };

    expect(result.data.result).toMatchObject({
      reason: { code: 'knowledge-empty' },
      status: 'degraded',
    });
    expect(result.data.primeKnowledgeMaterial.status).toBe('empty');
  });

  test('does not import or call the legacy task handler', () => {
    const source = readFileSync(
      new URL('../../lib/codex/mcp/handlers/agent-public-tools.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('taskHandler');
    expect(source).not.toContain("from './task");
    expect(source).not.toContain('alembic_task');
    expect(source).not.toContain('operation=prime');
  });
});
