import path from 'node:path';
import type { ProjectDescriptor, ProjectFolderDescriptor } from '@alembic/core/shared';
import { resolveProjectScopeRuntime } from '#shared/project-scope-runtime.js';

export interface RescanProjectScopeSelection {
  analysisProjectRoot: string;
  folders: Array<{ id: string; path: string }>;
  sourceFolders?: string[];
}

export function resolveRescanProjectScopeSelection(
  projectRoot: string,
  moduleScope: readonly string[]
): RescanProjectScopeSelection {
  const runtime = resolveProjectScopeRuntime(projectRoot);
  if (!runtime) {
    return { analysisProjectRoot: projectRoot, folders: [] };
  }
  return selectRescanProjectScopeFolders(runtime.descriptor, projectRoot, moduleScope);
}

export function selectRescanProjectScopeFolders(
  descriptor: ProjectDescriptor,
  projectRoot: string,
  moduleScope: readonly string[]
): RescanProjectScopeSelection {
  const controlRoot = path.resolve(descriptor.controlRoot.path);
  const requestedRoot = path.resolve(projectRoot);
  const boundFolder = descriptor.folders.find((folder) => pathWithin(requestedRoot, folder.path));
  if (boundFolder && requestedRoot !== controlRoot) {
    return {
      analysisProjectRoot: projectRoot,
      folders: [{ id: boundFolder.id, path: boundFolder.path }],
    };
  }

  const normalizedScopes = uniqueNormalizedPaths(moduleScope);
  const selected =
    normalizedScopes.length === 0
      ? descriptor.folders
      : descriptor.folders.filter((folder) =>
          normalizedScopes.some((scope) => folderMatchesScope(folder, controlRoot, scope))
        );
  return {
    analysisProjectRoot: controlRoot,
    folders: selected.map((folder) => ({ id: folder.id, path: folder.path })),
    sourceFolders: selected.map((folder) => normalizePath(path.relative(controlRoot, folder.path))),
  };
}

function folderMatchesScope(
  folder: ProjectFolderDescriptor,
  controlRoot: string,
  scope: string
): boolean {
  const aliases = uniqueNormalizedPaths([
    path.relative(controlRoot, folder.path),
    path.basename(folder.path),
    folder.displayName,
    folder.id,
    folder.repositoryId ?? '',
  ]);
  return aliases.some(
    (alias) => scope === alias || scope.startsWith(`${alias}/`) || alias.startsWith(`${scope}/`)
  );
}

function pathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueNormalizedPaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizePath).filter(Boolean))];
}

function normalizePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
}
