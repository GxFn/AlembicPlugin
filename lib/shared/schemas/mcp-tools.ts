/**
 * mcp-tools.ts — MCP 工具输入 Zod Schema
 *
 * 每个 MCP 工具的输入参数定义为 Zod Schema，既做运行时校验，
 * 又可通过 zodToJsonSchema() 自动生成 inputSchema 声明（消除双重维护）。
 *
 * 命名约定：`{ToolSuffix}Input`，如 `SearchInput` 对应 `alembic_search`。
 *
 * @module shared/schemas/mcp-tools
 */

import {
  ComplexityEnum,
  ContentSchema,
  IdField,
  LanguageField,
  ReasoningSchema,
  ScopeEnum,
  StrictKindEnum,
  TitleField,
} from '@alembic/core/shared';
import { z } from 'zod';

// ══════════════════════════════════════════════════════
//  1. alembic_status — 可选 aspect(runtime/knowledge)
//     MTC-4: merges alembic_health + alembic_mcp_status +
//     alembic_codex_diagnostics into one cross-server status tool.
//     Omitting aspect returns the full status; aspect narrows the
//     view (runtime = runtime/diagnostics, knowledge = knowledge stats).
// ══════════════════════════════════════════════════════

export const StatusInput = z.object({
  aspect: z.enum(['runtime', 'knowledge']).optional(),
});
export type StatusInput = z.infer<typeof StatusInput>;

// ══════════════════════════════════════════════════════
//  Host intent / turn metadata — Plugin-owned Codex intake
// ══════════════════════════════════════════════════════

const HostIntentTextField = z.string().min(1).max(1200);

export const HostDeclaredIntentInput = z.object({
  query: HostIntentTextField.optional().describe('Host-declared concise user intent query'),
  summary: HostIntentTextField.optional().describe('Host-declared short intent summary'),
  goal: z.string().min(1).max(600).optional().describe('Host-declared immediate goal'),
  action: z.string().min(1).max(600).optional().describe('Host-declared action hint'),
  scenario: z.string().min(1).max(80).optional().describe('Host-declared scenario label'),
  language: z.string().min(1).max(80).optional().describe('Host-declared language hint'),
  module: z.string().min(1).max(160).optional().describe('Host-declared module hint'),
  labels: z
    .array(z.string().min(1).max(80))
    .max(12)
    .optional()
    .describe('Host-declared short intent labels'),
  keywords: z
    .array(z.string().min(1).max(80))
    .max(12)
    .optional()
    .describe('Host-declared keyword hints for resident search context'),
  sourceRefs: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe('Host-declared non-private source refs for resident search context'),
  confidence: z.number().min(0).max(1).optional().describe('Host-declared confidence 0..1'),
  source: z.string().min(1).max(120).optional().describe('Host source label'),
});
export type HostDeclaredIntentInput = z.infer<typeof HostDeclaredIntentInput>;

export const HostTurnMetaInput = z.object({
  turnId: z.string().min(1).max(160).optional().describe('Host turn identifier'),
  messageId: z.string().min(1).max(160).optional().describe('Host message identifier'),
  threadId: z
    .string()
    .min(1)
    .max(400)
    .optional()
    .describe('Raw host thread id; handler stores only a redacted hash'),
  conversationId: z
    .string()
    .min(1)
    .max(400)
    .optional()
    .describe('Raw host conversation id; handler stores only a redacted hash'),
  sessionId: z
    .string()
    .min(1)
    .max(400)
    .optional()
    .describe('Raw host session id; handler stores only a redacted hash'),
  source: z.string().min(1).max(120).optional().describe('Host metadata source label'),
  surface: z.string().min(1).max(120).optional().describe('Host surface label'),
  timestamp: z.string().min(1).max(120).optional().describe('Host turn timestamp'),
  language: z.string().min(1).max(80).optional().describe('Host turn language hint'),
});
export type HostTurnMetaInput = z.infer<typeof HostTurnMetaInput>;

// ══════════════════════════════════════════════════════
//  Agent-facing public tools — active public surface
// ══════════════════════════════════════════════════════

// RC-5: 与 contract.ts AGENT_HOSTS 对齐为真实双宿主，删除 generic-host-agent。
// 本地内联保留（不 import runtime/contract）以守住 shared 不依赖 runtime 的层级边界。
const AgentHostSchema = z.enum(['codex', 'claude-code']);
const AgentInputSourceSchema = z.enum([
  'host-declared-intent',
  'host-turn-metadata',
  'user-message',
  'automation-envelope',
  'source-ref',
  'tool-result',
]);
const AgentIntentKindSchema = z.enum([
  'implementation-task',
  'fix-task',
  'refactor-task',
  'review-task',
  'read-only-analysis',
  'status-only',
  'decision',
  'design-or-planning',
  'mechanical-envelope',
  'unknown',
]);

