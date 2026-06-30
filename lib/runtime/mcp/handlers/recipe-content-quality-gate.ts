// P1.1 re-point (CG-3, byte-identical):本 stage-1 门禁不再内联校验逻辑，而是委托给 Core 的
// 权威 RecipeAuthoringSpec —— validateAgainst(stage 1)。Core 模块里的常量/谓词（verb Sets、
// NON_ENGLISH_SCRIPT_RE、FIRST_WORD_RE、hasMarkerExample、✅/❌ 阈值）是 P0 从本文件原样
// 搬运（controller-verified byte-identical）的副本，因此「搬运而非重写」保证输出逐字节一致：
// 同一 Set、同一 regex、同一谓词 ⇒ 同一违规数组（含 code / field / itemIndex / message / nextAction
// 与 per-item 顺序）。golden-corpus 快照在旧 inline 实现上生成，re-point 后必须保持绿色。
import { validateAgainst } from '@alembic/core/knowledge';

export type RecipeContentQualityViolationCode =
  | 'CONTENT_CONTRAST_MISSING'
  | 'CONTENT_MARKDOWN_REQUIRED'
  | 'DO_CLAUSE_NON_ENGLISH'
  | 'DO_CLAUSE_NON_IMPERATIVE'
  | 'DO_CLAUSE_REQUIRED'
  | 'DONT_CLAUSE_NON_ENGLISH'
  | 'DONT_CLAUSE_NON_IMPERATIVE'
  | 'DONT_CLAUSE_REQUIRED';

export interface RecipeContentQualityViolation {
  code: RecipeContentQualityViolationCode;
  field: 'content.markdown' | 'doClause' | 'dontClause';
  itemIndex: number;
  message: string;
  nextAction: string;
}

export interface RecipeContentQualityGateResult {
  ok: boolean;
  violations: RecipeContentQualityViolation[];
}

export function validateSubmitKnowledgeContentQuality(
  items: Array<Record<string, unknown>>
): RecipeContentQualityGateResult {
  // Core 的 stage-1 违规对象与本地 RecipeContentQualityViolation 形状完全一致（code/field/
  // itemIndex/message/nextAction）；Core 的 field 是 string，这里 cast 回更窄的本地联合类型，
  // 仅为满足 TS（运行时取值同样落在该联合内），不改变任何字节。
  const violations = validateAgainst(items, {
    stage: 1,
    path: 'host-cold-start',
  }) as unknown as RecipeContentQualityViolation[];
  return { ok: violations.length === 0, violations };
}
