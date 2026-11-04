import { z } from 'zod';
import type { ProjectRuntimeContext } from '../../context/ProjectRuntimeContext.js';
import {
  ProjectRuntimeContextV3Schema,
  ProjectRuntimePublicationProvenanceSchema,
  StrictUnavailablePublicationProvenanceSchema,
} from '../project-runtime-output-schema.js';

/** 项目没有知识数据库（未初始化）：只读工具返回原生 unavailable，绝不自动初始化。 */
export const KNOWLEDGE_DATABASE_UNAVAILABLE_CODE = 'knowledge-database-unavailable';
/** strict-v1 publication 存在但没有 active route：知识发布本身需要修复。 */
export const STRICT_PUBLICATION_ROUTE_UNAVAILABLE_CODE = 'strict-publication-route-unavailable';

export const KNOWLEDGE_UNAVAILABLE_TOOL_NAMES = [
  'alembic_prime',
  'alembic_search',
  'alembic_recipe_map',
  'alembic_code_guard',
] as const;

export type KnowledgeUnavailableToolName = (typeof KNOWLEDGE_UNAVAILABLE_TOOL_NAMES)[number];

const INIT_NEXT_ACTION_REASON =
  'Initialize Alembic for this project to create its knowledge database; read tools never initialize a project automatically.';

export function createKnowledgeUnavailableResult(
  toolName: string,
  projectRuntime: ProjectRuntimeContext
): Record<string, unknown> {
  const identity = projectRuntime.identity;
  const strictRouteUnavailable = projectRuntime.publication.mode === 'strict-v1';
  const summary = strictRouteUnavailable
    ? `Alembic strict knowledge is unavailable for ${identity.projectRoot}; the valid strict publication has no active route.`
    : `Alembic knowledge is unavailable for ${identity.projectRoot}; no database exists at ${identity.databasePath}. Run alembic_init to initialize the project.`;
  return {
    success: true,
    data: {
      status: 'unavailable',
      summary,
      items: [],
      results: [],
      relations: [],
      diagnostics: [
        {
          code: strictRouteUnavailable
            ? STRICT_PUBLICATION_ROUTE_UNAVAILABLE_CODE
            : KNOWLEDGE_DATABASE_UNAVAILABLE_CODE,
          severity: 'info',
          message: summary,
          retryable: false,
        },
      ],
      // legacy（无数据库）只给出 alembic_init 指引，由调用方决定是否初始化；strict
      // route 缺失不是"未初始化"，初始化无法修复它，因此不给 init 指引。
      nextActions: strictRouteUnavailable
        ? []
        : [{ tool: 'alembic_init', reason: INIT_NEXT_ACTION_REASON, required: false }],
      project: {
        projectRoot: identity.projectRoot,
        projectId: identity.projectId,
        dataRoot: identity.dataRoot,
        databasePath: identity.databasePath,
        databaseExists: false,
        publication: projectRuntime.publication,
      },
    },
    message: summary,
    toolName,
  };
}

const KnowledgeUnavailableDiagnosticSchema = z
  .object({
    code: z.enum([KNOWLEDGE_DATABASE_UNAVAILABLE_CODE, STRICT_PUBLICATION_ROUTE_UNAVAILABLE_CODE]),
    severity: z.literal('info'),
    message: z.string().min(1).max(1200),
    retryable: z.literal(false),
  })
  .strict();

const KnowledgeUnavailableNextActionSchema = z
  .object({
    tool: z.literal('alembic_init'),
    reason: z.string().min(1).max(600),
    required: z.literal(false),
  })
  .strict();