const AgentPublicToolBaseInput = z.object({
  agentHost: AgentHostSchema.default('codex').describe('Calling host agent family'),
  inputSource: AgentInputSourceSchema.default('user-message').describe(
    'Enum-first source classification for the current host input'
  ),
  intentKind: AgentIntentKindSchema.optional().describe(
    'Optional host-provided intent kind; handler can infer it when omitted'
  ),
  userQuery: z
    .string()
    .min(1)
    .max(1200)
    .optional()
    .describe(
      'Semantic user query; do not pass raw automation envelopes without hostDeclaredIntent'
    ),
  activeFile: z.string().min(1).max(1200).optional().describe('Current active file hint'),
  language: z.string().min(1).max(80).optional().describe('Current language hint'),
  hostDeclaredIntent: HostDeclaredIntentInput.optional().describe(
    'Structured host-declared intent frame'
  ),
  hostTurnMeta: HostTurnMetaInput.optional().describe(
    'Optional host turn metadata; raw ids are redacted by the handler'
  ),
  sourceRefs: z
    .array(z.string().min(1).max(200))
    .max(50)
    .optional()
    .describe('Non-private source refs used as detailRefs and automation evidence'),
  sourceEvidenceRefs: z
    .array(z.string().min(1).max(240))
    .max(50)
    .optional()
    .describe('Compact non-private source/detail refs used as evidence; never raw source dumps'),
  projectRoot: z
    .string()
    .min(1)
    .max(1200)
    .optional()
    .describe('Absolute target project root supplied by Codex host runtime'),
});

const PrimeTaskActionInput = z.enum([
  'implement',
  'fix',
  'refactor',
  'test-writing',
  'test-repair',
  'code-edit',
  'code-review',
]);
const PrimeLocatorTextInput = z.string().min(1).max(240);
const PrimeLocatorListInput = z.array(PrimeLocatorTextInput).max(12);

const PrimePublicToolBaseInput = AgentPublicToolBaseInput.omit({
  hostDeclaredIntent: true,
  userQuery: true,
});

export const PrimeInput = PrimePublicToolBaseInput.extend({
  taskAction: PrimeTaskActionInput.describe(
    'Code-development action prime is being asked to support before code work'
  ),
  requirementGoal: z
    .string()
    .min(1)
    .max(1200)
    .describe('Concrete feature, fix, refactor, test, or code-review goal to prime for'),
  scenario: PrimeLocatorTextInput.optional().describe(
    'Requirement scenario or usage situation; counts as a prime locator facet'
  ),
  capability: PrimeLocatorTextInput.optional().describe(
    'Capability or subsystem area; counts as a prime locator facet'
  ),
  domainObjects: PrimeLocatorListInput.optional().describe(
    'Domain objects involved in the code task; counts as a prime locator facet'
  ),
  integrationBoundary: PrimeLocatorTextInput.optional().describe(
    'API, MCP, daemon, storage, plugin, Core, host-agent, or other integration boundary'
  ),
  lifecycleHint: PrimeLocatorTextInput.optional().describe(
    'Optional lifecycle or data-flow hint; does not replace a required locator facet'
  ),
  qualityConcerns: PrimeLocatorListInput.optional().describe(
    'Quality concerns such as safety, concurrency, persistence, observability, or testing'
  ),
  labels: PrimeLocatorListInput.optional().describe('Curated short labels for this code task'),
  keywords: PrimeLocatorListInput.optional().describe('Curated keyword hints for this code task'),
})
  .strict()
  .superRefine((value, ctx) => {
    const hasLocatorFacet = Boolean(
      value.scenario?.trim() ||
        value.capability?.trim() ||
        (value.domainObjects?.length ?? 0) > 0 ||
        value.integrationBoundary?.trim() ||
        (value.qualityConcerns?.length ?? 0) > 0
    );
    if (!hasLocatorFacet) {
      ctx.addIssue({
        code: 'custom',
        path: ['locatorFacets'],
        message:
          'alembic_prime requires at least one locator facet: capability, scenario, domainObjects, integrationBoundary, or qualityConcerns.',
      });
    }
  })
  .describe(
    'Standalone code-development Recipe priming. Requires taskAction, requirementGoal, and at least one locator facet; obsolete intentRef/recognizedIntent inputs are not supported.'
  );
export type PrimeInput = z.infer<typeof PrimeInput>;

const AgentRefIdInput = z.string().min(1).max(240);
const AgentSourceFileRefsInput = z.array(z.string().min(1).max(1200)).max(80).optional();

// MTC-7: merged alembic_work_start + alembic_work_finish. phase discriminates;
// start fields (title/workScope) and finish fields (workRef/outcome/summary/
// changedFiles/evidenceRefs/validationPlan/reason) are all optional on the union,
// with per-phase requirements enforced by the handler.
export const WorkInput = AgentPublicToolBaseInput.extend({
  phase: z
    .enum(['start', 'finish'])
    .describe('Work lifecycle phase: start creates a workRef; finish closes an existing workRef.'),
  primeRef: AgentRefIdInput.optional().describe('primeRef returned by alembic_prime'),
  title: z.string().min(1).max(240).optional().describe('phase=start: short work title'),
  workScope: z
    .object({
      goal: z.string().min(1).max(800).optional(),
      files: AgentSourceFileRefsInput,
      summary: z.string().min(1).max(1200).optional(),
    })
    .optional()
    .describe(
      'phase=start: host-declared concrete work scope; used only as evidence, not as hidden policy.'
    ),
  workRef: AgentRefIdInput.optional().describe(
    'phase=finish: workRef returned by an earlier alembic_work phase=start'
  ),
  outcome: z
    .enum(['completed', 'blocked', 'abandoned'])
    .default('completed')
    .optional()
    .describe('phase=finish: host-declared work outcome'),
  summary: z
    .string()
    .min(1)
    .max(1600)
    .optional()
    .describe('phase=finish: concise completion summary'),
  changedFiles: AgentSourceFileRefsInput.describe(
    'phase=finish: task-scoped files changed by this work; used to recommend alembic_code_guard with explicit files.'
  ),
  evidenceRefs: AgentSourceFileRefsInput.describe(
    'phase=finish: non-private evidence refs from build/test/logs'
  ),
  validationPlan: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'phase=finish: optional compact validation advisory supplied by the host. Buckets are advisory and do not replace Guard, repository tests, controller acceptance, or Test-window validation.'
    ),
  reason: z
    .string()
    .min(1)
    .max(1200)
    .optional()
    .describe('phase=finish: blocked or abandoned reason'),
}).describe(
  'Agent-facing work lifecycle. phase=start creates a workRef for concrete implementation/fix/refactor/review work; phase=finish returns finishRef, detailRefs, and scoped Guard recommendation metadata. Does not load knowledge, run Guard, or call legacy task operations.'
);
export type WorkInput = z.infer<typeof WorkInput>;

