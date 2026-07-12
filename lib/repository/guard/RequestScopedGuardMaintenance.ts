import { SignalBus } from '@alembic/core/events';
import { LifecycleStateMachine, ProposalGateway } from '@alembic/core/evolution';
import { RecipeFreshnessService, SourceRefReconciler } from '@alembic/core/knowledge';
import {
  ALEMBIC_REPOSITORY_KEYS,
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

export interface RequestScopedGuardMaintenanceResources {
  close(): void;
  container: {
    get(name: string): unknown;
  };
}

/**
 * Open the already-migrated database selected by the current Guard request.
 *
 * This intentionally does not use Plugin's process-global ServiceContainer: one host process can
 * serve multiple explicit project roots, so maintenance repositories must have the same lifetime
 * and physical database identity as the request. The narrow connection also leaves the existing
 * SQLite journal mode unchanged.
 */
export function createRequestScopedGuardMaintenanceResources(input: {
  databasePath: string;
  projectRoot: string;
}): RequestScopedGuardMaintenanceResources {
  const db = new Database(input.databasePath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 3000');
    const orm = drizzle(db);
    const repositories = createAlembicRepositories({
      getDb: () => db,
      getDrizzle: () => orm,
    } as never);
    const signalBus = new SignalBus();
    const lifecycle = new LifecycleStateMachine(
      repositories.knowledgeRepository as never,
      repositories.lifecycleEventRepository,
      signalBus,
      repositories.proposalRepository
    );
    const proposalGateway = new ProposalGateway(
      repositories.proposalRepository,
      lifecycle,
      repositories.knowledgeRepository as never
    );
    const sourceRefReconciler = new SourceRefReconciler(
      input.projectRoot,
      repositories.recipeSourceRefRepository as never,
      repositories.knowledgeRepository as never,
      { signalBus }
    );
    const recipeFreshnessService = new RecipeFreshnessService({
      sourceRefReconciler,
      sourceRefRepository: repositories.recipeSourceRefRepository as never,
      vectorService: null,
    });
    const services = new Map<string, unknown>([
      ...repositoryServices(repositories),
      ['proposalGateway', proposalGateway],
      ['recipeFreshnessService', recipeFreshnessService],
      ['signalBus', signalBus],
    ]);
    return {
      close(): void {
        db.close();
      },
      container: {
        get(name: string): unknown {
          if (!services.has(name)) {
            throw new Error(`Request-scoped Guard maintenance does not expose ${name}.`);
          }
          return services.get(name);
        },
      },
    };
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function repositoryServices(repositories: AlembicRepositoryBundle): Array<[string, unknown]> {
  return ALEMBIC_REPOSITORY_KEYS.map((name) => [name, repositories[name]]);
}
