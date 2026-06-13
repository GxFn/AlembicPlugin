import fs from 'node:fs';
import path from 'node:path';
import { getOrCreateSessionManager } from '@alembic/core/host-agent-workflows';

export type RecipeEvidenceViolationCode =
  | 'SESSION_NOT_FOUND'
  | 'WRONG_SCOPE'
  | 'SOURCE_REFS_MISSING'
  | 'SOURCE_REF_BARE'
  | 'SOURCE_REF_INVALID'
  | 'SOURCE_REF_NOT_FOUND'
  | 'SOURCE_REF_LINE_MISSING'
  | 'SOURCE_REF_LINE_OUT_OF_RANGE'
  | 'SNIPPET_MISMATCH'
  | 'PLACEHOLDER_EVIDENCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'GRAPH_REF_INVALID'
  | 'STALE_GRAPH'
  | 'QUALITY_GATE_FAILED'
  | 'DIMENSION_CANDIDATE_COUNT_INSUFFICIENT'
  | 'DIMENSION_REFERENCED_FILES_MISSING'
  | 'DIMENSION_KEY_FINDINGS_INSUFFICIENT'
  | 'DIMENSION_ANALYSIS_TEXT_INSUFFICIENT'
  | 'DIMENSION_RECIPE_ID_NOT_BOUND';

export interface RecipeEvidenceViolation {
  code: RecipeEvidenceViolationCode;
  message: string;
  itemIndex?: number;
  title?: string;
  sourceRef?: string;
  path?: string;
  nextAction: string;
}

export interface RecipeEvidenceGateResult {
  acceptedEvidence?: Record<string, unknown>;
  ok: boolean;
  violations: RecipeEvidenceViolation[];
}

export interface BootstrapSessionLike {
  id: string;
  projectRoot: string;
  dimensions?: Array<{ id: string }>;
  submissionTracker?: {
    buildQualityReport?(
      dimId: string,
      analysisText?: string,
      referencedFiles?: string[]
    ): DimensionQualityReportLike;
    getAllSubmittedTitles?(): Set<string>;
    getAllSubmittedTriggers?(): Set<string>;
    getSubmissions?(dimId: string): Array<{ recipeId?: string; sources?: string[] }>;
  };
}

export interface DimensionQualityReportLike {
  pass: boolean;
  scores?: Record<string, number>;
  suggestions?: string[];
  totalScore?: number;
}

interface SourceRefEvidence {
  filePath: string;
  raw: string;
  rangeText: string;
  sourcePath: string;
}

export function resolveBootstrapSession(
  container: {
    get(name: string): unknown;
    register?: (name: string, factory: () => unknown) => void;
  },
  sessionId?: string
): BootstrapSessionLike | null {
  try {
    const sessionManager = getOrCreateSessionManager(container as never);
    const session = sessionManager.getSession(sessionId);
    return isBootstrapSessionLike(session) ? session : null;
  } catch {
    return null;
  }
}

export function shouldRunRecipeEvidenceGate({
  args,
  items,
  session,
}: {
  args: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  session: BootstrapSessionLike | null;
}): boolean {
  if (session) {
    return true;
  }
  if (typeof args.sessionId === 'string' || typeof args.bootstrapSessionRef === 'string') {
    return true;
  }
  if (typeof args.dimensionId === 'string') {
    return true;
  }
  return items.some((item) => typeof item.dimensionId === 'string');
}

