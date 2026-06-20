import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  codeGuardHandler,
  primeHandler,
  workFinishHandler,
  workStartHandler,
} from '../../lib/runtime/mcp/handlers/agent-public-tools.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import type { AgentPublicToolName } from '../../lib/runtime/mcp/public-tools/contract.js';
import {
  AGENT_PUBLIC_TOOL_NAMES,
  AgentPublicToolResultEnvelopeSchema,
  buildAgentPublicCrossHostReadinessReport,
  getAgentPublicToolContractDefinition,
  getAgentPublicToolDescriptionBase,
} from '../../lib/runtime/mcp/public-tools/index.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const retiredPublicToolNames = [
  'alembic_intent',
  'alembic_work_start',
  'alembic_work_finish',
  'alembic_decision_record',
] as const;

const currentToolSamples = {
  alembic_prime: {
    capability: 'agent-facing public tool contract',
    inputSource: 'host-declared-intent',
    projectRoot: '/tmp/alembic-plugin-stage6',
    requirementGoal: 'Evaluate current public tool contracts',
    scenario: 'Stage 6 public tool readback',
    taskAction: 'code-review',
  },
  alembic_work: {
    inputSource: 'host-declared-intent',
    phase: 'start',
    title: 'Evaluate current public tools',
    workScope: { goal: 'Close current public tool evaluation evidence.' },
  },
  alembic_code_guard: {
    code: 'export const stage6Evaluation = true;',
    filePath: 'test/unit/AgentPublicToolsEvaluation.test.ts',
    inputSource: 'host-declared-intent',
    language: 'typescript',
  },
} as const satisfies Record<AgentPublicToolName, Record<string, unknown>>;

