import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface GitSubmoduleRepoFolder {
  repoName: string;
  sourceFolder: string;
}

/**
 * 从 Git 权威声明补齐单根项目的已初始化 submodule 仓边界。
 *
 * 这里只发现 repo scope，不读取或投影源码事实；后续每个仓仍必须由
 * ProjectContext `repo` 请求真实成功，不能把 `.gitmodules` 声明伪造成 coverage。
 */
export function discoverInitializedGitSubmoduleRepoFolders(
  projectRoot: string
): GitSubmoduleRepoFolder[] {
  const gitmodulesPath = path.join(projectRoot, '.gitmodules');
  if (!existsSync(gitmodulesPath)) {
    return [];
  }

  let contents: string;
  try {
    contents = readFileSync(gitmodulesPath, 'utf8');
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Graph] unable to read .gitmodules; submodule repo coverage remains root-only: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return [];
  }

  const folders = new Map<string, GitSubmoduleRepoFolder>();
  for (const match of contents.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const sourceFolder = normalizeRepoPath(match[1]);
    if (!sourceFolder || sourceFolder === '.') {
      continue;
    }
    const absoluteRoot = path.resolve(projectRoot, sourceFolder);
    if (!isWithin(absoluteRoot, projectRoot) || !isInitializedGitWorktree(absoluteRoot)) {
      process.stderr.write(
        `[MCP/Graph] ignoring uninitialized or out-of-root git submodule path=${sourceFolder}\n`
      );
      continue;
    }
    folders.set(sourceFolder, { repoName: sourceFolder, sourceFolder });
  }
  return [...folders.values()].sort((left, right) =>
    left.sourceFolder.localeCompare(right.sourceFolder)
  );
}

function isInitializedGitWorktree(absoluteRoot: string): boolean {
  try {
    return statSync(absoluteRoot).isDirectory() && existsSync(path.join(absoluteRoot, '.git'));
  } catch {
    return false;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeRepoPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized || '.';
}
