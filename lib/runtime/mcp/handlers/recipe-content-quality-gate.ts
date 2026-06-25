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

const NON_ENGLISH_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FIRST_WORD_RE = /^[\s"'`([{]*([A-Za-z]+(?:'[A-Za-z]+)?)/u;

const POSITIVE_IMPERATIVE_VERBS = new Set([
  'add',
  'align',
  'bind',
  'build',
  'call',
  'check',
  'cite',
  'collect',
  'compare',
  'configure',
  'copy',
  'create',
  'derive',
  'dispatch',
  'ensure',
  'expose',
  'fetch',
  'follow',
  'guard',
  'handle',
  'include',
  'inject',
  'keep',
  'load',
  'map',
  'normalize',
  'pass',
  'prefer',
  'preserve',
  'query',
  'read',
  'record',
  'reject',
  'require',
  'resolve',
  'return',
  'route',
  'run',
  'select',
  'store',
  'submit',
  'update',
  'use',
  'validate',
  'write',
]);

const NEGATIVE_IMPERATIVE_VERBS = new Set([
  'avoid',
  'block',
  'do',
  'exclude',
  'forbid',
  'keep',
  'omit',
  'prevent',
  'reject',
  'remove',
  'skip',
  'stop',
]);

export function validateSubmitKnowledgeContentQuality(
  items: Array<Record<string, unknown>>
): RecipeContentQualityGateResult {
  const violations = items.flatMap((item, itemIndex) => [
    ...validateClause(item, itemIndex, 'doClause'),
    ...validateClause(item, itemIndex, 'dontClause'),
    ...validateContentContrast(item, itemIndex),
  ]);
  return { ok: violations.length === 0, violations };
}

function validateClause(
  item: Record<string, unknown>,
  itemIndex: number,
  field: 'doClause' | 'dontClause'
): RecipeContentQualityViolation[] {
  const value = item[field];
  const label = field === 'doClause' ? 'doClause' : 'dontClause';
  const codePrefix = field === 'doClause' ? 'DO_CLAUSE' : 'DONT_CLAUSE';
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [
      violation({
        code: `${codePrefix}_REQUIRED` as RecipeContentQualityViolationCode,
        field,
        itemIndex,
        message: `${label} is required.`,
        nextAction:
          field === 'doClause'
            ? 'Rewrite doClause as an English imperative clause that starts with a command verb, e.g. "Use ...".'
            : 'Rewrite dontClause as an English negative imperative clause, e.g. "Do not ..." or "Avoid ...".',
      }),
    ];
  }

  if (NON_ENGLISH_SCRIPT_RE.test(value)) {
    return [
      violation({
        code: `${codePrefix}_NON_ENGLISH` as RecipeContentQualityViolationCode,
        field,
        itemIndex,
        message: `${label} contains non-English script.`,
        nextAction:
          field === 'doClause'
            ? 'Translate doClause into an English imperative clause that starts with a command verb.'
            : 'Translate dontClause into an English negative imperative clause such as "Do not ..." or "Avoid ...".',
      }),
    ];
  }

  if (!isImperativeVerbLeading(value, field)) {
    return [
      violation({
        code: `${codePrefix}_NON_IMPERATIVE` as RecipeContentQualityViolationCode,
        field,
        itemIndex,
        message: `${label} is not verb-leading imperative guidance.`,
        nextAction:
          field === 'doClause'
            ? 'Start doClause with an imperative verb such as Use, Prefer, Validate, Keep, or Require.'
            : 'Start dontClause with Do not, Avoid, Prevent, Reject, or another negative imperative verb.',
      }),
    ];
  }

  return [];
}

function isImperativeVerbLeading(value: string, field: 'doClause' | 'dontClause'): boolean {
  const firstWord = value.match(FIRST_WORD_RE)?.[1]?.toLowerCase();
  if (!firstWord) {
    return false;
  }
  if (field === 'doClause') {
    return POSITIVE_IMPERATIVE_VERBS.has(firstWord);
  }
  if (firstWord === 'do') {
    return /^["'`([{]*do\s+not\b/iu.test(value.trim());
  }
  return NEGATIVE_IMPERATIVE_VERBS.has(firstWord);
}

function validateContentContrast(
  item: Record<string, unknown>,
  itemIndex: number
): RecipeContentQualityViolation[] {
  const markdown = readContentMarkdown(item.content);
  if (!markdown) {
    return [
      violation({
        code: 'CONTENT_MARKDOWN_REQUIRED',
        field: 'content.markdown',
        itemIndex,
        message: 'content.markdown is required for project close-up guidance.',
        nextAction:
          'Provide content.markdown with project-specific guidance and a ✅ correct / ❌ forbidden contrast.',
      }),
    ];
  }
  if (!hasMarkerExample(markdown, '✅') || !hasMarkerExample(markdown, '❌')) {
    return [
      violation({
        code: 'CONTENT_CONTRAST_MISSING',
        field: 'content.markdown',
        itemIndex,
        message: 'content.markdown must include both ✅ and ❌ project-specific examples.',
        nextAction:
          'Add a consistent contrast in content.markdown: one ✅ correct project-specific example and one ❌ forbidden counterexample.',
      }),
    ];
  }
  return [];
}

function readContentMarkdown(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const markdown = (value as { markdown?: unknown }).markdown;
  return typeof markdown === 'string' && markdown.trim().length > 0 ? markdown : null;
}

function hasMarkerExample(markdown: string, marker: '✅' | '❌'): boolean {
  return markdown.split(/\r?\n/u).some((line) => {
    const index = line.indexOf(marker);
    return index >= 0 && line.slice(index + marker.length).trim().length >= 4;
  });
}

function violation(input: RecipeContentQualityViolation): RecipeContentQualityViolation {
  return input;
}
