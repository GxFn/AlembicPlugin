import type { DaemonState } from '@alembic/core/daemon';
import { describe, expect, it, vi } from 'vitest';
import { ResidentSearchClient } from '../../lib/service/search/ResidentSearchClient.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

function daemonState(): DaemonState {
  return {
    dashboardUrl: 'http://127.0.0.1:4321/dashboard',
    dataRoot: '/tmp/alembic-data',
    databasePath: '/tmp/alembic-data/alembic.db',
    host: '127.0.0.1',
    lastReadyAt: '2026-05-21T00:00:00.000Z',
    mode: 'daemon',
    pid: 1234,
    port: 4321,
    projectId: 'project-1',
    projectRoot: '/tmp/project',
    schemaMigrationVersion: null,
    schemaVersion: 1,
    startedAt: '2026-05-21T00:00:00.000Z',
    token: 'token-1',
    url: 'http://127.0.0.1:4321',
    version: getPackageVersion(),
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

describe('ResidentSearchClient', () => {
  it('normalizes Codex auto mode to daemon semantic mode while preserving requested mode metadata', async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(fetchInputUrl(input));
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            items: [{ id: 'resident-1', title: 'Resident vector recipe', score: 0.92 }],
            searchMeta: {
              actualMode: 'semantic',
              requestedMode: 'semantic',
              semanticUsed: true,
              vectorUsed: true,
              residentVector: { available: true, reason: null },
            },
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new ResidentSearchClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const result = await client.search({ query: 'VideoURLPreloader', mode: 'auto', limit: 3 });

    expect(requestedUrls[0]?.searchParams.get('mode')).toBe('semantic');
    expect(result.meta.requestedMode).toBe('auto');
    expect(result.meta.residentRequestMode).toBe('semantic');
    expect(result.meta.searchMeta).toMatchObject({
      codexRequestedMode: 'auto',
      residentRequestMode: 'semantic',
      requestedMode: 'semantic',
    });
    expect(result.meta.residentVector).toMatchObject({ available: true });
  });

  it('does not claim resident vector availability when semantic telemetry is missing', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            items: [{ id: 'resident-1', title: 'Resident vector recipe', score: 0.92 }],
            searchMeta: {},
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new ResidentSearchClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const result = await client.search({ query: 'VideoURLPreloader', mode: 'auto' });

    expect(result.meta.available).toBe(true);
    expect(result.meta.residentVector).toMatchObject({
      available: false,
      reason: 'resident_search_telemetry_missing',
    });
    expect(result.meta.searchMeta).toMatchObject({
      codexRequestedMode: 'auto',
      residentRequestMode: 'semantic',
    });
  });
});
