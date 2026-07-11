import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { SearchEngine } from '@alembic/core/search';
import Database from 'better-sqlite3';
import { createReadOnlySearchRepositories } from '../../../repository/search/ReadOnlySearchServices.js';
import { AlembicResidentServiceClient } from '../../../service/resident/AlembicResidentServiceClient.js';
import { search } from '../handlers/search.js';
import type { McpContext, McpServiceContainer, SearchArgs } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';

type ReadOnlyDatabase = InstanceType<typeof Database>;

/**
 * Run public Search against a connection that SQLite itself opened read-only.
 *
 * The general embedded MCP Bootstrap owns migrations, lifecycle services and writable WAL
 * connections. Reusing it for Search made an otherwise read-only tool update or remove live
 * `-wal`/`-shm` sidecars whenever the request switched projects. This bounded container exposes
 * only Search's read collectors, so no migration, audit, vector-sync or shutdown checkpoint can
 * enter the request path.
 */
export async function executeReadOnlySearch(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for read-only Search.');
  }
  const identity = projectRuntime.identity;
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!isWithin(databasePath, dataRoot)) {
    throw new Error(
      `Read-only Search database identity mismatch: database=${databasePath}, dataRoot=${dataRoot}.`
    );
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Read-only Search database does not exist: ${databasePath}.`);
  }

  const db = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    db.pragma('query_only = ON');
    const container = createReadOnlySearchContainer(db, {
      dataRoot,
      projectRoot,
    });
    process.stderr.write(
      `[MCP/Search] request-scoped SQLite route is read-only: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = {
      container,
      projectRuntime,
    };
    return await search(ctx, args as SearchArgs);
  } finally {
    db.close();
  }
}

function createReadOnlySearchContainer(
  db: ReadOnlyDatabase,
  identity: { dataRoot: string; projectRoot: string }
): McpServiceContainer {
  const searchEngine = new SearchEngine(db);
  const { checkpointRepository, knowledgeService } = createReadOnlySearchRepositories(db);
  const residentSearchClient = new AlembicResidentServiceClient({
    projectRoot: identity.projectRoot,
  });

  return {
    get(name: string): unknown {
      switch (name) {
        case 'gitDiffCheckpointRepository':
          return checkpointRepository;
        case 'knowledgeService':
          return knowledgeService;
        case 'residentSearchClient':
        case 'residentServiceClient':
          return residentSearchClient;
        case 'searchEngine':
          return searchEngine;
        default:
          throw new Error(`Read-only Search container does not expose ${name}.`);
      }
    },
    singletons: {
      _projectRoot: identity.projectRoot,
      _workspaceResolver: { dataRoot: identity.dataRoot },
    },
  };
}

function isWithin(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel.length > 0 && !rel.startsWith('..') && !relative(root, filePath).startsWith('/');
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Search project identity is missing ${field}.`);
  }
  return value;
}
