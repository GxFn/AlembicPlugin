import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function countProjectSkillKnowledgeEntries(dataRoot: string): number {
  const candidates = [path.join(dataRoot, '.asd', 'alembic.db'), path.join(dataRoot, 'alembic.db')];
  for (const dbPath of candidates) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    try {
      const db = new Database(dbPath, { fileMustExist: true, readonly: true });
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_entries'"
          )
          .get();
        if (!table) {
          continue;
        }
        const row = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get() as {
          count?: number;
        };
        return Number(row.count ?? 0);
      } finally {
        db.close();
      }
    } catch {}
  }
  return 0;
}
