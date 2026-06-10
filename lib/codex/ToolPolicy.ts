import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { CodexKnowledgeState } from './KnowledgeState.js';
import {
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  resolveEffectiveCodexTier,
} from './runtime/RuntimeContext.js';

export interface CodexToolDefinition {
  annotations?: ToolAnnotations;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  tier?: string;
}

export interface CodexToolPolicyInput<T extends CodexToolDefinition = CodexToolDefinition> {
  adminEnabled?: boolean;
  channelId?: string;
  coreTools: T[];
  daemon?: {
    message?: string;
    ready?: boolean;
    status?: string;
  };
  knowledge: CodexKnowledgeState;
  residentProjectScopeAvailable?: boolean;
  tierName?: string;
  tierOrder: Record<string, number>;
}

export type CodexToolPolicyState =
  | 'bootstrap_running'
  | 'daemon_stale'
  | 'needs_bootstrap'
  | 'needs_init'
  | 'ready'
  | 'ready_refreshing'
  | 'ready_stale';

export interface CodexToolPolicySignal {
  code: string;
  message: string;
  severity: 'info' | 'warning';
}

export interface CodexToolPolicyResult<T extends CodexToolDefinition = CodexToolDefinition> {
  allowedLocalToolNames: Set<string>;
  effectiveTier: string;
  hiddenReason: string | null;
  signals: CodexToolPolicySignal[];
  state: CodexToolPolicyState;
  visibleTools: Array<T | CodexToolDefinition>;
}

// Codex 插件当前只有 alembic-codex 一个入口；这里维护单插件工具策略，不做多插件抽象。
export const CODEX_PROJECT_ROOT_PROPERTY = {
  type: 'string',
  description:
    'Absolute target project root. Pass the current workspace directory when Alembic cannot determine the project.',
};

function codexInputSchema(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      projectRoot: CODEX_PROJECT_ROOT_PROPERTY,
      ...properties,
    },
    additionalProperties: false,
  };
}

export const CODEX_DISCOVERY_TOOL_NAMES = new Set([
  'alembic_codex_status',
  'alembic_codex_diagnostics',
  'alembic_source_graph_status',
]);

export const CODEX_INIT_TOOL_NAMES = new Set([...CODEX_DISCOVERY_TOOL_NAMES, 'alembic_codex_init']);

const CODEX_RETIRED_TOOL_NAMES = new Set(['alembic_task']);

export const CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES = new Set([
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_submit_knowledge',
  'alembic_dimension_complete',
]);

// Agent-facing public tools are Codex host lifecycle surfaces, not ordinary
// Recipe/Search/Guard knowledge-consumption tools. They stay visible even before
// local knowledge exists so the handlers can return structured skipped,
// degraded, or blocked envelopes instead of disappearing behind the knowledge
// gate.
export const CODEX_AGENT_PUBLIC_TOOL_NAMES = new Set([
  'alembic_intent',
  'alembic_prime',
  'alembic_work_start',
  'alembic_work_finish',
  'alembic_code_guard',
  'alembic_decision_record',
]);

// Agent lifecycle tools are the active public route. Legacy alembic_task is no
// longer a visible policy surface; older direct calls are handled separately by
// the hidden compatibility boundary in the MCP executor.
export const CODEX_TASK_LIFECYCLE_TOOL_NAMES = new Set([...CODEX_AGENT_PUBLIC_TOOL_NAMES]);

// Project Skill delivery is a Codex runtime surface, not a Recipe/Guard knowledge
// consumption surface. It must remain available for initialized projects so Codex
// can export or inspect generated Project Skill receipts even while bootstrap is
// still producing the first usable knowledge base.
export const CODEX_PROJECT_SKILL_DELIVERY_TOOL_NAMES = new Set(['alembic_project_skill']);

// ProjectScope resident 已连通但 Project 级知识库仍为空时，Codex 仍需要看见这些
// resident-backed 工具：prime/search 可以返回空结果和 telemetry，而不是被本地
// single-folder knowledge gate 误判为 CODEX_ALEMBIC_KNOWLEDGE_REQUIRED。
export const CODEX_RESIDENT_PROJECT_SCOPE_TOOL_NAMES = new Set([
  'alembic_health',
  ...CODEX_AGENT_PUBLIC_TOOL_NAMES,
  'alembic_search',
]);

export const CODEX_INIT_ON_DEMAND_TOOL_NAMES = new Set([
  'alembic_codex_dashboard',
  'alembic_codex_bootstrap',
  'alembic_codex_rescan',
  'alembic_codex_job',
  ...CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES,
]);

export const CODEX_COLD_START_TOOL_NAMES = new Set([
  ...CODEX_INIT_TOOL_NAMES,
  ...CODEX_INIT_ON_DEMAND_TOOL_NAMES,
  ...CODEX_AGENT_PUBLIC_TOOL_NAMES,
]);

