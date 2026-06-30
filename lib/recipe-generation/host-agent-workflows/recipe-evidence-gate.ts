// P1.2 re-point (CG-3, byte-identical):本 stage-2 cold-start 门禁的 submit-path 校验不再内联
// 纯谓词（floor 表、snippet 算法、source-ref 格式 regex、placeholder 黑名单、relationship 关键词），
// 改为委托 Core 的权威 RecipeAuthoringSpec —— validateAgainst(stage 2)。这些纯谓词是 P0 从本文件
// 原样搬运到 Core 的副本（controller-verified byte-identical），「搬运而非重写」⇒ 输出逐字节一致。
//
// §C.1 split：两处运行时耦合仍留在 Plugin 侧并以 Core 的 typed port 注入：
//   - sourceRefResolver：包装本文件原有的 fs 读取（existsSync/statSync/readFileSync），拥有
//     SOURCE_REF_INVALID / SOURCE_REF_NOT_FOUND / SOURCE_REF_LINE_OUT_OF_RANGE。
//   - sessionScope：包装 bootstrap-session 作用域校验（SESSION_NOT_FOUND / WRONG_SCOPE）。
// 注意：live 的 validateRecipeProductionEvidenceGate 把违规拼成 [...所有 session 违规, ...所有 item
// 违规]，且 session 检查可一次性产生两条 WRONG_SCOPE。为逐字节保持「session 全部在前」的顺序与
// 双发场景，wrapper 仍由 validateRecipeSessionScope 在 Plugin 侧产出 session 违规并前置，
// 而把 per-item evidence 委托给 validateAgainst（不向其传入 sessionScope，避免 per-item 交错/合并）。
// sessionScope port 仍按 Core 契约构造并由 drift tripwire / 单条路径覆盖，保持端口契约真实可用。
import fs from 'node:fs';
import path from 'node:path';
import { getOrCreateSessionManager } from '@alembic/core/host-agent-workflows';
import type {
  RecipeAuthoringViolation,
  RecipeSessionScope,
  RecipeSourceRefResolver,
} from '@alembic/core/knowledge';
import { validateAgainst } from '@alembic/core/knowledge';

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
  if (args.requireProductionSession === true) {
    return true;
  }
  if (typeof args.dimensionId === 'string') {
    return true;
  }
  return items.some((item) => typeof item.dimensionId === 'string');
}

/**
 * §C.11 sourceRefResolver port — 包装本仓库原有的 on-disk source-ref 读取。
 *
 * Core 的 domain spec 纯解析 ref 形状（regex → {sourcePath, startLine, endLine}），把结果交给
 * 此 host-injected resolver；resolver 拥有 node:path 归一化 + node:fs 读取，并产出
 * SOURCE_REF_INVALID / SOURCE_REF_NOT_FOUND / SOURCE_REF_LINE_OUT_OF_RANGE，或返回校验后的
 * { rangeText, sourcePath } 供纯 snippet/floor 谓词消费。逐字节复刻旧 validateSourceRef 的分支与文案。
 */
function createSourceRefResolver(): RecipeSourceRefResolver {
  return ({
    projectRoot,
    sourcePath: rawPath,
    startLine,
    endLine,
    sourceRef,
    itemIndex,
    title,
  }) => {
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
        raw: sourceRef,
        rangeText: lines.slice(startLine - 1, endLine).join('\n'),
        sourcePath,
      },
    };
  };
}

/**
 * §C.11 sessionScope port — 包装 bootstrap-session 作用域校验（SESSION_NOT_FOUND / WRONG_SCOPE）。
 *
 * 注意：live wrapper 的 session 检查可一次性产出两条 WRONG_SCOPE（projectRoot 不符 + dimension 不符），
 * 且必须整体排在所有 item 违规之前。Core 的单违规 port 无法表达「双发 + 全部前置」，因此 submit-path
 * 仍由 validateRecipeSessionScope 在 wrapper 侧产出并前置；此 port 仅返回首个 session 违规，
 * 用于满足 Core 端口契约与 drift tripwire 的真实可用性（不参与 submit-path 的逐字节排序）。
 */
function createSessionScope(args: {
  dimensionId?: string;
  projectRoot: string;
  session: BootstrapSessionLike | null;
}): RecipeSessionScope {
  return () => {
    const violations = validateRecipeSessionScope({
      dimensionId: args.dimensionId,
      projectRoot: args.projectRoot,
      session: args.session,
    });
    const first = violations[0];
    if (first) {
      return { violation: first as unknown as RecipeAuthoringViolation };
    }
    return { ok: true };
  };
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

  // session 违规由 Plugin 侧产出并整体前置（保持 live 的「session 全部在前」顺序与双发 WRONG_SCOPE）。
  const sessionViolations = validateRecipeSessionScope({ dimensionId, projectRoot, session });

  // per-item 纯 evidence 谓词委托 Core 的 validateAgainst(stage 2)；fs 读取经注入的
  // sourceRefResolver 完成。closure 捕获每个 ref 的 sourcePath，重建 acceptedEvidence.referencedFiles。
  const acceptedFiles = new Set<string>();
  const sourceRefResolver: RecipeSourceRefResolver = (input) => {
    const resolved = createSourceRefResolver()(input);
    if ('evidence' in resolved) {
      acceptedFiles.add(resolved.evidence.sourcePath);
    }
    return resolved;
  };

  const itemViolations = validateAgainst(items, {
    stage: 2,
    path: 'host-cold-start',
    sourceRefResolver,
    projectRoot,
  }) as unknown as RecipeEvidenceViolation[];

  const violations = [...sessionViolations, ...itemViolations];

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

// createSessionScope 端口暴露给 drift tripwire / 单条 cold-start 路径，保持端口契约真实可用。
export { createSessionScope, createSourceRefResolver };
