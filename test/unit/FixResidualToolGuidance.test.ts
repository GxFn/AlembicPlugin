/**
 * R2a 回归：已发布的工具说明必须与 wave-1 行为一致——
 * 未初始化项目（无知识库数据库）的 embedded 写工具返回 PROJECT_NOT_INITIALIZED 并指向 alembic_init；
 * alembic_bootstrap 需要 alembic_plan draft → confirm 产出的 planSelection。
 * 因此“知识为空就直接调用 alembic_bootstrap”的旧引导不能再出现在 tools/list 中。
 */
import { describe, expect, test } from 'vitest';
import { getToolCatalog } from '#host-runtime/mcp/host/tool-catalog.js';

function descriptionOf(name: string): string {
  const tool = getToolCatalog().find((entry) => entry.name === name);
  expect(tool, name).toBeDefined();
  return String(tool?.description ?? '');
}

describe('published cold-start guidance follows init → plan → bootstrap', () => {
  test('alembic_status points uninitialized projects to alembic_init and empty ones to plan then bootstrap', () => {
    const description = descriptionOf('alembic_status');
    expect(description).not.toContain('cold-start is needed (call alembic_bootstrap)');
    const init = description.indexOf('alembic_init');
    const plan = description.indexOf('alembic_plan');
    const bootstrap = description.indexOf('alembic_bootstrap');
    expect(init).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(init);
    expect(bootstrap).toBeGreaterThan(plan);
    expect(description).toMatch(/confirm/);
  });

  test('alembic_bootstrap and alembic_plan state the initialization prerequisite', () => {
    for (const name of ['alembic_bootstrap', 'alembic_plan']) {
      expect(descriptionOf(name), name).toContain('alembic_init');
    }
    expect(descriptionOf('alembic_bootstrap')).toContain('alembic_plan confirm');
  });

  test('no published description sends an empty or uninitialized project straight to alembic_bootstrap', () => {
    for (const tool of getToolCatalog()) {
      const description = String(tool.description ?? '');
      expect(description, tool.name).not.toMatch(/empty[^.]*call alembic_bootstrap\)/i);
    }
  });
});
