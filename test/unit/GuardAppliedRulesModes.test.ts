/**
 * D4(2026-07-11,P-D 活体矩阵登记):appliedRules 三模式对齐回归。
 * G2(2026-07-06)只给 review 模式补了"应用规则正面清单";code(guardCheck)/
 * audit(guardAuditFiles)两模式仍缺——BiliDili 真机 0 violations 时宿主无法区分
 * "检查了且干净"与"没什么规则可查"。本测锁 code/audit 两模式 data.appliedRules
 * 存在且形态与 review 同源(total/bySource/sample)。
 */
import { GuardCheckEngine } from '@alembic/core/guard';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { guardAuditFiles, guardCheck } from '../../lib/host-runtime/mcp/handlers/guard.js';

function createMinimalDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      language TEXT,
      scope TEXT,
      constraints TEXT,
      lifecycle TEXT DEFAULT 'active',
      kind TEXT DEFAULT 'rule',
      knowledgeType TEXT
    );
  `);
  return db;
}

function createCtx() {
  const engine = new GuardCheckEngine(
    createMinimalDB() as unknown as ConstructorParameters<typeof GuardCheckEngine>[0]
  );
  // 最小 DI:仅 guardCheckEngine;其余服务缺席走各自静默降级分支
  // (enhancement 注入/skillHooks/violationsStore 均 try-catch 包裹)。
  return {
    container: {
      get(name: string): unknown {
        if (name === 'guardCheckEngine') {
          return engine;
        }
        throw new Error(`not registered in test ctx: ${name}`);
      },
    },
  } as unknown as Parameters<typeof guardCheck>[0];
}

describe('guard appliedRules 模式对齐(D4)', () => {
  it('code 模式:0 violations 也交付 appliedRules(可判读的干净)', async () => {
    const result = await guardCheck(createCtx(), {
      code: 'let value = compute()\n',
      language: 'swift',
    } as Parameters<typeof guardCheck>[1]);
    const data = result.data as {
      violations: unknown[];
      appliedRules?: { total: number; bySource: Record<string, number>; sample: unknown[] };
    };
    expect(data.appliedRules).toBeDefined();
    expect(data.appliedRules?.total).toBeGreaterThan(0);
    expect(Object.keys(data.appliedRules?.bySource ?? {}).length).toBeGreaterThan(0);
  });

  it('audit 模式:文件语言集合驱动 appliedRules 枚举', async () => {
    const result = await guardAuditFiles(createCtx(), {
      files: [{ path: '/virtual/App.swift', content: 'let x = compute()\n' }],
    } as Parameters<typeof guardAuditFiles>[1]);
    const data = result.data as {
      appliedRules?: { total: number };
      files: unknown[];
    };
    expect(data.appliedRules).toBeDefined();
    expect(data.appliedRules?.total).toBeGreaterThan(0);
  });
});
