import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('alembic_search and alembic_prime source boundary', () => {
  it('keeps public search independent from prime relation-chain providers', () => {
    const source = readProjectFile('../../lib/host-runtime/mcp/handlers/search.ts');
    const forbiddenTokens = [
      'RecipeRelationChainProvider',
      'DefaultRecipeRelationChainProvider',
      'PrimeSearchPipeline',
      'PrimeKnowledgeMaterial',
      'HostIntentFrame',
      'buildHostIntentFrame',
      'buildResidentIntentHandoff',
      'prepareHostIntentInput',
      'PrimeInjectionPackage',
      'primeInjectionPackage',
      'intentEvidence',
      'hostIntentHandoff',
      'contextSearch',
      'relationEvidenceEdgesFromSearchMeta',
    ];

    for (const token of forbiddenTokens) {
      expect(source).not.toContain(token);
    }
  });

  it('keeps Trust Receipt on the prime public surface (relation surface intentionally scrubbed)', () => {
    // 钉更新（2026-07-06）：原断言追踪 GMAP-8 之前的世界（primePackage.trustReceipt 提升
    // + recipeRelation 面）。现实设计：trustReceipt 由 handler 就地装配；recipeRelation*
    // 面被 scrubPrimeOutputRelationSurface 有意从 prime 公开面移除（output.ts），不应再断言存在。
    const primeHandler = readProjectFile(
      '../../lib/host-runtime/mcp/handlers/agent-public-tools.ts'
    );
    const primeContract = readProjectFile('../../lib/host-runtime/mcp/public-tools/contract.ts');
    const primeOutput = readProjectFile('../../lib/host-runtime/mcp/public-tools/output.ts');

    expect(primeHandler).toContain('trustReceipt: {');
    expect(primeContract).toContain('trustReceipt');
    expect(primeContract).toContain('primeInjectionPackage');
    expect(primeOutput).toContain('scrubPrimeOutputRelationSurface');
  });
});
