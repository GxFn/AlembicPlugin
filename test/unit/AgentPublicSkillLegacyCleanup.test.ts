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

const scopedGuardGuidanceFiles = [
  '../../injectable-skills/alembic-guard/SKILL.md',
  '../../injectable-skills/alembic-recipes/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-guard/SKILL.md',
  '../../plugins/alembic-codex/runtime/injectable-skills/alembic-guard/SKILL.md',
  '../../plugins/alembic-codex/runtime/injectable-skills/alembic-recipes/SKILL.md',
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
    expect(mainSkill).toContain('not advertised as a public workflow surface');
    expect(mainSkill).toContain('six agent-facing public tools');
  });

  test('active tool descriptions remove alembic_task from the public surface', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.description]));

    expect(byName.has('alembic_task')).toBe(false);
    for (const toolName of [
      'alembic_intent',
      'alembic_prime',
      'alembic_work_start',
      'alembic_work_finish',
      'alembic_code_guard',
      'alembic_decision_record',
    ]) {
      expect(byName.has(toolName)).toBe(true);
    }
    expect(JSON.stringify([...byName])).not.toContain(
      'Task and decision management (5 operations)'
    );
    expect(byName.get('alembic_guard') ?? '').not.toContain('alembic_task');
    expect(byName.get('alembic_guard') ?? '').toContain('no params → blocked');
    expect(byName.get('alembic_code_guard') ?? '').toContain('workRef');
    expect(byName.get('alembic_code_guard') ?? '').toContain('Does not accept diffRef');
  });

  test('scoped guard guidance no longer presents legacy alembic_guard as the primary entry', () => {
    for (const relativePath of scopedGuardGuidanceFiles) {
      const content = readFixture(relativePath);

      expect(content, relativePath).toContain('alembic_code_guard');
      expect(content, relativePath).not.toContain('## MCP Tool: `alembic_guard`');
      expect(content, relativePath).not.toContain('MCP `alembic_guard`');
      expect(content, relativePath).not.toContain('`alembic_guard` with code');
      expect(content, relativePath).not.toContain('`alembic_guard` with file paths');
    }
  });
});
