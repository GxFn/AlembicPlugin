import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LanguageService } from '@alembic/core/shared';

export interface ProjectSourceFileFact {
  filePath: string;
  language: string;
  sizeBytes: number;
}

export interface ProjectModuleSeedLike {
  moduleName: string;
  modulePath?: string;
  ownedFiles?: readonly string[];
}

export interface CollectProjectSourceFileFactsOptions {
  maxFiles?: number;
  sourceFolders?: readonly string[];
}

const DEFAULT_PROJECT_SOURCE_SCAN_MAX_FILES = 5000;
const DEFAULT_MODULE_OWNED_FILE_LIMIT = 400;
const PROJECT_SOURCE_SCAN_EXCLUDE_DIRS = new Set([
  ...LanguageService.scanSkipDirs,
  '.asd',
  '.git',
  '.wakeflow-active',
  '.wakeflow-local',
  'DerivedData',
  'node_modules',
]);

export async function collectProjectSourceFileFacts(
  projectRoot: string,
  options: CollectProjectSourceFileFactsOptions = {}
): Promise<ProjectSourceFileFact[]> {
  const maxFiles = normalizePositiveInteger(
    options.maxFiles,
    DEFAULT_PROJECT_SOURCE_SCAN_MAX_FILES
  );
  const absoluteRoot = path.resolve(projectRoot);
  const sourceFolders = normalizeProjectSourceFolders(options.sourceFolders, absoluteRoot);
  if (sourceFolders.length === 0) {
    return scanProjectSourceFolder({
      absoluteRoot,
      maxFiles,
      scanRoot: absoluteRoot,
    });
  }

  const facts: ProjectSourceFileFact[] = [];
  const baseBudget = Math.floor(maxFiles / sourceFolders.length);
  const remainder = maxFiles % sourceFolders.length;
  for (const [index, sourceFolder] of sourceFolders.entries()) {
    const budget = baseBudget + (index < remainder ? 1 : 0);
    if (budget <= 0) {
      continue;
    }
    facts.push(
      ...(await scanProjectSourceFolder({
        absoluteRoot,
        maxFiles: budget,
        scanRoot: path.join(absoluteRoot, sourceFolder),
      }))
    );
    if (facts.length >= maxFiles) {
      break;
    }
  }
  return facts
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .slice(0, maxFiles);
}

async function scanProjectSourceFolder(input: {
  absoluteRoot: string;
  maxFiles: number;
  scanRoot: string;
}): Promise<ProjectSourceFileFact[]> {
  const facts: ProjectSourceFileFact[] = [];
  const pending = [input.scanRoot];
  while (pending.length > 0 && facts.length < input.maxFiles) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    const entries = await safeReadDir(current);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toProjectContextPath(path.relative(input.absoluteRoot, absolutePath));
      if (!relativePath || relativePath.startsWith('..')) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!PROJECT_SOURCE_SCAN_EXCLUDE_DIRS.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const language = LanguageService.inferLang(relativePath);
      if (language === 'unknown') {
        continue;
      }
      const stat = await safeStat(absolutePath);
      facts.push({
        filePath: relativePath,
        language,
        sizeBytes: stat?.size ?? 0,
      });
      if (facts.length >= input.maxFiles) {
        break;
      }
    }
  }
  return facts.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function attachSourceFilesToProjectContextModuleSeeds<T extends ProjectModuleSeedLike>(
  seeds: readonly T[],
  sourceFileFacts: readonly ProjectSourceFileFact[],
  options: { ownedFileLimit?: number } = {}
): T[] {
  const sourceFilesByPath = new Set(sourceFileFacts.map((file) => file.filePath));
  const ownedFileLimit = normalizePositiveInteger(
    options.ownedFileLimit,
    DEFAULT_MODULE_OWNED_FILE_LIMIT
  );
  return mergeProjectContextModuleSeeds(
    seeds
      .map((seed) => {
        const modulePath = normalizeProjectContextPath(seed.modulePath);
        const explicitFiles = uniqueStrings(
          (seed.ownedFiles ?? [])
            .map(normalizeProjectContextPath)
            .filter(isPresent)
            .filter((filePath) => sourceFilesByPath.has(filePath))
        );
        const matchedFiles = sourceFilesForModuleSeed(modulePath, sourceFileFacts).map(
          (file) => file.filePath
        );
        const ownedFiles = uniqueStrings([...explicitFiles, ...matchedFiles]).slice(
          0,
          ownedFileLimit
        );
        return {
          ...seed,
          ...(modulePath ? { modulePath } : {}),
          ownedFiles: ownedFiles.length > 0 ? ownedFiles : undefined,
        };
      })
      .filter((seed) => hasUsableSeedScope(seed) && (seed.ownedFiles?.length ?? 0) > 0)
  );
}

export function normalizeProjectContextPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.') {
    return undefined;
  }
  return trimmed.replace(/\\/g, '/').replace(/\/$/, '');
}

async function safeReadDir(directoryPath: string): Promise<Dirent[]> {
  try {
    return (await fs.readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  } catch {
    return [];
  }
}

async function safeStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function sourceFilesForModuleSeed(
  modulePath: string | undefined,
  sourceFileFacts: readonly ProjectSourceFileFact[]
): ProjectSourceFileFact[] {
  if (!modulePath) {
    return [];
  }
  return sourceFileFacts.filter(
    (file) => file.filePath === modulePath || file.filePath.startsWith(`${modulePath}/`)
  );
}

function mergeProjectContextModuleSeeds<T extends ProjectModuleSeedLike>(seeds: readonly T[]): T[] {
  return dedupeBy(
    seeds.map((seed) => ({ ...seed, modulePath: normalizeProjectContextPath(seed.modulePath) })),
    (seed) => `${seed.modulePath ?? seed.ownedFiles?.join(',') ?? ''}:${seed.moduleName}`
  ) as T[];
}

function hasUsableSeedScope(seed: ProjectModuleSeedLike): boolean {
  return Boolean(seed.modulePath || seed.ownedFiles?.length);
}

function toProjectContextPath(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizeProjectSourceFolders(
  sourceFolders: readonly string[] | undefined,
  absoluteRoot: string
): string[] {
  if (!sourceFolders || sourceFolders.length === 0) {
    return [];
  }
  return uniqueStrings(
    sourceFolders
      .map((sourceFolder) => normalizeProjectSourceFolder(sourceFolder, absoluteRoot))
      .filter(isPresent)
  );
}

function normalizeProjectSourceFolder(
  sourceFolder: string,
  absoluteRoot: string
): string | undefined {
  const normalized = normalizeProjectContextPath(sourceFolder);
  if (!normalized) {
    return undefined;
  }
  const relativePath = path.isAbsolute(normalized)
    ? toProjectContextPath(path.relative(absoluteRoot, normalized))
    : normalized;
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../') ||
    relativePath === '..'
  ) {
    return undefined;
  }
  return normalizeProjectContextPath(relativePath);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function dedupeBy<T>(values: readonly T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function isPresent<T>(value: T | null | undefined | ''): value is T {
  return value !== null && value !== undefined && value !== '';
}
