import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const HOST_SKILL_FILES = [
  'plugins/alembic-codex/skills/alembic/SKILL.md',
  'plugins/alembic-codex/skills/alembic-create/SKILL.md',
  'plugins/alembic-codex/skills/alembic-guard/SKILL.md',
  'plugins/alembic-codex/skills/alembic-recipes/SKILL.md',
  'plugins/alembic-codex/skills/alembic-structure/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-create/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-guard/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-recipes/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-structure/SKILL.md',
  'skills/alembic-create/SKILL.md',
  'skills/alembic-guard/SKILL.md',
  'skills/alembic-recipes/SKILL.md',
  'skills/alembic-structure/SKILL.md',
] as const;

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('Codex skill ProjectContext guidance', () => {
  test('keeps built-in workflow skill aligned with live MCP guidance', () => {
    const content = readRepoFile('plugins/alembic-codex/skills/alembic/SKILL.md');

    expect(content).toContain('Treat MCP initialize instructions as the live playbook');
    expect(content).toContain('Use `alembic_recipe_map` and `alembic_graph`');
    expect(content).toContain('Recipe/knowledge tools for project standards');
    expect(content).toContain('raw reads/search');
    expect(content).toContain('alembic_search');
    expect(content).toContain('alembic_prime');
    expect(content).not.toContain('Use `alembic_project_matrix`');
    expect(content).not.toContain('four agent-facing public tools');
    expect(content).not.toContain('inputSchema');
    expect(content).not.toContain('additionalProperties');
  });

  test('keeps host-agnostic workflow skill byte-identical across shell packages', () => {
    const codexSkill = readRepoFile('plugins/alembic-codex/skills/alembic/SKILL.md');
    const claudeCodeSkill = readRepoFile(
      'plugins/alembic-claude-code/skills/alembic/SKILL.md'
    );

    expect(claudeCodeSkill).toBe(codexSkill);
  });

  test('keeps structure skills short and routes structure through recipe_map and project graph', () => {
    const pluginSkill = readRepoFile('plugins/alembic-codex/skills/alembic-structure/SKILL.md');
    const claudeCodeSkill = readRepoFile(
      'plugins/alembic-claude-code/skills/alembic-structure/SKILL.md'
    );
    const injectableSkill = readRepoFile('skills/alembic-structure/SKILL.md');

    for (const content of [pluginSkill, claudeCodeSkill, injectableSkill]) {
      expect(content).toContain('ProjectContext');
      expect(content).toContain('alembic_recipe_map');
      expect(content).toContain('alembic_graph');
      expect(content).toContain('queryKind');
      expect(content).toContain('file-symbols');
      expect(content).toContain('fromRefId');
      expect(content).toContain('current source proof');
      expect(content).not.toContain('alembic_project_matrix');
      expect(content).not.toContain('alembic_graph(operation');
      expect(content).not.toContain('alembic_graph(operation:');
      expect(content).not.toContain('nodeId`, optional `relationType');
      expect(content).not.toContain('alembic_source_graph_status');
      expect(content).not.toContain('SourceGraphSearchInput');
      expect(content).not.toContain('SourceGraphAffectedTestsInput');
      expect(content).not.toContain('Recipe graph');
    }
  });

  test('keeps all Codex skills free of retired tool names and stale diagnostics', () => {
    for (const relativePath of HOST_SKILL_FILES) {
      const content = readRepoFile(relativePath);

      expect(content, relativePath).not.toContain('alembic_project_matrix');
      expect(content, relativePath).not.toContain('alembic_health');
      expect(content, relativePath).not.toContain('alembic_codex_diagnostics');
      expect(content, relativePath).not.toContain('alembic_mcp_status');
      expect(content, relativePath).not.toContain('matrix navigation');
      expect(content, relativePath).not.toContain('Project matrix');
    }
  });

  test('keeps Claude Code skills free of Codex-facing wording', () => {
    for (const relativePath of HOST_SKILL_FILES.filter((file) =>
      file.startsWith('plugins/alembic-claude-code/')
    )) {
      const content = readRepoFile(relativePath);

      expect(content, relativePath).not.toContain('Codex');
      expect(content, relativePath).not.toContain('codex');
    }
  });
});
