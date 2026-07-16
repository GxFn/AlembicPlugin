import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const HOST_ROOT = path.resolve('lib/host-runtime/mcp/host');

describe('reachable public five-tool reader inventory', () => {
  test('keeps one formal executor per tool and gates every reader with the fixed resolver', () => {
    const embedded = read('embedded-executor.ts');
    const routes = {
      alembic_search: 'read-only-search-executor.ts',
      alembic_prime: 'read-only-prime-executor.ts',
      alembic_recipe_map: 'read-only-recipe-map-executor.ts',
      alembic_code_guard: 'read-only-code-guard-executor.ts',
      alembic_graph: 'read-only-graph-executor.ts',
    } as const;
    for (const [tool, file] of Object.entries(routes)) {
      expect(embedded, tool).toContain(`name === '${tool}'`);
      const source = read(file);
      expect(source, file).toMatch(/resolvePublicKnowledge(?:ReadRoute|Publication)/u);
      expect(source, file).not.toMatch(/EventBus|StagingManager|afterPublish/u);
    }
    const ordinaryResolver = read('public-knowledge-read-route.ts');
    expect(ordinaryResolver).toContain('resolvePublicKnowledgePublication');
    expect(ordinaryResolver).not.toMatch(
      /candidate|checkpoint|privateCorpusRevision|pathOverride/u
    );
  });

  test('keeps Graph live-source and Recipe-free while four knowledge tools share sealed snapshots', () => {
    const graph = read('read-only-graph-executor.ts');
    expect(graph).not.toMatch(/Database|createReadOnlySearchSnapshot|knowledgeService|Recipe/u);
    for (const file of [
      'read-only-search-executor.ts',
      'read-only-prime-executor.ts',
      'read-only-recipe-map-executor.ts',
      'read-only-code-guard-executor.ts',
    ]) {
      expect(read(file), file).toContain('createReadOnlySearchSnapshot');
    }
  });
});

function read(file: string): string {
  return fs.readFileSync(path.join(HOST_ROOT, file), 'utf8');
}
