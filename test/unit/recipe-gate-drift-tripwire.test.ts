/**
 * recipe-gate-drift-tripwire.test.ts — P1.5 per-rule drift tripwire.
 *
 * 把 gate 行为依赖的「权威常量」快照下来：任何未来对 Core gateRules 的编辑只要改动了
 * imperative verb allowlist 或 evidence-floor 策略，本快照就会**大声失败**，从而把「门禁值漂移」
 * 变成可见的回归，而不是悄悄改变 Plugin 的拒绝行为。常量来源是 Core 的 @alembic/core/knowledge，
 * 即 Plugin gate re-point 后真正消费的同一张表。
 */
import { describe, expect, it } from 'vitest';
import {
  getEvidenceFloorPolicy,
  getImperativeVerbAllowlist,
  validateAgainst,
} from '@alembic/core/knowledge';
import type { RecipeSessionScope } from '@alembic/core/knowledge';
import {
  type BootstrapSessionLike,
  createSessionScope,
} from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';

describe('recipe-gate drift tripwire — lifted gate constants', () => {
  it('imperative verb allowlist is stable (positive + negative Sets)', () => {
    const allowlist = getImperativeVerbAllowlist();
    // 一并断言数量（从 Set 派生，不硬编码字面数字）+ 完整列表，双重锁定。
    expect({
      positiveCount: allowlist.positive.length,
      negativeCount: allowlist.negative.length,
      positive: allowlist.positive,
      negative: allowlist.negative,
    }).toMatchSnapshot();
  });

  it('evidence-floor policy is stable (distinct-file floors + scope-escape)', () => {
    const policy = getEvidenceFloorPolicy();
    expect({
      ruleFiles: policy.ruleFiles,
      factFiles: policy.factFiles,
      // RegExp 用 source/flags 快照，避免对象序列化差异。
      scopeEscapeSource: policy.scopeEscape.source,
      scopeEscapeFlags: policy.scopeEscape.flags,
    }).toMatchSnapshot();
  });
});

describe('recipe-gate sessionScope port — Core contract', () => {
  it('createSessionScope satisfies RecipeSessionScope and surfaces SESSION_NOT_FOUND', () => {
    // 端口必须满足 Core 的 RecipeSessionScope 接口（编译期 + 运行期）。
    const port: RecipeSessionScope = createSessionScope({
      dimensionId: 'architecture',
      projectRoot: '/tmp/project',
      session: null,
    });
    const result = port({ projectRoot: '/tmp/project', dimensionId: 'architecture', itemIndex: 0, title: 't' });
    expect('violation' in result).toBe(true);
    if ('violation' in result) {
      expect(result.violation.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('createSessionScope returns ok when the session matches scope', () => {
    const session: BootstrapSessionLike = {
      id: 'session-1',
      projectRoot: '/tmp/project',
      dimensions: [{ id: 'architecture' }],
    };
    const port = createSessionScope({
      dimensionId: 'architecture',
      projectRoot: '/tmp/project',
      session,
    });
    const result = port({ projectRoot: '/tmp/project', dimensionId: 'architecture', itemIndex: 0, title: 't' });
    expect(result).toEqual({ ok: true });
  });

  it('validateAgainst can consume the sessionScope port (single-violation path)', () => {
    // 证明端口与 Core validateAgainst 形状兼容：注入后单条 session 违规会被 Core 采纳。
    const port = createSessionScope({
      dimensionId: 'architecture',
      projectRoot: '/tmp/project',
      session: null,
    });
    const out = validateAgainst([{ title: 'x', kind: 'fact', sourceRefs: ['lib/a.ts:1'] }], {
      stage: 2,
      path: 'host-cold-start',
      sessionScope: port,
      projectRoot: '/tmp/project',
      dimensionId: 'architecture',
    });
    expect(out[0]?.code).toBe('SESSION_NOT_FOUND');
  });
});
