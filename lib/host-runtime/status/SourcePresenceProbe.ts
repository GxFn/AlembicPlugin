import { type Dirent, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_SOURCE_FILE_LIMIT = 25;

const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'Pods',
  'Carthage',
  '.build',
  'DerivedData',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
  '.idea',
  'out',
  'coverage',
  '.cache',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'Alembic',
]);

const SOURCE_CODE_EXTS = new Set([
  '.swift',
  '.m',
  '.mm',
  '.h',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.rb',
  '.vue',
  '.svelte',
  '.c',
  '.cpp',
  '.cs',
]);

export interface SourcePresence {
  capped: boolean;
  hasSource: boolean;
  maxDepth: number;
  sourceFileCount: number;
  sourceFileLimit: number;
  unreadableDirectoryCount: number;
}

export interface SourcePresenceProbeOptions {
  maxDepth?: number;
  sourceFileLimit?: number;
}

interface WalkState {
  capped: boolean;
  count: number;
  unreadableDirectoryCount: number;
}

export function probeSourcePresence(
  projectRoot: string,
  options: SourcePresenceProbeOptions = {}
): SourcePresence {
  const maxDepth = normalizePositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const sourceFileLimit = normalizePositiveInteger(
    options.sourceFileLimit,
    DEFAULT_SOURCE_FILE_LIMIT
  );
  const state: WalkState = {
    capped: false,
    count: 0,
    unreadableDirectoryCount: 0,
  };

  walkSourceTree(projectRoot, 0, maxDepth, sourceFileLimit, state);

  return {
    capped: state.capped,
    hasSource: state.count > 0,
    maxDepth,
    sourceFileCount: state.count,
    sourceFileLimit,
    unreadableDirectoryCount: state.unreadableDirectoryCount,
  };
}

function walkSourceTree(
  dir: string,
  depth: number,
  maxDepth: number,
  sourceFileLimit: number,
  state: WalkState
): void {
  if (state.count >= sourceFileLimit) {
    state.capped = true;
    return;
  }
  if (depth > maxDepth) {
    return;
  }

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  } catch {
    state.unreadableDirectoryCount += 1;
    return;
  }

  for (const entry of entries) {
    if (state.count >= sourceFileLimit) {
      state.capped = true;
      return;
    }
    if (entry.isFile() && SOURCE_CODE_EXTS.has(extname(entry.name).toLowerCase())) {
      state.count += 1;
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.') || SCAN_EXCLUDE_DIRS.has(entry.name)) {
      continue;
    }
    walkSourceTree(join(dir, entry.name), depth + 1, maxDepth, sourceFileLimit, state);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
