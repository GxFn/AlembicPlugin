import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES } from '../../lib/host-runtime/index.js';
import { buildMcpGuidance } from '../../lib/host-runtime/mcp/host/guidance.js';
import { listPluginToolSurfaceCatalog } from '../../lib/host-runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/host-runtime/mcp/tools.js';
import { zodToMcpSchema } from '../../lib/host-runtime/mcp/zodToMcpSchema.js';
import { buildStatusOnboardingContract } from '../../lib/host-runtime/status/OnboardingContract.js';
import {
  GraphInput,
  PrimeInput,
  RecipeMapInput,
  SearchInput,
} from '../../lib/shared/schemas/mcp-tools.js';

const ROOT = process.cwd();

const publicKnowledgeNavigationToolNames = [...PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES];
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

  test('describes knowledge tools with user-intent wording while preserving contracts', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

    expect(byName.get('alembic_prime')?.description).toContain(
      'Prime code-development Recipe context.'
    );
    expect(firstLine(byName.get('alembic_recipe_map')?.description)).toBe(
      'Use when the user asks which Recipes govern a code region, file, or module before editing; map Recipes onto a bounded ProjectContext region (replaces alembic_project_matrix). Pick a focus {kind: space|repo|map|module|file|symbol|anchor, refId/filePath/line}:'
    );
    expect(firstLine(byName.get('alembic_search')?.description)).toBe(
      'Use to pull exact Recipe/knowledge detail when the user asks about a project standard, convention, prior decision, or known rule; search, get, or expand compact Recipe / knowledge context.'
    );
    expect(firstLine(byName.get('alembic_graph')?.description)).toBe(
      'Use before changing code when the user asks for imports, dependencies, impact, structure, call paths, files, symbols, or project relations; run pure ProjectContext graph queries over project structure, packages, modules, source files, symbols, and stable refs. Select a queryKind:'
    );

    expect(byName.get('alembic_recipe_map')?.description).toContain(
      '• recipeMounts — Recipes mounted deterministically onto nodes via recipe_source_refs + explicit metadata only (never semantic/keyword); full mountType enum + reason'
    );
    expect(byName.get('alembic_search')?.description).toContain(
      '• expand — expand one detailRef without broad search fallback'
    );
    expect(byName.get('alembic_search')?.description).toContain(
      'Non-goal: no host-intent relevance, relation-chain traversal, prime context material, usage-confirmation operations, lifecycle mutation, or full Recipe browsing.'
    );
    expect(byName.get('alembic_graph')?.description).toContain(
      'Returns a Recipe-free AlembicGraphOutput (nodes, relations, ProjectContext refs, optional slices, diagnostics). Non-goal: no Recipe ids/summaries/mounts/relation-chains, no search scores, no semantic prime, no knowledge categories.'
    );

    const schemaInputs = {
      alembic_prime: PrimeInput,
      alembic_recipe_map: RecipeMapInput,
      alembic_search: SearchInput,
      alembic_graph: GraphInput,
    } as const;
    for (const [name, schema] of Object.entries(schemaInputs)) {
      expect(byName.get(name)?.inputSchema).toEqual(zodToMcpSchema(schema));
    }
  });

  test('builds initialize guidance from the four public knowledge context tools', () => {
    const guidance = buildMcpGuidance(TOOLS);

    expect(guidance.knowledgeTools.sort()).toEqual(publicKnowledgeNavigationToolNames.sort());
    expect(guidance.instructions).toContain('recipe_map');
    expect(guidance.instructions).toContain('alembic_graph for ProjectContext-backed');
    expect(guidance.instructions).toContain('Project knowledge consumption');
    expect(guidance.instructions).toContain('call `alembic_search` first');
    for (const toolName of legacyPublicKnowledgeToolNames) {
      expect(guidance.instructions).not.toContain(toolName);
    }
    expect(guidance.instructions).not.toContain('Recipe graph');
  });

  test('stages prime recommendedQueries consumption through search before coding', () => {
    const contract = buildStatusOnboardingContract({ projectRoot: '/tmp/alembic-plugin' });
    const hostAgentContract = contract.hostAgentContract as { stagedProtocol?: string[] };

    expect(hostAgentContract.stagedProtocol).toEqual(
      expect.arrayContaining([
        expect.stringContaining('consume them with alembic_search before coding'),
      ])
    );
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

function firstLine(value: string | undefined): string {
  return value?.split('\n')[0] ?? '';
}
