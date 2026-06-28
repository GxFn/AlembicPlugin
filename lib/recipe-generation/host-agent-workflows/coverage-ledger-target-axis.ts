interface CoverageLedgerAxisItem {
  moduleId?: string;
}

export function isTargetScopedCoverageModuleId(moduleId: string | undefined): moduleId is string {
  return typeof moduleId === 'string' && moduleId.trim().startsWith('target:');
}

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
