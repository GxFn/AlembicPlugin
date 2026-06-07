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
import type {
  AgentPublicToolName,
  AgentPublicToolResultEnvelope,
} from '../../lib/codex/mcp/public-tools/contract.js';
import {
  AGENT_PUBLIC_TOOL_NAMES,
  AgentPublicToolResultEnvelopeSchema,
  buildAgentPublicCrossHostReadinessReport,
  getAgentPublicToolContractDefinition,
  getAgentPublicToolDescriptionBase,
} from '../../lib/codex/mcp/public-tools/index.js';
import { LEGACY_DIRECT_CALL_COMPATIBILITY_TOOLS, TOOLS } from '../../lib/codex/mcp/tools.js';
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

const stage4aGoldenSuiteMatrix = [
  {
    id: 'wrong-call',
    toolName: 'alembic_intent',
    expectedStatus: 'skipped',
    expectedReasonKind: 'skip',
    expectedReasonCode: 'legacy-public-call-hidden',
    promptExpectation:
      'Old alembic_task operation calls stay hidden from tools/list; route host agents to the six public tools.',
  },
  {
    id: 'missing-call',
    toolName: 'alembic_prime',
    expectedStatus: 'blocked',
    expectedReasonKind: 'blocked',
    expectedReasonCode: 'missing-required-intent',
    promptExpectation:
      'Prime needs an intentRef or explicit recognized intent instead of guessing from an empty turn.',
  },
  {
    id: 'raw-envelope',
    toolName: 'alembic_intent',
    expectedStatus: 'skipped',
    expectedReasonKind: 'skip',
    expectedReasonCode: 'mechanical-envelope-only',
    promptExpectation:
      'Raw automation envelopes are skipped until the host provides curated intent and verifiable refs.',
  },
  {
    id: 'fake-work',
    toolName: 'alembic_work_finish',
    expectedStatus: 'blocked',
    expectedReasonKind: 'blocked',
    expectedReasonCode: 'missing-work-ref',
    promptExpectation:
      'Work finish must use a real workRef returned by alembic_work_start; fake work is not completion evidence.',
  },
  {
    id: 'noisy-guard',
    toolName: 'alembic_code_guard',
    expectedStatus: 'blocked',
    expectedReasonKind: 'blocked',
    expectedReasonCode: 'missing-guard-scope',
    promptExpectation:
      'Code Guard requires explicit files or inline code and never falls back to noisy whole-diff review.',
  },
  {
    id: 'stale-decision',
    toolName: 'alembic_decision_record',
    expectedStatus: 'blocked',
    expectedReasonKind: 'blocked',
    expectedReasonCode: 'decision-register-unavailable',
    promptExpectation:
      'Stale or missing durable Decision Register routes block instead of writing Plugin-local fake decisions.',
  },
  {
    id: 'over-budget',
    toolName: 'alembic_work_start',
    expectedStatus: 'ready',
    expectedReasonKind: null,
    expectedReasonCode: null,
    promptExpectation:
      'Long host-visible summaries stay compact and advertise truncation through outputBudget.',
  },
  {
    id: 'adoption-feedback',
    toolName: 'alembic_prime',
    expectedStatus: 'ready',
    expectedReasonKind: null,
    expectedReasonCode: null,
    promptExpectation:
      'Prime preserves observe-only adoption and feedback metadata from the resident retrieval contract.',
  },
] as const satisfies readonly {
  expectedReasonCode: string | null;
  expectedReasonKind: string | null;
  expectedStatus: AgentPublicToolResultEnvelope['status'];
  id: string;
  promptExpectation: string;
  toolName: AgentPublicToolName;
}[];

const afapiReq10CoverageDimensions = [
  'ready',
  'skip',
  'degraded',
  'blocked',
  'failed',
  'output-budget',
  'legacy-boundary',
] as const;

type AfapiReq10CoverageDimension = (typeof afapiReq10CoverageDimensions)[number];

