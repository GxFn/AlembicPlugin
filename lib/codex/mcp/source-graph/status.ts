import { createSourceGraphStatusResult } from '@alembic/core/source-graph';
import { projectSourceGraphOperationBusiness } from './output.js';

export function buildSourceGraphStatus(projectRoot: string): Record<string, unknown> {
  const checkedAt = Date.now();
  const result = createSourceGraphStatusResult({
    projectRoot,
    repoId: 'default',
    freshness: {
      status: 'uninitialized',
      checkedAt,
      pendingFileCount: 0,
      staleFileCount: 0,
      reason: 'AlembicPlugin has no connected Core source graph snapshot for this project yet.',
      nextAction: 'initialize_core_source_graph_or_run_catch_up_before_requesting_source_facts',
    },
    diagnostics: [
      {
        code: 'source-ref-unproven',
        severity: 'warning',
        owner: 'plugin',
        message:
          'Source graph facts are unavailable because the Plugin has not opened a Core-owned source graph snapshot for this project.',
        nextAction: 'initialize_core_source_graph_or_run_catch_up_before_requesting_source_facts',
        invalidConclusion: 'source graph facts are ready for this project',
        blocksReady: true,
      },
    ],
    counts: {
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      parseErrorCount: 0,
    },
  });

  return {
    success: true,
    data: projectSourceGraphOperationBusiness(result, 'alembic_source_graph_status'),
  };
}
