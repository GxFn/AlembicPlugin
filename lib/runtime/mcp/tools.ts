/**
 * MCP Tool Definitions — V3 Routed Surface (19 agent + 1 admin = 20 tools)
 *
 * Each tool declaration contains name, tier (agent/admin), description, and inputSchema.
 * description is the key for Agent tool selection — use bullet list to enumerate all operations and their purposes.
 * inputSchema is auto-generated from Zod Schema (zodToMcpSchema); parameter .describe() translates to JSON Schema description.
 *
 * Agent tools:
 *   Agent-facing public tools: prime/work/code_guard
 *   Query tools: health/recipe_map/search/graph/guard
 *   Write tool: submit_knowledge
 *   Project Skill delivery: project_skill
 *   Workflow tools: bootstrap/rescan/evolve/consolidate/dimension_complete
 *
 * Admin tools (1):
 *   knowledge_lifecycle
 */

import { z } from 'zod';

import {
  BootstrapInput,
  CodeGuardInput,
  ConsolidateInput,
  DimensionCompleteInput,
  EvolveInput,
  GraphInput,
  KnowledgeLifecycleInput,
  PlanInput,
  PrimeInput,
  ProjectSkillInput,
  RecipeMapInput,
  RescanInput,
  SearchInput,
  StatusInput,
  SubmitKnowledgeInput,
  WorkInput,
} from '#shared/schemas/mcp-tools.js';
import {
  TOOL_GATEWAY_MAP,
  withPluginToolAnnotations,
} from '../../runtime/mcp/PluginToolSurfaceCatalog.js';
import '../../runtime/mcp/core-tools/output.js';
// MTC-4: alembic_status is a cross-server tool (resident core surface + cold-start
// local surface). Its single output projector is homed in codex-local/output, so it
// must be co-registered wherever TOOLS loads (both the resident and cold-start shells
// import tools.ts), otherwise the resident alembic_status output has no projector.
import '../../runtime/mcp/local-tools/output.js';
import '../../runtime/mcp/knowledge-context-tools/graph-output.js';
import '../../runtime/mcp/knowledge-context-tools/output.js';
import '../../runtime/mcp/knowledge-context-tools/recipe-map-output.js';
import '../../runtime/mcp/knowledge-context-tools/search-output.js';
import { getAgentPublicToolDescriptionBase } from '../../runtime/mcp/public-tools/descriptions.js';
import '../../runtime/mcp/public-tools/output.js';
import { zodToMcpSchema } from '../../runtime/mcp/zodToMcpSchema.js';

// RescanInput may be undefined under certain Vitest module transforms; provide defensive fallback
const _RescanSchema =
  RescanInput ??
  z.object({
    planSelection: z
      .object({
        generationStage: z.enum(['deepMining', 'moduleMining']),
        dimensions: z.array(z.string()).min(1),
        scale: z.object({
          totalRecipeBudget: z.number().int().positive(),
          maxFiles: z.number().int().positive().optional(),
          contentMaxLines: z.number().int().positive().optional(),
          depthLevels: z.array(z.string()).optional(),
        }),
        moduleBindings: z
          .array(
            z.object({
              modulePath: z.string().min(1),
              moduleId: z.string().optional(),
              dimensions: z.array(z.string()).optional(),
              targetRecipes: z.number().int().nonnegative().optional(),
              priority: z.number().int().positive().optional(),
            })
          )
          .min(1),
      })
      .strict(),
    dimensions: z.array(z.string()).optional(),
    reason: z.string().optional(),
    force: z.boolean().optional(),
    generationStage: z.enum(['deepMining', 'moduleMining']).optional(),
    testMode: z.boolean().optional(),
    moduleScope: z.array(z.string()).optional(),
    scaleOverride: z
      .object({
        maxFiles: z.number().int().positive().optional(),
        contentMaxLines: z.number().int().positive().optional(),
        totalRecipeBudget: z.number().int().positive().optional(),
      })
      .optional(),
    rescanId: z.string().optional(),
    produceSession: z.record(z.string(), z.unknown()).optional(),
    controllerAuthorizedGaps: z.array(z.record(z.string(), z.unknown())).optional(),
    produceSessionDimensions: z.array(z.string()).optional(),
    controllerAuthorized: z.boolean().optional(),
  });

// EvolveInput — same defensive fallback for Vitest module transform edge case
const _EvolveSchema =
  EvolveInput ??
  z.object({
    decisions: z
      .array(
        z.object({
          recipeId: z.string(),
          action: z.enum(['propose_evolution', 'confirm_deprecation', 'skip']),
          evidence: z
            .object({
              codeSnippet: z.string(),
              filePath: z.string(),
              type: z.enum(['enhance', 'correction']),
              suggestedChanges: z.string(),
            })
            .optional(),
          reason: z.string().optional(),
          skipReason: z.enum(['still_valid', 'insufficient_info']).optional(),
        })
      )
      .min(1),
  });

