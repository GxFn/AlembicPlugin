import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { WorkspaceResolver } from '@alembic/core/workspace';
import { resolveScopeAwareWorkspace } from '../../shared/project-scope-runtime.js';
import { type ProjectRootResolution, resolveProjectRootFromEnv } from './ProjectRootResolver.js';

/** The complete physical identity for one MCP request. No selected project,
 * resident process, saved root, or prior request can override these facts. */
export interface ProjectLocation {
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
  resolver: WorkspaceResolver;
  rootResolution: ProjectRootResolution;
}

export class ProjectLocationService {
  resolve(projectRoot?: string): ProjectLocation {
    const rootResolution = resolveProjectRootFromEnv({ projectRoot });
    if (!rootResolution.path || rootResolution.rejected) {
      throw new Error(rootResolution.reason);
    }
    const resolvedRoot = resolve(rootResolution.path);
    const resolver = resolveScopeAwareWorkspace(resolvedRoot);
    const facts = resolver.toFacts();
    const location = {
      projectRoot: resolvedRoot,
      projectId: facts.projectId ?? null,
      projectScopeId: facts.projectScopeId ?? null,
      currentFolderId: facts.currentFolderId ?? null,
      registered: facts.registered,
      ghost: facts.ghost,
      dataRoot: facts.dataRoot,
      databasePath: facts.databasePath,
      databaseExists: existsSync(facts.databasePath),
      runtimeDir: facts.runtimeDir,
      resolver,
      rootResolution,
    };
    this.assertConfinedDatabase(location.dataRoot, location.databasePath);
    return location;
  }

  confineExistingDatabase(dataRoot: string, databasePath: string) {
    this.assertConfinedDatabase(dataRoot, databasePath);
    lstatSync(databasePath);
    const physicalDataRoot = realpathSync.native(dataRoot);
    const physicalDatabasePath = realpathSync.native(databasePath);
    this.assertConfinedDatabase(physicalDataRoot, physicalDatabasePath);
    if (!statSync(physicalDatabasePath).isFile()) {
      throw new Error(`Project database is not a regular file: ${physicalDatabasePath}.`);
    }
    return { dataRoot: physicalDataRoot, databasePath: physicalDatabasePath };
  }

  private assertConfinedDatabase(dataRoot: string, databasePath: string) {
    const rel = relative(resolve(dataRoot), resolve(databasePath));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `Project database is outside its request data root: database=${databasePath}, dataRoot=${dataRoot}.`
      );
    }
  }
}

export const projectLocationService = new ProjectLocationService();
