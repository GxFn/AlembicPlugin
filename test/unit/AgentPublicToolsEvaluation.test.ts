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
import type { AgentPublicToolName } from '../../lib/codex/mcp/public-tools/contract.js';
import {
  AGENT_PUBLIC_TOOL_NAMES,
  AgentPublicToolResultEnvelopeSchema,
  getAgentPublicToolContractDefinition,
  getAgentPublicToolDescriptionBase,
} from '../../lib/codex/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/codex/mcp/tools.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const forbiddenLegacyPrimaryWording = [
  'operation=prime',
  'operation=create',
  'operation=close',
  'Task and decision management (5 operations)',
  'primary action is `alembic_task`',
];

const goldenPublicToolMatrix = {
  alembic_intent: {
    acceptedRefs: ['detailRefs'],
    producedRefs: ['intentRef', 'detailRefs'],
    purposeFragment: 'Normalize host-declared intent',
    requiredFields: ['agentHost', 'inputSource'],
    schemaInput: { inputSource: 'host-declared-intent', userQuery: 'Evaluate Stage 6' },
    title: 'Normalize agent intent',
  },
  alembic_prime: {
    acceptedRefs: ['intentRef', 'detailRefs'],
    producedRefs: ['primeRef', 'detailRefs'],
    purposeFragment: 'Load compact, trust-labeled project knowledge',
    requiredFields: ['agentHost', 'inputSource', 'intentRef'],
    schemaInput: {
      inputSource: 'host-declared-intent',
      intentRef: 'intent-public-stage6',
      projectRoot: '/tmp/alembic-plugin-stage6',
    },
    title: 'Prime agent context',
  },
  alembic_work_start: {
    acceptedRefs: ['intentRef', 'primeRef', 'detailRefs'],
    producedRefs: ['workRef', 'detailRefs'],
    purposeFragment: 'Create a workRef',
    requiredFields: ['agentHost', 'inputSource', 'intentRef'],
    schemaInput: {
      inputSource: 'host-declared-intent',
      intentRef: 'intent-public-stage6',
      title: 'Evaluate Stage 6',
      workScope: { goal: 'Close evaluation gap' },
    },
    title: 'Start tracked work',
  },
  alembic_work_finish: {
    acceptedRefs: ['intentRef', 'primeRef', 'workRef', 'detailRefs'],
    producedRefs: ['workRef', 'finishRef', 'detailRefs'],
    purposeFragment: 'Close a workRef',
    requiredFields: ['agentHost', 'inputSource', 'workRef'],
    schemaInput: {
      changedFiles: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      inputSource: 'host-declared-intent',
      summary: 'Evaluation completed',
      workRef: 'work-public-stage6',
    },
    title: 'Finish tracked work',
  },
  alembic_code_guard: {
    acceptedRefs: ['intentRef', 'workRef', 'detailRefs'],
    producedRefs: ['guardResultRef', 'detailRefs'],
    purposeFragment: 'Run a code guard pass',
    requiredFields: ['agentHost', 'inputSource'],
    schemaInput: {
      code: 'export const stage6 = true;',
      filePath: 'test/unit/AgentPublicToolsEvaluation.test.ts',
      inputSource: 'host-declared-intent',
      language: 'typescript',
    },
    title: 'Check code against project rules',
  },
  alembic_decision_record: {
    acceptedRefs: ['intentRef', 'workRef', 'detailRefs'],
    producedRefs: ['decisionRef', 'detailRefs'],
    purposeFragment: 'Create, update, read, list, revoke, or delete',
    requiredFields: ['agentHost', 'inputSource'],
    schemaInput: {
      description: 'Stage 6 evaluation proves public tools remain coherent.',
      inputSource: 'host-declared-intent',
      title: 'Close public tools evaluation',
    },
    title: 'Record agent decision',
  },
} as const satisfies Record<
  AgentPublicToolName,
  {
    acceptedRefs: readonly string[];
    producedRefs: readonly string[];
    purposeFragment: string;
    requiredFields: readonly string[];
    schemaInput: Record<string, unknown>;
    title: string;
  }
>;

