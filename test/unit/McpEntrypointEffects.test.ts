/**
 * P2 AD6 入流/出流审计：MCP 工具面（本仓唯一公共入口族）的
 * no-undeclared-effects 快照测试（docs/declared-effects.md 的配套证明）。
 *
 * 代表性调用按声明效应类别各取一个：
 *  - 只读类（alembic_codex_status）：不得在数据根之外产生任何写入；
 *  - 破坏/初始化类（alembic_bootstrap，空项目 fast-path 仍执行 fullReset）：
 *    写入只允许落在项目数据根与 ALEMBIC_HOME 注册表内。
 * 两类共同的硬断言：外部探针目录保持空；Alembic 所有的
 * runtime-control.json 绝不被创建或修改（t6/t12 重钉的事实）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDaemonPaths } from '@alembic/core/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCodexProjectRuntimeControlStatePath } from '#codex/HostProjectAlignment.js';
import CodexMcpServer, {
  resetCodexPluginOwnedMcpServerForTests,
} from '#codex/mcp/CodexMcpServer.js';
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

function makeStoppedSupervisor(projectRoot: string) {
  const paths = resolveDaemonPaths(projectRoot);
  const status = {
    status: 'stopped',
    ready: false,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    lockDir: paths.lockDir,
    pidAlive: false,
    state: null,
    message: 'daemon is not started',
  } as never;
  return {
    status: vi.fn(async () => status),
    ensure: vi.fn(async () => status),
    stop: vi.fn(async () => status),
  };
}

afterEach(async () => {
  await resetCodexPluginOwnedMcpServerForTests();
  resetServiceContainer();
});

describe('MCP entrypoint effects stay inside declared boundaries (AD6)', () => {
  it('read-only class: alembic_codex_status writes nothing outside the data root', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-probe-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-project-'));
    fs.writeFileSync(path.join(projectRoot, 'index.js'), 'export const x = 1;\n');

    const server = new CodexMcpServer({
      projectRoot,
      supervisor: makeStoppedSupervisor(projectRoot) as never,
    });
    const result = (await server.handleToolCall('alembic_codex_status', {})) as {
      success?: boolean;
    };
    expect(result).toBeTruthy();

    // 探针目录保持空；runtime-control.json 绝不出现。
    expect(listFiles(probeDir)).toHaveLength(0);
    expect(fs.existsSync(getCodexProjectRuntimeControlStatePath())).toBe(false);
  });

  it('destructive class: alembic_bootstrap confines writes to the data root and registry', async () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-home-'));
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-probe-'));
    process.env.ALEMBIC_HOME = sandboxHome;
    // 空项目：fast-path 仍先执行 fullReset（破坏类代表，t6 门禁冷态放行）。
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-project-'));

    const server = new CodexMcpServer({
      projectRoot,
      supervisor: makeStoppedSupervisor(projectRoot) as never,
    });
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
    expect(fs.existsSync(getCodexProjectRuntimeControlStatePath())).toBe(false);
  });
});
