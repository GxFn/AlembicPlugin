import { describe, expect, test } from 'vitest';
import type { RetrievalCheckpointPosture } from '../../lib/host-runtime/mcp/handlers/retrieval-checkpoint-diagnostics.js';
import { summarizeHostKnowledgeState } from '../../lib/host-runtime/status/StatusService.js';
import type { HostKnowledgeState } from '../../lib/service/knowledge/KnowledgeState.js';

describe('status revision truth closure', () => {
  test.each([
    {
      label: 'stale alignment',
      posture: posture({ alignment: 'stale', rowStatus: 'stale', status: 'stale' }),
      expectedStatus: 'stale',
    },
    {
      label: 'incomplete manifest',
      posture: posture({
        alignment: 'stale',
        completeness: 'incomplete',
        rowStatus: 'missing-checkpoint',
        status: 'stale',
      }),
      expectedStatus: 'stale',
    },
    {
      label: 'project identity mismatch',
      posture: posture({
        alignment: 'stale',
        identityAlignment: 'mismatch',
        status: 'stale',
      }),
      expectedStatus: 'stale',
    },
    {
      label: 'unknown revision',
      posture: posture({ alignment: 'unknown', rowStatus: 'unknown', status: 'unknown' }),
      expectedStatus: 'unknown',
    },
    {
      label: 'unavailable revision manifest',
      posture: unavailablePosture(),
      expectedStatus: 'unknown',
    },
  ])('fails closed for $label', ({ expectedStatus, posture }) => {
    const summary = summarizeHostKnowledgeState(readyKnowledge(), posture);

    expect(summary).toMatchObject({
      freshness: {
        reason: expect.stringContaining('revision manifest'),
        stale: true,
        status: expectedStatus,
      },
      sourceRevisionStatus: posture.status,
      status: 'knowledge_stale',
    });
  });

  test('keeps current only for a complete matching revision manifest', () => {
    const summary = summarizeHostKnowledgeState(
      readyKnowledge(),
      posture({ alignment: 'current', status: 'current' })
    );

    expect(summary).toMatchObject({
      freshness: {
        reason: null,
        stale: false,
        status: 'current',
      },
      sourceRevisionManifest: {
        alignment: 'current',
        completeness: 'complete',
        identityAlignment: 'current',
        rows: [expect.objectContaining({ status: 'current' })],
      },
      sourceRevisionStatus: 'current',
      status: 'knowledge_ready',
    });
  });
});

function readyKnowledge(): HostKnowledgeState {
  return {
    databaseEntryCount: 1,
    dbRecipeCount: 1,
    freshness: {
      checkedAt: '2026-07-11T00:00:00.000Z',
      latestJobAt: null,
      latestKnowledgeAt: '2026-07-10T00:00:00.000Z',
      reason: null,
      stale: false,
      status: 'current',
    },
    hasKnowledge: true,
    initialized: true,
    materializedRecipeCount: 0,
    recipeCount: 1,
    skillCount: 0,
    status: 'knowledge_ready',
    usable: true,
  };
}

function posture(input: {
  alignment: 'current' | 'stale' | 'unknown';
  completeness?: 'complete' | 'incomplete';
  identityAlignment?: 'current' | 'mismatch' | 'unknown';
  rowStatus?: 'current' | 'dirty' | 'missing-checkpoint' | 'stale' | 'unknown';
  status: RetrievalCheckpointPosture['status'];
}): RetrievalCheckpointPosture {
  const rowStatus = input.rowStatus ?? 'current';
  return {
    available: true,
    checkpoint: null,
    diagnostics: [],
    nextActions: [],
    reason: input.status === 'current' ? null : 'checkpoint posture is not current',
    retrievalMayBeStale: input.status !== 'current',
    sourceRevisionManifest: {
      alignment: input.alignment,
      completeness: input.completeness ?? 'complete',
      identityAlignment: input.identityAlignment ?? 'current',
      projectId: 'project-fixture',
      projectScopeId: 'scope-fixture',
      rows: [
        {
          checkpointCommit:
            rowStatus === 'missing-checkpoint'
              ? null
              : rowStatus === 'current'
                ? 'current-commit'
                : 'checkpoint-commit',
          currentCommit: rowStatus === 'unknown' ? null : 'current-commit',
          dirty: rowStatus === 'unknown' ? null : rowStatus === 'dirty',
          folderId: 'folder-fixture',
          repositoryId: 'fixture',
          scannedAt: null,
          status: rowStatus,
        },
      ],
    },
    status: input.status,
  };
}

function unavailablePosture(): RetrievalCheckpointPosture {
  return {
    available: false,
    checkpoint: null,
    diagnostics: [],
    nextActions: [],
    reason: 'gitDiffCheckpointRepository is unavailable',
    retrievalMayBeStale: false,
    sourceRevisionManifest: null,
    status: 'unavailable',
  };
}
