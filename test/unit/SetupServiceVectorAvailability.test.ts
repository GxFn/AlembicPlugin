import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupService } from '../../lib/cli/SetupService.js';
import {
  getServiceContainer,
  resetServiceContainer,
} from '../../lib/injection/ServiceContainer.js';

describe('SetupService vector availability gate', () => {
  afterEach(() => {
    resetServiceContainer();
  });

  it('builds the vector index from Core availability even when legacy stats say provider unavailable', async () => {
    const fullBuild = vi.fn(async () => ({
      errors: 0,
      skipped: 0,
      upserted: 2,
    }));
    const service = createSetupService({
      fullBuild,
      getAvailability: vi.fn(async () => vectorAvailability({ available: true })),
      getStats: vi.fn(async () => ({
        count: 0,
        dimension: 1024,
        embedProviderAvailable: false,
      })),
    });

    const result = await service.stepVectorIndex();

    expect(fullBuild).toHaveBeenCalledWith({ force: false });
    expect(result).toMatchObject({
      errors: 0,
      indexed: 2,
      status: 'done',
      vectorAvailability: {
        available: true,
        reason: 'embed-provider-ready',
        status: 'available',
      },
    });
  });

  it('skips index building when Core availability reports a degraded provider', async () => {
    const fullBuild = vi.fn();
    const service = createSetupService({
      fullBuild,
      getAvailability: vi.fn(async () =>
        vectorAvailability({
          available: false,
          probeStatus: 'unavailable',
          reason: 'embed-provider-unavailable',
          status: 'degraded',
        })
      ),
      getStats: vi.fn(async () => ({
        count: 0,
        dimension: 1024,
        embedProviderAvailable: true,
      })),
    });

    const result = await service.stepVectorIndex();

    expect(fullBuild).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'skipped',
      vectorAvailability: {
        available: false,
        probeStatus: 'unavailable',
        reason: 'embed-provider-unavailable',
        status: 'degraded',
      },
    });
  });
});

function createSetupService(vectorService: Record<string, unknown>): SetupService {
  const container = getServiceContainer();
  container.register('vectorService', () => vectorService);
  return new SetupService({
    force: false,
    projectRoot: '/tmp/alembic-plugin-setup-test',
    quiet: true,
  });
}

function vectorAvailability(
  overrides: Partial<{
    available: boolean;
    embedProviderConfigured: boolean;
    probeStatus: string;
    reason: string;
    status: string;
  }> = {}
) {
  return {
    available: overrides.available ?? true,
    embedProviderConfigured: overrides.embedProviderConfigured ?? true,
    probeStatus: overrides.probeStatus ?? 'available',
    reason: overrides.reason ?? 'embed-provider-ready',
    status: overrides.status ?? 'available',
  };
}