describe('AFAPI Stage 6 agent-facing public tools evaluation', () => {
  test('locks current three-tool contract and retired public-tool boundary', () => {
    expect(AGENT_PUBLIC_TOOL_NAMES).toEqual([
      'alembic_prime',
      'alembic_work',
      'alembic_code_guard',
    ]);

    for (const toolName of AGENT_PUBLIC_TOOL_NAMES) {
      const contract = getAgentPublicToolContractDefinition(toolName);
      const description = getAgentPublicToolDescriptionBase(toolName);
      expect(contract.activeMcpSurface).toBe(true);
      expect(contract.implementationStatus).toBe('active-tool');
      expect(description.name).toBe(toolName);
      expect(TOOL_SCHEMAS[toolName].safeParse(currentToolSamples[toolName]).success).toBe(true);
    }

    for (const retiredName of retiredPublicToolNames) {
      expect(TOOL_SCHEMAS[retiredName]).toBeUndefined();
      expect(TOOLS.some((tool) => tool.name === retiredName)).toBe(false);
    }
  });

  test('keeps cross-host readiness guidance aligned with the current public surface', () => {
    const report = buildAgentPublicCrossHostReadinessReport();
    const serialized = JSON.stringify(report);

    expect(report.sharedContract.toolNames).toEqual([...AGENT_PUBLIC_TOOL_NAMES]);
    expect(report.schemaSignature).toBe(
      'contract:v1;hosts:codex|claude-code;tools:alembic_prime|alembic_work|alembic_code_guard;statuses:ready|skipped|degraded|blocked|failed'
    );
    expect(serialized).toContain('three agent-facing public tools');
    expect(serialized).toContain('alembic_work phase=start');
    expect(serialized).not.toContain('six agent-facing public tools');
    expect(serialized).not.toContain('call alembic_intent');
  });

  test('evaluates ready clean outputs for prime, work, and code guard without old public tools', async () => {
    const ctx = makeContext(async () => deliveredSearchResult(), {
      guardCheckEngine: {
        auditFile: vi.fn(),
        auditFiles: vi.fn(),
        checkCode: vi.fn(() => []),
        injectExternalRules: vi.fn(),
        isEpInjected: () => true,
      },
    });

    const prime = await callPublicTool(
      primeHandler(ctx, {
        agentHost: 'codex',
        capability: 'agent-facing public tool contract',
        integrationBoundary: 'MCP handler',
        inputSource: 'host-declared-intent',
        projectRoot: '/tmp/alembic-plugin-stage6',
        requirementGoal: 'Evaluate current public tool contracts',
        scenario: 'Stage 6 public tool readback',
        taskAction: 'code-review',
      })
    );
    const primeRef = stringFrom(prime.raw, ['refs', 'primeRef', 'id']);
    expect(prime.envelope).toMatchObject({
      actionKind: 'prime',
      refs: { primeRef: { id: primeRef } },
      status: 'ready',
      toolName: 'alembic_prime',
    });

    const workStart = await callPublicTool(
      workStartHandler(ctx, {
        inputSource: 'host-declared-intent',
        primeRef,
        title: 'Evaluate current public tools',
        workScope: {
          files: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
          goal: 'Close current public tool evaluation evidence.',
        },
      })
    );
    const workRef = stringFrom(workStart.raw, ['workRef']);
    expect(workStart.envelope).toMatchObject({
      actionKind: 'work',
      refs: {
        primeRef: { id: primeRef },
        workRef: { id: workRef },
      },
      status: 'ready',
      toolName: 'alembic_work',
    });

    const workFinish = await callPublicTool(
      workFinishHandler(ctx, {
        changedFiles: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
        evidenceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
        inputSource: 'host-declared-intent',
        summary: 'Current public tool evaluation evidence is ready.',
        workRef,
      })
    );
    expect(workFinish.envelope).toMatchObject({
      actionKind: 'work',
      refs: {
        finishRef: expect.objectContaining({ id: expect.any(String) }),
        workRef: { id: workRef },
      },
      status: 'ready',
      toolName: 'alembic_work',
    });

    const codeGuard = await callPublicTool(
      codeGuardHandler(ctx, {
        code: 'export const stage6Evaluation = true;',
        filePath: 'test/unit/AgentPublicToolsEvaluation.test.ts',
        inputSource: 'host-declared-intent',
        language: 'typescript',
        workRef,
      })
    );
    expect(codeGuard.envelope).toMatchObject({
      actionKind: 'code-guard',
      refs: { guardResultRef: expect.objectContaining({ id: expect.any(String) }) },
      status: 'ready',
      toolName: 'alembic_code_guard',
    });

    for (const result of [prime, workStart, workFinish, codeGuard]) {
      expect(result.envelope.refs.detailRefs).not.toHaveLength(0);
      expect(JSON.stringify(result.raw)).not.toContain('"data"');
      expect(JSON.stringify(result.raw)).not.toContain('legacyCompatibility');
      expect(JSON.stringify(result.raw)).not.toContain('outputBudget');
    }
  });

  test('blocks obsolete prime inputs and keeps the installed-cache probe on current tools', async () => {
    const search = vi.fn(async () => deliveredSearchResult());
    const obsoletePrime = await callPublicTool(
      primeHandler(makeContext(search), {
        inputSource: 'host-declared-intent',
        intentRef: 'obsolete-ref',
        projectRoot: '/tmp/alembic-plugin-stage6',
      })
    );

    expect(obsoletePrime.envelope).toMatchObject({
      reason: { code: 'obsolete-prime-intent-input', kind: 'blocked' },
      status: 'blocked',
      toolName: 'alembic_prime',
    });
    expect(search).not.toHaveBeenCalled();

    const probe = readFixture('../../scripts/probe-agent-public-tools-evaluation.mjs');
    expect(probe).toContain("'alembic_prime'");
    expect(probe).toContain("'alembic_work'");
    expect(probe).toContain("'alembic_code_guard'");
    for (const retiredName of retiredPublicToolNames) {
      expect(probe).not.toContain(`'${retiredName}'`);
    }
  });
});

async function callPublicTool(promise: Promise<unknown>) {
  const raw = await promise;
  return {
    envelope: AgentPublicToolResultEnvelopeSchema.parse(raw),
    raw,
  };
}

function makeContext(
  search?: (request: unknown, options?: unknown) => Promise<PrimeSearchResult | null>,
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
      acceptedDecisionRefs: ['decision-stage6-current'],
      auditExcludedCount: 0,
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
          relatedId: 'decision-stage6-current',
          relation: 'supports',
          source: 'knowledgeGraphService',
        },
      ],
      omitted: [],
    },
    retrievalQuality: {
      decisionRefCount: 1,
      feedbackSignalCount: 1,
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
        description: 'Do not route Codex public tools through retired task operations.',
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
        actionHint: 'Use standalone prime frames for public tool context.',
        description: 'Prime should search with extracted taskAction and locator facets.',
        id: 'recipe-public-prime-stage6',
        kind: 'pattern',
        language: 'typescript',
        score: 0.92,
        sourceRefs: ['lib/runtime/mcp/handlers/agent-public-tools.ts'],
        title: 'Agent public prime',
        trigger: '@agent-public-prime',
      },
    ],
    searchMeta: {
      filteredCount: 2,
      language: 'typescript',
      module: 'codex/mcp',
      queries: ['Evaluate current public tool contracts'],
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
      scenario: 'code-review',
    },
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
