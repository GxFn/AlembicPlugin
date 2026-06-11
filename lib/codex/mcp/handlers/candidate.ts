/**
 * MCP Handlers — 候选校验 (V3)
 * validateCandidate, checkDuplicate
 *
 * 注意: submitSingle, submitBatch, submitDrafts 已移至 V3 knowledge handlers
 *       (alembic_submit_knowledge / submit_knowledge_batch / knowledge_lifecycle)
 */

import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { envelope } from '../envelope.js';
import type {
  CandidateInput,
  CheckDuplicateArgs,
  McpContext,
  ValidateCandidateArgs,
} from './types.js';

type CandidateValidationSuggestion = { field: string; value: string };

interface CandidateValidationBuckets {
  errors: string[];
  warnings: string[];
  suggestions: CandidateValidationSuggestion[];
}

// ─── 校验 & 去重 ───────────────────────────────────────────

export async function validateCandidate(ctx: McpContext, args: ValidateCandidateArgs) {
  // Cast to CandidateInput — Agent input is runtime-dynamic, validation checks shape
  const c = (args.candidate || {}) as CandidateInput;
  const buckets: CandidateValidationBuckets = {
    errors: [],
    warnings: [],
    suggestions: [],
  };

  addCoreFieldFindings(c, args.strict, buckets);
  addClassificationFindings(c, buckets);
  addDocumentationFindings(c, buckets);
  addStructuredContentFindings(c, buckets);
  addConstraintFindings(c, buckets);
  addReasoningFindings(c, buckets);

  const ok = buckets.errors.length === 0;
  return envelope({
    success: ok,
    data: {
      ok,
      errors: buckets.errors,
      warnings: buckets.warnings,
      suggestions: buckets.suggestions,
    },
    meta: { tool: 'alembic_validate_candidate' },
  });
}

function addCoreFieldFindings(
  c: CandidateInput,
  strict: boolean | undefined,
  buckets: CandidateValidationBuckets
) {
  if (!c.title?.trim()) {
    buckets.errors.push('缺少 title');
  }
  if (!c.code?.trim() && strict) {
    buckets.errors.push('strict 模式下需要 code');
  }
  if (!c.language) {
    buckets.warnings.push('缺少 language');
  }
}

function addClassificationFindings(c: CandidateInput, buckets: CandidateValidationBuckets) {
  if (!c.category) {
    buckets.warnings.push('缺少 category');
  }
  if (!c.knowledgeType) {
    buckets.warnings.push('缺少 knowledgeType（code-pattern/architecture/best-practice/...）');
  }
  if (!c.complexity) {
    buckets.suggestions.push({ field: 'complexity', value: 'intermediate' });
  }
}

function addDocumentationFindings(c: CandidateInput, buckets: CandidateValidationBuckets) {
  if (!c.trigger?.trim()) {
    buckets.warnings.push('缺少 trigger（建议 @ 开头）');
  }
  if (c.trigger && !c.trigger.startsWith('@')) {
    buckets.suggestions.push({ field: 'trigger', value: `@${c.trigger.replace(/^@+/, '')}` });
  }
  if (!c.summary?.trim() && !c.description?.trim()) {
    buckets.warnings.push('缺少 summary 或 description');
  }
  if (!c.usageGuide?.trim()) {
    buckets.warnings.push('缺少 usageGuide');
  }
}

function addStructuredContentFindings(c: CandidateInput, buckets: CandidateValidationBuckets) {
  if (!c.rationale) {
    buckets.warnings.push('缺少 rationale（设计原理）');
  }
  if (!Array.isArray(c.headers) || c.headers.length === 0) {
    buckets.warnings.push('缺少 headers（import 声明）');
  }
  if (!c.steps && !c.codeChanges) {
    buckets.suggestions.push({ field: 'steps', value: '[{title, description, code}]' });
  }
}

function addConstraintFindings(c: CandidateInput, buckets: CandidateValidationBuckets) {
  if (!c.constraints) {
    buckets.suggestions.push({
      field: 'constraints',
      value: '{boundaries[], preconditions[], sideEffects[], guards[]}',
    });
  }
}

function addReasoningFindings(c: CandidateInput, buckets: CandidateValidationBuckets) {
  if (!c.reasoning) {
    buckets.errors.push('缺少 reasoning（推理依据 — whyStandard + sources + confidence）');
    return;
  }
  if (!c.reasoning.whyStandard?.trim()) {
    buckets.errors.push('reasoning.whyStandard 不能为空');
  }
  if (!Array.isArray(c.reasoning.sources) || c.reasoning.sources.length === 0) {
    buckets.errors.push('reasoning.sources 至少包含一项来源');
  }
  if (
    typeof c.reasoning.confidence !== 'number' ||
    c.reasoning.confidence < 0 ||
    c.reasoning.confidence > 1
  ) {
    buckets.warnings.push('reasoning.confidence 应为 0-1 的数字');
  }
}

export async function checkDuplicate(ctx: McpContext, args: CheckDuplicateArgs) {
  // SimilarityService 直接读磁盘 .md 文件，不依赖 Repository
  const { findSimilarRecipes } = await import('@alembic/core/service/candidate');
  const dataRoot = resolveDataRoot(ctx.container as never) || resolveProjectRoot(ctx.container);
  const candidate = (args.candidate ?? {}) as {
    title: string;
    code: string;
    summary?: string;
    [key: string]: unknown;
  };
  const similar = findSimilarRecipes(dataRoot, candidate, {
    threshold: args.threshold ?? 0.7,
    topK: args.topK ?? 5,
  });
  return envelope({
    success: true,
    data: { similar },
    meta: { tool: 'alembic_check_duplicate' },
  });
}
