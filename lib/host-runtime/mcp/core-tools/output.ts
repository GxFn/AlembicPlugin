import Logger from '@alembic/core/logging';
import { z } from 'zod';
import {
  CleanMcpResponseBaseSchema,
  createCleanMcpError,
  createCleanMcpResponse,
  ProducerNextActionsSchema,
  ProducerRequiredActionsSchema,
  registerMcpOutputProjector,
} from '../output-contract.js';

// MTC-4: alembic_health merged into alembic_status, whose single output projector
// is homed in codex-local/output (cross-server runtime-diagnostic tool).
export const CORE_CLEAN_OUTPUT_TOOL_NAMES = [
  'alembic_knowledge',
  'alembic_structure',
  'alembic_call_context',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_evolve',
  'alembic_consolidate',
  'alembic_dimension_complete',
  'alembic_knowledge_lifecycle',
] as const;

export type CoreCleanOutputToolName = (typeof CORE_CLEAN_OUTPUT_TOOL_NAMES)[number];

export const CoreCleanOutputToolNameSchema = z.enum(CORE_CLEAN_OUTPUT_TOOL_NAMES);

export const CORE_FORBIDDEN_BUSINESS_OUTPUT_KEYS = new Set([
  'diagnostics',
  'legacyBoundary',
  'legacyCompatibility',
  'maxChars',
  'metadata',
  'outputBudget',
  'projectRuntime',
  'retrievalConsumer',
  'runtimePolicy',
  'searchMeta',
  'telemetry',
  'truncated',
  'usedChars',
]);

export const CORE_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS = new Set([
  'data',
  'errorCode',
  'message',
  'result',
  'success',
]);

const CORE_SENSITIVE_BUSINESS_OUTPUT_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authheader',
  'authorization',
  'bearertoken',
  'cookie',
  'internaltelemetry',
  'password',
  ['private', 'daemon', 'url'].join(''),
  'providerprivatetrace',
  'refreshtoken',
  'secret',
  'secrettoken',
  'setcookie',
]);

const RESERVED_TOP_LEVEL_FIELD_RENAMES: Record<string, string> = {
  data: 'businessData',
  error: 'businessError',
  errorCode: 'businessErrorCode',
  message: 'businessMessage',
  meta: 'businessMeta',
  ok: 'businessOk',
  result: 'businessResult',
  status: 'businessStatus',
  success: 'businessSuccess',
  summary: 'businessSummary',
  toolName: 'businessToolName',
};

const ALLOWED_CLEAN_META_KEYS = new Set([
  'coverageLedgerSeed',
  'fullBriefingRef',
  'fullMapRef',
  'responseTimeMs',
  'source',
]);

// H1 复审：rescan 预算步骤（knowledge-rescan.ts 调 budgetBriefingResponseData 时不带 compact 回调）在原始
// data 超 18KB 时只写 transient 并附 meta.fullBriefingRef，内联仍是完整 data。evidenceHints.allRecipes /
// evolutionPrescreen 随配方数线性增长，公开后会让 structuredContent 无上限膨胀。投影层仅在 fullBriefingRef
// 存在（=已超预算且完整体可读）时把 evidenceHints 收敛到该上限；未超预算的响应原样内联。
export const RESCAN_OVER_BUDGET_EVIDENCE_HINTS_INLINE_BYTES = 12 * 1024;

export const CORE_BASE_OUTPUT_FIELD_NAMES = [
  'error',
  'meta',
  'ok',
  'status',
  'summary',
  'toolName',
] as const;

