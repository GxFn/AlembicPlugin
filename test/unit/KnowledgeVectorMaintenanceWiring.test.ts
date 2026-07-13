import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import * as InfraModule from '../../lib/injection/modules/InfraModule.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('KnowledgeSyncService production vector maintenance wiring', () => {
  it('awaits the canonical authoritative maintenance port after direct file-to-DB sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alembic-vector-maintenance-'));
    roots.push(root);
    let releaseMaintenance: (() => void) | undefined;
    const syncRecipeSemanticRegions = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          releaseMaintenance = () =>
            resolve({
              errors: [],
              generated: 0,
              generatedMetadata: [],
              removed: 0,
              scanned: 0,
              skipped: 0,
              status: 'completed',
              upserted: 0,
            });
        })
    );
    const container = new ServiceContainer();
    container.singletons._projectRoot = root;
    container.singletons._workspaceResolver = { dataRoot: root };
    InfraModule.register(container);
    container.register('knowledgeService', () => ({
      list: vi.fn(async () => ({ data: [] })),
    }));
    container.register('memoryRepository', () => ({
      create: vi.fn(),
      delete: vi.fn(),
      findById: vi.fn(),
      getAllActive: vi.fn(() => []),
      update: vi.fn(),
    }));
    container.register('recipeSourceRefRepository', () => ({
      findActiveByRecipeIds: vi.fn(() => []),
    }));
    container.register('vectorService', () => ({
      getAvailability: vi.fn(async () => ({
        available: true,
        probeStatus: 'ready',
        reason: 'embed-provider-ready',
        status: 'available',
      })),
      getStats: vi.fn(async () => ({ count: 0, dimension: 3, hasIndex: true, indexSize: 0 })),
      syncRecipeSemanticRegions,
    }));
    container.register('vectorStore', () => ({ flush: vi.fn(async () => undefined) }));

    const syncService = container.get('knowledgeSyncService');
    const syncPromise = syncService.syncAll(emptyRawDb(), { skipViolations: true });

    await vi.waitFor(() => expect(syncRecipeSemanticRegions).toHaveBeenCalledOnce());
    const pending = Symbol('pending');
    expect(await Promise.race([syncPromise, Promise.resolve(pending)])).toBe(pending);
    releaseMaintenance?.();

    await expect(syncPromise).resolves.toMatchObject({
      vectorMaintenanceStatus: 'completed',
      vectorMaintenanceReport: {
        entries: 0,
        status: 'synced',
        syncResult: { removed: 0 },
      },
    });
  });
});

function emptyRawDb() {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  };
}