const afapiReq10EvaluationMatrix = [
  {
    toolName: 'alembic_intent',
    coverage: {
      ready: ['unit: host-declared semantic intent returns ready with intentRef'],
      skip: ['unit: raw automation, status-only, and empty semantic turns return skipped'],
      degraded: ['unit: low-confidence semantic intent returns degraded and remains consumable'],
      blocked: ['contract: shared result envelope admits blocked status for host callers'],
      failed: ['contract: shared result envelope admits failed status for handler errors'],
      'output-budget': ['unit: compact summary uses outputBudget and expectBudget assertions'],
      'legacy-boundary': [
        'unit: usesLegacyTaskHandler=false and active guidance omits legacy task wording',
      ],
    },
  },
  {
    toolName: 'alembic_prime',
    coverage: {
      ready: ['unit: intentRef plus resident retrieval material returns ready with primeRef'],
      skip: ['unit: lifecycle skip policies cover mechanical/status/non-project intent'],
      degraded: [
        'unit: knowledge-empty, resident-unavailable, and missing producer metadata degrade',
      ],
      blocked: ['unit: missing intent and automation envelope without sourceRefs block'],
      failed: ['contract: shared result envelope admits failed status for handler errors'],
      'output-budget': ['unit: compact summary uses outputBudget and expectBudget assertions'],
      'legacy-boundary': [
        'unit: usesLegacyTaskHandler=false and prime does not route through alembic_task',
      ],
    },
  },
  {
    toolName: 'alembic_work_start',
    coverage: {
      ready: ['unit: concrete scoped work returns ready with workRef'],
      skip: ['unit: no-work-scope, status-only, raw-envelope, and design-readonly turns skip'],
      degraded: ['contract: shared result envelope admits degraded status for host callers'],
      blocked: ['contract: shared result envelope admits blocked status for host callers'],
      failed: ['contract: shared result envelope admits failed status for handler errors'],
      'output-budget': ['unit: over-budget work start advertises outputBudget.truncated=true'],
      'legacy-boundary': [
        'unit: usesLegacyTaskHandler=false and active guidance omits legacy task wording',
      ],
    },
  },
  {
    toolName: 'alembic_work_finish',
    coverage: {
      ready: ['unit: real workRef closes with finishRef and guard recommendation'],
      skip: ['contract: shared result envelope admits skipped status for host callers'],
      degraded: ['contract: shared result envelope admits degraded status for host callers'],
      blocked: ['unit: missing or fake workRef blocks as missing-work-ref'],
      failed: ['contract: shared result envelope admits failed status for handler errors'],
      'output-budget': ['unit: long finish summary advertises outputBudget.truncated=true'],
      'legacy-boundary': [
        'unit: usesLegacyTaskHandler=false and finish does not route through alembic_task',
      ],
    },
  },
  {
    toolName: 'alembic_code_guard',
    coverage: {
      ready: [
        'unit: scoped workRef guard returns ready',
        'probe: scoped workRef readback expects ready',
      ],
      skip: ['unit: active workRef with no source files skips as no-code-scope'],
      degraded: ['contract: shared result envelope admits degraded status for host callers'],
      blocked: [
        'unit: no-scope guard returns blocked/missing-guard-scope',
        'probe: no-scope readback expects blocked/missing-guard-scope',
      ],
      failed: [
        'contract: handler catch path returns failed/handler-error for scoped guard failures',
      ],
      'output-budget': ['unit: compact summary uses outputBudget and expectBudget assertions'],
      'legacy-boundary': [
        'unit: usesLegacyTaskHandler=false and code guard does not accept legacy public scope',
      ],
    },
  },
  {
    toolName: 'alembic_decision_record',
    coverage: {
      ready: [
        'unit: resident Decision Register create/update/revoke/delete/read/list returns ready',
      ],
      skip: ['contract: shared result envelope admits skipped status for host callers'],
      degraded: ['contract: shared result envelope admits degraded status for host callers'],
      blocked: [
        'unit: unavailable durable route blocks as decision-register-unavailable',
        'unit: capability mismatch blocks as decision-register-capability-mismatch',
      ],
      failed: ['contract: shared result envelope admits failed status for handler errors'],
      'output-budget': ['unit: compact summary uses outputBudget and expectBudget assertions'],
      'legacy-boundary': [
        'unit: alembic_task hidden direct record_decision is blocked and writes no local decision',
      ],
    },
  },
] as const satisfies readonly {
  coverage: Record<AfapiReq10CoverageDimension, readonly string[]>;
  toolName: AgentPublicToolName;
}[];

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

  test('anchors AFAPI-REQ-10 six-tool evaluation matrix as first-class coverage evidence', () => {
    expect(afapiReq10EvaluationMatrix.map((entry) => entry.toolName)).toEqual(
      AGENT_PUBLIC_TOOL_NAMES
    );

    for (const entry of afapiReq10EvaluationMatrix) {
      const contract = getAgentPublicToolContractDefinition(entry.toolName);
      expect(Object.keys(entry.coverage)).toEqual([...afapiReq10CoverageDimensions]);
      expect(contract.resultContract.statuses).toEqual([
        'ready',
        'skipped',
        'degraded',
        'blocked',
        'failed',
      ]);

      for (const dimension of afapiReq10CoverageDimensions) {
        expect(entry.coverage[dimension], `${entry.toolName} ${dimension}`).not.toHaveLength(0);
      }
      expect(entry.coverage.failed.some((item) => item.startsWith('contract:'))).toBe(true);
      expect(entry.coverage['output-budget'].some((item) => item.includes('outputBudget'))).toBe(
        true
      );
      expect(
        entry.coverage['legacy-boundary'].some(
          (item) => item.includes('usesLegacyTaskHandler=false') || item.includes('alembic_task')
        )
      ).toBe(true);
    }

    const codeGuardMatrix = afapiReq10EvaluationMatrix.find(
      (entry) => entry.toolName === 'alembic_code_guard'
    );
    expect(codeGuardMatrix?.coverage.ready).toEqual(
      expect.arrayContaining(['probe: scoped workRef readback expects ready'])
    );
    expect(codeGuardMatrix?.coverage.blocked).toEqual(
      expect.arrayContaining(['probe: no-scope readback expects blocked/missing-guard-scope'])
    );
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
    expect(skippedWorkStart.envelope.refs.workRef).toBeUndefined();

    const statusOnlyWorkStart = await callPublicTool(
      workStartHandler(ctx, {
        hostDeclaredIntent: {
          action: 'status',
          query: 'Status update only; summarize progress without changing files.',
        },
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
        userQuery: 'Status update only; summarize progress without changing files.',
      })
    );
    expect(statusOnlyWorkStart.envelope).toMatchObject({
      reason: { code: 'status-only-turn', kind: 'skip' },
      status: 'skipped',
      toolName: 'alembic_work_start',
    });
    expect(statusOnlyWorkStart.envelope.refs.workRef).toBeUndefined();

    const rawEnvelopeWorkStart = await callPublicTool(
      workStartHandler(ctx, {
        inputSource: 'automation-envelope',
        outputBudget: { maxChars: 120, mode: 'compact' },
        title: '<codex_delegation><input>继续当前窗口任务</input></codex_delegation>',
      })
    );
    expect(rawEnvelopeWorkStart.envelope).toMatchObject({
      reason: { code: 'mechanical-envelope-only', kind: 'skip' },
      status: 'skipped',
      toolName: 'alembic_work_start',
    });
    expect(rawEnvelopeWorkStart.envelope.refs.workRef).toBeUndefined();

    const designReadonlyWorkStart = await callPublicTool(
      workStartHandler(ctx, {
        hostDeclaredIntent: {
          action: 'analyze',
          query: 'Read the design discussion and provide a recommendation only.',
        },
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
      })
    );
    expect(designReadonlyWorkStart.envelope).toMatchObject({
      reason: { code: 'no-work-scope', kind: 'skip' },
      status: 'skipped',
      toolName: 'alembic_work_start',
    });
    expect(designReadonlyWorkStart.envelope.refs.workRef).toBeUndefined();

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
      statusOnlyWorkStart,
      rawEnvelopeWorkStart,
      designReadonlyWorkStart,
      blockedWorkFinish,
      blockedCodeGuard,
      blockedDecision,
      truncatedFinish,
    ]) {
      expect(result.envelope.legacyCompatibility.usesLegacyTaskHandler).toBe(false);
    }
  });

  test('removes alembic_task from active public tools while retaining hidden direct-call compatibility', () => {
    const taskTool = TOOLS.find((tool) => tool.name === 'alembic_task');
    const hiddenTaskTool = LEGACY_DIRECT_CALL_COMPATIBILITY_TOOLS.find(
      (tool) => tool.name === 'alembic_task'
    );

    expect(taskTool).toBeUndefined();
    expect(hiddenTaskTool?.description).toContain('Hidden direct-call compatibility');
    expect(hiddenTaskTool?.description).toContain('not advertised through tools/list');
    expect(hiddenTaskTool?.description).toContain('fail closed');
    expect(hiddenTaskTool?.description).toContain('never write Plugin-local decisions');
    for (const forbidden of forbiddenLegacyPrimaryWording) {
      expect(hiddenTaskTool?.description ?? '').not.toContain(forbidden);
    }
  });

  test('locks Stage 4A host prompt golden matrix across active guidance and host snapshots', () => {
    const activePublicGuidance = TOOLS.filter((tool) =>
      AGENT_PUBLIC_TOOL_NAMES.includes(tool.name as AgentPublicToolName)
    )
      .map((tool) => tool.description)
      .join('\n');
    const mainSkill = readFixture('../../plugins/alembic-codex/skills/alembic/SKILL.md');
    const hostGuide = JSON.stringify(buildAgentPublicCrossHostReadinessReport().hostSnapshots);
    const stage4aPromptMatrix = stage4aGoldenSuiteMatrix
      .map((scenario) => `${scenario.id}: ${scenario.promptExpectation}`)
      .join('\n');
    const combinedGuidance = [activePublicGuidance, mainSkill, hostGuide, stage4aPromptMatrix].join(
      '\n'
    );

    for (const scenario of stage4aGoldenSuiteMatrix) {
      expect(stage4aPromptMatrix).toContain(`${scenario.id}:`);
      expect(stage4aPromptMatrix).toContain(scenario.promptExpectation);
      expect(activePublicGuidance).toContain(
        getAgentPublicToolDescriptionBase(scenario.toolName).title
      );
    }
    for (const toolName of AGENT_PUBLIC_TOOL_NAMES) {
      expect(mainSkill).toContain(toolName);
    }
    expect(mainSkill).toContain('six agent-facing public tools');
    expect(hostGuide).toContain('Use alembic_work_start for concrete evidence-producing work');
    expect(hostGuide).toContain('Use alembic_code_guard only with explicit files or inline code');

    for (const forbidden of forbiddenLegacyPrimaryWording) {
      expect(combinedGuidance).not.toContain(forbidden);
    }
    expect(activePublicGuidance).not.toContain('alembic_task');
    expect(hostGuide).not.toContain('alembic_task');
  });

  test('evaluates Stage 4A wrong-call, missing-call, raw-envelope, fake-work, noisy-guard, stale-decision, over-budget, and adoption drift scenarios', async () => {
    const outcomes: Record<
      string,
      {
        reasonCode: string | null;
        reasonKind: string | null;
        status: AgentPublicToolResultEnvelope['status'];
        toolName: string;
      }
    > = {};

    const hiddenLegacyTaskTool = LEGACY_DIRECT_CALL_COMPATIBILITY_TOOLS.find(
      (tool) => tool.name === 'alembic_task'
    );
    expect(TOOLS.some((tool) => tool.name === 'alembic_task')).toBe(false);
    expect(hiddenLegacyTaskTool?.description).toContain('Hidden direct-call compatibility');
    outcomes['wrong-call'] = {
      reasonCode: 'legacy-public-call-hidden',
      reasonKind: 'skip',
      status: 'skipped',
      toolName: 'alembic_intent',
    };

    const missingCall = await callPublicTool(
      primeHandler(makeContext(), {
        inputSource: 'user-message',
        outputBudget: { maxChars: 120, mode: 'compact' },
      })
    );
    outcomes['missing-call'] = outcomeFrom(missingCall.envelope);

    const rawEnvelope = await callPublicTool(
      intentHandler(makeContext(), {
        inputSource: 'automation-envelope',
        outputBudget: { maxChars: 120, mode: 'compact' },
        userQuery: '<codex_delegation><input>继续当前窗口任务</input></codex_delegation>',
      })
    );
    outcomes['raw-envelope'] = outcomeFrom(rawEnvelope.envelope);
    expect(rawEnvelope.envelope.reason?.message).toContain('Raw automation envelope');

    const fakeWork = await callPublicTool(
      workFinishHandler(makeContext(), {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 120, mode: 'compact' },
        summary: 'Pretend work is complete without a real start record.',
        workRef: 'work-stage4a-fake',
      })
    );
    outcomes['fake-work'] = outcomeFrom(fakeWork.envelope);
    expect(fakeWork.envelope.reason?.message).toContain('No active work record exists');

    const noisyGuard = await callPublicTool(
      codeGuardHandler(makeContext(), {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 160, mode: 'compact' },
      })
    );
    outcomes['noisy-guard'] = outcomeFrom(noisyGuard.envelope);
    expect(noisyGuard.envelope.reason?.message).toContain('will not fall back');

    const staleDecision = await callPublicTool(
      decisionRecordHandler(
        makeContext(undefined, {
          residentDecisionRegisterClient: {
            decisionRegister: vi.fn(async () => ({
              message: 'Decision record is stale or missing from the durable register.',
              ok: false,
              reason: 'decision-not-found',
              retryable: false,
              status: { owner: 'alembic', route: 'decision-register' },
            })),
          },
        }),
        {
          action: 'update',
          decisionRef: 'decision-stage4a-stale',
          description: 'Do not write a Plugin-local fake decision for stale records.',
          inputSource: 'host-declared-intent',
          outputBudget: { maxChars: 180, mode: 'compact' },
        }
      )
    );
    outcomes['stale-decision'] = outcomeFrom(staleDecision.envelope);
    expect(staleDecision.envelope.summary.compact).toContain('no local fake record');

    const overBudget = await callPublicTool(
      workStartHandler(makeContext(), {
        inputSource: 'host-declared-intent',
        outputBudget: { maxChars: 48, mode: 'compact' },
        title: 'Stage 4A output budget proof '.repeat(8),
      })
    );
    outcomes['over-budget'] = outcomeFrom(overBudget.envelope);
    expect(overBudget.envelope.summary.outputBudget).toMatchObject({
      maxChars: 48,
      truncated: true,
    });

    const adoptionFeedback = await callPublicTool(
      primeHandler(
        makeContext(async () => deliveredSearchResult()),
        {
          hostDeclaredIntent: {
            action: 'review',
            query: 'Review adoption feedback drift in public prime metadata',
          },
          inputSource: 'host-declared-intent',
          outputBudget: { maxChars: 240, mode: 'compact' },
          projectRoot: '/tmp/alembic-plugin-stage4a',
          sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
        }
      )
    );
    outcomes['adoption-feedback'] = outcomeFrom(adoptionFeedback.envelope);
    expect(
      recordFrom(adoptionFeedback.raw, ['data', 'retrievalConsumer', 'feedback'])
    ).toMatchObject({
      observeOnly: true,
      supportedSignals: expect.arrayContaining(['searchHit', 'view', 'adoption']),
    });
    expect(
      recordFrom(adoptionFeedback.raw, ['data', 'retrievalConsumer', 'retrievalQuality'])
        .feedbackSignalCount
    ).toBe(3);

    expect(Object.keys(outcomes).sort()).toEqual(
      stage4aGoldenSuiteMatrix.map((scenario) => scenario.id).sort()
    );
    for (const scenario of stage4aGoldenSuiteMatrix) {
      expect(outcomes[scenario.id], scenario.id).toMatchObject({
        reasonCode: scenario.expectedReasonCode,
        reasonKind: scenario.expectedReasonKind,
        status: scenario.expectedStatus,
        toolName: scenario.toolName,
      });
    }
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.toolName).not.toBe('alembic_task');
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

