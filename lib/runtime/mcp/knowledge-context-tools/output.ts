import { z } from 'zod';
import {
  type KnowledgeContextToolName,
  KnowledgeContextToolOutputSchema,
} from '#service/project-knowledge-context/index.js';
import {
  type CleanMcpResponse,
  registerMcpOutputProjector,
} from '../../../runtime/mcp/output-contract.js';

export const KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_project_matrix'] as const;

export type KnowledgeContextCleanOutputToolName =
  (typeof KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES)[number];

export const KnowledgeContextCleanOutputToolNameSchema = z.enum(
  KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES
);

export const KNOWLEDGE_CONTEXT_TOOL_OUTPUT_SCHEMAS = {
  alembic_project_matrix: KnowledgeContextToolOutputSchema.refine(
    (output) => output.toolName === 'alembic_project_matrix',
    {
      message: 'Knowledge context output toolName must be alembic_project_matrix.',
      path: ['toolName'],
    }
  ),
} as unknown as Record<KnowledgeContextCleanOutputToolName, z.ZodType<CleanMcpResponse>>;

export function projectKnowledgeContextToolOutput(
  input: unknown,
  toolName: KnowledgeContextCleanOutputToolName
): CleanMcpResponse {
  const schema = KNOWLEDGE_CONTEXT_TOOL_OUTPUT_SCHEMAS[toolName];
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  return buildKnowledgeContextProjectionFailure(toolName);
}

function buildKnowledgeContextProjectionFailure(
  toolName: KnowledgeContextCleanOutputToolName
): CleanMcpResponse {
  return KnowledgeContextToolOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: toolName,
    toolName,
    operation: 'unknown',
    summary: `Knowledge context output for ${toolName} did not match the public output contract.`,
    detailRefs: [],
    sources: [],
    diagnostics: [
      {
        code: 'knowledge-context-output-contract-mismatch',
        message: 'Knowledge context handler returned a payload outside KnowledgeContextToolOutput.',
        retryable: false,
        severity: 'error',
      },
    ],
    nextActions: [],
    meta: {
      contractVersion: 1,
      outputSchema: 'KnowledgeContextToolOutput',
      producer: 'knowledge-context-clean-output-projector',
    },
  }) as CleanMcpResponse;
}

for (const toolName of KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES) {
  registerMcpOutputProjector({
    outputSchema: KNOWLEDGE_CONTEXT_TOOL_OUTPUT_SCHEMAS[toolName],
    outputSchemaName: `${toolName}_clean_output`,
    project: (input) => projectKnowledgeContextToolOutput(input, toolName),
    projectorName: 'knowledge-context-clean-output-projector',
    toolName,
  });
}

export type KnowledgeContextOutputToolName = KnowledgeContextToolName;
