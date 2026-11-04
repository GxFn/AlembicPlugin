/**
 * W3a-5：alembic_job op=bootstrap 的成功路径（wave-1 只证明了校验失败与 Plan gate 失败）。
 *
 * 在沙箱 ALEMBIC_HOME 的注册表里登记一个 native ProjectScope（Core 公共 API），项目是一个最小 git
 * 仓库；随后全部经 HostMcpServer.handleToolCall：alembic_init → alembic_plan draft → confirm →
 * alembic_job op=bootstrap（testMode）。断言 job 记录 completed、响应携带 Mission Briefing
 * （executionPlan / dimensions / hostAgentContract，完整版落盘于 meta.fullBriefingRef），
 * op=status 能回读同一 completed 记录，且用户仓库内零文件（数据都在 ghost dataRoot）。
 *
 * 需要真实 alembic_init（加载 ../AlembicCore 的 better-sqlite3）：仅 Node 24 可跑通。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
  upsertProjectScopeInRegistry,
} from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { PluginJobStore } from '../../lib/host-runtime/jobs/PluginJobStore.js';
import {
  CORE_BASE_OUTPUT_FIELD_NAMES,
  CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
} from '../../lib/host-runtime/mcp/core-tools/output.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

interface ScopedFixture {
  controlRoot: string;
  dataRoot: string;
  sourceRoot: string;
}

describe('alembic_job op=bootstrap success path', () => {
  afterEach(async () => {
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('a confirmed planSelection completes the job and returns the Mission Briefing', async () => {
    const fixture = createNativeScopeGitProject();
    const server = new HostMcpServer({ projectRoot: fixture.controlRoot });
    try {
      const init = rec(await server.handleToolCall('alembic_init', {}));
      expect(init.success, JSON.stringify(init).slice(0, 2000)).toBe(true);

      const draft = rec(
        await server.handleToolCall('alembic_plan', {
          operation: 'draft',
          generationStage: 'coldStart',
        })
      );
      expect(draft.success, JSON.stringify(draft).slice(0, 2000)).toBe(true);
      const tree = rec(rec(draft.data).projectInfoTree);
      const dimensionIds = arr(rec(draft.data).candidateDimensions).map((item) => String(item.id));
      expect(dimensionIds).toContain('architecture');

      const confirm = rec(
        await server.handleToolCall('alembic_plan', confirmArgs(tree, 'architecture', 'app'))
      );
      expect(confirm.success, JSON.stringify(confirm).slice(0, 2000)).toBe(true);
      const planSelection = rec(rec(confirm.data).planSelection);
      expect(planSelection.generationStage).toBe('coldStart');

      const job = rec(
        await server.handleToolCall('alembic_job', {
          op: 'bootstrap',
          planSelection,
          testMode: true,
        })
      );
      expect(job.success, JSON.stringify(job).slice(0, 3000)).toBe(true);
      const jobRecord = rec(rec(job.data).job);
      expect(jobRecord.status).toBe('completed');
      expect(rec(rec(job.data).jobRoute)).toMatchObject({ workflowTool: 'alembic_bootstrap' });

      // Mission Briefing：与直调 alembic_bootstrap 同一冷启动 briefing。
      const briefing = rec(jobRecord.result);
      expect(rec(briefing.bootstrapState).status).toBe('bootstrap_ready');
      expect(arr(rec(briefing.executionPlan).tiers)[0]?.dimensions).toEqual(['architecture']);
      expect(arr(briefing.dimensions).map((item) => item.id)).toEqual(['architecture']);
      expect(rec(briefing.currentDimensionGuidance).source).toBe(
        'mission-briefing.executionPlan.current-tier'
      );
      expect(rec(briefing.hostAgentContract).contractVersion).toBe(1);
      expect(rec(briefing.planGate)).toMatchObject({
        status: 'ready',
        toolName: 'alembic_bootstrap',
      });
      // job.result 与直调 alembic_bootstrap 走同一公开投影：只含该工具白名单字段，
      // meta 只保留公开键（profile 等内部 meta 不外泄）。
      expect(briefing.toolName).toBe('alembic_bootstrap');
      expect(briefing.ok).toBe(true);
      const allowedKeys = new Set<string>([
        ...CORE_BASE_OUTPUT_FIELD_NAMES,
        ...CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES.alembic_bootstrap,
      ]);
      expect(Object.keys(briefing).filter((key) => !allowedKeys.has(key))).toEqual([]);
      expect(rec(briefing.meta).profile).toBeUndefined();
      const fullBriefingPath = String(rec(rec(briefing.meta).fullBriefingRef).path ?? '');
      expect(fullBriefingPath.startsWith(fixture.dataRoot)).toBe(true);
      expect(fs.existsSync(fullBriefingPath)).toBe(true);
      // job.result 不重复携带 projectRuntime（响应顶层已带）。
      expect(briefing.projectRuntime).toBeUndefined();

      const status = rec(
        await server.handleToolCall('alembic_job', { op: 'status', jobId: jobRecord.id })
      );
      expect(rec(rec(status.data).job)).toMatchObject({ id: jobRecord.id, status: 'completed' });
      const stored = new PluginJobStore(fixture.controlRoot).list({ kind: 'bootstrap' });
      expect(stored.map((entry) => entry.status)).toEqual(['completed']);

      // ghost-registry 项目：用户仓库内零文件。
      expect(fs.existsSync(path.join(fixture.controlRoot, '.asd'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.sourceRoot, '.asd'))).toBe(false);
    } finally {
      await server.shutdown();
    }
  }, 120_000);
});

/** 最小 git 仓库 + 沙箱注册表中的 native ProjectScope（controlRoot 下一个 primary-source 目录）。 */
function createNativeScopeGitProject(): ScopedFixture {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-job-ok-')));
  createdRoots.push(sandbox);
  const alembicHome = path.join(sandbox, 'alembic-home');
  fs.mkdirSync(path.join(alembicHome, '.asd'), { recursive: true });
  process.env.ALEMBIC_HOME = alembicHome;

  const controlRoot = path.join(sandbox, 'workspace');
  const sourceRoot = path.join(controlRoot, 'app');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/job-ok', type: 'module' }, null, 2)
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'src/config.ts'),
    'export interface Config { mode: string }\nexport function loadConfig(): Config {\n  return Object.freeze({ mode: "local" });\n}\n'
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'src/index.ts'),
    "import { loadConfig } from './config.js';\nexport function start() {\n  return loadConfig().mode;\n}\n"
  );
  fs.writeFileSync(path.join(controlRoot, '.gitignore'), '.asd/\n');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
  };
  // 不受开发机全局 git 配置（如强制签名）影响。
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'],
  ]) {
    execFileSync('git', args, { cwd: controlRoot, env: gitEnv });
  }

  const dataRoot = path.join(sandbox, 'data', 'job-ok');
  const descriptor = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: 'Job Success Fixture',
    folders: [
      {
        displayName: 'app',
        id: 'folder-job-ok-app',
        path: sourceRoot,
        repositoryId: 'job-ok-app',
        role: 'primary-source',
      },
    ],
    projectId: 'job-ok',
    projectScopeId: 'scope-job-ok',
  });
  fs.writeFileSync(
    path.join(alembicHome, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(
      upsertProjectScopeInRegistry(createProjectScopeRegistryDocument(), descriptor),
      null,
      2
    )
  );
  return { controlRoot, dataRoot, sourceRoot };
}

