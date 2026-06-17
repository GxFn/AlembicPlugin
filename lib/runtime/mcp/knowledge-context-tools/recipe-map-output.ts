/**
 * GMAP-4/7: register the clean MCP output projector for alembic_recipe_map.
 *
 * recipe_map emits its own AlembicRecipeMapOutput (region + Recipe mounts/rollups),
 * not KnowledgeContextToolOutput. The handler returns a CallToolResult, so this
 * projector mainly advertises the schema in tools/list and provides a typed
 * fallback projection.
 */
import type { z } from 'zod';
import { AlembicRecipeMapOutputSchema } from '#service/project-knowledge-context/index.js';
import {
  type CleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';

export const RECIPE_MAP_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_recipe_map'] as const;

const AlembicRecipeMapCleanOutputSchema =
  AlembicRecipeMapOutputSchema as unknown as z.ZodType<CleanMcpResponse>;

function projectAlembicRecipeMapCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicRecipeMapOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  return buildAlembicRecipeMapProjectionFailure();
}

function buildAlembicRecipeMapProjectionFailure(): CleanMcpResponse {
  return AlembicRecipeMapOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_recipe_map',
    toolName: 'alembic_recipe_map',
    summary: 'alembic_recipe_map output did not match the public AlembicRecipeMapOutput contract.',
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
      truncated: false,
    },
    refs: [],
    recipeMounts: [],
    recipeRollups: [],
    diagnostics: [
      {
        code: 'alembic-recipe-map-output-contract-mismatch',
        severity: 'error',
        message: 'alembic_recipe_map handler returned a payload outside AlembicRecipeMapOutput.',
        retryable: false,
      },
    ],
    nextActions: [],
    limits: { nodeLimit: 0, recipeMountLimit: 0, refLimit: 0, detailLevel: 'summary' },
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
