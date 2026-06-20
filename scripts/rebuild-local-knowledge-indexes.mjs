#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HnswVectorAdapter, RECIPE_REGION_VECTOR_ID_PREFIX } from '@alembic/core/vector';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';

const repoRoot = resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const projectRoot = resolve(options.projectRoot || process.cwd());

if (options.enableLocalEmbedding) {
  process.env.ALEMBIC_LOCAL_EMBEDDING_ENABLED = '1';
}
if (options.ollamaEndpoint) {
  process.env.ALEMBIC_OLLAMA_ENDPOINT = options.ollamaEndpoint;
}
if (options.ollamaModel) {
  process.env.ALEMBIC_OLLAMA_EMBED_MODEL = options.ollamaModel;
}
process.env.ALEMBIC_QUIET ??= '1';

const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  mode: 'local-host-dispatcher',
  projectRoot,
  rescan: null,
  sourceRefs: null,
  vectorIndex: null,
};

let server = null;
let resetPluginOwnedMcpServerForTests = null;

try {
  const hostMcpServerPath = join(repoRoot, 'dist/lib/runtime/mcp/HostMcpServer.js');
  if (!existsSync(hostMcpServerPath)) {
    throw new Error('dist runtime is missing; run npm run build first.');
  }

  const hostModule = await import(`file://${hostMcpServerPath}`);
  const HostMcpServer = hostModule.HostMcpServer;
  resetPluginOwnedMcpServerForTests = hostModule.resetPluginOwnedMcpServerForTests;
  server = new HostMcpServer({ projectRoot, waitUntilReadyMs: options.timeoutMs });

  const rescan = await withTimeout(
    server.handleToolCall('alembic_rescan', {
      reason: 'rebuild local Recipe source refs and semantic-region vectors',
    }),
    options.timeoutMs,
    `alembic_rescan timed out after ${options.timeoutMs}ms`
  );
  report.rescan = summarizeRescan(rescan);

  const dataRoot = WorkspaceResolver.fromProject(projectRoot).dataRoot;
  const dbPath = join(dataRoot, '.asd/alembic.db');
  report.sourceRefs = inspectSourceRefs(dbPath);
  report.vectorIndex = await inspectVectorIndex(dataRoot);

  report.ok =
    report.sourceRefs.total > 0 &&
    report.sourceRefs.active > 0 &&
    report.vectorIndex.recipeRegionIds > 0 &&
    report.vectorIndex.recipeRegionRecipeIds > 0;
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
  report.ok = false;
} finally {
  try {
    await server?.shutdown?.();
  } catch (err) {
    report.shutdownError = err instanceof Error ? err.message : String(err);
  }
  try {
    await resetPluginOwnedMcpServerForTests?.();
  } catch (err) {
    report.resetError = err instanceof Error ? err.message : String(err);
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport(report);
}

if (!report.ok) {
  process.exitCode = 1;
}

function inspectSourceRefs(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`database does not exist: ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const total = scalar(db, 'SELECT count(*) FROM recipe_source_refs');
    const active = scalar(db, "SELECT count(*) FROM recipe_source_refs WHERE status = 'active'");
    const stale = scalar(db, "SELECT count(*) FROM recipe_source_refs WHERE status = 'stale'");
    const renamed = scalar(db, "SELECT count(*) FROM recipe_source_refs WHERE status = 'renamed'");
    const recipeCount = scalar(db, 'SELECT count(DISTINCT recipe_id) FROM recipe_source_refs');
    const sourceBackedRecipes = scalar(
      db,
      "SELECT count(*) FROM knowledge_entries WHERE json_array_length(json_extract(reasoning, '$.sources')) > 0"
    );
    return {
      active,
      databasePath: dbPath,
      recipeCount,
      renamed,
      sourceBackedRecipes,
      stale,
      total,
    };
  } finally {
    db.close();
  }
}

async function inspectVectorIndex(dataRoot) {
  const store = new HnswVectorAdapter(dataRoot);
  await store.init();
  try {
    const [ids, stats, regionItems] = await Promise.all([
      store.listIds(),
      store.getStats(),
      store.searchByFilter({ type: 'recipe-semantic-region' }),
    ]);
    const recipeRegionIds = ids.filter((id) => id.startsWith(RECIPE_REGION_VECTOR_ID_PREFIX));
    const recipeIds = new Set();
    let bridgeActive = 0;
    let bridgeRefs = 0;
    for (const item of regionItems) {
      const metadata = item.metadata || {};
      if (metadata.recipeId) {
        recipeIds.add(String(metadata.recipeId));
      }
      if (metadata.sourceRefsBridge === 'active') {
        bridgeActive++;
      }
      bridgeRefs += Number(metadata.bridgeRefCount || 0);
    }
    return {
      bridgeActiveRegionItems: bridgeActive,
      bridgeRefMentions: bridgeRefs,
      indexPath: stats.indexPath ?? join(dataRoot, '.asd/context/index/vector_index.asvec'),
      recipeRegionIds: recipeRegionIds.length,
      recipeRegionRecipeIds: recipeIds.size,
      totalIds: ids.length,
      totalMetadataRegionItems: regionItems.length,
      vectorStats: stats,
    };
  } finally {
    await store.flush?.();
    store.destroy?.();
  }
}

function summarizeRescan(value) {
  if (!value || typeof value !== 'object') {
    return { status: 'unknown' };
  }
  const data = value.data && typeof value.data === 'object' ? value.data : value;
  return {
    ok: value.ok ?? value.success ?? null,
    status: value.status ?? data.status ?? null,
    summary: value.summary ?? data.summary ?? null,
  };
}

function scalar(db, sql) {
  const row = db.prepare(sql).get();
  const value = row ? Object.values(row)[0] : 0;
  return Number(value || 0);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function printHumanReport(nextReport) {
  const status = nextReport.ok ? 'ok' : 'failed';
  process.stdout.write(
    `${status} local knowledge index rebuild project=${nextReport.projectRoot}\n`
  );
  if (nextReport.error) {
    process.stdout.write(`error: ${nextReport.error}\n`);
  }
  if (nextReport.sourceRefs) {
    const refs = nextReport.sourceRefs;
    process.stdout.write(
      `sourceRefs total=${refs.total} active=${refs.active} stale=${refs.stale} recipes=${refs.recipeCount}/${refs.sourceBackedRecipes}\n`
    );
  }
  if (nextReport.vectorIndex) {
    const vectors = nextReport.vectorIndex;
    process.stdout.write(
      `vectors totalIds=${vectors.totalIds} recipeRegionIds=${vectors.recipeRegionIds} recipeRegionRecipes=${vectors.recipeRegionRecipeIds} bridgeActiveItems=${vectors.bridgeActiveRegionItems}\n`
    );
  }
}

function parseArgs(argv) {
  const parsed = {
    enableLocalEmbedding: false,
    json: false,
    ollamaEndpoint: '',
    ollamaModel: '',
    projectRoot: '',
    timeoutMs: 120000,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--enable-local-embedding') {
      parsed.enableLocalEmbedding = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--project-root') {
      parsed.projectRoot = argv[++index] || '';
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[++index] || parsed.timeoutMs);
    } else if (arg === '--ollama-endpoint') {
      parsed.ollamaEndpoint = argv[++index] || '';
    } else if (arg === '--ollama-model') {
      parsed.ollamaModel = argv[++index] || '';
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelpAndExit() {
  process.stdout.write(`Usage:
  node scripts/rebuild-local-knowledge-indexes.mjs --project-root <path> [options]

Options:
  --enable-local-embedding       Enable Plugin local Ollama embedding lane for this run.
  --ollama-model <name>          Override ALEMBIC_OLLAMA_EMBED_MODEL.
  --ollama-endpoint <url>        Override ALEMBIC_OLLAMA_ENDPOINT.
  --timeout-ms <ms>              Overall rebuild timeout. Default: 120000.
  --json                         Print JSON report.
`);
  process.exit(0);
}
