/**
 * MCP Handlers — Guard 审计 & 项目扫描
 *
 * 内部入口：alembic_code_guard 的 check/review（legacy alembic_guard 工具已删，MTC-7）
 *   无参数         → 结构化阻塞（旧 whole-diff fallback 已禁用）
 *   files: string[] → 指定文件检查（+ inline recipe）
 *   code: string    → 单文件内联检查
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { LanguageService } from '@alembic/core/shared';
import {
  type CollectionCoverage,
  type ConclusionDisposition,
  deriveConclusionDisposition,
} from '#service/project-knowledge-context/contracts/ToolOutputPrimitives.js';
import { envelope } from '../envelope.js';
import { type McpContext, requireRequestProjectRuntime } from './types.js';

// ─── Local Types ──────────────────────────────────────────

export interface GuardViolation {
  ruleId: string;
  message: string;
  severity: string;
  line?: number;
  snippet?: string;
  fixSuggestion?: string | null;
  [key: string]: unknown;
}

interface GuardAuditFileResult {
  filePath: string;
  language: string;
  violations: GuardViolation[];
  uncertainResults?: unknown[];
  summary: { total: number; errors: number; warnings: number; uncertain?: number };
}

interface GuardAuditResult {
  summary: { total: number; errors: number; warnings: number; [key: string]: unknown };
  files: GuardAuditFileResult[];
  crossFileViolations?: unknown[];
  capabilityReport?: {
    executedChecks: Record<string, { total: number; executed: number; skipped: number }>;
    skippedChecks: unknown[];
    boundaries: unknown[];
    uncertainResults: Array<{
      ruleId: string;
      message: string;
      layer: string;
      reason: string;
      detail: string;
    }>;
    checkCoverage: number;
  };
}

interface GuardViolationEnriched {
  ruleId: string;
  message: string;
  severity: string;
  line?: number;
  snippet?: string;
  fixSuggestion: string | null;
  recipe?: {
    title: string;
    doClause: string | null;
    dontClause: string | null;
    coreCode: string | null;
  };
}

export interface ReviewFileResult {
  filePath: string;
  language?: string;
  violations: GuardViolationEnriched[];
  summary: { total: number; errors: number; warnings: number };
  error?: string;
}

type GuardFileDisposition = 'checked' | 'missing' | 'unreadable' | 'out-of-root' | 'unsupported';

interface GuardFileCoverageRow {
  requestedPath: string;
  filePath: string;
  disposition: GuardFileDisposition;
  message?: string;
}

interface GuardReviewCoverage extends CollectionCoverage {
  checked: number;
  missing: number;
  unreadable: number;
  outOfRoot: number;
  unsupported: number;
}

interface RecipeEntry {
  title: string;
  doClause: string | null;
  dontClause: string | null;
  coreCode: string | null;
}

interface GuardEngineLike {
  checkCode(code: string, language: string, opts?: Record<string, unknown>): GuardViolation[];
  /** G2：与检查同源的规则装配面（数据库 Recipe 规则 + 内置）；旧引擎可缺席 */
  getRules?(language: string | null): Array<Record<string, unknown>>;
  auditFile(
    filePath: string,
    code: string,
    options?: Record<string, unknown>
  ): {
    filePath: string;
    language: string;
    violations: GuardViolation[];
    uncertainResults: unknown[];
    summary: { total: number; errors: number; warnings: number; uncertain: number };
  };
  auditFiles(
    files: Array<{ path: string; content: string; isTest?: boolean }>,
    opts: Record<string, unknown>
  ): GuardAuditResult;
  injectExternalRules(rules: unknown[]): void;
  isEpInjected?(): boolean;
  markEpInjected?(): void;
}

interface GuardCheckArgs {
  code?: string;
  language?: string;
  filePath?: string;
  [key: string]: unknown;
}

interface GuardAuditArgs {
  files: Array<{ path: string; content?: string }>;
  scope?: string;
  [key: string]: unknown;
}