export const CodeGuardInput = AgentPublicToolBaseInput.extend({
  workRef: AgentRefIdInput.optional().describe(
    'workRef returned by alembic_work phase=start. When files/code are omitted, the current session work record supplies scoped files; missing or unscoped work returns a structured blocker/skip.'
  ),
  files: AgentSourceFileRefsInput.describe(
    'Explicit files to check. This is the preferred scope. Empty or omitted scope returns a structured blocker/skip instead of falling back to whole-diff review.'
  ),
  code: z.string().min(1).max(200000).optional().describe('Inline code to check'),
  filePath: z
    .string()
    .min(1)
    .max(1200)
    .optional()
    .describe('Path hint for inline code language detection'),
  language: z.string().min(1).max(80).optional().describe('Language hint for inline code'),
  operation: z
    .enum(['check', 'review'])
    .optional()
    .describe('Explicit guard operation. check requires code; review requires files.'),
}).describe(
  'Agent-facing scoped code guard. Supported public scopes are explicit files, inline code, or workRef-derived scoped files. diffRef, primeRef, acceptedGuards, and applicableRecipe are intentionally not public until schema, handler, tests, and runtime evidence exist. No-args whole-diff behavior is intentionally blocked.'
);
export type CodeGuardInput = z.infer<typeof CodeGuardInput>;

// ══════════════════════════════════════════════════════
//  2. alembic_project_matrix
// ══════════════════════════════════════════════════════

const KnowledgeContextBudgetInput = z
  .object({
    tokenBudget: z.number().int().min(256).max(100000).optional(),
    itemLimit: z.number().int().min(1).max(500).default(20),
    detailLimit: z.number().int().min(0).max(200).default(20),
    relationHopLimit: z.number().int().min(1).max(10).default(2),
    contentCharLimit: z.number().int().min(120).max(20000).default(1200),
    matrixNodeLimit: z.number().int().min(1).max(5000).default(500),
    nextActionLimit: z.number().int().min(0).max(20).default(5),
  })
  .strict()
  .describe('Budget limits for matrix nodes, refs, relations, text, and next actions.');

const SearchBudgetInput = KnowledgeContextBudgetInput.omit({
  relationHopLimit: true,
})
  .passthrough()
  .describe('Budget limits for search items, detail refs, text, and next actions.');

