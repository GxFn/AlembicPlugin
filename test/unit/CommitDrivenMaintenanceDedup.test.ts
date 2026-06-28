import { describe, expect, it, vi } from 'vitest';
import { HostAgentFileChangeHandler } from '../../lib/recipe-generation/evolution/HostAgentFileChangeHandler.js';

// UM#7（CG-6）：固化「commit-driven 维护双入口（presenter↔rescan）对同一 recipe+type 重复 submit
// 只落一条」。真实去重在 Core ProposalRepository.create 的 #hasDuplicate：按
// (target_recipe_id, type, status∈pending/observing) 去重。evolution_proposals 无 source_path 列，
// 故禁止声称按 sourcePath 去重——去重键是 (recipeId, type, status)。两入口经同一容器拿同一
// evolutionGateway → 同一 ProposalRepository，故无论哪个入口触发，重复提案被 Core 去重。
// 本测试用忠实建模该 dedup 的 gateway 桩，跨两次 handleFileChanges（模拟两入口/两 tick 对同一被覆盖
// 文件的同类变更）证明只落一条；不依赖真机/真 DB，不改 schema。

interface SubmitPayload {
  action: string;
  recipeId: string;
}

// 忠实建模 Core #hasDuplicate：键 = (recipeId, action) 且既有为 pending/observing 时判重、跳过插入。
function makeDedupGateway() {
  const stored: Array<{ action: string; recipeId: string; status: string }> = [];
  const submit = vi.fn(async (payload: SubmitPayload) => {
    const duplicate = stored.find(
      (existing) =>
        existing.recipeId === payload.recipeId &&
        existing.action === payload.action &&
        (existing.status === 'pending' || existing.status === 'observing')
    );
    if (duplicate) {
      return { outcome: 'duplicate-skipped' };
    }
    const proposalId = `proposal-${stored.length + 1}`;
    stored.push({ action: payload.action, recipeId: payload.recipeId, status: 'observing' });
    return { outcome: 'created', proposalId };
  });
  return { stored, submit };
}

function makeSourceRefRepo(seed: { recipeId: string; sourcePath: string }) {
  const rows = [{ recipeId: seed.recipeId, sourcePath: seed.sourcePath, status: 'active' }];
  return {
    findByRecipeId: (recipeId: string) => rows.filter((row) => row.recipeId === recipeId),
    findBySourcePath: (sourcePath: string) => rows.filter((row) => row.sourcePath === sourcePath),
    replaceSourcePath: () => {},
  };
}

describe('Commit-driven maintenance dual-entry dedup (UM#7 / CG-6)', () => {
  it('lands only one proposal when both entries submit the same recipe+type', async () => {
    const gateway = makeDedupGateway();
    const sourceRefRepo = makeSourceRefRepo({
      recipeId: 'recipe-1',
      sourcePath: 'Sources/Gone.swift',
    });
    const knowledgeRepo = {
      findById: vi.fn(async () => ({
        id: 'recipe-1',
        lifecycle: 'active',
        title: 'Gone Recipe',
      })),
    };

    // 两入口经各自容器装配自己的 handler，但共享同一 evolutionGateway（→ 同一 ProposalRepository）。
    const buildHandler = () =>
      new HostAgentFileChangeHandler(sourceRefRepo as never, knowledgeRepo as never, undefined, {
        evolutionGateway: gateway as never,
        projectRoot: '/repo',
      });

    const deletedEvent = {
      eventSource: 'git-head' as const,
      path: 'Sources/Gone.swift',
      type: 'deleted' as const,
    };

    // 入口①（如 presenter tick）：被覆盖源删除 → deprecate 提案。
    const first = await buildHandler().handleFileChanges([deletedEvent]);
    // 入口②（如 rescan tick）：同一 recipe+type 再次提交。
    const second = await buildHandler().handleFileChanges([deletedEvent]);

    // 两入口各自都尝试提交（gateway 被调用两次）……
    expect(gateway.submit).toHaveBeenCalledTimes(2);
    // ……但 Core 风格 (recipeId,type,status) 去重只落一条 observing 提案。
    expect(gateway.stored).toHaveLength(1);
    expect(gateway.stored[0]).toMatchObject({
      action: 'deprecate',
      recipeId: 'recipe-1',
      status: 'observing',
    });
    // 两次都产出 deprecation 信号（提案对端一致），证明重复由 gateway/Repository 去重而非入口各自判重。
    expect(first.pendingProposals).toHaveLength(1);
    expect(second.pendingProposals).toHaveLength(1);
  });
});
