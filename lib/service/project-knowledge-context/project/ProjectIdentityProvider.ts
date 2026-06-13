import type { NormalizedKnowledgeContextInput } from '../layer/KnowledgeContextInputNormalizer.js';

export interface KnowledgeContextProjectIdentity {
  language?: string;
  projectId?: string;
  projectRoot?: string;
}

export interface ProjectIdentityProvider {
  resolveProjectIdentity(input: NormalizedKnowledgeContextInput): KnowledgeContextProjectIdentity;
}

export class DefaultProjectIdentityProvider implements ProjectIdentityProvider {
  resolveProjectIdentity(input: NormalizedKnowledgeContextInput): KnowledgeContextProjectIdentity {
    return {
      ...(input.language === undefined ? {} : { language: input.language }),
      projectId:
        input.projectRoot === undefined ? 'project:unknown' : `project:${input.projectRoot}`,
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
    };
  }
}
