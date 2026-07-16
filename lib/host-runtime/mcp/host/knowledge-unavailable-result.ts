import type { ProjectRuntimeContext } from '../../context/ProjectRuntimeContext.js';

export function createKnowledgeUnavailableResult(
  toolName: string,
  projectRuntime: ProjectRuntimeContext
): Record<string, unknown> {
  const identity = projectRuntime.identity;
  const strictRouteUnavailable = projectRuntime.publication.mode === 'strict-v1';
  const summary = strictRouteUnavailable
    ? `Alembic strict knowledge is unavailable for ${identity.projectRoot}; the valid strict publication has no active route.`
    : `Alembic knowledge is unavailable for ${identity.projectRoot}; no database exists at ${identity.databasePath}.`;
  return {
    success: true,
    data: {
      status: 'unavailable',
      summary,
      items: [],
      results: [],
      relations: [],
      diagnostics: [
        {
          code: strictRouteUnavailable
            ? 'strict-publication-route-unavailable'
            : 'knowledge-database-unavailable',
          severity: 'info',
          message: summary,
          retryable: false,
        },
      ],
      nextActions: [],
      project: {
        projectRoot: identity.projectRoot,
        projectId: identity.projectId,
        dataRoot: identity.dataRoot,
        databasePath: identity.databasePath,
        databaseExists: false,
        publication: projectRuntime.publication,
      },
    },
    message: summary,
    toolName,
  };
}
