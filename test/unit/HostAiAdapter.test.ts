import { describe, expect, it } from 'vitest';
import {
  createHostAiProviderManager,
  createHostManagedProvider,
  type HostAiProvider,
  providerSupportsExecutableEmbedding,
} from '../../lib/codex/HostAiAdapter.js';

describe('HostAiAdapter embedding capability boundary', () => {
  it('does not treat host-managed placeholder embed() as executable', async () => {
    const manager = createHostAiProviderManager(
      createHostManagedProvider({ provider: 'openai', model: 'gpt-5.5' })
    );

    expect(manager.runtimeProvider).toBeNull();
    expect(manager.embedProvider).toBeNull();
    expect(manager.info.supportsEmbedding).toBe(false);
    expect(providerSupportsExecutableEmbedding(manager.provider)).toBe(false);
    await expect(manager.provider.embed('query')).rejects.toThrow(
      'AI execution is provided by the host agent'
    );
  });

  it('keeps a real embed provider executable when it explicitly supports embeddings', async () => {
    const provider = {
      name: 'custom',
      model: 'custom-embedding',
      supportsEmbedding: () => true,
      embed: async () => [0.1, 0.2, 0.3],
    } as unknown as HostAiProvider;

    const manager = createHostAiProviderManager(provider);

    expect(providerSupportsExecutableEmbedding(manager.provider)).toBe(true);
    expect(manager.embedProvider).toBe(manager.provider);
    await expect(manager.embedProvider?.embed('query')).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});
