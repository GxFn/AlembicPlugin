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
import { PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY } from '../../lib/runtime/mcp/plugin-host-contracts.js';
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
          'jobs.api-ai.bootstrap': {
            available: true,
            message: 'Bootstrap jobs available.',
          },
          'jobs.api-ai.rescan': {
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function primeInjectionPackageFixture() {
  return {
    decisionRegister: primeDecisionRegisterFixture(),
    feedback: primeFeedbackFixture(),
    injection: primeInjectionFixture(),
    intent: primeIntentFixture(),
    omitted: [],
    relations: primeRelationsFixture(),
    retrievalQuality: primeRetrievalQualityFixture(),
    search: primeSearchFixture(),
    selectedKnowledge: primeSelectedKnowledgeFixture(),
    trace: primeTraceFixture(),
    vector: primeVectorFixture(),
    version: 1,
  };
}

function primeDecisionRegisterFixture() {
  return {
    acceptedDecisionRefs: ['decision-active-1'],
    auditExcludedCount: 2,
    available: true,
    defaultLifecycle: 'active-effective-only',
    excludedStatuses: ['revoked', 'deleted'],
    route: '/api/v1/decision-register/searchable',
    source: 'alembic-decision-register',
    vectorAdmission: 'accepted-only',
  };
}

function primeFeedbackFixture() {
  return {
    observeOnly: true,
    recorder: 'HitRecorder',
    supportedSignals: ['searchHit', 'view', 'adoption'],
    version: 1,
  };
}

function primeInjectionFixture() {
  return {
    degradedReasons: [],
    omittedCount: 0,
    selectedCount: 1,
    status: 'ready',
  };
}

function primeIntentFixture() {
  return {
    applied: true,
    confidence: 0.86,
    degraded: false,
    degradedReasons: [],
    executableQuery: 'resident vector recipe',
    rankingProfile: 'semantic',
    requestedMode: 'semantic',
    sourceRefs: ['/Users/example/private-project/src/service.ts:42'],
    whySelected: ['intent-search-plan'],
  };
}

function primeRelationsFixture() {
  return {
    evidence: [
      {
        direction: 'outgoing',
        itemId: 'resident-1',
        relatedId: 'recipe-related',
        relation: 'related',
        source: 'knowledgeGraphService',
      },
    ],
    omitted: [],
  };
}

function primeRetrievalQualityFixture() {
  return {
    decisionRefCount: 1,
    feedbackSignalCount: 3,
    relationEvidenceCount: 1,
    selectedWithSourceRefs: 1,
    sourceRefCoverage: 1,
    version: 1,
  };
}

function primeSearchFixture() {
  return {
    actualMode: 'semantic',
    filteredCount: 1,
    query: 'resident vector recipe',
    queries: ['resident vector recipe'],
    requestedMode: 'semantic',
    resultCount: 1,
  };
}

function primeSelectedKnowledgeFixture() {
  return [
    {
      evidenceRefs: ['scoreBreakdown:resident-1', 'sourceRef:resident-1:1'],
      injectionStatus: 'selected',
      itemId: 'resident-1',
      kind: 'pattern',
      rank: 1,
      score: 0.92,
      sourceRefs: ['/Users/example/private-project/src/service.ts:42'],
      title: 'Resident vector recipe',
      trigger: '@resident-vector',
      whySelected: ['semantic-score'],
    },
  ];
}

function primeTraceFixture() {
  return {
    evidenceRefs: ['scoreBreakdown:resident-1'],
    sourcePath: ['searchMeta.primeInjectionPackage'],
    sourceRefs: ['/Users/example/private-project/src/service.ts:42'],
    sources: ['intentSearchPlan', 'intentEvidence'],
  };
}

function primeVectorFixture() {
  return {
    omitted: [],
    scoreBreakdown: [
      {
        finalScore: 0.92,
        itemId: 'resident-1',
        rank: 1,
        semanticScore: 0.82,
        signals: ['semantic-score'],
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
    semanticUsed: true,
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
    vectorAvailable: true,
    vectorUsed: true,
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
              primeInjectionPackage: primeInjectionPackageFixture(),
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
      primeInjectionPackage: {
        decisionRegister: {
          acceptedDecisionRefs: ['decision-active-1'],
          auditExcludedCount: 2,
          vectorAdmission: 'accepted-only',
        },
        feedback: {
          observeOnly: true,
          recorder: 'HitRecorder',
        },
        injection: {
          status: 'ready',
        },
        retrievalQuality: {
          decisionRefCount: 1,
          selectedWithSourceRefs: 1,
        },
        selectedKnowledge: [
          expect.objectContaining({
            injectionStatus: 'selected',
            itemId: 'resident-1',
            sourceRefs: ['[absolute-path]/service.ts:42'],
          }),
        ],
        trace: {
          sourceRefs: ['[absolute-path]/service.ts:42'],
        },
      },
      retrievalConsumer: {
        decisionRegister: {
          acceptedDecisionRefs: ['decision-active-1'],
          auditExcludedCount: 2,
        },
        producerContract: {
          available: true,
          missingFields: [],
          reasonCode: 'resident-search-stage1a-contract-present',
        },
        retrievalQuality: {
          decisionRefCount: 1,
          feedbackSignalCount: 3,
        },
      },
      projectScopeIdentity: {
        mode: 'project-scope',
        projectScopeId: 'project-scope-workspace',
        serviceScopeId: 'project-scope:project-scope-workspace',
      },
      residentRequestMode: 'semantic',
      requestedMode: 'semantic',
    });
    expect(result.meta.primeInjectionPackage).toMatchObject({
      decisionRegister: {
        acceptedDecisionRefs: ['decision-active-1'],
        auditExcludedCount: 2,
      },
      feedback: {
        observeOnly: true,
      },
      injection: {
        selectedCount: 1,
        status: 'ready',
      },
      retrievalQuality: {
        decisionRefCount: 1,
        feedbackSignalCount: 3,
      },
      trace: {
        evidenceRefs: ['scoreBreakdown:resident-1'],
        sources: ['intentSearchPlan', 'intentEvidence'],
      },
    });
    expect(result.meta.retrievalConsumer).toMatchObject({
      decisionRegister: {
        acceptedDecisionRefs: ['decision-active-1'],
        auditExcludedCount: 2,
      },
      feedback: {
        observeOnly: true,
      },
      producerContract: {
        available: true,
        missingFields: [],
      },
    });
    expect(JSON.stringify(result.meta.primeInjectionPackage)).not.toContain('/Users/example');
    expect(result.meta.projectScopeIdentity).toMatchObject({
      available: true,
      mode: 'project-scope',
      projectScopeId: 'project-scope-workspace',
      source: 'resident-service-scope',
    });
    expect(result.meta.residentVector).toMatchObject({ available: true });
  });

  it('preserves resident region selectedRecipes in compact prime injection metadata', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (fetchInputUrl(input).pathname === '/api/v1/daemon/health') {
        return jsonResponse(residentHealthPayload());
      }
      return jsonResponse({
        success: true,
        data: {
          items: [{ id: 'recipe-region-selected', title: 'Region selected Recipe', score: 0.94 }],
          searchMeta: {
            actualMode: 'semantic',
            primeInjectionPackage: {
              ...primeInjectionPackageFixture(),
              injection: {
                degradedReasons: ['knowledge:stale', 'document:partial'],
                omittedCount: 4,
                selectedCount: 6,
                status: 'degraded',
              },
              residentRegionRetrieval: {
                attempted: true,
                degradedReasons: ['knowledge:stale', 'document:partial'],
                metadataOnlyFallback: { attempted: false, used: false },
                queryCount: 6,
                regionHitCount: 18,
                route: 'resident-vector-recipe-semantic-region',
                selectedRecipes: [
                  {
                    itemId: 'recipe-region-selected',
                    matchedRegionClasses: ['applicability', 'architectureConvention'],
                    matchedRegions: [
                      {
                        recipeId: 'recipe-region-selected',
                        regionClass: 'applicability',
                        score: 0.94,
                        snippet: 'Use this Recipe for resident vector selected material.',
                        sourceRefs: ['/Users/example/private-project/src/service.ts:42'],
                        sourceRefsBridge: 'active',
                        vectorId: 'recipe_region_recipe-region-selected_applicability_hash',
                      },
                    ],
                    score: 0.94,
                    sourceRefs: ['/Users/example/private-project/src/service.ts:42'],
                    title: 'Region selected Recipe',
                    trigger: '@region-selected',
                  },
                ],
                used: true,
                vectorAvailable: true,
                wholeEntryOnlyRejectedCount: 0,
              },
              selectedKnowledge: [],
            },
            requestedMode: 'semantic',
            residentVector: { available: true, reason: null },
            semanticUsed: true,
            vectorUsed: true,
          },
        },
      });
    }) as unknown as typeof fetch;
    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const result = await client.search({
      query: 'resident vector selected material',
      mode: 'auto',
    });

    expect(result.meta.primeInjectionPackage).toMatchObject({
      injection: {
        selectedCount: 6,
        status: 'degraded',
      },
      residentRegionRetrieval: {
        route: 'resident-vector-recipe-semantic-region',
        selectedRecipes: [
          expect.objectContaining({
            matchedRegionClasses: ['applicability', 'architectureConvention'],
            matchedRegions: [
              expect.objectContaining({
                regionClass: 'applicability',
                sourceRefs: ['[absolute-path]/service.ts:42'],
              }),
            ],
            itemId: 'recipe-region-selected',
            sourceRefs: ['[absolute-path]/service.ts:42'],
          }),
        ],
        used: true,
        vectorAvailable: true,
      },
      selectedKnowledge: [],
    });
    expect(JSON.stringify(result.meta.primeInjectionPackage)).not.toContain('/Users/example');
  });

  it('replays accepted D3 provider fixture ids through Plugin resident client routes', async () => {
    const replayedFixtureIds: string[] = [];
    const replay = (fixtureId: string, payload: unknown, status = 200) => {
      replayedFixtureIds.push(fixtureId);
      return jsonResponse(payload, status);
    };
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = fetchInputUrl(input);
        const method = init?.method ?? 'GET';

        if (url.pathname === '/api/v1/daemon/health') {
          return replay('runtime-health.ready', residentHealthPayload({ projectScope: null }));
        }
        if (url.pathname === '/api/v1/project-scope/resolve-folder') {
          return replay('project-scope.success', {
            success: true,
            data: { capability: { available: true }, summary: projectScopeSummary() },
          });
        }
        if (url.pathname === '/api/v1/search') {
          return replay('knowledge.success', {
            success: true,
            data: {
              items: [{ id: 'knowledge-alpha', title: 'Boundary rule' }],
              searchMeta: {
                actualMode: 'semantic',
                requestedMode: 'semantic',
                residentVector: { available: true, reason: null },
                semanticUsed: true,
                vectorUsed: true,
              },
              total: 1,
            },
          });
        }
        if (url.pathname === '/api/v1/jobs' && method === 'GET') {
          return replay('jobs.queued', {
            success: true,
            data: { jobs: [{ id: 'job-bootstrap-1', kind: 'bootstrap', status: 'queued' }] },
          });
        }
        return jsonResponse(
          { success: false, message: `${method} ${url.pathname} unexpected` },
          404
        );
      }
    ) as unknown as typeof fetch;
    const client = new AlembicResidentServiceClient({
      fetchImpl,
      projectRoot: '/tmp/project',
      readState: () => daemonState(),
    });

    const scope = await client.resolveProjectScopeIdentity();
    const search = await client.search({ query: 'Boundary rule', mode: 'auto' });
    const job = await client.readJob({ kind: 'bootstrap' });

    expect(scope).toMatchObject({
      available: true,
      projectScopeId: 'project-scope-workspace',
      source: 'resident-project-scope-endpoint',
    });
    expect(search.items).toEqual([{ id: 'knowledge-alpha', title: 'Boundary rule' }]);
    expect(job.ok).toBe(true);

    const acceptedFixtureIds = new Set(
      PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY.flatMap((entry) => entry.fixtureIds)
    );
    expect(replayedFixtureIds).toEqual(
      expect.arrayContaining([
        'runtime-health.ready',
        'project-scope.success',
        'knowledge.success',
        'jobs.queued',
      ])
    );
    for (const fixtureId of replayedFixtureIds) {
      expect(acceptedFixtureIds.has(fixtureId), `${fixtureId} is accepted D3 evidence`).toBe(true);
    }
  });

  it('ignores resident search results from a different workspace than the requested projectRoot', async () => {
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
        if (url.pathname === '/api/v1/search') {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                items: [
                  { id: 'resident-bilidili', title: 'BiliDili resident recipe', score: 0.99 },
                ],
                searchMeta: {
                  actualMode: 'semantic',
                  requestedMode: 'semantic',
                  semanticUsed: true,
                  vectorUsed: true,
                  workspace: {
                    projectRoot: '/tmp/bilidili',
                    projectScopeId: 'project-scope-bilidili',
                  },
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
      projectRoot: '/tmp/plugin-host',
      readState: () => daemonState(),
    });

    const result = await client.search({
      query: 'AlembicWorkspace prime',
      mode: 'auto',
      projectRoot: '/tmp/alembic-workspace',
    });

    const searchRequest = requests.find((request) => request.url.pathname === '/api/v1/search');
    expect(searchRequest?.init?.method).toBe('POST');
    expect(JSON.parse(String(searchRequest?.init?.body))).toMatchObject({
      mode: 'semantic',
      projectRoot: '/tmp/alembic-workspace',
      query: 'AlembicWorkspace prime',
    });
    expect(result.items).toEqual([]);
    expect(result.meta.available).toBe(false);
    expect(result.meta.reason).toContain('different workspace');
    expect(result.meta.reason).toContain('/tmp/bilidili');
    expect(result.meta.projectScopeIdentity).toMatchObject({
      mode: 'project-scope',
      projectScopeId: 'project-scope-workspace',
    });
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
      kind: 'fact',
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
      type: 'fact',
    });
    expect(body).not.toHaveProperty('kind');
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

  it('keeps resident vector telemetry when indexSize is zero but usable vector stats are present', async () => {
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
            searchMeta: {
              semanticUsed: true,
              vectorUsed: true,
              residentVector: {
                available: true,
                reason: null,
                stats: {
                  count: 140,
                  dimension: 1024,
                  embedProviderAvailable: true,
                  hasIndex: true,
                  indexSize: 0,
                },
              },
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

    const result = await client.search({ query: 'semantic output quality', mode: 'semantic' });

    expect(result.meta.residentVector).toMatchObject({
      available: true,
      reason: null,
      stats: {
        count: 140,
        dimension: 1024,
        embedProviderAvailable: true,
        hasIndex: true,
        indexSize: 0,
      },
    });
    expect(result.meta.semanticUsed).toBe(true);
    expect(result.meta.vectorUsed).toBe(true);
  });

  it('downgrades resident vector telemetry when the daemon explicitly reports an empty index', async () => {
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
            searchMeta: {
              semanticUsed: true,
              vectorUsed: true,
              residentVector: {
                available: true,
                reason: 'empty-vector-index',
                stats: {
                  count: 140,
                  dimension: 1024,
                  embedProviderAvailable: true,
                  hasIndex: true,
                  indexSize: 0,
                },
              },
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

    const result = await client.search({ query: 'semantic output quality', mode: 'semantic' });

    expect(result.meta.residentVector).toMatchObject({
      available: false,
      reason: 'empty-vector-index',
      stats: {
        indexSize: 0,
      },
    });
    expect(result.meta.semanticUsed).toBe(false);
    expect(result.meta.vectorUsed).toBe(false);
  });

  it('downgrades resident vector telemetry when the daemon reports sparse-only search', async () => {
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
            items: [{ id: 'resident-1', title: 'Resident sparse recipe', score: 0.92 }],
            searchMeta: {
              semanticUsed: true,
              vectorUsed: true,
              residentVector: {
                available: true,
                reason: null,
                stats: {
                  count: 140,
                  dimension: 1024,
                  embedProviderAvailable: true,
                  hasIndex: true,
                  indexSize: 20,
                  sparseOnly: true,
                },
              },
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

    const result = await client.search({ query: 'semantic output quality', mode: 'semantic' });

    expect(result.meta.residentVector).toMatchObject({
      available: false,
      reason: 'sparse-only',
      stats: {
        sparseOnly: true,
      },
    });
    expect(result.meta.semanticUsed).toBe(false);
    expect(result.meta.vectorUsed).toBe(false);
  });

  it('sends explicit search filters in the resident POST body without host context', async () => {
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
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [],
              searchMeta: {
                actualMode: 'semantic',
                requestedMode: 'semantic',
                semanticUsed: false,
                vectorUsed: false,
                residentVector: { available: false, reason: 'empty-vector-index' },
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

    await client.search({
      category: 'mcp',
      dimensionId: 'asq-r4',
      kind: 'pattern',
      knowledgeType: 'semantic-quality',
      language: 'typescript',
      limit: 4,
      mode: 'auto',
      query: 'resident semantic vector truth',
      rank: false,
      scope: 'workspace',
      tags: ['search', 'resident'],
    });

    const searchRequest = requests.find((request) => request.url.pathname === '/api/v1/search');
    expect(searchRequest?.method).toBe('POST');
    expect(searchRequest?.url.search).toBe('');
    expect(searchRequest?.body).toMatchObject({
      category: 'mcp',
      dimensionId: 'asq-r4',
      knowledgeType: 'semantic-quality',
      language: 'typescript',
      limit: 4,
      mode: 'semantic',
      query: 'resident semantic vector truth',
      q: 'resident semantic vector truth',
      rank: false,
      scope: 'workspace',
      tags: ['search', 'resident'],
      type: 'pattern',
    });
    expect(JSON.stringify(searchRequest?.body)).not.toContain('hostDeclaredIntent');
    expect(JSON.stringify(searchRequest?.body)).not.toContain('sourceRefs');
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
