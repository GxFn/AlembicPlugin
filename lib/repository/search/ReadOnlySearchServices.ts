import type Database from 'better-sqlite3';

type ReadOnlyDatabase = InstanceType<typeof Database>;

const JSON_COLUMNS = new Set([
  'agentNotes',
  'constraints',
  'content',
  'headerPaths',
  'headers',
  'includeHeaders',
  'lifecycleHistory',
  'quality',
  'reasoning',
  'relations',
  'stats',
  'tags',
]);

const FILTER_COLUMNS = {
  category: 'category',
  dimensionId: 'dimensionId',
  kind: 'kind',
  knowledgeType: 'knowledgeType',
  language: 'language',
  lifecycle: 'lifecycle',
  scope: 'scope',
  source: 'source',
} as const;

interface ReadOnlyKnowledgeEntry extends Record<string, unknown> {
  id: string;
  sourceRefs: string[];
}

interface KnowledgeListResult {
  data: ReadOnlyKnowledgeEntry[];
  page: number;
  pageSize: number;
  total: number;
}

/** Keep raw read SQL in the repository layer while the MCP host owns route selection only. */
export function createReadOnlySearchRepositories(db: ReadOnlyDatabase): {
  checkpointRepository: ReadOnlyGitDiffCheckpointRepository;
  knowledgeService: ReadOnlyKnowledgeService;
} {
  return {
    checkpointRepository: new ReadOnlyGitDiffCheckpointRepository(db),
    knowledgeService: new ReadOnlyKnowledgeService(db),
  };
}

class ReadOnlyKnowledgeService {
  readonly #db: ReadOnlyDatabase;

  constructor(db: ReadOnlyDatabase) {
    this.#db = db;
  }

  async get(id: string): Promise<ReadOnlyKnowledgeEntry | null> {
    const row = this.#db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id);
    return row ? this.#projectRow(row as Record<string, unknown>) : null;
  }

  async list(
    filters: Record<string, unknown> = {},
    pagination: { page?: number; pageSize?: number } = {}
  ): Promise<KnowledgeListResult> {
    const page = positiveInteger(pagination.page, 1);
    const pageSize = positiveInteger(pagination.pageSize, 20);
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const [filterName, column] of Object.entries(FILTER_COLUMNS)) {
      const value = filters[filterName];
      if (typeof value === 'string' && value.length > 0) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (typeof filters.tag === 'string' && filters.tag.length > 0) {
      clauses.push("tags LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(filters.tag)}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(
      (
        this.#db
          .prepare(`SELECT COUNT(*) AS total FROM knowledge_entries ${where}`)
          .get(...values) as {
          total: number;
        }
      ).total
    );
    const rows = this.#db
      .prepare(`SELECT * FROM knowledge_entries ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return {
      data: rows.map((row) => this.#projectRow(row)),
      page,
      pageSize,
      total,
    };
  }

  #projectRow(row: Record<string, unknown>): ReadOnlyKnowledgeEntry {
    const projected = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        JSON_COLUMNS.has(key) ? parseJsonColumn(value) : value,
      ])
    ) as ReadOnlyKnowledgeEntry;
    projected.sourceRefs = this.#db
      .prepare(
        `SELECT source_path
           FROM recipe_source_refs
          WHERE recipe_id = ? AND status != 'missing'
          ORDER BY source_path`
      )
      .all(projected.id)
      .map((sourceRef) => String((sourceRef as { source_path: unknown }).source_path));
    return projected;
  }
}

class ReadOnlyGitDiffCheckpointRepository {
  readonly #db: ReadOnlyDatabase;

  constructor(db: ReadOnlyDatabase) {
    this.#db = db;
  }

  get(scope: {
    folderId: string;
    projectRoot: string;
    scopeId: string;
  }): Record<string, unknown> | null {
    const row = this.#db
      .prepare(
        `SELECT *
           FROM git_diff_checkpoints
          WHERE project_root = ? AND scope_id = ? AND folder_id = ?
          LIMIT 1`
      )
      .get(scope.projectRoot, scope.scopeId, scope.folderId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      ...row,
      advancedAt: row.advanced_at,
      checkpointCommit: row.checkpoint_commit,
      initialFromPlanCommit: row.initial_from_plan_commit,
      lastRouteReason: row.last_route_reason,
      lastRouteStatus: row.last_route_status,
      lastScannedAt: row.last_scanned_at,
      mergeBaseCommit: row.merge_base_commit,
      targetCommit: row.target_commit,
    };
  }
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