describe('AFAPI Stage 6 agent-facing public tools evaluation', () => {
  test('locks golden descriptions, contracts, schemas, and non-legacy primary guidance', () => {
    const activeToolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

    for (const toolName of AGENT_PUBLIC_TOOL_NAMES) {
      const golden = goldenPublicToolMatrix[toolName];
      const description = getAgentPublicToolDescriptionBase(toolName);
      const activeTool = activeToolsByName.get(toolName);
      const contract = getAgentPublicToolContractDefinition(toolName);

      expect(description.title).toBe(golden.title);
      expect(description.purpose).toContain(golden.purposeFragment);
      expect(description.selectionHint).toMatch(/\S/);
      expect(description.nonGoal).toMatch(/\S/);
      expect(activeTool?.description).toContain(description.title);
      expect(activeTool?.description).toContain(description.purpose);
      expect(activeTool?.description).toContain(description.selectionHint);
      expect(activeTool?.description).toContain(`Non-goal: ${description.nonGoal}`);

      expect(contract.activeMcpSurface).toBe(true);
      expect(contract.handlerDependency).toBe('McpServer.agent-public-tools');
      expect(contract.inputContract.acceptedRefs).toEqual(golden.acceptedRefs);
      expect(contract.inputContract.requiredFields).toEqual(golden.requiredFields);
      expect(contract.resultContract.producesRefs).toEqual(golden.producedRefs);
      expect(TOOL_SCHEMAS[toolName].safeParse(golden.schemaInput).success).toBe(true);

      for (const forbidden of forbiddenLegacyPrimaryWording) {
        expect(
          activeTool?.description ?? '',
          `${toolName} should not advertise ${forbidden}`
        ).not.toContain(forbidden);
      }
    }
  });

  test('evaluates ready handler envelopes for six public tools with refs and compact budgets', async () => {
    const ctx = makeContext(async () => deliveredSearchResult(), {
      guardCheckEngine: {
        auditFile: vi.fn(),
        auditFiles: vi.fn(),
        checkCode: vi.fn(() => []),
        injectExternalRules: vi.fn(),
        isEpInjected: () => true,
      },
      residentDecisionRegisterClient: {
        decisionRegister: vi.fn(async (request: Record<string, unknown>) => ({
          ok: true,
          status: { owner: 'alembic', route: 'local-alembic-daemon' },
          value: {
            action: request.action,
            capability: durableDecisionCapability(),
            decision: {
              decisionId: 'decision-stage6-ready',
              status: 'active',
              title: 'Close public tools evaluation',
            },
          },
        })),
      },
    });

    const intent = await callPublicTool(intentHandler(ctx, stage6IntentArgs(220)));
    const intentRef = stringFrom(intent.raw, ['data', 'intentRef']);
    expect(intent.envelope).toMatchObject({
      actionKind: 'intent',
      refs: { intentRef: { id: intentRef } },
      status: 'ready',
      toolName: 'alembic_intent',
    });

    const prime = await callPublicTool(
      primeHandler(ctx, {
        inputSource: 'host-declared-intent',
        intentRef,
        outputBudget: { maxChars: 240, mode: 'compact' },
        projectRoot: '/tmp/alembic-plugin-stage6',
      })
    );
    const primeRef = stringFrom(prime.raw, ['data', 'result', 'refs', 'primeRef', 'id']);
    expect(prime.envelope).toMatchObject({
      actionKind: 'prime',
      refs: { intentRef: { id: intentRef }, primeRef: { id: primeRef } },
      status: 'ready',
      toolName: 'alembic_prime',
    });

    const workStart = await callPublicTool(
      workStartHandler(ctx, {
        inputSource: 'host-declared-intent',
        intentRef,
        outputBudget: { maxChars: 180, mode: 'compact' },
        primeRef,
        title: 'Evaluate public tools closure',
        workScope: {
          files: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
          goal: 'Close Stage 6 evaluation evidence.',
        },
      })
    );
    const workRef = stringFrom(workStart.raw, ['data', 'workRef']);
    expect(workStart.envelope).toMatchObject({
      actionKind: 'work-start',
      refs: { primeRef: { id: primeRef }, workRef: { id: workRef } },
      status: 'ready',
      toolName: 'alembic_work_start',
    });

    const workFinish = await callPublicTool(
      workFinishHandler(ctx, {
        changedFiles: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
        evidenceRefs: ['scratch/afapi-stage6-agent-public-tools-readback.json'],
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 180, mode: 'compact' },
        summary: 'Stage 6 evaluation evidence is ready for controller review.',
        workRef,
      })
    );
    expect(workFinish.envelope).toMatchObject({
      actionKind: 'work-finish',
      refs: { finishRef: expect.objectContaining({ id: expect.any(String) }) },
      status: 'ready',
      toolName: 'alembic_work_finish',
    });

    const codeGuard = await callPublicTool(
      codeGuardHandler(ctx, {
        code: 'export const stage6Evaluation = true;',
        filePath: 'test/unit/AgentPublicToolsEvaluation.test.ts',
        inputSource: 'host-declared-intent',
        language: 'typescript',
        outputBudget: { maxChars: 160, mode: 'compact' },
        workRef,
      })
    );
    expect(codeGuard.envelope).toMatchObject({
      actionKind: 'code-guard',
      refs: { guardResultRef: expect.objectContaining({ id: expect.any(String) }) },
      status: 'ready',
      toolName: 'alembic_code_guard',
    });

    const decision = await callPublicTool(
      decisionRecordHandler(ctx, {
        description: 'Stage 6 evaluation proves P0 public tool contracts and readbacks.',
        evidenceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
        inputSource: 'host-declared-intent',
        intentRef,
        outputBudget: { maxChars: 180, mode: 'compact' },
        title: 'Close public tools evaluation',
        workRef,
      })
    );
    expect(decision.envelope).toMatchObject({
      actionKind: 'decision-record',
      refs: { decisionRef: { id: 'decision-stage6-ready' } },
      status: 'ready',
      toolName: 'alembic_decision_record',
    });

    for (const result of [intent, prime, workStart, workFinish, codeGuard, decision]) {
      expect(result.envelope.legacyCompatibility).toEqual({
        compatibilityRole: 'none',
        usesLegacyTaskHandler: false,
      });
      expect(result.envelope.refs.detailRefs).not.toHaveLength(0);
      expectBudget(result.envelope.summary.outputBudget);
    }
  });

  test('evaluates skip, degraded, blocked, and truncation paths without legacy task fallback', async () => {
    const ctx = makeContext(async () => null);

    const skippedIntent = await callPublicTool(
      intentHandler(ctx, {
        inputSource: 'automation-envelope',
        outputBudget: { maxChars: 120, mode: 'compact' },
        userQuery: '<codex_delegation><input>继续当前窗口任务</input></codex_delegation>',
      })
    );
    expect(skippedIntent.envelope).toMatchObject({
      reason: { code: 'mechanical-envelope-only', kind: 'skip' },
      status: 'skipped',
      toolName: 'alembic_intent',
    });

    const degradedPrime = await callPublicTool(
      primeHandler(ctx, {
        hostDeclaredIntent: {
          action: 'review',
          query: 'Review public tool evaluation coverage',
        },
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
        projectRoot: '/tmp/alembic-plugin-stage6',
        sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      })
    );
    expect(degradedPrime.envelope).toMatchObject({
      reason: { code: 'knowledge-empty', kind: 'degraded' },
      status: 'degraded',
      toolName: 'alembic_prime',
    });

    const skippedWorkStart = await callPublicTool(
      workStartHandler(ctx, {
        inputSource: 'user-message',
        outputBudget: { maxChars: 120, mode: 'compact' },
      })
    );
    expect(skippedWorkStart.envelope).toMatchObject({
      reason: { code: 'no-work-scope', kind: 'skip' },
      status: 'skipped',
      toolName: 'alembic_work_start',
    });

    const blockedWorkFinish = await callPublicTool(
      workFinishHandler(ctx, {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
      })
    );
    expect(blockedWorkFinish.envelope).toMatchObject({
      reason: { code: 'missing-work-ref', kind: 'blocked' },
      status: 'blocked',
      toolName: 'alembic_work_finish',
    });

    const blockedCodeGuard = await callPublicTool(
      codeGuardHandler(ctx, {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
      })
    );
    expect(blockedCodeGuard.envelope).toMatchObject({
      reason: { code: 'missing-guard-scope', kind: 'blocked' },
      status: 'blocked',
      toolName: 'alembic_code_guard',
    });

    const blockedDecision = await callPublicTool(
      decisionRecordHandler(ctx, {
        description: 'Decision Register unavailable path.',
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
        title: 'Decision Register unavailable path',
      })
    );
    expect(blockedDecision.envelope).toMatchObject({
      reason: { code: 'decision-register-unavailable', kind: 'blocked' },
      status: 'blocked',
      toolName: 'alembic_decision_record',
    });

    const workStart = await callPublicTool(
      workStartHandler(makeContext(), {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
        title: 'Budget truncation proof',
      })
    );
    const truncatedFinish = await callPublicTool(
      workFinishHandler(makeContext(), {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 48, mode: 'compact' },
        summary: 'Long Stage 6 output budget proof. '.repeat(10),
        workRef: stringFrom(workStart.raw, ['data', 'workRef']),
      })
    );
    expect(truncatedFinish.envelope.summary.outputBudget).toMatchObject({
      maxChars: 48,
      truncated: true,
    });
    expectBudget(truncatedFinish.envelope.summary.outputBudget);

    for (const result of [
      skippedIntent,
      degradedPrime,
      skippedWorkStart,
      blockedWorkFinish,
      blockedCodeGuard,
      blockedDecision,
      truncatedFinish,
    ]) {
      expect(result.envelope.legacyCompatibility.usesLegacyTaskHandler).toBe(false);
    }
  });

  test('keeps alembic_task as compatibility only and maps old operations to new tools', () => {
    const taskTool = TOOLS.find((tool) => tool.name === 'alembic_task');
    expect(taskTool?.description).toContain('Legacy compatibility task lifecycle surface');
    expect(taskTool?.description).toContain(
      'Prefer the agent-facing public tools as the primary host guide'
    );
    expect(taskTool?.description).toContain('prime');
    expect(taskTool?.description).toContain('alembic_intent');
    expect(taskTool?.description).toContain('alembic_prime');
    expect(taskTool?.description).toContain('create');
    expect(taskTool?.description).toContain('alembic_work_start');
    expect(taskTool?.description).toContain('close');
    expect(taskTool?.description).toContain('alembic_work_finish');
    expect(taskTool?.description).toContain('alembic_code_guard');
    expect(taskTool?.description).toContain('record_decision');
    expect(taskTool?.description).toContain('alembic_decision_record');

    for (const forbidden of forbiddenLegacyPrimaryWording) {
      expect(taskTool?.description ?? '').not.toContain(forbidden);
    }
  });
});