export function validateRecipeProductionEvidenceGate({
  args,
  items,
  projectRoot,
  session,
  skipConsolidation,
}: {
  args: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  projectRoot: string;
  session: BootstrapSessionLike | null;
  skipConsolidation: boolean;
}): RecipeEvidenceGateResult {
  const dimensionId = firstString(args.dimensionId, ...items.map((item) => item.dimensionId));
  const itemResults = items.map((item, index) =>
    validateRecipeItemEvidence({ item: item ?? {}, itemIndex: index, projectRoot })
  );
  const violations = [
    ...validateRecipeSessionScope({ dimensionId, projectRoot, session }),
    ...itemResults.flatMap((result) => result.violations),
  ];
  const acceptedFiles = new Set(itemResults.flatMap((result) => result.sourcePaths));

  return {
    ok: violations.length === 0,
    violations,
    acceptedEvidence:
      violations.length === 0
        ? {
            dimensionId,
            itemCount: items.length,
            referencedFiles: [...acceptedFiles].sort(),
            sessionId: session?.id,
            skipConsolidationChecked: skipConsolidation,
          }
        : undefined,
  };
}

function validateRecipeSessionScope({
  dimensionId,
  projectRoot,
  session,
}: {
  dimensionId?: string;
  projectRoot: string;
  session: BootstrapSessionLike | null;
}): RecipeEvidenceViolation[] {
  const violations: RecipeEvidenceViolation[] = [];
  if (!session) {
    violations.push({
      code: 'SESSION_NOT_FOUND',
      message: 'No active bootstrap session is bound to this host-agent Recipe submission.',
      nextAction: 'Call alembic_bootstrap and resubmit with the active bootstrap session id.',
    });
  } else {
    if (!samePath(session.projectRoot, projectRoot)) {
      violations.push({
        code: 'WRONG_SCOPE',
        message: `Bootstrap session projectRoot does not match this MCP project root.`,
        nextAction:
          'Restart bootstrap in the same project scope before submitting Recipe evidence.',
      });
    }
    if (
      dimensionId &&
      Array.isArray(session.dimensions) &&
      !session.dimensions.some((dimension) => dimension.id === dimensionId)
    ) {
      violations.push({
        code: 'WRONG_SCOPE',
        message: `dimensionId "${dimensionId}" is not part of the active bootstrap session.`,
        nextAction: 'Use a dimension id from the active bootstrap session.',
      });
    }
  }
  return violations;
}

function validateRecipeItemEvidence({
  item,
  itemIndex,
  projectRoot,
}: {
  item: Record<string, unknown>;
  itemIndex: number;
  projectRoot: string;
}): { sourcePaths: string[]; violations: RecipeEvidenceViolation[] } {
  const title = stringValue(item.title) || '(untitled)';
  const sourceRefs = collectSourceRefs(item);
  const violations: RecipeEvidenceViolation[] = [];
  const validRefs: SourceRefEvidence[] = [];

  if (sourceRefs.length === 0) {
    violations.push({
      code: 'SOURCE_REFS_MISSING',
      itemIndex,
      title,
      message: 'Recipe candidate has no concrete sourceRefs or reasoning.sources.',
      nextAction: 'Add repo-relative source refs with line ranges for the cited source evidence.',
    });
  }

  for (const sourceRef of sourceRefs) {
    const parsed = validateSourceRef({ projectRoot, sourceRef, itemIndex, title });
    if ('violation' in parsed) {
      violations.push(parsed.violation);
    } else {
      validRefs.push(parsed.evidence);
    }
  }

  violations.push(
    ...validateCodeSnippets({ itemIndex, snippets: collectCodeEvidence(item), title, validRefs })
  );
  violations.push(...validateEvidenceFloor({ item, itemIndex, title, validRefs }));

  const graphIssue = validateGraphEvidence(item);
  if (graphIssue) {
    violations.push({
      ...graphIssue,
      itemIndex,
      title,
    });
  }

  return {
    sourcePaths: validRefs.map((ref) => ref.sourcePath),
    violations,
  };
}

