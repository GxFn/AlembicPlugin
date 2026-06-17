import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CODEX_PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES } from '../../lib/runtime/index.js';
import { buildCodexMcpGuidance } from '../../lib/runtime/mcp/host/guidance.js';
import { listPluginToolSurfaceCatalog } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';

const ROOT = process.cwd();

const publicKnowledgeNavigationToolNames = [...CODEX_PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES];
const legacyPublicKnowledgeToolNames = [
  'alembic_knowledge',
  'alembic_structure',
  'alembic_call_context',
  'alembic_panorama',
] as const;

const activeGuidanceFiles = [
  'skills/alembic-create/SKILL.md',
  'skills/alembic-recipes/SKILL.md',
  'skills/alembic-guard/SKILL.md',
  'skills/alembic-structure/SKILL.md',
  'plugins/alembic-codex/skills/alembic/SKILL.md',
  'plugins/alembic-codex/skills/alembic-create/SKILL.md',
  'plugins/alembic-codex/skills/alembic-recipes/SKILL.md',
  'plugins/alembic-codex/skills/alembic-guard/SKILL.md',
  'plugins/alembic-codex/skills/alembic-structure/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-create/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-recipes/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-guard/SKILL.md',
  'plugins/alembic-claude-code/skills/alembic-structure/SKILL.md',
  'templates/recipes-setup/README.md',
] as const;

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('public knowledge context surface guidance', () => {
  test('keeps default tool and catalog knowledge navigation surface to the four public tools', () => {
    const toolNames = TOOLS.map((tool) => tool.name);
    const catalog = listPluginToolSurfaceCatalog();
    const catalogNames = catalog.map((entry) => entry.name);

    for (const toolName of publicKnowledgeNavigationToolNames) {
      expect(toolNames).toContain(toolName);
      expect(catalogNames).toContain(toolName);
    }
    for (const toolName of legacyPublicKnowledgeToolNames) {
      expect(toolNames).not.toContain(toolName);
      expect(catalogNames).not.toContain(toolName);
    }

    for (const entry of catalog.filter((item) =>
      publicKnowledgeNavigationToolNames.includes(item.name)
    )) {
      expect(entry.annotations.readOnlyHint, entry.name).toBe(true);
    }

    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.description]));
    expect(byName.get('alembic_search')).not.toMatch(/confirm_usage|insights/);
    expect(byName.get('alembic_graph')).not.toMatch(
      /Recipe graph|coveredByKnowledge|hasGap|knowledge_edges/
    );
  });

  test('builds initialize guidance from the four public knowledge context tools', () => {
    const guidance = buildCodexMcpGuidance(TOOLS);

    expect(guidance.knowledgeTools.sort()).toEqual(publicKnowledgeNavigationToolNames.sort());
    expect(guidance.instructions).toContain('recipe_map');
    expect(guidance.instructions).toContain('alembic_graph for ProjectContext-backed');
    for (const toolName of legacyPublicKnowledgeToolNames) {
      expect(guidance.instructions).not.toContain(toolName);
    }
    expect(guidance.instructions).not.toContain('Recipe graph');
  });

  test('keeps active skill and template guidance off legacy public knowledge tools', () => {
    const forbiddenPatterns = [
      /\balembic_knowledge\b(?!_lifecycle)/,
      /\balembic_structure\b/,
      /\balembic_panorama\b/,
      /\bconfirm_usage\b/,
      /Recipe graph/i,
      /knowledge graph/i,
    ];

    for (const relativePath of activeGuidanceFiles) {
      const content = readRepoFile(relativePath);
      for (const pattern of forbiddenPatterns) {
        expect(content, `${relativePath} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
