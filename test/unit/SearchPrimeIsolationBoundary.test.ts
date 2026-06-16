import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('alembic_search and alembic_prime source boundary', () => {
  it('keeps public search independent from prime relation-chain providers', () => {
    const source = readProjectFile('../../lib/runtime/mcp/handlers/search.ts');
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

  it('keeps prime relation and Trust Receipt fields on the prime public surface', () => {
    const primeHandler = readProjectFile('../../lib/runtime/mcp/handlers/agent-public-tools.ts');
    const primeContract = readProjectFile('../../lib/runtime/mcp/public-tools/contract.ts');

    expect(primeHandler).toContain('trustReceipt: input.primePackage.trustReceipt');
    expect(primeHandler).toContain('recipeRelationCount');
    expect(primeHandler).toContain('relationEvidence');
    expect(primeContract).toContain('trustReceipt');
    expect(primeContract).toContain('primeInjectionPackage');
    expect(primeContract).toContain('relationEvidenceCount');
  });
});
