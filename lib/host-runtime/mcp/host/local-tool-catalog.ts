import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { GenerateInput, RescanInput } from '#shared/schemas/mcp-tools.js';
import { zodToMcpSchema } from '../zodToMcpSchema.js';

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

/**
 * alembic_job 的 op=bootstrap|rescan 直接转发给 alembic_bootstrap / alembic_rescan 的同一
 * workflow，入参也由同一 Zod schema 校验；这里从 GenerateInput ∪ RescanInput 派生广告 schema，
 * 避免 additionalProperties:false 把 planSelection 等必填字段挡在客户端之外。
 * 两个 schema 同名但定义不同的字段（generationStage / planSelection 的阶段字面量）用 anyOf 合并。
 */
function buildJobWorkflowProperties(): Record<string, unknown> {
  const generate = zodToMcpSchema(GenerateInput).properties;
  const rescan = zodToMcpSchema(RescanInput).properties;
  const properties: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(generate), ...Object.keys(rescan)])) {
    // projectRoot 由 inputSchema() 统一声明（请求级项目身份）。
    if (key === 'projectRoot') {
      continue;
    }
    const fromGenerate = generate[key];
    const fromRescan = rescan[key];
    if (fromGenerate && fromRescan && JSON.stringify(fromGenerate) !== JSON.stringify(fromRescan)) {
      properties[key] = {
        anyOf: [fromGenerate, fromRescan],
        description: `op=bootstrap: alembic_bootstrap.${key}; op=rescan: alembic_rescan.${key}.`,
      };
      continue;
    }
    properties[key] = fromGenerate ?? fromRescan;
  }
  return properties;
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
    description:
      'Run or inspect Plugin-owned bootstrap/rescan jobs for this project. op=bootstrap|rescan runs the same workflow as alembic_bootstrap / alembic_rescan and accepts the same arguments (planSelection from alembic_plan confirm is required); op=status reads jobs back by jobId or kind/status/limit.',
    inputSchema: inputSchema({
      ...buildJobWorkflowProperties(),
      op: { type: 'string', enum: ['bootstrap', 'rescan', 'status'] },
      jobId: { type: 'string', description: 'op=status: read one job by id.' },
      kind: {
        type: 'string',
        enum: ['bootstrap', 'rescan'],
        description: 'op=status: filter jobs by kind.',
      },
      // 保持历史的自由字符串（不加 enum），避免已有调用方被客户端侧校验拒绝；未知值在 readJob 中忽略。
      status: {
        type: 'string',
        description:
          'op=status: filter jobs by status (queued | running | completed | failed | cancelled).',
      },
      limit: { type: 'number', description: 'op=status: maximum jobs to list (default 20).' },
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
