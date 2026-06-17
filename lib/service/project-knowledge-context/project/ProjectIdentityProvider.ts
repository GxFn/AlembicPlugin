import { resolveSearchWorkspaceIdentity } from '@alembic/core/search';
import { stableRefSegment } from '../support/index.js';

// GMAP-8c: the KnowledgeContext middle-layer input normalizer is retired; identity
// resolution only needs the project root + optional language.
export interface ProjectIdentityInput {
  projectRoot?: string;
  language?: string;
}

export interface KnowledgeContextProjectIdentity {
  dataRoot?: string;
  language?: string;
  projectId?: string;
  projectRoot?: string;
  workspaceMode?: string;
}

export interface ProjectIdentityProvider {
  resolveProjectIdentity(input: ProjectIdentityInput): KnowledgeContextProjectIdentity;
}

export class DefaultProjectIdentityProvider implements ProjectIdentityProvider {
  resolveProjectIdentity(input: ProjectIdentityInput): KnowledgeContextProjectIdentity {
    const workspace = resolveSearchWorkspaceIdentity({ projectRoot: input.projectRoot });
    const projectRoot = workspace?.projectRoot ?? input.projectRoot;
    const projectId =
      workspace?.projectId ??
      (projectRoot === undefined ? 'project:unknown' : `project:${stableRefSegment(projectRoot)}`);

    return {
      ...(workspace?.dataRoot === undefined ? {} : { dataRoot: workspace.dataRoot }),
      ...(input.language === undefined ? {} : { language: input.language }),
      projectId,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      ...(workspace?.workspaceMode === undefined ? {} : { workspaceMode: workspace.workspaceMode }),
    };
  }
}
