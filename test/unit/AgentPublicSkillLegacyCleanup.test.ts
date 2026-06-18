import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';

const activeHostGuidanceFiles = [
  '../../README.md',
  '../../README_CN.md',
  '../../SOUL.md',
  '../../plugins/alembic-codex/README.md',
  '../../plugins/alembic-codex/README.zh-CN.md',
  '../../plugins/alembic-codex/RELEASE-PLAYBOOK.md',
  '../../plugins/alembic-codex/skills/alembic/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-create/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-recipes/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-guard/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-structure/SKILL.md',
  '../../skills/alembic-create/SKILL.md',
  '../../skills/alembic-recipes/SKILL.md',
  '../../skills/alembic-guard/SKILL.md',
  '../../skills/alembic-structure/SKILL.md',
] as const;

const legacyCompatibilityGuidanceFiles = [
  '../../plugins/alembic-codex/skills/alembic/SKILL.md',
] as const;

const forbiddenPrimaryLifecycleGuidance = [
  'operation=prime',
  'operation=create',
  'operation=close',
  'record_decision',
  'prime/create/close',
  'Task and decision management (5 operations)',
  'primary action is `alembic_task`',
  'alembic_task(operation: "prime")',
  'alembic_task(operation: "create")',
  'alembic_task(operation: "close")',
  'alembic_task(operation: "record_decision")',
  'alembic_task` with `operation',
] as const;

const scopedGuardGuidanceFiles = [
  '../../skills/alembic-guard/SKILL.md',
  '../../skills/alembic-recipes/SKILL.md',
  '../../plugins/alembic-codex/skills/alembic-guard/SKILL.md',
] as const;

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('AFAPI Stage 5 skill and legacy cleanup', () => {
  test('active host guidance uses agent-facing public tools instead of old task operation entrypoints', () => {
    for (const relativePath of activeHostGuidanceFiles) {
      const content = readFixture(relativePath);

      for (const forbidden of forbiddenPrimaryLifecycleGuidance) {
        expect(content, `${relativePath} should not advertise ${forbidden}`).not.toContain(
          forbidden
        );
      }
      if (!legacyCompatibilityGuidanceFiles.includes(relativePath)) {
        expect(
          content,
          `${relativePath} should not mention hidden legacy alembic_task`
        ).not.toContain('alembic_task');
      }
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
    expect(mainSkill).toContain('`alembic_task` is retired');
    expect(mainSkill).toContain('CODEX_TOOL_RETIRED');
    expect(mainSkill).toContain('six agent-facing public tools');
    expect(mainSkill).toContain('clean `structuredContent`');
  });

  test('active tool descriptions remove alembic_task from the public surface', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.description]));

    expect(byName.has('alembic_task')).toBe(false);
    expect(byName.has('alembic_intent')).toBe(false);
    expect(byName.has('alembic_decision_record')).toBe(false);
    for (const toolName of ['alembic_prime', 'alembic_work', 'alembic_code_guard']) {
      expect(byName.has(toolName)).toBe(true);
    }
    expect(JSON.stringify([...byName])).not.toContain(
      'Task and decision management (5 operations)'
    );
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
