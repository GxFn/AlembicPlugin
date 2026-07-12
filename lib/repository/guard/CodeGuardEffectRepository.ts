import { ViolationsStore } from '@alembic/core/guard';
import { createAlembicRepositories } from '@alembic/core/repositories';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

export interface GuardViolationRunEffect {
  filePath?: string;
  summary?: string;
  violations?: Array<Record<string, unknown>>;
}

export interface CodeGuardEffects {
  guardHits: Map<string, number>;
  primeAdoptions: Map<string, number>;
  violationRuns: GuardViolationRunEffect[];
}

/**
 * 提交 Guard 已声明的后置副作用，但不改变现有 SQLite journal posture。
 *
 * 通用 Core 连接面向完整 runtime，会主动切换 WAL；Guard 的窄 effect seam
 * 只打开已经迁移好的物理数据库，并复用 Core repositories / ViolationsStore
 * 的写入语义。路径 confinement 由调用方在打开前后各验证一次。
 */
export function persistCodeGuardEffects(databasePath: string, effects: CodeGuardEffects): void {
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 3000');
    const orm = drizzle(db);
    // Workspace installs may give Core and Plugin distinct Drizzle type identities even though
    // both wrap this exact connection. Keep the type bridge inside the repository adapter.
    const repositories = createAlembicRepositories({
      getDb: () => db,
      getDrizzle: () => orm,
    } as never);
    const violationsStore = new ViolationsStore(db, orm as never);
    const persist = db.transaction(() => {
      for (const run of effects.violationRuns) {
        violationsStore.appendRun(run);
      }
      for (const [id, count] of effects.guardHits) {
        repositories.knowledgeRepository.incrementGuardHitsSync(id, count);
      }
      for (const [id, count] of effects.primeAdoptions) {
        repositories.knowledgeRepository.incrementPrimeAdoptionsSync(id, count);
      }
    });
    persist();
  } finally {
    db.close();
  }
}