export const CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES = {
  alembic_bootstrap: [
    // H1：plan-gate / rebuild-confirmation 的 ok=false 信封靠这些字段告诉 Agent 为何被拦、下一步调用什么；
    // 投影层对 success:false 的 data 走同一份白名单，漏列就只剩泛化 summary。
    'blockedReason',
    'bootstrapState',
    'currentDimensionGuidance',
    'currentDimensionNextActions',
    'fileCount',
    'files',
    'gates',
    'guardAudit',
    'hostAgentContract',
    'hostAgentAnalysis',
    'ideAgentAnalysis',
    'dimensions',
    'cleanupPolicy',
    'executionPlan',
    'generationStage',
    'initialToolBriefing',
    'knowledge',
    'moduleScope',
    'needsUserInput',
    'nextActions',
    'planGate',
    'planState',
    'progress',
    'projectContextCreationGuide',
    'projectRoot',
    'recipeCreationNextActions',
    'repairState',
    'session',
    'targets',
    'testMode',
    'toolCapabilities',
    'businessMessage',
  ],
  alembic_call_context: [
    'callees',
    'callers',
    'direction',
    'impact',
    'maxDepth',
    'methodName',
    'note',
  ],
  alembic_consolidate: ['errors', 'kept', 'merged', 'processed', 'rejected'],
  alembic_dimension_complete: [
    'accumulatedHints',
    'businessStatus',
    'candidateCount',
    'completenessCritic',
    'completed',
    'completedDimensions',
    'dimensionId',
    // H1：证据/质量门禁失败（rebuild-required）时 Agent 需要逐条 violation 与 nextAction 才能修复；
    // 字段形状与 alembic_submit_knowledge 已公开的 evidenceGate/problem/rejectedItems 一致。
    'evidenceGate',
    'evidenceHints',
    'hostAgentAnalysisProgress',
    'ideAgentAnalysisProgress',
    'isBootstrapComplete',
    // 末维度完成后的知识 Skill 自动同步摘要（成功/失败/跳过原因），失败时宿主需据此决定是否手动 refresh。
    'knowledgeSkillAutoSync',
    'nextActions',
    'problem',
    'progress',
    'projectSkillDelivery',
    'qualityFeedback',
    'recipesBound',
    'rejectedItems',
    'remainingDimensions',
    'skillCreated',
    'subpackageCoverageWarning',
    'updated',
  ],
  alembic_evolve: [
    'deprecated',
    'errors',
    'freshness',
    'processed',
    'proposed',
    'quotaChange',
    'refreshed',
    'retrievalMayBeStale',
    'skipped',
  ],
  alembic_knowledge: [
    'businessMessage',
    'category',
    'complexity',
    'constraints',
    'content',
    'count',
    'createdAt',
    'createdBy',
    'description',
    'feedback',
    'headers',
    'id',
    'items',
    'kind',
    'knowledgeType',
    'language',
    'lifecycle',
    'quality',
    'reasoning',
    'recipeId',
    'relations',
    'scope',
    'stats',
    'tags',
    'title',
    'total',
    'trigger',
    'updatedAt',
    'usageType',
  ],
  alembic_knowledge_lifecycle: [
    'action',
    'businessMessage',
    'entry',
    'id',
    'lifecycle',
    'newStatus',
    'operation',
    'title',
    'updated',
  ],
  alembic_plan: [
    'agentDecisionChecklist',
    'candidateDimensions',
    // H1：deepMining 草稿的覆盖账本信号（gap 候选/现存计数/评级/单轮上限），只读、无绝对路径。
    'coverageSeed',
    // H2：checklist 规模条目依赖的每维证据密度（id/label/计数/strength/sampleHits 相对路径尾），只读。
    'dimensionEvidenceDensity',
    'nextActions',
    'operation',
    'planDiagnostics',
    'planSelection',
    'projectInfoTree',
    'projectRoot',
    'warnings',
  ],
  alembic_project_skill: [
    'businessError',
    'businessMessage',
    'businessStatus',
    'content',
    'deliveryReceipt',
    'description',
    'exportResult',
    'knowledgeScope',
    'name',
    'operation',
    'receipt',
    'receiptId',
    'runtimeExport',
    'skillName',
    'skills',
    'source',
    'title',
    'warnings',
  ],
  alembic_rescan: [
    // 历史顶层键：Core 从不在顶层产出 allRecipes（实际位于 evidenceHints.allRecipes），保留仅为 schema 兼容。
    'allRecipes',
    // H1：plan-gate 拦截（PLAN_REQUIRED / PLAN_GENERATION_IN_PROGRESS）的恢复信息，以及空项目 data.message。
    'blockedReason',
    'businessMessage',
    // U2d：覆盖账本咨询（三停止 + 高价值空白 + 价值排序缺口 + 建议）；advisory 不阻断。
    'coverageAdvisory',
    'dimensions',
    'cleanupPolicy',
    // H1：rescan message 明确要求 Agent 过滤 allRecipes、遵守 evidenceHints.constraints.occupiedTriggers，
    // executionPlan.workflow 也引用 dimensionGaps/needsVerification/sourceRefs——它们都在 evidenceHints 内。
    // 18KB 内联预算在投影前对含 evidenceHints 的原始 data 计算，超预算时完整体在 meta.fullBriefingRef，
    // 投影层再把 evidenceHints 收敛到 RESCAN_OVER_BUDGET_EVIDENCE_HINTS_INLINE_BYTES（见 compactOverBudgetRescanEvidenceHints）。
    'evidenceHints',
    'evidencePlan',
    'evolution',
    'executionDimensions',
    'executionPlan',
    'generationStage',
    'generationChangeLog',
    'hostAgentAnalysis',
    'hostAgentLifecycle',
    'ideAgentAnalysis',
    // U2e：退役 git-diff 增量生成杂质——gitDiffEvidence / moduleMiningRoutes 不再透出 rescan 业务输出
    //（生成已于 750ef70 退役、moduleMiningRoutes 恒空）；维护 pendingProposals/generationChangeLog 保留。
    'moduleScope',
    'needsUserInput',
    'nextActions',
    // 终局 advisory 释放空 session 时的显式信号（session=null 与之配套）。
    'noActionableHostAgentWork',
    'pendingProposals',
    'planGate',
    'planState',
    'produceDimensions',
    'proposals',
    'projectContextCreationGuide',
    'projectRoot',
    'recipeCreationNextActions',
    'requestedDimensions',
    'reasons',
    // Core presenter 产出的清理/审计摘要（仅计数 + 归档引用）。
    'relevanceAudit',
    'rescan',
    // 与 bootstrap 一致公开 session 摘要（id/state/progress），供 session-bound submit/dimension_complete 绑定。
    'session',
    // rescan 无 hostAgentContract，Recipe 创作前置契约只挂在 submissionSchema（C.3 re-point）；
    // 不公开则内联（≤18KB、无 fullBriefingRef）时 mining 路径拿不到契约。
    'submissionSchema',
    'testMode',
    'unifiedEvolution',
  ],
  alembic_structure: [
    'businessSummary',
    'dependencies',
    'fileCount',
    'files',
    'framework',
    'graphEdges',
    'inferredRole',
    'language',
    'languageStats',
    'name',
    'packageDir',
    'packageName',
    'packagePath',
    'packageSwift',
    'packageTargets',
    'path',
    'sources',
    'sourcesPath',
    'targetDir',
    'targetName',
    'targets',
    'totalAvailable',
    'type',
  ],
  alembic_submit_knowledge: [
    'blockedItems',
    'blockedSummary',
    'businessStatus',
    'commonErrors',
    'codeEvidence',
    'count',
    'degraded',
    'degradedReasons',
    'evidenceGate',
    'finality',
    'freshness',
    'hostAgentAnalysisLinkage',
    'ideAgentAnalysisLinkage',
    'ids',
    'nextAction',
    'nextActionBlocked',
    'pendingSemanticReview',
    'problem',
    'production',
    'proposalSummary',
    'proposals',
    'rejectedItems',
    'rejectedSummary',
    'relationshipGrounding',
    'readiness',
    'requiredFields',
    'retrievalMayBeStale',
    'retrievalProfiles',
    'total',
  ],
} as const satisfies Record<CoreCleanOutputToolName, readonly string[]>;