interface GuardReviewArgs {
  files?: Array<string | { path?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ScanProjectArgs {
  maxFiles?: number;
  includeContent?: boolean;
  contentMaxLines?: number;
  [key: string]: unknown;
}

interface ScanFileEntry {
  name: string;
  path: string;
  relativePath: string;
  targetName: string;
  content?: string;
  totalLines?: number;
  truncated?: boolean;
}

interface ModuleServiceLike {
  load(): Promise<void>;
  listTargets(): Promise<
    Array<{ name: string; type?: string; packageName?: string; [key: string]: unknown }>
  >;
  getTargetFiles(target: Record<string, unknown>): Promise<
    Array<{
      name: string;
      path: string;
      relativePath?: string;
      size?: number;
      [key: string]: unknown;
    }>
  >;
}

export async function guardCheck(ctx: McpContext, args: GuardCheckArgs) {
  const { GuardCheckEngine, detectLanguage } = await import('@alembic/core/guard');

  // 输入校验：空代码直接返回
  if (!args.code || !args.code.trim()) {
    return envelope({
      success: true,
      data: {
        language: args.language || 'unknown',
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      },
      meta: { tool: 'alembic_code_guard', note: 'Empty code — skipped' },
    });
  }

  const engine = _getOrCreateEngine(ctx, GuardCheckEngine);

  // 注入 Enhancement Pack Guard 规则
  await _injectEnhancementGuardRules(engine, ctx);

  const language = args.language || detectLanguage(args.filePath || '');
  const violations = engine.checkCode(args.code, language);

  // ── SkillHooks: onGuardCheck — 允许 hooks 修改 violations ──
  try {
    const skillHooks = ctx.container.get('skillHooks');
    if (skillHooks.has('onGuardCheck')) {
      for (let i = 0; i < violations.length; i++) {
        const modified = await skillHooks.run('onGuardCheck', violations[i], { language });
        if (modified && typeof modified === 'object') {
          violations[i] = modified;
        }
      }
    }
  } catch {
    /* skillHooks not available */
  }

  const warnings: '未能识别语言，部分语言相关规则可能未执行。建议提供 language 或 filePath 参数。'[] =
    [];
  if (language === 'unknown') {
    warnings.push('未能识别语言，部分语言相关规则可能未执行。建议提供 language 或 filePath 参数。');
  }

  // D4:code 模式补 appliedRules——engine.checkCode 同源规则装配面按本次语言枚举,
  // 让 0 violations 可判读(与 review 模式 G2 摘要同形)。
  const appliedRules = summarizeAppliedGuardRules(engine, [{ language }]);

  return envelope({
    success: true,
    data: {
      language,
      violations,
      summary: {
        total: violations.length,
        errors: violations.filter((v: GuardViolation) => v.severity === 'error').length,
        warnings: violations.filter((v: GuardViolation) => v.severity === 'warning').length,
      },
      ...(appliedRules ? { appliedRules } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
    meta: { tool: 'alembic_code_guard' },
  });
}

export async function guardAuditFiles(ctx: McpContext, args: GuardAuditArgs) {
  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw new Error('files array is required and must not be empty');
  }
  const scope = args.scope || 'project';

  const { GuardCheckEngine } = await import('@alembic/core/guard');
  const engine = _getOrCreateEngine(ctx, GuardCheckEngine);

  // 注入 Enhancement Pack Guard 规则
  await _injectEnhancementGuardRules(engine, ctx);

  // 解析项目根路径（用于相对路径转绝对路径）
  const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;

  // 补充缺失的 content（从磁盘读取）
  // 相对路径自动转绝对路径，避免 MCP 进程 cwd 不在项目目录时读不到文件
  const filesToAudit = await Promise.all(
    args.files.map(async (f: { path: string; content?: string }) => {
      const absPath = path.isAbsolute(f.path) ? f.path : path.resolve(projectRoot, f.path);
      let content = f.content;
      if (!content) {
        try {
          content = await readFile(absPath, 'utf8');
        } catch {
          content = '';
        }
      }
      return { path: absPath, content, isTest: LanguageService.isTestFile(absPath) };
    })
  );

  const result = engine.auditFiles(filesToAudit, { scope });

  // 写入 ViolationsStore + GuardFeedbackLoop
  try {
    const violationsStore = ctx.container.get('violationsStore');
    for (const fileResult of result.files || []) {
      if (fileResult.violations.length > 0) {
        violationsStore.appendRun({
          filePath: fileResult.filePath,
          violations: fileResult.violations,
          summary: `MCP audit (${scope}): ${fileResult.summary.errors}E ${fileResult.summary.warnings}W`,
        });
      }

      // Guard ↔ Recipe 闭环：检测修复并自动确认使用
      try {
        const feedbackLoop = ctx.container.get('guardFeedbackLoop');
        feedbackLoop.processFixDetection(fileResult, fileResult.filePath);
      } catch {
        /* guardFeedbackLoop not available */
      }
    }
  } catch {
    /* ViolationsStore not available */
  }

  // D4:audit 模式补 appliedRules(按被审文件语言集合枚举实际装载规则)。
  const appliedRules = summarizeAppliedGuardRules(engine, result.files ?? []);

  return envelope({
    success: true,
    data: {
      summary: result.summary,
      ...(appliedRules ? { appliedRules } : {}),
      files: result.files.map((f: GuardAuditFileResult) => ({
        filePath: f.filePath,
        language: f.language,
        violations: f.violations,
        summary: f.summary,
      })),
      ...(result.crossFileViolations?.length
        ? { crossFileViolations: result.crossFileViolations }
        : {}),
      // uncertain 消费链路 — 结构化上抛给 Agent
      ...(result.capabilityReport
        ? {
            capabilityReport: result.capabilityReport,
            uncertainSummary: {
              total: result.capabilityReport.uncertainResults.length,
              byLayer: _groupBy(result.capabilityReport.uncertainResults, 'layer'),
              byReason: _groupBy(result.capabilityReport.uncertainResults, 'reason'),
            },
            boundaries: result.capabilityReport.boundaries,
          }
        : {}),
    },
    meta: { tool: 'alembic_code_guard' },
  });
}

// ═══ Review 模式 — 编码后质量门禁（必须显式传入 files） ═══

/**
 * Guard Review — 编码后的代码质量检查
 *
 * 设计要点:
 *   1. 无参数 → 结构化阻塞，不再自动读取整个 git diff
 *   2. files: string[] → 指定文件路径（简化，不再要求对象数组）
 *   3. violations 按实际可用性携带 inline Recipe 或 fixSuggestion，并公开指导覆盖计数
 *   4. Review 是无状态检查；不会用 projectRoot 共享轮次或在上限后强制通过
 *   5. 不绑定 task ID — 代码检查独立于任务系统
 *
 * @param ctx MCP context with container
 * @param args { files?: string[] }
 */
export async function guardReview(ctx: McpContext, args: GuardReviewArgs) {
  const { GuardCheckEngine } = await import('@alembic/core/guard');

  const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;

  if (!args.files || !Array.isArray(args.files) || args.files.length === 0) {
    return envelope({
      success: false,
      data: {
        blocked: true,
        legacyBoundary: {
          noArgsWholeDiffDisabled: true,
          replacementTool: 'alembic_code_guard',
          tool: 'alembic_code_guard',
        },
        reasonCode: 'missing-guard-scope',
        required: {
          files: 'explicit task-scoped file list',
          inlineCode: 'or pass code/filePath/language through alembic_code_guard',
        },
      },
      message:
        'No-args whole-diff review is disabled. Call alembic_code_guard with explicit files or inline code.',
      errorCode: 'GUARD_SCOPE_REQUIRED',
      meta: { tool: 'alembic_code_guard', mode: 'review', legacyCompatibility: true },
    });
  }
  const physicalProjectRoot = await realpath(projectRoot);

  // Review 不携带可验证的 task/work/content identity 时，跨调用轮次会把无关请求
  // 串在一起。保持无状态比 projectRoot 级计数更诚实；未来若要轮次限制，必须由
  // 显式 receipt/workRef + content digest 驱动，且达到上限只能 blocked。
  const round = 1;
  const maxRoundsReached = false;

  // 1. 每个请求路径都保留一行 coverage；禁止先过滤再假装“没有文件”。
  const requestedFiles = args.files.map(
    (file: string | { path?: string; [key: string]: unknown }) =>
      typeof file === 'string' ? file : file.path || String(file)
  );
  const coverageRows: GuardFileCoverageRow[] = [];
  const readableFiles: Array<{
    code: string;
    coverage: GuardFileCoverageRow;
    filePath: string;
  }> = [];
  const results: ReviewFileResult[] = [];

  for (const requestedPath of requestedFiles) {
    const filePath = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(projectRoot, requestedPath);
    const relative = path.relative(projectRoot, filePath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition: 'out-of-root',
        message: 'Requested path is outside the active project root.',
      };
      coverageRows.push(row);
      results.push({
        filePath,
        error: row.message,
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      });
      continue;
    }

    let physicalFilePath: string;
    try {
      await lstat(filePath);
      physicalFilePath = await realpath(filePath);
    } catch (err: unknown) {
      const code = isNodeErrorWithCode(err) ? err.code : '';
      const disposition: GuardFileDisposition = code === 'ENOENT' ? 'missing' : 'unreadable';
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition,
        message:
          disposition === 'missing' ? 'Requested file does not exist.' : guardErrorMessage(err),
      };
      coverageRows.push(row);
      results.push({
        filePath,
        error: row.message,
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      });
      continue;
    }

    const physicalRelative = path.relative(physicalProjectRoot, physicalFilePath);
    if (
      physicalRelative.startsWith(`..${path.sep}`) ||
      physicalRelative === '..' ||
      path.isAbsolute(physicalRelative)
    ) {
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition: 'out-of-root',
        message: 'Requested path resolves outside the active project root.',
      };
      coverageRows.push(row);
      results.push({
        filePath,
        error: row.message,
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      });
      continue;
    }

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(physicalFilePath);
    } catch (err: unknown) {
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition: 'unreadable',
        message: guardErrorMessage(err),
      };
      coverageRows.push(row);
      results.push({
        filePath,
        error: row.message,
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      });
      continue;
    }

    if (!fileStat.isFile()) {
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition: 'unsupported',
        message: 'Requested path is not a regular file.',
      };
      coverageRows.push(row);
      results.push({
        filePath,
        error: row.message,
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      });
      continue;
    }

    try {
      const code = await readFile(physicalFilePath, 'utf8');
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition: 'checked',
      };
      coverageRows.push(row);
      readableFiles.push({ code, coverage: row, filePath });
    } catch (err: unknown) {
      const row: GuardFileCoverageRow = {
        requestedPath,
        filePath,
        disposition: 'unreadable',
        message: guardErrorMessage(err),
      };
      coverageRows.push(row);
      results.push({
        filePath,
        error: row.message,
        violations: [],
        summary: { total: 0, errors: 0, warnings: 0 },
      });
    }
  }
  const fileSource = 'explicit';

  // 2. 预加载 rule recipe 缓存
  const recipeMap = await _loadRuleRecipes(ctx);

  // 3. 创建引擎，注入 Enhancement Pack
  const engine = _getOrCreateEngine(ctx, GuardCheckEngine);
  await _injectEnhancementGuardRules(engine, ctx);

  // 4. 一次批量检查完整 covered file set，保留 Core cross-file 结论。
  let totalViolations = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  const allUncertainResults: unknown[] = [];
  let crossFileViolations: GuardViolationEnriched[] = [];

  if (readableFiles.length > 0) {
    try {
      const auditResult = engine.auditFiles(
        readableFiles.map((file) => ({
          path: file.filePath,
          content: file.code,
          isTest: LanguageService.isTestFile(file.filePath),
        })),
        { scope: 'project' }
      );

      for (const fileResult of auditResult.files ?? []) {
        const violations = fileResult.violations ?? [];
        if (fileResult.uncertainResults?.length) {
          allUncertainResults.push(...fileResult.uncertainResults);
        }
        const fileSummary = {
          total: violations.length,
          errors: violations.filter((violation) => violation.severity === 'error').length,
          warnings: violations.filter((violation) => violation.severity === 'warning').length,
        };
        totalViolations += fileSummary.total;
        totalErrors += fileSummary.errors;
        totalWarnings += fileSummary.warnings;
        results.push({
          filePath: fileResult.filePath,
          language: fileResult.language,
          violations: violations.map((violation) => enrichGuardViolation(violation, recipeMap)),
          summary: fileSummary,
        });
      }

      crossFileViolations = (auditResult.crossFileViolations ?? []).map((violation) =>
        enrichGuardViolation(violation as GuardViolation, recipeMap)
      );
      totalViolations += crossFileViolations.length;
      totalErrors += crossFileViolations.filter(
        (violation) => violation.severity === 'error'
      ).length;
      totalWarnings += crossFileViolations.filter(
        (violation) => violation.severity === 'warning'
      ).length;
      if (auditResult.capabilityReport?.uncertainResults?.length) {
        allUncertainResults.push(...auditResult.capabilityReport.uncertainResults);
      }
    } catch (err: unknown) {
      for (const readable of readableFiles) {
        readable.coverage.disposition = 'unsupported';
        readable.coverage.message = guardErrorMessage(err);
        results.push({
          filePath: readable.filePath,
          error: readable.coverage.message,
          violations: [],
          summary: { total: 0, errors: 0, warnings: 0 },
        });
      }
    }
  }

  const checked = coverageRows.filter((row) => row.disposition === 'checked').length;
  const missing = coverageRows.filter((row) => row.disposition === 'missing').length;
  const unreadable = coverageRows.filter((row) => row.disposition === 'unreadable').length;
  const outOfRoot = coverageRows.filter((row) => row.disposition === 'out-of-root').length;
  const unsupported = coverageRows.filter((row) => row.disposition === 'unsupported').length;
  const coverage: GuardReviewCoverage = {
    scope: 'files',
    requested: coverageRows.length,
    attempted: coverageRows.length - outOfRoot,
    succeeded: checked,
    failed: missing + unreadable + unsupported,
    omitted: outOfRoot,
    completeness: checked === coverageRows.length ? 'complete' : 'partial',
    checked,
    missing,
    unreadable,
    outOfRoot,
    unsupported,
  };
  const verdict: ConclusionDisposition = deriveConclusionDisposition({
    blockingFailure: outOfRoot > 0,
    coverage,
    hasFailure: totalViolations > 0 || allUncertainResults.length > 0,
  });
  const passed = verdict === 'passed';

  // G2 守门正面清单（2026-07-06）：0 violations 时宿主无法区分"检查了且干净"与
  // "没什么可检查"——按被检文件语言集合枚举引擎实际装载的规则（数据库 Recipe
  // 规则 + 内置），投影计数与样本。engine.getRules 是引擎检查同源的规则装配面。
  const appliedRules = summarizeAppliedGuardRules(engine, results);
  const applicableRecipeRules = collectApplicableRecipeRules(
    ctx,
    coverageRows.filter((row) => row.disposition === 'checked').map((row) => row.filePath)
  );
  const ruleAccounting = {
    accountingMode: 'separate-execution-modes' as const,
    countsAreAdditive: false,
    enumeratedEngineRules: appliedRules?.total ?? 0,
    additionalEngineChecks: 'not-enumerated' as const,
    hostEvaluationRequired: applicableRecipeRules.length,
  };
  const fixGuidance = summarizeGuardFixGuidance(results, crossFileViolations);

  // 5. 写入 ViolationsStore
  try {
    const violationsStore = ctx.container.get('violationsStore');
    for (const r of results) {
      if (r.violations.length > 0) {
        violationsStore.appendRun({
          filePath: r.filePath,
          violations: r.violations,
          summary: `guard review round ${round}: ${r.summary.errors}E ${r.summary.warnings}W`,
        });
      }
    }
  } catch {
    /* optional */
  }

  // 6. 构造消息
  let message: string;
  if (passed) {
    message = `✅ Guard review passed. ${checked} file(s) checked, 0 violations.`;
  } else if (verdict === 'failed') {
    const violatingFiles = results.filter((r) => r.violations.length > 0);
    const details = violatingFiles
      .map(
        (f) =>
          `  ${path.basename(f.filePath)}: ${f.violations.map((v: GuardViolationEnriched) => `L${v.line} ${v.ruleId}`).join(', ')}`
      )
      .join('\n');

    const guidance = [
      fixGuidance.inlineRecipe > 0
        ? `${fixGuidance.inlineRecipe} violation(s) include inline Recipe guidance.`
        : null,
      fixGuidance.fixSuggestionOnly > 0
        ? `${fixGuidance.fixSuggestionOnly} violation(s) include a fixSuggestion without inline Recipe guidance.`
        : null,
      fixGuidance.unavailable > 0
        ? `${fixGuidance.unavailable} violation(s) have no inline fix guidance; inspect the reported rule and source context.`
        : null,
    ].filter((line): line is string => line !== null);
    message = [
      `⚠️ Guard review failed: ${totalViolations} violation(s) in ${violatingFiles.length} file(s).`,
      details,
      '',
      ...guidance,
      'Fix the reported violations and run alembic_code_guard again with the same explicit scope.',
    ].join('\n');
  } else {
    message =
      verdict === 'blocked'
        ? '⛔ Guard review blocked because one or more requested paths are outside the project root.'
        : `⚠️ Guard review incomplete: checked ${checked}/${coverage.requested} requested file(s).`;
  }

  return envelope({
    success: true,
    data: {
      passed,
      verdict,
      coverage,
      fileCoverage: coverageRows,
      fileErrors: coverageRows
        .filter((row) => row.disposition !== 'checked')
        .map((row) => ({
          filePath: row.filePath,
          requestedPath: row.requestedPath,
          disposition: row.disposition,
          ...(row.message ? { message: row.message } : {}),
        })),
      reviewRound: round,
      maxRoundsReached,
      fileSource,
      files: results,
      ...(crossFileViolations.length > 0 ? { crossFileViolations } : {}),
      totalViolations,
      appliedRules,
      ruleAccounting,
      fixGuidance,
      // G-B：适用 Recipe 规矩清单（refs 精确文件匹配），无论 violation 与否都交付
      applicableRecipeRules,
      summary: {
        total: totalViolations,
        errors: totalErrors,
        warnings: totalWarnings,
        filesChecked: checked,
      },
      // uncertain 消费链路 — 结构化上抛给 Agent
      ...(allUncertainResults.length > 0
        ? {
            uncertainSummary: {
              total: allUncertainResults.length,
              byLayer: _groupBy(allUncertainResults as Array<{ layer: string }>, 'layer'),
              byReason: _groupBy(allUncertainResults as Array<{ reason: string }>, 'reason'),
            },
            uncertainResults: allUncertainResults,
          }
        : {}),
    },
    message,
    meta: { tool: 'alembic_code_guard', mode: 'review' },
  });
}

