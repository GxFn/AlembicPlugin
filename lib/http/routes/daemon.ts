import { resolveProjectRoot, WorkspaceResolver } from '@alembic/core/workspace';
import express, { type Request } from 'express';
import { inspectCodexAiConfig } from '../../codex/AiConfigState.js';
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
  const dashboardAvailable =
    mode === 'daemon' && process.env.ALEMBIC_DAEMON_DASHBOARD_MOUNTED === '1';
  const dashboardUrl = dashboardAvailable && origin ? origin : null;
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
        packageName: 'alembic-ai',
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
        internalAi: getInternalAiCapability(projectRoot),
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

function getInternalAiCapability(projectRoot: string) {
  try {
    const aiConfig = inspectCodexAiConfig(projectRoot);
    return {
      available: aiConfig.ready,
      configSource: aiConfig.source,
      model: aiConfig.model,
      provider: aiConfig.provider,
    };
  } catch {
    return { available: false, configSource: 'empty', model: null, provider: null };
  }
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
    const db = container.get('database') as {
      getDb?: () => { prepare: (sql: string) => { get: () => unknown } };
    };
    const row = db
      .getDb?.()
      ?.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
      .get() as { version?: string } | undefined;
    return row?.version || null;
  } catch {
    return null;
  }
}

export default router;