export type CoreToolCleanOutput = z.infer<typeof CleanMcpResponseBaseSchema> & {
  toolName: CoreCleanOutputToolName;
} & Record<string, unknown>;

type CoreToolOutputSchema = z.ZodType<CoreToolCleanOutput>;

export const CoreToolOutputBaseSchema = CleanMcpResponseBaseSchema.extend({
  toolName: CoreCleanOutputToolNameSchema,
}).strict();

export const CORE_TOOL_OUTPUT_SCHEMAS = Object.fromEntries(
  CORE_CLEAN_OUTPUT_TOOL_NAMES.map((toolName) => [
    toolName,
    createCoreToolOutputSchema(toolName, CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]),
  ])
) as unknown as Record<CoreCleanOutputToolName, CoreToolOutputSchema>;

export function projectCoreToolOutput(
  input: unknown,
  toolName: CoreCleanOutputToolName
): CoreToolCleanOutput {
  const schema = CORE_TOOL_OUTPUT_SCHEMAS[toolName];
  const alreadyClean = schema.safeParse(input);
  if (alreadyClean.success) {
    return alreadyClean.data;
  }

  const legacy = isRecord(input) ? input : {};
  const ok = typeof legacy.success === 'boolean' ? legacy.success : legacy.errorCode == null;
  const business = sanitizeBusinessFields(extractLegacyBusinessValue(legacy), toolName);
  const cleanMeta = pickCleanMeta(legacy.meta, toolName);
  if (toolName === 'alembic_rescan') {
    relativizeRescanArchiveFolder(business);
  }
  if (toolName === 'alembic_rescan' && hasTransientFullBriefingRef(cleanMeta)) {
    compactOverBudgetRescanEvidenceHints(business);
  }
  const errorDetails = pickLegacyErrorDetails(legacy);
  const errorDetailsWithActions = ok
    ? errorDetails
    : withProducerActionDetails(errorDetails, legacy, toolName);
  const summary = buildCoreToolSummary(toolName, {
    business,
    errorDetails,
    message: typeof legacy.message === 'string' ? legacy.message : '',
    ok,
  });
  const errorCode = extractLegacyErrorCode(legacy, errorDetails);
  const status = deriveCoreToolStatus({ business, errorCode, ok });
  const response = createCleanMcpResponse(
    {
      ...business,
      ok,
      status,
      summary,
      toolName,
      ...(!ok
        ? {
            error: createCleanMcpError({
              code: errorCode || 'TOOL_FAILED',
              ...(errorDetailsWithActions === null ? {} : { details: errorDetailsWithActions }),
              message: summary,
              source: errorDetails ?? legacy,
              status,
            }),
          }
        : {}),
      ...(cleanMeta ? { meta: cleanMeta } : {}),
    },
    toolName
  );
  return schema.parse(response);
}

