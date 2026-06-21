export const RECIPE_GENERATION_SUBSYSTEM_ROOT = 'lib/recipe-generation' as const;

export const RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES = [
  'alembic_recipe_map',
  'alembic_graph',
  'alembic_search',
  'alembic_prime',
] as const;

export const RECIPE_GENERATION_STATE_PROJECTION_SOURCES = [
  'knowledge_entries',
  'recipe_source_refs',
  'evolution_proposals',
  'lifecycle_transition_events',
] as const;

export const RECIPE_GENERATION_STAGE_KINDS = ['cold-start', 'rescan', 'evolution'] as const;

export const RECIPE_GENERATION_RESCAN_MODES = ['deep-mining', 'module-mining'] as const;

export type RecipeGenerationProjectContextToolName =
  (typeof RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES)[number];
export type RecipeGenerationStateProjectionSource =
  (typeof RECIPE_GENERATION_STATE_PROJECTION_SOURCES)[number];
export type RecipeGenerationStageKind = (typeof RECIPE_GENERATION_STAGE_KINDS)[number];
export type RecipeGenerationRescanMode = (typeof RECIPE_GENERATION_RESCAN_MODES)[number];

export interface RecipeGenerationConfirmedPlanPrecondition {
  readonly blocksStages: readonly RecipeGenerationStageKind[];
  readonly currentRg0Behavior: 'contract-only';
  readonly enforcedFromPackage: 'RG-3';
  readonly requirement: 'confirmed-plan';
}

export interface RecipeGenerationStageContract {
  readonly firstImplementationPackage: string;
  readonly kind: RecipeGenerationStageKind;
  readonly planRequired: true;
  readonly rescanModes?: readonly RecipeGenerationRescanMode[];
}

export interface RecipeGenerationSkeletonContract {
  readonly generationState: {
    readonly model: 'read-time-db-projection';
    readonly persistenceRule: 'projected-from-db-not-double-written';
    readonly projectionSources: readonly RecipeGenerationStateProjectionSource[];
  };
  readonly plan: {
    readonly authority: 'confirmed-plan-living-ledger';
    readonly precondition: RecipeGenerationConfirmedPlanPrecondition;
    readonly rg0Status: 'future-contract-only';
  };
  readonly projectContext: {
    readonly role: 'source-of-project-facts';
    readonly toolNames: readonly RecipeGenerationProjectContextToolName[];
  };
  readonly rg0Boundary: {
    readonly forbidden: readonly string[];
    readonly productionBehaviorChanges: readonly string[];
    readonly publicMcpSurfaceChanges: readonly string[];
  };
  readonly stages: readonly RecipeGenerationStageContract[];
  readonly subsystemRoot: typeof RECIPE_GENERATION_SUBSYSTEM_ROOT;
}

export const RECIPE_GENERATION_CONFIRMED_PLAN_PRECONDITION = {
  blocksStages: RECIPE_GENERATION_STAGE_KINDS,
  currentRg0Behavior: 'contract-only',
  enforcedFromPackage: 'RG-3',
  requirement: 'confirmed-plan',
} as const satisfies RecipeGenerationConfirmedPlanPrecondition;

// RG-0 records the future boundary without registering tools, tables, handlers, or jobs.
export const RECIPE_GENERATION_SKELETON_CONTRACT = {
  subsystemRoot: RECIPE_GENERATION_SUBSYSTEM_ROOT,
  projectContext: {
    role: 'source-of-project-facts',
    toolNames: RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES,
  },
  plan: {
    authority: 'confirmed-plan-living-ledger',
    precondition: RECIPE_GENERATION_CONFIRMED_PLAN_PRECONDITION,
    rg0Status: 'future-contract-only',
  },
  generationState: {
    model: 'read-time-db-projection',
    persistenceRule: 'projected-from-db-not-double-written',
    projectionSources: RECIPE_GENERATION_STATE_PROJECTION_SOURCES,
  },
  stages: [
    {
      firstImplementationPackage: 'RG-4',
      kind: 'cold-start',
      planRequired: true,
    },
    {
      firstImplementationPackage: 'RG-4/RG-5',
      kind: 'rescan',
      planRequired: true,
      rescanModes: RECIPE_GENERATION_RESCAN_MODES,
    },
    {
      firstImplementationPackage: 'RG-8',
      kind: 'evolution',
      planRequired: true,
    },
  ],
  rg0Boundary: {
    forbidden: [
      'alembic_plan-tool-registration',
      'plans-table',
      'core-architecture-intelligence-rebuild',
      'public-mcp-semantic-change',
      'production-behavior-change',
    ],
    productionBehaviorChanges: [],
    publicMcpSurfaceChanges: [],
  },
} as const satisfies RecipeGenerationSkeletonContract;
