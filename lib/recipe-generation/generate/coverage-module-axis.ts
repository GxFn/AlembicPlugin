export interface CoverageModulePathCandidate {
  id?: string;
  moduleId?: string;
  modulePath?: string;
  path?: string;
}

/**
 * R-1：Core 负责 canonical id 生成；Plugin 在喂入 Core 前只剔除 host 投影里的泛化父模块。
 * 例如 `Sources`/`src` 与 `Auth`/`src/auth` 同时存在时，前者只是容器轴，不能被 canonical 成真实 target。
 */
export function filterGenericParentCoverageModules<T extends CoverageModulePathCandidate>(
  modules: readonly T[]
): T[] {
  const indexed = modules.map((module, index) => ({
    index,
    module,
    moduleId: normalizeCoverageModuleAxisString(module.moduleId ?? module.id),
    modulePath: normalizeCoverageModuleAxisPath(module.modulePath ?? module.path),
  }));

  return indexed
    .filter((candidate) => {
      const candidatePath = candidate.modulePath;
      if (!candidatePath || isTargetScopedCoverageModuleAxisId(candidate.moduleId)) {
        return true;
      }
      return !indexed.some(
        (other) =>
          other.index !== candidate.index &&
          Boolean(other.modulePath) &&
          coverageModuleAxisPathContains(candidatePath, other.modulePath)
      );
    })
    .map((candidate) => candidate.module);
}

function isTargetScopedCoverageModuleAxisId(moduleId: string | undefined): boolean {
  return moduleId?.startsWith('target:') === true;
}

function coverageModuleAxisPathContains(
  parentPath: string,
  childPath: string | undefined
): boolean {
  if (!childPath || parentPath === childPath) {
    return false;
  }
  return childPath.startsWith(`${parentPath}/`);
}

function normalizeCoverageModuleAxisPath(value: string | undefined): string | undefined {
  const normalized = normalizeCoverageModuleAxisString(value)
    ?.replace(/\\/g, '/')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/^\.\//, '');
  return normalized;
}

function normalizeCoverageModuleAxisString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