export const CODEX_LOCAL_TOOLS: CodexToolDefinition[] = [
  {
    name: 'alembic_codex_status',
    tier: 'agent',
    description:
      'Check Alembic Codex plugin status without starting the daemon. Reports workspace, Ghost data root, initialization, daemon state, and the recommended next tool call.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_codex_diagnostics',
    tier: 'agent',
    description:
      'Run Alembic Codex runtime diagnostics without starting the daemon. Checks Node, npm, npx, embedded runtime wiring, daemon version, portable runtime artifact guidance, admin mode gate, and first-run next actions.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_source_graph_status',
    tier: 'agent',
    description:
      'Report Alembic source graph boundary status using the Core-owned source graph freshness and diagnostic contract. This status tool stays callable during cold start, unavailable graph runtime, catch-up failure, stale output, or wrong project scope, and it never claims ready source facts unless Core freshness permits it.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_codex_init',
    tier: 'agent',
    description:
      'Initialize Alembic for Codex plugin use. Unregistered projects default to Ghost mode; registered projects inherit their existing Alembic workspace mode.',
    inputSchema: codexInputSchema({
      force: {
        type: 'boolean',
        description: 'Overwrite existing Alembic Codex setup artifacts.',
      },
      seed: { type: 'boolean', description: 'Create seed example Recipes.' },
      standard: {
        type: 'boolean',
        description: 'Write Alembic data into the project instead of the Ghost data root.',
      },
    }),
  },
  {
    name: 'alembic_codex_dashboard',
    tier: 'agent',
    description:
      'Return the local Alembic Dashboard URL only when the selected project already has a local Alembic daemon with Dashboard capability. If unavailable, fail closed with status and diagnostics next actions.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_codex_bootstrap',
    tier: 'agent',
    description:
      'Explicit resident bootstrap job path. A local Alembic daemon owns provider-backed job execution when available; embedded Plugin runtime only recovers Codex host-agent workflow state.',
    inputSchema: codexInputSchema({
      maxFiles: { type: 'number', description: 'Maximum files to include in project analysis.' },
      skipGuard: { type: 'boolean', description: 'Skip Guard audit during bootstrap analysis.' },
      contentMaxLines: {
        type: 'number',
        description: 'Maximum lines of content sampled per file.',
      },
    }),
  },
  {
    name: 'alembic_codex_rescan',
    tier: 'agent',
    description:
      'Explicit resident rescan job path. A local Alembic daemon owns provider-backed job execution when available; embedded Plugin runtime only recovers Codex host-agent workflow state.',
    inputSchema: codexInputSchema({
      reason: { type: 'string', description: 'Short reason for the rescan.' },
      dimensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional dimension ids to rescan.',
      },
    }),
  },
  {
    name: 'alembic_codex_job',
    tier: 'agent',
    description:
      'Read recoverable resident or embedded host-agent job status without starting a new job. If the workspace is not initialized yet, this first performs safe Ghost initialization. Pass jobId for one job, or omit it to list recent jobs.',
    inputSchema: codexInputSchema({
      jobId: {
        type: 'string',
        description: 'Job id returned by alembic_codex_bootstrap or alembic_codex_rescan.',
      },
      kind: { type: 'string', enum: ['bootstrap', 'rescan'] },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
      },
      limit: { type: 'number', description: 'Maximum jobs to return when listing.' },
    }),
  },
  {
    name: 'alembic_codex_stop',
    tier: 'agent',
    description: 'Stop the current project Alembic daemon.',
    inputSchema: codexInputSchema({
      waitMs: { type: 'number', description: 'Milliseconds to wait for graceful daemon stop.' },
    }),
  },
  {
    name: 'alembic_codex_cleanup',
    tier: 'agent',
    description:
      'Preview or explicitly clean Alembic Codex runtime files. Plugin uninstall never removes user data automatically; this tool requires confirm=true before deleting runtime state.',
    inputSchema: codexInputSchema({
      confirm: {
        type: 'boolean',
        description: 'When true, stop the daemon and delete runtime state/log/job files.',
      },
    }),
  },
];