function validateCodeSnippets({
  itemIndex,
  snippets,
  title,
  validRefs,
}: {
  itemIndex: number;
  snippets: string[];
  title: string;
  validRefs: SourceRefEvidence[];
}): RecipeEvidenceViolation[] {
  const violations: RecipeEvidenceViolation[] = [];
  for (const snippet of snippets) {
    if (looksLikePlaceholder(snippet)) {
      violations.push({
        code: 'PLACEHOLDER_EVIDENCE',
        itemIndex,
        title,
        message: 'Recipe candidate contains placeholder code instead of project source evidence.',
        nextAction: 'Replace placeholder snippets with code copied from the cited source range.',
      });
      continue;
    }
    if (
      validRefs.length > 0 &&
      !validRefs.some((ref) => snippetMatchesSourceRange(snippet, ref.rangeText))
    ) {
      violations.push({
        code: 'SNIPPET_MISMATCH',
        itemIndex,
        title,
        message: 'Recipe code evidence does not match any cited source line range.',
        nextAction: 'Cite the exact source line range that contains the submitted code snippet.',
      });
    }
  }
  return violations;
}

function validateEvidenceFloor({
  item,
  itemIndex,
  title,
  validRefs,
}: {
  item: Record<string, unknown>;
  itemIndex: number;
  title: string;
  validRefs: SourceRefEvidence[];
}): RecipeEvidenceViolation[] {
  const distinctFiles = new Set(validRefs.map((ref) => ref.sourcePath));
  if (requiresMultiFileEvidence(item) && distinctFiles.size < 3) {
    return [
      {
        code: 'INSUFFICIENT_EVIDENCE',
        itemIndex,
        title,
        message:
          'Rule/pattern candidates require at least three distinct source files unless explicitly scoped narrower.',
        nextAction:
          'Add at least three distinct repo-relative file references, or declare scope: "narrow" / "file-local" for a legitimately local rule.',
      },
    ];
  }
  if (isFactCandidate(item) && distinctFiles.size < 1) {
    return [
      {
        code: 'INSUFFICIENT_EVIDENCE',
        itemIndex,
        title,
        message: 'Fact candidates require at least one precise source reference.',
        nextAction: 'Add a repo-relative source reference with a valid line range.',
      },
    ];
  }
  return [];
}

export function previewDimensionQualityReport({
  analysisText,
  dimensionId,
  referencedFiles,
  session,
}: {
  analysisText: string;
  dimensionId: string;
  referencedFiles: string[];
  session: BootstrapSessionLike;
}): DimensionQualityReportLike | undefined {
  try {
    return session.submissionTracker?.buildQualityReport?.(
      dimensionId,
      analysisText,
      referencedFiles
    );
  } catch {
    return undefined;
  }
}

