/**
 * recipe-gate-golden-corpus.test.ts — the P1 byte-identical ORACLE (CG-3).
 *
 * 该测试枚举 P0 truth-matrix 中每一个 reject code（stage 1 + stage 2），各给出一个
 * 通过样本与一个失败样本，并用 toMatchSnapshot() 锁定当前 gate 的**逐字节**违规输出。
 *
 * 工作顺序：先在旧的 inline 实现上运行，生成 __snapshots__ 基线；P1.1/P1.2 把 gate
 * 改成 validateAgainst 之后，再次运行**必须**对同一快照保持绿色（逐字节一致）。任何字节
 * 差异都意味着某个值被「重新解释」而非「搬运」，应停止并上报，禁止 --update 抹平。
 *
 * stage-2 的 fs-bound code（SOURCE_REF_NOT_FOUND / LINE_OUT_OF_RANGE / SNIPPET_MISMATCH /
 * INSUFFICIENT_EVIDENCE）用 mkdtemp 真实临时文件触发，确保确定性。SESSION_NOT_FOUND /
 * WRONG_SCOPE 通过 session 入参驱动（运行时 session 端口）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BootstrapSessionLike,
  validateRecipeProductionEvidenceGate,
} from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';
import { validateSubmitKnowledgeContentQuality } from '../../lib/runtime/mcp/handlers/recipe-content-quality-gate.js';

// ════════════════════════════ Stage 1 corpus ════════════════════════════
//
// 每条 item 单独跑 gate，便于把违规数组按 reject code 命名快照（一个失败 + 一个通过）。

const STAGE1_PASS = {
  doClause: 'Use the AlembicPlugin gateway for every submission',
  dontClause: 'Do not bypass the gateway with a direct write',
  content: {
    markdown: ['Project guidance close-up.', '✅ create via the gateway', '❌ write straight to disk'].join(
      '\n'
    ),
  },
} as const;

const STAGE1_CASES: Array<{ name: string; item: Record<string, unknown> }> = [
  // PASSING baseline — must produce an empty violation array.
  { name: 'pass-clean-recipe', item: { ...STAGE1_PASS } },
  // DO_CLAUSE_REQUIRED + DONT_CLAUSE_REQUIRED (+ CONTENT_MARKDOWN_REQUIRED) — empty item.
  { name: 'fail-clauses-required', item: {} },
  // DO_CLAUSE_NON_ENGLISH — doClause uses Han script.
  {
    name: 'fail-do-non-english',
    item: { ...STAGE1_PASS, doClause: '使用网关提交知识' },
  },
  // DONT_CLAUSE_NON_ENGLISH — dontClause uses Han script.
  {
    name: 'fail-dont-non-english',
    item: { ...STAGE1_PASS, dontClause: '不要绕过网关' },
  },
  // DO_CLAUSE_NON_IMPERATIVE — doClause first word not in the positive verb allowlist.
  {
    name: 'fail-do-non-imperative',
    item: { ...STAGE1_PASS, doClause: 'Frobnicate the gateway payload' },
  },
  // DONT_CLAUSE_NON_IMPERATIVE — dontClause first word not in the negative verb allowlist.
  {
    name: 'fail-dont-non-imperative',
    item: { ...STAGE1_PASS, dontClause: 'Frobnicate the direct write' },
  },
  // CONTENT_MARKDOWN_REQUIRED — clauses valid, content.markdown missing.
  {
    name: 'fail-content-markdown-required',
    item: { doClause: STAGE1_PASS.doClause, dontClause: STAGE1_PASS.dontClause },
  },
  // CONTENT_CONTRAST_MISSING — markdown present but lacks one of ✅ / ❌ with ≥4 trailing chars.
  {
    name: 'fail-content-contrast-missing',
    item: {
      doClause: STAGE1_PASS.doClause,
      dontClause: STAGE1_PASS.dontClause,
      content: { markdown: 'Only a ✅ correct example here, no forbidden counterexample.' },
    },
  },
];

describe('recipe-gate golden corpus — stage 1 content-quality', () => {
  for (const testCase of STAGE1_CASES) {
    it(`stage1/${testCase.name}`, () => {
      const result = validateSubmitKnowledgeContentQuality([testCase.item]);
      // 整个 GateResult（ok + violations）一起快照，锁定逐字节行为。
      expect(result).toMatchSnapshot();
    });
  }
});

// ════════════════════════════ Stage 2 corpus ════════════════════════════
//
// stage-2 gate 是 cold-start-only、依赖 fs 与 bootstrap session 的运行时门禁。
// 这里用真实临时项目根目录 + 真实文件触发所有 fs-bound code。

let stage2Root: string;

function makeStage2Root(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-gate-corpus-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  // a.ts：含一段可被 snippet 精确匹配的「真实」代码。
  fs.writeFileSync(
    path.join(root, 'lib', 'a.ts'),
    ['export function alpha() {', '  return doRealThing(payload);', '}', ''].join('\n')
  );
  // b.ts / c.ts：让 rule/pattern 的 ≥3 distinct files 门槛可被满足或缺一。
  fs.writeFileSync(path.join(root, 'lib', 'b.ts'), ['const beta = 1;', 'const gamma = 2;', ''].join('\n'));
  fs.writeFileSync(path.join(root, 'lib', 'c.ts'), ['const delta = 3;', ''].join('\n'));
  return root;
}

function stage2Session(projectRoot: string): BootstrapSessionLike {
  return {
    id: 'session-corpus',
    projectRoot,
    dimensions: [{ id: 'architecture' }],
  };
}

beforeAll(() => {
  stage2Root = makeStage2Root();
});

afterAll(() => {
  if (stage2Root) {
    fs.rmSync(stage2Root, { recursive: true, force: true });
  }
});

interface Stage2Case {
  name: string;
  args?: Record<string, unknown>;
  item: Record<string, unknown>;
  session: (projectRoot: string) => BootstrapSessionLike | null;
  // 部分 case 需要与 session 不同的 projectRoot（WRONG_SCOPE）。
  projectRootOverride?: 'other';
}

const stage2Cases: Stage2Case[] = [
  // PASSING baseline — fact candidate with a real source ref + matching snippet.
  {
    name: 'pass-fact-evidence',
    item: {
      title: 'Fact alpha',
      kind: 'fact',
      sourceRefs: ['lib/a.ts:1-3'],
      coreCode: 'return doRealThing(payload);',
      reasoning: { sources: ['lib/a.ts:1-3'] },
    },
    session: stage2Session,
  },
  // SESSION_NOT_FOUND — gate runs (args.dimensionId) but no session bound.
  {
    name: 'fail-session-not-found',
    args: { dimensionId: 'architecture' },
    item: { title: 'No session', kind: 'fact', sourceRefs: ['lib/a.ts:1-3'], coreCode: 'return doRealThing(payload);' },
    session: () => null,
  },
  // WRONG_SCOPE — session projectRoot differs from the submission projectRoot.
  {
    name: 'fail-wrong-scope',
    args: { dimensionId: 'architecture' },
    item: { title: 'Wrong scope', kind: 'fact', sourceRefs: ['lib/a.ts:1-3'], coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
    projectRootOverride: 'other',
  },
  // SOURCE_REFS_MISSING — no sourceRefs / reasoning.sources at all.
  {
    name: 'fail-source-refs-missing',
    item: { title: 'No refs', kind: 'fact', coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
  },
  // SOURCE_REF_LINE_MISSING — ref without a line/range.
  {
    name: 'fail-source-ref-line-missing',
    item: { title: 'Bare ref', kind: 'fact', sourceRefs: ['lib/a.ts'], coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
  },
  // SOURCE_REF_INVALID — absolute path escapes the project root.
  {
    name: 'fail-source-ref-invalid',
    item: { title: 'Absolute ref', kind: 'fact', sourceRefs: ['/etc/passwd:1'], coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
  },
  // SOURCE_REF_NOT_FOUND — repo-relative ref to a non-existent file.
  {
    name: 'fail-source-ref-not-found',
    item: { title: 'Missing file', kind: 'fact', sourceRefs: ['lib/missing.ts:1'], coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
  },
  // SOURCE_REF_LINE_OUT_OF_RANGE — line range beyond the file length.
  {
    name: 'fail-source-ref-line-out-of-range',
    item: { title: 'Out of range', kind: 'fact', sourceRefs: ['lib/a.ts:1-999'], coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
  },
  // SNIPPET_MISMATCH — valid ref but the coreCode does not appear in the cited range.
  {
    name: 'fail-snippet-mismatch',
    item: { title: 'Snippet mismatch', kind: 'fact', sourceRefs: ['lib/a.ts:1-3'], coreCode: 'const totallyUnrelated = neverAppearsHere();' },
    session: stage2Session,
  },
  // PLACEHOLDER_EVIDENCE — coreCode is placeholder text.
  {
    name: 'fail-placeholder-evidence',
    item: { title: 'Placeholder', kind: 'fact', sourceRefs: ['lib/a.ts:1-3'], coreCode: 'await operation()' },
    session: stage2Session,
  },
  // INSUFFICIENT_EVIDENCE — rule candidate with only one distinct source file (<3).
  {
    name: 'fail-insufficient-evidence',
    item: { title: 'Thin rule', kind: 'rule', sourceRefs: ['lib/a.ts:1-3'], coreCode: 'return doRealThing(payload);' },
    session: stage2Session,
  },
  // GRAPH_REF_INVALID — relationship claim without graph refs.
  {
    name: 'fail-graph-ref-invalid',
    item: {
      title: 'Relationship claim',
      kind: 'rule',
      description: 'This rule describes the call chain and upstream depends on relationship.',
      sourceRefs: ['lib/a.ts:1-3', 'lib/b.ts:1-2', 'lib/c.ts:1-1'],
      coreCode: 'return doRealThing(payload);',
    },
    session: stage2Session,
  },
  // STALE_GRAPH — relationship claim with a stale graph ref.
  {
    name: 'fail-stale-graph',
    item: {
      title: 'Stale graph',
      kind: 'rule',
      sourceGraphRefs: ['source-graph:stale:abc'],
      relationshipClaim: true,
      sourceRefs: ['lib/a.ts:1-3', 'lib/b.ts:1-2', 'lib/c.ts:1-1'],
      coreCode: 'return doRealThing(payload);',
    },
    session: stage2Session,
  },
];

describe('recipe-gate golden corpus — stage 2 evidence', () => {
  for (const testCase of stage2Cases) {
    it(`stage2/${testCase.name}`, () => {
      const sessionRoot = stage2Root;
      const otherRoot =
        testCase.projectRootOverride === 'other'
          ? fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-gate-corpus-other-'))
          : undefined;
      // session 绑定 sessionRoot；提交 projectRoot 在 WRONG_SCOPE 用例下故意不同。
      const submissionRoot = otherRoot ?? sessionRoot;
      try {
        const result = validateRecipeProductionEvidenceGate({
          args: testCase.args ?? {},
          items: [testCase.item],
          projectRoot: submissionRoot,
          session: testCase.session(sessionRoot),
          skipConsolidation: true,
        });
        // 只快照 ok + 违规数组（剔除随临时目录变化的 acceptedEvidence 绝对路径），
        // 因为 acceptedEvidence.referencedFiles 是 repo-relative，但 sessionId 等稳定。
        expect({ ok: result.ok, violations: result.violations }).toMatchSnapshot();
      } finally {
        if (otherRoot) {
          fs.rmSync(otherRoot, { recursive: true, force: true });
        }
      }
    });
  }
});
