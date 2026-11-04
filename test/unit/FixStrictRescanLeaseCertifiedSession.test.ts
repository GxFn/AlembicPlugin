import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CANDIDATES_DIR } from '@alembic/core/config';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import {
  _resetGenerateSessionManagersForTesting,
  getOrCreateSessionManager,
} from '@alembic/core/host-agent-workflows';
import { KnowledgeEntry } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { createAlembicRepositories } from '@alembic/core/repositories';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
  pathGuard,
} from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { routePlanTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import {
  type McpContext,
  requireRequestProjectRuntime,
} from '../../lib/host-runtime/mcp/handlers/types.js';
import { readPluginCertifiedCarrierFromProjectContext } from '../../lib/project-facts/PluginCertifiedProjectFactsRuntime.js';
import { runHostAgentKnowledgeRescanWorkflow } from '../../lib/recipe-pipeline/generate/knowledge-rescan.js';
import {
  createProjectContextHostAgentSession,
  releaseEmptyHostAgentSessionLeaseById,
  releaseEmptyHostAgentSessionLeaseForProject,
} from '../../lib/recipe-pipeline/generate/project-context-analysis.js';
import { resolveScopeAwareWorkspace } from '../../lib/shared/project-scope-runtime.js';

// 回归：严格（MCP loaded）模式下 alembic_plan draft 创建的 HostAgent session 携带 Plugin
// certified carrier，但没有任何维度/提交；rescan 入口的 releaseEmpty* 不得把它当空租约释放。
// 同时严格前置条件（carrier 缺失）必须在破坏性清理（rescanClean）之前失败。

const tempRoots: string[] = [];
const databaseRuntimes: AlembicDatabaseRuntime[] = [];
const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of databaseRuntimes.splice(0)) {
    runtime.close();
  }
  _resetGenerateSessionManagersForTesting();
  pathGuard._reset();
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('releaseEmpty* never releases a Plugin-certified session', () => {
  test.each([
    { allowFreshEmpty: true, stale: false },
    { allowFreshEmpty: false, stale: true },
  ])('ForProject keeps a certified carrier session (%o)', ({ allowFreshEmpty, stale }) => {
    const fixture = createFileBackedCertifiedSessionFixture({ stale });
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

    const release = releaseEmptyHostAgentSessionLeaseForProject({
      allowFreshEmpty,
      container: fixture.container,
      logger: { info: (msg, meta) => logs.push({ msg, meta }) },
      projectRoot: fixture.projectRoot,
      reason: 'rescan-route-replaces-empty-bootstrap-session',
      source: 'alembic_rescan',
    });

    expect(release.released).toBe(false);
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual(['bs-certified']);
    expect(logs.map((entry) => entry.msg).join('\n')).toMatch(/certified/i);
    const session = getOrCreateSessionManager(fixture.container).getAnySession(undefined, {
      projectRoot: fixture.projectRoot,
    });
    expect(
      readPluginCertifiedCarrierFromProjectContext(session?.toSnapshot().projectContext)
    ).not.toBeNull();
  });

  test('ById keeps a certified carrier session', () => {
    const fixture = createFileBackedCertifiedSessionFixture({ stale: false });
    const logs: string[] = [];

    const release = releaseEmptyHostAgentSessionLeaseById({
      container: fixture.container,
      logger: { info: (msg) => logs.push(msg) },
      projectRoot: fixture.projectRoot,
      reason: 'deepMining-converged',
      sessionId: 'bs-certified',
      source: 'alembic_rescan',
    });

    expect(release.released).toBe(false);
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual(['bs-certified']);
    expect(logs.join('\n')).toMatch(/certified/i);
  });

  test('createProjectContextHostAgentSession reuses the certified session instead of replacing it', () => {
    const fixture = createFileBackedCertifiedSessionFixture({ stale: true });

    const session = createProjectContextHostAgentSession({
      container: fixture.container,
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      fileCount: 1,
      moduleCount: 1,
      primaryLang: 'typescript',
      producerCapability: 'incremental',
      projectRoot: fixture.projectRoot,
    });

    expect(session.id).toBe('bs-certified');
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual(['bs-certified']);
  });
});

