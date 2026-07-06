import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommitDrivenMaintenance } from '../../lib/recipe-pipeline/sustain/git-diff-checkpoint/CommitDrivenMaintenance.js';

/**
 * 空间根修（2026-07-06）：漂移扫描对象 = 当前 folder 自己的 git 仓。
 * 真机事故形态：workspace 根是 Wakeflow 协作区 git 仓（untracked 台账 450+），
 * 曾把事件预算挤爆（scale-guard:503>200）且台账不是知识源。
 */
describe('commit-driven maintenance scan root (project-scope folder)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function git(cwd: string, args: string[]) {
    execSync(`git ${args.join(' ')}`, { cwd, stdio: 'pipe' });
  }

  /** workspace 根仓（含协作台账噪音）+ 内嵌 folder 子仓（真实知识源）。 */
  function makeWorkspaceWithFolder() {
    const ws = mkdtempSync(join(tmpdir(), 'alembic-scanroot-ws-'));
    tmpDirs.push(ws);
    git(ws, ['init']);
    git(ws, ['config', 'user.email', 'a@t.dev']);
    git(ws, ['config', 'user.name', 'T']);
    writeFileSync(join(ws, 'README.md'), '# ws\n');
    git(ws, ['add', '.']);
    git(ws, ['commit', '-m', 'ws-init']);
    // 协作台账噪音（untracked）
    mkdirSync(join(ws, 'wakeflow-ledger', 'workspace', 'archive'), { recursive: true });
    writeFileSync(join(ws, 'wakeflow-ledger', 'workspace', 'archive', 'demand.json'), '{}\n');
    writeFileSync(join(ws, 'ws-note.md'), 'workspace noise\n');

    const folder = join(ws, 'Alembic');
    mkdirSync(folder, { recursive: true });
    git(folder, ['init']);
    git(folder, ['config', 'user.email', 'a@t.dev']);
    git(folder, ['config', 'user.name', 'T']);
    writeFileSync(join(folder, 'lib.ts'), 'export const a = 1;\n');
    git(folder, ['add', '.']);
    git(folder, ['commit', '-m', 'folder-init']);
    // folder 内真实源码变更（untracked 新文件）
    writeFileSync(join(folder, 'new-source.ts'), 'export const b = 2;\n');
    return { ws, folder };
  }

  const baseInput = {
    buildHandler: () => null,
    container: { get: () => null } as never,
    handlerUnavailableReason: 'test: no handler',
  };

  it('scans the registered folder repo and remaps event paths to workspace space', async () => {
    const { ws, folder } = makeWorkspaceWithFolder();
    const { scan } = await runCommitDrivenMaintenance({
      ...baseInput,
      projectRoot: ws,
      runtimeScope: { currentFolderPath: folder },
    });

    const paths = scan.events.map((event) => event.path);
    // folder 仓的变更以 workspace 相对路径（refs 表路径空间）出现
    expect(paths).toContain('Alembic/new-source.ts');
    // workspace 根仓的协作台账/杂音不进事件流
    expect(paths.some((p) => p.includes('wakeflow-ledger'))).toBe(false);
    expect(paths).not.toContain('ws-note.md');
  });

  it('falls back to projectRoot scanning when no folder path is provided (single-repo mode)', async () => {
    const { ws } = makeWorkspaceWithFolder();
    const { scan } = await runCommitDrivenMaintenance({
      ...baseInput,
      projectRoot: ws,
    });
    const paths = scan.events.map((event) => event.path);
    expect(paths).toContain('ws-note.md');
  });

  it('rejects out-of-workspace folder paths and falls back safely', async () => {
    const { ws } = makeWorkspaceWithFolder();
    const outside = mkdtempSync(join(tmpdir(), 'alembic-scanroot-outside-'));
    tmpDirs.push(outside);
    const { scan } = await runCommitDrivenMaintenance({
      ...baseInput,
      projectRoot: ws,
      runtimeScope: { currentFolderPath: outside },
    });
    const paths = scan.events.map((event) => event.path);
    // 越界路径被拒收，回退 workspace 根扫描
    expect(paths).toContain('ws-note.md');
  });
});