export function validateDimensionCompletionEvidenceGate({
  analysisText,
  candidateCount,
  dimensionId,
  keyFindings,
  qualityReport,
  referencedFiles,
  session,
  submittedRecipeIds,
}: {
  analysisText: string;
  candidateCount?: number;
  dimensionId: string;
  keyFindings: string[];
  qualityReport?: DimensionQualityReportLike;
  referencedFiles: string[];
  session: BootstrapSessionLike;
  submittedRecipeIds: string[];
}): RecipeEvidenceGateResult {
  const violations: RecipeEvidenceViolation[] = [];
  const submissions = safeGetSubmissions(session, dimensionId);
  const sessionRecipeIds = new Set(
    submissions.map((submission) => submission.recipeId).filter((id): id is string => Boolean(id))
  );
  const effectiveRecipeIds = uniqueStrings(
    submittedRecipeIds.length > 0 ? submittedRecipeIds : [...sessionRecipeIds]
  );
  const submissionFiles = new Set(
    submissions.flatMap((submission) =>
      (submission.sources || []).map((source) => source.split(':')[0]).filter(Boolean)
    )
  );
  const effectiveReferencedFiles = uniqueStrings(
    referencedFiles.length > 0 ? referencedFiles : [...submissionFiles]
  );

  if (effectiveRecipeIds.length === 0) {
    violations.push({
      code: 'DIMENSION_RECIPE_ID_NOT_BOUND',
      message: 'dimension_complete has no session-bound Recipe ids.',
      nextAction:
        'Submit valid Recipes through alembic_submit_knowledge before completing the dimension.',
    });
  }
  for (const recipeId of effectiveRecipeIds) {
    if (!sessionRecipeIds.has(recipeId)) {
      violations.push({
        code: 'DIMENSION_RECIPE_ID_NOT_BOUND',
        message: `Recipe id "${recipeId}" was not created or recovered in this bootstrap session.`,
        nextAction:
          'Use only Recipe ids returned by this session-bound alembic_submit_knowledge loop.',
      });
    }
  }

  const verifiedCandidateCount = effectiveRecipeIds.length;
  if (verifiedCandidateCount < 3) {
    violations.push({
      code: 'DIMENSION_CANDIDATE_COUNT_INSUFFICIENT',
      message: `Only ${verifiedCandidateCount} session-bound Recipes were verified; at least 3 are required.`,
      nextAction: 'Create more session-bound Recipes with concrete source evidence.',
    });
  }
  if (typeof candidateCount === 'number' && candidateCount > verifiedCandidateCount) {
    violations.push({
      code: 'DIMENSION_RECIPE_ID_NOT_BOUND',
      message: `candidateCount=${candidateCount} exceeds the ${verifiedCandidateCount} verified session-bound Recipe ids.`,
      nextAction: 'Do not use candidateCount as completion proof; provide the actual Recipe ids.',
    });
  }

  if (effectiveReferencedFiles.length === 0) {
    violations.push({
      code: 'DIMENSION_REFERENCED_FILES_MISSING',
      message: 'dimension_complete has no referencedFiles and no recoverable submission files.',
      nextAction: 'Provide repo-relative referencedFiles that overlap the submitted Recipes.',
    });
  } else if (
    submissionFiles.size > 0 &&
    !effectiveReferencedFiles.some((file) => submissionFiles.has(file))
  ) {
    violations.push({
      code: 'DIMENSION_REFERENCED_FILES_MISSING',
      message:
        'dimension_complete referencedFiles do not overlap session-bound Recipe source refs.',
      nextAction:
        'Use referencedFiles from the submitted Recipes so completion is tied to source evidence.',
    });
  }

  const concreteFindings = keyFindings.filter((finding) => finding.trim().length >= 20);
  if (concreteFindings.length < 3) {
    violations.push({
      code: 'DIMENSION_KEY_FINDINGS_INSUFFICIENT',
      message: 'dimension_complete requires at least three concrete keyFindings.',
      nextAction: 'Summarize at least three source-grounded findings from the completed dimension.',
    });
  }
  if (analysisText.trim().length < 500) {
    violations.push({
      code: 'DIMENSION_ANALYSIS_TEXT_INSUFFICIENT',
      message: 'dimension_complete analysisText is too short for a production Recipe loop.',
      nextAction: 'Provide a detailed source-grounded analysis with cited files and findings.',
    });
  }
  if (qualityReport && !qualityReport.pass) {
    violations.push({
      code: 'QUALITY_GATE_FAILED',
      message: `Dimension quality report failed${typeof qualityReport.totalScore === 'number' ? ` with score ${qualityReport.totalScore}` : ''}.`,
      nextAction: 'Repair the dimension evidence until the host-agent quality report passes.',
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    acceptedEvidence:
      violations.length === 0
        ? {
            analysisChars: analysisText.length,
            dimensionId,
            keyFindingCount: concreteFindings.length,
            recipeIds: effectiveRecipeIds,
            referencedFiles: effectiveReferencedFiles,
            sessionId: session.id,
            verifiedCandidateCount,
          }
        : undefined,
  };
}

export function buildEvidenceGateFailureData(result: RecipeEvidenceGateResult) {
  return {
    evidenceGate: {
      status: 'rebuild-required',
      violationCount: result.violations.length,
      violations: result.violations,
    },
    rejectedItems: result.violations.map((violation) => ({
      code: violation.code,
      index: violation.itemIndex,
      nextAction: violation.nextAction,
      sourceRef: violation.sourceRef,
      title: violation.title,
    })),
  };
}

export function primaryEvidenceGateCode(result: RecipeEvidenceGateResult): string {
  return result.violations[0]?.code || 'QUALITY_GATE_FAILED';
}

function validateSourceRef({
  itemIndex,
  projectRoot,
  sourceRef,
  title,
}:
  | {
      itemIndex: number;
      projectRoot: string;
      sourceRef: string;
      title: string;
    }
  | never): { evidence: SourceRefEvidence } | { violation: RecipeEvidenceViolation } {
  const cleaned = cleanSourceRef(sourceRef);
  const match = cleaned.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!match) {
    return {
      violation: {
        code: 'SOURCE_REF_LINE_MISSING',
        itemIndex,
        sourceRef,
        title,
        message: 'Source ref must include a line or line range.',
        nextAction: 'Use repo-relative refs such as lib/module/file.ts:10-18.',
      },
    };
  }

  const rawPath = match[1] ?? '';
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  const sourcePath = path.posix.normalize(rawPath.replaceAll('\\', '/'));
  if (path.isAbsolute(sourcePath) || sourcePath.startsWith('..')) {
    return {
      violation: {
        code: 'SOURCE_REF_INVALID',
        itemIndex,
        sourceRef,
        title,
        message: 'Source ref must stay inside the project source root.',
        nextAction: 'Use a repo-relative source path under the current project.',
      },
    };
  }

  const absolutePath = path.resolve(projectRoot, sourcePath);
  if (!isInsideRoot(projectRoot, absolutePath)) {
    return {
      violation: {
        code: 'SOURCE_REF_INVALID',
        itemIndex,
        path: sourcePath,
        sourceRef,
        title,
        message: 'Source ref resolves outside the project source root.',
        nextAction: 'Use a source path under the current project root.',
      },
    };
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return {
      violation: {
        code: 'SOURCE_REF_NOT_FOUND',
        itemIndex,
        path: sourcePath,
        sourceRef,
        title,
        message: 'Source ref file does not exist.',
        nextAction: 'Check the repo-relative path and cite an existing source file.',
      },
    };
  }
  const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    return {
      violation: {
        code: 'SOURCE_REF_LINE_OUT_OF_RANGE',
        itemIndex,
        path: sourcePath,
        sourceRef,
        title,
        message: 'Source ref line range is outside the file.',
        nextAction: 'Use a valid line range from the current source file.',
      },
    };
  }

  return {
    evidence: {
      filePath: absolutePath,
      raw: cleaned,
      rangeText: lines.slice(startLine - 1, endLine).join('\n'),
      sourcePath,
    },
  };
}