function summarizeGuardFixGuidance(
  results: readonly ReviewFileResult[],
  crossFileViolations: readonly unknown[]
): { inlineRecipe: number; fixSuggestionOnly: number; unavailable: number } {
  const violations: unknown[] = [
    ...results.flatMap((result) => result.violations),
    ...crossFileViolations,
  ];
  let inlineRecipe = 0;
  let fixSuggestionOnly = 0;
  let unavailable = 0;
  for (const value of violations) {
    const violation =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    if (violation.recipe && typeof violation.recipe === 'object') {
      inlineRecipe += 1;
    } else if (
      typeof violation.fixSuggestion === 'string' &&
      violation.fixSuggestion.trim().length > 0
    ) {
      fixSuggestionOnly += 1;
    } else {
      unavailable += 1;
    }
  }
  return { inlineRecipe, fixSuggestionOnly, unavailable };
}

// ═══ Recipe 缓存 ═════════════════════════════════════════

/**
 * 预加载所有 rule 类型 recipe 的修复字段
 * 构建 guardId → recipe 映射
 */
/**
 * G-B（2026-07-06）：Recipe 规矩清单交付——按被检文件从 recipe_source_refs
 * 确定性取适用 Recipe（refs 精确文件匹配，与 recipe_map 挂载同源判据，非语义
 * 猜测），交付 doClause/dontClause 给宿主 agent 判断。Recipe 是自然语言规则
 * （constraints.guards 机械 matcher 由生产端另行补充），"规则判断者"是宿主
 * LLM，guard 是确定性交付者；无论有无 violation 都交付，回答"这个文件适用
 * 哪些项目规矩"。失败容错返回 []（不破坏 guard 主链）。
 */
