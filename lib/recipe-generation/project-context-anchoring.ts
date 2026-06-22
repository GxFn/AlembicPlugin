import { RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES } from './contracts.js';

export type ProjectContextCreationStage =
  | 'plan-draft'
  | 'plan-confirm'
  | 'plan-get'
  | 'bootstrap'
  | 'rescan'
  | 'submit-knowledge';

export interface ProjectContextCreationGuideInput {
  readonly dimensionIds?: readonly string[];
  readonly generationStage?: string;
  readonly moduleScope?: readonly string[];
  readonly planId?: string;
  readonly projectRoot?: string;
  readonly stage: ProjectContextCreationStage;
  readonly testMode?: boolean;
}

export interface RelationshipGroundingAssessment {
  readonly acceptedGraphRefCount: number;
  readonly acceptedSourceRefCount: number;
  readonly degraded?: boolean;
  readonly finality: 'final' | 'non-final';
  readonly items: readonly Record<string, unknown>[];
  readonly missingGraphEvidenceCount: number;
  readonly missingSourceEvidenceCount: number;
  readonly nextActions: readonly Record<string, unknown>[];
  readonly relationshipClaimCount: number;
  readonly requiredEvidenceFields: readonly string[];
  readonly retrievalMayBeStale: boolean;
  readonly status: 'grounded' | 'needs-evidence' | 'not-applicable';
  readonly warning?: string;
}

const PROJECT_CONTEXT_CREATION_GUIDE_VERSION = 1;

const RELATIONSHIP_EVIDENCE_FIELDS = [
  'sourceRefs',
  'reasoning.sources',
  'sourceGraphRefs',
  'graphRefs',
] as const;

export function buildProjectContextCreationGuide(
  input: ProjectContextCreationGuideInput
): Record<string, unknown> {
  return {
    contractVersion: PROJECT_CONTEXT_CREATION_GUIDE_VERSION,
    source: 'RG-5-project-context-anchored-creation',
    stage: input.stage,
    rule: 'Before creating Recipes, anchor project claims in ProjectContext evidence, compare existing Recipes, and cite raw source or graph refs for relationship-heavy claims.',
    confirmedPlanBoundary: {
      required: true,
      dimensionIds: input.dimensionIds ?? [],
      planId: input.planId ?? null,
      generationStage: input.generationStage ?? null,
      moduleScope: input.moduleScope ?? [],
      testMode: input.testMode === true,
      noPluginOnlyPlanStore: true,
    },
    toolChain: buildProjectContextCreationToolChain(),
    relationshipClaimPolicy: buildRelationshipClaimPolicy(),
    nextActions: buildProjectContextCreationNextActions(input),
    invalidConclusions: [
      'ProjectContext orientation alone proves current behavior',
      'Recipe claims are fully grounded without sourceRefs or graph refs',
      'Plan guidance replaces raw source reads, Guard, or repository validation',
    ],
  };
}

export function attachProjectContextCreationGuide<T extends Record<string, unknown>>(
  target: T,
  input: ProjectContextCreationGuideInput
): T & {
  projectContextCreationGuide: Record<string, unknown>;
  recipeCreationNextActions: Record<string, unknown>[];
} {
  const guide = buildProjectContextCreationGuide(input);
  const nextActions = buildProjectContextCreationNextActions(input);
  return {
    ...target,
    projectContextCreationGuide: guide,
    recipeCreationNextActions: nextActions,
    meta: {
      ...(isRecord(target.meta) ? target.meta : {}),
      projectContextCreationGuide: {
        contractVersion: PROJECT_CONTEXT_CREATION_GUIDE_VERSION,
        stage: input.stage,
        toolCount: RECIPE_GENERATION_PROJECT_CONTEXT_TOOL_NAMES.length,
      },
    },
  };
}