export function findForbiddenCoreOutputField(
  value: unknown,
  path: string[] = []
): { path: string[] } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenCoreOutputField(item, [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (path.length === 0 && CORE_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key)) {
      return { path: [key] };
    }
    if (path[0] !== 'meta' && isSensitiveCoreOutputKey(key)) {
      return { path: [...path, key] };
    }
    if (path[0] !== 'meta' && CORE_FORBIDDEN_BUSINESS_OUTPUT_KEYS.has(key)) {
      return { path: [...path, key] };
    }
    if (path.length === 0 && key === 'meta') {
      continue;
    }
    const found = findForbiddenCoreOutputField(child, [...path, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function createCoreToolOutputSchema(
  toolName: CoreCleanOutputToolName,
  businessFields: readonly string[]
): CoreToolOutputSchema {
  const shape: Record<string, z.ZodType> = { toolName: z.literal(toolName) };
  for (const fieldName of businessFields) {
    shape[fieldName] = z.unknown().optional();
  }
  return CleanMcpResponseBaseSchema.extend(shape)
    .strict()
    .superRefine((output, ctx) => {
      const forbidden = findForbiddenCoreOutputField(output);
      if (forbidden) {
        ctx.addIssue({
          code: 'custom',
          path: forbidden.path,
          message: `Core MCP clean output must not expose ${forbidden.path.join('.')}`,
        });
      }
    }) as unknown as CoreToolOutputSchema;
}

function extractLegacyBusinessValue(value: Record<string, unknown>): unknown {
  if ('data' in value) {
    return value.data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CORE_FORBIDDEN_TOP_LEVEL_OUTPUT_KEYS.has(key) || key === 'meta') {
      continue;
    }
    out[key] = child;
  }
  return out;
}

function sanitizeBusinessFields(
  value: unknown,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> {
  const sanitized = sanitizeBusinessValue(value);
  let business: Record<string, unknown>;
  if (isRecord(sanitized)) {
    business = renameReservedTopLevelFields(sanitized);
  } else if (sanitized === undefined || sanitized === null) {
    business = {};
  } else {
    business = { value: sanitized };
  }
  return pickAllowedBusinessFields(business, toolName);
}

function sanitizeBusinessValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeBusinessValue);
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CORE_FORBIDDEN_BUSINESS_OUTPUT_KEYS.has(key) || isSensitiveCoreOutputKey(key)) {
      continue;
    }
    const sanitized = sanitizeBusinessValue(child);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

function renameReservedTopLevelFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextKey = RESERVED_TOP_LEVEL_FIELD_RENAMES[key] ?? key;
    out[nextKey] = child;
  }
  return out;
}

