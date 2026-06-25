/**
 * canonical-module-axis — U1 #5 的纯函数模块轴工具。
 *
 * 作用：把「canonical ProjectMap.modules」投影成 RecipeProductionGateway 需要的两个注入依赖：
 *   1. knownModuleNames —— canonical 模块名集合（Core 用它校验 Agent 显式 moduleName 是否越界）；
 *   2. resolveModuleFromSourceRefs —— 从 candidate sourceRefs 落点反查 canonical 模块名
 *      （Core 在 Agent 未显式给 moduleName 时用它派生，与覆盖轴同源）。
 *
 * 这里只做无副作用的纯计算（不读 DB、不扫项目、不碰维护游标存储）；canonical 模块列表
 * 由调用方提供（来自 ProjectMap.modules / ModuleService.listCanonicalModules）。模块列表为空时
 * 两个 builder 都返回「空/恒 undefined」，让 Core 退回原 passthrough 行为（加性、向后兼容）。
 */

/** canonical 模块的最小投影：name 必有，path 可选（path 用于 sourceRefs 前缀匹配）。 */
export interface CanonicalModuleRef {
  id?: string;
  name: string;
  path?: string;
}

/**
 * 归一化路径：统一反斜杠为正斜杠并去掉首尾分隔符，保证前缀匹配两侧坐标系一致。
 * 与 project-source-facts 的 normalize 同语义，但本模块零依赖、可独立单测。
 */
function normalizeAxisPath(value: string | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').trim();
}

/**
 * canonical 模块名集合（去重、去空）。供 Core knownModuleNames：Agent 显式 moduleName 不在此集合 → Core 留空+诊断。
 */
export function buildKnownModuleNames(modules: readonly CanonicalModuleRef[]): string[] {
  const names = new Set<string>();
  for (const module of modules) {
    const name = module.name.trim();
    if (name.length > 0) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * 构造 resolveModuleFromSourceRefs 闭包：给定一批 sourceRefs，返回命中的 canonical 模块名。
 *
 * 匹配规则：对每条 sourceRef（取归一化路径），找「path 是该 ref 路径前缀」的 canonical 模块；
 * 多个候选时取最长 path（最具体的模块）。任一 ref 命中即返回该模块名；全部不命中返回 undefined
 * （Core 据此留空+诊断，不再恒空兜底）。无 path 的 canonical 模块不参与前缀匹配。
 *
 * 仅依赖纯路径前缀，不读维护游标存储、不触达持久化。
 */
export function buildResolveModuleFromSourceRefs(
  modules: readonly CanonicalModuleRef[]
): (sourceRefs: string[]) => string | undefined {
  // 预计算 (归一化 path, name) 候选，按 path 长度降序，命中即取最具体模块。
  const pathCandidates = modules
    .map((module) => ({ name: module.name.trim(), path: normalizeAxisPath(module.path) }))
    .filter((candidate) => candidate.name.length > 0 && candidate.path.length > 0)
    .sort((left, right) => right.path.length - left.path.length);

  return (sourceRefs: string[]): string | undefined => {
    if (pathCandidates.length === 0) {
      return undefined;
    }
    for (const rawRef of sourceRefs) {
      const refPath = normalizeAxisPath(extractSourceRefPath(rawRef));
      if (refPath.length === 0) {
        continue;
      }
      const hit = pathCandidates.find(
        (candidate) => refPath === candidate.path || refPath.startsWith(`${candidate.path}/`)
      );
      if (hit) {
        return hit.name;
      }
    }
    return undefined;
  };
}

/**
 * 从单条 sourceRef 取文件路径部分。sourceRef 形如 `path/to/file.ts:10-20` 或纯路径；
 * 这里只切掉末尾的 `:行号` 锚点，保留路径用于模块前缀匹配。
 */
function extractSourceRefPath(rawRef: string): string {
  if (typeof rawRef !== 'string') {
    return '';
  }
  const trimmed = rawRef.trim();
  // 末段 `:<digits>` 或 `:<digits>-<digits>` 视为行锚点，剥离之；Windows 盘符 `C:` 不在此形态。
  const anchorMatch = trimmed.match(/:(\d+)(?:-\d+)?$/);
  return anchorMatch ? trimmed.slice(0, anchorMatch.index) : trimmed;
}
