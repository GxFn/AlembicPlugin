import { isAbsolute, normalize, relative } from 'node:path';

const IGNORED_ANY_SEGMENTS = new Set([
  '.asd',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'DerivedData',
  'node_modules',
]);

const IGNORED_GENERATED_SEGMENTS = new Set(['build', 'coverage', 'dist', 'target']);

const IGNORED_ROOT_SEGMENTS = new Set(['.cache', 'cache', 'logs', 'temp', 'tmp', 'vendor']);

// G1（2026-07-06 scale-guard 截断根修）：知识无关的协作运行台账按前缀忽略。
// Wakeflow 控制器把 demand/task-packages/target-results/archive 等状态机数据写在
// `wakeflow-ledger/workspace/` 下（真机 503 dirty paths 中 450 条全是其 archive/
// 一次性归档，写后不变）；它们不是项目知识源（recipe_source_refs 对该前缀零引用，
// 引用的是 wakeflow-ledger/<RepoName>/ 设计文档——不在此前缀内、保持可检测）。
// 非 Wakeflow 工作区没有该目录，规则零影响。
const IGNORED_PATH_PREFIXES = ['wakeflow-ledger/workspace/'];

const IGNORED_EXTENSIONS = ['.log'];

export function normalizeProjectRelativePath(filePath: string): string {
  let normalized = normalize(filePath).replaceAll('\\', '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized === '.' ? '' : normalized;
}

export function toProjectRelativePath(filePath: string, projectRoot: string): string {
  if (!isAbsolute(filePath)) {
    return normalizeProjectRelativePath(filePath);
  }
  return normalizeProjectRelativePath(relative(projectRoot, filePath));
}

export function isSafeProjectRelativePath(filePath: string): boolean {
  const normalized = normalizeProjectRelativePath(filePath);
  return (
    normalized.length > 0 &&
    !isAbsolute(normalized) &&
    !normalized.startsWith('../') &&
    normalized !== '..' &&
    !normalized.includes('/../')
  );
}

export function shouldIgnoreProjectPath(filePath: string): boolean {
  const normalized = normalizeProjectRelativePath(filePath);
  if (normalized.length === 0) {
    return false;
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => IGNORED_ANY_SEGMENTS.has(part))) {
    return true;
  }
  if (parts.some((part) => IGNORED_GENERATED_SEGMENTS.has(part))) {
    return true;
  }
  if (parts[0] && IGNORED_ROOT_SEGMENTS.has(parts[0])) {
    return true;
  }
  if (IGNORED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return IGNORED_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}
