import type { IDEAgentAnalysisPacket } from '@alembic/core/host-agent-workflows';
import { describe, expect, it } from 'vitest';
import {
  buildIDEAgentAnalysisProgressBackfill,
  buildIDEAgentAnalysisSurface,
} from '../../lib/codex/ide-agent/IDEAgentAnalysisSurface.js';

type TestSourceRef = IDEAgentAnalysisPacket['sourceRefs'][number] & {
  folderDisplayName?: string;
  folderId?: string;
  legacyPath?: string;
  projectScopeId?: string;
  qualifiedPath?: string;
  relativePath?: string;
};

function makePacket(): IDEAgentAnalysisPacket {
  return {
    packetId: 'ide-packet-1',
    projectRootHash: 'sha256:project',
    generatedAt: '2026-05-31T10:00:00.000Z',
    profile: 'cold-start',
    projectSummary: {
      primaryLanguage: 'typescript',
      fileCount: 3,
      targetCount: 1,
      materialization: { ast: true },
      degraded: [],
      warnings: [],
    },
    units: [
      makeUnit('unit-1', 'architecture', ['src/app.ts']),
      makeUnit('unit-2', 'state', ['src/store.ts']),
    ],
    sourceRefs: [
      {
        path: 'src/app.ts',
        role: 'primary',
      },
    ],
    requiredReadSet: ['src/app.ts', 'src/store.ts'],
    structuralEvidenceRefs: [
      {
        kind: 'ast-class',
        ref: 'App',
        summary: 'App class',
        sourceRefs: [{ path: 'src/app.ts' }],
      },
    ],
    retrievalHints: {
      structureTools: ['alembic_structure'],
      callContextAvailable: true,
      graphAvailable: false,
      stableKeyFormat: 'sourceRef + fqn + entityType',
      aliasPolicy: 'use Core stable keys',
    },
    budget: { includedUnits: 2, totalUnits: 2 },
    progressSeed: {
      packetId: 'ide-packet-1',
      checkpointKind: 'ide-agent-analysis-unit-progress',
      totalUnits: 2,
      remainingUnitIds: ['unit-1', 'unit-2'],
      unitProgress: [
        {
          unitId: 'unit-1',
          status: 'pending',
          submittedRecipeIds: [],
          referencedFiles: [],
          rejectedReasons: [],
        },
        {
          unitId: 'unit-2',
          status: 'pending',
          submittedRecipeIds: [],
          referencedFiles: [],
          rejectedReasons: [],
        },
      ],
    },
    meta: {
      builder: 'IDEAgentAnalysisPacketBuilder',
      source: 'project-snapshot',
      version: 1,
    },
  };
}

function makeUnit(
  unitId: string,
  dimensionId: string,
  requiredReadSet: string[]
): IDEAgentAnalysisPacket['units'][number] {
  return {
    unitId,
    key: {
      dimensionId,
      sourceRef: requiredReadSet[0],
      entityType: 'file',
      key: `${dimensionId}:${requiredReadSet[0]}`,
    },
    dimensionId,
    priority: 90,
    reason: `Analyze ${dimensionId}`,
    sourceRefs: [{ path: requiredReadSet[0], role: 'primary' }],
    requiredReadSet,
    structuralEvidenceRefs: [],
    structuralHints: {},
    completionContract: {
      minDistinctFiles: 1,
      mustReferenceAssignedSources: true,
      expectedEvidence: ['sourceRefs'],
    },
    degraded: [],
    warnings: [],
  };
}

