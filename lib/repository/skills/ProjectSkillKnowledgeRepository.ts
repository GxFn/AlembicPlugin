import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function countProjectSkillKnowledgeEntries(dataRoot: string): number {
  return countKnowledgeEntries(dataRoot);
}

export function countProjectDatabaseRecipes(dataRoot: string): number {
  // 当前统一模型里 knowledge_entries 是 DB 持久化 Recipe 表；磁盘 .md 导出数由
  // KnowledgeState 单独扫描 materializedRecipeCount，避免两个来源再次混淆。
  return countKnowledgeEntries(dataRoot);
}

function countKnowledgeEntries(dataRoot: string): number {
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