describe('releaseEmpty* still releases an empty session whose carrier fails validation', () => {
  // 回归：carrier 校验失败（例如插件升级后残留的旧格式 preparationId）的空 session 不是有效的
  // 认证 session；若保留，Plan/rescan/cold start 读取同一 carrier 都会抛错且无法恢复，直到 TTL 过期。
  // 所以只保护有效 carrier，无效 carrier 的空 session 照旧释放并留下 warn 诊断。
  const invalidCarrier = () => ({
    ...minimalCertifiedCarrier(),
    preparationId: 'prep-v2:legacy-format',
  });

  test('ForProject (rescan entry, allowFreshEmpty) releases it and warns', () => {
    const fixture = createFileBackedCertifiedSessionFixture({
      carrier: invalidCarrier(),
      sessionId: 'bs-invalid',
      stale: false,
    });
    const warn = vi.spyOn(Logger.getInstance(), 'warn');

    const release = releaseEmptyHostAgentSessionLeaseForProject({
      allowFreshEmpty: true,
      container: fixture.container,
      projectRoot: fixture.projectRoot,
      reason: 'rescan-route-replaces-empty-bootstrap-session',
      source: 'alembic_rescan',
    });

    expect(release).toMatchObject({ released: true, sessionId: 'bs-invalid' });
    expect(release.protectedReason).toBeUndefined();
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual([]);
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/invalid/i);
  });

  test('ById releases it', () => {
    const fixture = createFileBackedCertifiedSessionFixture({
      carrier: invalidCarrier(),
      sessionId: 'bs-invalid',
      stale: false,
    });

    const release = releaseEmptyHostAgentSessionLeaseById({
      container: fixture.container,
      projectRoot: fixture.projectRoot,
      reason: 'deepMining-converged',
      sessionId: 'bs-invalid',
      source: 'alembic_rescan',
    });

    expect(release).toMatchObject({ released: true, sessionId: 'bs-invalid' });
    expect(readStoredSessionIds(fixture.dataRoot)).toEqual([]);
  });
});

describe('strict alembic_rescan after a Plan-created certified session', () => {
  test('rescan keeps the Plan-created carrier session and analyses certified facts', async () => {
    const projectRoot = createProject();
    const harness = createLoadedContextHarness(projectRoot);
    await attachDatabase(harness);

    const draft = (await routePlanTool(harness.ctx, {
      generationStage: 'coldStart',
      hints: { maxBudget: 64 },
      operation: 'draft',
      projectRoot,
    })) as { success?: boolean };
    expect(draft.success).toBe(true);
    const planSession = getOrCreateSessionManager(harness.ctx.container).getAnySession(undefined, {
      projectRoot,
    });
    expect(planSession).not.toBeNull();
    const planCarrier = readPluginCertifiedCarrierFromProjectContext(
      planSession?.toSnapshot().projectContext
    );
    expect(planCarrier).not.toBeNull();

    const result = await settle(
      runHostAgentKnowledgeRescanWorkflow(
        harness.ctx as never,
        {
          generationStage: 'moduleMining',
          planSelection: moduleMiningPlanSelection(),
          reason: 'strict rescan after Plan draft',
          testMode: true,
        } as never
      )
    );

    expect(readErrorName(result.error), describeError(result.error)).not.toBe(
      'PluginStrictBypassError'
    );
    expect(result.error, describeError(result.error)).toBeUndefined();
    expect(readRecord(result.value).success, JSON.stringify(result.value)).toBe(true);
    const sessionAfter = getOrCreateSessionManager(harness.ctx.container).getAnySession(undefined, {
      projectRoot,
    });
    expect(sessionAfter?.id).toBe(planSession?.id);
    const carrierAfter = readPluginCertifiedCarrierFromProjectContext(
      sessionAfter?.toSnapshot().projectContext
    );
    expect(carrierAfter?.artifactId).toBe(planCarrier?.artifactId);
    expect(carrierAfter?.receipts['recipe-generation']).toMatchObject({
      artifactId: planCarrier?.artifactId,
    });
  });

  test('missing strict carrier fails before rescanClean deletes knowledge or archives candidates', async () => {
    const projectRoot = createProject();
    const harness = createLoadedContextHarness(projectRoot);
    const { dataRoot, repositories } = await attachDatabase(harness);
    const now = Date.now();
    await repositories.knowledgeRepository.create(
      new KnowledgeEntry({
        id: 'pending-before-strict-failure',
        title: 'Pending candidate that must survive a failed strict rescan',
        lifecycle: 'pending',
        language: 'typescript',
        dimensionId: 'architecture',
        category: 'general',
        kind: 'pattern',
        knowledgeType: 'code-pattern',
        trigger: 'trigger-pending-before-strict-failure',
        doClause: 'Keep the candidate.',
        content: { markdown: 'Pending body.' },
        createdAt: now,
        updatedAt: now,
      })
    );
    const candidateFile = path.join(dataRoot, CANDIDATES_DIR, 'keep-me.md');
    fs.mkdirSync(path.dirname(candidateFile), { recursive: true });
    fs.writeFileSync(candidateFile, '# keep me\n');

    const result = await settle(
      runHostAgentKnowledgeRescanWorkflow(
        harness.ctx as never,
        {
          generationStage: 'deepMining',
          planSelection: deepMiningPlanSelection(),
          reason: 'strict rescan without a Plan-created carrier',
        } as never
      )
    );

    expect(readErrorName(result.error), describeError(result.error)).toBe(
      'PluginStrictBypassError'
    );
    expect(
      await repositories.knowledgeRepository.findById('pending-before-strict-failure')
    ).toEqual(expect.objectContaining({ id: 'pending-before-strict-failure' }));
    expect(fs.existsSync(candidateFile)).toBe(true);
  });
});

