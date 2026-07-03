import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  RECIPE_GENERATION_CONFIRMED_PLAN_PRECONDITION,
  RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES,
  RECIPE_GENERATION_SKELETON_CONTRACT,
  RECIPE_GENERATION_STATE_PROJECTION_SOURCES,
  RECIPE_GENERATION_SUBSYSTEM_ROOT,
} from '#recipe-pipeline/contracts.js';
import { PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES } from '../../lib/runtime/index.js';
import { listPluginToolSurfaceCatalog } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const planToolName = 'alembic_plan';
const rg9AdapterPaths = [] as const;

const rg9ImplementationPaths = [
  'lib/recipe-pipeline/generate/cold-start.ts',
  'lib/recipe-pipeline/generate/dimension-completion.ts',
  'lib/recipe-pipeline/generate/knowledge-rescan.ts',
  'lib/recipe-pipeline/generate/project-context-analysis.ts',
  'lib/recipe-pipeline/generate/project-data-root.ts',
  'lib/recipe-pipeline/curate/recipe-evidence-gate.ts',
  'lib/recipe-pipeline/generate/recipe-region-vector.ts',
  'lib/recipe-pipeline/generate/runtime/GenerateEventEmitter.ts',
  'lib/recipe-pipeline/generate/runtime/GenerateTaskManager.ts',
  'lib/recipe-pipeline/vector/LocalEmbedding.ts',
  'lib/recipe-pipeline/sustain/HostAgentFileChangeHandler.ts',
  'lib/recipe-pipeline/sustain/PluginOpportunisticEvolution.ts',
  'lib/recipe-pipeline/sustain/git-diff-checkpoint/index.ts',
] as const;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('RG-0 recipe generation skeleton', () => {
  test('homes future Recipe generation contracts in the new internal subsystem', () => {
    expect(RECIPE_GENERATION_SUBSYSTEM_ROOT).toBe('lib/recipe-pipeline');
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.subsystemRoot).toBe(
      RECIPE_GENERATION_SUBSYSTEM_ROOT
    );
    expect(sorted(RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES)).toEqual(
      sorted(PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES)
    );
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.projectContext).toMatchObject({
      role: 'source-of-project-facts',
    });
  });

  test('keeps Plan as the future authority and generation-state as a DB projection', () => {
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.plan).toMatchObject({
      authority: 'confirmed-plan-living-ledger',
      rg0Status: 'future-contract-only',
    });
    expect(RECIPE_GENERATION_CONFIRMED_PLAN_PRECONDITION).toMatchObject({
      currentRg0Behavior: 'contract-only',
      enforcedFromPackage: 'RG-3',
      requirement: 'confirmed-plan',
    });
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.generationState).toEqual({
      model: 'read-time-db-projection',
      persistenceRule: 'projected-from-db-not-double-written',
      projectionSources: RECIPE_GENERATION_STATE_PROJECTION_SOURCES,
    });
    expect(RECIPE_GENERATION_STATE_PROJECTION_SOURCES).toEqual([
      'knowledge_entries',
      'recipe_source_refs',
      'evolution_proposals',
      'lifecycle_transition_events',
    ]);
  });

  test('declares only the confirmed future stages and leaves RG-0 behavior unchanged', () => {
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.stages).toEqual([
      {
        firstImplementationPackage: 'RG-4',
        kind: 'cold-start',
        planRequired: true,
      },
      {
        firstImplementationPackage: 'RG-4/RG-5',
        kind: 'rescan',
        planRequired: true,
        rescanModes: ['deep-mining', 'module-mining'],
      },
      {
        firstImplementationPackage: 'RG-8',
        kind: 'evolution',
        planRequired: true,
      },
    ]);
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.rg0Boundary).toMatchObject({
      productionBehaviorChanges: [],
      publicMcpSurfaceChanges: [],
    });
  });

  test('publishes the RG-3 alembic_plan tool while preserving the RG-0 historical boundary record', () => {
    const toolNames = new Set(TOOLS.map((tool) => tool.name));
    const catalogNames = new Set(listPluginToolSurfaceCatalog().map((entry) => entry.name));
    const schemaNames = new Set(Object.keys(TOOL_SCHEMAS));

    expect(toolNames.has(planToolName)).toBe(true);
    expect(catalogNames.has(planToolName)).toBe(true);
    expect(schemaNames.has(planToolName)).toBe(true);
    expect(RECIPE_GENERATION_SKELETON_CONTRACT.rg0Boundary.forbidden).toContain(
      'alembic_plan-tool-registration'
    );
  });

  test('keeps RG-9 moved implementations under recipe-generation with old paths as thin adapters', () => {
    for (const adapterPath of rg9AdapterPaths) {
      const source = readWorkspaceFile(adapterPath);
      const executableLines = source
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('//'));
      const executableSource = executableLines.join('\n');

      expect(source).toContain('RG9 兼容适配');
      expect(source).toContain('#recipe-pipeline/');
      expect(executableSource.match(/\bexport\b/g)).toHaveLength(1);
      expect(executableSource.trim()).toMatch(/^export /);
      expect(executableSource).not.toMatch(/\b(class|const|function|let|var)\b/);
    }

    for (const implementationPath of rg9ImplementationPaths) {
      const source = readWorkspaceFile(implementationPath);

      expect(source).not.toContain('#codex/mcp/host-agent-workflows/');
      expect(source).not.toContain('#service/bootstrap/');
      expect(source).not.toContain('#service/evolution/');
      expect(source).not.toContain('#service/vector/');
    }
  });
});

function readWorkspaceFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}
