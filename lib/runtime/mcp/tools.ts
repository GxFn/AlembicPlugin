/**
 * MCP Tool Definitions — V3 Routed Surface (21 agent + 1 admin = 22 tools)
 *
 * Each tool declaration contains name, tier (agent/admin), description, and inputSchema.
 * description is the key for Agent tool selection — use bullet list to enumerate all operations and their purposes.
 * inputSchema is auto-generated from Zod Schema (zodToMcpSchema); parameter .describe() translates to JSON Schema description.
 *
 * Agent tools:
 *   Agent-facing public tools: intent/prime/work_start/work_finish/code_guard/decision_record
 *   Query tools: health/search/knowledge/structure/graph/call_context/guard
 *   Write tool: submit_knowledge
 *   Project Skill delivery: project_skill
 *   Workflow tools: bootstrap/rescan/evolve/consolidate/dimension_complete/panorama
 *
 * Admin tools (1):
 *   knowledge_lifecycle
 */

import { z } from 'zod';

import {
  BootstrapInput,
  CallContextInput,
  CodeGuardInput,
  ConsolidateInput,
  DecisionRecordInput,
  DimensionCompleteInput,
  EvolveInput,
  GraphInput,
  GuardInput,
  HealthInput,
  IntentInput,
  KnowledgeInput,
  KnowledgeLifecycleInput,
  PanoramaInput,
  PrimeInput,
  ProjectMatrixInput,
  ProjectSkillInput,
  RescanInput,
  SearchInput,
  StructureInput,
  SubmitKnowledgeInput,
  WorkFinishInput,
  WorkStartInput,
} from '#shared/schemas/mcp-tools.js';
import {
  TOOL_GATEWAY_MAP,
  withPluginToolAnnotations,
} from '../../runtime/mcp/PluginToolSurfaceCatalog.js';
import '../../runtime/mcp/core-tools/output.js';
import '../../runtime/mcp/knowledge-context-tools/output.js';
import { getAgentPublicToolDescriptionBase } from '../../runtime/mcp/public-tools/descriptions.js';
import '../../runtime/mcp/public-tools/output.js';
import { zodToMcpSchema } from '../../runtime/mcp/zodToMcpSchema.js';

