/**
 * W3e-3 回归：MCP initialize instructions 的 Onboarding 行必须与工具说明的冷启动顺序一致：
 * alembic_status → 未初始化时 alembic_init → alembic_plan draft/confirm → alembic_bootstrap。
 * 不可见的工具不得被点名（只描述实际可见的工具面），并保持一行、不膨胀。
 */
import { describe, expect, test } from 'vitest';
import { buildMcpGuidance } from '#host-runtime/mcp/host/guidance.js';
import { getToolCatalog } from '#host-runtime/mcp/host/tool-catalog.js';

function onboardingLine(toolNames: readonly string[]): string {
  const guidance = buildMcpGuidance(toolNames.map((name) => ({ name })));
  const line = guidance.playbook.find((entry) => entry.startsWith('Onboarding:'));
  expect(line).toBeDefined();
  return String(line);
}

describe('W3e-3: initialize onboarding follows status -> init -> plan -> bootstrap', () => {
  test('full catalog: onboarding names the tools in cold-start order', () => {
    const line = onboardingLine(getToolCatalog().map((tool) => tool.name));
    const status = line.indexOf('alembic_status');
    const init = line.indexOf('alembic_init');
    const plan = line.indexOf('alembic_plan');
    const bootstrap = line.indexOf('alembic_bootstrap');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(init).toBeGreaterThan(status);
    expect(plan).toBeGreaterThan(init);
    expect(bootstrap).toBeGreaterThan(plan);
    expect(line).toMatch(/uninitialized/i);
    expect(line).toMatch(/draft/);
    expect(line).toMatch(/confirm/);
    // 不膨胀：仍然是单行，长度受控。
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(420);
  });

  test('instructions never send an uninitialized project straight to bootstrap', () => {
    const guidance = buildMcpGuidance(getToolCatalog());
    expect(guidance.instructions).not.toMatch(/read `alembic_status`\/`alembic_bootstrap`/);
  });

  test('invisible lifecycle tools are not named in the onboarding line', () => {
    const line = onboardingLine(['alembic_status', 'alembic_search']);
    expect(line).toContain('alembic_status');
    expect(line).not.toContain('alembic_init');
    expect(line).not.toContain('alembic_plan');
    expect(line).not.toContain('alembic_bootstrap');
  });
});
