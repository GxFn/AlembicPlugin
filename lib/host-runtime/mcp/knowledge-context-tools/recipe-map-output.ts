/**
 * GMAP-4/7: register the clean MCP output projector for alembic_recipe_map.
 *
 * recipe_map emits its own AlembicRecipeMapOutput (region + Recipe mounts/rollups),
 * not KnowledgeContextToolOutput. The handler returns a CallToolResult, so this
 * projector mainly advertises the schema in tools/list and provides a typed
 * fallback projection.
 */
import type { z } from 'zod';
import {
  AlembicRecipeMapOutputSchema,
  MapNextActionSchema,
} from '#service/project-knowledge-context/index.js';
import {
  type KnowledgeUnavailableProjection,
  readKnowledgeUnavailableResult,
} from '../host/knowledge-unavailable-result.js';
import {
  type CleanMcpError,
  CleanMcpErrorSchema,
  type CleanMcpResponse,
  createCleanMcpError,
  readMcpCleanErrorFailure,
  readMcpProducerFailure,
  registerMcpOutputProjector,
} from '../output-contract.js';

export const RECIPE_MAP_CLEAN_OUTPUT_TOOL_NAMES = ['alembic_recipe_map'] as const;

const AlembicRecipeMapCleanOutputSchema = AlembicRecipeMapOutputSchema.extend({
  error: CleanMcpErrorSchema.optional(),
}) as unknown as z.ZodType<CleanMcpResponse>;

// 请求项目根未知（执行上下文建立前的失败，如 PROJECT_ROOT_REQUIRED）时的占位；
// 已知时必须使用真实请求项目根。
const UNKNOWN_PROJECT_ROOT = '.';

function projectAlembicRecipeMapCleanOutput(input: unknown): CleanMcpResponse {
  const parsed = AlembicRecipeMapCleanOutputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as unknown as CleanMcpResponse;
  }
  // 只读 producer 的知识不可用结果（无数据库 / strict route 缺失）投影为原生 unavailable，
  // 而不是契约不匹配失败。
  const unavailable = readKnowledgeUnavailableResult(input, 'alembic_recipe_map');
  if (unavailable) {
    return buildAlembicRecipeMapUnavailableOutput(unavailable);
  }
  // 通用 clean 错误（PROJECT_ROOT_REQUIRED / wrapHandler 错误）与 failureResult 形态的
  // producer 失败（任意错误码，含续页 CURSOR_EXPIRED / FACTS_CHANGED）都已分类：保留
  // 原始 error（code/message/retryable/details），不能退化成泛化的 output-contract-mismatch。
  const failure =
    readMcpCleanErrorFailure(input, 'alembic_recipe_map') ??
    readMcpProducerFailure(input, 'alembic_recipe_map');
  if (failure) {
    process.stderr.write(
      `[MCP/alembic_recipe_map] projected producer error ${failure.error.code} (retryable=${failure.error.retryable}, projectRoot=${failure.projectRoot ?? 'unknown'}) into AlembicRecipeMapOutput\n`
    );
    return buildAlembicRecipeMapEmptyOutput({
      diagnostic: {
        code: failure.error.code,
        message: failure.summary.slice(0, 800),
        retryable: failure.error.retryable,
        severity: 'error',
      },
      error: failure.error,
      nextActions: failure.nextActions,
      ok: false,
      projectRoot: failure.projectRoot ?? UNKNOWN_PROJECT_ROOT,
      status: 'failed',
      summary: failure.summary,
    });
  }
  return buildAlembicRecipeMapEmptyOutput({
    diagnostic: {
      code: 'alembic-recipe-map-output-contract-mismatch',
      message: 'alembic_recipe_map handler returned a payload outside AlembicRecipeMapOutput.',
      retryable: false,
      severity: 'error',
    },
    ok: false,
    projectRoot: UNKNOWN_PROJECT_ROOT,
    status: 'failed',
    summary: 'alembic_recipe_map output did not match the public AlembicRecipeMapOutput contract.',
  });
}

