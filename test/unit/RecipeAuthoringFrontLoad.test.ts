/**
 * P2.3 / 13.L 真机验收：attachRecipeAuthoringFrontLoad（live cold-start 模块）把从
 * @alembic/core/knowledge 渲染的 Recipe 创作前置契约挂到 cold-start 风格 briefing 的 hostAgentContract
 * （bootstrap clean-output allowlist 内的字段）与 submissionSchema 镜像。断言 emitted briefing JSON 含
 * 三要素（guidance==gate）：(a) worked example 未被剥离（✅/❌ 范例） (b) doClause 字面允许动词
 * (c) scope: narrow（file-local）证据下限逃逸。clean-output 整体保留 hostAgentContract（不递归过滤）。
 */
import { describe, expect, it } from 'vitest';
import { attachRecipeAuthoringFrontLoad } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';

describe('recipe authoring front-load (P2.3 / 13.L)', () => {
  it('renders the worked example + literal verbs + scope escape from @alembic/core/knowledge', () => {
    const briefing = {
      hostAgentContract: { contractVersion: 1, source: 'host-agent-plan-neutral-quality-contract' },
      submissionSchema: { requiredFields: ['title'], topLevelFields: ['items'] },
      meta: {},
    };
    const withFrontLoad = attachRecipeAuthoringFrontLoad(briefing);

    // hostAgentContract 在 bootstrap clean-output allowlist 内且整体保留，故前置契约对冷启动 Agent 可见。
    const hostAgentContract = withFrontLoad.hostAgentContract as {
      recipeAuthoringFrontLoad?: Record<string, unknown>;
    };
    const frontLoad = hostAgentContract.recipeAuthoringFrontLoad as {
      workedExample?: { candidate?: { content?: { markdown?: string } } };
      guidanceText?: string;
      imperativeVerbs?: { positive?: string[] };
      perFieldContract?: Record<string, unknown>;
      failureModeCatalog?: unknown[];
      preSubmitChecklist?: unknown[];
    };
    expect(frontLoad).toBeTruthy();

    // grep 整份 briefing JSON（含 hostAgentContract + submissionSchema 镜像）——三要素必须同时在场。
    const json = JSON.stringify(withFrontLoad);
    // (a) worked example object present and NOT stripped
    expect(json).toContain('OrderRepository');
    expect(json).toContain('✅');
    expect(json).toContain('❌');
    expect(frontLoad.workedExample?.candidate?.content?.markdown).toContain('✅');
    expect(frontLoad.workedExample?.candidate?.content?.markdown).toContain('❌');
    // (b) literal allowlisted verbs in the doClause guidance
    expect(json).toContain('use, validate');
    expect(frontLoad.imperativeVerbs?.positive).toEqual(
      expect.arrayContaining(['use', 'validate', 'prefer'])
    );
    // (c) the scope: narrow (file-local) evidence-floor escape text
    expect(json).toContain('scope: narrow');
    expect(frontLoad.guidanceText).toContain('scope: narrow');

    // P2.4：失败模式目录 + pre-submit 清单单源自规范模块（failureModes / buildPreSubmitChecklist）。
    expect(frontLoad.perFieldContract).toBeTruthy();
    expect((frontLoad.failureModeCatalog || []).length).toBeGreaterThan(0);
    expect((frontLoad.preSubmitChecklist || []).length).toBeGreaterThan(0);
  });
});
