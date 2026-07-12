import { existsSync } from 'node:fs';
import { type ProjectLocation, projectLocationService } from './ProjectLocationService.js';
import type { ProjectRootResolution } from './ProjectRootResolver.js';

const PROJECT_RUNTIME_CONTEXT_VERSION = 2;

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

/** Request facts only. This contract intentionally contains no selected/active
 * project, daemon readiness, role/tier, fallback, or host repair policy. */
export interface ProjectRuntimeContext {
  contractVersion: typeof PROJECT_RUNTIME_CONTEXT_VERSION;
  identity: ProjectRuntimeIdentity;
  location: ProjectRuntimeLocationFacts;
}

export interface BuildProjectRuntimeContextOptions {
  projectRoot: string;
  projectRootResolution?: ProjectRootResolution | null;
  requiredServices?: readonly string[];
  [legacyIgnoredOption: string]: unknown;
}

export function buildProjectRuntimeContext(
  options: BuildProjectRuntimeContextOptions
): ProjectRuntimeContext {
  const location = projectLocationService.resolve(options.projectRoot);
  const facts = location.resolver.toFacts();
  return {
    contractVersion: PROJECT_RUNTIME_CONTEXT_VERSION,
    identity: {
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
    },
    location: serializableLocation(location),
  };
}

export function buildPrimeRuntimeContext(input: {
  projectRoot: string;
  [legacyIgnoredOption: string]: unknown;
}): ProjectRuntimeContext {
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