function pickAllowedBusinessFields(
  value: Record<string, unknown>,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> {
  const allowed = new Set<string>(CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName]);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key)) {
      out[key] = child;
    }
  }
  return out;
}

function pickCleanMeta(
  value: unknown,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'coverageLedgerSeed' && toolName !== 'alembic_rescan') {
      continue;
    }
    if (ALLOWED_CLEAN_META_KEYS.has(key)) {
      const cleanChild = key === 'coverageLedgerSeed' ? sanitizeCoverageLedgerSeed(child) : child;
      if (cleanChild !== undefined) {
        out[key] = cleanChild;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * H1 复审：Core rescan presenter 的 rescan.archive.folder 是 CleanupService 生成的绝对
 * trash 路径 `<dataRoot>/.asd/.trash/<ts>`（ghost 模式下位于用户 home）。公开投影改写为
 * dataRoot 相对形式 `.asd/.trash/<ts>`（与 rescan message 的写法一致）；无法定位
 * `.asd/.trash` 段的绝对路径则删除 folder，仅保留 movedItems/dbSnapshotRows 计数，
 * Agent 仍能通过 archive 非 null 判断发生了归档。就地改写 business.rescan。
 */
function relativizeRescanArchiveFolder(business: Record<string, unknown>): void {
  const rescan = business.rescan;
  if (!isRecord(rescan) || !isRecord(rescan.archive) || !('folder' in rescan.archive)) {
    return;
  }
  const { folder, ...counts } = rescan.archive;
  const relative = typeof folder === 'string' ? toDataRootRelativeTrashFolder(folder) : null;
  if (relative !== null) {
    business.rescan = { ...rescan, archive: { ...counts, folder: relative } };
    return;
  }
  // 分叉诊断走 Core Logger（MCP 模式下写 stderr），不得写 stdout；不记录原路径本身。
  Logger.getInstance().warn(
    '[core-tools/output] alembic_rescan archive.folder is not a recognizable .asd/.trash path; folder dropped from public output, archive counts kept',
    { folderType: typeof folder, keptKeys: Object.keys(counts) }
  );
  business.rescan = { ...rescan, archive: counts };
}

function toDataRootRelativeTrashFolder(folder: string): string | null {
  const segments = folder.split(/[\\/]+/).filter((segment) => segment.length > 0);
  // 取最后一个 `.asd/.trash` 段对：ghost 数据根本身可能位于 ~/.asd/workspaces/<id>/ 下。
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] === '.asd' && segments[index + 1] === '.trash') {
      const rest = segments.slice(index + 2);
      if (rest.length === 0 || rest.some((segment) => segment === '..')) {
        return null;
      }
      return ['.asd', '.trash', ...rest].join('/');
    }
  }
  return null;
}

function hasTransientFullBriefingRef(meta: Record<string, unknown> | null): boolean {
  const ref = meta?.fullBriefingRef;
  return isRecord(ref) && typeof ref.path === 'string' && ref.path.length > 0;
}

