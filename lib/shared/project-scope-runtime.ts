import path from 'node:path';
import {
  loadProjectScopeForFolder,
  normalizeProjectScopeSummary,
  type ProjectDescriptor,
  type ProjectFolderDescriptor,
  type ProjectScopeSummary,
  readProjectScopeRegistryDocument,
  resolveProjectScopeForFolder,
  summarizeProjectScopeDescriptor,
} from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';

export const ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV = 'ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY';

export interface ProjectScopeRuntime {
  descriptor: ProjectDescriptor;
  summary: ProjectScopeSummary;
}

export function serializeProjectScopeSummary(
  summary: ProjectScopeSummary | null | undefined
): string | null {
  if (!summary) {
    return null;
  }
  return JSON.stringify(summary);
}

export function readProjectScopeRuntimeFromEnv(): ProjectScopeRuntime | null {
  const raw = process.env[ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV];
  if (!raw) {
    return null;
  }
  try {
    const summary = normalizeProjectScopeSummary(JSON.parse(raw));
    if (!summary) {
      return null;
    }
    return {
      descriptor: projectScopeSummaryToDescriptor(summary),
      summary,
    };
  } catch {
    return null;
  }
}

export function resolveProjectScopeRuntime(projectRoot: string): ProjectScopeRuntime | null {
  const envRuntime = readProjectScopeRuntimeFromEnv();
  if (envRuntime && isProjectScopeSummaryForFolder(envRuntime.summary, projectRoot)) {
    return envRuntime;
  }

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

function projectScopeSummaryToDescriptor(summary: ProjectScopeSummary): ProjectDescriptor {
  return {
    contractVersion: summary.contractVersion,
    controlRoot: {
      includedInFolders: false,
      kind: 'workspace-control-root',
      path: summary.controlRoot,
    },
    createdAt: null,
    currentFolderId: summary.currentFolderId,
    dataRoot: summary.dataRoot,
    displayName: summary.displayName,
    folders: summary.folders.map(projectScopeFolderSummaryToDescriptor),
    metadata: {},
    projectId: summary.projectId,
    projectScopeId: summary.projectScopeId,
    storage: {
      dataRoot: summary.dataRoot,
      dataRootSource: 'ghost-registry',
      kind: 'ghost',
      projectRootWriteAllowed: false,
      standardWriteAllowed: false,
    },
    updatedAt: null,
  };
}

function projectScopeFolderSummaryToDescriptor(
  folder: ProjectScopeSummary['folders'][number]
): ProjectFolderDescriptor {
  return {
    addedAt: null,
    displayName: folder.displayName,
    id: folder.folderId,
    metadata: {},
    path: folder.path,
    realpath: folder.realpath,
    repositoryId: folder.repositoryId,
    role: folder.role,
    state: folder.state,
  };
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
