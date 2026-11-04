import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetGenerateSessionManagersForTesting,
  getOrCreateSessionManager,
} from '@alembic/core/host-agent-workflows';
import { pathGuard } from '@alembic/core/io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetKnowledgeSkillAutoSyncLedgerForTesting,
  type HostAgentDimensionCompletionContext,
  type HostAgentWorkflowSession,
  runHostAgentDimensionCompletionWorkflow,
} from '#recipe-pipeline/generate/dimension-completion.js';

// 回归（W3d-1）：Core 在插件做质量检查之前就把维度标记为完成。末维度首次提交若质量不合格，
// 重试时 Core 返回 updated=true；auto-sync 不能再按 per-dimension updated 判定，否则会被永久跳过。
// 这里驱动真实 Core GenerateSession，只把首次 buildQualityReport 改成不合格。

const tempRoots: string[] = [];

afterEach(() => {
  _resetGenerateSessionManagersForTesting();
  _resetKnowledgeSkillAutoSyncLedgerForTesting();
  pathGuard._reset();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('final dimension auto-sync after a failed-quality first completion', () => {
  it('runs the knowledge-skill auto-sync on the passing retry and skips only a later repeat', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-followup-autosync-'));
    tempRoots.push(projectRoot);
    pathGuard.configure({ projectRoot });

    const manager = getOrCreateSessionManager(createSessionContainer(projectRoot));
    const session = manager.createSession({
      projectRoot,
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectContext: { projectName: 'fix-followup-auto-sync' },
    }) as unknown as HostAgentWorkflowSession;
    recordGroundedSubmissions(session);

    const tracker = session.submissionTracker as unknown as {
      buildQualityReport(...args: unknown[]): unknown;
    };
    // 插件先用 preview 质量报告做前置门禁（第 1 次调用，保持真实结果）；Core markDimensionComplete
    // 写入 completedDimensions 之后再算一次（第 2 次调用）——只让这一次不合格，模拟“已标记完成、
    // 但插件随后按质量拒绝”的首次提交。
    const realBuildQualityReport = tracker.buildQualityReport.bind(tracker);
    let qualityCalls = 0;
    vi.spyOn(tracker, 'buildQualityReport').mockImplementation((...qualityArgs: unknown[]) => {
      qualityCalls += 1;
      if (qualityCalls === 2) {
        return {
          totalScore: 12,
          pass: false,
          scores: { coverageScore: 10, evidenceScore: 10, diversityScore: 10, coherenceScore: 10 },
          suggestions: ['Add more grounded evidence before completing this dimension.'],
        };
      }
      return realBuildQualityReport(...qualityArgs);
    });

    const refreshKnowledgeSkills = vi.fn(() => ({
      success: true,
      message: 'refreshed',
      data: {
        hasKnowledgeBase: true,
        refreshed: [{ skillName: 'alembic-recipes', success: true }],
      },
    }));
    const dependencies = {
      getActiveSession: () => session,
      refreshKnowledgeSkills,
      runCompletionFinalizer: vi.fn(async () => undefined),
      saveCheckpoint: async () => undefined,
      createEmitter: () => ({
        emitDimensionComplete: vi.fn(),
        emitAllComplete: vi.fn(),
      }),
    };
    const args = {
      dimensionId: 'architecture',
      analysisText: longAnalysisText(),
      keyFindings: [
        'The source files expose the shared module boundary through architecture evidence.',
        'The package references show how runtime ownership is separated from plugin code.',
        'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
      ],
    };

    const failed = await runHostAgentDimensionCompletionWorkflow(
      createContext(projectRoot),
      args,
      dependencies
    );
    expect(failed.success).toBe(false);
    expect(refreshKnowledgeSkills).not.toHaveBeenCalled();
    // 前置事实：Core 已经把该维度视为完成。
    expect(session.isComplete).toBe(true);

    const retry = await runHostAgentDimensionCompletionWorkflow(
      createContext(projectRoot),
      args,
      dependencies
    );
    expect(retry.success).toBe(true);
    const retryData = retry.data as Record<string, unknown>;
    expect(retryData.isBootstrapComplete).toBe(true);
    // Core 语义下重试是覆盖（updated=true），但 auto-sync 尚未成功运行过，必须执行。
    expect(retryData.updated).toBe(true);
    expect(refreshKnowledgeSkills).toHaveBeenCalledOnce();
    expect(retryData.knowledgeSkillAutoSync).toMatchObject({
      attempted: true,
      success: true,
      refreshedCount: 1,
    });

    const repeat = await runHostAgentDimensionCompletionWorkflow(
      createContext(projectRoot),
      args,
      dependencies
    );
    expect(repeat.success).toBe(true);
    expect(refreshKnowledgeSkills).toHaveBeenCalledOnce();
    expect((repeat.data as Record<string, unknown>).knowledgeSkillAutoSync).toMatchObject({
      attempted: false,
      reason: 'already-complete',
    });
  });

  it('re-runs the auto-sync on a repeat when the previous auto-sync failed', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-followup-autosync-'));
    tempRoots.push(projectRoot);
    pathGuard.configure({ projectRoot });

    const manager = getOrCreateSessionManager(createSessionContainer(projectRoot));
    const session = manager.createSession({
      projectRoot,
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectContext: { projectName: 'fix-followup-auto-sync-failed' },
    }) as unknown as HostAgentWorkflowSession;
    recordGroundedSubmissions(session);

    const refreshKnowledgeSkills = vi
      .fn()
      .mockReturnValueOnce({ success: false, message: 'export blocked', data: {} })
      .mockReturnValue({ success: true, data: { hasKnowledgeBase: true, refreshed: [] } });
    const dependencies = {
      getActiveSession: () => session,
      refreshKnowledgeSkills,
      runCompletionFinalizer: vi.fn(async () => undefined),
      saveCheckpoint: async () => undefined,
      createEmitter: () => ({
        emitDimensionComplete: vi.fn(),
        emitAllComplete: vi.fn(),
      }),
    };
    const args = {
      dimensionId: 'architecture',
      analysisText: longAnalysisText(),
      keyFindings: [
        'The source files expose the shared module boundary through architecture evidence.',
        'The package references show how runtime ownership is separated from plugin code.',
        'The completion path keeps checkpoint writes tied to verified recipe identifiers.',
      ],
    };

    const first = await runHostAgentDimensionCompletionWorkflow(
      createContext(projectRoot),
      args,
      dependencies
    );
    expect((first.data as Record<string, unknown>).knowledgeSkillAutoSync).toMatchObject({
      attempted: true,
      success: false,
    });

    const second = await runHostAgentDimensionCompletionWorkflow(
      createContext(projectRoot),
      args,
      dependencies
    );
    expect(refreshKnowledgeSkills).toHaveBeenCalledTimes(2);
    expect((second.data as Record<string, unknown>).knowledgeSkillAutoSync).toMatchObject({
      attempted: true,
      success: true,
    });
  });
});