const APPLICABLE_RECIPE_RULES_LIMIT = 20;

function collectApplicableRecipeRules(
  ctx: McpContext,
  filePaths: string[]
): Array<Record<string, unknown>> {
  if (filePaths.length === 0) {
    return [];
  }
  try {
    const refRepo = ctx.container.get('recipeSourceRefRepository') as {
      findAll(): Array<{ recipeId: string; sourcePath: string; status: string }>;
    };
    const knowledgeRepo = ctx.container.get('knowledgeRepository') as {
      findByIdsDetailSync(ids: string[]): Array<Record<string, unknown>>;
    };
    const checked = new Set(
      filePaths.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''))
    );
    const matchedRefByRecipe = new Map<string, string>();
    for (const ref of refRepo.findAll()) {
      if (ref.status !== 'active') {
        continue;
      }
      const refFile = ref.sourcePath.split(':')[0];
      if (!refFile) {
        continue;
      }
      const hit =
        checked.has(refFile) ||
        [...checked].some((file) => refFile.endsWith(`/${file}`) || file.endsWith(`/${refFile}`));
      if (hit && !matchedRefByRecipe.has(ref.recipeId)) {
        matchedRefByRecipe.set(ref.recipeId, ref.sourcePath);
      }
    }
    if (matchedRefByRecipe.size === 0) {
      return [];
    }
    const ids = [...matchedRefByRecipe.keys()].slice(0, APPLICABLE_RECIPE_RULES_LIMIT);
    const details = knowledgeRepo.findByIdsDetailSync(ids);
    const detailById = new Map(details.map((row) => [String(row.id), row]));
    return ids.flatMap((recipeId) => {
      const row = detailById.get(recipeId);
      if (!row) {
        return [];
      }
      const doClause = typeof row.doClause === 'string' ? row.doClause : '';
      const dontClause = typeof row.dontClause === 'string' ? row.dontClause : '';
      if (!doClause && !dontClause) {
        return [];
      }
      return [
        {
          recipeId,
          title: String(row.title ?? row.description ?? recipeId),
          ...(typeof row.trigger === 'string' && row.trigger ? { trigger: row.trigger } : {}),
          ...(typeof row.kind === 'string' && row.kind ? { kind: row.kind } : {}),
          ...(doClause ? { doClause } : {}),
          ...(dontClause ? { dontClause } : {}),
          sourceRef: matchedRefByRecipe.get(recipeId) as string,
        },
      ];
    });
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Guard] applicable recipe rules degraded: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return [];
  }
}