/**
 * 超预算 rescan 的 evidenceHints 有界内联投影（就地改写 business.evidenceHints）。
 *
 * 逐级收敛，每级测量含 inlineProjection 的字节，满足上限即停：
 * 1. allRecipes 瘦身为 id/title/trigger/dimensionId/knowledgeType/lifecycle/auditHint(score+verdict)，
 *    需验证配方排前；autoResolved（healthy 自动跳过 / dead 已废弃，无需 Agent 动作）只留计数；
 * 2. 去掉 dimensionGaps[].existingTriggers（与 constraints.occupiedTriggers 重复）；
 * 3. 在剩余预算内按优先级前缀内联 needsVerification，再内联瘦身 allRecipes。
 * constraints（occupiedTriggers + rules）、dimensionGaps 执行模式/createBudget、evolutionGuide 始终完整保留；
 * 若仅这些硬约束就超上限，接受超出并打 warn（完整体仍在 meta.fullBriefingRef）。
 */
function compactOverBudgetRescanEvidenceHints(business: Record<string, unknown>): void {
  const hints = business.evidenceHints;
  if (!isRecord(hints)) {
    return;
  }
  const rawBytes = jsonByteLength(hints);
  const prescreen = isRecord(hints.evolutionPrescreen) ? hints.evolutionPrescreen : null;
  const needsVerification = Array.isArray(prescreen?.needsVerification)
    ? prescreen.needsVerification
    : [];
  const autoResolvedTotal = Array.isArray(prescreen?.autoResolved)
    ? prescreen.autoResolved.length
    : 0;
  const allRecipes = Array.isArray(hints.allRecipes) ? hints.allRecipes : [];
  const priorityIds = new Set(
    needsVerification
      .map((item) => (isRecord(item) ? item.recipeId : undefined))
      .filter((id): id is string => typeof id === 'string')
  );
  const slimRecipes = allRecipes.map(slimRescanRecipe);
  const orderedRecipes = [
    ...slimRecipes.filter((recipe) => isRecord(recipe) && priorityIds.has(String(recipe.id))),
    ...slimRecipes.filter((recipe) => !(isRecord(recipe) && priorityIds.has(String(recipe.id)))),
  ];

  const assemble = (
    recipes: unknown[],
    verification: unknown[],
    keepExistingTriggers: boolean
  ): Record<string, unknown> => ({
    ...hints,
    allRecipes: recipes,
    ...(prescreen
      ? {
          evolutionPrescreen: {
            ...prescreen,
            needsVerification: verification,
            autoResolved: [],
          },
        }
      : {}),
    ...(Array.isArray(hints.dimensionGaps) && !keepExistingTriggers
      ? { dimensionGaps: hints.dimensionGaps.map(omitExistingTriggers) }
      : {}),
    inlineProjection: {
      mode: 'over-budget-compact',
      fullBriefingRef: 'meta.fullBriefingRef',
      note:
        'evidenceHints exceeded the rescan inline budget: allRecipes entries here are slimmed ' +
        '(no content/sourceRefs/doClause) and lists may be partial. Read the JSON file at ' +
        'meta.fullBriefingRef.path for full recipe content and complete lists. ' +
        'constraints.occupiedTriggers and dimensionGaps executionMode/createBudget are complete.',
      allRecipes: {
        inline: recipes.length,
        omittedFields: ['content', 'sourceRefs', 'doClause', 'auditHint.decayReasons'],
        total: allRecipes.length,
      },
      autoResolved: { inline: 0, total: autoResolvedTotal },
      existingTriggersInline: keepExistingTriggers,
      needsVerification: { inline: verification.length, total: needsVerification.length },
    },
  });

  const cap = RESCAN_OVER_BUDGET_EVIDENCE_HINTS_INLINE_BYTES;
  let stage = 'slim-recipes';
  let compacted = assemble(orderedRecipes, needsVerification, true);
  if (jsonByteLength(compacted) > cap) {
    stage = 'drop-existing-triggers';
    compacted = assemble(orderedRecipes, needsVerification, false);
  }
  if (jsonByteLength(compacted) > cap) {
    // 第 3 级：先测只含硬约束的骨架，再按优先级前缀填充；预留少量字节给计数位数变化。
    stage = 'partial-lists';
    let remaining = cap - jsonByteLength(assemble([], [], false)) - 64;
    const verification = takePrefixWithinBytes(needsVerification, remaining);
    remaining -= verification.bytes;
    const recipes = takePrefixWithinBytes(orderedRecipes, remaining);
    compacted = assemble(recipes.items, verification.items, false);
  }
  business.evidenceHints = compacted;

  const inlineBytes = jsonByteLength(compacted);
  const logPayload = {
    allRecipesInline: Array.isArray(compacted.allRecipes) ? compacted.allRecipes.length : 0,
    allRecipesTotal: allRecipes.length,
    cap,
    inlineBytes,
    rawBytes,
    stage,
  };
  // 分叉诊断走 Core Logger（MCP 模式下写 stderr），不得写 stdout（MCP stdio 协议通道）。
  if (inlineBytes > cap) {
    Logger.getInstance().warn(
      '[core-tools/output] alembic_rescan evidenceHints still over inline cap after compaction; hard constraints kept in full, full briefing at meta.fullBriefingRef',
      logPayload
    );
  } else {
    Logger.getInstance().info(
      '[core-tools/output] alembic_rescan over-budget evidenceHints compacted for inline output; full briefing at meta.fullBriefingRef',
      logPayload
    );
  }
}

