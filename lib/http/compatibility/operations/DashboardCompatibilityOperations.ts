import Logger from '@alembic/core/logging';
import type { ServiceContainer } from '../../../injection/ServiceContainer.js';

export type DashboardCompatibilityOperationHandler = (
  request: DashboardCompatibilityOperationRequest
) => Promise<unknown>;

export interface DashboardCompatibilityOperationRequest {
  args: Record<string, unknown>;
  context: {
    actor?: { role?: string; sessionId?: string; user?: string };
    services: ServiceContainer;
    surface?: string;
  };
}

export interface DashboardCompatibilityOperationManifest {
  description: string;
  id: string;
  policyProfile: 'analysis' | 'system' | 'write';
  timeoutMs: number;
  title: string;
}

const logger = Logger.getInstance();

// 这里的 dashboard.* 是历史 HTTP 兼容 operation id，不表示插件重新打包 Dashboard 前端。
export const DASHBOARD_COMPATIBILITY_OPERATION_IDS = {
  updateModuleMap: 'dashboard.update_module_map',
  rebuildSemanticIndex: 'dashboard.rebuild_semantic_index',
  scanProject: 'dashboard.scan_project',
  bootstrapProject: 'dashboard.bootstrap_project',
  cancelBootstrap: 'dashboard.cancel_bootstrap',
  rescanProject: 'dashboard.rescan_project',
} as const;

export const DASHBOARD_COMPATIBILITY_OPERATION_MANIFESTS: DashboardCompatibilityOperationManifest[] = [
  manifest({
    id: DASHBOARD_COMPATIBILITY_OPERATION_IDS.updateModuleMap,
    title: 'Update Module Map',
    description: 'Refresh the project module map from Dashboard.',
    policyProfile: 'write',
  }),
  manifest({
    id: DASHBOARD_COMPATIBILITY_OPERATION_IDS.rebuildSemanticIndex,
    title: 'Rebuild Semantic Index',
    description: 'Rebuild the semantic vector index from Dashboard.',
    policyProfile: 'system',
    timeoutMs: 300_000,
  }),
  manifest({
    id: DASHBOARD_COMPATIBILITY_OPERATION_IDS.scanProject,
    title: 'Scan Project',
    description: 'Run a full project scan from Dashboard.',
    policyProfile: 'analysis',
    timeoutMs: 300_000,
  }),
  manifest({
    id: DASHBOARD_COMPATIBILITY_OPERATION_IDS.bootstrapProject,
    title: 'Bootstrap Project Knowledge',
    description: 'Start host-driven project bootstrap from Dashboard.',
    policyProfile: 'write',
    timeoutMs: 300_000,
  }),
  manifest({
    id: DASHBOARD_COMPATIBILITY_OPERATION_IDS.cancelBootstrap,
    title: 'Cancel Bootstrap Session',
    description: 'Cancel the active bootstrap or rescan background session from Dashboard.',
    policyProfile: 'write',
  }),
  manifest({
    id: DASHBOARD_COMPATIBILITY_OPERATION_IDS.rescanProject,
    title: 'Rescan Project Knowledge',
    description: 'Run host-driven project rescan from Dashboard.',
    policyProfile: 'write',
    timeoutMs: 300_000,
  }),
];

export const DASHBOARD_COMPATIBILITY_OPERATION_HANDLERS: Record<
  string,
  DashboardCompatibilityOperationHandler
> = {
  [DASHBOARD_COMPATIBILITY_OPERATION_IDS.updateModuleMap]: updateModuleMap,
  [DASHBOARD_COMPATIBILITY_OPERATION_IDS.rebuildSemanticIndex]: rebuildSemanticIndex,
  [DASHBOARD_COMPATIBILITY_OPERATION_IDS.scanProject]: scanProject,
  [DASHBOARD_COMPATIBILITY_OPERATION_IDS.bootstrapProject]: bootstrapProject,
  [DASHBOARD_COMPATIBILITY_OPERATION_IDS.cancelBootstrap]: cancelBootstrap,
  [DASHBOARD_COMPATIBILITY_OPERATION_IDS.rescanProject]: rescanProject,
};

function manifest(input: {
  description: string;
  id: string;
  policyProfile: DashboardCompatibilityOperationManifest['policyProfile'];
  timeoutMs?: number;
  title: string;
}): DashboardCompatibilityOperationManifest {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    policyProfile: input.policyProfile,
    timeoutMs: input.timeoutMs || 60_000,
  };
}

async function updateModuleMap(request: DashboardCompatibilityOperationRequest) {
  const container = getContainer(request);
  const moduleService = container.get('moduleService') as {
    updateModuleMap(options: Record<string, unknown>): Promise<unknown>;
  };
  const result = await moduleService.updateModuleMap({
    aggressive: request.args.aggressive ?? true,
  });
  logger.info('Module map updated via dashboard operation', { result });
  return result;
}

