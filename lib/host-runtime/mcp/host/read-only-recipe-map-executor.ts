import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createReadOnlyRecipeMapRepositories } from '../../../repository/recipe-map/ReadOnlyRecipeMapServices.js';
import { createReadOnlySearchRepositories } from '../../../repository/search/ReadOnlySearchServices.js';
import { recipeMap } from '../handlers/recipe-map.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

/**
 * Run public Recipe Map over a private DB/WAL snapshot and expose only its three read ports.
 * ProjectContext source facts still come from the request's real project root.
 */
export async function executeReadOnlyRecipeMap(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Recipe Map.');
  }
  const identity = projectRuntime.identity;
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!isWithin(databasePath, dataRoot)) {
    throw new Error(
      `Read-only Recipe Map database identity mismatch: database=${databasePath}, dataRoot=${dataRoot}.`
    );
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Read-only Recipe Map database does not exist: ${databasePath}.`);
  }

  const snapshot = createReadOnlySearchSnapshot({ dataRoot, databasePath });
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  try {
    db.pragma('query_only = ON');
    const { checkpointRepository } = createReadOnlySearchRepositories(db);
    const { knowledgeService, sourceRefRepository } = createReadOnlyRecipeMapRepositories(db);
    const container: McpServiceContainer = {
      get(name: string): unknown {
        switch (name) {
          case 'gitDiffCheckpointRepository':
            return checkpointRepository;
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
    const ctx: McpContext = { container, projectRuntime };
    return await recipeMap(ctx, args);
  } finally {
    db.close();
    snapshot.dispose();
  }
}

function isWithin(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith('/');
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Recipe Map project identity is missing ${field}.`);
  }
  return value;
}
