import { SearchEngine } from '@alembic/core/search';
import Database from 'better-sqlite3';
import { describe, expect, test, vi } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { primeHandler } from '../../lib/host-runtime/mcp/handlers/agent-public-tools.js';
import { search } from '../../lib/host-runtime/mcp/handlers/search.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { createReadOnlySearchRepositories } from '../../lib/repository/search/ReadOnlySearchServices.js';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

describe('public Search/Prime vector truth projection', () => {
  test('filters orphan/deprecated vectors through the request DB and reports bounded Search evidence', async () => {
    const fixture = createTruthFixture();
    try {
      const semantic = (await search(fixture.context, {
        operation: 'search',
        query: 'truthful vector results',
        mode: 'semantic',
        limit: 2,
      })) as { structuredContent: Record<string, any> };
      const automatic = (await search(fixture.context, {
        operation: 'search',
        query: 'truthful vector results',
        mode: 'auto',
        limit: 2,
      })) as { structuredContent: Record<string, any> };
      const orphanGet = (await search(fixture.context, {
        operation: 'get',
        refId: 'knowledge:orphan-vector',
      })) as { structuredContent: Record<string, any> };

      for (const output of [semantic.structuredContent, automatic.structuredContent]) {
        expect(output.items.map((item: any) => item.id)).toEqual(['live-a', 'live-b']);
        expect(output.result).toMatchObject({
          vectorUsed: true,
          filteredOrphanVectorCount: 2,
        });
        expect(output.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'search-orphan-vector-filtered' }),
          ])
        );
        expect(JSON.stringify(output)).not.toContain('Orphan vector title');
        expect(JSON.stringify(output)).not.toContain('Deprecated vector title');
      }
      expect(orphanGet.structuredContent.result).toMatchObject({ found: false });
      expect(fixture.vectorService.upsert).not.toHaveBeenCalled();
      expect(fixture.vectorService.remove).not.toHaveBeenCalled();
      expect(fixture.vectorService.clear).not.toHaveBeenCalled();
      expect(fixture.vectorService.reconcileIndex).not.toHaveBeenCalled();
    } finally {
      fixture.db.close();
    }
  });

  test('Prime exposes only live knowledge and emits non-gating orphan-filter evidence', async () => {
    const fixture = createTruthFixture();
    try {
      const output = (await primeHandler(fixture.context, {
        query: 'truthful vector results',
      })) as Record<string, any>;

      expect(output.status).toBe('ready');
      expect(
        output.primePackage.compactPackage.acceptedKnowledge.map((item: any) => item.id)
      ).toEqual(['live-a', 'live-b']);
      expect(output.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'prime-orphan-vector-filtered' })])
      );
      expect(JSON.stringify(output)).not.toContain('Orphan vector title');
      expect(JSON.stringify(output)).not.toContain('Deprecated vector title');
    } finally {
      fixture.db.close();
    }
  });
});

function createTruthFixture(): {
  context: McpContext;
  db: Database.Database;
  vectorService: {
    clear: ReturnType<typeof vi.fn>;
    hybridSearch: ReturnType<typeof vi.fn>;
    reconcileIndex: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
} {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      language TEXT,
      dimensionId TEXT,
      category TEXT,
      knowledgeType TEXT,
      kind TEXT,
      scope TEXT,
      content TEXT,
      lifecycle TEXT,
      tags TEXT,
      trigger TEXT,
      difficulty TEXT,
      quality TEXT,
      stats TEXT,
      headers TEXT,
      moduleName TEXT,
      whenClause TEXT,
      doClause TEXT,
      updatedAt TEXT,
      createdAt TEXT
    );
    CREATE TABLE recipe_source_refs (
      recipe_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL,
      new_path TEXT
    );
    INSERT INTO knowledge_entries
      (id, title, description, kind, scope, lifecycle, content, tags, updatedAt, createdAt)
    VALUES
      ('live-a', 'Live A', 'first live row', 'pattern', 'project', 'active', '{}', '[]', '2026-01-01', '2026-01-01'),
      ('live-b', 'Live B', 'second live row', 'pattern', 'project', 'active', '{}', '[]', '2026-01-01', '2026-01-01');
  `);
  db.pragma('query_only = ON');

  const semanticCandidates = [
    vectorSearchHit('orphan-vector', 'Orphan vector title', 0.99),
    vectorSearchHit('live-a', 'Live A', 0.93),
    vectorSearchHit('deprecated-vector', 'Deprecated vector title', 0.84),
    vectorSearchHit('live-b', 'Live B', 0.72),
  ];
  const vectorService = {
    search: vi.fn().mockResolvedValue(semanticCandidates),
    hybridSearch: vi.fn().mockResolvedValue(
      semanticCandidates.map((hit) => ({
        id: String(hit.item.metadata.entryId),
        score: hit.score,
        semanticUsed: true,
        vectorUsed: true,
      }))
    ),
    upsert: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    reconcileIndex: vi.fn(),
  };
  const searchEngine = new SearchEngine(db, { vectorService: vectorService as never });
  const primeSearchPipeline = new PrimeSearchPipeline(searchEngine);
  const { knowledgeService } = createReadOnlySearchRepositories(db);
  const projectRuntime = buildProjectRuntimeContext({ projectRoot: process.cwd() });
  return {
    context: {
      projectRuntime,
      container: {
        get(name: string): unknown {
          if (name === 'knowledgeService') return knowledgeService;
          if (name === 'primeSearchPipeline') return primeSearchPipeline;
          if (name === 'searchEngine') return searchEngine;
          return undefined;
        },
      },
    } as McpContext,
    db,
    vectorService,
  };
}

function vectorSearchHit(id: string, title: string, score: number) {
  return {
    score,
    item: {
      id: `entry_${id}`,
      metadata: { entryId: id, scope: 'project', title },
    },
  };
}
