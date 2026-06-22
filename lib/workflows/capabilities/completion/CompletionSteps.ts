/**
 * CompletionSteps — Workflow 完成阶段的各步骤实现
 *
 * 包含 ProjectContext 刷新占位和语义记忆固化，
 * 由 WorkflowCompletionFinalizer 按顺序调用。
 */

import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  CompletionSessionStoreLike,
  LoadServiceContainer,
  PersistentMemoryDb,
  WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

// ── ProjectContextCompletionStep ──

export async function refreshProjectContextReads({
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  log: CompletionLogger;
}): Promise<void> {
  log.info(
    '[DimensionComplete] ProjectContext refresh skipped: retired project refresh provider has no work; ProjectContext reads are live.'
  );
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
  try {
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
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Semantic Memory consolidation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
