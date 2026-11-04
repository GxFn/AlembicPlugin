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

// 回归：Core GenerateSession.markDimensionComplete 的 updated=true 表示「覆盖已完成维度」。
// 末维度首次完成（updated=false）必须触发 knowledge skill auto-sync，重复提交才跳过。
// 这里直接驱动真实 Core GenerateSession，避免测试替身再次倒置 updated 语义。

const tempRoots: string[] = [];

afterEach(() => {
  _resetGenerateSessionManagersForTesting();
  _resetKnowledgeSkillAutoSyncLedgerForTesting();
  pathGuard._reset();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('final dimension knowledge-skill auto-sync (real Core GenerateSession)', () => {
  it('auto-syncs on the first final completion and skips only the re-completion', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-dim-autosync-'));
    tempRoots.push(projectRoot);
    pathGuard.configure({ projectRoot });

    const manager = getOrCreateSessionManager(createSessionContainer(projectRoot));
    const session = manager.createSession({
      projectRoot,
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectContext: { projectName: 'fix-dimension-auto-sync' },
    });
    recordGroundedSubmissions(session as unknown as HostAgentWorkflowSession);

    const refreshKnowledgeSkills = vi.fn(() => ({
      success: true,
      message: 'refreshed',
      data: {
        hasKnowledgeBase: true,
        refreshed: [{ skillName: 'alembic-recipes', success: true }],
      },
    }));
    const runCompletionFinalizer = vi.fn(async () => undefined);
    const dependencies = {
      getActiveSession: () => session as unknown as HostAgentWorkflowSession,
      refreshKnowledgeSkills,
      runCompletionFinalizer,
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

    expect(first.success).toBe(true);
    const firstData = first.data as Record<string, unknown>;
    expect(firstData.isBootstrapComplete).toBe(true);
    // Core 语义：首次完成不是覆盖，updated=false。
    expect(firstData.updated).toBe(false);
    expect(refreshKnowledgeSkills).toHaveBeenCalledOnce();
    expect(firstData.knowledgeSkillAutoSync).toMatchObject({
      attempted: true,
      success: true,
      hasKnowledgeBase: true,
      refreshedCount: 1,
    });

    const second = await runHostAgentDimensionCompletionWorkflow(
      createContext(projectRoot),
      args,
      dependencies
    );

    expect(second.success).toBe(true);
    const secondData = second.data as Record<string, unknown>;
    expect(secondData.updated).toBe(true);
    expect(refreshKnowledgeSkills).toHaveBeenCalledOnce();
    expect(secondData.knowledgeSkillAutoSync).toMatchObject({
      attempted: false,
      reason: 'already-complete',
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