function collectSourceRefs(item: Record<string, unknown>): string[] {
  const refs = [
    ...stringArray(item.sourceRefs),
    ...stringArray(asRecord(item.reasoning)?.sources),
    ...stringArray(item.sourceRef),
  ];
  return uniqueStrings(refs.map(cleanSourceRef).filter(Boolean));
}

function collectCodeEvidence(item: Record<string, unknown>): string[] {
  const content = asRecord(item.content);
  const markdown = stringValue(content?.markdown) || '';
  const fenced = markdown.match(/```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)```/);
  return uniqueStrings(
    [stringValue(item.coreCode), stringValue(content?.pattern), fenced?.[1]].filter(
      (value): value is string => Boolean(value?.trim())
    )
  );
}

function validateGraphEvidence(
  item: Record<string, unknown>
): Omit<RecipeEvidenceViolation, 'itemIndex' | 'title'> | null {
  if (!hasRelationshipClaim(item)) {
    return null;
  }
  const refs = [
    ...stringArray(item.graphRefs),
    ...stringArray(item.sourceGraphRefs),
    ...stringArray(asRecord(item.relations)?.graphRefs),
    ...stringArray(asRecord(item.relationships)?.graphRefs),
    ...stringArray(asRecord(item.reasoning)?.graphRefs),
  ];
  if (refs.length === 0) {
    return {
      code: 'GRAPH_REF_INVALID',
      message: 'Relationship claims require graph-backed refs.',
      nextAction:
        'Attach sourceGraph refs from a fresh graph query or remove the relationship claim.',
    };
  }
  if (refs.some((ref) => /\bstale\b|\bpartial\b|\bpending\b/i.test(ref))) {
    return {
      code: 'STALE_GRAPH',
      message: 'Relationship evidence refers to stale or partial graph data.',
      nextAction: 'Refresh the source graph and cite fresh graph refs before submitting.',
    };
  }
  return null;
}

