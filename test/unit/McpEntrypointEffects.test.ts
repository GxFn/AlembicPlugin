/**
 * P2 AD6 入流/出流审计：MCP 工具面（本仓唯一公共入口族）的
 * no-undeclared-effects 快照测试（docs/declared-effects.md 的配套证明）。
 *
 * 代表性调用按声明效应类别各取一个：
 *  - 只读类（alembic_status）：不得在数据根之外产生任何写入；
 *  - 破坏/初始化类（alembic_bootstrap，空项目 fast-path 仍执行 fullReset）：
 *    写入只允许落在项目数据根与 ALEMBIC_HOME 注册表内。
 * 两类共同的硬断言：外部探针目录保持空；Alembic 所有的
 * runtime-control.json 绝不被创建或修改（t6/t12 重钉的事实）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { getProjectRuntimeControlStatePath } from '#host-runtime/context/HostProjectAlignment.js';
import HostMcpServer, {
  resetPluginOwnedMcpServerForTests,
} from '#host-runtime/mcp/HostMcpServer.js';
import { PLUGIN_TOOL_SURFACE_CATALOG } from '#host-runtime/mcp/PluginToolSurfaceCatalog.js';
import { resetServiceContainer } from '#inject/ServiceContainer.js';

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out.sort();
}

afterEach(async () => {
  await resetPluginOwnedMcpServerForTests();
  resetServiceContainer();
});

describe('MCP entrypoint effects stay inside declared boundaries (AD6)', () => {
  it.each([
    ['alembic_search', true, 'McpServer.tool-router'],
    ['alembic_recipe_map', true, 'McpServer.tool-router'],
    ['alembic_prime', true, 'McpServer.agent-public-tools'],
    ['alembic_code_guard', false, 'McpServer.agent-public-tools'],
    ['alembic_graph', true, 'McpServer.tool-router'],
  ] as const)('five-tool effect catalog: %s has the tested read/write owner', (toolName, readOnly, handlerOwner) => {
    const entry = PLUGIN_TOOL_SURFACE_CATALOG[toolName];
    expect(entry.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: readOnly,
    });
    expect(entry.handlerOwner).toBe(handlerOwner);
  });

  it('read-only class: alembic_status writes nothing outside the data root', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-probe-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-project-'));
    fs.writeFileSync(path.join(projectRoot, 'index.js'), 'export const x = 1;\n');

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_status', {})) as {
      success?: boolean;
    };
    expect(result).toBeTruthy();

    // 探针目录保持空；runtime-control.json 绝不出现。
    expect(listFiles(probeDir)).toHaveLength(0);
    expect(fs.existsSync(getProjectRuntimeControlStatePath())).toBe(false);
  });

  it('read-only Graph uses no initializing container and preserves its live DB family byte-for-byte', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-graph-project-'));
    const dataDir = path.join(projectRoot, '.asd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n');
    fs.writeFileSync(path.join(dataDir, 'alembic.db'), '');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"ad6-graph"}\n');
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const graph = true;\n');
    const before = captureProjectReadInputs(projectRoot);

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_graph', {
      queryKind: 'space',
    })) as { structuredContent?: { ok?: boolean } };

    expect(result.structuredContent?.ok).toBe(true);
    expect(captureProjectReadInputs(projectRoot)).toEqual(before);
  });

  it('read-only Recipe Map uses no initializing container and preserves its live DB family byte-for-byte', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-recipe-map-project-'));
    const dataDir = path.join(projectRoot, '.asd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n');
    fs.writeFileSync(path.join(dataDir, 'alembic.db'), '');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"ad6-recipe-map"}\n');
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const recipeMap = true;\n');
    const before = captureProjectReadInputs(projectRoot);

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_recipe_map', {
      focus: { kind: 'space' },
    })) as { structuredContent?: { ok?: boolean } };

    expect(result.structuredContent?.ok).toBe(true);
    expect(captureProjectReadInputs(projectRoot)).toEqual(before);
  });

  it('read-only Prime uses a request snapshot and preserves its live DB family byte-for-byte', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-prime-project-'));
    const dataDir = path.join(projectRoot, '.asd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n');
    fs.writeFileSync(path.join(dataDir, 'alembic.db'), '');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"ad6-prime"}\n');
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const prime = true;\n');
    const before = captureProjectReadInputs(projectRoot);

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_prime', {
      agentHost: 'codex',
      inputSource: 'host-declared-intent',
      projectRoot,
      requirementGoal: 'Inspect project knowledge without mutating retrieval state',
      scenario: 'Prime read-only entrypoint effects',
      taskAction: 'fix',
    })) as { status?: string };

    expect(result.status).toBeTruthy();
    expect(captureProjectReadInputs(projectRoot)).toEqual(before);
  });

  it('clean Code Guard keeps review read-only while its declared checkpoint write stays in the request DB', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-guard-project-'));
    const dataDir = path.join(projectRoot, '.asd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n');
    await createMigratedDatabase(path.join(dataDir, 'alembic.db'), projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"ad6-guard"}\n');
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const guarded = true;\n');
    const before = captureProjectReadInputs(projectRoot);

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_code_guard', {
      files: ['index.ts'],
      inputSource: 'host-declared-intent',
      operation: 'review',
      projectRoot,
    })) as { status?: string };

    const readDb = new Database(path.join(dataDir, 'alembic.db'), {
      fileMustExist: true,
      readonly: true,
    });
    const checkpoints = readDb
      .prepare(
        'SELECT project_root, checkpoint_commit FROM git_diff_checkpoints ORDER BY updated_at DESC'
      )
      .all() as Array<{ checkpoint_commit: string; project_root: string }>;
    readDb.close();
    const after = captureProjectReadInputs(projectRoot);
    expect(result.status).toBe('ready');
    expect(checkpoints).toEqual([
      expect.objectContaining({
        checkpoint_commit: null,
        project_root: projectRoot,
      }),
    ]);
    expect(after['config.json']).toEqual(before['config.json']);
    expect(after['alembic.db-wal']?.exists).toBe(before['alembic.db-wal']?.exists);
    expect(after['alembic.db-shm']?.exists).toBe(before['alembic.db-shm']?.exists);
  });

  it('Code Guard commits a real violation only through its declared post-result effect', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-guard-effect-project-'));
    const dataDir = path.join(projectRoot, '.asd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(configPath, '{}\n');
    const databasePath = path.join(dataDir, 'alembic.db');
    await createMigratedDatabase(databasePath, projectRoot);
    const seedDb = new Database(databasePath, { fileMustExist: true });
    const now = Math.floor(Date.now() / 1000);
    seedDb
      .prepare(
        `INSERT INTO knowledge_entries
           (id, title, description, lifecycle, language, kind, constraints, stats, createdAt, updatedAt)
         VALUES (?, ?, ?, 'active', 'typescript', 'rule', ?, '{}', ?, ?)`
      )
      .run(
        'fixture-console-log',
        'Fixture console rule',
        'Records explicit Guard feedback',
        JSON.stringify({
          guards: [
            {
              id: 'fixture-console-log',
              message: 'Fixture console violation',
              pattern: 'console\\.log',
              severity: 'error',
            },
          ],
        }),
        now,
        now
      );
    seedDb.close();
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"ad6-guard-effect"}\n');
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'console.log("guard effect");\n');
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const familyBefore = captureProjectReadInputs(projectRoot);

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_code_guard', {
      files: ['index.ts'],
      inputSource: 'host-declared-intent',
      operation: 'review',
      projectRoot,
    })) as { guard?: { verdict?: string }; status?: string };

    const readDb = new Database(databasePath, { fileMustExist: true, readonly: true });
    const persisted = readDb
      .prepare('SELECT violations_json FROM guard_violations ORDER BY created_at DESC')
      .all() as Array<{ violations_json: string }>;
    const feedback = readDb
      .prepare('SELECT stats FROM knowledge_entries WHERE id = ?')
      .get('fixture-console-log') as { stats: string };
    const journalMode = readDb.pragma('journal_mode', { simple: true });
    readDb.close();
    expect(result.status).toBe('ready');
    expect(result.guard?.verdict).toBe('failed');
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]?.violations_json ?? '[]')).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'js-no-console-log' })])
    );
    expect(JSON.parse(feedback.stats)).toMatchObject({ guardHits: 1 });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(journalMode).toBe('delete');
    const familyAfter = captureProjectReadInputs(projectRoot);
    expect(familyAfter['alembic.db-wal']?.exists).toBe(familyBefore['alembic.db-wal']?.exists);
    expect(familyAfter['alembic.db-shm']?.exists).toBe(familyBefore['alembic.db-shm']?.exists);
  });

  it('Code Guard rejects a database symlink that would route effects outside dataRoot', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-guard-db-link-project-'));
    const dataDir = path.join(projectRoot, '.asd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"ad6-guard-db-link"}\n');
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'console.log("must not persist");\n');

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-guard-db-outside-'));
    const outsideDataDir = path.join(outsideRoot, '.asd');
    fs.mkdirSync(outsideDataDir, { recursive: true });
    const outsideDatabasePath = path.join(outsideDataDir, 'alembic.db');
    await createMigratedDatabase(outsideDatabasePath, outsideRoot);
    const seedDb = new Database(outsideDatabasePath, { fileMustExist: true });
    const now = Math.floor(Date.now() / 1000);
    seedDb
      .prepare(
        `INSERT INTO knowledge_entries
           (id, title, description, lifecycle, language, kind, constraints, stats, createdAt, updatedAt)
         VALUES (?, ?, ?, 'active', 'typescript', 'rule', ?, '{}', ?, ?)`
      )
      .run(
        'fixture-db-link-console-log',
        'Fixture DB link rule',
        'Must not persist outside dataRoot',
        JSON.stringify({
          guards: [
            {
              id: 'fixture-db-link-console-log',
              message: 'Fixture DB link violation',
              pattern: 'console\\.log',
              severity: 'error',
            },
          ],
        }),
        now,
        now
      );
    seedDb.close();
    fs.symlinkSync(outsideDatabasePath, path.join(dataDir, 'alembic.db'));

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_code_guard', {
      files: ['index.ts'],
      inputSource: 'host-declared-intent',
      operation: 'review',
      projectRoot,
    })) as { errorCode?: string; success?: boolean };

    const verifyDb = new Database(outsideDatabasePath, { fileMustExist: true, readonly: true });
    const persisted = verifyDb.prepare('SELECT count(*) AS count FROM guard_violations').get() as {
      count: number;
    };
    verifyDb.close();
    expect(result).toMatchObject({ errorCode: 'CODEX_MCP_ERROR', success: false });
    expect(persisted.count).toBe(0);
  });

  it('destructive class: alembic_bootstrap confines writes to the data root and registry', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-probe-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    // 空项目：fast-path 仍先执行 fullReset（破坏类代表，t6 门禁冷态放行）。
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-project-'));

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_bootstrap', {})) as Record<
      string,
      unknown
    >;
    expect(result).toBeTruthy();

    // 所有新文件必须位于项目根（数据根=项目根，非排除项目）或 ALEMBIC_HOME 之下。
    const allowedRoots = [projectRoot, sandboxHome];
    const written = [...listFiles(projectRoot), ...listFiles(sandboxHome)];
    for (const file of written) {
      expect(
        allowedRoots.some((root) => file.startsWith(root)),
        `undeclared write location: ${file}`
      ).toBe(true);
    }
    // 外部探针目录保持空；runtime-control.json（Alembic 所有）绝不被创建。
    expect(listFiles(probeDir)).toHaveLength(0);
    expect(fs.existsSync(getProjectRuntimeControlStatePath())).toBe(false);
  });
});

async function createMigratedDatabase(databasePath: string, dataRoot: string): Promise<void> {
  const runtime = await openAlembicDatabase(
    { path: databasePath },
    { workspaceResolver: { dataRoot } as never }
  );
  runtime.close();
  const db = new Database(databasePath, { fileMustExist: true });
  db.pragma('journal_mode = DELETE');
  db.close();
}

function captureProjectReadInputs(
  projectRoot: string
): Record<string, { content?: string; exists: boolean; mtimeNs?: string; size?: number }> {
  const dataDir = path.join(projectRoot, '.asd');
  return Object.fromEntries(
    ['alembic.db', 'alembic.db-wal', 'alembic.db-shm', 'config.json'].map((name) => {
      const filePath = path.join(dataDir, name);
      if (!fs.existsSync(filePath)) {
        return [name, { exists: false }];
      }
      const stat = fs.statSync(filePath, { bigint: true });
      return [
        name,
        {
          content: fs.readFileSync(filePath).toString('base64'),
          exists: true,
          mtimeNs: stat.mtimeNs.toString(),
          size: Number(stat.size),
        },
      ];
    })
  );
}
