import { existsSync } from 'node:fs';
import { type ProjectLocation, projectLocationService } from './ProjectLocationService.js';
import {
  observePublicKnowledgePublication,
  type ProjectRuntimePublicationProvenance,
} from './StrictPublicKnowledgeResolver.js';

const PROJECT_RUNTIME_CONTEXT_VERSION = 3;

export interface ProjectRuntimeLocationFacts {
  projectRoot: string;
  projectId: string | null;
  projectScopeId: string | null;
  currentFolderId: string | null;
  registered: boolean;
  ghost: boolean;
  dataRoot: string;
  databasePath: string;
  databaseExists: boolean;
  runtimeDir: string;
}

export interface ProjectRuntimeIdentity {
  projectRoot: string;
  projectRealpath: string;
  projectExists: boolean;
  projectId: string | null;
  projectScope: unknown | null;
  projectScopeId: string | null;
  currentFolderId: string | null;
  registered: boolean;
  ghost: boolean;
  mode: string;
  dataRoot: string;
  dataRootSource: string;
  databasePath: string;
  runtimeDir: string;
  workspaceExists: boolean;
}

/** Request-scoped project location facts exposed with each MCP result. */
export interface ProjectRuntimeContext {
  contractVersion: typeof PROJECT_RUNTIME_CONTEXT_VERSION;
  identity: ProjectRuntimeIdentity;
  location: ProjectRuntimeLocationFacts;
  publication: ProjectRuntimePublicationProvenance;
}

export interface BuildProjectRuntimeContextOptions {
  projectRoot: string;
}

export function buildProjectRuntimeContext(
  options: BuildProjectRuntimeContextOptions
): ProjectRuntimeContext {
  const location = projectLocationService.resolve(options.projectRoot);
  const facts = location.resolver.toFacts();
  const identity: ProjectRuntimeIdentity = {
    currentFolderId: location.currentFolderId,
    dataRoot: location.dataRoot,
    dataRootSource: facts.dataRootSource,
    databasePath: location.databasePath,
    ghost: location.ghost,
    mode: facts.mode,
    projectExists: existsSync(location.projectRoot),
    projectId: location.projectId,
    projectRealpath: facts.projectRealpath,
    projectRoot: location.projectRoot,
    projectScope: facts.projectScope ?? null,
    projectScopeId: location.projectScopeId,
    registered: facts.registered,
    runtimeDir: location.runtimeDir,
    workspaceExists: facts.workspaceExists,
  };
  const publication = observePublicKnowledgePublication(identity).provenance;
  return {
    contractVersion: PROJECT_RUNTIME_CONTEXT_VERSION,
    identity,
    location: serializableLocation(location),
    publication,
  };
}

export function buildPrimeRuntimeContext(input: { projectRoot: string }): ProjectRuntimeContext {
  return buildProjectRuntimeContext({ projectRoot: input.projectRoot });
}

function serializableLocation(location: ProjectLocation): ProjectRuntimeLocationFacts {
  return {
    projectRoot: location.projectRoot,
    projectId: location.projectId,
    projectScopeId: location.projectScopeId,
    currentFolderId: location.currentFolderId,
    registered: location.registered,
    ghost: location.ghost,
    dataRoot: location.dataRoot,
    databasePath: location.databasePath,
    databaseExists: location.databaseExists,
    runtimeDir: location.runtimeDir,
  };
}
