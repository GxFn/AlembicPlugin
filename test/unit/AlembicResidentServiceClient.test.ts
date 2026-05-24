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

function projectScopeSummary() {
  return {
    contractVersion: 1,
    controlRoot: '/tmp/workspace',
    controlRootIncludedInFolders: false,
    currentFolderId: 'folder-plugin',
    currentFolderPath: '/tmp/project',
    dataRoot: '/tmp/alembic-project-scope-data',
    dataRootSource: 'ghost-registry',
    displayName: 'Alembic Workspace',
    folderCount: 2,
    folders: [
      {
        displayName: 'Plugin',
        folderId: 'folder-plugin',
        path: '/tmp/project',
        realpath: '/tmp/project',
        role: 'source',
        state: 'active',
      },
      {
        displayName: 'Core',
        folderId: 'folder-core',
        path: '/tmp/core',
        realpath: '/tmp/core',
        role: 'source',
        state: 'active',
      },
    ],
    projectId: 'project-workspace',
    projectRootWriteAllowed: false,
    projectScopeId: 'project-scope-workspace',
    standardWriteAllowed: false,
    storageKind: 'ghost',
  };
}

function residentHealthPayload(
  options: { projectScope?: ReturnType<typeof projectScopeSummary> | null } = {}
) {
  const projectScope =
    options.projectScope === undefined ? projectScopeSummary() : options.projectScope;
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
        serviceScope: {
          diagnosticPaths: {
            controlRoot: projectScope?.controlRoot ?? null,
            databasePath: '/tmp/alembic-project-scope-data/alembic.db',
            dataRoot: projectScope?.dataRoot ?? '/tmp/alembic-data',
            projectRoot: '/tmp/project',
            runtimeDir: '/tmp/alembic-runtime',
            statePath: '/tmp/alembic-runtime/daemon.json',
          },
          displayName: projectScope?.displayName ?? 'Alembic current service scope',
          kind: 'current-project',
          projectIdentity: {
            dataRootSource: projectScope ? 'ghost-registry' : null,
            projectId: projectScope?.projectId ?? 'project-1',
            projectScope,
            projectScopeId: projectScope?.projectScopeId ?? null,
            schemaMigrationVersion: null,
            workspaceMode: projectScope ? 'ghost' : null,
          },
          scopeId: projectScope
            ? `project-scope:${projectScope.projectScopeId}`
            : 'project:project-1',
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
      projectScopeIdentity: {
        mode: 'project-scope',
        projectScopeId: 'project-scope-workspace',
        serviceScopeId: 'project-scope:project-scope-workspace',
      },
      residentRequestMode: 'semantic',
      requestedMode: 'semantic',
    });
    expect(result.meta.projectScopeIdentity).toMatchObject({
      available: true,
      mode: 'project-scope',
      projectScopeId: 'project-scope-workspace',
      source: 'resident-service-scope',
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

  it('resolves ProjectScope from the resident endpoint when health only advertises baseline identity', async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
      requestedUrls.push(url);
      if (url.pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(residentHealthPayload({ projectScope: null })), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      if (url.pathname === '/api/v1/project-scope/resolve-folder') {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              capability: {
                available: true,
                supportedOperations: ['project-scope.read', 'project-folders.resolve'],
              },
              summary: projectScopeSummary(),
            },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const identity = await client.resolveProjectScopeIdentity();

    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/api/v1/daemon/health',
      '/api/v1/project-scope/resolve-folder',
    ]);
    expect(requestedUrls[1]?.searchParams.get('folderPath')).toBe('/tmp/project');
    expect(identity).toMatchObject({
      available: true,
      currentFolderId: 'folder-plugin',
      mode: 'project-scope',
      projectScopeId: 'project-scope-workspace',
      source: 'resident-project-scope-endpoint',
    });
  });

  it('keeps a single-folder baseline when resident ProjectScope resolve returns no match', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(residentHealthPayload({ projectScope: null })), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      if (url.pathname === '/api/v1/project-scope/resolve-folder') {
        return new Response(
          JSON.stringify({
            success: true,
            data: { capability: { available: true }, summary: null },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      }
      return new Response(JSON.stringify({ success: true, data: { items: [], searchMeta: {} } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const identity = await client.resolveProjectScopeIdentity();

    expect(identity).toMatchObject({
      available: false,
      mode: 'single-folder-baseline',
      projectScopeId: null,
      reason: expect.stringContaining('resident project scope unavailable'),
      source: 'plugin-single-folder-baseline',
    });
  });

  it('reports single-folder baseline when no Alembic daemon state exists', async () => {
    const client = new AlembicResidentServiceClient({
      projectRoot: '/tmp/project',
      readState: () => null,
    });

    const identity = await client.resolveProjectScopeIdentity();

    expect(identity).toMatchObject({
      available: false,
      mode: 'single-folder-baseline',
      reason: expect.stringContaining('resident project scope unavailable'),
      resident: {
        owner: 'alembic-plugin',
        route: 'unavailable',
      },
    });
  });
});
