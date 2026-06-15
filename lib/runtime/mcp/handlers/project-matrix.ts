import { resolveProjectRoot } from '@alembic/core/workspace';
import {
  defaultProjectKnowledgeContextLayer,
  defaultProjectMatrixProvider,
  type ProjectMatrixKnowledgeEntry,
} from '#service/project-knowledge-context/index.js';
import type { McpContext } from '../../../runtime/mcp/handlers/types.js';

interface ProjectMatrixArgs {
  activeFile?: unknown;
  agentHost?: unknown;
  budget?: unknown;
  detailLevel?: unknown;
  filters?: unknown;
  freshnessPolicy?: unknown;
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  inputSource?: unknown;
  intentKind?: unknown;
  intentRef?: unknown;
  language?: unknown;
  nodeId?: unknown;
  nodeType?: unknown;
  operation?: unknown;
  primeRef?: unknown;
  projectRoot?: unknown;
  query?: unknown;
  scope?: unknown;
  sourceEvidenceRefs?: unknown;
  sourceGraphRef?: unknown;
  sourceRefs?: unknown;
  workRef?: unknown;
}

interface KnowledgeServiceLike {
  list(
    filters: Record<string, unknown>,
    pagination: { page: number; pageSize: number }
  ):
    | Promise<{ data?: unknown[]; pagination?: { total?: number } } | { data?: unknown[] }>
    | {
        data?: unknown[];
        pagination?: { total?: number };
      };
}

export async function projectMatrix(ctx: McpContext, args: ProjectMatrixArgs) {
  const projectRoot = resolveMatrixProjectRoot(ctx, args);
  const operation = readString(args.operation) ?? 'overview';
  const sourceRefs = readStringArray(args.sourceRefs);
  const sourceEvidenceRefs = readStringArray(args.sourceEvidenceRefs);
  const sourceGraphRef = readString(args.sourceGraphRef);
  const knowledgeEntries = await readKnowledgeCatalogEntries(ctx);
  const matrix = await defaultProjectMatrixProvider.resolveMatrix({
    activeFile: readString(args.activeFile),
    knowledgeEntries,
    nodeId: readString(args.nodeId),
    nodeType: readString(args.nodeType),
    operation,
    projectRoot,
    sourceEvidenceRefs,
    sourceGraphRef,
    sourceRefs,
  });

  return defaultProjectKnowledgeContextLayer.resolveMcpResult(
    'alembic_project_matrix',
    {
      activeFile: readString(args.activeFile),
      agentHost: readString(args.agentHost),
      budget: args.budget,
      detailLevel: readString(args.detailLevel),
      filters: args.filters,
      freshnessPolicy: args.freshnessPolicy,
      hostDeclaredIntent: args.hostDeclaredIntent,
      hostTurnMeta: args.hostTurnMeta,
      inputSource: readString(args.inputSource),
      intentKind: readString(args.intentKind),
      intentRef: readString(args.intentRef),
      language: readString(args.language),
      nodeId: readString(args.nodeId),
      nodeType: readString(args.nodeType),
      operation,
      primeRef: readString(args.primeRef),
      projectRoot,
      query: readString(args.query),
      scope: args.scope,
      sourceEvidenceRefs,
      sourceGraphRef,
      sourceRefs,
      workRef: readString(args.workRef),
    },
    {
      payload: {
        detailRefs: matrix.detailRefs,
        diagnostics: matrix.diagnostics,
        inventory: matrix.inventory,
        items: matrix.items,
        matrixNodes: matrix.matrixNodes,
        nextActions: matrix.nextActions,
        relations: matrix.relations,
        result: matrix.result,
        sources: matrix.sources,
        summary: matrix.summary,
      },
      snapshot: {
        domainFreshness: matrix.domainFreshness,
        knowledgeItemCount: matrix.knowledgeItemCount,
        projectNodes: matrix.projectNodes,
        recipeRelationCount: matrix.recipeRelationCount,
        sourceGraphSupported: sourceGraphRef !== undefined,
      },
    }
  );
}

function resolveMatrixProjectRoot(ctx: McpContext, args: ProjectMatrixArgs): string | undefined {
  const explicit = readString(args.projectRoot);
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    return resolveProjectRoot(ctx.container);
  } catch {
    return undefined;
  }
}

async function readKnowledgeCatalogEntries(
  ctx: McpContext
): Promise<ProjectMatrixKnowledgeEntry[]> {
  let knowledgeService: KnowledgeServiceLike;
  try {
    knowledgeService = ctx.container.get('knowledgeService') as KnowledgeServiceLike;
  } catch {
    return [];
  }
  try {
    const result = await knowledgeService.list({}, { page: 1, pageSize: 80 });
    const rows = Array.isArray(result?.data) ? result.data : [];
    return rows
      .map(projectKnowledgeEntry)
      .filter((entry): entry is ProjectMatrixKnowledgeEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function projectKnowledgeEntry(row: unknown): ProjectMatrixKnowledgeEntry | null {
  const value =
    row && typeof row === 'object' && 'toJSON' in row && typeof row.toJSON === 'function'
      ? row.toJSON()
      : row;
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    ...(readString(record.category) === undefined ? {} : { category: readString(record.category) }),
    ...(readString(record.description) === undefined
      ? {}
      : { description: readString(record.description) }),
    ...(readString(record.kind) === undefined ? {} : { kind: readString(record.kind) }),
    ...(readString(record.language) === undefined ? {} : { language: readString(record.language) }),
    ...(readString(record.title) === undefined ? {} : { title: readString(record.title) }),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
