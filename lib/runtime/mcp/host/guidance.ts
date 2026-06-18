import {
  CODEX_AGENT_PUBLIC_TOOL_NAMES,
  CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES,
  CODEX_PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES,
} from '../../../runtime/ToolPolicy.js';

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
  validationTools: string[];
  visibleToolNames: string[];
}

const KNOWLEDGE_TOOL_NAMES = CODEX_PUBLIC_KNOWLEDGE_NAVIGATION_TOOL_NAMES;

const GUARD_TOOL_NAMES = new Set(['alembic_code_guard']);

const RECOVERY_TOOL_NAMES = new Set([
  'alembic_mcp_init',
  'alembic_mcp_bootstrap_job',
  'alembic_mcp_rescan_job',
  ...CODEX_HOST_AGENT_WORKFLOW_TOOL_NAMES,
]);

const VALIDATION_TOOL_NAMES = new Set(['alembic_code_guard']);

export function buildCodexMcpGuidance(tools: readonly GuidanceToolLike[]): CodexMcpGuidance {
  const visibleToolNames = tools.map((tool) => tool.name);
  const visibleToolNameSet = new Set(visibleToolNames);
  const knowledgeTools = visibleToolNames.filter((name) => KNOWLEDGE_TOOL_NAMES.has(name));
  const guardTools = visibleToolNames.filter((name) => GUARD_TOOL_NAMES.has(name));
  const lifecycleTools = visibleToolNames.filter((name) => CODEX_AGENT_PUBLIC_TOOL_NAMES.has(name));
  const recoveryTools = visibleToolNames.filter((name) => RECOVERY_TOOL_NAMES.has(name));
  const validationTools = visibleToolNames.filter((name) => VALIDATION_TOOL_NAMES.has(name));

  const playbook = [
    buildOnboardingPlaybookLine(visibleToolNameSet),
    buildProjectContextPlaybookLine(knowledgeTools),
    buildKnowledgePlaybookLine(knowledgeTools),
    buildGuardPlaybookLine(guardTools),
    buildLifecyclePlaybookLine(lifecycleTools),
    buildFallbackPlaybookLine(visibleToolNameSet),
  ];
  const limitations = [
    'ProjectContext matrix/graph facts are orientation evidence; raw source reads or repository tests still prove current behavior.',
    'Project knowledge and decisions explain standards and prior choices; they do not prove current source implementation.',
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
    validationTools,
    visibleToolNames,
  };
}

export function buildCodexMcpInitializeInstructions(tools: readonly GuidanceToolLike[]): string {
  return buildCodexMcpGuidance(tools).instructions;
}

function buildProjectContextPlaybookLine(knowledgeTools: string[]): string {
  const hasMatrix = knowledgeTools.includes('alembic_recipe_map');
  const hasGraph = knowledgeTools.includes('alembic_graph');
  if (!hasMatrix && !hasGraph) {
    return 'Project orientation: no ProjectContext matrix/graph tools are visible; use raw file reads/search and validate before relying on project-structure facts.';
  }
  const projectContextTools = knowledgeTools.filter((name) =>
    ['alembic_recipe_map', 'alembic_graph'].includes(name)
  );
  return `Project orientation: use ${formatToolList(
    projectContextTools
  )} for compact ProjectContext navigation, entrypoints, module/file relations, detailRefs, and partial/freshness notes before broad raw exploration.`;
}

function buildKnowledgePlaybookLine(knowledgeTools: string[]): string {
  if (knowledgeTools.length === 0) {
    return 'Project knowledge/context: no public project-context tools are visible; do not infer project standards from structure facts alone.';
  }
  return `Project knowledge/context: use visible tools ${formatToolList(
    knowledgeTools
  )}; use search/prime for standards and prior decisions, recipe_map for navigation, and alembic_graph for ProjectContext-backed structure/source/dependency relations.`;
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
  )} for intent, prime, scoped work, finish, Guard handoff, and durable decisions; ProjectContext orientation does not replace scoped work/evidence refs.`;
}

function buildOnboardingPlaybookLine(visibleToolNameSet: Set<string>): string {
  const statusTool = visibleToolNameSet.has('alembic_status')
    ? '`alembic_status`'
    : 'status output when available';
  const bootstrapTool = visibleToolNameSet.has('alembic_bootstrap')
    ? '`alembic_bootstrap`'
    : 'bootstrap output when available';
  return `Onboarding: read ${statusTool}/${bootstrapTool} fields \`bootstrapState\`, \`toolCapabilities\`, \`domainQueue\`, \`currentDomainSop\`, \`sopPack\`, \`gates\`, and \`repairState\` before choosing the next tool.`;
}

function buildFallbackPlaybookLine(visibleToolNameSet: Set<string>): string {
  const hasGraph = visibleToolNameSet.has('alembic_graph');
  const graphHint = hasGraph
    ? ' Use `alembic_graph` for bounded ProjectContext relation hints, not as acceptance.'
    : '';
  return `Fallback and validation: when ProjectContext is partial, scope is ambiguous, or a relation is missing, fall back to raw file reads/search, name the uncertainty, and run matching repository validation.${graphHint}`;
}

function formatToolList(toolNames: readonly string[]): string {
  return toolNames.map((name) => `\`${name}\``).join(', ');
}