async function rebuildSemanticIndex(request: DashboardCompatibilityOperationRequest) {
  const container = getContainer(request);
  const clear = request.args.clear !== false;
  const force = Boolean(request.args.force ?? false);
  // Plugin 内不再注入第三方 embedding provider。这里仍允许本地索引流程跑完：
  // 有 Alembic resident/vector 能力时由对应服务增强，否则 Core 会按 baseline/skip 语义返回统计。
  const vectorService = container.services.vectorService
    ? (container.get('vectorService') as unknown as {
        clear(): Promise<void>;
        fullBuild(options: Record<string, unknown>): Promise<BuildResultLike>;
      })
    : null;

  let result: Record<string, unknown>;
  if (vectorService) {
    if (clear) {
      await vectorService.clear();
    }
    const buildResult = await vectorService.fullBuild({ force });
    result = {
      scanned: buildResult.scanned,
      chunked: buildResult.chunked,
      embedded: buildResult.embedded,
      upserted: buildResult.upserted,
      skipped: buildResult.skipped,
      errors: buildResult.errors,
    };
  } else {
    const indexingPipeline = container.get('indexingPipeline') as {
      run(options: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    result = await indexingPipeline.run({ clear, force });
  }

  logger.info('Semantic index rebuilt via dashboard operation', { result });
  return {
    scanned: result.scanned || 0,
    chunked: result.chunked || 0,
    embedded: result.embedded || 0,
    upserted: result.upserted || 0,
    skipped: result.skipped || 0,
    errors: result.errors || 0,
  };
}

async function scanProject(request: DashboardCompatibilityOperationRequest) {
  const container = getContainer(request);
  const moduleService = container.get('moduleService') as {
    load(): Promise<void>;
    scanProject(options: Record<string, unknown>): Promise<unknown>;
  };
  await moduleService.load();
  logger.info('Full project scan started via dashboard operation');
  return moduleService.scanProject(
    (request.args.options as Record<string, unknown> | undefined) || {}
  );
}

async function bootstrapProject(request: DashboardCompatibilityOperationRequest) {
  const container = getContainer(request);
  const { createDaemonJob, runDaemonJob } = await import('../../../daemon/DaemonJobRunner.js');
  const args = {
    maxFiles: numberArg(request.args.maxFiles, 500),
    skipGuard: Boolean(request.args.skipGuard || false),
    contentMaxLines: numberArg(request.args.contentMaxLines, 120),
  };
  const job = createDaemonJob({ args, container, kind: 'bootstrap', logger, source: 'dashboard' });
  const result = await runDaemonJob({
    args,
    container,
    jobId: job.id,
    kind: 'bootstrap',
    logger,
    source: 'dashboard',
  });
  return { ...asRecord(result.result), job: result.job, jobId: job.id };
}

async function cancelBootstrap(request: DashboardCompatibilityOperationRequest) {
  const container = getContainer(request);
  const taskManager = getOptionalService<{
    isRunning: boolean;
    abortSession(reason: string): void;
    markCancelled(): void;
    getSessionStatus(): Record<string, unknown>;
  }>(container, 'bootstrapTaskManager');

  if (!taskManager) {
    return { message: 'No bootstrap task manager initialized' };
  }

  const reason = (request.args.reason as string | undefined) || 'Cancelled by user via Dashboard';
  if (taskManager.isRunning) {
    taskManager.abortSession(reason);
  } else {
    taskManager.markCancelled();
  }
  logger.info('Bootstrap session cancelled via dashboard operation', { reason });
  return taskManager.getSessionStatus();
}

async function rescanProject(request: DashboardCompatibilityOperationRequest) {
  const container = getContainer(request);
  const { createDaemonJob, runDaemonJob } = await import('../../../daemon/DaemonJobRunner.js');
  const args = {
    reason: (request.args.reason as string | undefined) || 'dashboard-rescan',
    dimensions: Array.isArray(request.args.dimensions)
      ? request.args.dimensions.filter(
          (dimension): dimension is string => typeof dimension === 'string'
        )
      : undefined,
  };
  logger.info('Rescan initiated via dashboard operation', {
    reason: args.reason,
    dimensions: args.dimensions,
  });
  const job = createDaemonJob({ args, container, kind: 'rescan', logger, source: 'dashboard' });
  const result = await runDaemonJob({
    args,
    container,
    jobId: job.id,
    kind: 'rescan',
    logger,
    source: 'dashboard',
  });
  return { ...asRecord(result.result), job: result.job, jobId: job.id };
}

function getContainer(request: DashboardCompatibilityOperationRequest) {
  return request.context.services;
}

function getOptionalService<T>(container: ServiceContainer, name: string): T | null {
  try {
    return container.get(name) as T;
  } catch {
    return null;
  }
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}

function numberArg(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

interface BuildResultLike {
  chunked?: number;
  embedded?: number;
  errors?: unknown;
  scanned?: number;
  skipped?: number;
  upserted?: number;
}
