import { resolveSearchWorkspaceIdentity } from '@alembic/core/search';
import type { NormalizedKnowledgeContextInput } from '../layer/KnowledgeContextInputNormalizer.js';
import { stableRefSegment } from '../support/index.js';

export interface KnowledgeContextProjectIdentity {
  dataRoot?: string;
  language?: string;
  projectId?: string;
  projectRoot?: string;
  workspaceMode?: string;
}

export interface ProjectIdentityProvider {
  resolveProjectIdentity(input: NormalizedKnowledgeContextInput): KnowledgeContextProjectIdentity;
}

export class DefaultProjectIdentityProvider implements ProjectIdentityProvider {
  resolveProjectIdentity(input: NormalizedKnowledgeContextInput): KnowledgeContextProjectIdentity {
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
