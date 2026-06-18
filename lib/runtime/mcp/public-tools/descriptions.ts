import { z } from 'zod';

import { AgentPublicToolNameSchema } from '../../../runtime/mcp/public-tools/contract.js';

export const AgentPublicToolDescriptionBaseSchema = z.object({
  name: AgentPublicToolNameSchema,
  title: z.string().min(1).max(120),
  purpose: z.string().min(1).max(500),
  selectionHint: z.string().min(1).max(500),
  nonGoal: z.string().min(1).max(500),
});

export type AgentPublicToolDescriptionBase = z.infer<typeof AgentPublicToolDescriptionBaseSchema>;

export const AGENT_PUBLIC_TOOL_DESCRIPTION_BASE = {
  alembic_prime: {
    name: 'alembic_prime',
    title: 'Prime code-development Recipe context',
    purpose:
      'Load compact, trust-labeled Recipe guidance for a standalone code-development requirement frame and return primeRef plus detailRefs.',
    selectionHint:
      'Use before implementation, fixes, refactors, tests, or code-review edits when the host can provide taskAction, requirementGoal, and locator facets.',
    nonGoal:
      'Does not answer general knowledge lookup, provide project maps, create work sessions, modify code, mark work complete, or run guard checks.',
  },
  alembic_work_start: {
    name: 'alembic_work_start',
    title: 'Start tracked work',
    purpose:
      'Create a workRef that anchors an implementation, fix, refactor, review, or other multi-step evidence-producing task.',
    selectionHint:
      'Use when the user has asked for concrete work that should later be finished with evidence and optional guard guidance.',
    nonGoal:
      'Does not load project knowledge by itself, finish work, run guard checks, or record durable decisions.',
  },
  alembic_work_finish: {
    name: 'alembic_work_finish',
    title: 'Finish tracked work',
    purpose:
      'Close a workRef with changed files, outcome summary, detailRefs, and guard recommendation metadata.',
    selectionHint:
      'Use after scoped work is complete and the host agent needs a compact result envelope for evidence and next checks.',
    nonGoal:
      'Does not perform the code check itself, create new work, or silently widen the changed-file scope.',
  },
  alembic_code_guard: {
    name: 'alembic_code_guard',
    title: 'Check code against project rules',
    purpose:
      'Run a code guard pass over explicit files, inline code, or scoped files from a current workRef and return guard result references.',
    selectionHint:
      'Use when files, inline code, or a current workRef with scoped files is explicit and project rules should be checked before finalizing work.',
    nonGoal:
      'Does not accept diffRef/primeRef/acceptedGuards/applicableRecipe as public guard scope, infer unbounded repository scope, run no-args whole-diff review, create work sessions, or record user preferences.',
  },
} as const satisfies Record<string, AgentPublicToolDescriptionBase>;

export function getAgentPublicToolDescriptionBase(
  name: z.infer<typeof AgentPublicToolNameSchema>
): AgentPublicToolDescriptionBase {
  return AgentPublicToolDescriptionBaseSchema.parse(AGENT_PUBLIC_TOOL_DESCRIPTION_BASE[name]);
}
