import type Database from 'better-sqlite3';

type ReadOnlyDatabase = InstanceType<typeof Database>;

/** Keep Guard snapshot SQL in the repository layer while the MCP host owns effect routing. */
export function createReadOnlyCodeGuardRepositories(db: ReadOnlyDatabase): {
  knowledgeRepository: ReadOnlyCodeGuardKnowledgeRepository;
  sourceRefRepository: ReadOnlyCodeGuardSourceRefRepository;
} {
  return {
    knowledgeRepository: new ReadOnlyCodeGuardKnowledgeRepository(db),
    sourceRefRepository: new ReadOnlyCodeGuardSourceRefRepository(db),
  };
}

class ReadOnlyCodeGuardKnowledgeRepository {
  readonly #db: ReadOnlyDatabase;

  constructor(db: ReadOnlyDatabase) {
    this.#db = db;
  }

  findGuardRulesSync(lifecycles: string[]): Array<Record<string, unknown>> {
    if (!tableExists(this.#db, 'knowledge_entries') || lifecycles.length === 0) {
      return [];
    }
    const placeholders = lifecycles.map(() => '?').join(',');
    return this.#db
      .prepare(
        `SELECT id, title, description, language, scope, constraints, lifecycle
           FROM knowledge_entries
          WHERE (kind = 'rule' OR knowledgeType = 'boundary-constraint')
            AND lifecycle IN (${placeholders})`
      )
      .all(...lifecycles) as Array<Record<string, unknown>>;
  }

  async findActiveGuardRecipes(): Promise<Array<Record<string, unknown>>> {
    if (!tableExists(this.#db, 'knowledge_entries')) {
      return [];
    }
    return this.#db
      .prepare(
        `SELECT * FROM knowledge_entries
          WHERE lifecycle = 'active'
            AND (kind = 'rule' OR knowledgeType = 'boundary-constraint')`
      )
      .all() as Array<Record<string, unknown>>;
  }

  findByIdsDetailSync(ids: string[]): Array<Record<string, unknown>> {
    if (!tableExists(this.#db, 'knowledge_entries') || ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(',');
    return this.#db
      .prepare(
        `SELECT id, content, description, trigger, headers, moduleName, tags, language,
                category, updatedAt, createdAt, quality, stats, difficulty,
                whenClause, doClause, dontClause, title, kind
           FROM knowledge_entries WHERE id IN (${placeholders})`
      )
      .all(...ids) as Array<Record<string, unknown>>;
  }

  incrementGuardHitsSync(): void {}

  incrementPrimeAdoptionsSync(): void {}
}

class ReadOnlyCodeGuardSourceRefRepository {
  readonly #db: ReadOnlyDatabase;

  constructor(db: ReadOnlyDatabase) {
    this.#db = db;
  }

  findAll(): Array<{ recipeId: string; sourcePath: string; status: string }> {
    if (!tableExists(this.#db, 'recipe_source_refs')) {
      return [];
    }
    return this.#db
      .prepare(
        `SELECT recipe_id AS recipeId, source_path AS sourcePath, status
           FROM recipe_source_refs ORDER BY recipe_id, source_path`
      )
      .all() as Array<{ recipeId: string; sourcePath: string; status: string }>;
  }
}

function tableExists(db: ReadOnlyDatabase, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table)
  );
}
