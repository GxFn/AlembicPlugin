import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  codeGuardHandler,
  decisionRecordHandler,
  intentHandler,
  primeHandler,
  workFinishHandler,
  workStartHandler,
} from '../../lib/codex/mcp/handlers/agent-public-tools.js';
import type { McpContext } from '../../lib/codex/mcp/handlers/types.js';
import { createIdleIntent } from '../../lib/codex/mcp/handlers/types.js';
import { TOOLS } from '../../lib/codex/mcp/tools.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

function makeContext(
  search?: (intent: unknown, options?: unknown) => Promise<PrimeSearchResult | null>,
  services: Record<string, unknown> = {}
): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return search ? { search } : null;
        }
        if (name in services) {
          return services[name];
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
  test('registers all agent public tools with active schemas', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'alembic_intent',
        'alembic_prime',
        'alembic_work_start',
        'alembic_work_finish',
        'alembic_code_guard',
        'alembic_decision_record',
      ])
    );

    expect(
      TOOL_SCHEMAS.alembic_intent.safeParse({ userQuery: 'Implement public tools' }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_prime.safeParse({
        intentRef: 'intent-1',
        projectRoot: '/tmp/project',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_work_start.safeParse({
        title: 'Implement active work public tool',
      }).success
    ).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_work_finish.safeParse({
        changedFiles: ['lib/codex/mcp/handlers/agent-public-tools.ts'],
        workRef: 'work-public-1',
      }).success
    ).toBe(true);
    expect(TOOL_SCHEMAS.alembic_code_guard.safeParse({}).success).toBe(true);
    expect(
      TOOL_SCHEMAS.alembic_decision_record.safeParse({
        title: 'Decision register route required',
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

  test('starts and finishes work with workRef, finishRef, detailRefs, and scoped guard recommendation', async () => {
    const ctx = makeContext();
    const start = (await workStartHandler(ctx, {
      agentHost: 'codex',
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.93,
        language: 'typescript',
        query: 'Implement Stage 4 active work tool',
      },
      inputSource: 'host-declared-intent',
      title: 'Implement Stage 4 active work tool',
      workScope: {
        files: ['lib/codex/mcp/handlers/agent-public-tools.ts'],
        goal: 'Implement active work lifecycle',
      },
    })) as {
      data: {
        result: {
          legacyCompatibility: { usesLegacyTaskHandler: boolean };
          refs: { detailRefs: unknown[]; workRef: { id: string } };
          status: string;
        };
        workRef: string;
      };
      success: boolean;
    };

    expect(start.success).toBe(true);
    expect(start.data.result.status).toBe('ready');
    expect(start.data.result.refs.workRef.id).toBe(start.data.workRef);
    expect(start.data.result.refs.detailRefs).not.toHaveLength(0);
    expect(start.data.result.legacyCompatibility.usesLegacyTaskHandler).toBe(false);

    const finish = (await workFinishHandler(ctx, {
      changedFiles: ['lib/codex/mcp/handlers/agent-public-tools.ts'],
      evidenceRefs: ['test/unit/AgentPublicToolsActive.test.ts'],
      inputSource: 'host-declared-intent',
      summary: 'Implemented Stage 4 active work tool.',
      workRef: start.data.workRef,
    })) as {
      data: {
        finishRef: string;
        guardRecommendation: { action: string; input?: { files: string[] }; tool: string };
        result: {
          refs: { finishRef: { id: string }; workRef: { id: string } };
          status: string;
        };
      };
      success: boolean;
    };

    expect(finish.success).toBe(true);
    expect(finish.data.result.status).toBe('ready');
    expect(finish.data.result.refs.workRef.id).toBe(start.data.workRef);
    expect(finish.data.result.refs.finishRef.id).toBe(finish.data.finishRef);
    expect(finish.data.guardRecommendation).toMatchObject({
      action: 'run',
      tool: 'alembic_code_guard',
    });
    expect(finish.data.guardRecommendation.input?.files).toEqual(
      expect.arrayContaining(['lib/codex/mcp/handlers/agent-public-tools.ts'])
    );
  });

  test('blocks code guard without explicit files or inline code', async () => {
    const ctx = makeContext();
    const result = (await codeGuardHandler(ctx, {
      hostDeclaredIntent: {
        action: 'review',
        query: 'Run guard after work finish',
      },
      inputSource: 'host-declared-intent',
    })) as {
      data: { result: { reason: { code: string }; status: string } };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.result).toMatchObject({
      reason: { code: 'missing-guard-scope' },
      status: 'blocked',
    });
  });

  test('runs code guard only for explicit inline code scope', async () => {
    const checkCode = vi.fn(() => []);
    const ctx = makeContext(undefined, {
      guardCheckEngine: {
        auditFile: vi.fn(),
        auditFiles: vi.fn(),
        checkCode,
        injectExternalRules: vi.fn(),
        isEpInjected: () => true,
      },
    });

    const result = (await codeGuardHandler(ctx, {
      code: 'export const value = 1;',
      filePath: 'lib/example.ts',
      inputSource: 'host-declared-intent',
      language: 'typescript',
    })) as {
      data: {
        explicitScope: { filePath: string | null; kind: string };
        guardResultRef: string;
        result: { refs: { guardResultRef: { id: string } }; status: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(checkCode).toHaveBeenCalledWith('export const value = 1;', 'typescript');
    expect(result.data.explicitScope).toEqual({ filePath: 'lib/example.ts', kind: 'code' });
    expect(result.data.result.refs.guardResultRef.id).toBe(result.data.guardResultRef);
  });

  test('returns a durable persistence blocker for decision recording instead of writing a fake record', async () => {
    const ctx = makeContext();
    const result = (await decisionRecordHandler(ctx, {
      description: 'Stage 4 needs a durable Decision Register producer route.',
      inputSource: 'host-declared-intent',
      title: 'Decision Register producer route required',
    })) as {
      data: {
        durablePersistence: { available: boolean; requiredRoute: string };
        result: { reason: { code: string }; refs: { decisionRef?: unknown }; status: string };
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.result).toMatchObject({
      reason: { code: 'decision-register-unavailable' },
      status: 'blocked',
    });
    expect(result.data.result.refs.decisionRef).toBeUndefined();
    expect(result.data.durablePersistence).toMatchObject({
      available: false,
      requiredRoute: 'Alembic durable Decision Register Recipe route',
    });
  });

  test('does not import or call the legacy task handler', () => {
    const source = readFileSync(
      new URL('../../lib/codex/mcp/handlers/agent-public-tools.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('taskHandler');
    expect(source).not.toContain("from './task");
    expect(source).not.toContain('alembic_task');
    expect(source).not.toContain('routeGuardTool');
    expect(source).not.toContain('operation=prime');
  });
});
