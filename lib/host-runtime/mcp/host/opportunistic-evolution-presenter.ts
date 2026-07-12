import { runCommitDrivenMaintenance } from '#recipe-pipeline/sustain/git-diff-checkpoint/CommitDrivenMaintenance.js';
import { HostAgentFileChangeHandler } from '#recipe-pipeline/sustain/HostAgentFileChangeHandler.js';
import {
  buildPluginOpportunisticEvolutionSurface,
  extractPluginToolOutcome,
  extractTaskCloseGuardDecision,
  shouldAttachPluginOpportunisticEvolution,
} from '#recipe-pipeline/sustain/PluginOpportunisticEvolution.js';
import { createRequestScopedGuardMaintenanceResources } from '../../../repository/guard/RequestScopedGuardMaintenance.js';
import {
  attachCodeGuardAuxiliaryFailure,
  auxiliaryErrorMessage,
} from './code-guard-auxiliary-failure.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { resolveCodeGuardPhysicalDatabaseIdentity } from './read-only-code-guard-executor.js';

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
  const projectRuntime = input.executionContext.projectRuntime;
  if (!projectRuntime) {
    return attachMaintenanceFailure(
      input.result,
      input.toolName,
      'Request-scoped ProjectRuntimeContext is unavailable for commit maintenance.'
    );
  }
  const identity = projectRuntime.identity;
  let resources: ReturnType<typeof createRequestScopedGuardMaintenanceResources> | null = null;
  let maintenance: Awaited<ReturnType<typeof runCommitDrivenMaintenance>>;
  try {
    const physicalIdentity = resolveCodeGuardPhysicalDatabaseIdentity(
      requireMaintenanceIdentityPath(identity.databasePath, 'databasePath'),
      requireMaintenanceIdentityPath(identity.dataRoot, 'dataRoot')
    );
    const projectScopeIdentity = input.executionContext.projectScopeIdentity;
    const maintenanceProjectRoot =
      projectScopeIdentity?.projectScopeId && projectScopeIdentity.controlRoot
        ? projectScopeIdentity.controlRoot
        : input.projectRoot;
    resources = createRequestScopedGuardMaintenanceResources({
      databasePath: physicalIdentity.databasePath,
      projectRoot: maintenanceProjectRoot,
    });
    const requestContainer = resources.container;
    // UM#2：单一 commit-driven 维护编排（与 rescan 入口共享）。presenter 的仓储、
    // handler 与 checkpoint 必须全部来自同一个请求级物理数据库。
    maintenance = await runCommitDrivenMaintenance({
      buildHandler: (projectRoot) => createUnifiedEvolutionHandler(requestContainer, projectRoot),
      container: requestContainer,
      handlerUnavailableReason:
        'Core unified evolution services are unavailable in the request-scoped Guard container',
      projectRoot: maintenanceProjectRoot,
      residentSearchEnhancementReady: input.executionContext.residentProjectScopeAvailable,
      runtimeScope: {
        currentFolderId: input.executionContext.projectScopeIdentity?.currentFolderId ?? null,
        projectScopeId: input.executionContext.projectScopeIdentity?.projectScopeId ?? null,
        // 空间根修（2026-07-06）：漂移扫描切到当前 folder 自己的 git 仓——Alembic
        // 空间只关注 ProjectScope 注册的子仓库，workspace 根（Wakeflow 协作区仓）不是知识源。
        currentFolderPath: input.executionContext.projectScopeIdentity?.currentFolderPath ?? null,
      },
    });
  } catch (error: unknown) {
    return attachMaintenanceFailure(input.result, input.toolName, auxiliaryErrorMessage(error));
  } finally {
    resources?.close();
  }
  const { checkpoint, report: unifiedEvolution, routeError, scan } = maintenance;

  const serviceGateReason = input.executionContext.residentProjectScopeAvailable
    ? 'Alembic resident ProjectScope is ready for this source folder.'
    : 'Alembic resident ProjectScope is unavailable, disabled, or unable to accept this source folder; Plugin fallback may inspect one-shot git diff evidence.';
  const surface = await buildPluginOpportunisticEvolutionSurface({
    guardDecision: extractTaskCloseGuardDecision(input.result),
    projectRoot: input.projectRoot,
    scan,
    serviceGate: {
      reason: routeError
        ? `${serviceGateReason} Plugin unified evolution routing did not complete: ${routeError}.`
        : serviceGateReason,
      residentProjectScopeAvailable: input.executionContext.residentProjectScopeAvailable,
      // UM#3：resident 检索增强就绪位（改名自旧服务门字段）；仅驱动 surface 去抖，非维护对端。
      residentSearchEnhancementReady: input.executionContext.residentProjectScopeAvailable,
    },
    toolOutcome,
    checkpoint,
    unifiedEvolution,
  });
  const result = attachNestedData(input.result, { unifiedEvolution: surface });
  return routeError ? attachMaintenanceFailure(result, input.toolName, routeError) : result;
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

function createUnifiedEvolutionHandler(
  container: { get(name: string): unknown },
  projectRoot: string
): HostAgentFileChangeHandler | null {
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
  const proposalGateway = safeContainerGet(container, 'proposalGateway');
  const recipeFreshnessService = safeContainerGet(container, 'recipeFreshnessService');
  const signalBus = safeContainerGet(container, 'signalBus');
  return new HostAgentFileChangeHandler(
    sourceRefRepository as never,
    knowledgeRepository as never,
    contentPatcher,
    {
      proposalGateway: hasFunctions(proposalGateway, ['submit'])
        ? (proposalGateway as never)
        : null,
      projectRoot,
      recipeFreshnessService: hasFunctions(recipeFreshnessService, ['refreshRecipes'])
        ? (recipeFreshnessService as never)
        : null,
      signalBus: hasFunctions(signalBus, ['send']) ? (signalBus as never) : null,
    }
  );
}

function safeContainerGet(container: { get(name: string): unknown }, serviceName: string): unknown {
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

function attachMaintenanceFailure(result: unknown, toolName: string, message: string): unknown {
  if (toolName !== 'alembic_code_guard') {
    return result;
  }
  return attachCodeGuardAuxiliaryFailure({
    diagnosticCode: 'guard-maintenance-failed',
    message,
    result,
  });
}

function requireMaintenanceIdentityPath(value: string | null, field: string): string {
  if (!value?.trim()) {
    throw new Error(`Request-scoped ProjectRuntimeContext is missing ${field}.`);
  }
  return value;
}
