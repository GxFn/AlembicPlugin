import { describe, expect, test } from 'vitest';
import {
  buildHostIntentFrame,
  prepareHostIntentInput,
} from '../../lib/service/task/HostIntentFrame.js';
import { extract as extractIntent } from '../../lib/service/task/IntentExtractor.js';
import {
  classifyTaskLifecycleInput,
  decideGuardTrigger,
} from '../../lib/service/task/TaskLifecyclePolicy.js';

const RAW_DELEGATION = `<codex_delegation>
  <input>继续当前窗口任务：AlembicPlugin / PCTL-STAGE1-PLUGIN-P1。
  dispatchGroup: PCTL-STAGE1-PLUGIN-IMPLEMENTATION-20260603
  taskId: PCTL-STAGE1-PLUGIN-P1</input>
</codex_delegation>`;

function hostFrame(input: Parameters<typeof prepareHostIntentInput>[0]) {
  const prepared = prepareHostIntentInput(input);
  const extracted = extractIntent(prepared.userQuery, prepared.activeFile, prepared.language);
  return {
    frame: buildHostIntentFrame(prepared, extracted),
    prepared,
  };
}

describe('TaskLifecyclePolicy', () => {
  test('skips prime and task anchor for raw automation envelopes without curated intent', () => {
    const { frame, prepared } = hostFrame({ userQuery: RAW_DELEGATION });

    const result = classifyTaskLifecycleInput({
      hostIntentFrame: frame,
      operation: 'prime',
      rawUserQuery: RAW_DELEGATION,
      userQuery: prepared.userQuery,
    });

    expect(result.inputSource).toBe('automation-envelope');
    expect(result.intentKind).toBe('automation-control');
    expect(result.primeDecision).toMatchObject({
      action: 'skip',
      reasonCode: 'no-semantic-query',
    });
    expect(result.taskAnchorDecision).toMatchObject({
      action: 'skip',
      reasonCode: 'automation-envelope-no-anchor',
    });
  });

  test('uses hostDeclaredIntent to recover semantic intent from raw automation envelopes', () => {
    const { frame, prepared } = hostFrame({
      userQuery: RAW_DELEGATION,
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.82,
        keywords: ['task lifecycle', 'guard'],
        query: 'Implement Codex-aware task lifecycle policy',
        sourceRefs: ['lib/runtime/mcp/handlers/task.ts'],
      },
    });

    const result = classifyTaskLifecycleInput({
      hostIntentFrame: frame,
      operation: 'prime',
      rawUserQuery: RAW_DELEGATION,
      userQuery: prepared.userQuery,
    });

    expect(prepared.userQuery).toBe('Implement Codex-aware task lifecycle policy');
    expect(result.inputSource).toBe('user-intent');
    expect(result.intentKind).toBe('code-change-task');
    expect(result.primeDecision).toMatchObject({
      action: 'run',
      curatedQuery: 'Implement Codex-aware task lifecycle policy',
      reasonCode: 'knowledge-ready-code-task',
      sourceRefs: ['lib/runtime/mcp/handlers/task.ts'],
    });
    expect(result.taskAnchorDecision).toMatchObject({
      action: 'create',
      reasonCode: 'explicit-code-change',
    });
  });

  test('classifies status and design turns as no task-anchor work', () => {
    const status = classifyTaskLifecycleInput({
      operation: 'prime',
      userQuery: 'status update only',
    });
    const design = classifyTaskLifecycleInput({
      operation: 'prime',
      userQuery: 'draft an interface contract dossier',
    });

    expect(status.intentKind).toBe('status-report');
    expect(status.taskAnchorDecision).toMatchObject({
      action: 'skip',
      reasonCode: 'status-only-no-anchor',
    });
    expect(design.intentKind).toBe('design-discussion');
    expect(design.taskAnchorDecision).toMatchObject({
      action: 'skip',
      reasonCode: 'readonly-no-anchor',
    });
  });

  test('runs Guard only for task-scoped guard-relevant code diffs', () => {
    expect(
      decideGuardTrigger({
        changedFiles: [],
        taskAnchorExists: true,
        taskScopeFiles: ['src/index.ts'],
      })
    ).toMatchObject({ action: 'skip', reasonCode: 'no-code-diff' });

    expect(
      decideGuardTrigger({
        changedFiles: ['docs/README.md'],
        taskAnchorExists: true,
        taskScopeFiles: ['docs/README.md'],
      })
    ).toMatchObject({ action: 'skip', reasonCode: 'docs-only-diff' });

    expect(
      decideGuardTrigger({
        changedFiles: ['src/index.ts'],
        taskAnchorExists: true,
        taskScopeFiles: ['src/other.ts'],
      })
    ).toMatchObject({ action: 'skip', reasonCode: 'unrelated-dirty-diff' });

    expect(
      decideGuardTrigger({
        changedFiles: ['src/index.ts', 'docs/README.md'],
        taskAnchorExists: true,
        taskScopeFiles: ['src/index.ts'],
      })
    ).toMatchObject({
      action: 'run',
      reasonCode: 'task-scoped-code-diff',
      taskScopedFiles: ['src/index.ts'],
    });
  });
});