async function callPublicTool(promise: Promise<unknown>) {
  const raw = await promise;
  return {
    envelope: AgentPublicToolResultEnvelopeSchema.parse(
      (raw as { data?: { result?: unknown } }).data?.result
    ),
    raw,
  };
}

function expectBudget(budget: { maxChars: number; truncated: boolean; usedChars: number }): void {
  expect(budget.maxChars).toBeGreaterThan(0);
  expect(budget.usedChars).toBeGreaterThanOrEqual(0);
  expect(budget.usedChars).toBeLessThanOrEqual(budget.maxChars);
  expect(typeof budget.truncated).toBe('boolean');
}

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
      id: 'session-public-tools-stage6',
      intent: createIdleIntent(),
      lastActivityAt: 1,
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
    },
  };
}

function deliveredSearchResult(): PrimeSearchResult {
  return {
    guardRules: [
      {
        actionHint: 'Keep Plugin-owned Codex MCP boundaries.',
        description: 'Do not route Codex public tools through legacy task operations.',
        id: 'guard-public-api-stage6',
        kind: 'rule',
        language: 'typescript',
        score: 0.86,
        sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
        title: 'Keep public tools Plugin-owned',
        trigger: '@plugin-public-tools',
      },
    ],
    relatedKnowledge: [
      {
        actionHint: 'Use structure-first Recipe retrieval.',
        description: 'Prime should search with extracted structure and host intent context.',
        id: 'recipe-public-prime-stage6',
        kind: 'pattern',
        language: 'typescript',
        score: 0.92,
        sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts'],
        title: 'Agent public prime',
        trigger: '@agent-public-prime',
      },
    ],
    searchMeta: {
      filteredCount: 2,
      language: 'typescript',
      module: 'codex/mcp',
      queries: ['Evaluate AFAPI Stage 6 public tools'],
      residentSearch: {
        attempted: true,
        available: true,
        residentVector: { available: true },
        route: 'alembic-resident-service',
        semanticUsed: true,
        vectorUsed: true,
      },
      resultCount: 2,
      scenario: 'generate',
    },
  };
}

function durableDecisionCapability() {
  return {
    available: true,
    lifecycle: ['create', 'update', 'revoke', 'delete', 'read', 'list'],
    owner: 'alembic',
    route: 'decision-register',
  };
}

function stage6IntentArgs(maxChars: number) {
  return {
    hostDeclaredIntent: {
      action: 'implement',
      confidence: 0.92,
      language: 'typescript',
      query: 'Evaluate AFAPI Stage 6 public tools',
      sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
    },
    inputSource: 'host-declared-intent' as const,
    language: 'typescript',
    outputBudget: { maxChars, mode: 'compact' as const },
    sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
  };
}

function stringFrom(value: unknown, path: readonly string[]): string {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      throw new Error(`Missing string path ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== 'string') {
    throw new Error(`Expected string path ${path.join('.')}`);
  }
  return current;
}
