import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAlembicResidentServiceStatus,
  createProjectRuntimeControlState,
  type DaemonState,
} from '@alembic/core/daemon';
import { getProjectRegistryDir } from '@alembic/core/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlembicResidentServiceClient } from '../../lib/service/resident/AlembicResidentServiceClient.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

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

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-resident-home-'));
}

function writeRuntimeControlState(
  state: Parameters<typeof createProjectRuntimeControlState>[0]
): void {
  fs.mkdirSync(getProjectRegistryDir(), { recursive: true });
  fs.writeFileSync(
    path.join(getProjectRegistryDir(), 'runtime-control.json'),
    `${JSON.stringify(createProjectRuntimeControlState(state), null, 2)}\n`
  );
}

function projectScopeSummary(
  overrides: {
    controlRoot?: string;
    currentFolderId?: string;
    currentFolderPath?: string;
    folders?: Array<{
      displayName: string;
      folderId: string;
      path: string;
      realpath: string | null;
      role: 'primary-source' | 'source';
      state: 'active';
    }>;
  } = {}
) {
  const controlRoot = overrides.controlRoot ?? '/tmp/workspace';
  const currentFolderPath = overrides.currentFolderPath ?? '/tmp/project';
  const currentFolderId = overrides.currentFolderId ?? 'folder-plugin';
  return {
    contractVersion: 1,
    controlRoot,
    controlRootIncludedInFolders: false,
    currentFolderId,
    currentFolderPath,
    dataRoot: '/tmp/alembic-project-scope-data',
    dataRootSource: 'ghost-registry',
    displayName: 'Alembic Workspace',
    folderCount: 2,
    folders: overrides.folders ?? [
      {
        displayName: 'Plugin',
        folderId: currentFolderId,
        path: currentFolderPath,
        realpath: currentFolderPath,
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

function intentEvidenceFixture() {
  return {
    degraded: false,
    degradedReasons: ['vector:evidence-observe-only'],
    relationEvidence: [
      {
        direction: 'outgoing',
        itemId: 'resident-1',
        relatedId: 'recipe-related',
        relation: 'related',
        source: 'knowledgeGraphService',
      },
    ],
    scoreBreakdown: [
      {
        finalScore: 0.92,
        itemId: 'resident-1',
        rank: 1,
        semanticScore: 0.82,
        signals: ['final-score', 'semantic-score'],
        vectorScore: null,
      },
    ],
    semanticAnchors: [
      {
        kind: 'source-ref',
        source: 'intentSearchPlan.sourceRefs',
        value: '/Users/example/private-project/src/service.ts:42',
        weight: 0.55,
      },
    ],
    topAnchorMatches: [
      {
        anchor: 'service factory',
        itemId: 'resident-1',
        matchType: 'text',
        rank: 1,
        score: 0.92,
        sourceRefs: ['/Users/example/private-project/src/service.ts:42'],
        title: 'Resident vector recipe',
      },
    ],
    version: 1,
  };
}

describe('AlembicResidentServiceClient', () => {
  afterEach(() => {
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
    vi.restoreAllMocks();
  });

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
              intentEvidence: intentEvidenceFixture(),
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
      intentEvidence: {
        semanticAnchors: [
          expect.objectContaining({
            value: '[absolute-path]/service.ts:42',
          }),
        ],
        topAnchorMatches: [
          expect.objectContaining({
            sourceRefs: ['[absolute-path]/service.ts:42'],
          }),
        ],
      },
      projectScopeIdentity: {
        mode: 'project-scope',
        projectScopeId: 'project-scope-workspace',
        serviceScopeId: 'project-scope:project-scope-workspace',
      },
      residentRequestMode: 'semantic',
      requestedMode: 'semantic',
    });
    expect(result.meta.intentEvidence).toMatchObject({
      scoreBreakdown: [
        expect.objectContaining({
          itemId: 'resident-1',
          semanticScore: 0.82,
        }),
      ],
      relationEvidence: [
        expect.objectContaining({
          relatedId: 'recipe-related',
        }),
      ],
    });
    expect(JSON.stringify(result.meta.intentEvidence)).not.toContain('/Users/example');
    expect(result.meta.projectScopeIdentity).toMatchObject({
      available: true,
      mode: 'project-scope',
      projectScopeId: 'project-scope-workspace',
      source: 'resident-service-scope',
    });
    expect(result.meta.residentVector).toMatchObject({ available: true });
  });

  it('uses POST body for resident host intent handoff without leaking context into the URL', async () => {
    const requests: Array<{ init?: RequestInit; url: URL }> = [];
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = fetchInputUrl(input);
        requests.push({ init, url });
        if (url.pathname === '/api/v1/daemon/health') {
          return new Response(JSON.stringify(residentHealthPayload()), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [{ id: 'resident-1', title: 'Resident intent recipe', score: 0.92 }],
              searchMeta: {
                actualMode: 'semantic',
                hostIntentApplied: true,
                hostIntentConfidence: 0.82,
                hostIntentDegraded: false,
                hostIntentSourceRefs: ['host:intent'],
                requestedMode: 'semantic',
                semanticUsed: true,
                vectorUsed: true,
                residentVector: { available: true, reason: null },
              },
            },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      }
    ) as unknown as typeof fetch;

    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const result = await client.search({
      query: 'resident host intent',
      mode: 'auto',
      limit: 3,
      confidence: 0.82,
      degraded: false,
      hostDeclaredIntent: {
        query: 'resident host intent',
        sourceRefs: ['host:intent'],
      },
      hostTurnMeta: {
        redactions: ['threadId', 'activeFile'],
        threadIdHash: 'thread-hash',
      },
      intentContext: {
        confidence: 0.82,
        query: 'resident host intent',
        sourceRefs: ['host:intent'],
      },
      language: 'typescript',
      sessionHistory: [{ content: 'previous host turn' }],
      sourceRefs: ['host:intent'],
    });

    const searchRequest = requests.find((request) => request.url.pathname === '/api/v1/search');
    expect(searchRequest?.init?.method).toBe('POST');
    expect(searchRequest?.url.search).toBe('');
    const body = JSON.parse(String(searchRequest?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      confidence: 0.82,
      hostDeclaredIntent: { query: 'resident host intent' },
      hostTurnMeta: { threadIdHash: 'thread-hash' },
      intentContext: { query: 'resident host intent' },
      language: 'typescript',
      mode: 'semantic',
      query: 'resident host intent',
      sessionHistory: [{ content: 'previous host turn' }],
      sourceRefs: ['host:intent'],
    });
    expect(JSON.stringify(body)).not.toContain('/tmp/project');
    expect(result.meta.hostIntentHandoff).toMatchObject({
      enabled: true,
      requestRoute: 'post-body',
      sessionHistoryCount: 1,
      sourceRefsCount: 1,
    });
    expect(result.meta.searchMeta).toMatchObject({
      hostIntentApplied: true,
      hostIntentConfidence: 0.82,
    });
  });

  it('uses resident IntentEpisode API for start, read, and outcome handoff', async () => {
    const requests: Array<{ body?: Record<string, unknown>; method?: string; url: URL }> = [];
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = fetchInputUrl(input);
        requests.push({
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
          method: init?.method,
          url,
        });
        if (url.pathname === '/api/v1/daemon/health') {
          return new Response(JSON.stringify(residentHealthPayload()), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        }
        if (url.pathname === '/api/v1/intent-episodes/latest') {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                capability: { owner: 'alembic' },
                episode: {
                  episodeId: 'episode-prev',
                  query: 'previous',
                  sessionKey: 'sha256:previous',
                  sourceRefs: ['host:previous'],
                  status: 'completed',
                },
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 }
          );
        }
        if (url.pathname === '/api/v1/intent-episodes/recent') {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                capability: { owner: 'alembic' },
                count: 1,
                episodes: [
                  {
                    episodeId: 'episode-prev',
                    query: 'previous',
                    sessionKey: 'sha256:previous',
                    sourceRefs: ['host:previous'],
                    status: 'completed',
                  },
                ],
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 }
          );
        }
        if (url.pathname === '/api/v1/intent-episodes' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                capability: { owner: 'alembic' },
                episode: {
                  episodeId: 'episode-current',
                  query: 'resident episode',
                  sessionKey: 'sha256:current',
                  sourceRefs: ['host:intent'],
                  status: 'active',
                },
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 201 }
          );
        }
        if (url.pathname === '/api/v1/intent-episodes/episode-current') {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                capability: { owner: 'alembic' },
                episode: {
                  episodeId: 'episode-current',
                  sessionKey: 'sha256:current',
                  status: 'completed',
                },
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 }
          );
        }
        throw new Error(`Unexpected URL: ${url.pathname}`);
      }
    ) as unknown as typeof fetch;

    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const latest = await client.latestIntentEpisode({ sessionId: 'thread:hash' });
    const recent = await client.recentIntentEpisodes({ limit: 3, sessionId: 'thread:hash' });
    const start = await client.startIntentEpisode({
      activeFile: '/Users/example/private-project/lib/file.ts',
      hostIntent: {
        applied: true,
        confidence: 0.8,
        hostTurnMeta: { threadIdHash: 'hash' },
        sourceRefs: ['host:intent'],
      },
      query: 'resident episode',
      scenario: 'implementation',
      searchMeta: {
        hostIntentApplied: true,
        hostIntentConfidence: 0.8,
        queries: ['resident episode'],
        resultCount: 1,
      },
      sessionId: 'thread:hash',
      sourceRefs: ['host:intent'],
      turnId: 'turn-1',
    });
    const updated = await client.updateIntentEpisodeOutcome('episode-current', {
      reason: 'done',
      status: 'completed',
      taskId: 'task-1',
    });

    expect(latest.ok).toBe(true);
    expect(recent.ok).toBe(true);
    expect(start.ok).toBe(true);
    expect(updated.ok).toBe(true);
    if (start.ok) {
      expect(start.value.episode).toMatchObject({
        episodeId: 'episode-current',
        sessionKey: 'sha256:current',
        status: 'active',
      });
    }
    const latestRequest = requests.find((request) => request.url.pathname.endsWith('/latest'));
    const recentRequest = requests.find((request) => request.url.pathname.endsWith('/recent'));
    const startRequest = requests.find(
      (request) => request.url.pathname === '/api/v1/intent-episodes' && request.method === 'POST'
    );
    const updateRequest = requests.find((request) =>
      request.url.pathname.endsWith('/episode-current')
    );
    expect(latestRequest?.url.searchParams.get('sessionId')).toBe('thread:hash');
    expect(recentRequest?.url.searchParams.get('limit')).toBe('3');
    expect(startRequest?.body).toMatchObject({
      activeFile: '/Users/example/private-project/lib/file.ts',
      hostIntent: {
        applied: true,
        hostTurnMeta: { threadIdHash: 'hash' },
      },
      query: 'resident episode',
      sessionId: 'thread:hash',
      sourceRefs: ['host:intent'],
      turnId: 'turn-1',
    });
    expect(JSON.stringify(startRequest?.body?.hostIntent)).not.toContain('raw-thread-id');
    expect(updateRequest?.method).toBe('PATCH');
    expect(updateRequest?.body).toMatchObject({
      reason: 'done',
      status: 'completed',
      taskId: 'task-1',
    });
  });

  it('degrades resident IntentEpisode handoff when an older daemon lacks the route', async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
      requestedUrls.push(url);
      if (url.pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(residentHealthPayload()), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: { message: 'IntentEpisode route unavailable' },
        }),
        { headers: { 'content-type': 'application/json' }, status: 404 }
      );
    }) as unknown as typeof fetch;

    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const result = await client.startIntentEpisode({
      query: 'resident episode',
      sessionId: 'thread:hash',
    });

    expect(result.ok).toBe(false);
    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/api/v1/daemon/health',
      '/api/v1/intent-episodes',
    ]);
    if (!result.ok) {
      expect(result.reason).toBe('request-failed');
      expect(result.message).toBe('IntentEpisode route unavailable');
      expect(result.telemetry).toMatchObject({
        feature: 'intent-episodes',
        status: 404,
      });
    }
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

  it('discovers an active controlRoot resident for a bound source folder', async () => {
    useTempAlembicHome();
    const controlRoot = '/tmp/workspace';
    const boundFolder = '/tmp/workspace/AlembicCore';
    const activeState = {
      ...daemonState(),
      projectRoot: controlRoot,
      projectId: 'project-workspace',
      dataRoot: '/tmp/alembic-project-scope-data',
      databasePath: '/tmp/alembic-project-scope-data/alembic.db',
    };
    writeRuntimeControlState({
      activeProjectId: 'project-workspace',
      activeProjectRoot: controlRoot,
      selectedAt: '2026-05-25T00:00:00.000Z',
      selectedProjectId: 'project-workspace',
      selectedProjectRoot: controlRoot,
      updatedAt: '2026-05-25T00:00:00.000Z',
    });
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
              capability: { available: true },
              summary: projectScopeSummary({
                controlRoot,
                currentFolderId: 'folder-core',
                currentFolderPath: boundFolder,
              }),
            },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const readState = vi.fn((projectRoot: string) =>
      projectRoot === controlRoot ? activeState : null
    );
    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: boundFolder,
      readState,
    });

    const identity = await client.resolveProjectScopeIdentity();

    expect(readState).toHaveBeenCalledWith(boundFolder);
    expect(readState).toHaveBeenCalledWith(controlRoot);
    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/api/v1/daemon/health',
      '/api/v1/project-scope/resolve-folder',
    ]);
    expect(requestedUrls[1]?.searchParams.get('folderPath')).toBe(boundFolder);
    expect(identity).toMatchObject({
      available: true,
      currentFolderId: 'folder-core',
      currentFolderPath: boundFolder,
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