async function _loadRuleRecipes(ctx: McpContext): Promise<Map<string, RecipeEntry>> {
  const map = new Map<string, RecipeEntry>();
  try {
    const knowledgeRepo = ctx.container.get('knowledgeRepository') as {
      findActiveGuardRecipes(): Promise<Array<Record<string, unknown>>>;
    };
    const entries = await knowledgeRepo.findActiveGuardRecipes();

    for (const row of entries) {
      try {
        const constraints =
          typeof row.constraints === 'object' && row.constraints
            ? (row.constraints as Record<string, unknown>)
            : JSON.parse((row.constraints as string) || '{}');
        const guards = (constraints.guards || []) as Array<{ id?: string }>;
        for (const g of guards) {
          if (g.id) {
            map.set(g.id, {
              title: row.title as string,
              doClause: row.doClause as string,
              dontClause: row.dontClause as string,
              coreCode: row.coreCode as string,
            });
          }
        }
      } catch {
        /* skip */
      }
      map.set(row.id as string, {
        title: row.title as string,
        doClause: row.doClause as string,
        dontClause: row.dontClause as string,
        coreCode: row.coreCode as string,
      });
    }
  } catch {
    /* DB not available */
  }
  return map;
}

// ═══ 项目扫描 ════════════════════════════════════════════

