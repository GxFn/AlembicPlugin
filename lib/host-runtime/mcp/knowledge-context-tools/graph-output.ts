/**
 * GMAP-1: register the clean MCP output projector for alembic_graph.
 *
 * alembic_graph emits its own Recipe-free AlembicGraphOutput rather than the
 * shared KnowledgeContextToolOutput envelope. The graph handler already returns a
 * CallToolResult, so this projector mainly advertises the AlembicGraphOutput
 * schema in tools/list and provides a typed fallback projection.
 */
import type { z } from 'zod';
import {
  AlembicGraphOutputSchema,
  GraphNextActionSchema,
} from '#service/project-knowledge-context/index.js';
import {
  CleanMcpErrorSchema,
  type CleanMcpResponse,
  type McpClassifiedFailure,
  readMcpCleanErrorFailure,
  readMcpProducerFailure,
  registerMcpOutputProjector,
} from '../output-contract.js';

// alembic_graph is a clean-output tool with its own AlembicGraphOutput schema,
// separate from the KnowledgeContextToolOutput envelope.
export const GRAPH_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_graph'] as const;

const AlembicGraphCleanOutputSchema = AlembicGraphOutputSchema.extend({
  error: CleanMcpErrorSchema.optional(),
}) as unknown as z.ZodType<CleanMcpResponse>;

// 请求项目根未知（执行上下文建立前的失败，如 PROJECT_ROOT_REQUIRED）时的占位；
// 已知时必须使用真实请求项目根。
const UNKNOWN_PROJECT_ROOT = '.';

function projectAlembicGraphCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicGraphCleanOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  // 通用 clean 错误（PROJECT_ROOT_REQUIRED / wrapHandler 错误）与 failureResult 形态的
  // producer 失败（任意错误码，含续页 CURSOR_EXPIRED / FACTS_CHANGED）都已分类：保留
  // 原始 error（code/message/retryable/details），不能退化成泛化的 output-contract-mismatch。
  const failure =
    readMcpCleanErrorFailure(input, 'alembic_graph') ??
    readMcpProducerFailure(input, 'alembic_graph');
  if (failure) {
    process.stderr.write(
      `[MCP/alembic_graph] projected producer error ${failure.error.code} (retryable=${failure.error.retryable}, projectRoot=${failure.projectRoot ?? 'unknown'}) into AlembicGraphOutput\n`
    );
    return buildAlembicGraphProjectionFailure(failure);
  }
  return buildAlembicGraphProjectionFailure();
}

function buildAlembicGraphProjectionFailure(failure?: McpClassifiedFailure): CleanMcpResponse {
  const summary = failure
    ? failure.summary.slice(0, 2000)
    : 'alembic_graph output did not match the public AlembicGraphOutput contract.';
  const diagnosticCode = failure?.error.code ?? 'alembic-graph-output-contract-mismatch';
  return AlembicGraphCleanOutputSchema.parse({
    ok: false,
    status: 'failed',
    tool: 'alembic_graph',
    toolName: 'alembic_graph',
    queryKind: 'map',
    summary,
    project: { projectRoot: failure?.projectRoot ?? UNKNOWN_PROJECT_ROOT },
    repoCoverage: {
      scope: 'canonical-repositories',
      requested: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      omitted: 0,
      completeness: 'unknown',
      discoveredRepoIds: [],
      succeededRepoIds: [],
      failedRepoIds: [],
      omittedRepoIds: [],
      timeoutCount: diagnosticCode === 'TOOL_TIMEOUT' ? 1 : 0,
    },
    nodes: [],
    relations: [],
    refs: [],
    diagnostics: [
      {
        code: diagnosticCode,
        message: failure
          ? summary.slice(0, 800)
          : 'alembic_graph handler returned a payload outside AlembicGraphOutput.',
        retryable: failure?.error.retryable ?? false,
        severity: 'error',
      },
    ],
    nextActions: projectGraphNextActions(failure?.nextActions),
    limits: { truncated: false, itemLimit: 0, refLimit: 0, relationLimit: 0 },
    ...(failure ? { error: failure.error } : {}),
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicGraphOutput',
      producer: 'alembic-graph-clean-output-projector',
      sourceOfTruth: false,
      callClaimsRequireSourceVerification: true,
    },
  }) as unknown as CleanMcpResponse;
}

/** producer 指引中满足 GraphNextAction 契约的条目；其余指引保留在 error.details。 */
function projectGraphNextActions(value: unknown): z.infer<typeof GraphNextActionSchema>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 20).flatMap((entry) => {
    const parsed = GraphNextActionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

registerMcpOutputProjector({
  outputSchema: AlembicGraphCleanOutputSchema,
  outputSchemaName: 'alembic_graph_clean_output',
  project: (input) => projectAlembicGraphCleanOutput(input),
  projectorName: 'alembic-graph-clean-output-projector',
  toolName: 'alembic_graph',
});
