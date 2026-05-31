import type {
  IDEAgentAnalysisPacket,
  IDEAgentAnalysisUnit,
  IDEAgentAnalysisUnitProgress,
} from '@alembic/core/host-agent-workflows';

export interface IDEAgentAnalysisUnitSurface {
  completionContract: IDEAgentAnalysisUnit['completionContract'];
  degraded: IDEAgentAnalysisUnit['degraded'];
  dimensionId: string;
  moduleName?: string;
  priority: number;
  reason: string;
  requiredReadSet: string[];
  sourceRefs: IDEAgentAnalysisUnit['sourceRefs'];
  targetName?: string;
  unitId: string;
  warnings: string[];
}

export interface IDEAgentAnalysisSurface {
  nextUnits: IDEAgentAnalysisUnitSurface[];
  packetSummary: {
    budget: IDEAgentAnalysisPacket['budget'];
    generatedAt: string;
    packetId: string;
    profile: IDEAgentAnalysisPacket['profile'];
    projectRootHash: string;
    projectSummary: IDEAgentAnalysisPacket['projectSummary'];
    unitCountsByDimension: Record<string, number>;
  };
  progress: {
    checkpointKind: IDEAgentAnalysisPacket['progressSeed']['checkpointKind'];
    packetId: string;
    remainingUnitIds: string[];
    statusCounts: Record<IDEAgentAnalysisUnitProgress['status'], number>;
    totalUnits: number;
    unitProgress: IDEAgentAnalysisUnitProgress[];
  };
  retrieval: {
    requiredReadSet: string[];
    retrievalHints: IDEAgentAnalysisPacket['retrievalHints'];
    sourceRefs: IDEAgentAnalysisPacket['sourceRefs'];
    structuralEvidenceRefs: IDEAgentAnalysisPacket['structuralEvidenceRefs'];
  };
}

export interface BuildIDEAgentAnalysisSurfaceOptions {
  maxNextUnits?: number;
  progressOverrides?: readonly IDEAgentAnalysisUnitProgress[];
}

const DEFAULT_NEXT_UNITS = 5;

export function buildIDEAgentAnalysisSurface(
  packet: IDEAgentAnalysisPacket,
  options: BuildIDEAgentAnalysisSurfaceOptions = {}
): IDEAgentAnalysisSurface {
  const progress = mergeProgress(packet.progressSeed.unitProgress, options.progressOverrides ?? []);
  const remainingUnitIds = progress
    .filter((unit) => unit.status === 'pending' || unit.status === 'claimed')
    .map((unit) => unit.unitId);
  const nextUnitSet = new Set(remainingUnitIds);
  const maxNextUnits = normalizePositiveInt(options.maxNextUnits, DEFAULT_NEXT_UNITS);

  return {
    packetSummary: {
      budget: packet.budget,
      generatedAt: packet.generatedAt,
      packetId: packet.packetId,
      profile: packet.profile,
      projectRootHash: packet.projectRootHash,
      projectSummary: packet.projectSummary,
      unitCountsByDimension: countUnitsByDimension(packet.units),
    },
    nextUnits: packet.units
      .filter((unit) => nextUnitSet.has(unit.unitId))
      .slice(0, maxNextUnits)
      .map(projectUnitSurface),
    retrieval: {
      requiredReadSet: packet.requiredReadSet,
      retrievalHints: packet.retrievalHints,
      sourceRefs: packet.sourceRefs,
      structuralEvidenceRefs: packet.structuralEvidenceRefs,
    },
    progress: {
      checkpointKind: packet.progressSeed.checkpointKind,
      packetId: packet.packetId,
      totalUnits: packet.progressSeed.totalUnits,
      remainingUnitIds,
      statusCounts: countProgressStatuses(progress),
      unitProgress: progress,
    },
  };
}