export function buildProjectContextCreationNextActions(
  input: ProjectContextCreationGuideInput
): Record<string, unknown>[] {
  const projectRootArg = input.projectRoot ? { projectRoot: input.projectRoot } : {};
  const dimensionHint =
    input.dimensionIds && input.dimensionIds.length > 0
      ? { dimensionId: input.dimensionIds[0] }
      : {};
  return [
    {
      tool: 'alembic_recipe_map',
      required: true,
      reason:
        'Start from a Recipe-mounted ProjectContext region so candidate scope, modules, and existing Recipe mounts are visible before authoring.',
      args: {
        ...projectRootArg,
        focus: {
          kind: input.moduleScope?.length ? 'module' : 'map',
          ...(input.moduleScope?.[0] ? { moduleName: input.moduleScope[0] } : {}),
        },
        detailLevel: 'summary',
      },
    },
    {
      tool: 'alembic_graph',
      required: true,
      reason:
        'Collect ProjectContext refs, source slices, and relation hints for caller/callee/dependency/impact claims.',
      args: {
        ...projectRootArg,
        queryKind: input.moduleScope?.length ? 'module' : 'map',
        ...(input.moduleScope?.[0] ? { query: input.moduleScope[0] } : {}),
        detailLevel: 'summary',
      },
    },
    {
      tool: 'alembic_search',
      required: false,
      reason:
        'Compare existing Recipes and prior decisions before creating another candidate for the same project convention.',
      args: {
        ...projectRootArg,
        operation: 'search',
        query: buildSearchQuery(input),
        ...dimensionHint,
        limit: 5,
      },
    },
    {
      tool: 'alembic_prime',
      required: false,
      reason:
        'Prime task semantics when the candidate encodes a rule, pattern, boundary, or validation workflow.',
      argsTemplate: {
        ...projectRootArg,
        taskAction: 'code-review',
        requirementGoal: 'Ground a Recipe candidate in ProjectContext evidence before submission.',
        integrationBoundary: 'ProjectContext-to-Recipe creation',
        qualityConcerns: ['source evidence', 'relationship refs', 'validation guidance'],
      },
    },
    {
      tool: 'alembic_submit_knowledge',
      required: true,
      reason:
        'Submit only after sourceRefs/reasoning.sources are concrete and relationship claims carry sourceGraphRefs or graphRefs.',
      argsTemplate: {
        items: [
          {
            ...dimensionHint,
            sourceRefs: ['repo-relative/path.ts:line-line'],
            sourceGraphRefs: ['ProjectContext detail/ref id for relationships when applicable'],
          },
        ],
      },
    },
  ];
}

export function assessProjectContextRelationshipGrounding(
  items: readonly Record<string, unknown>[]
): RelationshipGroundingAssessment | null {
  const inspected = items.map((item, index) => {
    const title = readString(item.title) ?? `(item ${index})`;
    const hasRelationship = hasRelationshipClaim(item);
    const graphRefs = collectGraphRefs(item);
    const sourceRefs = collectSourceRefs(item);
    const hasRequiredEvidence = graphRefs.length > 0 && sourceRefs.length > 0;
    return {
      index,
      title,
      hasRelationship,
      graphRefCount: graphRefs.length,
      sourceRefCount: sourceRefs.length,
      status: !hasRelationship
        ? 'not-applicable'
        : hasRequiredEvidence
          ? 'grounded'
          : 'needs-evidence',
    };
  });
  const relationshipItems = inspected.filter((item) => item.hasRelationship);
  if (relationshipItems.length === 0) {
    return null;
  }
  const missingGraph = relationshipItems.filter((item) => item.graphRefCount === 0);
  const missingSource = relationshipItems.filter((item) => item.sourceRefCount === 0);
  const status =
    missingGraph.length > 0 || missingSource.length > 0 ? 'needs-evidence' : 'grounded';
  const needsEvidence = status === 'needs-evidence';
  return {
    acceptedGraphRefCount: relationshipItems.reduce((sum, item) => sum + item.graphRefCount, 0),
    acceptedSourceRefCount: relationshipItems.reduce((sum, item) => sum + item.sourceRefCount, 0),
    ...(needsEvidence ? { degraded: true } : {}),
    finality: needsEvidence ? 'non-final' : 'final',
    items: inspected,
    missingGraphEvidenceCount: missingGraph.length,
    missingSourceEvidenceCount: missingSource.length,
    nextActions: buildProjectContextCreationNextActions({ stage: 'submit-knowledge' }).slice(0, 2),
    relationshipClaimCount: relationshipItems.length,
    requiredEvidenceFields: RELATIONSHIP_EVIDENCE_FIELDS,
    retrievalMayBeStale: needsEvidence,
    status,
    ...(needsEvidence
      ? {
          warning:
            'Relationship-heavy Recipe claims are non-final until both sourceRefs/reasoning.sources and sourceGraphRefs/graphRefs from alembic_graph/recipe_map are attached.',
        }
      : {}),
  };
}

