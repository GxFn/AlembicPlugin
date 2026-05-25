import path from 'node:path';
import {
  normalizeProjectScopeSummary,
  type ProjectDescriptor,
  type ProjectFolderDescriptor,
  type ProjectScopeSummary,
} from '@alembic/core/shared';

export const ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY_ENV = 'ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY';

export interface CodexProjectScopeRuntime {
  descriptor: ProjectDescriptor;
  summary: ProjectScopeSummary;
}

export function serializeCodexProjectScopeSummary(
  summary: ProjectScopeSummary | null | undefined
): string | null {
  if (!summary) {
    return null;
  }
  return JSON.stringify(summary);
}

export function readCodexProjectScopeRuntimeFromEnv(): CodexProjectScopeRuntime | null {
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

export function isCodexProjectScopeSummaryForFolder(
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