export function buildIDEAgentAnalysisProgressBackfill(input: {
  analysisUnitIds?: readonly string[];
  deviationReason?: string;
  dimensionId: string;
  rejectedAnalysisUnitIds?: readonly string[];
  remainingAnalysisUnitIds?: readonly string[];
  sessionId?: string;
  skippedAnalysisUnitIds?: readonly string[];
}): {
  checkpointKind: 'ide-agent-analysis-unit-progress';
  completedUnitIds: string[];
  deviationReason?: string;
  rejectedUnitIds: string[];
  remainingUnitIds: string[];
  skippedUnitIds: string[];
  unitProgress: IDEAgentAnalysisUnitProgress[];
} {
  const completedUnitIds = uniqueStrings(input.analysisUnitIds);
  const skippedUnitIds = uniqueStrings(input.skippedAnalysisUnitIds);
  const rejectedUnitIds = uniqueStrings(input.rejectedAnalysisUnitIds);
  const remainingUnitIds = uniqueStrings(input.remainingAnalysisUnitIds);
  const now = new Date().toISOString();
  const baseCheckpoint = {
    checkpointKind: 'dimension-checkpoint' as const,
    dimensionId: input.dimensionId,
    sessionId: input.sessionId,
    updatedAt: now,
  };

  // Plugin 只回填宿主执行状态，不重建 Core 的 AST/callgraph/sourceRefs 投影。
  const unitProgress: IDEAgentAnalysisUnitProgress[] = [
    ...completedUnitIds.map((unitId) => ({
      unitId,
      status: 'completed' as const,
      completedAt: now,
      submittedRecipeIds: [],
      referencedFiles: [],
      rejectedReasons: [],
      checkpoint: baseCheckpoint,
    })),
    ...skippedUnitIds.map((unitId) => ({
      unitId,
      status: 'skipped' as const,
      completedAt: now,
      submittedRecipeIds: [],
      referencedFiles: [],
      rejectedReasons: [],
      deviationReason: input.deviationReason,
      checkpoint: baseCheckpoint,
    })),
    ...rejectedUnitIds.map((unitId) => ({
      unitId,
      status: 'rejected' as const,
      completedAt: now,
      submittedRecipeIds: [],
      referencedFiles: [],
      rejectedReasons: input.deviationReason ? [input.deviationReason] : [],
      deviationReason: input.deviationReason,
      checkpoint: baseCheckpoint,
    })),
    ...remainingUnitIds.map((unitId) => ({
      unitId,
      status: 'pending' as const,
      submittedRecipeIds: [],
      referencedFiles: [],
      rejectedReasons: [],
      checkpoint: baseCheckpoint,
    })),
  ];

  return {
    checkpointKind: 'ide-agent-analysis-unit-progress',
    completedUnitIds,
    skippedUnitIds,
    rejectedUnitIds,
    remainingUnitIds,
    ...(input.deviationReason ? { deviationReason: input.deviationReason } : {}),
    unitProgress,
  };
}

function mergeProgress(
  seed: readonly IDEAgentAnalysisUnitProgress[],
  overrides: readonly IDEAgentAnalysisUnitProgress[]
): IDEAgentAnalysisUnitProgress[] {
  const byUnit = new Map<string, IDEAgentAnalysisUnitProgress>();
  for (const unit of seed) {
    byUnit.set(unit.unitId, { ...unit });
  }
  for (const unit of overrides) {
    byUnit.set(unit.unitId, { ...byUnit.get(unit.unitId), ...unit });
  }
  return [...byUnit.values()];
}

function projectUnitSurface(unit: IDEAgentAnalysisUnit): IDEAgentAnalysisUnitSurface {
  return {
    unitId: unit.unitId,
    dimensionId: unit.dimensionId,
    targetName: unit.targetName,
    moduleName: unit.moduleName,
    priority: unit.priority,
    reason: unit.reason,
    sourceRefs: unit.sourceRefs,
    requiredReadSet: unit.requiredReadSet,
    completionContract: unit.completionContract,
    degraded: unit.degraded,
    warnings: unit.warnings,
  };
}

function countUnitsByDimension(units: readonly IDEAgentAnalysisUnit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const unit of units) {
    counts[unit.dimensionId] = (counts[unit.dimensionId] ?? 0) + 1;
  }
  return counts;
}

function countProgressStatuses(
  units: readonly IDEAgentAnalysisUnitProgress[]
): Record<IDEAgentAnalysisUnitProgress['status'], number> {
  const counts: Record<IDEAgentAnalysisUnitProgress['status'], number> = {
    blocked: 0,
    claimed: 0,
    completed: 0,
    pending: 0,
    rejected: 0,
    skipped: 0,
  };
  for (const unit of units) {
    counts[unit.status] += 1;
  }
  return counts;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.trim().length > 0))];
}
