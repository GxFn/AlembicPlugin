import { getServiceContainer } from '#inject/ServiceContainer.js';
import {
  FileChangeHandler,
  type UnifiedEvolutionReport,
} from '#recipe-generation/evolution/FileChangeHandler.js';
import {
  GitDiffScanner,
  type GitDiffScanResult,
} from '#recipe-generation/evolution/git-diff-checkpoint/GitDiffScanner.js';
import {
  buildPluginOpportunisticEvolutionSurface,
  extractPluginToolOutcome,
  extractTaskCloseGuardDecision,
  shouldAttachPluginOpportunisticEvolution,
} from '#recipe-generation/evolution/PluginOpportunisticEvolution.js';
import type { ToolExecutionContext } from '../../../runtime/mcp/host/embedded-executor.js';

interface PluginUnifiedEvolutionCheckpoint {
  head: string | null;
  signature: string | null;
}

let pluginUnifiedEvolutionCheckpoints: Map<string, PluginUnifiedEvolutionCheckpoint> | null = null;

export async function attachPluginOpportunisticEvolutionSurface(input: {
  args: Record<string, unknown>;
  executionContext: ToolExecutionContext;
  projectRoot: string;
  result: unknown;
  toolName: string;
}): Promise<unknown> {
  if (!shouldAttachPluginOpportunisticEvolution({ args: input.args, toolName: input.toolName })) {
    return input.result;
  }
  if (hasEmbeddedUnifiedEvolutionSurface(input.result)) {
    return input.result;
  }
  const toolOutcome = extractPluginToolOutcome(input.toolName, input.result);
  if (!toolOutcome) {
    return input.result;
  }
  const checkpointKey = pluginEvolutionCheckpointKey(input.projectRoot, input.executionContext);
  const checkpoints = getPluginUnifiedEvolutionCheckpoints();
  const checkpoint = checkpoints.get(checkpointKey) ?? {
    head: null,
    signature: null,
  };
  const scanner = new GitDiffScanner({ projectRoot: input.projectRoot });
  const scan = await scanner.scanOnce(Date.now(), { previousHead: checkpoint.head });
  let unifiedEvolution: UnifiedEvolutionReport | null = null;
  let routeError: string | null = null;
  const shouldDeferToResident =
    input.executionContext.residentProjectScopeAvailable && !scan.headChanged;

  if (!shouldDeferToResident && shouldRouteUnifiedEvolution(scan)) {
    const handler = createUnifiedEvolutionHandler(input.projectRoot);
    if (handler) {
      try {
        unifiedEvolution = await handler.handleFileChanges(scan.events);
      } catch (error: unknown) {
        routeError = error instanceof Error ? error.message : String(error);
      }
    } else {
      routeError = 'Core unified evolution services are unavailable in the plugin container';
    }
  }

  if (scan.scanned) {
    checkpoints.set(checkpointKey, {
      head: scan.head,
      signature: scan.signature,
    });
  }

  const serviceGateReason = input.executionContext.residentProjectScopeAvailable
    ? 'Alembic resident ProjectScope is ready for this source folder.'
    : 'Alembic resident ProjectScope is unavailable, disabled, or unable to accept this source folder; Plugin fallback may inspect one-shot git diff evidence.';
  const surface = await buildPluginOpportunisticEvolutionSurface({
    guardDecision: extractTaskCloseGuardDecision(input.result),
    projectRoot: input.projectRoot,
    scan,
    serviceGate: {
      mainServiceCanHandleProjectScope: input.executionContext.residentProjectScopeAvailable,
      residentProjectScopeAvailable: input.executionContext.residentProjectScopeAvailable,
      reason: routeError
        ? `${serviceGateReason} Plugin unified evolution routing did not complete: ${routeError}.`
        : serviceGateReason,
    },
    toolOutcome,
    unifiedEvolution,
  });
  return attachNestedData(input.result, { unifiedEvolution: surface });
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

function hasEmbeddedUnifiedEvolutionSurface(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (isRecord(record.unifiedEvolution)) {
    return true;
  }
  return isRecord(record.data) && isRecord(record.data.unifiedEvolution);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function resetPluginUnifiedEvolutionCheckpointsForTests(): void {
  pluginUnifiedEvolutionCheckpoints?.clear();
  pluginUnifiedEvolutionCheckpoints = null;
}

function getPluginUnifiedEvolutionCheckpoints(): Map<string, PluginUnifiedEvolutionCheckpoint> {
  if (pluginUnifiedEvolutionCheckpoints === null) {
    pluginUnifiedEvolutionCheckpoints = new Map();
  }
  return pluginUnifiedEvolutionCheckpoints;
}

function shouldRouteUnifiedEvolution(scan: GitDiffScanResult): boolean {
  if (!scan.scanned || scan.events.length === 0 || scan.truncated) {
    return false;
  }
  if (scan.headChanged && scan.headRangeStatus !== 'ancestor') {
    return false;
  }
  return true;
}

function createUnifiedEvolutionHandler(projectRoot: string): FileChangeHandler | null {
  let container: ReturnType<typeof getServiceContainer>;
  try {
    container = getServiceContainer();
  } catch {
    return null;
  }
  const sourceRefRepository = safeContainerGet(container, 'recipeSourceRefRepository');
  const knowledgeRepository = safeContainerGet(container, 'knowledgeRepository');
  if (
    !hasFunctions(sourceRefRepository, ['findByRecipeId', 'findBySourcePath', 'replaceSourcePath'])
  ) {
    return null;
  }
  if (!hasFunctions(knowledgeRepository, ['findById'])) {
    return null;
  }
  const contentPatcher = safeContainerGet(container, 'contentPatcher');
  const evolutionGateway = safeContainerGet(container, 'evolutionGateway');
  const recipeFreshnessService = safeContainerGet(container, 'recipeFreshnessService');
  const signalBus = safeContainerGet(container, 'signalBus');
  return new FileChangeHandler(
    sourceRefRepository as never,
    knowledgeRepository as never,
    contentPatcher,
    {
      evolutionGateway: hasFunctions(evolutionGateway, ['submit'])
        ? (evolutionGateway as never)
        : null,
      projectRoot,
      recipeFreshnessService: hasFunctions(recipeFreshnessService, ['refreshRecipes'])
        ? (recipeFreshnessService as never)
        : null,
      signalBus: hasFunctions(signalBus, ['send']) ? (signalBus as never) : null,
    }
  );
}

function safeContainerGet(
  container: ReturnType<typeof getServiceContainer>,
  serviceName: string
): unknown {
  try {
    return container.get(serviceName);
  } catch {
    return null;
  }
}

function hasFunctions(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

function pluginEvolutionCheckpointKey(
  projectRoot: string,
  executionContext: ToolExecutionContext
): string {
  return [
    projectRoot,
    executionContext.projectScopeIdentity?.projectScopeId ?? 'single-folder',
    executionContext.projectScopeIdentity?.currentFolderId ?? '',
  ].join('\0');
}