// 只读 producer 的已知 unavailable 形态（attachExecutionContext 之后可带 projectRuntime）。
// 外层与 data 都 strict：只有这一种封闭形态能被投影为原生 unavailable，任何漂移
// 仍落到各投影器的显式拒绝/契约不匹配诊断，不会被静默吞掉。
export const KnowledgeUnavailableResultSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        status: z.literal('unavailable'),
        summary: z.string().min(1).max(1200),
        items: z.array(z.never()).max(0),
        results: z.array(z.never()).max(0),
        relations: z.array(z.never()).max(0),
        diagnostics: z.tuple([KnowledgeUnavailableDiagnosticSchema]),
        nextActions: z.array(KnowledgeUnavailableNextActionSchema).max(1),
        project: z
          .object({
            projectRoot: z.string().min(1).max(1200),
            projectId: z.string().nullable(),
            dataRoot: z.string().min(1).max(1200),
            databasePath: z.string().min(1).max(1200),
            databaseExists: z.literal(false),
            publication: ProjectRuntimePublicationProvenanceSchema,
          })
          .strict(),
        projectRuntime: ProjectRuntimeContextV3Schema.optional(),
      })
      .strict(),
    message: z.string().min(1).max(1200),
    toolName: z.enum(KNOWLEDGE_UNAVAILABLE_TOOL_NAMES),
  })
  .strict()
  .superRefine((output, ctx) => {
    const diagnostic = output.data.diagnostics[0];
    if (output.message !== output.data.summary || output.message !== diagnostic.message) {
      ctx.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'message, data.summary and the diagnostic message must match',
      });
    }
    const strict = diagnostic.code === STRICT_PUBLICATION_ROUTE_UNAVAILABLE_CODE;
    if (strict) {
      // strict 原因必须由真实的 strict-v1 route-null provenance 支撑，且不带 init 指引。
      if (
        !StrictUnavailablePublicationProvenanceSchema.safeParse(output.data.project.publication)
          .success
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'project', 'publication'],
          message: 'strict route-unavailable requires a strict-v1 route-null publication',
        });
      }
      if (output.data.nextActions.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'nextActions'],
          message: 'strict route-unavailable must not suggest alembic_init',
        });
      }
    } else if (output.data.project.publication.mode !== 'legacy') {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'project', 'publication', 'mode'],
        message: 'knowledge-database-unavailable requires a legacy publication',
      });
    }
    const runtime = output.data.projectRuntime;
    if (!runtime) {
      return;
    }
    const identity = runtime.identity;
    const project = output.data.project;
    for (const [field, expected, actual] of [
      ['projectRoot', identity.projectRoot, project.projectRoot],
      ['projectId', identity.projectId, project.projectId],
      ['dataRoot', identity.dataRoot, project.dataRoot],
      ['databasePath', identity.databasePath, project.databasePath],
    ] as const) {
      if (expected !== actual) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'project', field],
          message: `${field} must match projectRuntime.identity`,
        });
      }
    }
    if (strict && runtime.publication.mode !== 'strict-v1') {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'projectRuntime', 'publication'],
        message: 'strict route-unavailable requires a strict-v1 projectRuntime publication',
      });
    }
  });

export interface KnowledgeUnavailableProjection {
  /** 诊断/原因码：knowledge-database-unavailable 或 strict-publication-route-unavailable。 */
  reasonCode:
    | typeof KNOWLEDGE_DATABASE_UNAVAILABLE_CODE
    | typeof STRICT_PUBLICATION_ROUTE_UNAVAILABLE_CODE;
  /** strict route 缺失是已初始化项目的发布故障；legacy 无数据库只是"未初始化"。 */
  strictRouteUnavailable: boolean;
  summary: string;
  projectRoot: string;
  projectId: string | null;
  nextActions: Array<{ tool: 'alembic_init'; reason: string; required: false }>;
}

export type KnowledgeUnavailableResult = z.infer<typeof KnowledgeUnavailableResultSchema>;

/** 已校验的 unavailable producer 结果 → 各工具投影器共用的原生 unavailable 描述。 */
export function toKnowledgeUnavailableProjection(
  result: KnowledgeUnavailableResult
): KnowledgeUnavailableProjection {
  const diagnostic = result.data.diagnostics[0];
  return {
    reasonCode: diagnostic.code,
    strictRouteUnavailable: diagnostic.code === STRICT_PUBLICATION_ROUTE_UNAVAILABLE_CODE,
    summary: result.message,
    projectRoot: result.data.project.projectRoot,
    projectId: result.data.project.projectId,
    nextActions: result.data.nextActions,
  };
}

/**
 * 读取只读知识 producer 的 unavailable 结果，供 prime / search / recipe_map /
 * code_guard 投影器产出各自的原生 unavailable 输出。toolName 不一致时拒绝。
 */
export function readKnowledgeUnavailableResult(
  value: unknown,
  toolName: string
): KnowledgeUnavailableProjection | null {
  const parsed = KnowledgeUnavailableResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.toolName !== toolName) {
    return null;
  }
  return toKnowledgeUnavailableProjection(parsed.data);
}
