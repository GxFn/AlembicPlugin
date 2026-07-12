import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  annotations?: ToolAnnotations;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

export const PROJECT_ROOT_PROPERTY = {
  type: 'string',
  description: 'Absolute target project root for this call.',
};

function inputSchema(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    properties: { projectRoot: PROJECT_ROOT_PROPERTY, ...properties },
    additionalProperties: false,
  };
}

export const PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES = new Set([
  'alembic_recipe_map',
  'alembic_prime',
  'alembic_search',
  'alembic_graph',
]);
export const HOST_AGENT_WORKFLOW_TOOL_NAMES = new Set([
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
]);
export const AGENT_PUBLIC_TOOL_NAMES = new Set([
  'alembic_prime',
  'alembic_work',
  'alembic_code_guard',
]);

export const LOCAL_TOOLS: ToolDefinition[] = [
  {
    name: 'alembic_status',
    description: 'Report request-scoped project location and local knowledge availability.',
    inputSchema: inputSchema({
      aspect: { type: 'string', enum: ['runtime', 'knowledge'] },
    }),
  },
  {
    name: 'alembic_init',
    description: 'Explicitly initialize Alembic for the request-scoped project.',
    inputSchema: inputSchema({
      force: { type: 'boolean' },
      seed: { type: 'boolean' },
      standard: { type: 'boolean' },
    }),
  },
  {
    name: 'alembic_job',
    description: 'Run or inspect Plugin-owned bootstrap/rescan jobs for this project.',
    inputSchema: inputSchema({
      op: { type: 'string', enum: ['bootstrap', 'rescan', 'status'] },
      jobId: { type: 'string' },
      kind: { type: 'string', enum: ['bootstrap', 'rescan'] },
      status: { type: 'string' },
      limit: { type: 'number' },
      reason: { type: 'string' },
      dimensions: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    name: 'alembic_runtime',
    description: 'Preview or clean Plugin-owned runtime files for this project.',
    inputSchema: {
      ...inputSchema({
        action: { type: 'string', enum: ['cleanup'] },
        confirm: { type: 'boolean' },
      }),
      required: ['action'],
    },
  },
];
