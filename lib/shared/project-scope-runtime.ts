import path from 'node:path';
import {
  loadProjectScopeForFolder,
  type ProjectDescriptor,
  type ProjectScopeSummary,
  readProjectScopeRegistryDocument,
  resolveProjectScopeForFolder,
  summarizeProjectScopeDescriptor,
} from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';

export interface ProjectScopeRuntime {
  descriptor: ProjectDescriptor;
  summary: ProjectScopeSummary;
}

export function resolveProjectScopeRuntime(projectRoot: string): ProjectScopeRuntime | null {
  const descriptor = loadProjectScopeForRuntimeProject(projectRoot);
  if (!descriptor) {
    return null;
  }
  const folderResolution = resolveProjectScopeForFolder(descriptor, projectRoot);
  return {
    descriptor,
    summary: summarizeProjectScopeDescriptor(
      descriptor,
      folderResolution.matched ? folderResolution.currentFolderId : null
    ),
  };
}

/**
 * 只在 native ProjectScope 存在时构造同一份 Ghost workspace resolver，供 setup
 * 这类需要区分“有 scope / 无 scope”的调用方使用。
 */
export function resolveNativeProjectScopeWorkspace(projectRoot: string): WorkspaceResolver | null {
  const runtime = resolveProjectScopeRuntime(projectRoot);
  if (!runtime) {
    return null;
  }
  return new WorkspaceResolver({
    projectRoot,
    projectScope: runtime.descriptor,
    currentFolderId: runtime.summary.currentFolderId,
  });
}

/**
 * Plugin 内所有需要读写项目数据根的消费者共用这一入口。native ProjectScope
 * 优先；否则保留 Core ProjectRegistry / 单根 workspace 的既有解析语义。
 */
export function resolveScopeAwareWorkspace(projectRoot: string): WorkspaceResolver {
  return (
    resolveNativeProjectScopeWorkspace(projectRoot) ?? WorkspaceResolver.fromProject(projectRoot)
  );
}

export function isProjectScopeSummaryForFolder(
  summary: ProjectScopeSummary | null | undefined,
  folderPath: string
): boolean {
  if (!summary) {
    return false;
  }
  return (
    samePath(summary.currentFolderPath, folderPath) ||
    samePath(summary.controlRoot, folderPath) ||
    summary.folders.some(
      (folder) => samePath(folder.path, folderPath) || samePath(folder.realpath, folderPath)
    )
  );
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

function loadProjectScopeForRuntimeProject(projectRoot: string): ProjectDescriptor | null {
  try {
    const resolver = WorkspaceResolver.fromProjectScopeRegistry(projectRoot);
    if (resolver.projectScope) {
      return resolver.projectScope;
    }
  } catch {
    /* registry loader failed — fall through to direct registry reads */
  }

  const folderScope = loadProjectScopeForFolder(projectRoot);
  if (folderScope) {
    return folderScope;
  }
  const normalizedProjectRoot = path.resolve(projectRoot);
  try {
    return (
      Object.values(readProjectScopeRegistryDocument().scopes).find(
        (scope) => path.resolve(scope.controlRoot.path) === normalizedProjectRoot
      ) ?? null
    );
  } catch {
    return null;
  }
}
