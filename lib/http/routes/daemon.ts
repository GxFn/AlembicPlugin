import { resolveProjectRoot, WorkspaceResolver } from '@alembic/core/workspace';
import express, { type Request } from 'express';
import { getLatestSchemaMigrationVersion } from '#infra/database/SqliteDatabaseAccess.js';
import { CODEX_RUNTIME_PACKAGE } from '../../codex/runtime/RuntimeContext.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { GitDiffCheckpointStatus } from '../../service/evolution/git-diff-checkpoint/index.js';
import { getPackageVersion } from '../../shared/package-assets.js';

const router = express.Router();
const API_PREFIX = '/api/v1';

router.get('/health', (req, res) => {
  const container = getServiceContainer();
  const projectRoot = resolveProjectRoot(container);
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const gitDiffCheckpoint = readGitDiffCheckpointStatus(container);
  const mode = process.env.ALEMBIC_DAEMON_MODE === '1' ? 'daemon' : 'api';
  const origin = buildRequestOrigin(req);
  const dashboardAvailable = false;
  const dashboardUrl = null;
  res.json({
    success: true,
    data: {
      gitDiffCheckpoint,
      mode,
      projectRoot,
      dataRoot: resolver.dataRoot,
      projectId: resolver.projectId,
      version: getPackageVersion(),
      pid: process.pid,
      uptime: process.uptime(),
      databasePath: resolver.databasePath,
      schemaMigrationVersion: getSchemaMigrationVersion(container),
      dashboardUrl,
      enhancement: {
        apiVersion: 'v1',
        packageName: CODEX_RUNTIME_PACKAGE,
        route: 'embedded-plugin-runtime',
        version: getPackageVersion(),
      },
      capabilities: {
        api: {
          available: true,
          baseUrl: origin,
          healthPath: `${API_PREFIX}/daemon/health`,
        },
        dashboard: {
          available: dashboardAvailable,
          url: dashboardUrl,
        },
        apiAi: getApiAiCapability(),
        jobs: {
          available: true,
          endpoints: {
            bootstrap: `${API_PREFIX}/jobs/bootstrap`,
            list: `${API_PREFIX}/jobs`,
            rescan: `${API_PREFIX}/jobs/rescan`,
          },
          kinds: ['bootstrap', 'rescan'],
        },
      },
    },
  });
});

function getApiAiCapability() {
  return {
    available: false,
    configSource: null,
    model: null,
    provider: null,
    owner: 'Alembic',
    pluginConfigRemoved: true,
  };
}

function buildRequestOrigin(req: Request): string | null {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : null;
}

function readGitDiffCheckpointStatus(
  container: ReturnType<typeof getServiceContainer>
): GitDiffCheckpointStatus | null {
  const checkpoint = container.singletons.gitDiffCheckpoint as
    | { getStatus?: () => GitDiffCheckpointStatus }
    | undefined;
  return checkpoint?.getStatus?.() ?? null;
}

function getSchemaMigrationVersion(
  container: ReturnType<typeof getServiceContainer>
): string | null {
  try {
    return getLatestSchemaMigrationVersion(container.get('database'));
  } catch {
    return null;
  }
}

export default router;
