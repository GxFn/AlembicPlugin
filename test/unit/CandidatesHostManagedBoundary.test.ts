import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routeSource = () =>
  readFileSync(join(process.cwd(), 'lib/http/routes/candidates.ts'), 'utf8');

describe('Candidates route host-managed boundary source contract', () => {
  it('keeps the legacy Dashboard-compatible code while adding canonical boundary helpers', () => {
    const source = routeSource();

    expect(source).toContain('LEGACY_HOST_AI_MANAGED_CODE');
    expect(source).toContain('HOST_AGENT_MANAGED_CODE');
    expect(source).toContain('attachHostAgentManagedBoundary');
    expect(source).toContain('makeHostAgentManagedError');
    expect(source).toContain('canonicalReason: HOST_AGENT_MANAGED_CODE');
    expect(source).toContain('boundaryCode: HOST_AGENT_MANAGED_CODE');
  });

  it('does not restore local candidate AI execution wording', () => {
    const source = routeSource();

    expect(source).toContain('不执行本地候选 AI 补齐');
    expect(source).toContain('不再由 AlembicPlugin 本地 AI 执行');
    expect(source).toContain('Codex host agent 或 Alembic resident service');
    expect(source).not.toContain('请由宿主 agent 生成 preview');
  });
});