function outcomeFrom(envelope: AgentPublicToolResultEnvelope) {
  return {
    reasonCode: envelope.reason?.code ?? null,
    reasonKind: envelope.reason?.kind ?? null,
    status: envelope.status,
    toolName: envelope.toolName,
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
  const retrievalConsumer = {
    decisionRegister: {
      acceptedDecisionRefs: ['decision-stage4a-adoption'],
      auditExcludedCount: 1,
      available: true,
      defaultLifecycle: 'active-effective-only' as const,
      excludedStatuses: ['revoked', 'deleted'],
      route: '/api/v1/decision-register/searchable',
    },
    feedback: {
      observeOnly: true,
      supportedSignals: ['searchHit', 'view', 'adoption'],
      version: 1,
    },
    producerContract: {
      available: true,
      missingFields: [],
      reasonCode: 'resident-search-stage1a-contract-present' as const,
      requiredFields: ['decisionRegister', 'feedback', 'retrievalQuality'],
      stage: 'AFAPI-FULL-STAGE1A' as const,
    },
    relationEvidence: {
      count: 1,
      evidence: [
        {
          direction: 'outgoing',
          itemId: 'recipe-public-prime-stage6',
          relatedId: 'decision-stage4a-adoption',
          relation: 'supports',
          source: 'knowledgeGraphService',
        },
      ],
      omitted: [],
    },
    retrievalQuality: {
      decisionRefCount: 1,
      feedbackSignalCount: 3,
      relationEvidenceCount: 1,
      sourceRefCoverage: 1,
      version: 1,
    },
    source: 'resident-search-meta' as const,
    version: 1,
  };

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
      retrievalConsumer,
      residentSearch: {
        attempted: true,
        available: true,
        residentVector: { available: true },
        retrievalConsumer,
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

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function recordFrom(value: unknown, path: readonly string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      throw new Error(`Missing record path ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Expected record path ${path.join('.')}`);
  }
  return current as Record<string, unknown>;
}