export async function scanProject(ctx: McpContext, args: ScanProjectArgs) {
  const maxFiles = args.maxFiles || 200;
  const includeContent = args.includeContent || false;
  const contentMaxLines = args.contentMaxLines || 100;

  const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;

  // 使用 ModuleService（多语言统一入口）
  let service: ModuleServiceLike;
  try {
    const { ModuleService } = await import('#service/module/ModuleService.js');
    service = new ModuleService(projectRoot) as unknown as ModuleServiceLike;
  } catch {
    return envelope({
      success: false,
      data: { targets: [], files: [], guardAudit: null, message: 'ModuleService not available' },
      meta: { tool: 'alembic_bootstrap' },
    });
  }
  await service.load();
  const allTargets = await service.listTargets();

  if (!allTargets || allTargets.length === 0) {
    return envelope({
      success: true,
      data: { targets: [], files: [], guardAudit: null, message: 'No module targets found' },
      meta: { tool: 'alembic_bootstrap' },
    });
  }

  // 收集所有文件（去重）
  const seenPaths = new Set();
  const allFiles: ScanFileEntry[] = [];
  for (const t of allTargets) {
    try {
      const fileList = await service.getTargetFiles(t);
      for (const f of fileList) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) {
          continue;
        }
        seenPaths.add(fp);
        const entry: ScanFileEntry = {
          name: f.name || path.basename(fp),
          path: fp,
          relativePath: f.relativePath || path.basename(fp),
          targetName: t.name,
        };
        if (includeContent) {
          try {
            const raw = await readFile(fp, 'utf8');
            const lines = raw.split('\n');
            entry.content = lines.slice(0, contentMaxLines).join('\n');
            entry.totalLines = lines.length;
            entry.truncated = lines.length > contentMaxLines;
          } catch {
            entry.content = '';
            entry.totalLines = 0;
          }
        }
        allFiles.push(entry);
        if (allFiles.length >= maxFiles) {
          break;
        }
      }
    } catch {
      /* skip target */
    }
    if (allFiles.length >= maxFiles) {
      break;
    }
  }

  // Guard 审计
  let guardAudit: GuardAuditResult | null = null;
  try {
    const { GuardCheckEngine } = await import('@alembic/core/guard');
    const engine = _getOrCreateEngine(ctx, GuardCheckEngine);

    // 注入 Enhancement Pack Guard 规则
    await _injectEnhancementGuardRules(engine, ctx);

    const filesToAudit = await Promise.all(
      allFiles.map(async (f) => {
        let content = f.content;
        if (!content) {
          try {
            content = await readFile(f.path, 'utf8');
          } catch {
            content = '';
          }
        }
        return { path: f.path, content, isTest: LanguageService.isTestFile(f.path) };
      })
    );
    guardAudit = engine.auditFiles(filesToAudit, { scope: 'project' });

    // 写入 ViolationsStore
    try {
      const violationsStore = ctx.container.get('violationsStore');
      for (const fileResult of guardAudit.files || []) {
        if (fileResult.violations.length > 0) {
          violationsStore.appendRun({
            filePath: fileResult.filePath,
            violations: fileResult.violations,
            summary: `MCP project scan: ${fileResult.summary.errors}E ${fileResult.summary.warnings}W`,
          });
        }
      }
    } catch {
      /* store not available */
    }
  } catch (e: unknown) {
    const logger = ctx.logger as { warn?: (...args: unknown[]) => void } | undefined;
    logger?.warn?.(
      `[MCP] Guard audit in scanProject failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // 构建文件列表摘要
  const fileSummary = allFiles.map((f) => {
    const base: {
      name: string;
      path: string;
      targetName: string;
      content?: string;
      totalLines?: number;
      truncated?: boolean;
    } = { name: f.name, path: f.relativePath, targetName: f.targetName };
    if (includeContent) {
      base.content = f.content;
      base.totalLines = f.totalLines;
      base.truncated = f.truncated;
    }
    return base;
  });

  return envelope({
    success: true,
    data: {
      targets: allTargets.map((t: { name: string; type?: string; packageName?: string }) => ({
        name: t.name,
        type: t.type,
        packageName: t.packageName,
      })),
      files: fileSummary,
      fileCount: allFiles.length,
      guardAudit: guardAudit
        ? {
            summary: guardAudit.summary,
            filesWithViolations: (guardAudit.files || [])
              .filter((f: GuardAuditFileResult) => f.violations.length > 0)
              .map((f: GuardAuditFileResult) => ({
                filePath: f.filePath,
                language: f.language,
                violations: f.violations,
                summary: f.summary,
              })),
            ...(guardAudit.crossFileViolations?.length
              ? { crossFileViolations: guardAudit.crossFileViolations }
              : {}),
          }
        : null,
    },
    meta: { tool: 'alembic_bootstrap' },
  });
}

// ─── 内部辅助 ─────────────────────────────────────────────

function isNodeErrorWithCode(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
  );
}

function guardErrorMessage(err: unknown): string {
  return `Cannot inspect requested file: ${err instanceof Error ? err.message : String(err)}`;
}

function enrichGuardViolation(
  violation: GuardViolation,
  recipeMap: Map<string, RecipeEntry>
): GuardViolationEnriched {
  const enriched: GuardViolationEnriched = {
    ruleId: violation.ruleId,
    message: violation.message,
    severity: violation.severity,
    line: violation.line,
    snippet: violation.snippet,
    fixSuggestion: violation.fixSuggestion || null,
  };
  const recipe = recipeMap.get(violation.ruleId);
  if (recipe) {
    enriched.recipe = {
      title: recipe.title,
      doClause: recipe.doClause || null,
      dontClause: recipe.dontClause || null,
      coreCode: recipe.coreCode || null,
    };
  }
  return enriched;
}

/** 按字段值分组计数 */
function _groupBy<T extends Record<string, unknown>>(
  arr: T[],
  key: string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of arr) {
    const k = String(item[key] ?? 'unknown');
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * 获取 DI 容器中的 GuardCheckEngine 单例，回退到新建实例
 * 优先复用 DI 单例以保持 externalRules / cache 的跨调用一致性
 * @param ctx MCP context with container
 * @param GuardCheckEngine 引擎构造函数（用于回退）
 */
function _getOrCreateEngine(ctx: McpContext, GuardCheckEngineCtor: unknown): GuardEngineLike {
  try {
    const engine = ctx.container.get('guardCheckEngine');
    if (engine) {
      return engine as GuardEngineLike;
    }
  } catch {
    /* DI not registered — fall back to new instance */
  }
  const db = ctx.container.get('database');
  return new (GuardCheckEngineCtor as new (db: unknown) => GuardEngineLike)(db);
}

/**
 * 将 Enhancement Pack 的 Guard 规则注入 GuardCheckEngine
 * 幂等 — 已注入的引擎直接跳过，避免每次请求重复加载 EnhancementRegistry
 * 静默失败 — Enhancement Pack 不可用不应阻断 Guard 审计
 */
async function _injectEnhancementGuardRules(
  engine: GuardEngineLike,
  ctx: McpContext
): Promise<void> {
  // 幂等保护: 已注入则跳过
  if (engine.isEpInjected?.()) {
    return;
  }
  try {
    // 2026-07-10 链路验通审计:此前这里走 frameworkAgnostic(generic-only),而 14 个
    // 增强包全部带框架条件 → 恒空集;旧注释声称的"Bootstrap Phase 4 精确 resolve"
    // 经全仓扫描证实从未存在。改走 Core 的项目级精确 resolve:从真实依赖清单
    // (package.json/go.mod/Cargo.toml/pyproject/gradle)推导 languages+frameworks,
    // 匹配项目(如 React)注入对应包规则,无对应生态(如纯 Swift)得空集——评估期
    // 语言门(GuardCheckEngine 按文件语言过滤)仍是第二道网。失败静默降级为不注入。
    const { resolveEnhancementGuardRulesForProject } = await import('@alembic/core/guard');
    const projectRoot = requireRequestProjectRuntime(ctx).identity.projectRoot;
    const { rules, packIds, detection } = await resolveEnhancementGuardRulesForProject(projectRoot);
    if (rules.length > 0) {
      engine.injectExternalRules(rules);
    }
    const logger = ctx.logger as { info?: (...args: unknown[]) => void } | undefined;
    logger?.info?.(
      `[guard] enhancement rules resolved: packs=[${packIds.join(',')}] rules=${rules.length} ` +
        `languages=[${detection.languages.join(',')}] frameworks=[${detection.frameworks.join(',')}]`
    );
    engine.markEpInjected?.();
  } catch {
    /* Enhancement rules unavailable — non-critical */
  }
}

/**
 * G2（2026-07-06）：按被检文件的语言集合枚举引擎实际装载的规则，产出守门
 * 正面清单摘要。规则来源与检查同源（engine.getRules：数据库 Recipe 规则 +
 * 内置规则）；异常容缺返回 null（诊断面缺席不影响守门结果本体）。
 */
// D4(2026-07-11):参数放宽为"带 language 字段的任意结果"——G2 原只接 review 模式,
// code(guardCheck)/audit(guardAuditFiles)两模式此前缺 appliedRules,0 violations 时
// 宿主无法区分"检查了且干净"与"没什么规则可查"(P-D 活体矩阵 BiliDili 实证)。
function summarizeAppliedGuardRules(
  engine: GuardEngineLike,
  results: Array<{ language?: unknown }>
): {
  total: number;
  complete: false;
  enumerationScope: 'engine-getRules';
  bySource: Record<string, number>;
  sample: Array<{ id: string; name: string; severity: string; source: string }>;
} | null {
  if (typeof engine.getRules !== 'function') {
    return null;
  }
  try {
    const languages = [
      ...new Set(
        results
          .map((result) => (typeof result.language === 'string' ? result.language : null))
          .filter((language): language is string => Boolean(language))
      ),
    ];
    const byId = new Map<string, { id: string; name: string; severity: string; source: string }>();
    for (const language of languages.length > 0 ? languages : [null]) {
      for (const rule of engine.getRules(language)) {
        const id = String(rule.id ?? rule.name ?? '');
        if (!id || byId.has(id)) {
          continue;
        }
        byId.set(id, {
          id,
          name: String(rule.name ?? id),
          severity: String(rule.severity ?? 'warning'),
          source: String(rule.source ?? 'unknown'),
        });
      }
    }
    const all = [...byId.values()];
    const bySource: Record<string, number> = {};
    for (const rule of all) {
      bySource[rule.source] = (bySource[rule.source] ?? 0) + 1;
    }
    return {
      total: all.length,
      complete: false,
      enumerationScope: 'engine-getRules',
      bySource,
      sample: all.slice(0, 10),
    };
  } catch {
    return null;
  }
}
