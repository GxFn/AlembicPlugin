#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  mode: 'local-derived-index-rebuild',
  projectRoot,
  indexRebuild: null,
  sourceRefs: null,
  vectorIndex: null,
};

let bootstrap = null;
let resetServiceContainer = null;
const previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
const previousCwd = process.cwd();

try {
  const bootstrapPath = join(repoRoot, 'dist/lib/bootstrap.js');
  const serviceContainerPath = join(repoRoot, 'dist/lib/injection/ServiceContainer.js');
  const indexRebuildPath = join(
    repoRoot,
    'dist/lib/recipe-generation/host-agent-workflows/knowledge-index-rebuild.js'
  );
  for (const requiredPath of [bootstrapPath, serviceContainerPath, indexRebuildPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(
        `dist runtime is missing required file: ${requiredPath}; run npm run build first.`
      );
    }
  }

  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  if (process.cwd() !== projectRoot) {
    process.chdir(projectRoot);
  }

  const bootstrapModule = await import(pathToFileURL(bootstrapPath).href);
  const serviceModule = await import(pathToFileURL(serviceContainerPath).href);
  const indexRebuildModule = await import(pathToFileURL(indexRebuildPath).href);
  const Bootstrap = bootstrapModule.default ?? bootstrapModule.Bootstrap;
  const getServiceContainer = serviceModule.getServiceContainer;
  resetServiceContainer = serviceModule.resetServiceContainer;
  const rebuildLocalKnowledgeIndexes = indexRebuildModule.rebuildLocalKnowledgeIndexes;

  if (
    !Bootstrap ||
    typeof getServiceContainer !== 'function' ||
    typeof rebuildLocalKnowledgeIndexes !== 'function'
  ) {
    throw new Error('dist runtime is missing; run npm run build first.');
  }

  Bootstrap.configurePathGuard(projectRoot);
  bootstrap = new Bootstrap();
  const components = await bootstrap.initialize();
  const container = getServiceContainer();
  await container.initialize({
    auditLogger: components.auditLogger,
    config: components.config,
    db: components.db,
    projectRoot,
    skillHooks: components.skillHooks,
    workspaceResolver: components.workspaceResolver,
  });

  const logger = components.logger ?? {
    info(message, meta) {
      if (!options.json) {
        process.stdout.write(`${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
      }
    },
    warn(message, meta) {
      process.stderr.write(`${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
    },
  };

  const indexRebuild = await withTimeout(
    rebuildLocalKnowledgeIndexes({
      container,
      db: components.db,
      logger,
      logPrefix: 'RebuildLocalKnowledgeIndexes',
    }),
    options.timeoutMs,
    `local knowledge index rebuild timed out after ${options.timeoutMs}ms`
  );
  report.indexRebuild = summarizeIndexRebuild(indexRebuild);

  const dataRoot = WorkspaceResolver.fromProject(projectRoot).dataRoot;
  const dbPath = join(dataRoot, '.asd/alembic.db');
  report.sourceRefs = inspectSourceRefs(dbPath);
  report.vectorIndex = await inspectVectorIndex(dataRoot);

  report.ok =
    report.sourceRefs.total > 0 &&
    report.sourceRefs.active > 0 &&
    report.sourceRefs.semanticMemories > 0 &&
    report.sourceRefs.recipeRegionSemanticMemories > 0 &&
    report.vectorIndex.recipeRegionIds > 0 &&
    report.vectorIndex.recipeRegionRecipeIds > 0;
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
  report.ok = false;
} finally {
  try {
    await bootstrap?.shutdown?.();
  } catch (err) {
    report.shutdownError = err instanceof Error ? err.message : String(err);
  }
  try {
    await resetServiceContainer?.();
  } catch (err) {
    report.resetError = err instanceof Error ? err.message : String(err);
  }
  if (previousProjectDir === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = previousProjectDir;
  }
  if (process.cwd() !== previousCwd) {
    process.chdir(previousCwd);
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
    const semanticMemories = scalar(db, 'SELECT count(*) FROM semantic_memories');
    const recipeRegionSemanticMemories = scalar(
      db,
      "SELECT count(*) FROM semantic_memories WHERE source = 'recipe-region-vector' AND type = 'recipe'"
    );
    const sourceBackedRecipes = scalar(
      db,
      "SELECT count(*) FROM knowledge_entries WHERE json_array_length(json_extract(reasoning, '$.sources')) > 0"
    );
    return {
      active,
      databasePath: dbPath,
      recipeCount,
      recipeRegionSemanticMemories,
      renamed,
      semanticMemories,
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

function summarizeIndexRebuild(value) {
  if (!value || typeof value !== 'object') {
    return { status: 'unknown' };
  }
  return {
    knowledgeSync: value.knowledgeSync
      ? {
          created: value.knowledgeSync.created,
          skipped: value.knowledgeSync.skipped,
          synced: value.knowledgeSync.synced,
          updated: value.knowledgeSync.updated,
          violations: value.knowledgeSync.violations?.length ?? 0,
        }
      : null,
    recipeRegionVectors: value.recipeRegionVectors
      ? {
          bridgeRecipeCount: value.recipeRegionVectors.bridgeRecipeCount,
          bridgeRefCount: value.recipeRegionVectors.bridgeRefCount,
          entries: value.recipeRegionVectors.entries,
          reason: value.recipeRegionVectors.reason,
          status: value.recipeRegionVectors.status,
          syncResult: value.recipeRegionVectors.syncResult
            ? {
                degradedReason: value.recipeRegionVectors.syncResult.degradedReason ?? null,
                embedded: value.recipeRegionVectors.syncResult.embedded,
                errors: value.recipeRegionVectors.syncResult.errors ?? [],
                generated: value.recipeRegionVectors.syncResult.generated,
                removed: value.recipeRegionVectors.syncResult.removed,
                scanned: value.recipeRegionVectors.syncResult.scanned,
                skipped: value.recipeRegionVectors.syncResult.skipped,
                status: value.recipeRegionVectors.syncResult.status,
                upserted: value.recipeRegionVectors.syncResult.upserted,
              }
            : null,
          semanticMemories: value.recipeRegionVectors.semanticMemories
            ? {
                created: value.recipeRegionVectors.semanticMemories.created,
                deleted: value.recipeRegionVectors.semanticMemories.deleted,
                reason: value.recipeRegionVectors.semanticMemories.reason ?? null,
                skipped: value.recipeRegionVectors.semanticMemories.skipped,
                status: value.recipeRegionVectors.semanticMemories.status,
                total: value.recipeRegionVectors.semanticMemories.total,
                updated: value.recipeRegionVectors.semanticMemories.updated,
              }
            : null,
          vectorAvailability: value.recipeRegionVectors.vectorAvailability
            ? {
                available: value.recipeRegionVectors.vectorAvailability.available,
                detail: value.recipeRegionVectors.vectorAvailability.detail ?? null,
                embedProviderConfigured:
                  value.recipeRegionVectors.vectorAvailability.embedProviderConfigured,
                probeStatus: value.recipeRegionVectors.vectorAvailability.probeStatus,
                reason: value.recipeRegionVectors.vectorAvailability.reason,
                status: value.recipeRegionVectors.vectorAvailability.status,
              }
            : null,
          vectorStatsAfter: value.recipeRegionVectors.vectorStatsAfter,
          vectorStatsBefore: value.recipeRegionVectors.vectorStatsBefore,
        }
      : null,
    sourceRefs: value.sourceRefs
      ? {
          active: value.sourceRefs.active,
          cleaned: value.sourceRefs.cleaned ?? 0,
          inserted: value.sourceRefs.inserted,
          recipesProcessed: value.sourceRefs.recipesProcessed,
          skipped: value.sourceRefs.skipped,
          stale: value.sourceRefs.stale,
        }
      : null,
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
