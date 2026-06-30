/**
 * recipe-gate-drift-tripwire.test.ts — P1.5 per-rule drift tripwire.
 *
 * 把 gate 行为依赖的「权威常量」快照下来：任何未来对 Core gateRules 的编辑只要改动了
 * imperative verb allowlist 或 evidence-floor 策略，本快照就会**大声失败**，从而把「门禁值漂移」
 * 变成可见的回归，而不是悄悄改变 Plugin 的拒绝行为。常量来源是 Core 的 @alembic/core/knowledge，
 * 即 Plugin gate re-point 后真正消费的同一张表。
 */
import { describe, expect, it } from 'vitest';
import {
  describeSubmitToolFields,
  getEvidenceFloorPolicy,
  getImperativeVerbAllowlist,
  validateAgainst,
} from '@alembic/core/knowledge';
import type { RecipeSessionScope } from '@alembic/core/knowledge';
import { attachRecipeAuthoringFrontLoad } from '#recipe-generation/host-agent-workflows/cold-start.js';
import {
  type BootstrapSessionLike,
  createSessionScope,
  createSourceRefResolver,
  validateRecipeProductionEvidenceGate,
} from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';
import { validateSubmitKnowledgeContentQuality } from '#codex/mcp/handlers/recipe-content-quality-gate.js';
import { buildColdStartOnboardingContract } from '#codex/status/OnboardingContract.js';
import { SubmitKnowledgeItemSchema } from '#shared/schemas/mcp-tools.js';

describe('recipe-gate drift tripwire — lifted gate constants', () => {
  it('imperative verb allowlist is stable (positive + negative Sets)', () => {
    const allowlist = getImperativeVerbAllowlist();
    // 一并断言数量（从 Set 派生，不硬编码字面数字）+ 完整列表，双重锁定。
    expect({
      positiveCount: allowlist.positive.length,
      negativeCount: allowlist.negative.length,
      positive: allowlist.positive,
      negative: allowlist.negative,
    }).toMatchSnapshot();
  });

  it('evidence-floor policy is stable (distinct-file floors + scope-escape)', () => {
    const policy = getEvidenceFloorPolicy();
    expect({
      ruleFiles: policy.ruleFiles,
      factFiles: policy.factFiles,
      // RegExp 用 source/flags 快照，避免对象序列化差异。
      scopeEscapeSource: policy.scopeEscape.source,
      scopeEscapeFlags: policy.scopeEscape.flags,
    }).toMatchSnapshot();
  });
});

