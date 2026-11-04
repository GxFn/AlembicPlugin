import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import {
  _resetGenerateSessionManagersForTesting,
  getOrCreateSessionManager,
} from '@alembic/core/host-agent-workflows';
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
import { resolveScopeAwareWorkspace } from '../../lib/shared/project-scope-runtime.js';

// 回归（W3d-2）：严格模式 deepMining 无可执行产出（no-produce-dimensions）时，rescan 按 id 释放空
// session；Plan 创建的 certified session 被保护保留（released=false）。此时响应不能再告诉 Agent
// “session 不存在”（session=null / sessionId=null），而应保留其 id 并标明是保留的认证 session。

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

describe('strict deepMining no-work rescan with a retained certified session', () => {
  test('keeps the retained certified session id instead of reporting no session', async () => {
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
    expect(
      readPluginCertifiedCarrierFromProjectContext(planSession?.toSnapshot().projectContext)
    ).not.toBeNull();
    const planSessionId = String(planSession?.id);

    const result = await settle(
      runHostAgentKnowledgeRescanWorkflow(
        harness.ctx as never,
        {
          generationStage: 'deepMining',
          planSelection: noProduceDeepMiningPlanSelection(),
          reason: 'strict deepMining rescan without produce work',
          testMode: true,
        } as never
      )
    );

    expect(result.error, describeError(result.error)).toBeUndefined();
    const response = readRecord(result.value);
    expect(response.success, JSON.stringify(response)).toBe(true);
    const data = readRecord(response.data);
    const meta = readRecord(response.meta);
    // 前置事实：走的是 no-work 释放路径，且认证 session 被保留（未释放）。
    expect(readRecord(meta.noActionableHostAgentWork)).toMatchObject({
      releasedEmptySession: false,
      retainedCertifiedSession: true,
      sessionId: planSessionId,
      stopReason: 'no-produce-dimensions',
    });
    expect(
      getOrCreateSessionManager(harness.ctx.container).getAnySession(undefined, { projectRoot })?.id
    ).toBe(planSessionId);

    expect(readRecord(data.noActionableHostAgentWork)).toMatchObject({
      releasedEmptySession: false,
      retainedCertifiedSession: true,
      sessionId: planSessionId,
      stopReason: 'no-produce-dimensions',
    });
    expect(data.session).not.toBeNull();
    expect(readRecord(data.session).id).toBe(planSessionId);
    expect(String(response.message)).toMatch(/certified/i);
    expect(String(response.message)).not.toContain('不保留空 host-agent session');
  });
});

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

function noProduceDeepMiningPlanSelection() {
  // targetRecipes=0 → 计划没有 produce 维度，触发 no-produce-dimensions 的 no-work 释放路径。
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
        targetRecipes: 0,
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

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
