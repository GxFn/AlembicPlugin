import { createAlembicResidentServiceStatus, type DaemonState } from '@alembic/core/daemon';
import { describe, expect, it, vi } from 'vitest';
import { AlembicResidentServiceClient } from '../../lib/service/resident/AlembicResidentServiceClient.js';
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

function residentHealthPayload() {
  return {
    success: true,
    data: {
      residentService: createAlembicResidentServiceStatus({
        apiBaseUrl: 'http://127.0.0.1:4321',
        owner: 'alembic',
        route: 'local-alembic-daemon',
        capabilityOverrides: {
          'dashboard.handoff': {
            available: true,
            message: 'Dashboard handoff available.',
          },
          'jobs.internal-ai.bootstrap': {
            available: true,
            message: 'Bootstrap jobs available.',
          },
          'jobs.internal-ai.rescan': {
            available: true,
            message: 'Rescan jobs available.',
          },
          'search.keyword': {
            available: true,
            message: 'Keyword search available.',
          },
          'search.semantic': {
            available: true,
            message: 'Semantic search available.',
          },
          'status.health': {
            available: true,
            message: 'Health available.',
          },
        },
      }),
    },
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

describe('AlembicResidentServiceClient', () => {
  it('normalizes Codex auto mode to daemon semantic mode while preserving requested mode metadata', async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(fetchInputUrl(input));
      if (fetchInputUrl(input).pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(residentHealthPayload()), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
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

    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const result = await client.search({ query: 'VideoURLPreloader', mode: 'auto', limit: 3 });

    expect(requestedUrls[0]?.pathname).toBe('/api/v1/daemon/health');
    expect(requestedUrls[1]?.pathname).toBe('/api/v1/search');
    expect(requestedUrls[1]?.searchParams.get('mode')).toBe('semantic');
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
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (fetchInputUrl(input).pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(residentHealthPayload()), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
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

    const client = new AlembicResidentServiceClient({
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