export function resolveCodexToolPolicy<T extends CodexToolDefinition>(
  input: CodexToolPolicyInput<T>
): CodexToolPolicyResult<T> {
  const allowedLocalToolNames = allowedCodexToolNames(input.knowledge);
  const tierName = input.tierName || process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER;
  const adminEnabled = input.adminEnabled ?? process.env[CODEX_ADMIN_ENABLE_ENV] === '1';
  const effectiveTier = resolveEffectiveCodexTier(tierName, adminEnabled);
  const maxTier = input.tierOrder[effectiveTier] ?? input.tierOrder[CODEX_DEFAULT_MCP_TIER] ?? 0;
  const localTools = CODEX_LOCAL_TOOLS.filter((tool) => allowedLocalToolNames.has(tool.name));
  const coreTools = input.coreTools.filter(
    (tool) =>
      !CODEX_RETIRED_TOOL_NAMES.has(tool.name) &&
      (input.knowledge.usable ||
        CODEX_AGENT_PUBLIC_TOOL_NAMES.has(tool.name) ||
        (input.residentProjectScopeAvailable === true &&
          CODEX_RESIDENT_PROJECT_SCOPE_TOOL_NAMES.has(tool.name)) ||
        CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES.has(tool.name) ||
        (input.knowledge.initialized && CODEX_TASK_LIFECYCLE_TOOL_NAMES.has(tool.name)) ||
        isCodexProjectSkillDeliveryToolVisible(tool.name, input.knowledge)) &&
      (input.tierOrder[tool.tier || 'agent'] ?? 0) <= maxTier
  );
  const state = resolveCodexToolPolicyState(input);
  return {
    allowedLocalToolNames,
    effectiveTier,
    hiddenReason:
      input.knowledge.usable || input.residentProjectScopeAvailable === true
        ? null
        : 'CODEX_ALEMBIC_KNOWLEDGE_REQUIRED',
    signals: buildCodexToolPolicySignals(input, state),
    state,
    visibleTools: [...localTools, ...coreTools],
  };
}

export function allowedCodexToolNames(knowledge: CodexKnowledgeState): Set<string> {
  if (knowledge.usable) {
    return new Set([
      ...CODEX_LOCAL_TOOLS.map((tool) => tool.name),
      ...CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES,
    ]);
  }
  if (knowledge.initialized) {
    return new Set([
      ...CODEX_COLD_START_TOOL_NAMES,
      ...CODEX_TASK_LIFECYCLE_TOOL_NAMES,
      ...CODEX_PROJECT_SKILL_DELIVERY_TOOL_NAMES,
    ]);
  }
  return new Set([...CODEX_COLD_START_TOOL_NAMES]);
}

export function isCodexProjectSkillDeliveryToolVisible(
  name: string,
  knowledge: CodexKnowledgeState
): boolean {
  return knowledge.initialized && CODEX_PROJECT_SKILL_DELIVERY_TOOL_NAMES.has(name);
}

export function isToolAllowedForCodexKnowledge(
  name: string,
  knowledge: CodexKnowledgeState
): boolean {
  if (knowledge.usable) {
    return true;
  }
  return allowedCodexToolNames(knowledge).has(name);
}

export function resolveCodexToolPolicyState(input: CodexToolPolicyInput): CodexToolPolicyState {
  const knowledge = input.knowledge;
  if (!knowledge.initialized) {
    return 'needs_init';
  }
  if (!knowledge.usable && knowledge.jobs?.bootstrapRunning) {
    return 'bootstrap_running';
  }
  if (!knowledge.usable) {
    return 'needs_bootstrap';
  }
  if (input.daemon?.status === 'stale') {
    return 'daemon_stale';
  }
  if (knowledge.freshness?.stale) {
    return 'ready_stale';
  }
  if (knowledge.jobs?.running) {
    return 'ready_refreshing';
  }
  return 'ready';
}

export function buildCodexToolPolicySignals(
  input: CodexToolPolicyInput,
  state: CodexToolPolicyState
): CodexToolPolicySignal[] {
  const signals: CodexToolPolicySignal[] = [];
  if (state === 'bootstrap_running') {
    signals.push({
      code: 'CODEX_BOOTSTRAP_RUNNING',
      message: 'A bootstrap job is already running; use alembic_codex_job to recover progress.',
      severity: 'info',
    });
  }
  if (state === 'ready_refreshing') {
    signals.push({
      code: 'CODEX_REFRESH_RUNNING',
      message: 'A bootstrap or rescan job is refreshing project knowledge in the background.',
      severity: 'info',
    });
  }
  if (state === 'ready_stale') {
    signals.push({
      code:
        input.knowledge.freshness?.status === 'source_refs_stale'
          ? 'CODEX_SOURCE_REFS_STALE'
          : 'CODEX_KNOWLEDGE_REFRESH_FAILED',
      message:
        input.knowledge.freshness?.reason ||
        'The latest bootstrap or rescan did not complete after the current knowledge was built.',
      severity: 'warning',
    });
  }
  if (state === 'daemon_stale') {
    signals.push({
      code: 'CODEX_DAEMON_STALE',
      message: input.daemon?.message || 'Daemon state exists but is not healthy.',
      severity: 'warning',
    });
  }
  if (input.knowledge.vector?.skipped) {
    signals.push({
      code: 'CODEX_VECTOR_SKIPPED_NON_BLOCKING',
      message:
        input.knowledge.vector.reason ||
        'Semantic vector index is unavailable; Codex tools remain available.',
      severity: 'info',
    });
  }
  return signals;
}
