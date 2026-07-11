import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { HybridRetriever, SearchEngine } from '@alembic/core/search';
import { BinaryPersistence, IndexingPipeline, VectorService } from '@alembic/core/vector';
import Database from 'better-sqlite3';
import {
  resolveLocalEmbeddingConfig,
  selectLocalEmbedLane,
} from '../../../recipe-pipeline/vector/LocalEmbedding.js';
import { createReadOnlySearchRepositories } from '../../../repository/search/ReadOnlySearchServices.js';
import { AlembicResidentServiceClient } from '../../../service/resident/AlembicResidentServiceClient.js';
import { search } from '../handlers/search.js';
import type { McpContext, McpServiceContainer, SearchArgs } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { ReadOnlyHnswVectorStore } from './read-only-hnsw-vector-store.js';
import {
  createReadOnlySearchSnapshot,
  type ReadOnlySearchSnapshot,
} from './read-only-search-snapshot.js';

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

  const snapshot = createReadOnlySearchSnapshot({ dataRoot, databasePath });
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  let containerHandle: ReadOnlySearchContainerHandle | null = null;
  try {
    db.pragma('query_only = ON');
    containerHandle = await createReadOnlySearchContainer(db, snapshot, {
      dataRoot,
      projectRoot,
    });
    process.stderr.write(
      `[MCP/Search] request-scoped snapshot route is read-only: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = {
      container: containerHandle.container,
      projectRuntime,
    };
    return await search(ctx, args as SearchArgs);
  } finally {
    containerHandle?.dispose();
    db.close();
    snapshot.dispose();
  }
}

interface ReadOnlySearchContainerHandle {
  container: McpServiceContainer;
  dispose(): void;
}

async function createReadOnlySearchContainer(
  db: ReadOnlyDatabase,
  snapshot: ReadOnlySearchSnapshot,
  identity: { dataRoot: string; projectRoot: string }
): Promise<ReadOnlySearchContainerHandle> {
  const vectorGraph = await createReadOnlyVectorGraph(snapshot);
  const searchEngine = new SearchEngine(
    db,
    (vectorGraph
      ? {
          hybridRetriever: vectorGraph.hybridRetriever,
          vectorService: vectorGraph.vectorService,
          vectorStore: vectorGraph.vectorStore,
        }
      : {}) as unknown as ConstructorParameters<typeof SearchEngine>[1]
  );
  const { checkpointRepository, knowledgeService } = createReadOnlySearchRepositories(db);
  const residentSearchClient = new AlembicResidentServiceClient({
    projectRoot: identity.projectRoot,
  });

  return {
    container: {
      get(name: string): unknown {
        switch (name) {
          case 'gitDiffCheckpointRepository':
            return checkpointRepository;
          case 'hybridRetriever':
            return vectorGraph?.hybridRetriever;
          case 'knowledgeService':
            return knowledgeService;
          case 'residentSearchClient':
          case 'residentServiceClient':
            return residentSearchClient;
          case 'searchEngine':
            return searchEngine;
          case 'vectorService':
            return vectorGraph?.vectorService;
          case 'vectorStore':
            return vectorGraph?.vectorStore;
          default:
            throw new Error(`Read-only Search container does not expose ${name}.`);
        }
      },
      singletons: {
        _projectRoot: identity.projectRoot,
        _workspaceResolver: { dataRoot: identity.dataRoot },
      },
    },
    dispose: () => vectorGraph?.dispose(),
  };
}

interface ReadOnlyVectorGraph {
  dispose(): void;
  hybridRetriever: HybridRetriever;
  vectorService: VectorService;
  vectorStore: ReadOnlyHnswVectorStore;
}

async function createReadOnlyVectorGraph(
  snapshot: ReadOnlySearchSnapshot
): Promise<ReadOnlyVectorGraph | null> {
  if (!BinaryPersistence.isValid(snapshot.vectorIndexPath)) {
    process.stderr.write(
      '[MCP/Search] request snapshot has no valid HNSW index; local semantic lane is unavailable.\n'
    );
    return null;
  }

  const vectorStore = new ReadOnlyHnswVectorStore(snapshot.vectorIndexPath);
  const hybridRetriever = new HybridRetriever({
    vectorStore: vectorStore as unknown as NonNullable<
      ConstructorParameters<typeof HybridRetriever>[0]
    >['vectorStore'],
  });
  const indexingPipeline = new IndexingPipeline({
    projectRoot: snapshot.dataRoot,
    scanDirs: [],
    vectorStore,
  });
  const localEmbedding = resolveLocalEmbeddingConfig(readVectorConfig(snapshot.configPath));
  const embedSelection = await selectLocalEmbedLane(localEmbedding);
  const vectorService = new VectorService({
    autoSyncOnCrud: false,
    contextualEnricher: null,
    embedProvider: embedSelection.provider,
    eventBus: null,
    hybridRetriever,
    indexingPipeline,
    syncDebounceMs: 2000,
    vectorStore,
  });
  await vectorService.initialize();
  process.stderr.write(
    `[MCP/Search] local snapshot vector lane=${embedSelection.lane} index=${snapshot.vectorIndexPath}\n`
  );
  return {
    dispose: () => vectorStore.destroy(),
    hybridRetriever,
    vectorService,
    vectorStore,
  };
}

function readVectorConfig(configPath: string): unknown {
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    return config.vector;
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Search] snapshot vector config is unreadable; env/default policy applies: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return undefined;
  }
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
