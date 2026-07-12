import type {
  RecipeContextKnowledgeEntry,
  RecipeContextKnowledgeService,
  RecipeContextSourceRefRecord,
  RecipeContextSourceRefService,
} from '@alembic/core/recipe-context-capabilities';
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
} as const;

/** Minimal RecipeContext read ports over a request-scoped SQLite snapshot. */
export function createReadOnlyRecipeMapRepositories(db: ReadOnlyDatabase): {
  knowledgeService: RecipeContextKnowledgeService;
  sourceRefRepository: RecipeContextSourceRefService;
} {
  return {
    knowledgeService: new ReadOnlyRecipeContextKnowledgeService(db),
    sourceRefRepository: new ReadOnlyRecipeSourceRefRepository(db),
  };
}

class ReadOnlyRecipeContextKnowledgeService implements RecipeContextKnowledgeService {
  readonly #db: ReadOnlyDatabase;

  constructor(db: ReadOnlyDatabase) {
    this.#db = db;
  }

  async get(id: string): Promise<RecipeContextKnowledgeEntry> {
    const row = this.#hasKnowledgeTable()
      ? (this.#db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    if (!row) {
      throw new Error(`Recipe not found: ${id}`);
    }
    return toKnowledgeEntry(row);
  }

  async list(
    filters: Record<string, unknown> = {},
    pagination: { page?: number; pageSize?: number } = {}
  ): Promise<{
    data: RecipeContextKnowledgeEntry[];
    pagination: { page: number; pageSize: number; total: number };
  }> {
    const page = positiveInteger(pagination.page, 1);
    const pageSize = positiveInteger(pagination.pageSize, 20);
    if (!this.#hasKnowledgeTable()) {
      return { data: [], pagination: { page, pageSize, total: 0 } };
    }

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
          .get(...values) as { total: number }
      ).total
    );
    const rows = this.#db
      .prepare(`SELECT * FROM knowledge_entries ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return {
      data: rows.map(toKnowledgeEntry),
      pagination: { page, pageSize, total },
    };
  }

  #hasKnowledgeTable(): boolean {
    return tableExists(this.#db, 'knowledge_entries');
  }
}

class ReadOnlyRecipeSourceRefRepository implements RecipeContextSourceRefService {
  readonly #db: ReadOnlyDatabase;

  constructor(db: ReadOnlyDatabase) {
    this.#db = db;
  }

  findByRecipeId(recipeId: string): RecipeContextSourceRefRecord[] {
    return this.#query('recipe_id = ?', recipeId);
  }

  findBySourcePath(sourcePath: string): RecipeContextSourceRefRecord[] {
    return this.#query('source_path = ?', sourcePath);
  }

  findByStatus(status: string): RecipeContextSourceRefRecord[] {
    return this.#query('status = ?', status);
  }

  findStale(): RecipeContextSourceRefRecord[] {
    return this.findByStatus('stale');
  }

  findRenamed(): RecipeContextSourceRefRecord[] {
    return this.findByStatus('renamed');
  }

  #query(where: string, value: string): RecipeContextSourceRefRecord[] {
    if (!tableExists(this.#db, 'recipe_source_refs')) {
      return [];
    }
    const columns = tableColumns(this.#db, 'recipe_source_refs');
    const newPath = columns.has('new_path') ? 'new_path' : 'NULL AS new_path';
    const verifiedAt = columns.has('verified_at') ? 'verified_at' : 'NULL AS verified_at';
    return (
      this.#db
        .prepare(
          `SELECT recipe_id, source_path, status, ${newPath}, ${verifiedAt}
             FROM recipe_source_refs
            WHERE ${where}
            ORDER BY recipe_id, source_path`
        )
        .all(value) as Array<Record<string, unknown>>
    ).map((row) => ({
      recipeId: String(row.recipe_id),
      sourcePath: String(row.source_path),
      status: String(row.status),
      ...(typeof row.new_path === 'string' ? { newPath: row.new_path } : {}),
      ...(typeof row.verified_at === 'number' ? { verifiedAt: row.verified_at } : {}),
    }));
  }
}

function toKnowledgeEntry(row: Record<string, unknown>): RecipeContextKnowledgeEntry {
  const wire = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      JSON_COLUMNS.has(key) ? parseJsonColumn(value) : value,
    ])
  );
  return { toJSON: () => wire };
}

function tableExists(db: ReadOnlyDatabase, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table)
  );
}

function tableColumns(db: ReadOnlyDatabase, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
  );
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