// ConsolidateInput — defensive fallback for Vitest module transform edge case
const _ConsolidateSchema =
  ConsolidateInput ??
  z.object({
    decisions: z
      .array(
        z.object({
          newRecipeId: z.string(),
          action: z.enum(['keep', 'merge', 'reject']),
          mergeTargetId: z.string().optional(),
          mergeStrategy: z.enum(['absorb', 'complement']).optional(),
          reasoning: z.string(),
        })
      )
      .min(1),
  });

// ─── Tier Definitions ────────────────────────────────────────
export const TIER_ORDER = { agent: 0, admin: 1 };

export const withMcpToolAnnotations = withPluginToolAnnotations;
export { TOOL_GATEWAY_MAP };

const PRIME_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_prime');
const WORK_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_work');
const CODE_GUARD_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_code_guard');

// ─── Tool Declarations ───────────────────────────────────────

export const TOOLS = [
  // ══════════════════════════════════════════════════════
  //  Tier: agent — Core Agent Toolset (19)
  // ══════════════════════════════════════════════════════

  // Agent-facing public workflow tools
  {
    name: 'alembic_prime',
    tier: 'agent',
    description:
      `${PRIME_DESCRIPTION.title}. ${PRIME_DESCRIPTION.purpose}\n` +
      `${PRIME_DESCRIPTION.selectionHint} It is reserved for code-development Recipe priming and skips or blocks non-code, low-information, and obsolete intent-route inputs before retrieval.\n` +
      `Non-goal: ${PRIME_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(PrimeInput),
  },

  {
    name: 'alembic_recipe_map',
    tier: 'agent',
    description:
      'Map Recipes onto a bounded ProjectContext region (replaces alembic_project_matrix). Pick a focus {kind: space|repo|map|module|file|symbol|anchor, refId/filePath/line}:\n' +
      '• region — rootNode, breadcrumb, and bounded child nodes (shares ref ids with alembic_graph)\n' +
      '• recipeMounts — Recipes mounted deterministically onto nodes via recipe_source_refs + explicit metadata only (never semantic/keyword); full mountType enum + reason\n' +
      '• recipeRollups — direct/descendant Recipe counts + representative ids per node\n' +
      '• diagnostics — stale/unresolved/cross-repo/unmounted source refs\n' +
      'Returns bounded output with no full Recipe body. nextActions point to alembic_graph (structure), alembic_search (Recipe detail by id), alembic_prime (task semantics).',
    inputSchema: zodToMcpSchema(RecipeMapInput),
  },

  // MTC-7: merged the former split work lifecycle tools into one phase-routed tool.
  {
    name: 'alembic_work',
    tier: 'agent',
    description:
      `${WORK_DESCRIPTION.title}. ${WORK_DESCRIPTION.purpose}\n` +
      `${WORK_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${WORK_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(WorkInput),
  },

  {
    name: 'alembic_code_guard',
    tier: 'agent',
    description:
      `${CODE_GUARD_DESCRIPTION.title}. ${CODE_GUARD_DESCRIPTION.purpose}\n` +
      `${CODE_GUARD_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${CODE_GUARD_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(CodeGuardInput),
  },

  {
    name: 'alembic_status',
    tier: 'agent',
    description:
      'Check Alembic runtime status, diagnostics, and knowledge base stats. Optional aspect narrows the view: runtime = runtime/diagnostics, knowledge = knowledge base stats (recipes/candidates/index). Omit aspect for the full status. When knowledge is empty, cold-start is needed (call alembic_bootstrap).',
    inputSchema: zodToMcpSchema(StatusInput),
  },

  // Unified Search
  {
    name: 'alembic_search',
    tier: 'agent',
    description:
      'Search, get, or expand compact Recipe / knowledge context.\n' +
      '• search — direct lookup by explicit query, keywords, mode, and Recipe metadata filters\n' +
      '• get — retrieve one result by refId/id/detailRefId as a bounded clean output\n' +
      '• expand — expand one detailRef without broad search fallback\n' +
      'Returns summary-only visible text plus structured detailRefs, direct whyMatched evidence, scoreBreakdown, and degraded diagnostics when available. Non-goal: no host-intent relevance, relation-chain traversal, prime context material, usage-confirmation operations, lifecycle mutation, or full Recipe browsing.',
    inputSchema: zodToMcpSchema(SearchInput),
  },

  // Project Graph
  {
    name: 'alembic_graph',
    tier: 'agent',
    description:
      'Pure ProjectContext graph queries over project structure, packages, modules, source files, symbols, and stable refs. Select a queryKind:\n' +
      '• space / repo / map — project, repo, and architecture-map overviews\n' +
      '• module / module-layers — module detail and layered file groups\n' +
      '• file-flow / file-symbols / source-slice — file imports/exports, file symbols, and bounded source slices (filePath)\n' +
      '• anchor-range — bounded ref/symbol/slice radius around a file line\n' +
      '• path / impact / neighborhood / stats — relation path, impact radius, node neighborhood, and graph counts derived from ProjectContext refs/relations\n' +
      'Returns a Recipe-free AlembicGraphOutput (nodes, relations, ProjectContext refs, optional slices, diagnostics). Non-goal: no Recipe ids/summaries/mounts/relation-chains, no search scores, no semantic prime, no knowledge categories.',
    inputSchema: zodToMcpSchema(GraphInput),
  },

  // Submit Knowledge (Unified Pipeline)
  {
    name: 'alembic_plan',
    tier: 'agent',
    description:
      'Prepare the stateless planSelection required immediately before Alembic Recipe generation.\n' +
      '• draft — collect bounded real ProjectContext as projectInfoTree plus the full candidate dimension catalog and Agent decision checklist for one generation stage\n' +
      '• confirm — validate the Agent-authored single-stage selection and return planSelection {generationStage, dimensions, scale, moduleBindings}; it is not persisted\n' +
      '• get — removed compatibility route; run draft + confirm again for the next cold-start/deep/module execution\n' +
      'Non-goal: does not start generation, bootstrap, rescan, vector jobs, or any durable Plan ledger write.',
    inputSchema: zodToMcpSchema(PlanInput),
  },

  {
    name: 'alembic_submit_knowledge',
    tier: 'agent',
    description:
      'Submit knowledge entries (single/batch unified pipeline). Pass 1~N items via the items array.\n' +
      '• All entries undergo strict validation; all V3 fields must be provided at once\n' +
      '• Unified consolidation analysis: detects overlap with existing Recipes and batch candidates\n' +
      '• Overlap detected → evolution proposal created automatically (merge/enhance/reorganize); system auto-executes after observation window\n' +
      '• Set skipConsolidation: true to skip consolidation check. content and reasoning must be objects.\n' +
      '• Set supersedes: "old-recipe-id" to declare the new Recipe replaces an existing one (creates a supersede proposal with observation window).\n' +
      '• Optional unitId / analysisUnitIds / sourceRefs link submissions to Core HostAgentAnalysisUnit progress; omit them for legacy flows.\n' +
      '• Evidence refs may cite root-level files such as package.json:1; rule/pattern candidates normally need 3 distinct files, or scope: "narrow" / "file-local" for a legitimate local rule.\n' +
      '• P5 quality: EN verb-led do/dont; content.markdown needs ✅/❌ contrast.\n' +
      '⚠️ Batch rule: items in the array must NOT be cross-redundant — no highly overlapping doClause/coreCode/trigger within the same batch. ' +
      'If two entries share 80%+ content, merge into one or split into primary + extends supplementary entries.',
    inputSchema: zodToMcpSchema(SubmitKnowledgeInput),
  },

  // Project Skill Management
  {
    name: 'alembic_project_skill',
    tier: 'agent',
    description:
      'Codex Project Skill delivery and runtime export.\n' +
      '• list — list built-in skills, dataRoot source skills, Codex runtime exports, and effective winners\n' +
      '• load — load a skill, preferring Codex project runtime `.agents/skills/<name>/SKILL.md`, then dataRoot source, then built-in\n' +
      '• upsert/create/update — write source to `dataRoot/Alembic/skills/<name>/`, produce a Plugin route receipt, and optionally export\n' +
      '• refresh — only when the current dataRoot has knowledge_entries, candidates, or recipes, refresh knowledge-dependent same-name Project Skills\n' +
      '• export — symlink source SKILL.md into `.agents/skills` after authorizeProjectSkillExport=true\n' +
      '• delete — delete Alembic-managed source/runtime projection; built-in plugin skills remain read-only',
    inputSchema: zodToMcpSchema(ProjectSkillInput),
  },

  // Cold-Start Bootstrap
  {
    name: 'alembic_bootstrap',
    tier: 'agent',
    description:
      'Plan-selection-driven cold-start — requires planSelection from a just-run alembic_plan confirm before any generation or cleanup. DESTRUCTIVE on an existing knowledge base unless testMode:true: all current knowledge is archived to .asd/.trash/<timestamp>/ and rebuilt from zero, so when a usable knowledge base exists this tool refuses unless called with rebuild:true (prefer alembic_rescan to refresh while preserving Recipes). testMode:true skips fullReset and uses bounded planSelection dimensions/scale. Auto-analyzes the project and returns a Mission Briefing:\n' +
      '• Project metadata and language statistics\n' +
      '• planSelection dimension task list and scale\n' +
      '• hostAgentAnalysis packet summary, next units, retrieval hints, and unit progress seed (ideAgentAnalysis remains a compatibility alias)\n' +
      '• planGate/planState projection showing execution dimensions, gaps, cleanupPolicy, and module scope\n' +
      '• Execution plan and submission examples\n' +
      'After receiving the Briefing, complete all dimension analyses per the executionPlan.',
    inputSchema: zodToMcpSchema(BootstrapInput),
  },

  // Incremental Rescan
  {
    name: 'alembic_rescan',
    tier: 'agent',
    description:
      'Plan-selection-driven incremental rescan / moduleMining — requires planSelection from a just-run alembic_plan confirm before cleanup or generation.\n' +
      '• deepMining snapshots approved Recipes → cleans derived caches → planSelection ProjectContext analysis\n' +
      '• moduleMining or testMode uses cleanupPolicy:none and scoped ProjectContext module analysis, preserving candidates/wiki/cache\n' +
      '• Runs relevance audit (evidence check, auto-decay stale Recipes)\n' +
      '\u2022 Returns Mission Briefing with allRecipes (full content + auditHint per recipe)\n' +
      '\u2022 Includes hostAgentAnalysis packet summary, next units, retrieval hints, and unit progress seed (ideAgentAnalysis remains a compatibility alias)\n' +
      '\u2022 Includes planGate/planState projection with coverage gaps, execution dimensions, moduleScope, cleanupPolicy, and scale\n' +
      '\u2022 Per-dimension workflow: evolve (alembic_evolve) \u2192 gap-fill (submit_knowledge) \u2192 dimension_complete\n' +
      '\u2022 Optional: dimensions/reason/generationStage/moduleScope/testMode/scaleOverride plus controller-authorized produceSession fields for session-bound ASQ publication',
    inputSchema: zodToMcpSchema(_RescanSchema),
  },

  // Recipe Evolution
  {
    name: 'alembic_evolve',
    tier: 'agent',
    description:
      'Batch Recipe evolution decisions. Dual-entry tool:\n' +
      '\u2022 Rescan mode: called per-dimension before gap-fill (evolve \u2192 submit \u2192 complete)\n' +
      '\u2022 Standalone mode: user triggers directly to verify Recipe validity\n' +
      'Three decision types per Recipe:\n' +
      '\u2022 propose_evolution \u2014 code changed, suggest Recipe update (enters observation window)\n' +
      '\u2022 confirm_deprecation \u2014 pattern disappeared, deprecate Recipe immediately\n' +
      '\u2022 skip \u2014 still_valid (refreshes lastVerifiedAt) or insufficient_info',
    inputSchema: zodToMcpSchema(_EvolveSchema),
  },

  // Consolidation Review
  {
    name: 'alembic_consolidate',
    tier: 'agent',
    description:
      'Semantic consolidation review for ambiguous Recipe overlaps.\n' +
      'Called after alembic_submit_knowledge when pendingSemanticReview items exist (nextAction tail instruction).\n' +
      'Three decision types per Recipe:\n' +
      '\u2022 keep \u2014 Recipe is genuinely independent, retain as-is\n' +
      '\u2022 merge \u2014 merge new Recipe into existing one (requires mergeTargetId)\n' +
      '\u2022 reject \u2014 Recipe is redundant, deprecate immediately',
    inputSchema: zodToMcpSchema(_ConsolidateSchema),
  },

  // Dimension Complete Notification
  {
    name: 'alembic_dimension_complete',
    tier: 'agent',
    description:
      'Dimension analysis completion notification. Handles: Recipe linking, Skill generation (auto-synthesized from submitted candidates), Checkpoint saving, cross-dimension Hints distribution.\n' +
      'analysisText can be brief — the system auto-synthesizes detailed content from submitted candidates for Skill generation.\n' +
      'Optional unitId / analysisUnitIds / skippedAnalysisUnitIds / rejectedAnalysisUnitIds / remainingAnalysisUnitIds / deviationReason backfill IDE Agent unit progress.',
    inputSchema: zodToMcpSchema(DimensionCompleteInput),
  },

  // ══════════════════════════════════════════════════════
  //  Tier: admin — Admin/CI Tools (+1)
  // ══════════════════════════════════════════════════════

  // Knowledge Lifecycle
  {
    name: 'alembic_knowledge_lifecycle',
    tier: 'admin',
    description:
      'Knowledge lifecycle operation exposed to Codex MCP. Only reactivate is allowed here: deprecated Recipe → pending review. publish/deprecate/approve/fast_track are not available to the default Codex agent; use Dashboard or an explicit admin path instead.',
    inputSchema: zodToMcpSchema(KnowledgeLifecycleInput),
  },
];
