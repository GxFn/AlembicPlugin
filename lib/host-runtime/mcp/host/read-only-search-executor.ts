import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HybridCandidateRetriever,
  KnowledgeRetrievalPolicy,
  type KnowledgeRetrievalPort,
  KnowledgeTruthProjector,
  SearchEngine,
} from '@alembic/core/search';
import { asEmbeddingPort, BinaryPersistence, type EmbeddingPort } from '@alembic/core/vector';
import Database from 'better-sqlite3';
import {
  resolveLocalEmbeddingConfig,
  selectLocalEmbedLane,
} from '../../../recipe-pipeline/vector/LocalEmbedding.js';
import { createReadOnlySearchRepositories } from '../../../repository/search/ReadOnlySearchServices.js';
import { SearchInput } from '../../../shared/schemas/mcp-tools.js';
import { projectLocationService } from '../../context/ProjectLocationService.js';
import { search } from '../handlers/search.js';
import type { McpContext, McpServiceContainer, SearchArgs } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createKnowledgeUnavailableResult } from './knowledge-unavailable-result.js';
import { ReadOnlyHnswVectorReader } from './read-only-hnsw-vector-reader.js';
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
 * only Search's read collectors, so no migration, audit, vector-sync, or shutdown hook can
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
  SearchInput.parse(args);
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!existsSync(databasePath)) {
    return createKnowledgeUnavailableResult('alembic_search', projectRuntime);
  }
  const physicalIdentity = projectLocationService.confineExistingDatabase(dataRoot, databasePath);

  const snapshot = createReadOnlySearchSnapshot(physicalIdentity);
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

export interface ReadOnlySearchContainerHandle {
  container: McpServiceContainer;
  dispose(): void;
}

export async function createReadOnlySearchContainer(
  db: ReadOnlyDatabase,
  snapshot: ReadOnlySearchSnapshot,
  identity: { dataRoot: string; projectRoot: string }
): Promise<ReadOnlySearchContainerHandle> {
  const { knowledgeService } = createReadOnlySearchRepositories(db);
  const sparseEngine = new SearchEngine(db);
  const vectorGraph = await createReadOnlyVectorGraph(snapshot);
  const candidateRetriever = new HybridCandidateRetriever({
    embedding: vectorGraph.embedding,
    reader: vectorGraph.reader,
    sparse: async (query, options) => {
      options.signal?.throwIfAborted();
      const filters = isRecord(options.filter) ? options.filter : {};
      const response = await sparseEngine.search(query, {
        ...filters,
        limit: options.limit,
        mode: 'weighted',
        rank: false,
      });
      options.signal?.throwIfAborted();
      return response.items.map((item) => ({ ...item, id: item.id, score: item.score }));
    },
  });
  const knowledgeRetrievalPort: KnowledgeRetrievalPort = new KnowledgeRetrievalPolicy(
    candidateRetriever,
    new KnowledgeTruthProjector(knowledgeService)
  );
  const searchEngine = new SearchEngine(db, { knowledgeRetrievalPort });

  return {
    container: {
      get(name: string): unknown {
        switch (name) {
          case 'knowledgeService':
            return knowledgeService;
          case 'knowledgeRetrievalPort':
            return knowledgeRetrievalPort;
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
    },
    dispose: () => vectorGraph.dispose(),
  };
}

interface ReadOnlyVectorGraph {
  dispose(): void;
  embedding: EmbeddingPort | null;
  reader: ReadOnlyHnswVectorReader | null;
}

async function createReadOnlyVectorGraph(
  snapshot: ReadOnlySearchSnapshot
): Promise<ReadOnlyVectorGraph> {
  if (!BinaryPersistence.isValid(snapshot.vectorIndexPath)) {
    process.stderr.write(
      '[MCP/Search] request snapshot has no valid HNSW index; local semantic lane is unavailable.\n'
    );
    return { dispose: () => undefined, embedding: null, reader: null };
  }

  const reader = new ReadOnlyHnswVectorReader(snapshot.vectorIndexPath);
  const localEmbedding = resolveLocalEmbeddingConfig(readVectorConfig(snapshot.configPath));
  const embedSelection = await selectLocalEmbedLane(localEmbedding);
  const embedding = embedSelection.provider ? asEmbeddingPort(embedSelection.provider) : null;
  process.stderr.write(
    `[MCP/Search] local snapshot vector lane=${embedSelection.lane} index=${snapshot.vectorIndexPath}\n`
  );
  return {
    dispose: () => reader.dispose(),
    embedding,
    reader,
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

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Read-only Search project identity is missing ${field}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
