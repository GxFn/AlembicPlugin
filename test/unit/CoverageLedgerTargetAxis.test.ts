import { describe, expect, test } from 'vitest';
import {
  isTargetScopedCoverageModuleId,
  preferTargetScopedCoverageItems,
  uniqueTargetScopedCoverageModuleCount,
} from '#recipe-generation/host-agent-workflows/coverage-ledger-target-axis.js';

describe('coverage ledger target axis helpers', () => {
  test('recognizes only ProjectMap target-scoped module ids', () => {
    expect(isTargetScopedCoverageModuleId('target:Auth:Sources/Auth')).toBe(true);
    expect(isTargetScopedCoverageModuleId('module:root:BiliDili:BiliDili')).toBe(false);
    expect(isTargetScopedCoverageModuleId('BiliDili')).toBe(false);
    expect(isTargetScopedCoverageModuleId('Sources')).toBe(false);
  });

  test('filters mixed advisory cells to target-scoped ids when target cells exist', () => {
    const result = preferTargetScopedCoverageItems([
      { moduleId: 'target:Auth:Sources/Auth', valueScore: 90 },
      { moduleId: 'Sources', valueScore: 80 },
      { moduleId: 'module:root:BiliDili:BiliDili', valueScore: 70 },
      { moduleId: 'target:VideoPlay:Sources/Features/VideoPlay', valueScore: 60 },
    ]);

    expect(result.mode).toBe('target-scoped');
    expect(result.filteredCount).toBe(2);
    expect(result.items.map((item) => item.moduleId)).toEqual([
      'target:Auth:Sources/Auth',
      'target:VideoPlay:Sources/Features/VideoPlay',
    ]);
    expect(uniqueTargetScopedCoverageModuleCount(result.items)).toBe(2);
  });

  test('keeps legacy aggregate-only cells when no target-scoped axis exists', () => {
    const result = preferTargetScopedCoverageItems([
      { moduleId: 'Sources' },
      { moduleId: 'Packages/AOXUIKit' },
    ]);

    expect(result.mode).toBe('unchanged');
    expect(result.filteredCount).toBe(0);
    expect(result.items.map((item) => item.moduleId)).toEqual(['Sources', 'Packages/AOXUIKit']);
  });
});
