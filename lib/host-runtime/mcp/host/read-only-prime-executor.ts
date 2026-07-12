import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createReadOnlyRecipeMapRepositories } from '../../../repository/recipe-map/ReadOnlyRecipeMapServices.js';
import { PrimeSearchPipeline } from '../../../service/task/PrimeSearchPipeline.js';
import { primeHandler } from '../handlers/agent-public-tools.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import {
  createReadOnlySearchContainer,
  type ReadOnlySearchContainerHandle,
} from './read-only-search-executor.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

/**
 * Run public Prime over one request-scoped DB/WAL/config/vector snapshot.
 *
 * Prime keeps the same real SearchEngine, vector lane, RecipeContext locator/region readers,
 * checkpoint repository, and request ProjectRuntimeContext as the public read surfaces. The
 * general embedded container is intentionally excluded because its migration and shutdown
 * lifecycle can mutate the live SQLite family even when the public operation is read-only.
 */
export async function executeReadOnlyPrime(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Prime.');
  }
  const identity = projectRuntime.identity;
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!isWithin(databasePath, dataRoot)) {
    throw new Error(
      `Read-only Prime database identity mismatch: database=${databasePath}, dataRoot=${dataRoot}.`
    );
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Read-only Prime database does not exist: ${databasePath}.`);
  }

  const snapshot = createReadOnlySearchSnapshot({ dataRoot, databasePath });
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  let searchHandle: ReadOnlySearchContainerHandle | null = null;
  try {
    db.pragma('query_only = ON');
    searchHandle = await createReadOnlySearchContainer(db, snapshot, { dataRoot, projectRoot });
    const searchContainer = searchHandle.container;
    const searchEngine = searchContainer.get('searchEngine') as ConstructorParameters<
      typeof PrimeSearchPipeline
    >[0];
    const primeSearchPipeline = new PrimeSearchPipeline(searchEngine);
    const { knowledgeService, sourceRefRepository } = createReadOnlyRecipeMapRepositories(db);
    const container: McpServiceContainer = {
      get(name: string): unknown {
        switch (name) {
          case 'knowledgeService':
            return knowledgeService;
          case 'primeSearchPipeline':
            return primeSearchPipeline;
          case 'recipeSourceRefRepository':
            return sourceRefRepository;
          default:
            return searchContainer.get(name);
        }
      },
      singletons: searchContainer.singletons,
    };
    process.stderr.write(
      `[MCP/Prime] request-scoped snapshot route is physically read-only: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = { container, projectRuntime };
    return await primeHandler(ctx, args);
  } finally {
    searchHandle?.dispose();
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
    throw new Error(`Read-only Prime project identity is missing ${field}.`);
  }
  return value;
}
