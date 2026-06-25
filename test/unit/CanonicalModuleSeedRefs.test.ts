/**
 * U1 #6（方案A）单测：canonicalizeModuleSeedRefs 把派生 seed 的 name/id 对齐 canonical
 * ProjectMap.modules，命中保留 seed（不退役），未命中保留原派生名，canonical 缺省时原样返回。
 */
import type { ProjectMap } from '@alembic/core/project-context';
import { describe, expect, test } from 'vitest';
import {
  canonicalizeModuleSeedRefs,
  type ProjectContextModuleSeed,
} from '#recipe-generation/host-agent-workflows/project-context-analysis.js';

// 构造最小 canonical ModuleSummary（path 经 ref.scope.filePath 提供）。
function canonicalModules(
  entries: Array<{ id: string; name: string; path?: string }>
): ProjectMap['modules'] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.path
      ? { ref: { kind: 'module', id: `ref-${entry.id}`, scope: { filePath: entry.path } } }
      : {}),
  })) as unknown as ProjectMap['modules'];
}

describe('canonicalizeModuleSeedRefs (U1 #6, 方案A)', () => {
  test('seed matching a canonical module path gets canonical name + id (seed kept)', () => {
    const seeds: ProjectContextModuleSeed[] = [
      // 派生名是 ad-hoc 末段 'auth'；canonical 名应覆盖成 'AuthModule'。
      { moduleName: 'auth', modulePath: 'src/auth', role: 'source-root' },
    ];
    const modules = canonicalModules([{ id: 'mod-auth', name: 'AuthModule', path: 'src/auth' }]);

    const result = canonicalizeModuleSeedRefs(seeds, modules);

    expect(result).toHaveLength(1); // seed 不退役
    expect(result[0]?.moduleName).toBe('AuthModule');
    expect(result[0]?.moduleId).toBe('mod-auth');
    expect(result[0]?.modulePath).toBe('src/auth'); // 其余字段不变
    expect(result[0]?.role).toBe('source-root');
  });

  test('seed matches via ownedFiles when modulePath absent', () => {
    const seeds: ProjectContextModuleSeed[] = [
      { moduleName: 'login', ownedFiles: ['src/auth/login.ts'], role: 'file-anchor' },
    ];
    const modules = canonicalModules([{ id: 'mod-auth', name: 'AuthModule', path: 'src/auth' }]);

    const result = canonicalizeModuleSeedRefs(seeds, modules);

    expect(result[0]?.moduleName).toBe('AuthModule');
    expect(result[0]?.moduleId).toBe('mod-auth');
  });

  test('most specific (longest path) canonical module wins', () => {
    const seeds: ProjectContextModuleSeed[] = [
      { moduleName: 'tax', modulePath: 'src/billing/tax', role: 'top-area' },
    ];
    const modules = canonicalModules([
      { id: 'mod-billing', name: 'BillingModule', path: 'src/billing' },
      { id: 'mod-tax', name: 'BillingTaxModule', path: 'src/billing/tax' },
    ]);

    const result = canonicalizeModuleSeedRefs(seeds, modules);

    expect(result[0]?.moduleName).toBe('BillingTaxModule');
    expect(result[0]?.moduleId).toBe('mod-tax');
  });

  test('seed with no canonical match keeps its derived name and id stays unset', () => {
    const seeds: ProjectContextModuleSeed[] = [
      { moduleName: 'vendored', modulePath: 'vendor/x', role: 'top-area' },
    ];
    const modules = canonicalModules([{ id: 'mod-auth', name: 'AuthModule', path: 'src/auth' }]);

    const result = canonicalizeModuleSeedRefs(seeds, modules);

    expect(result[0]?.moduleName).toBe('vendored');
    expect(result[0]?.moduleId).toBeUndefined();
  });

  test('undefined / empty canonical modules returns seeds unchanged', () => {
    const seeds: ProjectContextModuleSeed[] = [{ moduleName: 'auth', modulePath: 'src/auth' }];

    expect(canonicalizeModuleSeedRefs(seeds, undefined)).toEqual(seeds);
    expect(canonicalizeModuleSeedRefs(seeds, canonicalModules([]))).toEqual(seeds);
  });

  test('canonical modules without a path are ignored for matching', () => {
    const seeds: ProjectContextModuleSeed[] = [{ moduleName: 'auth', modulePath: 'src/auth' }];
    // 仅有无 path 的 canonical 模块 → 无前缀候选 → 原样返回。
    const modules = canonicalModules([{ id: 'mod-virtual', name: 'VirtualModule' }]);

    const result = canonicalizeModuleSeedRefs(seeds, modules);

    expect(result[0]?.moduleName).toBe('auth');
    expect(result[0]?.moduleId).toBeUndefined();
  });
});