function slimRescanRecipe(recipe: unknown): unknown {
  if (!isRecord(recipe)) {
    return recipe;
  }
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'title', 'trigger', 'dimensionId', 'knowledgeType', 'lifecycle']) {
    if (recipe[key] !== undefined) {
      out[key] = recipe[key];
    }
  }
  if (isRecord(recipe.auditHint)) {
    out.auditHint = {
      relevanceScore: recipe.auditHint.relevanceScore,
      verdict: recipe.auditHint.verdict,
    };
  }
  return out;
}

function omitExistingTriggers(gap: unknown): unknown {
  if (!isRecord(gap)) {
    return gap;
  }
  const { existingTriggers: _existingTriggers, ...rest } = gap;
  return rest;
}

function takePrefixWithinBytes(
  items: readonly unknown[],
  budgetBytes: number
): { bytes: number; items: unknown[] } {
  const taken: unknown[] = [];
  let used = 0;
  for (const item of items) {
    // +1 计入数组分隔逗号。
    const size = jsonByteLength(item) + 1;
    if (used + size > budgetBytes) {
      break;
    }
    taken.push(item);
    used += size;
  }
  return { bytes: used, items: taken };
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function sanitizeCoverageLedgerSeed(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = boundedString(value.status, 80);
  if (!status) {
    return undefined;
  }
  const out: Record<string, unknown> = { status };
  const reason = boundedString(value.reason, 240);
  if (reason) {
    out.reason = reason;
  }
  for (const key of ['writtenCells', 'coveredPathCount', 'moduleCount']) {
    const numericValue = nonnegativeInteger(value[key]);
    if (numericValue !== undefined) {
      out[key] = numericValue;
    }
  }
  const dimensionIds = cleanStringArray(value.dimensionIds, 160);
  if (dimensionIds !== undefined) {
    out.dimensionIds = dimensionIds;
  }
  return out;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function cleanStringArray(value: unknown, itemMaxLength: number): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const cleaned = value
    .map((item) => boundedString(item, itemMaxLength))
    .filter((item): item is string => item !== undefined);
  return cleaned.length > 0 ? cleaned : [];
}

function extractLegacyErrorCode(
  legacy: Record<string, unknown>,
  errorDetails: Record<string, unknown> | null
): string | null {
  if (typeof legacy.errorCode === 'string' && legacy.errorCode.length > 0) {
    return legacy.errorCode;
  }
  for (const key of ['code', 'mcpErrorCode', 'reasonCode']) {
    const value = errorDetails?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * failureResult 的可执行指引（data.requiredActions / data.nextActions，如 PROJECT_NOT_INITIALIZED
 * 引导先调用 alembic_init）随 error.details 交付，与 agent-public 投影口径一致。
 * 业务白名单只决定 data 顶层哪些字段公开，多数 core 工具未列 nextActions，否则拒绝信封在线上
 * 只剩 code + message。仅接受有界、封闭的指引形状；形状不符时记 stderr 诊断并按原样不附加。
 */
function withProducerActionDetails(
  errorDetails: Record<string, unknown> | null,
  legacy: Record<string, unknown>,
  toolName: CoreCleanOutputToolName
): Record<string, unknown> | null {
  const data = isRecord(legacy.data) ? legacy.data : null;
  if (!data || (data.requiredActions === undefined && data.nextActions === undefined)) {
    return errorDetails;
  }
  const actions: Record<string, unknown> = {};
  for (const [key, schema] of [
    ['requiredActions', ProducerRequiredActionsSchema],
    ['nextActions', ProducerNextActionsSchema],
  ] as const) {
    if (data[key] === undefined || errorDetails?.[key] !== undefined) {
      continue;
    }
    const parsed = schema.safeParse(data[key]);
    if (parsed.success) {
      actions[key] = parsed.data;
    } else {
      Logger.getInstance().warn(
        `[core-tools/output] ${toolName} failure data.${key} does not match the bounded action shape; not attached to error.details`
      );
    }
  }
  if (Object.keys(actions).length === 0) {
    return errorDetails;
  }
  return { ...(errorDetails ?? {}), ...actions };
}

function pickLegacyErrorDetails(legacy: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(legacy.error)) {
    return legacy.error;
  }
  if (isRecord(legacy.data) && isRecord(legacy.data.error)) {
    return legacy.data.error;
  }
  return null;
}

function deriveCoreToolStatus(input: {
  business: Record<string, unknown>;
  errorCode: string | null;
  ok: boolean;
}): string {
  if (!input.ok) {
    return 'blocked';
  }
  if (input.business.degraded === true) {
    return 'degraded';
  }
  if (typeof input.business.businessStatus === 'string') {
    const normalized = input.business.businessStatus.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (normalized === 'degraded' || normalized === 'blocked' || normalized === 'failed') {
      return normalized;
    }
  }
  if (input.errorCode) {
    return 'blocked';
  }
  return 'ready';
}

function buildCoreToolSummary(
  toolName: CoreCleanOutputToolName,
  input: {
    business: Record<string, unknown>;
    errorDetails: Record<string, unknown> | null;
    message: string;
    ok: boolean;
  }
): string {
  if (input.message.trim()) {
    return input.message.trim();
  }
  if (!input.ok && typeof input.errorDetails?.message === 'string') {
    return input.errorDetails.message;
  }
  if (!input.ok) {
    return `${toolName} blocked.`;
  }
  switch (toolName) {
    case 'alembic_knowledge':
      return 'Knowledge request completed.';
    case 'alembic_structure':
      return 'Structure request completed.';
    case 'alembic_call_context':
      return 'Call context request completed.';
    case 'alembic_plan':
      return 'Plan request completed.';
    case 'alembic_submit_knowledge':
      return `Knowledge submission processed ${numberField(input.business.count)} item(s).`;
    case 'alembic_project_skill':
      return 'Project skill request completed.';
    case 'alembic_bootstrap':
      return 'Bootstrap briefing completed.';
    case 'alembic_rescan':
      return 'Rescan briefing completed.';
    case 'alembic_evolve':
      return 'Evolution decisions processed.';
    case 'alembic_consolidate':
      return 'Consolidation decisions processed.';
    case 'alembic_dimension_complete':
      return 'Dimension completion processed.';
    case 'alembic_knowledge_lifecycle':
      return 'Knowledge lifecycle request completed.';
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSensitiveCoreOutputKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return CORE_SENSITIVE_BUSINESS_OUTPUT_KEYS.has(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

for (const toolName of CORE_CLEAN_OUTPUT_TOOL_NAMES) {
  registerMcpOutputProjector({
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS[toolName],
    outputSchemaName: `${toolName}_clean_output`,
    project: (input) => projectCoreToolOutput(input, toolName),
    projectorName: 'core-tools-clean-output-projector',
    toolName,
  });
}
