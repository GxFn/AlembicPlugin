/**
 * W3a-6：恢复的 tick-on-access staging sweep 驱动真实的 Core 晋级（不 mock 任何 driver）。
 *
 * 在真实 alembic_init 的项目里，经插件自有容器的真实 KnowledgeService / StagingManager 造一条
 * grace 已过期、autoApprovable 的 staging 条目；随后用无效入参调用 alembic_submit_knowledge——
 * sweep 在 handler 之前运行，所以即便工具本身返回 VALIDATION_ERROR，条目也必须已经晋级为 active，
 * 并留下 staging→active / grace-period-expire 的 lifecycle 事件。
 *
 * 晋级条件（Core StagingManager.checkAndPromote + LifecycleStateMachine.transition）：
 * lifecycle=staging、stagingDeadline>0 且已过期、autoApprovable、复核结论非 fail，且转 active 时
 * 通过 retrieval readiness（boundary-constraint / guard 类知识豁免）。普通 code-pattern 条目没有
 * native retrievalProfile 时被 readiness 挡住、保持 staging——第二个用例把这条边界固定下来。
 *
 * 需要真实 alembic_init（加载 ../AlembicCore 的 better-sqlite3）：仅 Node 24 可跑通。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import type { McpServiceContainer } from '../../lib/host-runtime/mcp/handlers/types.js';
import { EmbeddedToolExecutor } from '../../lib/host-runtime/mcp/host/embedded-executor.js';
import { resetStagingAccessSweepStateForTests } from '../../lib/host-runtime/mcp/host/staging-access-sweep.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ENV_KEYS = [
  'ALEMBIC_HOME',
  'ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS',
  'ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS',
  'ALEMBIC_VECTOR_RECONCILE_MIN_INTERVAL_MS',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const createdRoots: string[] = [];

interface KnowledgeServiceLike {
  create(
    data: Record<string, unknown>,
    context: { userId: string }
  ): Promise<{ id: string; lifecycle?: string }>;
}
interface StagingManagerLike {
  enterStaging(entryId: string, gracePeriodMs: number, confidence: number): Promise<boolean>;
}
interface DatabaseLike {
  getDb(): {
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
  };
}

interface EntryRow {
  autoApprovable: number;
  lifecycle: string;
  publishedBy: string | null;
  staging_deadline: number | null;
}

describe('restored staging sweep drives a real Core promotion', () => {
  beforeEach(() => {
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-sweep-real-home-'));
    createdRoots.push(process.env.ALEMBIC_HOME);
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    // 真实 driver 首次打开表/索引可能较慢：放宽信封超时，避免把"未完成"误判为"未晋级"。
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '30000';
    // 向量对账走独立长节流，不触网（Ollama）。
    process.env.ALEMBIC_VECTOR_RECONCILE_MIN_INTERVAL_MS = String(24 * 60 * 60 * 1000);
    resetStagingAccessSweepStateForTests();
  });

  afterEach(async () => {
    resetStagingAccessSweepStateForTests();
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('an expired auto-approvable staging entry becomes active on the next write-class tool call', async () => {
    const { projectRoot, server } = await initializedProject();
    const id = await seedExpiredStagingEntry(projectRoot, {
      title: 'Never call the network from the config loader',
      knowledgeType: 'boundary-constraint',
      category: 'guard',
    });
    expect(await readEntry(projectRoot, id, 'before')).toMatchObject({ lifecycle: 'staging' });

    // 对照：只读 / 本地工具不跑 sweep，条目保持 staging——晋级只能来自下面的写类工具调用。
    await server.handleToolCall('alembic_search', { query: 'config loader' });
    await server.handleToolCall('alembic_status', {});
    expect(await readEntry(projectRoot, id, 'control')).toMatchObject({ lifecycle: 'staging' });

    // 无效入参：handler 返回 VALIDATION_ERROR，但 sweep 已在 handler 之前运行。
    const result = await server.handleToolCall('alembic_submit_knowledge', {});
    expect(JSON.stringify(result)).toContain('VALIDATION_ERROR');
    expect(JSON.stringify(result)).not.toContain('promotedCount');

    const row = await readEntry(projectRoot, id, 'after');
    expect(row).toMatchObject({
      lifecycle: 'active',
      publishedBy: 'StagingManager',
      staging_deadline: null,
    });
    const events = await readTransitionEvents(projectRoot, id);
    expect(events).toContainEqual({
      from_state: 'staging',
      to_state: 'active',
      trigger: 'grace-period-expire',
      operator_id: 'StagingManager',
    });
  }, 120_000);

  test('a code-pattern entry without a native retrieval profile stays staging (readiness gate)', async () => {
    const { projectRoot, server } = await initializedProject();
    const id = await seedExpiredStagingEntry(projectRoot, {
      title: 'Config loader exports one frozen object',
      knowledgeType: 'code-pattern',
      category: 'architecture',
    });

    await server.handleToolCall('alembic_submit_knowledge', {});

    const row = await readEntry(projectRoot, id, 'after');
    expect(row.lifecycle).toBe('staging');
    expect(await readTransitionEvents(projectRoot, id)).toEqual([]);
  }, 120_000);
});

async function initializedProject(): Promise<{ projectRoot: string; server: HostMcpServer }> {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-sweep-real-project-'))
  );
  createdRoots.push(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"alembic-sweep-real"}\n');
  fs.writeFileSync(
    path.join(projectRoot, 'config.ts'),
    'export const config = Object.freeze({ mode: "local" });\n'
  );
  const server = new HostMcpServer({ projectRoot });
  const init = await server.handleToolCall('alembic_init', {});
  expect(init).toMatchObject({ success: true });
  return { projectRoot, server };
}

/** 与 HostMcpServer 同一请求项目作用域的插件自有容器（同一 scope key 时复用同一单例）。 */
async function withContainer<T>(
  projectRoot: string,
  callback: (container: McpServiceContainer) => Promise<T>
): Promise<T> {
  const executor = new EmbeddedToolExecutor({
    getSessionId: () => 'fix-followup-sweep-real',
    hostProjectRoot: projectRoot,
  });
  return executor.withPluginOwnedContainer(
    { projectRoot, projectRuntime: buildProjectRuntimeContext({ projectRoot }) },
    callback
  );
}

