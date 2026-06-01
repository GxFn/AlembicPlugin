import { describe, expect, test, vi } from 'vitest';
import { taskHandler } from '../../lib/codex/mcp/handlers/task.js';
import type { McpContext } from '../../lib/codex/mcp/handlers/types.js';
import { createIdleIntent } from '../../lib/codex/mcp/handlers/types.js';
import type { ExtractedIntent } from '../../lib/service/task/IntentExtractor.js';
import type { PrimeSearchResult } from '../../lib/service/task/PrimeSearchPipeline.js';

interface PrimeMaterial {
  status: 'delivered' | 'empty' | 'degraded';
  receiptId: string;
  intent: {
    userQuery: string;
    activeFile?: string;
    language?: string;
    module?: string;
    scenario: string;
    queries: string[];
    hostIntentFrame?: {
      source: 'deterministic' | 'host-declared' | 'mixed';
      confidence: number;
      degraded: boolean;
      degradedReasons: string[];
      hostDeclaredIntent?: Record<string, unknown>;
      hostTurnMeta?: Record<string, unknown>;
    };
  };
  acceptedKnowledge: Array<{
    id: string;
    kind: string;
    title: string;
    trigger: string;
    summary: string;
    score: number;
    evidenceRefs: Array<{ path: string; line: number | null }>;
  }>;
  acceptedGuards: Array<{
    id: string;
    title: string;
    trigger: string;
    score: number;
    evidenceRefs: Array<{ path: string; line: number | null }>;
  }>;
  shoutInstruction: string;
  hostResponse: {
    action: string;
    receiptId: string;
    status: 'delivered' | 'empty' | 'degraded';
    timing: 'immediate_after_prime';
    required: boolean;
    requiredBeforeNextAction: boolean;
    visibility: 'developer_visible';
    reason: string;
  };
  nextActions: Array<{ tool: string; args: Record<string, unknown>; required: boolean }>;
  intentEvidence?: Record<string, unknown>;
  primeInjectionPackage?: Record<string, unknown>;
  intentEpisode?: {
    available: boolean;
    current: {
      episodeId: string;
      query?: string;
      sessionKey: string | null;
      sourceRefs: string[];
      status: string;
    } | null;
    degraded: boolean;
    latest: {
      episodeId: string;
      query?: string;
      sessionKey: string | null;
      sourceRefs: string[];
      status: string;
    } | null;
    recent: Array<{
      episodeId: string;
      query?: string;
      sessionKey: string | null;
      sourceRefs: string[];
      status: string;
    }>;
    requestFields: string[];
    sessionSource: string;
  };
}

interface PrimeEnvelope {
  success: boolean;
  message: string;
  data: {
    knowledge: {
      relatedKnowledge: PrimeSearchResult['relatedKnowledge'];
      guardRules: PrimeSearchResult['guardRules'];
    } | null;
    primeKnowledgeMaterial: PrimeMaterial;
    searchMeta: PrimeSearchResult['searchMeta'] | null;
  };
}

