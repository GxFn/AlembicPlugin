import { describe, expect, test } from 'vitest';
import {
  RECIPE_GENERATION_CONFIRMED_PLAN_PRECONDITION,
  RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES,
  RECIPE_GENERATION_SKELETON_CONTRACT,
  RECIPE_GENERATION_STATE_PROJECTION_SOURCES,
  RECIPE_GENERATION_SUBSYSTEM_ROOT,
} from '#recipe-generation/contracts.js';
import { PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES } from '../../lib/runtime/index.js';
import { listPluginToolSurfaceCatalog } from '../../lib/runtime/mcp/PluginToolSurfaceCatalog.js';
import { TOOLS } from '../../lib/runtime/mcp/tools.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const planToolName = 'alembic_plan';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('RG-0 recipe generation skeleton', () => {
  test('homes future Recipe generation contracts in the new internal subsystem', () => {
    expect(RECIPE_GENERATION_SUBSYSTEM_ROOT).toBe('lib/recipe-generation');
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
});