async function seedExpiredStagingEntry(
  projectRoot: string,
  input: { category: string; knowledgeType: string; title: string }
): Promise<string> {
  return withContainer(projectRoot, async (container) => {
    const knowledgeService = container.get('knowledgeService') as KnowledgeServiceLike;
    const created = await knowledgeService.create(
      {
        title: input.title,
        description: 'Source-grounded rule for the sweep promotion probe.',
        language: 'typescript',
        category: input.category,
        knowledgeType: input.knowledgeType,
        source: 'host-agent',
        content: {
          markdown:
            'The config loader returns a frozen object built from local files only, so callers never trigger network access while reading configuration.',
        },
        reasoning: {
          whyStandard: 'config.ts freezes the exported configuration object.',
          sources: ['config.ts:1'],
          confidence: 0.95,
        },
      },
      { userId: 'host-agent' }
    );
    const db = (container.get('database') as DatabaseLike).getDb();
    const current = db
      .prepare('SELECT lifecycle FROM knowledge_entries WHERE id = ?')
      .get(created.id) as { lifecycle: string };
    if (current.lifecycle === 'pending') {
      // ConfidenceRouter 未直接送入 staging 时，走 Core 的真实入口进入 staging。
      const stagingManager = container.get('stagingManager') as StagingManagerLike;
      expect(await stagingManager.enterStaging(created.id, 60_000, 0.95)).toBe(true);
    }
    // 与 Core 自身测试（KnowledgeProductizationLifecycle）一致：直接把 grace deadline 拨到过去，
    // 并标记可自动晋级（Core 仅对 autoApprovable 条目做 grace 到期晋级）。
    db.prepare(
      'UPDATE knowledge_entries SET staging_deadline = ?, autoApprovable = 1 WHERE id = ?'
    ).run(Date.now() - 60_000, created.id);
    return created.id;
  });
}

async function readEntry(projectRoot: string, id: string, _label: string): Promise<EntryRow> {
  return withContainer(projectRoot, async (container) => {
    const db = (container.get('database') as DatabaseLike).getDb();
    return db
      .prepare(
        'SELECT lifecycle, autoApprovable, publishedBy, staging_deadline FROM knowledge_entries WHERE id = ?'
      )
      .get(id) as EntryRow;
  });
}

async function readTransitionEvents(projectRoot: string, id: string): Promise<unknown[]> {
  return withContainer(projectRoot, async (container) => {
    const db = (container.get('database') as DatabaseLike).getDb();
    return db
      .prepare(
        'SELECT from_state, to_state, trigger, operator_id FROM lifecycle_transition_events WHERE recipe_id = ?'
      )
      .all(id);
  });
}
