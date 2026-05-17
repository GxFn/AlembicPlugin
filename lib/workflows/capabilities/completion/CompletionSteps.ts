/**
 * CompletionSteps — Workflow 完成阶段的各步骤实现
 *
 * 包含 Panorama 刷新和语义记忆固化，
 * 由 WorkflowCompletionFinalizer 按顺序调用。
 */

import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  CompletionSessionStoreLike,
  LoadServiceContainer,
  PanoramaServiceLike,
  PersistentMemoryDb,
  WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

// ── PanoramaCompletionStep ──

export async function refreshPanorama({
  getServiceContainer,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const panoramaService = container.services?.panoramaService
      ? (container.get?.('panoramaService') as PanoramaServiceLike | undefined)
      : undefined;
    if (!panoramaService || typeof panoramaService.rescan !== 'function') {
      return;
    }

    await panoramaService.rescan();
    const overview = await panoramaService.getOverview();
    log.info(
      `[DimensionComplete] Panorama refreshed — ${overview.moduleCount} modules, ${overview.gapCount} gaps`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Panorama refresh failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── SemanticMemoryCompletionStep ──

interface SemanticMemoryConsolidatorLike {
  consolidate(
    sessionStore: CompletionSessionStoreLike,
    options: Record<string, unknown>
  ): Promise<unknown> | unknown;
}

export interface SemanticMemoryCompletionDependencies {
  createPersistentMemory?: (
    db: PersistentMemoryDb,
    dataRoot: string,
    log: CompletionLogger
  ) => Promise<unknown> | unknown;
  createConsolidator?: (
    semanticMemory: unknown,
    log: CompletionLogger
  ) => Promise<SemanticMemoryConsolidatorLike> | SemanticMemoryConsolidatorLike;
}

export async function consolidateSemanticMemory({
  ctx,
  session,
  dataRoot,
  log,
  dependencies = {},
}: {
  ctx: CompletionContextLike;
  session: CompletionSessionLike;
  dataRoot: string;
  log: CompletionLogger;
  dependencies?: SemanticMemoryCompletionDependencies;
}): Promise<WorkflowSemanticMemoryConsolidationResult | null> {
  if (!dependencies.createPersistentMemory || !dependencies.createConsolidator) {
    log.info(
      `[DimensionComplete] Semantic Memory consolidation skipped for ${session.id}: local agent memory has been removed from AlembicPlugin.`
    );
    return null;
  }

  const db = ctx.container.get?.('database') ?? ctx.container.get?.('db');
  if (!db || !session.sessionStore) {
    return null;
  }
  const semanticMemory = await dependencies.createPersistentMemory(
    db as PersistentMemoryDb,
    dataRoot,
    log
  );
  const consolidator = await dependencies.createConsolidator(semanticMemory, log);
  const result = await consolidator.consolidate(
    session.sessionStore as CompletionSessionStoreLike,
    {
      bootstrapSession: session.id,
      clearPrevious: true,
    }
  );
  return result && typeof result === 'object'
    ? (result as WorkflowSemanticMemoryConsolidationResult)
    : null;
}