function makeContext(
  search: (
    intent: ExtractedIntent,
    options?: { hostIntentFrame?: unknown }
  ) => Promise<PrimeSearchResult | null>,
  services: Record<string, unknown> = {}
): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return { search };
        }
        if (Object.hasOwn(services, name)) {
          return services[name];
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    },
    session: {
      id: 'session-1',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

function makeContextWithoutPipeline(): McpContext {
  return {
    container: {
      get: vi.fn(() => null),
    },
    session: {
      id: 'session-1',
      startedAt: 1,
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: 1,
      intent: createIdleIntent(),
    },
  };
}

function intentEvidenceSummary() {
  return {
    degraded: false,
    degradedReasons: ['vector:evidence-observe-only'],
    relationEvidence: [
      {
        direction: 'outgoing',
        itemId: 'recipe-episode',
        relatedId: 'recipe-related',
        relation: 'related',
        source: 'knowledgeGraphService',
      },
    ],
    scoreBreakdown: [
      {
        finalScore: 0.91,
        itemId: 'recipe-episode',
        rank: 1,
        semanticScore: 0.81,
        signals: ['final-score', 'semantic-score'],
        vectorScore: null,
      },
    ],
    semanticAnchors: [
      {
        kind: 'query',
        source: 'intentSearchPlan.executableQuery',
        value: 'Create episode handoff',
        weight: 1,
      },
    ],
    topAnchorMatches: [
      {
        anchor: 'episode handoff',
        itemId: 'recipe-episode',
        matchType: 'text',
        rank: 1,
        score: 0.91,
        sourceRefs: ['knowledge:recipe-episode'],
      },
    ],
    version: 1,
  };
}

function primeInjectionPackageSummary() {
  return {
    injection: {
      degradedReasons: [],
      omittedCount: 0,
      selectedCount: 1,
      status: 'ready',
    },
    intent: {
      applied: true,
      confidence: 0.86,
      degraded: false,
      degradedReasons: [],
      executableQuery: 'Create episode handoff',
      requestedMode: 'semantic',
      sourceRefs: ['host:intent'],
      whySelected: ['intent-search-plan'],
    },
    omitted: [],
    relations: {
      evidence: [
        {
          direction: 'outgoing',
          itemId: 'recipe-episode',
          relatedId: 'recipe-related',
          relation: 'related',
          source: 'knowledgeGraphService',
        },
      ],
      omitted: [],
    },
    search: {
      actualMode: 'semantic',
      filteredCount: 1,
      query: 'Create episode handoff',
      queries: ['episode handoff'],
      requestedMode: 'semantic',
      resultCount: 1,
    },
    selectedKnowledge: [
      {
        evidenceRefs: ['scoreBreakdown:recipe-episode'],
        injectionStatus: 'selected',
        itemId: 'recipe-episode',
        kind: 'pattern',
        rank: 1,
        score: 0.91,
        sourceRefs: ['lib/codex/mcp/handlers/task.ts:42'],
        title: 'Episode handoff',
        trigger: '@episode-handoff',
        whySelected: ['semantic-score'],
      },
    ],
    trace: {
      evidenceRefs: ['scoreBreakdown:recipe-episode'],
      sourcePath: ['searchMeta.primeInjectionPackage'],
      sourceRefs: ['lib/codex/mcp/handlers/task.ts:42'],
      sources: ['intentSearchPlan', 'intentEvidence'],
    },
    vector: {
      omitted: [],
      scoreBreakdown: [
        {
          finalScore: 0.91,
          itemId: 'recipe-episode',
          rank: 1,
          semanticScore: 0.81,
          signals: ['semantic-score'],
          vectorScore: null,
        },
      ],
      semanticAnchors: [],
      semanticUsed: true,
      topAnchorMatches: [],
      vectorAvailable: true,
      vectorUsed: true,
    },
    version: 1,
  };
}

describe('alembic_task prime knowledge material', () => {
  test('returns delivered primeKnowledgeMaterial with recipe, guard, and evidence refs', async () => {
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-1',
          title: 'Use codex plugin boundaries',
          trigger: '@codex-plugin-boundary',
          kind: 'pattern',
          language: 'typescript',
          score: 0.91,
          description: 'Keep Codex MCP wiring in the plugin layer.',
          actionHint: 'Use plugin adapter APIs instead of reintroducing agent runtime.',
          knowledgeType: 'code-standard',
          sourceRefs: ['lib/codex/mcp/handlers/task.ts:42', 'lib/codex/status/StatusService.ts'],
        },
      ],
      guardRules: [
        {
          id: 'guard-1',
          title: 'Do not restore agent runtime',
          trigger: '@no-agent-runtime',
          kind: 'rule',
          language: 'typescript',
          score: 0.84,
          description: 'Plugin must not own agent runtime.',
          actionHint: 'Keep agent runtime out of AlembicPlugin.',
          sourceRefs: ['AGENTS.md:22'],
        },
      ],
      searchMeta: {
        queries: ['prime knowledge shout'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 2,
        filteredCount: 2,
        residentSearch: {
          attempted: true,
          available: true,
          route: 'alembic-resident-service',
          semanticUsed: true,
          vectorUsed: true,
          residentVector: { available: true },
        },
      },
    };
    const ctx = makeContext(async () => searchResult);
    const result = (await taskHandler(ctx, {
      operation: 'prime',
      userQuery: 'Add prime knowledge shout',
      activeFile: 'lib/codex/mcp/handlers/task.ts',
      language: 'typescript',
    })) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge?.relatedKnowledge).toEqual(searchResult.relatedKnowledge);
    expect(result.data.searchMeta).toEqual(searchResult.searchMeta);
    expect(ctx.session?.intent.searchMeta?.residentSearch).toMatchObject({
      route: 'alembic-resident-service',
      vectorUsed: true,
    });
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'delivered',
      intent: {
        userQuery: 'Add prime knowledge shout',
        hostIntentFrame: {
          source: 'deterministic',
          confidence: 1,
          degraded: false,
          degradedReasons: [],
        },
      },
      acceptedKnowledge: [
        {
          id: 'recipe-1',
          kind: 'pattern',
          title: 'Use codex plugin boundaries',
          trigger: '@codex-plugin-boundary',
          summary: 'Keep Codex MCP wiring in the plugin layer.',
          score: 0.91,
          evidenceRefs: [
            { path: 'lib/codex/mcp/handlers/task.ts', line: 42 },
            { path: 'lib/codex/status/StatusService.ts', line: null },
          ],
        },
      ],
      acceptedGuards: [
        {
          id: 'guard-1',
          title: 'Do not restore agent runtime',
          trigger: '@no-agent-runtime',
          score: 0.84,
          evidenceRefs: [{ path: 'AGENTS.md', line: 22 }],
        },
      ],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Immediately after this prime tool result'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'short, active knowledge receipt'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Use Codex/first-person as the speaker'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'what I accepted or what Codex received'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'accepted Recipe and Guard constraints'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'do not list evidenceRefs paths or line numbers by default'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Keep evidenceRefs for your later code reading'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).not.toContain(
      'Cite evidenceRefs as path:line'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).not.toContain(
      'line number is missing'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'delivered',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain('As Codex');
    expect(result.data.primeKnowledgeMaterial.hostResponse.reason).toContain(
      'do not make Alembic prime'
    );
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Codex must immediately shout');
    expect(result.message).toContain('short knowledge receipt');
    expect(result.message).toContain('Speak as Codex or I');
    expect(result.message).toContain('not as Alembic prime');
    expect(result.message).toContain('keep evidenceRefs in the payload');
    expect(result.message).not.toContain('📍');
    expect(result.message).not.toContain('lib/codex/mcp/handlers/task.ts:42');
    expect(result.message).not.toContain('Alembic prime has received');
    expect(result.message).not.toContain('Alembic prime received');
    expect(result.message).toContain('before any further tool call');
  });

  test('returns empty material when prime finds no matching recipes or guards', async () => {
    const result = (await taskHandler(
      makeContext(async () => null),
      {
        operation: 'prime',
        userQuery: 'Quick question',
      }
    )) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge).toBeNull();
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'empty',
      acceptedKnowledge: [],
      acceptedGuards: [],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'I did not receive matching Recipe or Guard knowledge'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('shout a clear receipt');
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'empty',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(result.message).toContain('No matching recipes found.');
    expect(result.message).toContain('it did not receive usable project knowledge');
    expect(result.message).toContain('Do not make Alembic prime');
  });

  test('uses host-declared intent as prime query and redacts host turn metadata', async () => {
    let searchedIntent: ExtractedIntent | null = null;
    let searchedOptions: { hostIntentFrame?: unknown } | null = null;
    const ctx = makeContext(async (intent, options) => {
      searchedIntent = intent;
      searchedOptions = options ?? null;
      return null;
    });
    ctx.hostTurnMeta = {
      threadId: 'raw-request-thread-id',
      conversationId: 'raw-request-conversation-id',
      turnId: 'turn-from-request',
      cwd: '/Users/example/private-project',
      surface: 'codex',
    };

    const result = (await taskHandler(ctx, {
      operation: 'prime',
      hostDeclaredIntent: {
        summary: 'Route host intent into the prime flow',
        confidence: 0.73,
        labels: ['intent', 'prime'],
        source: 'codex-host',
        ignoredPayload: 'not retained',
      },
      hostTurnMeta: {
        threadId: 'raw-explicit-thread-id',
        messageId: 'message-1',
        activeFile: '/Users/example/private-project/lib/file.ts',
      },
    })) as PrimeEnvelope;

    expect(searchedIntent?.raw.userQuery).toBe('Route host intent into the prime flow');
    expect(searchedOptions?.hostIntentFrame).toMatchObject({
      source: 'host-declared',
      confidence: 0.73,
    });
    expect(result.data.primeKnowledgeMaterial.intent.userQuery).toBe(
      'Route host intent into the prime flow'
    );
    expect(result.data.primeKnowledgeMaterial.intent.hostIntentFrame).toMatchObject({
      source: 'host-declared',
      confidence: 0.73,
      degraded: false,
      hostDeclaredIntent: {
        summary: 'Route host intent into the prime flow',
        labels: ['intent', 'prime'],
        source: 'codex-host',
      },
      recognizedIntentDraft: {
        action: 'search',
        confidence: 0.73,
        constraints: expect.arrayContaining(['intent', 'prime']),
        degraded: false,
        evidenceSpans: expect.arrayContaining([
          expect.objectContaining({ field: 'query', source: 'hostDeclaredIntent' }),
        ]),
        query: 'Route host intent into the prime flow',
        source: 'host-declared',
        status: 'recognized',
      },
      hostTurnMeta: {
        turnId: 'turn-from-request',
        messageId: 'message-1',
        surface: 'codex',
        threadIdHash: expect.any(String),
        conversationIdHash: expect.any(String),
        redactions: expect.arrayContaining(['threadId', 'conversationId', 'cwd', 'activeFile']),
      },
    });
    const serializedFrame = JSON.stringify(
      result.data.primeKnowledgeMaterial.intent.hostIntentFrame
    );
    expect(serializedFrame).not.toContain('raw-request-thread-id');
    expect(serializedFrame).not.toContain('raw-explicit-thread-id');
    expect(serializedFrame).not.toContain('/Users/example/private-project');
    expect(serializedFrame).not.toContain('ignoredPayload');
    expect(ctx.session?.intent.primeQuery).toBe('Route host intent into the prime flow');
    expect(ctx.session?.intent.hostIntentFrame?.source).toBe('host-declared');
  });

  test('hands off prime intent episodes to resident service with redacted host identifiers', async () => {
    const searchResult: PrimeSearchResult = {
      relatedKnowledge: [
        {
          id: 'recipe-episode',
          title: 'Episode handoff',
          trigger: '@episode-handoff',
          kind: 'pattern',
          language: 'typescript',
          score: 0.91,
          description: 'Persist prime intent episodes in Alembic resident service.',
          actionHint: 'Send redacted host intent facts and search meta to the resident API.',
          knowledgeType: 'code-standard',
          sourceRefs: ['lib/codex/mcp/handlers/task.ts:42'],
        },
      ],
      guardRules: [],
      searchMeta: {
        queries: ['episode handoff'],
        scenario: 'implementation',
        language: 'typescript',
        module: 'mcp',
        resultCount: 1,
        filteredCount: 1,
        intentEvidence: intentEvidenceSummary(),
        primeInjectionPackage: primeInjectionPackageSummary(),
        residentSearch: {
          attempted: true,
          available: true,
          route: 'alembic-resident-service',
          searchMeta: {
            hostIntentApplied: true,
            hostIntentConfidence: 0.86,
            hostIntentDegraded: false,
            hostIntentSourceRefs: ['host:intent'],
            intentEvidence: intentEvidenceSummary(),
            primeInjectionPackage: primeInjectionPackageSummary(),
          },
        },
      },
    };
    const residentStatus = { owner: 'alembic', route: 'local-alembic-daemon' };
    const residentServiceClient = {
      latestIntentEpisode: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          episode: {
            episodeId: 'episode-prev',
            query: 'previous query',
            sessionKey: 'sha256:previous',
            sourceRefs: ['host:previous'],
            status: 'completed',
          },
        },
      })),
      recentIntentEpisodes: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          count: 1,
          episode: null,
          episodes: [
            {
              episodeId: 'episode-prev',
              query: 'previous query',
              sessionKey: 'sha256:previous',
              sourceRefs: ['host:previous'],
              status: 'completed',
            },
          ],
        },
      })),
      startIntentEpisode: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          episode: {
            episodeId: 'episode-current',
            query: 'Create episode handoff',
            sessionKey: 'sha256:current',
            sourceRefs: ['host:intent', 'knowledge:recipe-episode'],
            status: 'active',
          },
        },
      })),
      updateIntentEpisodeOutcome: vi.fn(async () => ({
        ok: true,
        status: residentStatus,
        value: {
          capability: null,
          episode: {
            episodeId: 'episode-current',
            sessionKey: 'sha256:current',
            status: 'completed',
          },
        },
      })),
    };
    const ctx = makeContext(async () => searchResult, { residentServiceClient });

    const primeResult = (await taskHandler(ctx, {
      operation: 'prime',
      activeFile: '/Users/example/private-project/lib/task.ts',
      hostDeclaredIntent: {
        confidence: 0.86,
        sourceRefs: ['host:intent'],
        summary: 'Create episode handoff',
      },
      hostTurnMeta: {
        activeFile: '/Users/example/private-project/lib/task.ts',
        threadId: 'raw-thread-id',
        turnId: 'turn-1',
      },
      language: 'typescript',
    })) as PrimeEnvelope;

    expect(residentServiceClient.latestIntentEpisode).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(/^thread:/),
    });
    expect(residentServiceClient.recentIntentEpisodes).toHaveBeenCalledWith({
      limit: 3,
      sessionId: expect.stringMatching(/^thread:/),
    });
    expect(residentServiceClient.startIntentEpisode).toHaveBeenCalledTimes(1);
    const startRequest = residentServiceClient.startIntentEpisode.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(startRequest).toMatchObject({
      activeFile: '/Users/example/private-project/lib/task.ts',
      language: 'typescript',
      query: 'Create episode handoff',
      scenario: 'generate',
      sessionId: expect.stringMatching(/^thread:/),
      sourceRefs: ['host:intent', 'knowledge:recipe-episode'],
      turnId: 'turn-1',
    });
    expect(startRequest.sessionId).not.toBe('raw-thread-id');
    expect(JSON.stringify(startRequest.hostIntent)).not.toContain('raw-thread-id');
    expect(JSON.stringify(startRequest.hostIntent)).not.toContain('/Users/example/private-project');
    expect(startRequest.searchMeta).toMatchObject({
      filteredCount: 1,
      hostIntentApplied: true,
      hostIntentConfidence: 0.86,
      hostIntentDegraded: false,
      hostIntentSourceRefs: ['host:intent'],
      intentEvidence: {
        semanticAnchors: [
          expect.objectContaining({
            value: 'Create episode handoff',
          }),
        ],
        scoreBreakdown: [
          expect.objectContaining({
            itemId: 'recipe-episode',
            semanticScore: 0.81,
          }),
        ],
      },
      queries: ['episode handoff'],
      primeInjectionPackage: {
        injection: {
          selectedCount: 1,
          status: 'ready',
        },
        selectedKnowledge: [
          expect.objectContaining({
            injectionStatus: 'selected',
            itemId: 'recipe-episode',
          }),
        ],
      },
      resultCount: 1,
    });
    expect(ctx.session?.intent.searchMeta?.intentEvidence).toMatchObject({
      topAnchorMatches: [
        expect.objectContaining({
          itemId: 'recipe-episode',
        }),
      ],
    });
    expect(ctx.session?.intent.searchMeta?.primeInjectionPackage).toMatchObject({
      trace: {
        evidenceRefs: ['scoreBreakdown:recipe-episode'],
      },
    });
    expect(primeResult.data.primeKnowledgeMaterial.intent.activeFile).toBe(
      '[absolute-path]/task.ts'
    );
    expect(primeResult.data.primeKnowledgeMaterial.intentEvidence).toMatchObject({
      relationEvidence: [
        expect.objectContaining({
          relatedId: 'recipe-related',
        }),
      ],
      semanticAnchors: [
        expect.objectContaining({
          source: 'intentSearchPlan.executableQuery',
        }),
      ],
    });
    expect(primeResult.data.primeKnowledgeMaterial.primeInjectionPackage).toMatchObject({
      injection: {
        status: 'ready',
      },
      trace: {
        sourceRefs: ['lib/codex/mcp/handlers/task.ts:42'],
      },
    });
    expect(primeResult.data.primeKnowledgeMaterial.intentEpisode).toMatchObject({
      available: true,
      current: {
        episodeId: 'episode-current',
        sessionKey: 'sha256:current',
        status: 'active',
      },
      latest: {
        episodeId: 'episode-prev',
        sessionKey: 'sha256:previous',
        status: 'completed',
      },
      recent: [
        {
          episodeId: 'episode-prev',
          sessionKey: 'sha256:previous',
          status: 'completed',
        },
      ],
      sessionSource: 'host-thread-hash',
    });
    const visibleEpisodePayload = JSON.stringify(primeResult.data.primeKnowledgeMaterial);
    expect(visibleEpisodePayload).not.toContain('raw-thread-id');
    expect(visibleEpisodePayload).not.toContain('/Users/example/private-project');
    expect(ctx.session?.intent.intentEpisode).toMatchObject({
      episodeId: 'episode-current',
      sessionKey: 'sha256:current',
      startAvailable: true,
    });

    const createResult = (await taskHandler(ctx, {
      operation: 'create',
      title: 'Episode task',
    })) as { data: { id: string } };
    await taskHandler(ctx, {
      operation: 'close',
      id: createResult.data.id,
      reason: 'done',
    });
    expect(residentServiceClient.updateIntentEpisodeOutcome).toHaveBeenCalledWith(
      'episode-current',
      expect.objectContaining({
        reason: 'done',
        searchMeta: expect.objectContaining({
          primeInjectionPackage: expect.objectContaining({
            injection: expect.objectContaining({
              status: 'ready',
            }),
          }),
        }),
        status: 'completed',
        taskId: createResult.data.id,
      })
    );
  });

  test('returns degraded material when the prime search pipeline is unavailable', async () => {
    const result = (await taskHandler(makeContextWithoutPipeline(), {
      operation: 'prime',
      userQuery: 'Implement something with project knowledge',
    })) as PrimeEnvelope;

    expect(result.success).toBe(true);
    expect(result.data.knowledge).toBeNull();
    expect(result.data.primeKnowledgeMaterial).toMatchObject({
      status: 'degraded',
      acceptedKnowledge: [],
      acceptedGuards: [],
    });
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'I did not receive usable project knowledge because prime degraded'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain('shout a clear receipt');
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'Do not make "Alembic prime"'
    );
    expect(result.data.primeKnowledgeMaterial.shoutInstruction).toContain(
      'before any further tool call'
    );
    expect(result.data.primeKnowledgeMaterial.hostResponse).toMatchObject({
      action: 'shout_prime_knowledge_receipt',
      status: 'degraded',
      timing: 'immediate_after_prime',
      required: true,
      requiredBeforeNextAction: true,
      visibility: 'developer_visible',
    });
    expect(
      result.data.primeKnowledgeMaterial.nextActions.map((action) => action.tool)
    ).not.toContain('codex_host_response');
    expect(result.message).toContain('Prime knowledge search degraded');
  });
});