function createSessionContainer(projectRoot: string) {
  const registry: Record<string, unknown> = {};
  return {
    get: (name: string) => registry[name],
    register: (name: string, factory: () => unknown) => {
      registry[name] = factory();
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: { dataRoot: projectRoot },
    },
  };
}

function createContext(projectRoot: string): HostAgentDimensionCompletionContext {
  return {
    container: {
      singletons: {
        _projectRoot: projectRoot,
        _dataRoot: projectRoot,
        _workspaceResolver: { dataRoot: projectRoot },
      },
      get: () => null,
    },
    projectRuntime: { identity: { dataRoot: projectRoot } },
  } as HostAgentDimensionCompletionContext;
}

function recordGroundedSubmissions(session: HostAgentWorkflowSession): void {
  const tracker = session.submissionTracker as unknown as {
    recordSubmission(
      dimId: string,
      submissionArgs: Record<string, unknown>,
      recipeId: string
    ): void;
  };
  const markdown = 'Grounded recipe guidance. '.repeat(30);
  const fixtures = [
    {
      recipeId: 'recipe-a',
      source: 'src/a.ts:10-20',
      type: 'pattern',
      category: 'arch',
      kind: 'rule',
    },
    {
      recipeId: 'recipe-b',
      source: 'packages/core/b.ts:5-15',
      type: 'convention',
      category: 'io',
      kind: 'pattern',
    },
    {
      recipeId: 'recipe-c',
      source: 'lib/c.ts:1-12',
      type: 'practice',
      category: 'ops',
      kind: 'fact',
    },
  ];
  for (const fixture of fixtures) {
    tracker.recordSubmission(
      'architecture',
      {
        title: fixture.recipeId,
        knowledgeType: fixture.type,
        category: fixture.category,
        kind: fixture.kind,
        coreCode: 'export const grounded = true;',
        content: { markdown },
        reasoning: { sources: [fixture.source], confidence: 0.9 },
      },
      fixture.recipeId
    );
  }
}

function longAnalysisText(): string {
  return [
    '## Architecture evidence',
    '',
    '1. The analysis walks the verified bootstrap path from source discovery into Recipe candidate production.',
    '2. Each candidate is tied to a concrete source reference so the dimension completion step can recover the submitted Recipe identifiers.',
    '3. The completion workflow writes checkpoints only after the session-bound Recipe ids, referenced files, and key findings all agree.',
    '',
    '```ts',
    'export function completeDimensionWithVerifiedRecipes() {',
    '  return "session-bound-evidence";',
    '}',
    '```',
    '',
    'The remaining text intentionally keeps this fixture above the production floor so the success path exercises the positive loop instead of the validation branch.',
  ].join('\n');
}
