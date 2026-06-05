import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { TOOLS } from '../../lib/codex/mcp/tools.js';

const shippedGuidanceFiles = [
  '../../plugins/alembic-codex/skills/alembic/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-recipes/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-guard/SKILL.md',
  '../../plugins/alembic-codex/README.md',
  '../../plugins/alembic-codex/README.zh-CN.md',
  '../../plugins/alembic-codex/RELEASE-PLAYBOOK.md',
] as const;

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('AFAPI Stage 5 skill and legacy cleanup', () => {
  test('shipped Codex guidance uses agent-facing public tools instead of old task operation entrypoints', () => {
    for (const relativePath of shippedGuidanceFiles) {
      const content = readFixture(relativePath);

      expect(content, relativePath).not.toContain('operation=prime');
      expect(content, relativePath).not.toContain('operation=create');
      expect(content, relativePath).not.toContain('operation=close');
      expect(content, relativePath).not.toContain('alembic_task(operation: "close")');
      expect(content, relativePath).not.toContain('alembic_task` with `operation');
    }

    const mainSkill = readFixture('../../plugins/alembic-codex/skills/alembic/SKILL.md');
    for (const toolName of [
      'alembic_intent',
      'alembic_prime',
      'alembic_work_start',
      'alembic_work_finish',
      'alembic_code_guard',
      'alembic_decision_record',
    ]) {
      expect(mainSkill).toContain(toolName);
    }
    expect(mainSkill).toContain('legacy compatibility hook');
    expect(mainSkill).toContain('Do not use it as the primary workflow guide');
  });

  test('active tool descriptions downgrade alembic_task to compatibility and keep new tools primary', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.description]));
    const taskDescription = byName.get('alembic_task') ?? '';

    expect(taskDescription).toContain('Legacy compatibility task lifecycle surface');
    for (const toolName of [
      'alembic_intent',
      'alembic_prime',
      'alembic_work_start',
      'alembic_work_finish',
      'alembic_code_guard',
      'alembic_decision_record',
    ]) {
      expect(taskDescription).toContain(toolName);
    }
    expect(taskDescription).not.toContain('Task and decision management (5 operations)');
    expect(taskDescription).not.toContain('• prime');
    expect(taskDescription).not.toContain('• create');
    expect(taskDescription).not.toContain('• close');
    expect(byName.get('alembic_guard') ?? '').not.toContain('alembic_task');
  });
});
