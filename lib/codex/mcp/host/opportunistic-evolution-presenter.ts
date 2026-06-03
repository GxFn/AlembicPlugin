import {
  buildPluginOpportunisticEvolutionSurface,
  extractTaskCloseGuardDecision,
  extractTaskCloseOutcome,
  shouldAttachPluginOpportunisticEvolution,
} from '#codex/evolution/PluginOpportunisticEvolution.js';
import { GitDiffScanner } from '#service/evolution/git-diff-checkpoint/GitDiffScanner.js';
import type { CodexToolExecutionContext } from './embedded-executor.js';

export async function attachPluginOpportunisticEvolutionSurface(input: {
  args: Record<string, unknown>;
  executionContext: CodexToolExecutionContext;
  projectRoot: string;
  result: unknown;
  toolName: string;
}): Promise<unknown> {
  if (!shouldAttachPluginOpportunisticEvolution({ args: input.args, toolName: input.toolName })) {
    return input.result;
  }
  const toolOutcome = extractTaskCloseOutcome(input.result);
  if (!toolOutcome) {
    return input.result;
  }
  const surface = await buildPluginOpportunisticEvolutionSurface({
    guardDecision: extractTaskCloseGuardDecision(input.result),
    projectRoot: input.projectRoot,
    scanner: new GitDiffScanner({ projectRoot: input.projectRoot }),
    serviceGate: {
      mainServiceCanHandleProjectScope: input.executionContext.residentProjectScopeAvailable,
      residentProjectScopeAvailable: input.executionContext.residentProjectScopeAvailable,
      reason: input.executionContext.residentProjectScopeAvailable
        ? 'Alembic resident ProjectScope is ready for this source folder.'
        : 'Alembic resident ProjectScope is unavailable, disabled, or unable to accept this source folder; Plugin fallback may inspect one-shot git diff evidence.',
    },
    toolOutcome,
  });
  return attachNestedData(input.result, { opportunisticEvolution: surface });
}

function attachNestedData(result: unknown, patch: Record<string, unknown>): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  return {
    ...record,
    data: {
      ...data,
      ...patch,
    },
  };
}
