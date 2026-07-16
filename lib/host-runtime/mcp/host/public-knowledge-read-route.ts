import { existsSync } from 'node:fs';
import { projectLocationService } from '../../context/ProjectLocationService.js';
import type { ProjectRuntimeContext } from '../../context/ProjectRuntimeContext.js';
import {
  resolvePublicKnowledgePublication,
  type StrictPublicationDataFile,
  type StrictVectorPublication,
} from '../../context/StrictPublicKnowledgeResolver.js';

export type PublicKnowledgeReadRoute =
  | { state: 'unavailable' }
  | {
      dataRoot: string;
      databasePath: string;
      state: 'ready';
      strictPublication: {
        files: readonly StrictPublicationDataFile[];
        vector: StrictVectorPublication;
      } | null;
    };

/** Resolve every public knowledge call from the fixed namespace; no caller path enters here. */
export function resolvePublicKnowledgeReadRoute(
  projectRuntime: ProjectRuntimeContext
): PublicKnowledgeReadRoute {
  const publication = resolvePublicKnowledgePublication(projectRuntime.identity);
  projectRuntime.publication = publication.provenance;
  if (publication.state === 'unavailable') {
    return { state: 'unavailable' };
  }
  if (publication.state === 'ready') {
    return {
      dataRoot: publication.dataRoot,
      databasePath: publication.databasePath,
      state: 'ready',
      strictPublication: {
        files: publication.dataFiles,
        vector: publication.vector,
      },
    };
  }
  const { dataRoot, databasePath } = projectRuntime.identity;
  if (!existsSync(databasePath)) {
    return { state: 'unavailable' };
  }
  const physical = projectLocationService.confineExistingDatabase(dataRoot, databasePath);
  return {
    dataRoot: physical.dataRoot,
    databasePath: physical.databasePath,
    state: 'ready',
    strictPublication: null,
  };
}