/**
 * 知识不可用的原生 recipe_map 输出（projectCoverageStatus='unavailable'，空区域与守恒计数）。
 * - legacy（无数据库，项目未初始化）：不是工具失败——ok=true、isError 不置位，status 取
 *   recipe_map 状态词表中的 'degraded'（地图可调用但没有 Recipe 知识可挂载）。MapNextAction
 *   的 tool 词表不含 alembic_init，因此 init 指引放在诊断消息与 summary 中；投影绝不初始化。
 * - strict route 缺失：已初始化项目的发布故障，保持 ok=false/isError（既有 strict 传输契约）；
 *   recipe_map 词表无 'blocked'，取 'failed'，error.code 保留原因码。
 */
function buildAlembicRecipeMapUnavailableOutput(
  unavailable: KnowledgeUnavailableProjection
): CleanMcpResponse {
  const strict = unavailable.strictRouteUnavailable;
  process.stderr.write(
    `[MCP/alembic_recipe_map] knowledge unavailable (${unavailable.reasonCode}); returning native ${strict ? 'failed' : 'degraded'} output without initializing\n`
  );
  const summary = unavailable.summary.slice(0, 2000);
  return buildAlembicRecipeMapEmptyOutput({
    diagnostic: {
      code: unavailable.reasonCode,
      message: summary.slice(0, 800),
      retryable: false,
      severity: 'info',
    },
    ...(strict
      ? {
          error: createCleanMcpError({
            code: unavailable.reasonCode,
            failureKind: 'unavailable',
            message: summary,
            retryable: false,
            status: 'failed',
          }),
        }
      : {}),
    nextActions: unavailable.nextActions,
    ok: !strict,
    projectId: unavailable.projectId,
    projectRoot: unavailable.projectRoot,
    status: strict ? 'failed' : 'degraded',
    summary,
  });
}

function buildAlembicRecipeMapEmptyOutput(input: {
  diagnostic: {
    code: string;
    message: string;
    retryable: boolean;
    severity: 'info' | 'warning' | 'error';
  };
  error?: CleanMcpError;
  nextActions?: unknown;
  ok: boolean;
  projectId?: string | null;
  projectRoot: string;
  status: 'degraded' | 'failed';
  summary: string;
}): CleanMcpResponse {
  return AlembicRecipeMapCleanOutputSchema.parse({
    ok: input.ok,
    status: input.status,
    tool: 'alembic_recipe_map',
    toolName: 'alembic_recipe_map',
    summary: input.summary.slice(0, 2000),
    project: {
      projectRoot: input.projectRoot,
      ...(input.projectId ? { projectId: input.projectId.slice(0, 240) } : {}),
    },
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
    diagnostics: [input.diagnostic],
    nextActions: projectRecipeMapNextActions(input.nextActions),
    limits: {
      nodeLimit: 0,
      recipeMountLimit: 0,
      appliedRecipeMountLimit: 0,
      recipeMountLimitReason: 'requested-limit',
      refLimit: 0,
      detailLevel: 'summary',
    },
    ...(input.error ? { error: input.error } : {}),
    meta: {
      contractVersion: 1,
      outputSchema: 'AlembicRecipeMapOutput',
      producer: 'alembic-recipe-map-clean-output-projector',
    },
  }) as unknown as CleanMcpResponse;
}

/** producer 指引中满足 MapNextAction 契约的条目；其余指引保留在 error.details / 诊断消息。 */
function projectRecipeMapNextActions(value: unknown): z.infer<typeof MapNextActionSchema>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 20).flatMap((entry) => {
    const parsed = MapNextActionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

registerMcpOutputProjector({
  outputSchema: AlembicRecipeMapCleanOutputSchema,
  outputSchemaName: 'alembic_recipe_map_clean_output',
  project: (input) => projectAlembicRecipeMapCleanOutput(input),
  projectorName: 'alembic-recipe-map-clean-output-projector',
  toolName: 'alembic_recipe_map',
});
