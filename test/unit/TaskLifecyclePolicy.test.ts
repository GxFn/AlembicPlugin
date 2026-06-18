import { describe, expect, test } from 'vitest';
import {
  classifyTaskLifecycleInput,
  decideGuardTrigger,
} from '../../lib/service/task/TaskLifecyclePolicy.js';

// PDR-1d: classifyTaskLifecycleInput is decoupled from the retired HostIntentFrame
// intake; it now classifies from operation + raw/normalized userQuery only.
const RAW_DELEGATION = `<codex_delegation>
  <input>继续当前窗口任务：AlembicPlugin / PCTL-STAGE1-PLUGIN-P1。
  dispatchGroup: PCTL-STAGE1-PLUGIN-IMPLEMENTATION-20260603
  taskId: PCTL-STAGE1-PLUGIN-P1</input>
</codex_delegation>`;

describe('TaskLifecyclePolicy', () => {
  test('classifies raw automation envelopes and skips prime', () => {
    const result = classifyTaskLifecycleInput({
      operation: 'prime',
      rawUserQuery: RAW_DELEGATION,
      userQuery: RAW_DELEGATION,
    });

    expect(result.inputSource).toBe('automation-envelope');
    expect(result.intentKind).toBe('automation-control');
    expect(result.primeDecision.action).toBe('skip');
  });

  test('runs prime for an explicit code-change requirement query', () => {
    const result = classifyTaskLifecycleInput({
      operation: 'prime',
      userQuery: 'Implement Codex-aware task lifecycle policy',
    });

    expect(result.inputSource).toBe('user-intent');
    expect(result.intentKind).toBe('code-change-task');
    expect(result.primeDecision).toMatchObject({
      action: 'run',
      curatedQuery: 'Implement Codex-aware task lifecycle policy',
      reasonCode: 'knowledge-ready-code-task',
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
