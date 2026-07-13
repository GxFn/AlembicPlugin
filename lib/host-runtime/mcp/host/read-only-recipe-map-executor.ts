import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createReadOnlyRecipeMapRepositories } from '../../../repository/recipe-map/ReadOnlyRecipeMapServices.js';
import type { ProjectContextBuildSessionManager } from '../../../service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { RecipeMapInput } from '../../../shared/schemas/mcp-tools.js';
import { projectLocationService } from '../../context/ProjectLocationService.js';
import { recipeMap } from '../handlers/recipe-map.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createKnowledgeUnavailableResult } from './knowledge-unavailable-result.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

/**
 * Run public Recipe Map over a private DB/WAL snapshot and expose only its three read ports.
 * ProjectContext source facts still come from the request's real project root.
 */
export async function executeReadOnlyRecipeMap(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext,
  projectContextExecution?: {
    buildSessions: ProjectContextBuildSessionManager;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Recipe Map.');
  }
  const identity = projectRuntime.identity;
  RecipeMapInput.parse(args);
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!existsSync(databasePath)) {
    return createKnowledgeUnavailableResult('alembic_recipe_map', projectRuntime);
  }
  const physicalIdentity = projectLocationService.confineExistingDatabase(dataRoot, databasePath);

  const snapshot = createReadOnlySearchSnapshot(physicalIdentity);
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  try {
    db.pragma('query_only = ON');
    const { knowledgeService, sourceRefRepository } = createReadOnlyRecipeMapRepositories(db);
    const container: McpServiceContainer = {
      get(name: string): unknown {
        switch (name) {
          case 'knowledgeService':
            return knowledgeService;
          case 'recipeSourceRefRepository':
            return sourceRefRepository;
          default:
            throw new Error(`Read-only Recipe Map container does not expose ${name}.`);
        }
      },
      singletons: {
        _projectRoot: projectRoot,
        _workspaceResolver: { dataRoot },
      },
    };
    process.stderr.write(
      `[MCP/RecipeMap] request-scoped snapshot route is physically read-only: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = { container, projectRuntime, projectContextExecution };
    return await recipeMap(ctx, args);
  } finally {
    db.close();
    snapshot.dispose();
  }
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Recipe Map project identity is missing ${field}.`);
  }
  return value;
}