describe('IDEAgentAnalysisSurface', () => {
  it('projects Core packet summary, next units, retrieval, and progress without private schema', () => {
    const surface = buildIDEAgentAnalysisSurface(makePacket(), {
      progressOverrides: [
        {
          unitId: 'unit-1',
          status: 'completed',
          submittedRecipeIds: ['recipe-1'],
          referencedFiles: ['src/app.ts'],
          rejectedReasons: [],
        },
      ],
    });

    expect(surface.packetSummary.packetId).toBe('ide-packet-1');
    expect(surface.packetSummary.unitCountsByDimension).toEqual({ architecture: 1, state: 1 });
    expect(surface.nextUnits.map((unit) => unit.unitId)).toEqual(['unit-2']);
    expect(surface.nextUnits[0]?.requiredReadSet).toEqual(['src/store.ts']);
    expect(surface.retrieval.requiredReadSet).toEqual(['src/app.ts', 'src/store.ts']);
    expect(surface.retrieval.retrievalHints.structureTools).toEqual(['alembic_structure']);
    expect(surface.progress.statusCounts).toMatchObject({ completed: 1, pending: 1 });
    expect(surface.progress.remainingUnitIds).toEqual(['unit-2']);
  });

  it('projects ProjectScope-qualified source identities into Codex read sets', () => {
    const pluginIndexRef = makeProjectScopeRef('plugin-folder', 'AlembicPlugin/lib/index.ts');
    const dashboardIndexRef = makeProjectScopeRef(
      'dashboard-folder',
      'AlembicDashboard/lib/index.ts'
    );
    const packet = makePacket();
    packet.units = [
      {
        ...makeUnit('unit-1', 'architecture', ['lib/index.ts']),
        sourceRefs: [pluginIndexRef, dashboardIndexRef],
        requiredReadSet: ['lib/index.ts'],
      },
    ];
    packet.sourceRefs = [pluginIndexRef, dashboardIndexRef];
    packet.requiredReadSet = ['lib/index.ts'];
    packet.budget = { includedUnits: 1, totalUnits: 1 };
    packet.progressSeed = {
      ...packet.progressSeed,
      totalUnits: 1,
      remainingUnitIds: ['unit-1'],
      unitProgress: [
        {
          unitId: 'unit-1',
          status: 'pending',
          submittedRecipeIds: [],
          referencedFiles: [],
          rejectedReasons: [],
        },
      ],
    };

    const surface = buildIDEAgentAnalysisSurface(packet);

    expect(surface.retrieval.requiredReadSet).toEqual([
      'AlembicPlugin/lib/index.ts',
      'AlembicDashboard/lib/index.ts',
    ]);
    expect(surface.nextUnits[0]?.requiredReadSet).toEqual([
      'AlembicPlugin/lib/index.ts',
      'AlembicDashboard/lib/index.ts',
    ]);
    expect(surface.nextUnits[0]?.sourceRefs).toEqual([pluginIndexRef, dashboardIndexRef]);
  });

  it('builds checkpoint backfill for completed, skipped, rejected, and remaining units', () => {
    const backfill = buildIDEAgentAnalysisProgressBackfill({
      analysisUnitIds: ['unit-1'],
      skippedAnalysisUnitIds: ['unit-2'],
      rejectedAnalysisUnitIds: ['unit-3'],
      remainingAnalysisUnitIds: ['unit-4'],
      deviationReason: 'source vanished',
      dimensionId: 'architecture',
      sessionId: 'session-1',
    });

    expect(backfill.completedUnitIds).toEqual(['unit-1']);
    expect(backfill.skippedUnitIds).toEqual(['unit-2']);
    expect(backfill.rejectedUnitIds).toEqual(['unit-3']);
    expect(backfill.remainingUnitIds).toEqual(['unit-4']);
    expect(backfill.unitProgress.map((unit) => unit.status)).toEqual([
      'completed',
      'skipped',
      'rejected',
      'pending',
    ]);
  });
});

function makeProjectScopeRef(folderId: string, qualifiedPath: string): TestSourceRef {
  return {
    path: 'lib/index.ts',
    legacyPath: 'lib/index.ts',
    qualifiedPath,
    relativePath: 'lib/index.ts',
    folderDisplayName: folderId,
    folderId,
    projectScopeId: 'workspace-scope',
    role: 'entry',
  };
}