describe('recipe-gate sessionScope port — Core contract', () => {
  it('createSessionScope satisfies RecipeSessionScope and surfaces SESSION_NOT_FOUND', () => {
    // 端口必须满足 Core 的 RecipeSessionScope 接口（编译期 + 运行期）。
    const port: RecipeSessionScope = createSessionScope({
      dimensionId: 'architecture',
      projectRoot: '/tmp/project',
      session: null,
    });
    const result = port({ projectRoot: '/tmp/project', dimensionId: 'architecture', itemIndex: 0, title: 't' });
    expect('violation' in result).toBe(true);
    if ('violation' in result) {
      expect(result.violation.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('createSessionScope returns ok when the session matches scope', () => {
    const session: BootstrapSessionLike = {
      id: 'session-1',
      projectRoot: '/tmp/project',
      dimensions: [{ id: 'architecture' }],
    };
    const port = createSessionScope({
      dimensionId: 'architecture',
      projectRoot: '/tmp/project',
      session,
    });
    const result = port({ projectRoot: '/tmp/project', dimensionId: 'architecture', itemIndex: 0, title: 't' });
    expect(result).toEqual({ ok: true });
  });

  it('validateAgainst can consume the sessionScope port (single-violation path)', () => {
    // 证明端口与 Core validateAgainst 形状兼容：注入后单条 session 违规会被 Core 采纳。
    const port = createSessionScope({
      dimensionId: 'architecture',
      projectRoot: '/tmp/project',
      session: null,
    });
    const out = validateAgainst([{ title: 'x', kind: 'fact', sourceRefs: ['lib/a.ts:1'] }], {
      stage: 2,
      path: 'host-cold-start',
      sessionScope: port,
      projectRoot: '/tmp/project',
      dimensionId: 'architecture',
    });
    expect(out[0]?.code).toBe('SESSION_NOT_FOUND');
  });
});

/**
 * P4 wave 2 — Plugin-consumer guidance==gate drift (design A.6 / B-P4.1)。
 *
 * 证明 Plugin RENDERED guidance（OnboardingContract / cold-start front-load / mcp-tools describe）
 * 列出的动词/证据下限/逃逸/confidence 全部直接读自 Core 的同一张 gateRules 表，**绝不**硬编码副本、
 * 绝不 vague 'verb-led'、绝不残留 confidence 硬阈值。这同时充当 A.6 #1「imports-allowlist guard」：
 * 任何 Plugin 重新声明 allowlist 的漂移都会让本套件大声失败。
 */
describe('P4 Plugin-consumer guidance==gate parity (A.6)', () => {
  const coreVerbs = getImperativeVerbAllowlist();
  const coreFloor = getEvidenceFloorPolicy();

  // 取冷启动 onboarding 的 hostAgentContract（含 submitKnowledgeContract / recipeGuidanceFloor）。
  // 最小入参（仅 projectRoot），渲染面来自 Core 规范模块。
  function hostAgentContract(): Record<string, unknown> {
    const contract = buildColdStartOnboardingContract({ projectRoot: '/tmp/p4-parity-project' });
    return contract.hostAgentContract as Record<string, unknown>;
  }

  it('OnboardingContract.submitKnowledgeContract lists EXACTLY the Core verb allowlist (A.6 #1 imports-allowlist guard)', () => {
    const skc = hostAgentContract().submitKnowledgeContract as {
      imperativeVerbs: { positive: string[]; negative: string[] };
    };
    // 逐字节等于 Core 表（非硬编码副本）；并锁定 45/12（与 P0 oracle 一致）。
    expect(skc.imperativeVerbs.positive).toEqual(coreVerbs.positive);
    expect(skc.imperativeVerbs.negative).toEqual(coreVerbs.negative);
    expect(skc.imperativeVerbs.positive.length).toBe(45);
    expect(skc.imperativeVerbs.negative.length).toBe(12);
  });

  it('OnboardingContract.submitKnowledgeContract states the Core evidence floor + scope escape', () => {
    const skc = hostAgentContract().submitKnowledgeContract as {
      evidenceFloor: { ruleFiles: number; factFiles: number; scopeEscape: string };
    };
    expect(skc.evidenceFloor.ruleFiles).toBe(coreFloor.ruleFiles);
    expect(skc.evidenceFloor.factFiles).toBe(coreFloor.factFiles);
    expect(skc.evidenceFloor.scopeEscape).toBe(coreFloor.scopeEscape.source);
    // scope 逃逸文案必须真实出现（narrow / file-local），不得被省略。
    expect(skc.evidenceFloor.scopeEscape).toMatch(/narrow|file-local/);
  });

  it('OnboardingContract confidence wording is recommended-not-enforced (D-A), never a hard floor', () => {
    const hac = hostAgentContract();
    // confidence 文案在 submitKnowledgeContract.fieldFloors.confidence / recipeGuidanceFloor.candidateContent。
    const skc = hac.submitKnowledgeContract as { fieldFloors: { confidence?: string } };
    const floor = hac.recipeGuidanceFloor as {
      candidateContent: { confidenceRecommendation?: string };
    };
    const confidence = skc.fieldFloors.confidence;
    expect(confidence).toMatch(/recommended/i);
    expect(confidence).toMatch(/not enforced/i);
    // 反漂移：绝不残留「>=0.85 for normal submit」式硬阈值表述。
    expect(confidence).not.toMatch(/for normal submit|hard floor|\bmust be >=/i);
    expect(floor.candidateContent.confidenceRecommendation).toMatch(/recommended/i);
    expect(floor.candidateContent.confidenceRecommendation).toMatch(/not enforced/i);
  });

  it('OnboardingContract.recipeGuidanceFloor renders verbs + scope-escape from the Core table', () => {
    const floor = hostAgentContract().recipeGuidanceFloor as {
      imperativeVerbs: { positive: string[]; negative: string[] };
      fileReferences: { scopeEscape: string; crossModuleClaimFloor: string };
    };
    expect(floor.imperativeVerbs.positive).toEqual(coreVerbs.positive);
    expect(floor.imperativeVerbs.negative).toEqual(coreVerbs.negative);
    expect(floor.fileReferences.scopeEscape).toBe(coreFloor.scopeEscape.source);
    // crossModuleClaimFloor 文案携带真实 ruleFiles 数字（非硬编码 3）。
    expect(floor.fileReferences.crossModuleClaimFloor).toContain(String(coreFloor.ruleFiles));
  });

  it('cold-start front-load (13.L) renders verbs + evidence floor from the Core table', () => {
    const briefing = {
      hostAgentContract: { contractVersion: 1, source: 'host-agent-plan-neutral-quality-contract' },
      submissionSchema: { requiredFields: ['title'], topLevelFields: ['items'] },
      meta: {},
    };
    const withFrontLoad = attachRecipeAuthoringFrontLoad(briefing);
    const frontLoad = (withFrontLoad.hostAgentContract as { recipeAuthoringFrontLoad?: unknown })
      .recipeAuthoringFrontLoad as {
      imperativeVerbs: { positive: string[]; negative: string[] };
      evidenceFloor: { ruleFiles: number; factFiles: number; scopeEscape: string };
    };
    expect(frontLoad.imperativeVerbs.positive).toEqual(coreVerbs.positive);
    expect(frontLoad.imperativeVerbs.negative).toEqual(coreVerbs.negative);
    expect(frontLoad.evidenceFloor.ruleFiles).toBe(coreFloor.ruleFiles);
    expect(frontLoad.evidenceFloor.factFiles).toBe(coreFloor.factFiles);
    expect(frontLoad.evidenceFloor.scopeEscape).toBe(coreFloor.scopeEscape.source);
  });

  it('mcp-tools submit-knowledge doClause/dontClause describe is Core-spec-derived (not vague verb-led)', () => {
    const specFields = describeSubmitToolFields();
    const shape = SubmitKnowledgeItemSchema.shape as Record<string, { description?: string }>;
    // describeSubmitField 优先取 Core 规范表；证明 describe 串来自 Core（非硬编码、非 vague）。
    if (specFields.doClause) {
      expect(shape.doClause?.description).toBe(specFields.doClause);
    }
    if (specFields.dontClause) {
      expect(shape.dontClause?.description).toBe(specFields.dontClause);
    }
    expect(shape.doClause?.description).toBeTruthy();
  });
});

/**
 * P4 §12.5 host-path parity tripwire —— 证明 Plugin host-path 门禁 wrapper 不篡改它从 Core 拿到的判定。
 *
 * stage-1：validateSubmitKnowledgeContentQuality 的违规数组 === 直调 validateAgainst(stage 1)。
 * stage-2：在 session 合法（无 SESSION/SCOPE 违规、前置为空）时，validateRecipeProductionEvidenceGate
 * 的违规 === 直调 validateAgainst(stage 2, 同 sourceRefResolver + sessionScope 端口)。覆盖纯谓词 +
 * fs-bound（SOURCE_REF_NOT_FOUND 经 resolver）两路。fs byte-identical 全量另由 golden-corpus 锁定。
 */
describe('P4 §12.5 host-path parity tripwire (wrapper verdict == direct Core validateAgainst)', () => {
  it('stage-1 content-quality wrapper does not mutate the Core verdict', () => {
    const items: Array<Record<string, unknown>> = [
      // 一过一拒，混合覆盖；wrapper 仅 {ok, violations} 包裹、不改 violations。
      {
        doClause: 'Use the gateway to submit knowledge',
        dontClause: 'Do not bypass the gateway',
        content: { markdown: '✅ correct gateway usage\n❌ forbidden direct write to store' },
      },
      { doClause: 'Frobnicate the payload' },
      {},
    ];
    const wrapper = validateSubmitKnowledgeContentQuality(items);
    const direct = validateAgainst(items, { stage: 1, path: 'host-cold-start' });
    expect(wrapper.violations).toEqual(direct);
  });

  it('stage-2 evidence wrapper (valid session) does not mutate the Core verdict', () => {
    const projectRoot = '/tmp/p4-parity-stage2';
    const dimensionId = 'architecture';
    const session: BootstrapSessionLike = {
      id: 'session-p4-parity',
      projectRoot,
      dimensions: [{ id: dimensionId }],
    };
    const items: Array<Record<string, unknown>> = [
      // SOURCE_REFS_MISSING（纯）。
      { title: 'a', kind: 'fact', dimensionId, sourceRefs: [] },
      // SOURCE_REF_NOT_FOUND（fs-bound，经注入 resolver；引用 root 下不存在文件）。
      { title: 'b', kind: 'fact', dimensionId, sourceRefs: ['lib/__p4_nonexistent__.ts:1'] },
      // GRAPH_REF_INVALID（纯，relationship 声明缺 graphRefs）。
      {
        title: 'c',
        kind: 'rule',
        dimensionId,
        description: 'This rule describes the call chain and upstream depends on relationship.',
        sourceRefs: ['lib/__p4_nonexistent__.ts:1'],
      },
    ];
    const wrapper = validateRecipeProductionEvidenceGate({
      args: { dimensionId },
      items,
      projectRoot,
      session,
      skipConsolidation: false,
    });
    const direct = validateAgainst(items, {
      stage: 2,
      path: 'host-cold-start',
      sourceRefResolver: createSourceRefResolver(),
      sessionScope: createSessionScope({ dimensionId, projectRoot, session }),
      projectRoot,
      dimensionId,
    });
    // session 合法 ⇒ wrapper 前置 session 违规为空 ⇒ 违规数组应与直调逐字节一致。
    expect(wrapper.violations).toEqual(direct);
  });
});