function createFileBackedCertifiedSessionFixture(input: {
  carrier?: Record<string, unknown>;
  sessionId?: string;
  stale: boolean;
}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-strict-rescan-lease-'));
  tempRoots.push(dataRoot);
  const projectRoot = path.join(dataRoot, 'CertifiedProject');
  const storeDir = path.join(dataRoot, '.asd', 'bootstrap-sessions');
  fs.mkdirSync(storeDir, { recursive: true });
  const startedAt = Date.now() - (input.stale ? 60 * 60 * 1000 : 30 * 1000);
  const projectContext = { certifiedProjectFacts: input.carrier ?? minimalCertifiedCarrier() };
  fs.writeFileSync(
    path.join(storeDir, 'active-sessions.json'),
    JSON.stringify(
      {
        version: 1,
        savedAt: startedAt,
        sessions: [
          {
            id: input.sessionId ?? 'bs-certified',
            projectRoot,
            dimensions: [{ id: 'architecture', label: 'Architecture' }],
            projectContext,
            startedAt,
            expiresAt: Date.now() + 60 * 60 * 1000,
            completedDimensions: {},
            crossDimensionHints: {},
            snapshotCache: null,
            sessionStore: {
              dimensionReports: {},
              crossReferences: [],
              tierReflections: [],
              submittedCandidates: {},
              projectContext,
            },
            submissionTracker: {
              dimensionSubmissions: {},
              fileEvidenceMap: {},
              negativeSignals: [],
              rejections: {},
              usedTriggers: [],
            },
            savedAt: startedAt,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
  const registry: Record<string, unknown> = {};
  const container = {
    get: (name: string) => registry[name],
    register: (name: string, factory: () => unknown) => {
      registry[name] = factory();
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: { dataRoot },
    },
  };
  return { container, dataRoot, projectRoot };
}

function minimalCertifiedCarrier() {
  return {
    artifactId: 'artifact-fixture',
    baseReadbackUnchanged: true,
    canonicalScopeHash: 'scope-hash-fixture',
    certificationBindingHash: 'binding-hash-fixture',
    factsContentHash: 'facts-hash-fixture',
    preparationId: 'prep-v1:00000000-0000-4000-8000-000000000000',
    preparationReceiptHash: 'preparation-receipt-fixture',
    receipts: {},
    sourceVectorHash: 'source-vector-fixture',
  };
}

function readStoredSessionIds(dataRoot: string): string[] {
  const store = JSON.parse(
    fs.readFileSync(
      path.join(dataRoot, '.asd', 'bootstrap-sessions', 'active-sessions.json'),
      'utf8'
    )
  ) as { sessions: Array<{ id: string }> };
  return store.sessions.map((session) => session.id);
}

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-strict-rescan-project-'));
  tempRoots.push(root);
  process.env.ALEMBIC_HOME = root;
  const runtimeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-strict-rescan-data-'));
  tempRoots.push(runtimeParent);
  const sourceRoot = path.join(root, 'strict-rescan');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/strict-rescan', type: 'module' }, null, 2)
  );
  fs.writeFileSync(path.join(sourceRoot, 'src/index.ts'), 'export const loaded = true;\n');
  const descriptor = createProjectDescriptor({
    controlRoot: root,
    dataRoot: path.join(runtimeParent, 'project-data'),
    displayName: 'Strict Rescan',
    folders: [
      {
        displayName: 'strict-rescan',
        id: 'folder-strict-rescan',
        path: sourceRoot,
        repositoryId: 'strict-rescan',
        role: 'primary-source',
      },
    ],
    projectId: 'strict-rescan',
    projectScopeId: 'scope-strict-rescan',
  });
  fs.mkdirSync(path.join(root, '.asd'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([descriptor]), null, 2)
  );
  return root;
}

function createLoadedContextHarness(projectRoot: string): {
  ctx: McpContext;
  services: Map<string, unknown>;
} {
  const services = new Map<string, unknown>();
  const container: McpContext['container'] = {
    get: (name: string) => services.get(name),
    register: (name: string, factory: () => unknown) => {
      if (!services.has(name)) {
        services.set(name, factory());
      }
    },
    singletons: {
      _projectRoot: projectRoot,
      _workspaceResolver: resolveScopeAwareWorkspace(projectRoot),
    },
  };
  return {
    ctx: {
      container,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
      projectRuntime: buildProjectRuntimeContext({ projectRoot }),
    },
    services,
  };
}

async function attachDatabase(harness: ReturnType<typeof createLoadedContextHarness>) {
  const dataRoot = requireRequestProjectRuntime(harness.ctx).identity.dataRoot;
  fs.mkdirSync(dataRoot, { recursive: true });
  const projectRoot = String(harness.ctx.container.singletons?._projectRoot);
  const runtime = await openAlembicDatabase(
    { path: path.join(dataRoot, 'alembic.db') },
    { workspaceResolver: WorkspaceResolver.fromProject(projectRoot) }
  );
  databaseRuntimes.push(runtime);
  const repositories = createAlembicRepositories(runtime.connection);
  const { services } = harness;
  services.set('database', runtime.connection);
  services.set('gitDiffCheckpointRepository', repositories.gitDiffCheckpointRepository);
  services.set('knowledgeRepository', repositories.knowledgeRepository);
  services.set('lifecycleEventRepository', repositories.lifecycleEventRepository);
  services.set('planRepository', repositories.planRepository);
  services.set('proposalGateway', {
    submit: async () => ({ id: 'proposal-strict-rescan' }),
  });
  services.set('proposalRepository', repositories.proposalRepository);
  services.set('recipeSourceRefRepository', repositories.recipeSourceRefRepository);
  return { dataRoot, repositories };
}

function moduleMiningPlanSelection() {
  return {
    generationStage: 'moduleMining' as const,
    dimensions: ['architecture'],
    scale: {
      totalRecipeBudget: 1,
      maxFiles: 8,
      contentMaxLines: 20,
      depthLevels: ['module'],
    },
    moduleBindings: [
      {
        modulePath: 'strict-rescan',
        dimensions: ['architecture'],
        targetRecipes: 1,
      },
    ],
  };
}

function deepMiningPlanSelection() {
  return {
    generationStage: 'deepMining' as const,
    dimensions: ['architecture'],
    scale: {
      totalRecipeBudget: 1,
      maxFiles: 8,
      contentMaxLines: 20,
      depthLevels: ['project', 'module'],
    },
    moduleBindings: [
      {
        modulePath: 'strict-rescan',
        dimensions: ['architecture'],
        targetRecipes: 1,
      },
    ],
  };
}

async function settle(promise: Promise<unknown>): Promise<{ error?: unknown; value?: unknown }> {
  try {
    return { value: await promise };
  } catch (error: unknown) {
    return { error };
  }
}

function readErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
