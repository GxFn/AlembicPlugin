import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createReadOnlyRecipeMapRepositories } from '../../../repository/recipe-map/ReadOnlyRecipeMapServices.js';
import { PrimeSearchPipeline } from '../../../service/task/PrimeSearchPipeline.js';
import { PrimeInput } from '../../../shared/schemas/mcp-tools.js';
import { primeHandler } from '../handlers/agent-public-tools.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createKnowledgeUnavailableResult } from './knowledge-unavailable-result.js';
import { resolvePublicKnowledgeReadRoute } from './public-knowledge-read-route.js';
import {
  createReadOnlySearchContainer,
  type ReadOnlySearchContainerHandle,
} from './read-only-search-executor.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

/**
 * Run public Prime over one request-scoped DB/WAL/config/vector snapshot.
 *
 * Prime keeps the same real SearchEngine, vector lane, and request ProjectRuntimeContext. The
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
  PrimeInput.parse(args);
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const readRoute = resolvePublicKnowledgeReadRoute(projectRuntime);
  if (readRoute.state === 'unavailable') {
    return createKnowledgeUnavailableResult('alembic_prime', projectRuntime);
  }
  const dataRoot = resolve(readRoute.dataRoot);
  const databasePath = resolve(readRoute.databasePath);

  const snapshot = createReadOnlySearchSnapshot({
    dataRoot,
    databasePath,
    ...(readRoute.strictPublication ? { strictPublication: readRoute.strictPublication } : {}),
  });
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

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Prime project identity is missing ${field}.`);
  }
  return value;
}