function confirmArgs(
  tree: Record<string, unknown>,
  dimensionId: string,
  modulePath: string
): Record<string, unknown> {
  return {
    operation: 'confirm',
    generationStage: 'coldStart',
    evidenceRefs: [
      {
        detail: 'Draft projectInfoTree',
        kind: 'project-context',
        ref: `projectInfoTree:${String(tree.primaryLanguage)}:${String(tree.fileCount)}`,
      },
    ],
    moduleBindings: [{ dimensions: [dimensionId], modulePath, targetRecipes: 1 }],
    plannedNextActions: [
      { reason: 'Run the confirmed plan through alembic_job.', tool: 'alembic_bootstrap' },
    ],
    projectProfile: {
      architectureHints: arr(tree.children)
        .map((child) => String(child.path ?? ''))
        .filter(Boolean)
        .slice(0, 8),
      fileCount: Number(tree.fileCount ?? 0),
      frameworks: Array.isArray(tree.frameworks) ? tree.frameworks : [],
      moduleCount: Number(tree.moduleCount ?? 0),
      primaryLanguage: String(tree.primaryLanguage ?? 'typescript'),
      projectType: String(tree.projectType ?? 'node'),
      secondaryLanguages: Array.isArray(tree.secondaryLanguages) ? tree.secondaryLanguages : [],
    },
    rationale: 'Minimal single-dimension plan for the alembic_job success path.',
    scale: {
      contentMaxLines: 80,
      depthLevels: ['project', 'module'],
      maxFiles: 32,
      totalRecipeBudget: 1,
    },
    selectedDimensions: [
      { dimensionId, priority: 1, rationale: 'Job success path.', targetRecipes: 1 },
    ],
  };
}
