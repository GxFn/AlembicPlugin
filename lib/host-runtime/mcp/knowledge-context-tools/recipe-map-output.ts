/**
 * GMAP-4/7: register the clean MCP output projector for alembic_recipe_map.
 *
 * recipe_map emits its own AlembicRecipeMapOutput (region + Recipe mounts/rollups),
 * not KnowledgeContextToolOutput. The handler returns a CallToolResult, so this
 * projector mainly advertises the schema in tools/list and provides a typed
 * fallback projection.
 */
import { z } from 'zod';
import { AlembicRecipeMapOutputSchema } from '#service/project-knowledge-context/index.js';
import { isStrictPublicationErrorCode } from '../../context/StrictPublicationError.js';
import { HOST_NEUTRAL_INTERNAL_ERROR_CODE, normalizeHostMcpErrorCode } from '../error-taxonomy.js';
import {
  CleanMcpErrorSchema,
  type CleanMcpResponse,
  createCleanMcpError,
  registerMcpOutputProjector,
} from '../output-contract.js';
import { ProjectRuntimeContextV3Schema } from '../project-runtime-output-schema.js';

export const RECIPE_MAP_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_recipe_map'] as const;

const AlembicRecipeMapCleanOutputSchema = AlembicRecipeMapOutputSchema.extend({
  error: CleanMcpErrorSchema.optional(),
}) as unknown as z.ZodType<CleanMcpResponse>;

const RecipeMapProducerFailureSchema = z
  .object({
    success: z.literal(false),
    data: z
      .object({
        projectRuntime: ProjectRuntimeContextV3Schema,
        retryable: z.boolean().optional(),
      })
      .strict(),
    errorCode: z.string().min(1).max(120),
    message: z.string().min(1).max(4000),
    tool: z.literal('alembic_recipe_map'),
  })
  .strict();

function projectAlembicRecipeMapCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicRecipeMapCleanOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  const producerFailure = RecipeMapProducerFailureSchema.safeParse(input);
  if (producerFailure.success) {
    const errorCode = normalizeHostMcpErrorCode(producerFailure.data.errorCode);
    if (isPreservedRecipeMapProducerFailureCode(errorCode)) {
      return buildAlembicRecipeMapProjectionFailure({
        code: errorCode,
        message: producerFailure.data.message,
        retryable: producerFailure.data.data.retryable ?? errorCode === 'TOOL_TIMEOUT',
      });
    }
  }
  return buildAlembicRecipeMapProjectionFailure();
}

function isPreservedRecipeMapProducerFailureCode(errorCode: string): boolean {
  return (
    errorCode === HOST_NEUTRAL_INTERNAL_ERROR_CODE ||
    errorCode === 'TOOL_TIMEOUT' ||
    isStrictPublicationErrorCode(errorCode)
  );
}

function buildAlembicRecipeMapProjectionFailure(
  failure?: Readonly<{ code: string; message: string; retryable: boolean }>
): CleanMcpResponse {
  const summary = failure
    ? failure.message.slice(0, 2000)
    : 'alembic_recipe_map output did not match the public AlembicRecipeMapOutput contract.';
  const diagnosticCode = failure?.code ?? 'alembic-recipe-map-output-contract-mismatch';
  return AlembicRecipeMapCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_recipe_map',
    toolName: 'alembic_recipe_map',
    summary,
    project: { projectRoot: '.' },
    focus: { kind: 'space' },
    radius: {},
    region: {
      rootNode: {
        nodeId: 'project:unknown',
        kind: 'space',
        label: 'unknown',
        directRecipeCount: 0,
        descendantRecipeCount: 0,
        representativeRecipeIds: [],
      },
      breadcrumb: [],
      nodes: [],
      relations: [],
      truncated: false,
    },
    refs: [],
    recipeMounts: [],
    recipeRollups: [],
    conservation: {
      candidateRecipes: 0,
      mountedTotal: 0,
      deferredTotal: 0,
      uncoveredTotal: 0,
      displayedMounts: 0,
      omittedMounts: 0,
      completeness: 'unknown',
      mountAccountingCompleteness: 'unknown',
    },
    projectCoverageStatus: 'unavailable',
    finalCoverageReceipt: null,
    diagnostics: [
      {
        code: diagnosticCode,
        severity: 'error',
        message: failure
          ? summary.slice(0, 800)
          : 'alembic_recipe_map handler returned a payload outside AlembicRecipeMapOutput.',
        retryable: failure?.retryable ?? false,
      },
    ],
    nextActions: [],
    limits: {
      nodeLimit: 0,
      recipeMountLimit: 0,
      appliedRecipeMountLimit: 0,
      recipeMountLimitReason: 'requested-limit',
      refLimit: 0,
      detailLevel: 'summary',
    },
    ...(failure
      ? {
          error: createCleanMcpError({
            code: diagnosticCode,
            message: summary,
            status: 'failed',
          }),
        }
      : {}),
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicRecipeMapOutput',
      producer: 'alembic-recipe-map-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

registerMcpOutputProjector({
  outputSchema: AlembicRecipeMapCleanOutputSchema,
  outputSchemaName: 'alembic_recipe_map_clean_output',
  project: (input) => projectAlembicRecipeMapCleanOutput(input),
  projectorName: 'alembic-recipe-map-clean-output-projector',
  toolName: 'alembic_recipe_map',
});
