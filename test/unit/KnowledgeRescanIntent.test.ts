import { createExternalKnowledgeRescanIntent } from '@alembic/core/host-agent-workflows';
import { describe, expect, test } from 'vitest';

describe('KnowledgeRescanIntent', () => {
  test('uses external rescan cleanup semantics', () => {
    const intent = createExternalKnowledgeRescanIntent({
      reason: 'external-rescan',
      dimensions: ['architecture'],
    });

    expect(intent).toMatchObject({
      executor: 'external-agent',
      analysisMode: 'incremental',
      cleanupPolicy: 'rescan-clean',
      completionPolicy: 'external-dimension-complete',
      dimensionIds: ['architecture'],
    });
  });
});
