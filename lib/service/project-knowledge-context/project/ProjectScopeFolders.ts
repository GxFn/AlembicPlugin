import fs from 'node:fs';
import path from 'node:path';
import { listProjectScopeFolders, readProjectScopeFromWorkspaceConfig } from '@alembic/core/shared';

export interface ProjectScopeSourceFolder {
  absolutePath: string;
  displayName: string;
  relativePath: string;
}

export function resolveProjectScopeSourceFolders(projectRoot: string): ProjectScopeSourceFolder[] {
  const scope = readProjectScopeFromWorkspaceConfig(projectRoot);
  if (!scope) {
    return [];
  }

  const seen = new Set<string>();
  const folders: ProjectScopeSourceFolder[] = [];
  for (const folder of listProjectScopeFolders(scope)) {
    const absolutePath = path.resolve(folder.path);
    const relativePath = normalizeRelativePath(path.relative(projectRoot, absolutePath));
    if (
      seen.has(relativePath) ||
      relativePath.length === 0 ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath) ||
      !isDirectory(absolutePath)
    ) {
      continue;
    }
    seen.add(relativePath);
    folders.push({
      absolutePath,
      displayName: folder.displayName,
      relativePath,
    });
  }

  return folders.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function isDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRelativePath(input: string): string {
  return input.split(path.sep).join('/');
}