// RescanInput may be undefined under certain Vitest module transforms; provide defensive fallback
const _RescanSchema =
  RescanInput ??
  z.object({
    dimensions: z.array(z.string()).optional(),
    reason: z.string().optional(),
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

const INTENT_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_intent');
const PRIME_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_prime');
const WORK_START_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_work_start');
const WORK_FINISH_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_work_finish');
const CODE_GUARD_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_code_guard');
const DECISION_RECORD_DESCRIPTION = getAgentPublicToolDescriptionBase('alembic_decision_record');

// ─── Tool Declarations ───────────────────────────────────────

export const TOOLS = [
  // ══════════════════════════════════════════════════════
  //  Tier: agent — Core Agent Toolset (21)
  // ══════════════════════════════════════════════════════

  // Agent-facing public workflow tools
  {
    name: 'alembic_intent',
    tier: 'agent',
    description:
      `${INTENT_DESCRIPTION.title}. ${INTENT_DESCRIPTION.purpose}\n` +
      `${INTENT_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${INTENT_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(IntentInput),
  },

  {
    name: 'alembic_prime',
    tier: 'agent',
    description:
      `${PRIME_DESCRIPTION.title}. ${PRIME_DESCRIPTION.purpose}\n` +
      `${PRIME_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${PRIME_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(PrimeInput),
  },

  {
    name: 'alembic_project_matrix',
    tier: 'agent',
    description:
      'Compact, read-only project matrix.\n' +
      '• overview — project hierarchy, key nodes, structural hotspots, source graph status, knowledge category summary, refs, and nextActions\n' +
      '• node — expand one matrix node only\n' +
      '• relations/layers/sources/catalog — bounded internal relations, layer/source summaries, or knowledge category catalog\n' +
      'Does not return full source, full file lists, full Recipe text, full graph edge sets, lifecycle/governance actions, or knowledge coverage judgments.',
    inputSchema: zodToMcpSchema(ProjectMatrixInput),
  },

  {
    name: 'alembic_work_start',
    tier: 'agent',
    description:
      `${WORK_START_DESCRIPTION.title}. ${WORK_START_DESCRIPTION.purpose}\n` +
      `${WORK_START_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${WORK_START_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(WorkStartInput),
  },

  {
    name: 'alembic_work_finish',
    tier: 'agent',
    description:
      `${WORK_FINISH_DESCRIPTION.title}. ${WORK_FINISH_DESCRIPTION.purpose}\n` +
      `${WORK_FINISH_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${WORK_FINISH_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(WorkFinishInput),
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
    name: 'alembic_decision_record',
    tier: 'agent',
    description:
      `${DECISION_RECORD_DESCRIPTION.title}. ${DECISION_RECORD_DESCRIPTION.purpose}\n` +
      `${DECISION_RECORD_DESCRIPTION.selectionHint}\n` +
      `Non-goal: ${DECISION_RECORD_DESCRIPTION.nonGoal}`,
    inputSchema: zodToMcpSchema(DecisionRecordInput),
  },

  {
    name: 'alembic_health',
    tier: 'agent',
    description:
      'Check service status and knowledge base stats. Returns total (entry count) and kind/lifecycle distribution. When total=0, cold-start is needed (call alembic_bootstrap).',
    inputSchema: zodToMcpSchema(HealthInput),
  },

  // Unified Search
  {
    name: 'alembic_search',
    tier: 'agent',
    description:
      'Search the knowledge base. 5 modes:\n' +
      '• auto (default) — automatically selects optimal strategy\n' +
      '• keyword — exact keyword matching, best for trigger/title lookup\n' +
      '• bm25 — full-text search, best for natural language descriptions\n' +
      '• semantic — vector semantic search, best for fuzzy concept matching\n' +
      '• context — combined search + context association, best for coding assistance\n' +
      'Returns results grouped by kind (rule/pattern/fact).',
    inputSchema: zodToMcpSchema(SearchInput),
  },

  // Knowledge Browser
  {
    name: 'alembic_knowledge',
    tier: 'agent',
    description:
      'Knowledge entry management.\n' +
      '• list — filter entries by kind/category/status\n' +
      '• get — retrieve full content of a single entry (requires id)\n' +
      '• insights — quality analysis and improvement suggestions (requires id)\n' +
      '• confirm_usage — record that knowledge was actually adopted (requires id)',
    inputSchema: zodToMcpSchema(KnowledgeInput),
  },

  // Project Structure
  {
    name: 'alembic_structure',
    tier: 'agent',
    description:
      'Explore project structure.\n' +
      '• targets — list build targets (modules/Targets/Packages)\n' +
      '• files — list files for a specific Target\n' +
      '• metadata — project metadata (language, dependencies, configuration)',
    inputSchema: zodToMcpSchema(StructureInput),
  },

  // Knowledge Graph
  {
    name: 'alembic_graph',
    tier: 'agent',
    description:
      'Knowledge relationship graph queries.\n' +
      '• query — query relationships of a node\n' +
      '• impact — analyze impact scope of modifying a knowledge entry\n' +
      '• path — find relationship path between two knowledge nodes\n' +
      '• stats — global graph statistics (nodes/edges/density)',
    inputSchema: zodToMcpSchema(GraphInput),
  },

  // Call Context
  {
    name: 'alembic_call_context',
    tier: 'agent',
    description:
      'Query function/method call chains.\n' +
      '• callers — who calls it (upstream call chain)\n' +
      '• callees — what it calls (downstream dependency chain)\n' +
      '• impact — modification impact radius (upstream + downstream + affected file count)\n' +
      '• both — retrieve callers + callees simultaneously',
    inputSchema: zodToMcpSchema(CallContextInput),
  },

  // Guard Code Check
  {
    name: 'alembic_guard',
    tier: 'agent',
    description:
      'Legacy Guard route for compatibility and report operations.\n' +
      '• files → check specified file list; prefer alembic_code_guard for agent-facing scoped checks\n' +
      '• no params → blocked; whole-diff fallback is disabled to avoid silently consuming unrelated repository changes\n' +
      '• code → inline check code snippet; prefer alembic_code_guard for new host-agent calls\n' +
      '• operation: "coverage_matrix" → module-level Guard rule coverage matrix\n' +
      'Each violation includes a fix guide (doClause + coreCode). Fix accordingly and re-check.',
    inputSchema: zodToMcpSchema(GuardInput),
  },

  // Submit Knowledge (Unified Pipeline)
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
      '• Optional unitId / analysisUnitIds / sourceRefs link submissions to Core IDEAgentAnalysisUnit progress; omit them for legacy flows.\n' +
      '• Evidence refs may cite root-level files such as package.json:1; rule/pattern candidates normally need 3 distinct files, or scope: "narrow" / "file-local" for a legitimate local rule.\n' +
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
      'Cold-start — DESTRUCTIVE on an existing knowledge base: all current knowledge is archived to .asd/.trash/<timestamp>/ and rebuilt from zero, so when a usable knowledge base exists this tool refuses unless called with rebuild:true (prefer alembic_rescan to refresh while preserving Recipes). On a fresh project no parameters are needed. Auto-analyzes the project (AST, dependency graph, Guard audit) and returns a Mission Briefing:\n' +
      '• Project metadata and language statistics\n' +
      '• Dimension task list (8 dimensions × 3 Tiers)\n' +
      '• ideAgentAnalysis packet summary, next units, retrieval hints, and unit progress seed\n' +
      '• Execution plan and submission examples\n' +
      'After receiving the Briefing, complete all dimension analyses per the executionPlan.',
    inputSchema: zodToMcpSchema(BootstrapInput),
  },

  // Incremental Rescan
  {
    name: 'alembic_rescan',
    tier: 'agent',
    description:
      'Incremental rescan — preserves existing Recipes and re-analyzes project.\n' +
      '• Snapshots approved Recipes → cleans derived caches → full Phase 1-4 analysis\n' +
      '• Runs relevance audit (evidence check, auto-decay stale Recipes)\n' +
      '\u2022 Returns Mission Briefing with allRecipes (full content + auditHint per recipe)\n' +
      '\u2022 Includes ideAgentAnalysis packet summary, next units, retrieval hints, and unit progress seed\n' +
      '\u2022 Per-dimension workflow: evolve (alembic_evolve) \u2192 gap-fill (submit_knowledge) \u2192 dimension_complete\n' +
      '\u2022 Optional: dimensions (filter specific dimensions), reason (rescan justification)',
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

  // Project Panorama
  {
    name: 'alembic_panorama',
    tier: 'agent',
    description:
      'Project panorama queries. Auto-triggers structure scan when no data exists — no manual cold-start needed.\n' +
      '• overview (default) — project skeleton + architecture layers + module roles + knowledge coverage\n' +
      '• module — single module details + neighbor relationships (requires module param)\n' +
      '• gaps — knowledge gaps (modules with code but no Recipes)\n' +
      '• health — panorama health score (coverage + coupling + circular deps + health score)\n' +
      '• governance_cycle — full knowledge metabolism cycle (contradiction detection + redundancy analysis + decay assessment)\n' +
      '• decay_report — decay assessment report (5 strategy detection + decayScore)\n' +
      '• staging_check — staging entry check + auto-publish on expiry\n' +
      '• enhancement_suggestions — Recipe enhancement suggestions based on usage data',
    inputSchema: zodToMcpSchema(PanoramaInput),
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
