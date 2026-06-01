import { createHostAgentKnowledgeRescanIntent } from '@alembic/core/host-agent-workflows';
import { describe, expect, test } from 'vitest';

describe('KnowledgeRescanIntent', () => {
  test('uses host-agent rescan cleanup semantics', () => {
    const intent = createHostAgentKnowledgeRescanIntent({
      reason: 'host-agent-rescan',
      dimensions: ['architecture'],
    });

    expect(intent).toMatchObject({
      executor: 'host-agent',
      analysisMode: 'incremental',
      cleanupPolicy: 'rescan-clean',
      completionPolicy: 'host-agent-dimension-complete',
      dimensionIds: ['architecture'],
      projectAnalysis: expect.objectContaining({
        sourceTag: 'rescan-host-agent',
      }),
    });
  });
});
