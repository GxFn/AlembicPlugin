import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { uninitializedGraphDataRoot } from '../../lib/host-runtime/mcp/host/read-only-graph-executor.js';
import { isErrorResult } from '../../lib/host-runtime/mcp/host/results.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { closeProjectIndexRelations } from '../../lib/service/project-knowledge-context/project/ProjectIndexRelations.js';

// A4 复审：未初始化项目的 Graph 运行根位于系统临时目录，在共享 /tmp（Linux、CI、Codex CLI）上
// 路径可被他人预测。运行根必须按 OS 用户私有、校验非符号链接 / 属主 / 无 group-other 权限；
// 校验不过时回退到进程级 mkdtemp 私有根，Graph 仍然可用，且绝不经由被植入的路径写数据。
// 测试把 TMPDIR 指向独立沙箱目录，模拟共享 tmp 中的预置目录与符号链接。

const ORIGINAL_TMPDIR = process.env.TMPDIR;
const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const SANDBOX_PARENT = os.tmpdir();
const createdRoots: string[] = [];
const servers: HostMcpServer[] = [];
const posixOnly = typeof process.getuid === 'function' ? test : test.skip;

let sandboxTmp = '';

describe('FixHostShell: uninitialized Graph runtime root is private to the current user', () => {
  beforeEach(() => {
    sandboxTmp = fs.realpathSync(
      fs.mkdtempSync(path.join(SANDBOX_PARENT, 'host-shell-graph-tmp-'))
    );
    createdRoots.push(sandboxTmp);
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(SANDBOX_PARENT, 'host-shell-graph-home-'));
    createdRoots.push(process.env.ALEMBIC_HOME);
    // os.tmpdir() 在 POSIX 上每次调用都读取 TMPDIR。
    process.env.TMPDIR = sandboxTmp;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.shutdown();
    }
    closeProjectIndexRelations();
    resetServiceContainer();
    await resetPluginOwnedMcpServerForTests();
    restoreEnv('TMPDIR', ORIGINAL_TMPDIR);
    restoreEnv('ALEMBIC_HOME', ORIGINAL_ALEMBIC_HOME);
    for (const root of createdRoots.splice(0)) {
      makeWritable(root);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  posixOnly(
    'the preferred runtime base is keyed by the OS user and created 0700',
    async () => {
      const projectRoot = makeProjectRoot();
      const preferred = uninitializedGraphDataRoot(projectRoot);
      const base = path.dirname(preferred);
      expect(base).toBe(path.join(sandboxTmp, `alembic-graph-runtime-${process.getuid?.()}`));

      await expectGraphSucceeds(projectRoot);

      const stat = fs.lstatSync(base);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.uid).toBe(process.getuid?.());
      expect(stat.mode & 0o077).toBe(0);
      expect(listTree(preferred)).toContain('.asd/codegraph-sessions/');
    },
    60_000
  );

  posixOnly(
    'a symlink planted at the project leaf is never written through',
    async () => {
      const projectRoot = makeProjectRoot();
      const preferred = uninitializedGraphDataRoot(projectRoot);
      const attackerDir = makeAttackerDir();
      fs.mkdirSync(path.dirname(preferred), { recursive: true, mode: 0o700 });
      fs.symlinkSync(attackerDir, preferred);

      await expectGraphSucceeds(projectRoot);

      expect(fs.readdirSync(attackerDir)).toEqual([]);
      expect(fs.lstatSync(preferred).isSymbolicLink()).toBe(true);
      expectFallbackHoldsGraphData(projectRoot);
    },
    60_000
  );

  posixOnly(
    'a symlink planted at the shared base is never written through',
    async () => {
      const projectRoot = makeProjectRoot();
      const base = path.dirname(uninitializedGraphDataRoot(projectRoot));
      const attackerDir = makeAttackerDir();
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.symlinkSync(attackerDir, base);

      await expectGraphSucceeds(projectRoot);

      expect(fs.readdirSync(attackerDir)).toEqual([]);
      expectFallbackHoldsGraphData(projectRoot);
    },
    60_000
  );

  posixOnly(
    'a group/other-writable base is refused instead of reused',
    async () => {
      const projectRoot = makeProjectRoot();
      const base = path.dirname(uninitializedGraphDataRoot(projectRoot));
      fs.mkdirSync(base, { recursive: true });
      fs.chmodSync(base, 0o777);

      await expectGraphSucceeds(projectRoot);

      expect(fs.readdirSync(base)).toEqual([]);
      expectFallbackHoldsGraphData(projectRoot);
    },
    60_000
  );

  posixOnly(
    'an unwritable base falls back instead of failing Graph with EACCES',
    async () => {
      const projectRoot = makeProjectRoot();
      const base = path.dirname(uninitializedGraphDataRoot(projectRoot));
      fs.mkdirSync(base, { recursive: true });
      fs.chmodSync(base, 0o500);

      await expectGraphSucceeds(projectRoot);

      expect(fs.readdirSync(base)).toEqual([]);
      expectFallbackHoldsGraphData(projectRoot);
    },
    60_000
  );
});

async function expectGraphSucceeds(projectRoot: string): Promise<void> {
  const server = new HostMcpServer({ projectRoot });
  servers.push(server);
  const before = listTree(projectRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = (await server.handleToolCall('alembic_graph', {
      queryKind: 'file-symbols',
      filePath: 'src/index.ts',
    })) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('EACCES');
    expect(isErrorResult(result)).toBe(false);
    expect(readRecord(result.structuredContent).ok).toBe(true);
  }
  expect(listTree(projectRoot)).toEqual(before);
}

/** 回退根：进程级 mkdtemp 私有目录（0700、属当前用户），项目子目录承载 Graph 运行数据。 */
function expectFallbackHoldsGraphData(projectRoot: string): void {
  const digest = path.basename(uninitializedGraphDataRoot(projectRoot));
  const fallbacks = fs
    .readdirSync(sandboxTmp)
    .filter((name) => name.startsWith('alembic-graph-runtime-private-'))
    .map((name) => path.join(sandboxTmp, name));
  expect(fallbacks).toHaveLength(1);
  const stat = fs.lstatSync(fallbacks[0]);
  expect(stat.isDirectory()).toBe(true);
  expect(stat.uid).toBe(process.getuid?.());
  expect(stat.mode & 0o077).toBe(0);
  expect(listTree(path.join(fallbacks[0], digest))).toContain('.asd/codegraph-sessions/');
}

function makeAttackerDir(): string {
  const dir = fs.mkdtempSync(path.join(SANDBOX_PARENT, 'host-shell-graph-attacker-'));
  createdRoots.push(dir);
  return dir;
}

function makeProjectRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(SANDBOX_PARENT, 'host-shell-graph-project-'))
  );
  createdRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"host-shell-graph-fixture"}\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'index.ts'),
    "import { helper } from './helper.js';\nexport const value = helper(1);\n"
  );
  fs.writeFileSync(
    path.join(root, 'src', 'helper.ts'),
    'export function helper(input: number): number { return input + 1; }\n'
  );
  return root;
}

/** 清理前恢复沙箱内被测试改成只读的目录权限，否则 rmSync 无法删除。 */
function makeWritable(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }
  const walk = (dir: string) => {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function listTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      entries.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) {
        walk(absolute);
      }
    }
  };
  walk(root);
  return entries.sort();
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
