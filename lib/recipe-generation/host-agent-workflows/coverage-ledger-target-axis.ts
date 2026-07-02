interface CoverageLedgerAxisItem {
  moduleId?: string;
}

// W2(2026-07-02 全空间统一):谓词改用 Core 权威版——此前本地裸 startsWith 影子实现
// 语义弱于 Core 版(缺 normalizeCoverageLedgerString 归一,大小写/空白差异会误判)。
import { isTargetScopedCoverageModuleId } from '@alembic/core/host-agent-workflows';
export { isTargetScopedCoverageModuleId };

export function preferTargetScopedCoverageItems<T extends CoverageLedgerAxisItem>(
  items: readonly T[]
): {
  filteredCount: number;
  items: T[];
  mode: 'target-scoped' | 'unchanged';
  targetScopedCount: number;
} {
  const targetScopedItems = items.filter((item) => isTargetScopedCoverageModuleId(item.moduleId));
  if (targetScopedItems.length === 0) {
    return {
      filteredCount: 0,
      items: [...items],
      mode: 'unchanged',
      targetScopedCount: 0,
    };
  }
  return {
    filteredCount: items.length - targetScopedItems.length,
    items: targetScopedItems,
    mode: 'target-scoped',
    targetScopedCount: targetScopedItems.length,
  };
}

export function countTargetScopedCoverageItems(items: readonly CoverageLedgerAxisItem[]): number {
  return items.filter((item) => isTargetScopedCoverageModuleId(item.moduleId)).length;
}

export function uniqueTargetScopedCoverageModuleCount(
  items: readonly CoverageLedgerAxisItem[]
): number {
  const moduleIds = new Set<string>();
  for (const item of items) {
    const moduleId = item.moduleId;
    if (isTargetScopedCoverageModuleId(moduleId)) {
      moduleIds.add(moduleId.trim());
    }
  }
  return moduleIds.size;
}