function hasRelationshipClaim(item: Record<string, unknown>): boolean {
  if (
    item.graphRefs ||
    item.sourceGraphRefs ||
    item.relations ||
    item.relationships ||
    item.relationshipClaim === true ||
    item.requiresGraphEvidence === true ||
    item.relationshipEvidenceRequired === true
  ) {
    return true;
  }
  const text = [
    stringValue(item.description),
    stringValue(asRecord(item.content)?.markdown),
    stringValue(asRecord(item.reasoning)?.whyStandard),
  ]
    .filter(Boolean)
    .join('\n');
  return (
    /\b(call chain|caller|callee|called by|depends on|impact path|relationship|invokes)\b/i.test(
      text
    ) || /调用链|调用方|被调用|依赖|影响路径|关系|上游|下游/.test(text)
  );
}

function requiresMultiFileEvidence(item: Record<string, unknown>): boolean {
  const kind = stringValue(item.kind)?.toLowerCase();
  if (kind !== 'rule' && kind !== 'pattern') {
    return false;
  }
  const scope = stringValue(item.scope)?.toLowerCase() || '';
  return !/\b(single-file|file-local|local-only|narrow)\b/.test(scope);
}

function isFactCandidate(item: Record<string, unknown>): boolean {
  return stringValue(item.kind)?.toLowerCase() === 'fact';
}

function safeGetSubmissions(
  session: BootstrapSessionLike,
  dimensionId: string
): Array<{ recipeId?: string; sources?: string[] }> {
  try {
    return session.submissionTracker?.getSubmissions?.(dimensionId) || [];
  } catch {
    return [];
  }
}

function looksLikePlaceholder(value: string): boolean {
  return [
    /\bawait\s+operation\s*\(/i,
    /\boperation\s*\(/i,
    /\bdoThing\b/,
    /\bfoo\b/i,
    /\bbar\b/i,
    /\bTODO\b/,
  ].some((pattern) => pattern.test(value));
}

function normalizedCode(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function snippetMatchesSourceRange(snippet: string, rangeText: string): boolean {
  const source = normalizedCode(rangeText);
  const candidate = normalizedCode(snippet);
  if (candidate.length > 0 && source.includes(candidate)) {
    return true;
  }
  const sourceLines = rangeText.split(/\r?\n/).map(normalizedCode).filter(Boolean);
  const significantSnippetLines = snippet
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/|#)\s*/, '').trim())
    .filter((line) => !/^(?:[{}()[\],;]|\.\.\.)*$/.test(line))
    .map(normalizedCode)
    .filter((line) => line.length >= 6);
  if (significantSnippetLines.length === 0) {
    return false;
  }

  let sourceCursor = 0;
  for (const snippetLine of significantSnippetLines) {
    const nextIndex = sourceLines.findIndex(
      (line, index) =>
        index >= sourceCursor && (line.includes(snippetLine) || snippetLine.includes(line))
    );
    if (nextIndex < 0) {
      return false;
    }
    sourceCursor = nextIndex + 1;
  }
  return true;
}

function cleanSourceRef(value: string): string {
  return value
    .trim()
    .replace(/^[`(["']+/, '')
    .replace(/[`)!"',.;]+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    );
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value];
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBootstrapSessionLike(value: unknown): value is BootstrapSessionLike {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as BootstrapSessionLike).id === 'string' &&
    typeof (value as BootstrapSessionLike).projectRoot === 'string'
  );
}
