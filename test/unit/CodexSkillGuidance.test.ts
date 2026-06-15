import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('Codex skill ProjectContext guidance', () => {
  test('keeps built-in workflow skill aligned with live MCP guidance', () => {
    const content = readRepoFile('plugins/alembic-codex/skills/alembic/SKILL.md');

    expect(content).toContain('Treat MCP initialize instructions as the live playbook');
    expect(content).toContain('Use `alembic_project_matrix` and `alembic_graph`');
    expect(content).toContain('Recipe/knowledge tools for project standards');
    expect(content).toContain('raw reads/search');
    expect(content).not.toContain('inputSchema');
    expect(content).not.toContain('additionalProperties');
  });

  test('keeps structure skills short and routes structure through matrix and project graph', () => {
    const pluginSkill = readRepoFile('plugins/alembic-codex/skills/alembic-structure/SKILL.md');
    const injectableSkill = readRepoFile('skills/alembic-structure/SKILL.md');

    for (const content of [pluginSkill, injectableSkill]) {
      expect(content).toContain('ProjectContext');
      expect(content).toContain('alembic_project_matrix');
      expect(content).toContain('alembic_graph');
      expect(content).toContain('current source proof');
      expect(content).not.toContain('alembic_source_graph_status');
      expect(content).not.toContain('SourceGraphSearchInput');
      expect(content).not.toContain('SourceGraphAffectedTestsInput');
      expect(content).not.toContain('Recipe graph');
    }
  });
});
