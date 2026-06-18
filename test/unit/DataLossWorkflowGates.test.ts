/**
 * MT1 P1/P3-3 数据丢失工作流门禁回归（Train H 认证缺陷 P3-1/P3-2/P3-3）
 *
 * - P3-1: rescan 清理把 candidates/wiki 投影归档进 .asd/.trash/，不再静默删除
 * - P3-2: 可用知识库存在时 bootstrap 需要显式 rebuild:true 确认
 * - P3-3: 选择不一致的阻断响应携带可执行的本地工作流恢复动作
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectCodexKnowledge } from '#codex/KnowledgeState.js';
import { buildCodexHostProjectHandoffBlock } from '#codex/mcp/host/host-project-handoff.js';
import { buildBootstrapRebuildConfirmationBlock } from '#codex/mcp/host-agent-workflows/cold-start.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import { BootstrapInput } from '#shared/schemas/mcp-tools.js';

function makeDataRoot(withProjections: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't6-gates-'));
  if (withProjections) {
    const candidates = path.join(root, 'Alembic', 'candidates');
    const wiki = path.join(root, 'Alembic', 'wiki');
    fs.mkdirSync(candidates, { recursive: true });
    fs.mkdirSync(wiki, { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(candidates, `c${i}.md`), `c${i}`);
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(wiki, `w${i}.md`), `w${i}`);
  }
  return root;
}

const silentLogger = { info() {}, warn() {} };

describe('P3-1: rescan archives knowledge projections instead of deleting them', () => {
  for (const method of ['rescanClean', 'forceRescanClean'] as const) {
    it(`${method} moves candidates+wiki into .asd/.trash and reports the archive`, async () => {
      const root = makeDataRoot(true);
      const service = new CleanupService({
        projectRoot: root,
        dataRoot: root,
        logger: silentLogger,
      });
      const result = await service[method]();

      expect(result.trash).toBeDefined();
      expect(result.trash?.movedItems).toBe(8);
      const trashRoot = path.join(root, '.asd', '.trash');
      expect(fs.existsSync(trashRoot)).toBe(true);
      const [folder] = fs.readdirSync(trashRoot);
      const archived = [
        ...fs.readdirSync(path.join(trashRoot, folder, 'candidates')),
        ...fs.readdirSync(path.join(trashRoot, folder, 'wiki')),
      ];
      expect(archived).toHaveLength(8);
      // 原目录保持为空目录（与旧 #clearDirectory 后置状态一致）
      expect(fs.readdirSync(path.join(root, 'Alembic', 'candidates'))).toHaveLength(0);
      expect(fs.readdirSync(path.join(root, 'Alembic', 'wiki'))).toHaveLength(0);
    });
  }

  it('does not create an empty trash folder when nothing is removed', async () => {
    const root = makeDataRoot(false);
    const service = new CleanupService({ projectRoot: root, dataRoot: root, logger: silentLogger });
    const result = await service.rescanClean();

    expect(result.trash).toBeUndefined();
    expect(fs.existsSync(path.join(root, '.asd', '.trash'))).toBe(false);
  });
});

describe('P3-2: bootstrap rebuild confirmation gate', () => {
  function makeUsableProject(): string {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't6-usable-'));
    fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'Alembic', 'recipes', 'http-client.md'),
      '---\ntitle: HTTP Client\n---\nUse the project HTTP client.\n'
    );
    return projectRoot;
  }

  it('BootstrapInput accepts the rebuild confirmation argument', () => {
    expect(BootstrapInput.parse({})).toEqual({});
    expect(BootstrapInput.parse({ rebuild: true })).toEqual({ rebuild: true });
  });

  it('blocks a bare bootstrap when the knowledge base is usable', () => {
    const knowledge = inspectCodexKnowledge(makeUsableProject());
    expect(knowledge.usable).toBe(true);

    const block = buildBootstrapRebuildConfirmationBlock(knowledge, {});
    expect(block).not.toBeNull();
    expect(block).toMatchObject({
      errorCode: 'CODEX_BOOTSTRAP_REBUILD_CONFIRMATION_REQUIRED',
      success: false,
    });
    const data = (
      block as { data: { needsUserInput: boolean; nextActions: Array<{ tool: string }> } }
    ).data;
    expect(data.needsUserInput).toBe(true);
    expect(data.nextActions.map((a) => a.tool)).toEqual(['alembic_rescan', 'alembic_bootstrap']);
  });

  it('proceeds with explicit rebuild:true on a usable knowledge base', () => {
    const knowledge = inspectCodexKnowledge(makeUsableProject());
    expect(buildBootstrapRebuildConfirmationBlock(knowledge, { rebuild: true })).toBeNull();
  });

  it('proceeds without confirmation on a non-usable knowledge base', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't6-fresh-'));
    const knowledge = inspectCodexKnowledge(projectRoot);
    expect(knowledge.usable).toBe(false);
    expect(buildBootstrapRebuildConfirmationBlock(knowledge, {})).toBeNull();
  });
});

describe('P3-3: selection-mismatch block carries an executable local recovery', () => {
  function makeBlockInput(projectRoot: string) {
    return {
      daemon: {
        message: 'daemon is not started',
        pidAlive: false,
        ready: false,
        state: null,
        status: 'stopped',
      } as never,
      enhancementRoute: { selected: 'pure-local' } as never,
      hostProjectAlignment: { connectionState: 'mismatch' } as never,
      projectRoot,
      requirement: 'jobs' as const,
      tool: 'alembic_job',
    };
  }

  it('recommends the local host-agent workflow first (bootstrap on a fresh project)', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't6-mismatch-'));
    const block = buildCodexHostProjectHandoffBlock(makeBlockInput(projectRoot)) as {
      data: { nextActions: Array<{ tool: string }> };
      message: string;
    };
    expect(block).not.toBeNull();
    expect(block.data.nextActions[0].tool).toBe('alembic_bootstrap');
    expect(block.data.nextActions.map((a) => a.tool)).toContain('alembic_status');
    expect(block.message).toContain('local host-agent workflow');
  });
});