const KnowledgeContextFreshnessInput = z
  .object({
    policy: z
      .enum(['preferFresh', 'allowStale', 'requireFresh', 'snapshotOnly'])
      .default('preferFresh')
      .describe('Freshness policy for ProjectContext, knowledge, and document domains.'),
    maxAgeMs: z.number().int().min(0).optional(),
    snapshotRef: z.string().min(1).max(240).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

// ══════════════════════════════════════════════════════
//  3. alembic_search
// ══════════════════════════════════════════════════════

const SearchKindInput = z.enum(['all', 'rule', 'pattern', 'fact', 'guide', 'decision', 'standard']);

export const SearchInput = z
  .object({
    operation: z
      .enum(['search', 'get', 'expand'])
      .default('search')
      .describe('search=检索候选 | get=按 ref/id 获取详情 | expand=按 ref/id 展开上下文'),
    query: z.string().min(1).max(4000).optional().describe('Explicit search query text.'),
    keywords: z
      .array(z.string().min(1).max(120))
      .max(40)
      .optional()
      .describe('Optional keyword hints for recipe/knowledge search.'),
    mode: z
      .enum(['auto', 'keyword', 'semantic'])
      .default('auto')
      .describe('auto=自动选策略 | keyword=精确匹配 | semantic=向量语义'),
    kind: SearchKindInput.default('all').describe(
      '过滤知识类型: all/rule/pattern/fact/guide/decision/standard'
    ),
    category: z.string().min(1).max(160).optional(),
    dimensionId: z.string().min(1).max(160).optional(),
    knowledgeType: z.string().min(1).max(160).optional(),
    scope: z.string().min(1).max(160).optional(),
    tags: z.array(z.string().min(1).max(120)).max(40).optional(),
    refId: z.string().min(1).max(240).optional().describe('get/expand 的知识 refId'),
    id: z.string().min(1).max(240).optional().describe('get/expand 的知识 id 别名'),
    detailRefId: z.string().min(1).max(240).optional().describe('get/expand 的 detailRefId'),
    limit: z.number().int().min(1).max(100).default(10),
    language: z.string().optional().describe('按编程语言过滤，如 swift/typescript'),
    projectRoot: z.string().min(1).max(2000).optional(),
    detailLevel: z.enum(['summary', 'standard', 'detailed']).default('summary'),
    budget: SearchBudgetInput.optional(),
    freshnessPolicy: KnowledgeContextFreshnessInput.optional(),
  })
  .passthrough()
  .superRefine((input, ctx) => {
    const ref = input.refId ?? input.id ?? input.detailRefId;
    if (input.operation === 'search') {
      const hasQuery = typeof input.query === 'string' && input.query.length > 0;
      const hasKeywords = (input.keywords?.length ?? 0) > 0;
      const hasExplicitFilter =
        input.kind !== 'all' ||
        typeof input.category === 'string' ||
        typeof input.dimensionId === 'string' ||
        typeof input.knowledgeType === 'string' ||
        typeof input.scope === 'string' ||
        typeof input.language === 'string' ||
        (input.tags?.length ?? 0) > 0;
      if (!hasQuery && !hasKeywords && !hasExplicitFilter) {
        ctx.addIssue({
          code: 'custom',
          message: 'query, keywords, or explicit Recipe metadata filters are required for search',
          path: ['query'],
        });
      }
      return;
    }
    if (!ref) {
      ctx.addIssue({
        code: 'custom',
        message: 'refId, id, or detailRefId is required for get/expand operations',
        path: ['refId'],
      });
    }
  });
export type SearchInput = z.infer<typeof SearchInput>;

// ══════════════════════════════════════════════════════
//  3. alembic_knowledge
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
//  4. alembic_structure
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
//  5. alembic_graph
// ══════════════════════════════════════════════════════

// GMAP-1: `queryKind` is the public alembic_graph selector. The 9 leading values
// map 1:1 onto ProjectContext request classes; path/impact/neighborhood/stats are
// derived from ProjectContext refs/relations. Keep this list in lockstep with
// `AlembicGraphQueryKindSchema` in the service contracts (asserted in tests).
export const GRAPH_QUERY_KINDS = [
  'space',
  'repo',
  'map',
  'module',
  'module-layers',
  'file-flow',
  'file-symbols',
  'source-slice',
  'anchor-range',
  'path',
  'impact',
  'neighborhood',
  'stats',
] as const;

const GraphNodeTypeEnum = z.enum([
  'project',
  'package',
  'target',
  'module',
  'directory',
  'file',
  'symbol',
]);

export const GraphInput = z
  .object({
    queryKind: z
      .enum(GRAPH_QUERY_KINDS)
      .optional()
      .describe(
        'ProjectContext graph query class (defaults to map). ProjectContext kinds: space|repo|map|module|module-layers|file-flow|file-symbols|source-slice|anchor-range. Derived traversals over ProjectContext refs/relations: path|impact|neighborhood|stats.'
      ),
    refId: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe('ProjectContext ref/node id anchor for module/file/anchor/impact/neighborhood.'),
    fromRefId: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe('path queryKind source ProjectContext ref/node id.'),
    toRefId: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe('path queryKind target ProjectContext ref/node id.'),
    filePath: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('Target file for file-flow/file-symbols/source-slice/anchor-range.'),
    symbolName: z.string().min(1).max(240).optional(),
    line: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe('Anchor line for source-slice/anchor-range.'),
    radius: z
      .object({
        maxDepth: z.number().int().min(1).max(10).optional(),
        beforeLines: z.number().int().min(0).max(400).optional(),
        afterLines: z.number().int().min(0).max(400).optional(),
        relationHops: z.number().int().min(0).max(10).optional(),
      })
      .strict()
      .optional()
      .describe('Bounded traversal/source radius for derived and anchor queryKinds.'),
    relationType: z
      .enum([
        'partOf',
        'dependsOn',
        'imports',
        'exports',
        'definesSymbol',
        'referencesSymbol',
        'calls',
        'calledBy',
        'ownsFile',
        'entrypointFor',
      ])
      .optional(),
    query: z.string().min(1).max(4000).optional(),
    activeFile: z.string().min(1).max(2000).optional(),
    hostDeclaredIntent: HostDeclaredIntentInput.optional().describe(
      'Optional host-declared intent frame; query is used when query is omitted.'
    ),
    sourceRefs: z
      .array(z.string().min(1).max(240))
      .max(80)
      .optional()
      .describe('Optional non-private ProjectContext source refs.'),
    sourceEvidenceRefs: z.array(z.string().min(1).max(240)).max(80).optional(),
    projectRoot: z.string().min(1).max(2000).optional(),
    detailLevel: z.enum(['summary', 'standard', 'detailed']).default('summary'),
    budget: KnowledgeContextBudgetInput.optional(),
    freshnessPolicy: KnowledgeContextFreshnessInput.optional(),
    // ── Deprecated stale-input aliases (handler-boundary normalization only) ──
    // Not the public contract; retained so cached host arguments still parse and
    // normalize onto queryKind without a second behavior branch.
    operation: z
      .enum(['query', 'impact', 'path', 'stats', 'neighborhood'])
      .optional()
      .describe('Deprecated: legacy operation; normalized onto queryKind.'),
    nodeId: z.string().min(1).max(240).optional(),
    nodeType: GraphNodeTypeEnum.optional(),
    fromId: z.string().optional(),
    toId: z.string().optional(),
    fromType: GraphNodeTypeEnum.optional(),
    toType: GraphNodeTypeEnum.optional(),
    direction: z.enum(['out', 'in', 'both']).default('both'),
    maxDepth: z.number().int().min(1).max(10).default(2),
  })
  .strict();
export type GraphInput = z.infer<typeof GraphInput>;

// ══════════════════════════════════════════════════════
//  5b. alembic_recipe_map (replaces alembic_project_matrix)
// ══════════════════════════════════════════════════════

export const RecipeMapInput = z
  .object({
    focus: z
      .object({
        kind: z.enum(['space', 'repo', 'map', 'module', 'file', 'symbol', 'anchor']),
        refId: z.string().min(1).max(240).optional(),
        nodeId: z.string().min(1).max(240).optional(),
        filePath: z.string().min(1).max(2000).optional(),
        line: z.number().int().min(1).max(1_000_000).optional(),
        sourceRef: z.string().min(1).max(400).optional(),
        moduleName: z.string().min(1).max(240).optional(),
        repoId: z.string().min(1).max(240).optional(),
      })
      .strict()
      .optional()
      .describe(
        'ProjectContext focus; defaults to space (top-level). Shares ref ids with alembic_graph.'
      ),
    radius: z
      .object({
        upLevels: z.number().int().min(0).max(10).optional(),
        downLevels: z.number().int().min(0).max(10).optional(),
        relationHops: z.number().int().min(0).max(10).optional(),
        beforeLines: z.number().int().min(0).max(400).optional(),
        afterLines: z.number().int().min(0).max(400).optional(),
      })
      .strict()
      .optional(),
    projectRoot: z.string().min(1).max(2000).optional(),
    activeFile: z.string().min(1).max(2000).optional(),
    includeRecipes: z.boolean().default(true),
    includeRollups: z.boolean().default(true),
    recipeMountLimit: z.number().int().min(0).max(200).optional(),
    nodeLimit: z.number().int().min(1).max(500).optional(),
    detailLevel: z.enum(['summary', 'standard', 'detailed']).default('summary'),
  })
  .strict();
export type RecipeMapInput = z.infer<typeof RecipeMapInput>;

// ══════════════════════════════════════════════════════
//  6. alembic_call_context
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
//  7b. alembic_submit_knowledge (unified pipeline)
// ══════════════════════════════════════════════════════

/**
 * 单条知识条目字段定义（items 数组内部元素的严格 Schema）
 * 用于文档/类型推导，实际 items 使用 z.record() 宽容接收后在 handler 层校验。
 */
export const SubmitKnowledgeItemSchema = z.object({
  // ── 必填字段 ──
  title: TitleField.describe('知识标题，简洁明确'),
  language: LanguageField.describe('编程语言，如 typescript/swift/python'),
  content: ContentSchema.describe(
    '内容对象: { pattern?: "代码片段", markdown?: "正文", rationale: "设计原理" }。pattern/markdown 至少提供一个，rationale 必填'
  ),
  kind: StrictKindEnum.describe('rule=规范约束 | pattern=代码模式 | fact=项目事实'),
  doClause: z.string().min(1, 'doClause is required').describe('✅ 应该怎么做（插件适配字段）'),
  dontClause: z.string().min(1, 'dontClause is required').describe('❌ 不应该怎么做'),
  whenClause: z.string().min(1, 'whenClause is required').describe('何时适用'),
  coreCode: z.string().min(1, 'coreCode is required').describe('核心代码片段'),
  category: z
    .string()
    .min(1, 'category is required')
    .describe('View/Service/Tool/Model/Network/Storage/UI/Utility'),
  trigger: z.string().min(1, 'trigger is required').describe('触发关键词，如 @NetworkMonitor'),
  description: z.string().min(1, 'description is required').describe('一句话描述用途'),
  headers: z.array(z.string()).describe('完整 import 语句列表'),
  usageGuide: z
    .string()
    .min(1, 'usageGuide is required')
    .describe('使用指南（Markdown，用 ### 分节：何时用/关键点/何时不用）'),
  knowledgeType: z
    .string()
    .min(1, 'knowledgeType is required')
    .describe('code-pattern/architecture/best-practice/code-standard 等'),
  reasoning: ReasoningSchema.describe(
    '推理对象: { whyStandard: "原因", sources: ["来源"], confidence: 0.0-1.0 }'
  ),
  // ── 可选字段 ──
  dimensionId: z
    .string()
    .optional()
    .describe('维度归属 ID；不要用 category/knowledgeType 表示维度'),
  topicHint: z.string().optional(),
  complexity: ComplexityEnum.optional(),
  scope: ScopeEnum.optional(),
  difficulty: z.string().optional(),
  tags: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  relations: z.record(z.string(), z.unknown()).optional(),
  headerPaths: z.array(z.string()).optional(),
  moduleName: z.string().optional(),
  includeHeaders: z.boolean().optional(),
  source: z.string().optional(),
  unitId: z
    .string()
    .optional()
    .describe('IDEAgentAnalysisUnit.unitId linkage; optional for backwards compatibility'),
  analysisUnitIds: z
    .array(z.string())
    .optional()
    .describe('One or more IDEAgentAnalysisUnit ids covered by this knowledge item'),
  sourceRefs: z
    .array(z.string())
    .optional()
    .describe('Source references used as evidence for IDE Agent unit linkage'),
});

export const SubmitKnowledgeInput = z.object({
  items: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .describe(
      '知识条目数组（1~N 条）。单条与批量统一处理，所有条目严格校验 + 融合分析。' +
        '每条字段: title, language, content(对象), kind, doClause, dontClause, whenClause, coreCode, category(业务/组件分类), trigger, description, headers, usageGuide, knowledgeType(知识类型), reasoning(对象), dimensionId(维度归属)。' +
        '可选 unitId / analysisUnitIds / sourceRefs 用于 IDE Agent packet linkage；sourceRefs 可引用 package.json:1 等根文件；rule/pattern 的单文件正当例外请显式传 scope: "narrow" 或 "file-local"。'
    ),
  target_name: z.string().optional().describe('来源标识，如 network-module-scan'),
  source: z.string().optional().describe('来源标记，默认 mcp'),
  skipConsolidation: z
    .boolean()
    .default(false)
    .describe('跳过融合分析（当确认需要独立新建时设为 true）'),
  skipDuplicateCheck: z.boolean().default(false),
  client_id: z.string().optional(),
  dimensionId: z.string().optional().describe('冷启动/增量扫描关联维度 ID'),
  sessionId: z
    .string()
    .optional()
    .describe('alembic_bootstrap 返回的 bootstrap session id，用于把提交绑定到当前冷启动会话'),
  bootstrapSessionRef: z
    .string()
    .optional()
    .describe('可选：调用方持有的 bootstrap-session:<id> 引用；用于诊断和生产 session 绑定'),
  requireProductionSession: z
    .boolean()
    .optional()
    .describe(
      '可选：要求本次提交绑定可用的 bootstrap/rescan produce session；ASQ/controller 生产证明应设置。'
    ),
  supersedes: z
    .string()
    .optional()
    .describe(
      '声明新 Recipe 替代旧 Recipe 的 ID。提交后系统将创建 supersede 提案，观察窗口内对比新旧表现后自动执行。'
    ),
});
export type SubmitKnowledgeInput = z.infer<typeof SubmitKnowledgeInput>;

// ══════════════════════════════════════════════════════
//  10. alembic_project_skill
// ══════════════════════════════════════════════════════

export const ProjectSkillInput = z.object({
  operation: z
    .enum(['list', 'load', 'export', 'create', 'update', 'upsert', 'delete', 'refresh'])
    .describe(
      'list=列表 | load=从 Codex runtime 或 source 加载 | upsert/create/update=写入 dataRoot source + receipt | refresh=有知识库时刷新知识 skill | export=导出 .agents/skills symlink | delete=删除 Alembic-managed source/runtime'
    ),
  name: z.string().optional().describe('Project Skill 名称（kebab-case）'),
  skillName: z.string().optional().describe('name 的别名，与 name 等价'),
  receiptId: z.string().optional().describe('export 时可按 workflow report 中的 receipt id 查找'),
  receipt: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('export 时可直接传入 ProjectSkillDeliveryReceipt'),
  section: z.string().optional().describe('load 时过滤指定章节'),
  description: z.string().optional().describe('create/update 时的简短描述'),
  content: z.string().optional().describe('create/update 时的 Markdown 内容'),
  overwrite: z.boolean().default(false).describe('只允许覆盖 managed marker 匹配的 runtime export'),
  authorizeProjectSkillExport: z
    .boolean()
    .default(false)
    .describe('显式项目级授权；true 时允许写入当前项目 .agents/skills'),
  createdBy: z
    .enum(['manual', 'user-ai', 'system-ai', 'external-ai', 'host-agent'])
    .default('host-agent'),
});
export type ProjectSkillInput = z.infer<typeof ProjectSkillInput>;

// ══════════════════════════════════════════════════════
//  11. alembic_bootstrap — 仅重建确认参数
// ══════════════════════════════════════════════════════

export const BootstrapInput = z.object({
  // MT1 P1 数据丢失门禁：可用知识库存在时，bootstrap 会把全部现有知识
  // 移入 .asd/.trash/<ts>/ 并从零重建，必须显式 rebuild:true 确认。
  rebuild: z
    .boolean()
    .optional()
    .describe(
      'Required confirmation when a usable knowledge base already exists: pass true to archive ALL existing knowledge to .asd/.trash/<timestamp>/ and rebuild from zero. Without it, bootstrap refuses and recommends alembic_rescan instead.'
    ),
});
export type BootstrapInput = z.infer<typeof BootstrapInput>;

// ══════════════════════════════════════════════════════
//  11a. alembic_rescan — 增量知识更新
// ══════════════════════════════════════════════════════

const ProduceSessionGapInput = z
  .object({
    createBudget: z.number().int().positive().max(20).optional(),
    dimensionId: z.string().optional(),
    gapId: z.string().optional(),
    source: z.string().optional(),
    triggerPrefix: z.string().optional(),
  })
  .passthrough();

const ProduceSessionRouteInput = z
  .object({
    controllerAuthorized: z.boolean().optional(),
    createBudget: z.number().int().positive().max(20).optional(),
    dimensions: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    gaps: z.array(ProduceSessionGapInput).optional(),
    reason: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough();

export const RescanInput = z.object({
  dimensions: z.array(z.string()).optional().describe('指定维度列表，空 = 全部活跃维度'),
  reason: z.string().optional().describe('触发原因（记录到报告）'),
  force: z
    .boolean()
    .optional()
    .describe('强制全量重扫（清会话态缓存 + 全量 Phase 1-4，但保留增量快照）'),
  produceSession: ProduceSessionRouteInput.optional().describe(
    '可选：打开或返回 controller 授权的非破坏性 produce session，供 alembic_submit_knowledge 绑定 sessionId/bootstrapSessionRef 使用'
  ),
  controllerAuthorizedGaps: z
    .array(ProduceSessionGapInput)
    .optional()
    .describe('可选：produceSession.gaps 的兼容顶层别名'),
  produceSessionDimensions: z
    .array(z.string())
    .optional()
    .describe('可选：produceSession.dimensions 的兼容顶层别名'),
  controllerAuthorized: z.boolean().optional().describe('可选：顶层 controller 授权标志'),
});
export type RescanInput = z.infer<typeof RescanInput>;

// ══════════════════════════════════════════════════════
//  11b. alembic_dimension_complete
// ══════════════════════════════════════════════════════

export const DimensionCompleteInput = z.object({
  sessionId: z.string().optional(),
  dimensionId: z.string().min(1, 'dimensionId is required'),
  submittedRecipeIds: z.array(z.string()).optional(),
  unitId: z.string().optional().describe('单个 IDEAgentAnalysisUnit id；兼容 analysisUnitIds 简写'),
  analysisUnitIds: z
    .array(z.string())
    .optional()
    .describe('本次完成覆盖的 IDEAgentAnalysisUnit ids'),
  skippedAnalysisUnitIds: z
    .array(z.string())
    .optional()
    .describe('本次显式跳过的 IDEAgentAnalysisUnit ids'),
  rejectedAnalysisUnitIds: z
    .array(z.string())
    .optional()
    .describe('本次拒绝或无法完成的 IDEAgentAnalysisUnit ids'),
  remainingAnalysisUnitIds: z
    .array(z.string())
    .optional()
    .describe('宿主仍需继续处理的 IDEAgentAnalysisUnit ids'),
  deviationReason: z
    .string()
    .optional()
    .describe('跳过、拒绝或偏离 Core completionContract 的原因'),
  analysisText: z
    .string()
    .min(1, 'analysisText is required')
    .describe(
      '维度分析报告（Markdown）。写得越详细，生成的 Skill 质量越高；若过短，系统会自动从候选知识中合成。'
    ),
  referencedFiles: z.array(z.string()).optional(),
  keyFindings: z.array(z.string()).optional(),
  candidateCount: z.number().int().min(0).optional(),
  crossDimensionHints: z.record(z.string(), z.string()).optional(),
});
export type DimensionCompleteInput = z.infer<typeof DimensionCompleteInput>;

// ══════════════════════════════════════════════════════
//  12. alembic_capabilities — 无参数
// ══════════════════════════════════════════════════════

export const CapabilitiesInput = z.object({});
export type CapabilitiesInput = z.infer<typeof CapabilitiesInput>;

// ══════════════════════════════════════════════════════
//  13. Retired task lifecycle schema.
//  Kept for historical unit coverage and migration evidence only; it is not in
//  TOOL_SCHEMAS and must not be exposed as a Codex MCP tool.
// ══════════════════════════════════════════════════════

export const TaskInput = z.object({
  operation: z
    .enum(['prime', 'create', 'close', 'fail', 'record_decision'])
    .describe(
      'Legacy compatibility operation. Prefer public tools: alembic_prime, alembic_work, and alembic_code_guard.'
    ),
  title: z.string().optional().describe('Task title; legacy record_decision title is blocked'),
  description: z
    .string()
    .optional()
    .describe('Legacy record_decision description; blocked in favor of alembic_decision_record'),
  id: z
    .string()
    .optional()
    .describe('Task ID (close / fail). Optional if a task was created in the current session.'),
  taskId: z.string().optional().describe('Alias for id (accepted for convenience)'),
  reason: z.string().optional().describe('Close/fail reason'),
  rationale: z
    .string()
    .optional()
    .describe('Legacy record_decision rationale; blocked in favor of alembic_decision_record'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Legacy record_decision tags; blocked in favor of alembic_decision_record'),
  userQuery: z
    .string()
    .optional()
    .describe(
      'Semantic current user input for knowledge-aware search. Prefer hostDeclaredIntent over raw automation/direct-thread envelopes.'
    ),
  activeFile: z.string().optional().describe('Currently active file path in IDE'),
  language: z.string().optional().describe('Current programming language'),
  hostDeclaredIntent: HostDeclaredIntentInput.optional().describe(
    'Optional host-declared intent frame. Backward compatible with userQuery/activeFile/language.'
  ),
  hostTurnMeta: HostTurnMetaInput.optional().describe(
    'Optional host turn metadata. The handler only keeps redacted allowlisted fields.'
  ),
  changedFiles: z
    .array(z.string().min(1).max(200))
    .max(50)
    .optional()
    .describe(
      'Task-scoped files changed by this legacy task; compatibility close uses them to recommend explicit alembic_code_guard scope.'
    ),
  sourceRefs: z
    .array(z.string().min(1).max(200))
    .max(50)
    .optional()
    .describe(
      'Optional non-private source refs for legacy task-scope evidence and public-tool detailRefs.'
    ),
});
export type TaskInput = z.infer<typeof TaskInput>;

// ══════════════════════════════════════════════════════
//  Admin Tools
// ══════════════════════════════════════════════════════

// 14. alembic_knowledge_lifecycle
export const KnowledgeLifecycleInput = z.object({
  id: IdField,
  action: z
    // Codex MCP 默认不开放 Recipe 发布 / 废弃权限；这些能力走 Dashboard 或明确 admin 路径。
    .enum(['reactivate'])
    .describe(
      'reactivate=请求将 deprecated Recipe 恢复为 pending review；publish/deprecate/approve/fast_track 不对默认 Codex agent 开放，请走 Dashboard 或 admin 路径'
    ),
  reason: z
    .string()
    .optional()
    .describe('reactivate 的原因；发布、废弃、审核操作不通过此 MCP 工具执行'),
});
export type KnowledgeLifecycleInput = z.infer<typeof KnowledgeLifecycleInput>;

// 19. alembic_evolve
const EvolveDecisionSchema = z.object({
  recipeId: z.string().describe('目标 Recipe ID'),
  action: z
    .enum(['propose_evolution', 'confirm_deprecation', 'skip'])
    .describe('propose_evolution=提案进化 | confirm_deprecation=确认废弃 | skip=跳过'),
  evidence: z
    .object({
      codeSnippet: z.string().describe('读到的真实代码片段'),
      filePath: z.string().describe('代码所在文件路径'),
      type: z
        .enum(['enhance', 'correction'])
        .describe('enhance=模式迁移/功能扩展 | correction=描述错误/接口变更'),
      suggestedChanges: z.string().describe('建议的内容变更'),
    })
    .optional()
    .describe('propose_evolution 时必填'),
  reason: z.string().optional().describe('confirm_deprecation 时必填，废弃原因'),
  skipReason: z
    .enum(['still_valid', 'insufficient_info'])
    .optional()
    .describe('skip 时必填: still_valid=仍然有效(刷新验证时间) | insufficient_info=信息不足'),
});

export const EvolveInput = z.object({
  decisions: z
    .array(EvolveDecisionSchema)
    .min(1)
    .describe('进化决策数组，每个元素对应一个 Recipe 的决策'),
});
export type EvolveInput = z.infer<typeof EvolveInput>;

// ── alembic_consolidate ──

const ConsolidateDecisionSchema = z.object({
  newRecipeId: z.string().describe('新创建的 Recipe ID（pendingSemanticReview 中返回的）'),
  action: z
    .enum(['keep', 'merge', 'reject'])
    .describe('keep=保留为独立 Recipe, merge=合并到已有 Recipe, reject=拒绝（deprecated）'),
  mergeTargetId: z.string().optional().describe('action=merge 时必填: 合并目标的已有 Recipe ID'),
  mergeStrategy: z
    .enum(['absorb', 'complement'])
    .optional()
    .describe('absorb=完全吸收, complement=补充新维度'),
  reasoning: z.string().describe('Agent 解释决策原因'),
});

export const ConsolidateInput = z.object({
  decisions: z
    .array(ConsolidateDecisionSchema)
    .min(1)
    .describe('语义融合决策数组，每个元素对应一个 pendingSemanticReview 条目的决策'),
});
export type ConsolidateInput = z.infer<typeof ConsolidateInput>;

// ══════════════════════════════════════════════════════
//  工具名 → Schema 映射表（用于 wrapHandler 自动注入校验）
// ══════════════════════════════════════════════════════

// QD2 schema honesty (CODE-GUARD-SCHEMA-LOOSENESS): reject unknown top-level
// keys at call-time parse so malformed input fails with a structured
// VALIDATION_ERROR instead of being silently stripped. This does NOT move the
// published tools/list wire schema — zodToMcpSchema strips
// additionalProperties:false, so the strict and non-strict variants serialize
// identically; only the runtime parse tightens. No routed schema uses
// .passthrough()/.catchall(), so every documented field-set still parses; any
// tool that legitimately needed extra keys would be excluded here (none do).
function strictToolInput(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodObject ? schema.strict() : schema;
}

const ROUTED_TOOL_SCHEMAS: Record<string, z.ZodType> = {
  alembic_prime: PrimeInput,
  alembic_recipe_map: RecipeMapInput,
  alembic_work: WorkInput,
  alembic_code_guard: CodeGuardInput,
  alembic_status: StatusInput,
  alembic_search: SearchInput,
  alembic_graph: GraphInput,
  alembic_submit_knowledge: SubmitKnowledgeInput,
  alembic_project_skill: ProjectSkillInput,
  alembic_bootstrap: BootstrapInput,
  alembic_rescan: RescanInput,
  alembic_dimension_complete: DimensionCompleteInput,
  alembic_knowledge_lifecycle: KnowledgeLifecycleInput,
  alembic_evolve: EvolveInput,
  alembic_consolidate: ConsolidateInput,
};

export const TOOL_SCHEMAS: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(ROUTED_TOOL_SCHEMAS).map(([name, schema]) => [name, strictToolInput(schema)])
);