function buildProjectContextCreationToolChain(): Record<string, unknown>[] {
  return [
    {
      tool: 'alembic_recipe_map',
      provides: 'Recipe-mounted ProjectContext scope, modules, refs, partial notes, and mounts',
      requiredFor: ['candidate scope', 'duplicate avoidance', 'module ownership'],
    },
    {
      tool: 'alembic_graph',
      provides: 'ProjectContext graph refs, source slices, and relation/impact hints',
      requiredFor: ['caller/callee claims', 'dependency claims', 'ownership and impact claims'],
    },
    {
      tool: 'alembic_search',
      provides: 'existing Recipe details and prior project decisions',
      requiredFor: ['duplicate checks', 'when/when-not refinement'],
    },
    {
      tool: 'alembic_prime',
      provides:
        'task-semantic Recipe context for rules, boundaries, validation, and prior decisions',
      requiredFor: ['relationship-heavy or behavior-changing candidates'],
    },
  ];
}

function buildRelationshipClaimPolicy(): Record<string, unknown> {
  return {
    status: 'needs-evidence-before-fully-grounded',
    claimKinds: ['caller/callee', 'dependency', 'ownership', 'impact path', 'module boundary'],
    requiredEvidenceFields: RELATIONSHIP_EVIDENCE_FIELDS,
    preferredTools: ['alembic_recipe_map', 'alembic_graph'],
    fallback:
      'If ProjectContext is partial or stale, cite raw source reads and mark the uncertainty instead of treating the claim as graph-grounded.',
  };
}

function buildSearchQuery(input: ProjectContextCreationGuideInput): string {
  const parts = [
    'ProjectContext grounded Recipe creation',
    input.stage,
    input.generationStage,
    ...(input.dimensionIds ?? []),
    ...(input.moduleScope ?? []),
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.join(' ');
}

function hasRelationshipClaim(item: Record<string, unknown>): boolean {
  if (
    item.graphRefs ||
    item.sourceGraphRefs ||
    item.relations ||
    item.relationships ||
    item.relationshipClaim === true ||
    item.requiresGraphEvidence === true ||
    item.relationshipEvidenceRequired === true
  ) {
    return true;
  }
  const text = [
    readString(item.description),
    readString(readRecord(item.content)?.markdown),
    readString(readRecord(item.reasoning)?.whyStandard),
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
  return (
    /\b(call chain|caller|callee|called by|depends on|impact path|relationship|invokes)\b/i.test(
      text
    ) || /调用链|调用方|被调用|依赖|影响路径|关系|上游|下游/.test(text)
  );
}

function collectGraphRefs(item: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...stringArray(item.graphRefs),
    ...stringArray(item.sourceGraphRefs),
    ...stringArray(readRecord(item.relations)?.graphRefs),
    ...stringArray(readRecord(item.relationships)?.graphRefs),
    ...stringArray(readRecord(item.reasoning)?.graphRefs),
  ]);
}

function collectSourceRefs(item: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...stringArray(item.sourceRefs),
    ...stringArray(readRecord(item.reasoning)?.sources),
    ...stringArray(readRecord(item.relations)?.sourceRefs),
    ...stringArray(readRecord(item.relationships)?.sourceRefs),
  ]);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    );
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value];
  }
  return [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
