import {
  CODEX_AGENT_PUBLIC_TOOL_NAMES,
  CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES,
  CODEX_SOURCE_GRAPH_TOOL_NAMES,
} from '../../ToolPolicy.js';

interface GuidanceToolLike {
  description?: string;
  name: string;
}

export interface CodexMcpGuidance {
  guardTools: string[];
  instructions: string;
  knowledgeTools: string[];
  lifecycleTools: string[];
  limitations: string[];
  playbook: string[];
  recoveryTools: string[];
  sourceGraphTools: string[];
  validationTools: string[];
  visibleToolNames: string[];
}

const KNOWLEDGE_TOOL_NAMES = new Set([
  'alembic_prime',
  'alembic_search',
  'alembic_knowledge',
  'alembic_graph',
  'alembic_structure',
]);

const GUARD_TOOL_NAMES = new Set(['alembic_code_guard', 'alembic_guard']);

const RECOVERY_TOOL_NAMES = new Set([
  'alembic_codex_init',
  'alembic_codex_bootstrap',
  'alembic_codex_rescan',
  ...CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES,
]);

const VALIDATION_TOOL_NAMES = new Set([
  'alembic_code_guard',
  'alembic_guard',
  'alembic_code_impact',
  'alembic_affected_tests',
  'alembic_validation_plan',
]);

export function buildCodexMcpGuidance(tools: readonly GuidanceToolLike[]): CodexMcpGuidance {
  const visibleToolNames = tools.map((tool) => tool.name);
  const visibleToolNameSet = new Set(visibleToolNames);
  const sourceGraphTools = visibleToolNames.filter((name) =>
    CODEX_SOURCE_GRAPH_TOOL_NAMES.has(name)
  );
  const sourceGraphQueryTools = sourceGraphTools.filter(
    (name) => name !== 'alembic_source_graph_status'
  );
  const knowledgeTools = visibleToolNames.filter((name) => KNOWLEDGE_TOOL_NAMES.has(name));
  const guardTools = visibleToolNames.filter((name) => GUARD_TOOL_NAMES.has(name));
  const lifecycleTools = visibleToolNames.filter((name) => CODEX_AGENT_PUBLIC_TOOL_NAMES.has(name));
  const recoveryTools = visibleToolNames.filter((name) => RECOVERY_TOOL_NAMES.has(name));
  const validationTools = visibleToolNames.filter((name) => VALIDATION_TOOL_NAMES.has(name));

  const playbook = [
    buildOnboardingPlaybookLine(visibleToolNameSet),
    buildSourceGraphPlaybookLine(sourceGraphTools, sourceGraphQueryTools),
    buildKnowledgePlaybookLine(knowledgeTools),
    buildGuardPlaybookLine(guardTools),
    buildLifecyclePlaybookLine(lifecycleTools),
    buildFallbackPlaybookLine(visibleToolNameSet),
  ];
  const limitations = [
    'Source graph facts can lag the worktree; stale, pending, partial, wrong-scope, or unsupported-language states are not proof of current code behavior.',
    'Recipe and Decision knowledge explain project standards and decisions; they do not prove current source freshness.',
    'Validation is still required after edits: use Guard when visible and run repository tests or targeted host checks that match the change.',
  ];

  return {
    guardTools,
    instructions: [...playbook, ...limitations.map((line) => `Limit: ${line}`)].join('\n'),
    knowledgeTools,
    lifecycleTools,
    limitations,
    playbook,
    recoveryTools,
    sourceGraphTools,
    validationTools,
    visibleToolNames,
  };
}

export function buildCodexMcpInitializeInstructions(tools: readonly GuidanceToolLike[]): string {
  return buildCodexMcpGuidance(tools).instructions;
}

function buildSourceGraphPlaybookLine(
  sourceGraphTools: string[],
  sourceGraphQueryTools: string[]
): string {
  if (sourceGraphTools.length === 0) {
    return 'Current code facts: no Alembic source graph tools are visible; use raw file reads/search and validate before relying on source facts.';
  }
  const statusPrefix = sourceGraphTools.includes('alembic_source_graph_status')
    ? 'call `alembic_source_graph_status` first, then '
    : '';
  const queryToolText =
    sourceGraphQueryTools.length > 0
      ? `use visible source tools ${formatToolList(sourceGraphQueryTools)} before broad raw Read/Grep exploration`
      : 'use raw file reads/search until source query tools are visible';
  return `Current code facts: ${statusPrefix}${queryToolText}; trust source text only when freshness/ready signals permit it.`;
}

function buildKnowledgePlaybookLine(knowledgeTools: string[]): string {
  if (knowledgeTools.length === 0) {
    return 'Project knowledge: no Recipe/knowledge tools are visible; do not infer project standards from source graph facts alone.';
  }
  return `Project knowledge: use visible Recipe/knowledge tools ${formatToolList(
    knowledgeTools
  )} for standards, prior decisions, and reusable patterns.`;
}

function buildGuardPlaybookLine(guardTools: string[]): string {
  if (guardTools.length === 0) {
    return 'Guard: no Guard tool is visible; use repository validation and report the missing Guard surface instead of inventing compliance evidence.';
  }
  return `Guard: use ${formatToolList(guardTools)} after meaningful edits with explicit files, inline code, or scoped work refs.`;
}

function buildLifecyclePlaybookLine(lifecycleTools: string[]): string {
  if (lifecycleTools.length === 0) {
    return 'Lifecycle: no Alembic intent/prime/work/decision lifecycle tools are visible; keep evidence local to the host turn.';
  }
  return `Lifecycle: use ${formatToolList(
    lifecycleTools
  )} for intent, prime, scoped work, finish, Guard handoff, and durable decisions; source graph evidence does not replace these refs.`;
}

function buildOnboardingPlaybookLine(visibleToolNameSet: Set<string>): string {
  const statusTool = visibleToolNameSet.has('alembic_codex_status')
    ? '`alembic_codex_status`'
    : 'status output when available';
  const bootstrapTool = visibleToolNameSet.has('alembic_bootstrap')
    ? '`alembic_bootstrap`'
    : 'bootstrap output when available';
  return `Onboarding: read ${statusTool}/${bootstrapTool} fields \`bootstrapState\`, \`toolCapabilities\`, \`domainQueue\`, \`currentDomainSop\`, \`sopPack\`, \`gates\`, and \`repairState\` before choosing the next tool.`;
}

function buildFallbackPlaybookLine(visibleToolNameSet: Set<string>): string {
  const hasAffectedTests = visibleToolNameSet.has('alembic_affected_tests');
  const hasValidationPlan = visibleToolNameSet.has('alembic_validation_plan');
  const affectedTestsHint = hasAffectedTests
    ? ' Use `alembic_affected_tests` as a hint for likely tests, not as acceptance.'
    : '';
  const validationPlanHint = hasValidationPlan
    ? ' Use `alembic_validation_plan` for advisory mustRun/recommended/manualReview/unknown buckets; never treat it as acceptance.'
    : '';
  return `Fallback and validation: when graph freshness is degraded, scope is ambiguous, or unsupported language/partial parse appears, fall back to raw file reads/search, name the uncertainty, and run matching repository validation.${affectedTestsHint}${validationPlanHint}`;
}

function formatToolList(toolNames: readonly string[]): string {
  return toolNames.map((name) => `\`${name}\``).join(', ');
}
