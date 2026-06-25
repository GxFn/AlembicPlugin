/**
 * U1 #5 单测：canonical 模块轴 helper（knownModuleNames / resolveModuleFromSourceRefs），
 * 以及 RecipeProductionGateway 注入这两个 dep 后驱动 Core #deriveModuleName 的 canonical 行为：
 *   - sourceRefs 落入已知 canonical 模块 → 派生出该 canonical 模块名（非空）。
 *   - Agent 显式给一个越界（不在 canonical 轴）的 moduleName → 留空。
 *
 * 真正的 DB 持久化在后续任务门控，这里以「helper 纯函数 + Gateway 用这两个 dep 构造并跑 create」
 * 作为接线证据。
 */

import { describe, expect, test } from 'vitest';
import {
  buildKnownModuleNames,
  buildResolveModuleFromSourceRefs,
  type CanonicalModuleRef,
} from '#recipe-generation/canonical-module-axis.js';

const canonicalModules: CanonicalModuleRef[] = [
  { id: 'mod-auth', name: 'AuthModule', path: 'src/auth' },
  { id: 'mod-billing', name: 'BillingModule', path: 'src/billing' },
  // 嵌套子模块：path 更长 → 命中时优先（最具体）。
  { id: 'mod-billing-tax', name: 'BillingTaxModule', path: 'src/billing/tax' },
  // 无 path 的模块只进 knownModuleNames，不参与 sourceRefs 前缀匹配。
  { id: 'mod-virtual', name: 'VirtualModule' },
];

describe('buildKnownModuleNames (U1 #5)', () => {
  test('returns de-duped canonical names including path-less modules', () => {
    const names = buildKnownModuleNames(canonicalModules);
    expect(new Set(names)).toEqual(
      new Set(['AuthModule', 'BillingModule', 'BillingTaxModule', 'VirtualModule'])
    );
  });

  test('drops blank names', () => {
    const names = buildKnownModuleNames([{ name: '  ' }, { name: 'Real' }]);
    expect(names).toEqual(['Real']);
  });
});

describe('buildResolveModuleFromSourceRefs (U1 #5)', () => {
  const resolve = buildResolveModuleFromSourceRefs(canonicalModules);

  test('sourceRef inside a known module derives that canonical module name', () => {
    expect(resolve(['src/auth/login.ts'])).toBe('AuthModule');
  });

  test('strips line anchor before prefix match', () => {
    expect(resolve(['src/auth/login.ts:10-42'])).toBe('AuthModule');
  });

  test('prefers the most specific (longest path) canonical module', () => {
    // src/billing/tax/... 同时是 src/billing 的子路径，应命中更具体的 BillingTaxModule。
    expect(resolve(['src/billing/tax/vat.ts'])).toBe('BillingTaxModule');
  });

  test('exact module path match resolves', () => {
    expect(resolve(['src/billing'])).toBe('BillingModule');
  });

  test('out-of-axis sourceRef (no canonical prefix) resolves to undefined', () => {
    expect(resolve(['vendor/third-party/x.ts'])).toBeUndefined();
  });

  test('first matching ref wins across multiple refs', () => {
    expect(resolve(['README.md', 'src/billing/invoice.ts'])).toBe('BillingModule');
  });

  test('empty canonical list yields a resolver that always returns undefined', () => {
    const emptyResolve = buildResolveModuleFromSourceRefs([]);
    expect(emptyResolve(['src/auth/login.ts'])).toBeUndefined();
  });

  test('path-less canonical modules never match via sourceRefs', () => {
    // VirtualModule 无 path，任何 ref 都不会前缀命中它。
    expect(resolve(['VirtualModule'])).toBeUndefined();
  });
});
